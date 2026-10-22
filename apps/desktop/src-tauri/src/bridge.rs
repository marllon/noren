//! Tauri commands on top of the `noren-core` session manager and shell profiles.
//!
//! Terminal output goes to the interface through a `tauri::ipc::Channel` as raw bytes
//! (`InvokeResponseBody::Raw`), never as JSON; the end of a session is announced with the
//! `session-exit` event.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::Duration;

use noren_core::daemon::LinkState;
use noren_core::{
    ACTIONS_FILE_PATH, AgentEntry, BENCH_DIR_NAME, BackgroundStore, BenchFile, BenchStore,
    CONFIG_FILE_NAME, ConfigStore, ConfigWatcher, Gallery, GistStatus, GistSync, GitHead,
    InstalledItem, KeyVault, MODS_DIR_NAME, ModFile, ModStore, ModWatcher, PLUGINS_DIR_NAME,
    PluginFolder, PluginStore, ProcessSource, Profile, ProfileSet, PullOutcome, PushOutcome,
    SCROLLBACK_DIR_NAME, ScrollbackStore, SessionEvent, SessionId, SpaceFileLink, SpaceFileWrite,
    SpaceFolder, SpawnSpec, SshProfile, StateStore, SyncRepo, SyncStatus, SystemProcesses,
    THEMES_DIR_NAME, ThemeStore, UserProfile, WindowEffect, Worktree, check_catalog,
    create_worktree, detect_system_profiles, list_running_containers, list_worktrees, native_path,
    read_head, read_project_file, read_ssh_hosts, remove_worktree, run_short, scan_sessions,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::daemon_link::{Host, SessionError, Sessions};
use crate::pane_sessions::PaneBook;
use crate::route::OutputRoute;

/// File name of the workspace state inside the app data folder.
pub const STATE_FILE_NAME: &str = "state.json";

/// Where the shell integration scripts are inside the app's resource folder (see `bundle.resources`
/// in tauri.conf.json).
pub const INTEGRATION_RESOURCE_DIR: &str = "resources/shell-integration";

/// Name of the event emitted when a session's child ended and all its output was delivered.
pub const SESSION_EXIT_EVENT: &str = "session-exit";

/// Name of the event emitted when the connection of a session on another machine (a profile of
/// kind `ssh`) changes: it broke and is being made again, it came back, or it gave up.
pub const SESSION_LINK_EVENT: &str = "session-link";

/// State managed by Tauri: every PTY session (in the session daemon, or in this process when there
/// is none; see `daemon_link`) and the shell profiles: the ones found on this machine, and the ones
/// the user defined (`profiles` of `config.jsonc`), which the interface hands over.
pub struct AppState {
    pub sessions: Sessions,
    /// The shells found on this machine, detected once. The detection runs on a thread of its own
    /// from the start of the program (it asks `wsl.exe`, which takes ~70 ms) and the first reader
    /// waits for it, which is long after it ended.
    detected: LazyLock<ProfileSet, DetectedProfiles>,
    /// The detected shells followed by the profiles of the user: what is listed and what starts.
    /// `None` until the user's profiles are handed over: the detected set is the list then.
    profiles: RwLock<Option<ProfileSet>>,
    /// Where the output of each live session goes, by session id. A route is added when the session
    /// starts and removed when it ends; `session_attach` changes the channel behind it.
    routes: Arc<Mutex<HashMap<u64, Arc<OutputRoute>>>>,
    /// The shell of the pane on screen, started before the page asked for it (see `prespawn`).
    pub(crate) prespawn: Mutex<crate::prespawn::Slot>,
    /// The process tree of this machine, read by `agents_scan`; it keeps what it learned between
    /// scans so the next one only refreshes.
    processes: SystemProcesses,
    /// Whether the shells of the panes outlive the app (`sessions.keepOnClose` of the settings, which
    /// the interface hands over). Off until it does, so an app that never heard from the interface
    /// ends its sessions as it always did.
    pub(crate) keep_sessions: AtomicBool,
    /// Set by the tray icon's "Quit" (see `tray`): the app is going away for real, so the closing
    /// of the window is not turned into hiding it, and on the way out the sessions and the daemon
    /// are ended instead of left running.
    pub(crate) quitting: AtomicBool,
    /// Which session of the daemon belongs to which pane (see `pane_sessions`).
    pub(crate) pane_book: Mutex<PaneBook>,
}

/// What a `%NAME%` in a profile of the user is replaced with: the environment of the process.
fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// How the detected profiles are produced the first time they are read.
type DetectedProfiles = Box<dyn FnOnce() -> ProfileSet + Send + Sync>;

impl AppState {
    /// Starts detecting the system profiles (once, on a thread of its own), starts looking for the
    /// session daemon the same way when `host` asks for one, and starts with no session and no
    /// profile of the user.
    pub fn detect(host: Host) -> Self {
        let detection = std::thread::spawn(detect_system_profiles);
        let waiting = Mutex::new(Some(detection));
        Self::with_detection(
            Box::new(move || {
                // A detection that panicked leaves no shell, which the first session reports.
                let handle = waiting.lock().unwrap_or_else(|e| e.into_inner()).take();
                handle
                    .and_then(|handle| handle.join().ok())
                    .unwrap_or(ProfileSet {
                        profiles: Vec::new(),
                        default_id: None,
                    })
            }),
            host,
        )
    }

    /// The same around profiles already known, with the sessions in this process (a test builds its
    /// own).
    #[cfg(test)]
    pub fn with_detected(detected: ProfileSet) -> Self {
        Self::with_detected_in(detected, Host::InProcess)
    }

    /// The same, with the sessions where `host` says.
    #[cfg(test)]
    pub fn with_detected_in(detected: ProfileSet, host: Host) -> Self {
        Self::with_detection(Box::new(move || detected), host)
    }

    fn with_detection(detection: DetectedProfiles, host: Host) -> Self {
        Self {
            sessions: Sessions::new(host),
            detected: LazyLock::new(detection),
            profiles: RwLock::new(None),
            routes: Arc::default(),
            prespawn: Mutex::default(),
            processes: SystemProcesses::new(),
            keep_sessions: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            pane_book: Mutex::new(PaneBook::in_memory()),
        }
    }

    /// Runs `read` on the profiles in force: the user's followed the detected ones, once handed over.
    fn with_profiles<T>(&self, read: impl FnOnce(&ProfileSet) -> T) -> T {
        let joined = self.profiles.read().unwrap_or_else(|e| e.into_inner());
        match joined.as_ref() {
            Some(profiles) => read(profiles),
            None => read(&self.detected),
        }
    }

    /// The profile `id`, or the default one for `None`.
    pub fn find_profile(&self, id: Option<&str>) -> Result<Profile, String> {
        self.with_profiles(|profiles| match id {
            Some(id) => profiles
                .get(id)
                .cloned()
                .ok_or_else(|| format!("unknown shell profile '{id}'")),
            None => profiles
                .default_profile()
                .cloned()
                .ok_or_else(|| "no shell profile was found on this machine".to_owned()),
        })
    }

    /// Where the output of the session `id` goes; `None` for a session that never started or ended.
    pub fn route(&self, id: u64) -> Option<Arc<OutputRoute>> {
        self.routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
    }

    /// Every profile, the detected ones first, as the interface lists them.
    pub fn list_profiles(&self) -> Vec<ProfileDto> {
        self.with_profiles(profile_dtos)
    }

    /// Replaces the profiles of the user. The whole list is refused, and the profiles stay as they
    /// were, when one is not valid (an empty program, for one), an id repeats or an id is one of the
    /// shells found on this machine.
    pub fn set_user_profiles(&self, user: &[UserProfile]) -> Result<(), String> {
        let joined = self
            .detected
            .with_user_profiles(user, &process_env)
            .map_err(|e| e.to_string())?;
        *self.profiles.write().unwrap_or_else(|e| e.into_inner()) = Some(joined);
        Ok(())
    }
}

/// A shell profile as seen by the interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProfileDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "default")]
    pub is_default: bool,
    /// `"ssh"` for a profile whose shell lives on another machine; left out for a local shell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
}

/// A profile of the user as the interface sends it (an entry of `profiles` in `config.jsonc`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileDto {
    /// `"shell"` (or absent) or `"ssh"`.
    #[serde(default)]
    pub kind: Option<String>,
    pub id: String,
    pub name: String,
    /// Absent for an `ssh` profile that runs the login shell of the user on the other machine.
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub known_hosts_file: Option<String>,
}

impl TryFrom<UserProfileDto> for UserProfile {
    type Error = String;

    /// The page validated the profile already; this refuses what could not have come from it: a
    /// kind it does not know, an `ssh` profile with no host, a shell profile that names a machine.
    fn try_from(dto: UserProfileDto) -> Result<Self, String> {
        let ssh = match dto.kind.as_deref() {
            None | Some("shell") => {
                let names_a_machine = dto.host.is_some()
                    || dto.user.is_some()
                    || dto.port.is_some()
                    || dto.identity_file.is_some()
                    || dto.known_hosts_file.is_some();
                if names_a_machine {
                    return Err(format!(
                        "profile '{}': a shell profile cannot name a machine; the kind is 'ssh'",
                        dto.id
                    ));
                }
                None
            }
            Some("ssh") => Some(SshProfile {
                host: dto
                    .host
                    .ok_or_else(|| format!("profile '{}': an ssh profile needs a host", dto.id))?,
                user: dto.user,
                port: dto.port,
                identity_file: dto.identity_file,
                known_hosts_file: dto.known_hosts_file,
            }),
            Some(other) => {
                return Err(format!("profile '{}': unknown kind '{other}'", dto.id));
            }
        };
        Ok(Self {
            id: dto.id,
            name: dto.name,
            program: dto.program,
            args: dto.args,
            cwd: dto.cwd,
            ssh,
        })
    }
}

/// Payload of the `session-link` event: the session and where its connection stands. What does not
/// apply to the state is left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLinkPayload {
    pub id: u64,
    /// `connected`, `reconnecting` or `failed`.
    pub state: &'static str,
    /// `reconnecting`: the attempt about to start, counted from 1...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    /// ...of how many.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    /// `reconnecting`: milliseconds until it starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_in_ms: Option<u64>,
    /// `reconnecting` and `failed`: why, in a sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SessionLinkPayload {
    pub fn new(id: SessionId, state: &LinkState) -> Self {
        let none = Self {
            id: id.0,
            state: "connected",
            attempt: None,
            max_attempts: None,
            retry_in_ms: None,
            reason: None,
        };
        match state {
            LinkState::Connected => none,
            LinkState::Reconnecting {
                attempt,
                max_attempts,
                retry_in,
                reason,
            } => Self {
                state: "reconnecting",
                attempt: Some(*attempt),
                max_attempts: Some(*max_attempts),
                retry_in_ms: Some(u64::try_from(retry_in.as_millis()).unwrap_or(u64::MAX)),
                reason: Some(reason.clone()),
                ..none
            },
            LinkState::Failed { reason } => Self {
                state: "failed",
                reason: Some(reason.clone()),
                ..none
            },
        }
    }
}

/// Payload of the `session-exit` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionExitPayload {
    pub id: u64,
    pub code: u32,
    pub signal: Option<String>,
}

/// Input of `session_write`: text from the keyboard or raw bytes (for example a paste).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum WriteData {
    Text(String),
    Bytes(Vec<u8>),
}

impl WriteData {
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Text(text) => text.into_bytes(),
            Self::Bytes(bytes) => bytes,
        }
    }
}

/// Applies the optional working directory and extra environment of `session_create` to `spec`.
///
/// An empty `cwd` means "not set". A `cwd` that is not an existing folder is an error here,
/// before any process is started, so the interface gets a clear message instead of a shell that
/// silently opens somewhere else (or fails to start). The same goes for the folder the profile
/// itself carries (`spec.cwd`) when no `cwd` is given; a given `cwd` replaces it.
pub fn apply_session_options(
    mut spec: SpawnSpec,
    cwd: Option<&str>,
    env: Option<HashMap<String, String>>,
) -> Result<SpawnSpec, String> {
    if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
        let path = Path::new(cwd);
        if !path.is_dir() {
            return Err(format!(
                "working directory '{cwd}' does not exist or is not a folder"
            ));
        }
        spec.cwd = Some(path.to_owned());
    } else if let Some(path) = &spec.cwd
        && !path.is_dir()
    {
        return Err(format!(
            "working directory '{}' does not exist or is not a folder",
            path.display()
        ));
    }
    if let Some(env) = env {
        let mut pairs: Vec<(String, String)> = env.into_iter().collect();
        pairs.sort();
        for (key, value) in &pairs {
            if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                return Err(format!("invalid environment variable '{key}'"));
            }
        }
        spec.env.extend(pairs);
    }
    Ok(spec)
}

/// The folder with the shell integration scripts, when the app has it (installed app, or the
/// copy `tauri-build` keeps next to the debug binary).
pub fn integration_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app
        .path()
        .resolve(INTEGRATION_RESOURCE_DIR, BaseDirectory::Resource)
        .ok()?;
    dir.is_dir().then_some(dir)
}

fn profile_dtos(set: &ProfileSet) -> Vec<ProfileDto> {
    set.profiles
        .iter()
        .map(|profile| ProfileDto {
            id: profile.id.clone(),
            name: profile.name.clone(),
            is_default: set.default_id.as_deref() == Some(profile.id.as_str()),
            kind: profile.remote.as_ref().map(|_| "ssh"),
        })
        .collect()
}

/// Starts a session of `profile_id` (the default profile when `None`), streams its output to
/// `output` and emits `session-exit` when it ends. Returns the session id and the profile id.
///
/// The output goes through an [`OutputRoute`] kept in `state` until the session ends, so
/// [`attach_session`] can move it to another channel while the shell runs.
///
/// `cwd` and `env` are optional (see [`apply_session_options`]).
///
/// Shared by the `session_create` command and by `--smoke`, so the smoke test exercises the
/// same path the interface uses.
#[allow(clippy::too_many_arguments)]
pub fn create_session<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    profile_id: Option<&str>,
    cwd: Option<&str>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
) -> Result<(u64, String), String> {
    crate::perf::mark_once("session-create-called");
    let profile = state.find_profile(profile_id)?;
    // A profile of kind `ssh` opens its shell in a `norend` on another machine. The folder and the
    // environment of this call belong to this machine (the folder of the space, the variables of
    // the tab), so they are not sent there: the shell gets what the profile says (finding 198).
    if let Some(machine) = &profile.remote {
        let id = launch_remote(app, state, machine, profile.remote_spec(cols, rows), output)?;
        return Ok((id.0, profile.id.clone()));
    }
    let (profile, spec) = session_spec(app, state, profile_id, cwd, env, cols, rows)?;
    // The shell this very page is about to ask for may be running already (see `prespawn`).
    if let Some(id) = state.claim_prespawned(&spec, &output) {
        return Ok((id.0, profile.id.clone()));
    }
    let id = launch(app, state, spec, output, None)?;
    Ok((id.0, profile.id.clone()))
}

/// The profile and the command a `session_create` with these arguments starts: the one place that
/// decides it, so a shell started ahead of the call (see `prespawn`) is known to be the same one.
pub fn session_spec<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    profile_id: Option<&str>,
    cwd: Option<&str>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
) -> Result<(Profile, SpawnSpec), String> {
    let profile = state.find_profile(profile_id)?;
    if profile.remote.is_some() {
        return Err(format!(
            "'{}' is a profile on another machine: it has no command to start here",
            profile.id
        ));
    }
    let spec = apply_session_options(
        profile.spawn_spec_with_integration(cols, rows, integration_dir(app).as_deref()),
        cwd,
        env,
    )?;
    Ok((profile, spec))
}

/// Starts the shell of `spec`, sends its output to `output` through a route kept in `state` and
/// emits `session-exit` when it ends (unless `silent` is set by then: a shell nobody ever knew of).
pub fn launch<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    spec: SpawnSpec,
    output: Channel<InvokeResponseBody>,
    silent: Option<Arc<AtomicBool>>,
) -> Result<SessionId, String> {
    route_session(app, state, output, silent, |on_event| {
        state.sessions.spawn(spec, on_event)
    })
}

/// Starts `spec` in the daemon of `machine`, sends its output to `output` through a route kept in
/// `state`, emits `session-exit` when it ends and `session-link` whenever its connection changes.
pub fn launch_remote<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    machine: &SshProfile,
    spec: SpawnSpec,
    output: Channel<InvokeResponseBody>,
) -> Result<SessionId, String> {
    let linked = app.clone();
    route_session(app, state, output, None, |on_event| {
        state
            .sessions
            .spawn_remote(machine, spec, on_event, move |id, link| {
                let _ = linked.emit(SESSION_LINK_EVENT, SessionLinkPayload::new(id, link));
            })
    })
}

/// Takes over the session `id` that the daemon still holds from an earlier run: what it printed
/// meanwhile and everything after goes to `output` through a route kept in `state`, and its end is
/// announced with `session-exit`, exactly as for a session [`launch`] started.
pub fn launch_existing<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: SessionId,
    output: Channel<InvokeResponseBody>,
) -> Result<SessionId, String> {
    route_session(app, state, output, None, |on_event| {
        state.sessions.reattach(id, on_event)?;
        Ok(id)
    })
}

/// The part [`launch`] and [`launch_existing`] share: `begin` starts or takes over the session and
/// is given the callback that carries its output to a route and announces its end.
fn route_session<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    output: Channel<InvokeResponseBody>,
    silent: Option<Arc<AtomicBool>>,
    begin: impl FnOnce(Box<dyn FnMut(SessionEvent<'_>) + Send>) -> Result<SessionId, SessionError>,
) -> Result<SessionId, String> {
    // The exit event carries the session id, which exists only after `begin` returned. The
    // callback waits on this lock for it; a session that ends at once cannot report too early.
    let id_slot: Arc<Mutex<Option<SessionId>>> = Arc::new(Mutex::new(None));
    let mut slot = id_slot.lock().unwrap_or_else(|e| e.into_inner());

    let callback_slot = Arc::clone(&id_slot);
    let route = Arc::new(OutputRoute::new(output));
    let sink = Arc::clone(&route);
    // The clients of the local API hear what the session prints (none when the server is off).
    let events = crate::api_events::output_events(app);
    let tap = events.clone();
    let routes = Arc::clone(&state.routes);
    let app = app.clone();
    let id = begin(Box::new(move |event| match event {
        // A failed send means the page is gone; the session ends with the app.
        SessionEvent::Output(bytes) => {
            crate::perf::mark_once("shell-first-byte");
            crate::perf::mark_prompt_bytes(bytes);
            // The page first; the events are queued after and never make it wait.
            sink.send(bytes);
            if let Some(tap) = &tap {
                tap.push(bytes);
            }
        }
        SessionEvent::Exit(info) => {
            let id = *callback_slot.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(id) = id {
                routes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id.0);
                if silent
                    .as_ref()
                    .is_some_and(|silent| silent.load(Ordering::SeqCst))
                {
                    return;
                }
                let _ = app.emit(
                    SESSION_EXIT_EVENT,
                    SessionExitPayload {
                        id: id.0,
                        code: info.code,
                        signal: info.signal,
                    },
                );
            }
        }
    }))
    .map_err(|e| e.to_string())?;
    crate::perf::mark_once("shell-spawned");
    if let Some(events) = &events {
        events.bind(id.0);
    }
    // Before the lock is released: the exit callback waits for it, so it cannot remove a route
    // that was not added yet.
    state
        .routes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.0, route);
    *slot = Some(id);
    Ok(id)
}

/// Moves the output of the live session `id` to `output`: what the shell prints from now on goes
/// there and no longer to the channel that had it. The shell is not touched, it is the same process
/// under the same id; this is how a session opened in the quick window is handed to the main one.
/// Fails when no live session has the id.
///
/// With `replay`, and when the session lives in the daemon, `output` gets what the daemon kept of
/// what the session printed before first, then everything it prints (a page that draws a new
/// terminal for the session has seen none of it); the daemon is asked on the thread that carries
/// the output of the sessions, so no byte is shown twice or lost between the two (see
/// [`Sessions::replay`]). A session that is not in the daemon, or a daemon that cannot answer, is
/// moved as without `replay`.
pub fn attach_session(
    state: &AppState,
    id: u64,
    output: Channel<InvokeResponseBody>,
    replay: bool,
) -> Result<(), String> {
    let route = state
        .route(id)
        .ok_or_else(|| format!("unknown session {id}"))?;
    if replay && state.sessions.keeps_output(SessionId(id)) {
        // The channel waits here until the output thread has the buffer, which is the moment it
        // changes hands; if the daemon cannot give the buffer it is still here.
        let waiting = Arc::new(Mutex::new(Some(output)));
        let hand_over = {
            let waiting = Arc::clone(&waiting);
            let route = Arc::clone(&route);
            Box::new(move |kept: Vec<u8>| {
                let channel = waiting.lock().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(channel) = channel {
                    drop(route.replace_with_replay(channel, &kept));
                }
            })
        };
        if state.sessions.replay(SessionId(id), hand_over).is_ok() {
            return Ok(());
        }
        let channel = waiting.lock().unwrap_or_else(|e| e.into_inner()).take();
        return match channel {
            Some(channel) => {
                drop(route.replace(channel));
                Ok(())
            }
            // It was handed over before the answer failed to come back.
            None => Ok(()),
        };
    }
    drop(route.replace(output));
    Ok(())
}

/// Takes over the output of a live session that another window started (see [`attach_session`]).
/// The session has no pane, so it does not outlive the app (a shell from the quick window that was
/// promoted to a tab is not kept). `replay` asks for what the session printed before to come
/// first (the pages of the other windows, which draw a new terminal for a session that has been
/// running, ask for it).
#[tauri::command(rename_all = "camelCase")]
pub async fn session_attach(
    state: State<'_, AppState>,
    id: u64,
    on_output: Channel<InvokeResponseBody>,
    replay: Option<bool>,
) -> Result<(), String> {
    attach_session(&state, id, on_output, replay.unwrap_or(false))
}

/// Takes the settings of the interface for the shells of the panes: `keep` is
/// `sessions.keepOnClose`, whether they outlive the app.
#[tauri::command]
pub fn sessions_keep_set(state: State<'_, AppState>, keep: bool) {
    state.set_keep_sessions(keep);
}

/// Gives the pane `pane_id` the shell it had before the app was closed, when the daemon still holds
/// it and the settings keep shells: its buffer and everything after go to `on_output`. Resolves with
/// the id of the session, or `null` when the pane has none to come back to (the page then starts a
/// new shell, as it always did).
#[tauri::command(rename_all = "camelCase")]
pub async fn session_reattach(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<Option<u64>, String> {
    Ok(state
        .reattach_pane(&app, &pane_id, on_output)
        .map(|id| id.0))
}

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Vec<ProfileDto> {
    state.list_profiles()
}

/// Takes the profiles of the user from the interface, replacing the ones it had. Refused as a whole
/// (with the reason) when one of them is not valid; see [`AppState::set_user_profiles`].
#[tauri::command]
pub fn profiles_set_user(
    state: State<'_, AppState>,
    profiles: Vec<UserProfileDto>,
) -> Result<(), String> {
    let user = profiles
        .into_iter()
        .map(UserProfile::try_from)
        .collect::<Result<Vec<_>, _>>()?;
    state.set_user_profiles(&user)
}

/// Asks the connection of a session on another machine to try again now: it stops waiting between
/// two attempts, or, after it gave up, starts the attempts over. The new state arrives as
/// `session-link`. An error for a session that is not one on another machine.
#[tauri::command]
pub fn session_retry(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    state
        .sessions
        .retry(SessionId(id))
        .map_err(|e| e.to_string())
}

// The arguments are the named fields of the IPC call, so they stay flat.
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn session_create(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
    pane_id: Option<String>,
    on_output: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    // Opening a tab on another machine logs in over `ssh`, which can take a long time on a bad
    // network: it must not hold a thread of the interface's runtime that long.
    let remote = state
        .find_profile(profile_id.as_deref())
        .is_ok_and(|profile| profile.remote.is_some());
    let (id, _) = if remote {
        let waiting = app.clone();
        let profile_id = profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = waiting.state::<AppState>();
            create_session(
                &waiting,
                &state,
                profile_id.as_deref(),
                cwd.as_deref(),
                env,
                cols,
                rows,
                on_output,
            )
        })
        .await
        .map_err(|e| e.to_string())??
    } else {
        create_session(
            &app,
            &state,
            profile_id.as_deref(),
            cwd.as_deref(),
            env,
            cols,
            rows,
            on_output,
        )?
    };
    // The shell of a pane is written down with it, so a later run can find it again.
    if let Some(pane) = pane_id {
        state.bind_pane(&pane, SessionId(id));
    }
    Ok(id)
}

/// Builds the store for `state.json` inside the app data folder. Only resolves the path: the
/// folder is created on the first save.
pub fn state_store(app: &AppHandle) -> Result<StateStore, String> {
    state_file(app).map(StateStore::new)
}

/// Where `state.json` lives (the file may not be there yet).
pub fn state_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the app data folder: {e}"))?;
    Ok(dir.join(STATE_FILE_NAME))
}

/// Reads `state.json` as text; `None` when there is no file yet. Bytes that are not valid UTF-8
/// are replaced, so a damaged file still reaches the interface, fails to parse there and goes to
/// `state_quarantine` (which copies the original bytes, not this text).
#[tauri::command]
pub async fn state_load<R: Runtime>(
    window: tauri::Window<R>,
    store: State<'_, StateStore>,
) -> Result<Option<String>, String> {
    crate::windows::require_owner(&window)?;
    store
        .load()
        .map(|bytes| bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
        .map_err(|e| e.to_string())
}

/// Replaces `state.json` atomically with `content`.
#[tauri::command]
pub async fn state_save<R: Runtime>(
    window: tauri::Window<R>,
    store: State<'_, StateStore>,
    content: String,
) -> Result<(), String> {
    crate::windows::require_owner(&window)?;
    store.save(content.as_bytes()).map_err(|e| e.to_string())
}

/// Copies `state.json` to `state.broken-<UTC date and time>.json` next to it, leaves the
/// original in place and returns the path of the copy.
#[tauri::command]
pub async fn state_quarantine<R: Runtime>(
    window: tauri::Window<R>,
    store: State<'_, StateStore>,
) -> Result<String, String> {
    crate::windows::require_owner(&window)?;
    store
        .quarantine()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Name of the event emitted when `config.jsonc` changes. The payload is the new text of the file,
/// or `null` when the file was removed.
pub const CONFIG_CHANGED_EVENT: &str = "config-changed";

/// The settings file, and the watching of it, which starts when the interface asks for it.
pub struct ConfigState {
    pub store: ConfigStore,
    watcher: Mutex<Option<ConfigWatcher>>,
    watching_allowed: bool,
    writing_allowed: bool,
}

impl ConfigState {
    pub fn new(store: ConfigStore) -> Self {
        Self {
            store,
            watcher: Mutex::new(None),
            watching_allowed: true,
            writing_allowed: true,
        }
    }

    /// The same, but `watch` does nothing and `save` refuses. Watching creates the config folder
    /// when it is missing, and saving writes the file, and the smoke run must leave the folders and
    /// the files of the user as they are (a choice kept by an earlier build in the window storage
    /// would otherwise be moved into the real file by the check).
    pub fn without_watching(mut self) -> Self {
        self.watching_allowed = false;
        self.writing_allowed = false;
        self
    }

    /// Replaces the file with `text`, exactly as given, creating the file and its folder when there
    /// are none. The interface edits the text (it keeps the comments of the file); this only
    /// writes it, atomically.
    pub fn save(&self, text: &str) -> Result<(), String> {
        if !self.writing_allowed {
            return Err("this run does not write the settings file".to_owned());
        }
        self.store.save(text).map_err(|e| e.to_string())
    }

    /// Starts calling `on_change` when the file changes, unless the file is already watched (the
    /// page reloaded and asked again): then the first watching goes on and `on_change` is dropped.
    pub fn watch(&self, on_change: impl Fn(Option<String>) + Send + 'static) -> Result<(), String> {
        if !self.watching_allowed {
            return Ok(());
        }
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if watcher.is_none() {
            *watcher = Some(self.store.watch(on_change).map_err(|e| e.to_string())?);
        }
        Ok(())
    }
}

/// Builds the store for `config.jsonc` inside the app config folder. Only resolves the path: the
/// folder is created when the file is first saved or watched.
pub fn config_store(app: &AppHandle) -> Result<ConfigStore, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(ConfigStore::new(dir.join(CONFIG_FILE_NAME)))
}

/// Reads `config.jsonc` as text; `None` when there is no file yet. Parsing and validation belong
/// to the interface.
#[tauri::command]
pub async fn config_load(state: State<'_, ConfigState>) -> Result<Option<String>, String> {
    state.store.load().map_err(|e| e.to_string())
}

/// Replaces `config.jsonc` atomically with `content`, creating the file when there is none. The
/// watching, when it is on, reports this save like any other change.
#[tauri::command]
pub async fn config_save(state: State<'_, ConfigState>, content: String) -> Result<(), String> {
    state.save(&content)
}

/// Starts telling the interface, with the `config-changed` event, every time `config.jsonc`
/// changes. Asking again changes nothing.
#[tauri::command]
pub async fn config_watch(app: AppHandle, state: State<'_, ConfigState>) -> Result<(), String> {
    state.watch(move |text| {
        // A failed emit means the interface is gone; the next change tries again.
        let _ = app.emit(CONFIG_CHANGED_EVENT, text);
    })
}

/// The folder of the themes of the user, next to `config.jsonc`.
pub struct ThemeState {
    pub store: ThemeStore,
    writing_allowed: bool,
}

impl ThemeState {
    pub fn new(store: ThemeStore) -> Self {
        Self {
            store,
            writing_allowed: true,
        }
    }

    /// The same, but `save` refuses: the smoke run must leave the files of the user as they are.
    /// Listing still works (it only reads, and never creates the folder).
    pub fn without_writing(mut self) -> Self {
        self.writing_allowed = false;
        self
    }

    /// The text of every theme file that can be a theme (see [`ThemeStore::list`]).
    pub fn list(&self) -> Result<Vec<String>, String> {
        self.store.list().map_err(|e| e.to_string())
    }

    /// Writes the theme file of `id` atomically. Refuses an id that is not a theme id.
    pub fn save(&self, id: &str, text: &str) -> Result<(), String> {
        if !self.writing_allowed {
            return Err("this run does not write theme files".to_owned());
        }
        self.store.save(id, text).map_err(|e| e.to_string())
    }
}

/// Builds the store for the themes of the user: the `themes` folder inside the app config folder.
/// Only resolves the path: the folder is created when a theme is first saved.
pub fn theme_store(app: &AppHandle) -> Result<ThemeStore, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(ThemeStore::new(dir.join(THEMES_DIR_NAME)))
}

/// The text of the theme files of the user, in the order of the file names. Validating them
/// against the schema of a theme belongs to the interface.
#[tauri::command]
pub async fn theme_list(state: State<'_, ThemeState>) -> Result<Vec<String>, String> {
    state.list()
}

/// Writes `themes/<id>.json` atomically with `content`, creating the folder when there is none.
#[tauri::command]
pub async fn theme_save(
    state: State<'_, ThemeState>,
    id: String,
    content: String,
) -> Result<(), String> {
    state.save(&id, &content)
}

/// One result of the bench as the interface sees it: the name of its file and its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BenchFileDto {
    pub name: String,
    pub text: String,
}

impl From<BenchFile> for BenchFileDto {
    fn from(file: BenchFile) -> Self {
        Self {
            name: file.name,
            text: file.text,
        }
    }
}

/// The folder of the bench results, `bench-results` in the app data folder next to `state.json`.
pub struct BenchState {
    pub store: BenchStore,
    writing_allowed: bool,
}

impl BenchState {
    pub fn new(store: BenchStore) -> Self {
        Self {
            store,
            writing_allowed: true,
        }
    }

    /// The same, but `save` refuses: the smoke run must leave the files of the user as they are.
    /// Listing still works (it only reads, and never creates the folder).
    pub fn without_writing(mut self) -> Self {
        self.writing_allowed = false;
        self
    }

    /// The results in the folder, newest first (see [`BenchStore::list`]).
    pub fn list(&self) -> Result<Vec<BenchFileDto>, String> {
        self.store
            .list()
            .map(|files| files.into_iter().map(BenchFileDto::from).collect())
            .map_err(|e| e.to_string())
    }

    /// Writes the run in `text`, named from its start time, and returns the name of the file.
    pub fn save(&self, text: &str) -> Result<String, String> {
        if !self.writing_allowed {
            return Err("this run does not write bench results".to_owned());
        }
        self.store.save(text).map_err(|e| e.to_string())
    }
}

/// Builds the store for the bench results: the `bench-results` folder inside the app data folder,
/// next to `state.json`. Only resolves the path: the folder is created when a result is first saved.
pub fn bench_store(app: &AppHandle) -> Result<BenchStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the app data folder: {e}"))?;
    Ok(BenchStore::new(dir.join(BENCH_DIR_NAME)))
}

/// The bench results saved so far, newest first. Validating them against the schema of a run
/// belongs to the interface.
#[tauri::command]
pub async fn bench_list(state: State<'_, BenchState>) -> Result<Vec<BenchFileDto>, String> {
    state.list()
}

/// Writes the run in `content` to `bench-results/<start time>.json` atomically, creating the folder
/// when there is none, and returns the name of the file. The name is made from the `startedAt` of
/// the run: the interface does not name files.
#[tauri::command]
pub async fn bench_save(state: State<'_, BenchState>, content: String) -> Result<String, String> {
    state.save(&content)
}

/// The folder of the scrollback snapshots of the panes, next to `state.json`.
pub struct ScrollbackState {
    pub store: ScrollbackStore,
    writing_allowed: bool,
}

impl ScrollbackState {
    pub fn new(store: ScrollbackStore) -> Self {
        Self {
            store,
            writing_allowed: true,
        }
    }

    /// The same, but `save` and `delete` refuse: the smoke run must leave the files of the user as
    /// they are. Loading still works (it only reads, and never creates the folder).
    pub fn without_writing(mut self) -> Self {
        self.writing_allowed = false;
        self
    }

    /// The snapshot of the pane, or `None` when it has none (see [`ScrollbackStore::load`]).
    pub fn load(&self, pane_id: &str) -> Result<Option<String>, String> {
        self.store.load(pane_id).map_err(|e| e.to_string())
    }

    /// Writes the snapshot of the pane atomically. Refuses an id that is not a pane id and a text
    /// over the size limit.
    pub fn save(&self, pane_id: &str, text: &str) -> Result<(), String> {
        if !self.writing_allowed {
            return Err("this run does not write scrollback files".to_owned());
        }
        self.store.save(pane_id, text).map_err(|e| e.to_string())
    }

    /// The ids of the panes that have a snapshot, sorted (see [`ScrollbackStore::list`]). Only reads.
    pub fn list(&self) -> Result<Vec<String>, String> {
        self.store.list().map_err(|e| e.to_string())
    }

    /// Removes the snapshot of the pane; a pane with none is not an error.
    pub fn delete(&self, pane_id: &str) -> Result<(), String> {
        if !self.writing_allowed {
            return Err("this run does not remove scrollback files".to_owned());
        }
        self.store.delete(pane_id).map_err(|e| e.to_string())
    }
}

/// Builds the store for the snapshots: the `scrollback` folder inside the app data folder, next to
/// `state.json`. Only resolves the path: the folder is created when a snapshot is first saved.
pub fn scrollback_store(app: &AppHandle) -> Result<ScrollbackStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the app data folder: {e}"))?;
    Ok(ScrollbackStore::new(dir.join(SCROLLBACK_DIR_NAME)))
}

/// The scrollback snapshot of a pane as text, or `null` when it has none. The interface cleans it
/// before it reaches a terminal: what is on disk is not trusted.
#[tauri::command(rename_all = "camelCase")]
pub async fn scrollback_load(
    state: State<'_, ScrollbackState>,
    pane_id: String,
) -> Result<Option<String>, String> {
    state.load(&pane_id)
}

/// Writes `scrollback/<paneId>.txt` atomically with `content`, creating the folder when there is
/// none. The pane id becomes a file name, so one that is not a pane id is refused.
#[tauri::command(rename_all = "camelCase")]
pub async fn scrollback_save(
    state: State<'_, ScrollbackState>,
    pane_id: String,
    content: String,
) -> Result<(), String> {
    state.save(&pane_id, &content)
}

/// The ids of the panes that have a snapshot file, sorted. The page uses it to find the files that no
/// pane claims. Never creates the folder.
#[tauri::command(rename_all = "camelCase")]
pub async fn scrollback_list(state: State<'_, ScrollbackState>) -> Result<Vec<String>, String> {
    state.list()
}

/// Removes the snapshot of a pane. A pane with none is not an error.
#[tauri::command(rename_all = "camelCase")]
pub async fn scrollback_delete(
    state: State<'_, ScrollbackState>,
    pane_id: String,
) -> Result<(), String> {
    state.delete(&pane_id)
}

/// The pictures a background can be, read from an absolute path or from inside the config folder.
pub struct BackgroundState {
    pub store: BackgroundStore,
}

impl BackgroundState {
    pub fn new(store: BackgroundStore) -> Self {
        Self { store }
    }
}

/// Builds the reader of background pictures: a relative path is a path inside the app config
/// folder. Only resolves the path; nothing is created.
pub fn background_store(app: &AppHandle) -> Result<BackgroundStore, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(BackgroundStore::new(dir))
}

/// The longest title or filter name the page may put on the file chooser, in characters.
const PICKER_TEXT_MAX: usize = 80;

/// A line of text for the file chooser, as the page said it: trimmed, without control characters
/// and no longer than [`PICKER_TEXT_MAX`]; `fallback` when nothing is left.
fn picker_text(text: &str, fallback: &str) -> String {
    let clean: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(PICKER_TEXT_MAX)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        fallback.to_owned()
    } else {
        clean.to_owned()
    }
}

/// The picture the person chooses in the file chooser of the system (the "Choose image..." buttons
/// of the settings screen and of the background dialog of a space): its path, or `None` when the
/// chooser was closed without a choice. The chooser opens over the window that asked and lists the
/// picture kinds a background can be ([`noren_core::background::BACKGROUND_EXTENSIONS`]); a file
/// of another kind can still be typed into it, and `background_image_read` refuses it later, with
/// a sentence, like any other path. `title` and `filter` are the words of the language in force,
/// which only the page knows. Nothing is read or written here: the file is opened only when the
/// page asks for its bytes.
#[tauri::command]
pub async fn background_image_pick(
    window: tauri::Window,
    title: String,
    filter: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(picker_text(&title, "Choose a background image"))
        .add_filter(
            picker_text(&filter, "Pictures"),
            &noren_core::background::BACKGROUND_EXTENSIONS,
        )
        .pick_file(move |chosen| {
            let _ = sender.send(chosen);
        });
    let Some(chosen) = receiver
        .await
        .map_err(|_| "the file chooser ended without an answer".to_string())?
    else {
        return Ok(None);
    };
    chosen
        .into_path()
        .map(|path| Some(path.to_string_lossy().into_owned()))
        .map_err(|e| format!("the file chooser gave a path that is not a file: {e}"))
}

/// The bytes of the picture at `path`, as a raw response (not JSON, since a picture is megabytes).
/// The path and the file are checked by [`BackgroundStore::read`]: only a picture file of a
/// bounded size is ever returned, and nothing is fetched from the network.
#[tauri::command]
pub async fn background_image_read(
    state: State<'_, BackgroundState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    state
        .store
        .read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// The file at `path` as the preview pane shows it, as one raw frame (a picture is megabytes, and
/// JSON would make a list of numbers of it): the header length, a JSON header and the body, see
/// [`noren_core::FilePreview::to_frame`]. A file that cannot be shown is an answer (a frame whose
/// header says why), not an error. `read_file_preview` checks the path and the file; the read runs
/// off the async workers.
#[tauri::command]
pub async fn file_preview_read(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || noren_core::read_file_preview(&path).to_frame())
        .await
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("could not read the file: {e}"))
}

/// The git diff of the folder `cwd` for the diff pane: the working tree and the index against
/// `HEAD`, as the text `git diff` prints, as JSON (`{"kind":"diff","text":...}`), or the reason
/// there is none (`{"kind":"refused","reason":...}`): a folder that is no full local path, one
/// that is not there, one in no repository, no `git`, a diff past the cap. A refusal is an answer,
/// not an error. `noren-core` checks the folder and runs `git` (reading only, nothing from the
/// repository's own settings run); the run waits on a process, so it is off the async workers.
#[tauri::command]
pub async fn git_diff_read(cwd: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || noren_core::read_git_diff(&cwd).to_json())
        .await
        .map_err(|e| format!("could not read the diff: {e}"))
}

/// The monospaced font families installed on this machine, once each and in alphabetical order.
/// It only reads the system font folders (the smoke run may call it as well); a family name that is
/// not the name of a font is left out, so the list is safe to show and to write into the settings.
/// The scan reads font files, so it runs off the async workers.
#[tauri::command]
pub async fn fonts_list_monospace() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(noren_core::list_monospace_families)
        .await
        .map_err(|e| format!("could not list the fonts: {e}"))
}

/// What `hardware_read` finds: the memory of this machine in bytes. `vramBytes` is `null` when
/// the video memory is not known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub ram_bytes: u64,
    pub vram_bytes: Option<u64>,
}

impl From<noren_core::Hardware> for HardwareInfo {
    fn from(hardware: noren_core::Hardware) -> Self {
        HardwareInfo {
            ram_bytes: hardware.ram_bytes,
            vram_bytes: hardware.vram_bytes,
        }
    }
}

/// Where the memory of the machine is read from: the real source in the app, a made-up one in a
/// test of the command (so that test starts no `nvidia-smi`).
pub struct HardwareState {
    source: Arc<dyn noren_core::HardwareSource + Send + Sync>,
}

impl HardwareState {
    /// The memory of this machine, read with `sysinfo` and `nvidia-smi`.
    pub fn system() -> Self {
        Self::with_source(noren_core::SystemHardware::new())
    }

    pub fn with_source(source: impl noren_core::HardwareSource + Send + Sync + 'static) -> Self {
        Self {
            source: Arc::new(source),
        }
    }
}

/// The RAM and the video memory of this machine, to choose a local model that fits it, or `null`
/// when the system would not say how much RAM there is. The VRAM is `null` whenever it is not
/// known (no `nvidia-smi`, no NVIDIA card, an answer that makes no sense): it is never an error.
/// Reading it may start `nvidia-smi` (hidden, with a short timeout), so it runs off the async
/// workers. It only reads: nothing is written and nothing is sent anywhere.
#[tauri::command]
pub async fn hardware_read(
    state: State<'_, HardwareState>,
) -> Result<Option<HardwareInfo>, String> {
    let source = Arc::clone(&state.source);
    tauri::async_runtime::spawn_blocking(move || {
        noren_core::read_hardware(source.as_ref()).map(HardwareInfo::from)
    })
    .await
    .map_err(|e| format!("could not read the hardware: {e}"))
}

/// Gives the window the effect named `effect` (`none`, `mica`, `acrylic` or `vibrancy`), painted in
/// the look `scheme` names (`dark` or `light`: the kind of a theme that was chosen; `system`: the
/// mode of the system), and answers what it has: a system that cannot paint it keeps the window
/// opaque and the answer says why. The outcome goes to the log.
///
/// The caller is taken as a `Window`: Tauri refuses a `WebviewWindow` argument from a window that
/// has a browser pane's web view as a child (the main window while a pane is open, or a window that
/// holds a tab with one), and changing the theme must work then.
#[tauri::command]
pub async fn window_effect_set<R: tauri::Runtime>(
    window: tauri::Window<R>,
    effect: String,
    scheme: String,
) -> Result<crate::window_effect::EffectReportDto, String> {
    let requested =
        WindowEffect::parse(&effect).ok_or_else(|| format!("'{effect}' is not a window effect"))?;
    let look = crate::window_effect::parse_scheme(&scheme)?;
    let outcome = crate::window_effect::apply_on_main_thread(&window, requested, look)?;
    eprintln!("noren: {}", outcome.log_line());
    Ok(outcome.into())
}

/// Name of the event emitted when a file of the `mods` folder is added, changed or removed. The
/// payload is the whole list of mods after the change.
pub const MODS_CHANGED_EVENT: &str = "mods-changed";

/// One mod as the interface sees it: the name of its file and its CSS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModFileDto {
    pub name: String,
    pub text: String,
}

impl From<ModFile> for ModFileDto {
    fn from(file: ModFile) -> Self {
        Self {
            name: file.name,
            text: file.text,
        }
    }
}

/// The folder of the mods of the user, next to `config.jsonc`, and the watching of it, which starts
/// when the interface asks for it. The app only reads the folder: a mod is a file the person puts
/// there.
pub struct ModState {
    pub store: ModStore,
    watcher: Mutex<Option<ModWatcher>>,
    watching_allowed: bool,
}

impl ModState {
    pub fn new(store: ModStore) -> Self {
        Self {
            store,
            watcher: Mutex::new(None),
            watching_allowed: true,
        }
    }

    /// The same, but `watch` does nothing: watching creates the mods folder when it is missing, and
    /// the smoke run must leave the folders of the user as they are. Listing still works (it only
    /// reads, and never creates the folder).
    pub fn without_watching(mut self) -> Self {
        self.watching_allowed = false;
        self
    }

    /// The mods in the folder (see [`ModStore::list`]).
    pub fn list(&self) -> Result<Vec<ModFileDto>, String> {
        self.store
            .list()
            .map(|files| files.into_iter().map(ModFileDto::from).collect())
            .map_err(|e| e.to_string())
    }

    /// Starts calling `on_change` when the files change, unless the folder is already watched (the
    /// page reloaded and asked again): then the first watching goes on and `on_change` is dropped.
    pub fn watch(
        &self,
        on_change: impl Fn(Vec<ModFileDto>) + Send + 'static,
    ) -> Result<(), String> {
        if !self.watching_allowed {
            return Ok(());
        }
        let mut watcher = self.watcher.lock().unwrap_or_else(|e| e.into_inner());
        if watcher.is_none() {
            *watcher = Some(
                self.store
                    .watch(move |files| {
                        on_change(files.into_iter().map(ModFileDto::from).collect())
                    })
                    .map_err(|e| e.to_string())?,
            );
        }
        Ok(())
    }
}

/// Builds the store for the mods of the user: the `mods` folder inside the app config folder. Only
/// resolves the path: the folder is created when it is first watched.
pub fn mod_store(app: &AppHandle) -> Result<ModStore, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(ModStore::new(dir.join(MODS_DIR_NAME)))
}

/// The mods of the user, in the order of the file names. Applying them belongs to the interface.
#[tauri::command]
pub async fn mod_list(state: State<'_, ModState>) -> Result<Vec<ModFileDto>, String> {
    state.list()
}

/// Starts telling the interface, with the `mods-changed` event, every time the mods change. Asking
/// again changes nothing.
#[tauri::command]
pub async fn mod_watch(app: AppHandle, state: State<'_, ModState>) -> Result<(), String> {
    state.watch(move |files| {
        // A failed emit means the interface is gone; the next change tries again.
        let _ = app.emit(MODS_CHANGED_EVENT, files);
    })
}

/// One folder of the plugins folder as the interface sees it: its name and either the text of the
/// manifest and of the main file or the sentence that says why it is not a plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginFolderDto {
    pub folder: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl From<PluginFolder> for PluginFolderDto {
    fn from(plugin: PluginFolder) -> Self {
        match plugin.files {
            Ok(files) => Self {
                folder: plugin.folder,
                manifest: Some(files.manifest),
                main: Some(files.main),
                error: None,
            },
            Err(error) => Self {
                folder: plugin.folder,
                manifest: None,
                main: None,
                error: Some(error),
            },
        }
    }
}

/// The plugin folders of the store (see [`PluginStore::list`]). Only reads: the folder is never
/// made, and nothing watches it.
pub fn list_plugins(store: &PluginStore) -> Result<Vec<PluginFolderDto>, String> {
    store
        .list()
        .map(|plugins| plugins.into_iter().map(PluginFolderDto::from).collect())
        .map_err(|e| e.to_string())
}

/// Builds the store for the plugins of the user: the `plugins` folder inside the app config
/// folder. Only resolves the path: the folder is the user's to make.
pub fn plugin_store(app: &AppHandle) -> Result<PluginStore, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(PluginStore::new(dir.join(PLUGINS_DIR_NAME)))
}

/// The plugin folders of the user, by name: the text of `plugin.json` and of the file its `main`
/// names, or why the folder is not a plugin. Checking the manifest and running the code belong to
/// the interface.
#[tauri::command]
pub async fn plugins_list(store: State<'_, PluginStore>) -> Result<Vec<PluginFolderDto>, String> {
    // Up to a few dozen files of 256 KiB: read off the thread that answers the interface.
    let store = PluginStore::new(store.dir());
    tauri::async_runtime::spawn_blocking(move || list_plugins(&store))
        .await
        .map_err(|e| e.to_string())?
}

/// One item the app installed from the gallery, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstalledItemDto {
    pub id: String,
    pub kind: String,
    pub version: String,
    pub sha256: String,
}

impl From<InstalledItem> for InstalledItemDto {
    fn from(item: InstalledItem) -> Self {
        Self {
            id: item.id,
            kind: item.kind.as_str().to_owned(),
            version: item.version,
            sha256: item.sha256,
        }
    }
}

/// The gallery of themes and mods: downloads from the address of the index and installs into the
/// config folder of the app (`themes/`, `mods/` and the record `gallery.json`).
pub struct GalleryState {
    gallery: Gallery,
    installing_allowed: bool,
}

impl GalleryState {
    pub fn new(gallery: Gallery) -> Self {
        Self {
            gallery,
            installing_allowed: true,
        }
    }

    /// The same, but `install` refuses: the smoke run must leave the files of the user as they are.
    pub fn without_installing(mut self) -> Self {
        self.installing_allowed = false;
        self
    }

    /// The text of the index, downloaded and checked (see [`Gallery::index_text`]).
    pub async fn index(&self) -> Result<String, String> {
        self.gallery.index_text().await.map_err(|e| e.to_string())
    }

    /// What was installed from the gallery (see [`Gallery::installed`]).
    pub fn installed(&self) -> Vec<InstalledItemDto> {
        self.gallery
            .installed()
            .into_iter()
            .map(InstalledItemDto::from)
            .collect()
    }

    /// Installs or updates the item `id` (see [`Gallery::install`]); nothing is written when the
    /// hash of the download is not the one the index declares.
    pub async fn install(&self, id: &str) -> Result<InstalledItemDto, String> {
        if !self.installing_allowed {
            return Err("this run does not install from the gallery".to_owned());
        }
        self.gallery
            .install(id)
            .await
            .map(InstalledItemDto::from)
            .map_err(|e| e.to_string())
    }
}

/// Builds the gallery of the user: it installs into the app config folder. Only resolves the
/// path: the folders and the record are made when something is installed.
pub fn gallery_state(app: &AppHandle) -> Result<GalleryState, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Gallery::new(dir)
        .map(GalleryState::new)
        .map_err(|e| e.to_string())
}

/// The index of the gallery, downloaded over https and checked: its text as the gallery served it
/// (the interface checks it again with `parseGalleryIndex`).
#[tauri::command]
pub async fn gallery_index(state: State<'_, GalleryState>) -> Result<String, String> {
    state.index().await
}

/// What was installed from the gallery, in the order of the first installation.
#[tauri::command]
pub async fn gallery_installed(
    state: State<'_, GalleryState>,
) -> Result<Vec<InstalledItemDto>, String> {
    Ok(state.installed())
}

/// Installs or updates the item `id` of the gallery: downloads it, refuses it unless its sha256 is
/// the one the index declares, and puts it in `themes/` or `mods/`.
#[tauri::command]
pub async fn gallery_install(
    state: State<'_, GalleryState>,
    id: String,
) -> Result<InstalledItemDto, String> {
    state.install(&id).await
}

/// One file the next push would carry, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncChangeDto {
    pub path: String,
    /// `added` or `modified`.
    pub change: String,
}

/// Where the sync through git stands, as the interface sees it (see [`SyncStatus`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncStatusDto {
    pub connected: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub pending: Vec<SyncChangeDto>,
    pub ahead: usize,
    pub behind: usize,
}

impl From<SyncStatus> for SyncStatusDto {
    fn from(status: SyncStatus) -> Self {
        Self {
            connected: status.connected,
            remote: status.remote,
            branch: status.branch,
            pending: status
                .pending
                .into_iter()
                .map(|change| SyncChangeDto {
                    path: change.path,
                    change: change.kind.as_str().to_owned(),
                })
                .collect(),
            ahead: status.ahead,
            behind: status.behind,
        }
    }
}

/// What a pull did, as the interface sees it: `{"kind":"up_to_date"}`,
/// `{"kind":"updated","files":[...]}` or `{"kind":"conflict","paths":[...]}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncPullDto {
    UpToDate,
    Updated { files: Vec<String> },
    Conflict { paths: Vec<String> },
}

impl From<PullOutcome> for SyncPullDto {
    fn from(outcome: PullOutcome) -> Self {
        match outcome {
            PullOutcome::UpToDate => Self::UpToDate,
            PullOutcome::Updated(files) => Self::Updated { files },
            PullOutcome::Conflicts(paths) => Self::Conflict { paths },
        }
    }
}

/// What a push did, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncPushDto {
    pub committed: bool,
    pub pushed: bool,
    pub files: Vec<String>,
}

impl From<PushOutcome> for SyncPushDto {
    fn from(outcome: PushOutcome) -> Self {
        Self {
            committed: outcome.committed,
            pushed: outcome.pushed,
            files: outcome.files,
        }
    }
}

/// The space a space file is tied to on this computer, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSpaceLinkDto {
    pub space_id: String,
    pub hash: String,
}

/// One space file of the config folder: its name, the sha256 of its bytes and its link, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncSpaceFileDto {
    pub name: String,
    pub hash: String,
    pub linked: Option<SyncSpaceLinkDto>,
}

/// The space files of the config folder and the names the clone of the sync holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncSpaceFolderDto {
    pub files: Vec<SyncSpaceFileDto>,
    pub cloned: Vec<String>,
}

impl From<SpaceFolder> for SyncSpaceFolderDto {
    fn from(folder: SpaceFolder) -> Self {
        Self {
            files: folder
                .files
                .into_iter()
                .map(|file| SyncSpaceFileDto {
                    name: file.name,
                    hash: file.hash,
                    linked: file.link.map(|link| SyncSpaceLinkDto {
                        space_id: link.space_id,
                        hash: link.hash,
                    }),
                })
                .collect(),
            cloned: folder.cloned,
        }
    }
}

/// A space file the interface asks to write, with the space it is made from.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSpaceWriteDto {
    pub name: String,
    pub text: String,
    pub space_id: String,
}

/// A space file the interface asks to tie to a space.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSpaceLinkRequestDto {
    pub name: String,
    pub space_id: String,
}

/// The sync of the settings through git: one clone next to `config.jsonc`, one step at a time.
pub struct SyncState {
    repo: SyncRepo,
    /// Held for a whole step: two pulls or a push during a pull would fight over the clone.
    busy: Mutex<()>,
    syncing_allowed: bool,
}

impl SyncState {
    pub fn new(repo: SyncRepo) -> Self {
        Self {
            repo,
            busy: Mutex::new(()),
            syncing_allowed: true,
        }
    }

    /// The same, but connecting, pulling and pushing refuse: the smoke run must leave the files of
    /// the user as they are. The status is only a read.
    pub fn without_syncing(mut self) -> Self {
        self.syncing_allowed = false;
        self
    }

    fn step<T>(
        &self,
        run: impl FnOnce(&SyncRepo) -> Result<T, noren_core::SyncError>,
    ) -> Result<T, String> {
        if !self.syncing_allowed {
            return Err("this run does not sync".to_owned());
        }
        let _turn = self.busy.lock().map_err(|e| e.to_string())?;
        run(&self.repo).map_err(|e| e.to_string())
    }

    /// Where the sync stands (see [`SyncRepo::status`]).
    pub fn status(&self) -> Result<SyncStatusDto, String> {
        let _turn = self.busy.lock().map_err(|e| e.to_string())?;
        self.repo
            .status()
            .map(SyncStatusDto::from)
            .map_err(|e| e.to_string())
    }

    /// Connects to `remote` (see [`SyncRepo::connect`]).
    pub fn connect(&self, remote: &str) -> Result<SyncStatusDto, String> {
        self.step(|repo| repo.connect(remote))
            .map(SyncStatusDto::from)
    }

    /// Pulls (see [`SyncRepo::pull`]).
    pub fn pull(&self) -> Result<SyncPullDto, String> {
        self.step(SyncRepo::pull).map(SyncPullDto::from)
    }

    /// Pushes (see [`SyncRepo::push`]).
    pub fn push(&self) -> Result<SyncPushDto, String> {
        self.step(SyncRepo::push).map(SyncPushDto::from)
    }

    /// The space files of the config folder (see [`SpaceFiles::list`]). Only a read, but it waits
    /// for a pull or a push in progress so it never sees half of one.
    pub fn spaces_list(&self) -> Result<SyncSpaceFolderDto, String> {
        let _turn = self.busy.lock().map_err(|e| e.to_string())?;
        self.repo
            .space_files()
            .list()
            .map(SyncSpaceFolderDto::from)
            .map_err(|e| e.to_string())
    }

    /// The text of one space file (see [`SpaceFiles::read`]).
    pub fn spaces_read(&self, name: &str) -> Result<String, String> {
        let _turn = self.busy.lock().map_err(|e| e.to_string())?;
        self.repo
            .space_files()
            .read(name)
            .map_err(|e| e.to_string())
    }

    /// Writes space files and ties them to their spaces (see [`SpaceFiles::write`]). Refused in a
    /// smoke run, which must leave the files of the user as they are.
    pub fn spaces_write(&self, files: Vec<SyncSpaceWriteDto>) -> Result<(), String> {
        let files: Vec<SpaceFileWrite> = files
            .into_iter()
            .map(|file| SpaceFileWrite {
                name: file.name,
                text: file.text,
                space_id: file.space_id,
            })
            .collect();
        self.step(|repo| repo.space_files().write(&files))
    }

    /// Ties space files to the spaces made from them (see [`SpaceFiles::link`]). Refused in a
    /// smoke run.
    pub fn spaces_link(&self, links: Vec<SyncSpaceLinkRequestDto>) -> Result<(), String> {
        let links: Vec<SpaceFileLink> = links
            .into_iter()
            .map(|link| SpaceFileLink {
                name: link.name,
                space_id: link.space_id,
            })
            .collect();
        self.step(|repo| repo.space_files().link(&links))
    }
}

/// Builds the sync of the user over the app config folder. Only resolves the path: the clone is
/// made when a remote is connected.
pub fn sync_state(app: &AppHandle) -> Result<SyncState, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    Ok(SyncState::new(SyncRepo::new(dir)))
}

/// Where the sync through git stands, with no network.
#[tauri::command]
pub async fn sync_status(state: State<'_, Arc<SyncState>>) -> Result<SyncStatusDto, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.status())
        .await
        .map_err(|e| e.to_string())?
}

/// Connects to the git remote `remote` (clones it next to the config); the address is checked first.
#[tauri::command]
pub async fn sync_connect(
    state: State<'_, Arc<SyncState>>,
    remote: String,
) -> Result<SyncStatusDto, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.connect(&remote))
        .await
        .map_err(|e| e.to_string())?
}

/// Brings the remote into the config folder; a conflict writes nothing and lists the paths.
#[tauri::command]
pub async fn sync_pull(state: State<'_, Arc<SyncState>>) -> Result<SyncPullDto, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.pull())
        .await
        .map_err(|e| e.to_string())?
}

/// Commits the changed allowed files and pushes them to the remote.
#[tauri::command]
pub async fn sync_push(state: State<'_, Arc<SyncState>>) -> Result<SyncPushDto, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.push())
        .await
        .map_err(|e| e.to_string())?
}

/// The space files of the config folder, their links to spaces and the names the clone holds.
#[tauri::command]
pub async fn sync_spaces_list(
    state: State<'_, Arc<SyncState>>,
) -> Result<SyncSpaceFolderDto, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.spaces_list())
        .await
        .map_err(|e| e.to_string())?
}

/// The text of one space file; a name off the closed list is refused.
#[tauri::command]
pub async fn sync_spaces_read(
    state: State<'_, Arc<SyncState>>,
    name: String,
) -> Result<String, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.spaces_read(&name))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes space files into the config folder and ties each to the space it was made from.
#[tauri::command]
pub async fn sync_spaces_write(
    state: State<'_, Arc<SyncState>>,
    files: Vec<SyncSpaceWriteDto>,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.spaces_write(files))
        .await
        .map_err(|e| e.to_string())?
}

/// Ties space files already in the config folder to the spaces made from them.
#[tauri::command]
pub async fn sync_spaces_link(
    state: State<'_, Arc<SyncState>>,
    links: Vec<SyncSpaceLinkRequestDto>,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.spaces_link(links))
        .await
        .map_err(|e| e.to_string())?
}

/// Where the sync through a gist stands, as the interface sees it (see [`GistStatus`]). The token
/// is never part of it: the status only says whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncGistStatusDto {
    pub connected: bool,
    pub gist_id: Option<String>,
    /// Anyone can read the settings in the gist.
    pub public: bool,
    pub has_token: bool,
    pub pending: Vec<SyncChangeDto>,
}

impl From<GistStatus> for SyncGistStatusDto {
    fn from(status: GistStatus) -> Self {
        Self {
            connected: status.connected,
            gist_id: status.gist_id,
            public: status.public,
            has_token: status.has_token,
            pending: status
                .pending
                .into_iter()
                .map(|change| SyncChangeDto {
                    path: change.path,
                    change: change.kind.as_str().to_owned(),
                })
                .collect(),
        }
    }
}

/// The sync of the settings through a gist: one record next to `config.jsonc`, the token in the
/// keychain, one step at a time (the sync holds its own turn).
pub struct GistState {
    gist: GistSync,
    syncing_allowed: bool,
}

impl GistState {
    pub fn new(gist: GistSync) -> Self {
        Self {
            gist,
            syncing_allowed: true,
        }
    }

    /// The same, but storing or removing the token, connecting, pulling and pushing refuse: the
    /// smoke run must leave the files and the keychain of the user as they are. The status is only
    /// a read.
    pub fn without_syncing(mut self) -> Self {
        self.syncing_allowed = false;
        self
    }

    fn allowed(&self) -> Result<(), String> {
        if self.syncing_allowed {
            Ok(())
        } else {
            Err("this run does not sync".to_owned())
        }
    }

    /// Where the sync stands, with no network (see [`GistSync::status`]).
    pub fn status(&self) -> Result<SyncGistStatusDto, String> {
        self.gist
            .status()
            .map(SyncGistStatusDto::from)
            .map_err(|e| e.to_string())
    }

    /// Stores the token in the keychain (see [`GistSync::set_token`]).
    pub fn set_token(&self, token: &str) -> Result<(), String> {
        self.allowed()?;
        self.gist.set_token(token).map_err(|e| e.to_string())
    }

    /// Removes the token from the keychain (see [`GistSync::clear_token`]).
    pub fn clear_token(&self) -> Result<(), String> {
        self.allowed()?;
        self.gist.clear_token().map_err(|e| e.to_string())
    }

    /// Connects to a gist, or makes a secret one (see [`GistSync::connect`]).
    pub async fn connect(&self, gist_id: Option<&str>) -> Result<SyncGistStatusDto, String> {
        self.allowed()?;
        self.gist
            .connect(gist_id)
            .await
            .map(SyncGistStatusDto::from)
            .map_err(|e| e.to_string())
    }

    /// Pulls (see [`GistSync::pull`]).
    pub async fn pull(&self) -> Result<SyncPullDto, String> {
        self.allowed()?;
        self.gist
            .pull()
            .await
            .map(SyncPullDto::from)
            .map_err(|e| e.to_string())
    }

    /// Pushes (see [`GistSync::push`]).
    pub async fn push(&self) -> Result<SyncPushDto, String> {
        self.allowed()?;
        self.gist
            .push()
            .await
            .map(SyncPushDto::from)
            .map_err(|e| e.to_string())
    }
}

/// Builds the sync through a gist over the app config folder, with the token in `vault`. Only
/// resolves the path: the record is made when a gist is connected.
pub fn gist_state(app: &AppHandle, vault: Arc<dyn KeyVault>) -> Result<GistState, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not find the app config folder: {e}"))?;
    GistSync::new(dir, vault)
        .map(GistState::new)
        .map_err(|e| e.to_string())
}

/// Where the sync through a gist stands, with no network. It says whether a token is stored, never
/// what it is.
#[tauri::command]
pub async fn sync_gist_status(
    state: State<'_, Arc<GistState>>,
) -> Result<SyncGistStatusDto, String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.status())
        .await
        .map_err(|e| e.to_string())?
}

/// Stores the token of the gist sync in the keychain of the system, replacing the one there.
#[tauri::command]
pub async fn sync_gist_set_token(
    state: State<'_, Arc<GistState>>,
    token: String,
) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.set_token(&token))
        .await
        .map_err(|e| e.to_string())?
}

/// Removes the token of the gist sync from the keychain.
#[tauri::command]
pub async fn sync_gist_clear_token(state: State<'_, Arc<GistState>>) -> Result<(), String> {
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || state.clear_token())
        .await
        .map_err(|e| e.to_string())?
}

/// Connects to the gist `gist_id`, or (with none) makes a secret gist from the files that may travel.
#[tauri::command(rename_all = "camelCase")]
pub async fn sync_gist_connect(
    state: State<'_, Arc<GistState>>,
    gist_id: Option<String>,
) -> Result<SyncGistStatusDto, String> {
    let state = Arc::clone(&state);
    state.connect(gist_id.as_deref()).await
}

/// Brings the gist into the config folder; a conflict writes nothing and lists the paths.
#[tauri::command]
pub async fn sync_gist_pull(state: State<'_, Arc<GistState>>) -> Result<SyncPullDto, String> {
    let state = Arc::clone(&state);
    state.pull().await
}

/// Sends the changed files that may travel to the gist, unless the gist changed since the last sync.
#[tauri::command]
pub async fn sync_gist_push(state: State<'_, Arc<GistState>>) -> Result<SyncPushDto, String> {
    let state = Arc::clone(&state);
    state.push().await
}

/// Longest a project command (the `stop` of an action) may run before it is killed.
pub const PROJECT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Reads `<cwd>/.noren/actions.json` as text; `None` when there is no such file. Parsing and
/// validation belong to the interface.
#[tauri::command]
pub async fn project_actions_read(cwd: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_project_file(Path::new(&cwd))
            .map_err(|e| format!("could not read {ACTIONS_FILE_PATH} in '{cwd}': {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What `HEAD` of a repository points at, as seen by the interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitInfoDto {
    /// The branch, or the short commit id of a detached `HEAD`.
    pub branch: String,
    pub detached: bool,
}

impl From<GitHead> for GitInfoDto {
    fn from(head: GitHead) -> Self {
        Self {
            branch: head.branch,
            detached: head.detached,
        }
    }
}

/// The branch of the git repository `cwd` is in, read from `.git/HEAD` without running `git`;
/// `None` when `cwd` is in no repository.
#[tauri::command]
pub async fn git_info(cwd: String) -> Result<Option<GitInfoDto>, String> {
    tauri::async_runtime::spawn_blocking(move || read_head(Path::new(&cwd)).map(GitInfoDto::from))
        .await
        .map_err(|e| e.to_string())
}

/// One worktree of a git repository, as the interface reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDto {
    /// The folder, in the form of the system.
    pub path: String,
    /// The branch checked out; `None` when `HEAD` is detached.
    pub branch: Option<String>,
    /// The commit `HEAD` points at.
    pub head: Option<String>,
    pub detached: bool,
    /// The main worktree: the repository itself, which is never removed from the interface.
    pub main: bool,
    pub locked: bool,
}

impl WorktreeDto {
    fn new(worktree: Worktree, main: bool) -> Self {
        Self {
            path: native_path(&worktree.path).to_string_lossy().into_owned(),
            branch: worktree.branch,
            head: worktree.head,
            detached: worktree.detached,
            main,
            locked: worktree.locked,
        }
    }
}

/// The worktrees of the git repository `cwd` is in, the main one first. Runs `git`; rejects with a
/// sentence when `git` is missing or `cwd` is in no repository.
#[tauri::command]
pub async fn worktree_list(cwd: String) -> Result<Vec<WorktreeDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let list = list_worktrees(Path::new(&cwd)).map_err(|e| e.to_string())?;
        Ok(list
            .into_iter()
            .enumerate()
            .map(|(index, worktree)| WorktreeDto::new(worktree, index == 0))
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Adds a worktree on `branch` next to the repository `cwd` is in (the branch is created when it
/// does not exist) and returns it. Rejects with the reason when the branch name, the folder or
/// git refuse.
#[tauri::command]
pub async fn worktree_create(cwd: String, branch: String) -> Result<WorktreeDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_worktree(Path::new(&cwd), &branch)
            .map(|worktree| WorktreeDto::new(worktree, false))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Removes the worktree at `path` of the repository `cwd` is in, never forced: git refuses one
/// with changes and its message is the rejection. The branch is kept.
#[tauri::command]
pub async fn worktree_remove(cwd: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_worktree(Path::new(&cwd), &path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The hosts named by the `Host` lines of the `~/.ssh/config` of the user (no wildcards, nothing
/// that is not safe to type as `ssh <host>`); no file is no hosts. Rejects with a sentence when the
/// file cannot be read.
#[tauri::command]
pub async fn ssh_hosts_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(read_ssh_hosts)
        .await
        .map_err(|e| e.to_string())?
}

/// The names of the running containers (`docker ps`), none of them unsafe to type into a shell.
/// Rejects with a sentence when Docker is not there, fails or does not answer in time.
#[tauri::command]
pub async fn docker_containers_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| list_running_containers().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// One agent of the catalog the interface hands over (`agents.catalog` of `config.jsonc`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEntryDto {
    pub id: String,
    pub executables: Vec<String>,
    #[serde(default)]
    pub packages: Vec<String>,
}

impl From<AgentEntryDto> for AgentEntry {
    fn from(entry: AgentEntryDto) -> Self {
        Self {
            id: entry.id,
            executables: entry.executables,
            packages: entry.packages,
        }
    }
}

/// The agent found in the session with this id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHitDto {
    pub session_id: u64,
    pub agent_id: String,
}

/// The agents under the shells of `session_ids`, by the process tree (one picture for all of
/// them): only sessions that have an agent are listed. Reads processes and starts or writes
/// nothing; the catalog is bounded first (`check_catalog`).
pub fn scan_agents(
    state: &AppState,
    source: &dyn ProcessSource,
    session_ids: &[u64],
    catalog: Vec<AgentEntryDto>,
) -> Result<Vec<AgentHitDto>, String> {
    let catalog: Vec<AgentEntry> = catalog.into_iter().map(AgentEntry::from).collect();
    check_catalog(&catalog).map_err(|e| e.to_string())?;
    // The pid of each shell: from the list of the daemon (`SessionInfo`) when the sessions live in
    // one, else from the session manager of the app.
    let ids: Vec<SessionId> = session_ids.iter().map(|id| SessionId(*id)).collect();
    let roots = state.sessions.process_ids(&ids);
    Ok(scan_sessions(source, &roots, &catalog)
        .into_iter()
        .map(|(session, found)| AgentHitDto {
            session_id: session.0,
            agent_id: found.id,
        })
        .collect())
}

/// Asks which CLI agent runs under the shell of each session, from the process tree. The page asks
/// on an interval; the work runs off the thread of the interface.
#[tauri::command(rename_all = "camelCase")]
pub async fn agents_scan(
    app: AppHandle,
    session_ids: Vec<u64>,
    catalog: Vec<AgentEntryDto>,
) -> Result<Vec<AgentHitDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        scan_agents(&state, &state.processes, &session_ids, catalog)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs `command` through the system shell in `cwd`, with no terminal and no window, and returns
/// its exit code. The command is killed after [`PROJECT_COMMAND_TIMEOUT`].
#[tauri::command]
pub async fn project_command_run(cwd: String, command: String) -> Result<i32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_short(Path::new(&cwd), &command, PROJECT_COMMAND_TIMEOUT).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_write(
    state: State<'_, AppState>,
    id: u64,
    data: WriteData,
) -> Result<(), String> {
    state
        .sessions
        .write(SessionId(id), &data.into_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_resize(
    state: State<'_, AppState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .sessions
        .resize(SessionId(id), cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_kill(state: State<'_, AppState>, id: u64) -> Result<(), String> {
    let ended = state.sessions.kill(SessionId(id));
    // A session that is gone is no pane's to come back to, whether this call ended it or it was
    // already gone.
    state.unbind_session(SessionId(id));
    ended.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use noren_core::Profile;

    fn profile(id: &str, name: &str) -> Profile {
        Profile {
            id: id.to_owned(),
            name: name.to_owned(),
            program: format!("/bin/{id}"),
            args: Vec::new(),
            cwd: None,
            inject_integration: true,
            remote: None,
        }
    }

    fn detected_state() -> AppState {
        AppState::with_detected(ProfileSet {
            profiles: vec![
                profile("pwsh", "PowerShell"),
                profile("cmd", "Command Prompt"),
            ],
            default_id: Some("pwsh".to_owned()),
        })
    }

    fn user(id: &str, program: &str) -> UserProfile {
        UserProfile {
            id: id.to_owned(),
            name: format!("Name of {id}"),
            program: program.to_owned(),
            args: Vec::new(),
            cwd: None,
            ssh: None,
        }
    }

    fn listed(state: &AppState) -> Vec<(String, bool)> {
        state
            .list_profiles()
            .into_iter()
            .map(|p| (p.id, p.is_default))
            .collect()
    }

    #[test]
    fn the_list_has_the_detected_profiles_then_the_ones_of_the_user() {
        let state = detected_state();
        assert_eq!(
            listed(&state),
            [("pwsh".to_owned(), true), ("cmd".to_owned(), false)]
        );
        state
            .set_user_profiles(&[user("dev-shell", "sh"), user("other", "sh")])
            .expect("valid");
        assert_eq!(
            listed(&state),
            [
                ("pwsh".to_owned(), true),
                ("cmd".to_owned(), false),
                ("dev-shell".to_owned(), false),
                ("other".to_owned(), false),
            ]
        );
        assert_eq!(
            state.list_profiles()[2],
            ProfileDto {
                id: "dev-shell".into(),
                name: "Name of dev-shell".into(),
                is_default: false,
                kind: None,
            }
        );
        // The next list replaces the whole one.
        state
            .set_user_profiles(&[user("other", "sh")])
            .expect("valid");
        assert_eq!(state.list_profiles().len(), 3);
        state.set_user_profiles(&[]).expect("valid");
        assert_eq!(state.list_profiles().len(), 2);
    }

    #[test]
    fn a_profile_with_no_program_is_refused_and_the_profiles_stay_as_they_were() {
        let state = detected_state();
        state
            .set_user_profiles(&[user("keep", "sh")])
            .expect("valid");
        for program in ["", "  "] {
            let message = state
                .set_user_profiles(&[user("fresh", "sh"), user("empty", program)])
                .expect_err("refused");
            assert!(message.contains("empty"), "{message}");
            assert!(message.contains("program"), "{message}");
        }
        assert_eq!(
            listed(&state).last(),
            Some(&("keep".to_owned(), false)),
            "the refused list replaced the one in force"
        );
        assert_eq!(state.list_profiles().len(), 3);
    }

    #[test]
    fn an_id_of_a_detected_shell_or_a_repeated_one_is_refused() {
        let state = detected_state();
        let message = state
            .set_user_profiles(&[user("cmd", "sh")])
            .expect_err("refused");
        assert!(message.contains("already a shell found"), "{message}");
        let message = state
            .set_user_profiles(&[user("x", "sh"), user("x", "sh")])
            .expect_err("refused");
        assert!(message.contains("used by two profiles"), "{message}");
        assert_eq!(state.list_profiles().len(), 2);
    }

    #[test]
    fn find_profile_knows_the_user_profiles_and_the_default() {
        let state = detected_state();
        let mut dev = user("dev-shell", "/opt/dev/sh");
        dev.args = vec!["-l".to_owned(), "--flag".to_owned()];
        dev.cwd = Some("/opt/dev".to_owned());
        state.set_user_profiles(&[dev]).expect("valid");

        let found = state.find_profile(Some("dev-shell")).expect("listed");
        assert_eq!(found.program, "/opt/dev/sh");
        assert_eq!(found.args, ["-l", "--flag"]);
        assert_eq!(found.cwd.as_deref(), Some("/opt/dev"));
        assert_eq!(state.find_profile(None).expect("default").id, "pwsh");
        let missing = state.find_profile(Some("nope")).expect_err("unknown");
        assert!(
            missing.contains("unknown shell profile 'nope'"),
            "{missing}"
        );
    }

    #[test]
    fn the_dto_of_a_user_profile_reads_the_fields_the_interface_sends() {
        let dto: UserProfileDto = serde_json::from_value(serde_json::json!({
            "id": "dev-shell", "name": "Dev", "program": "pwsh.exe",
            "args": ["-NoLogo"], "cwd": "C:\\work"
        }))
        .expect("full");
        assert_eq!(
            UserProfile::try_from(dto).expect("a shell profile"),
            UserProfile {
                id: "dev-shell".into(),
                name: "Dev".into(),
                program: "pwsh.exe".into(),
                args: vec!["-NoLogo".into()],
                cwd: Some("C:\\work".into()),
                ssh: None,
            }
        );
        // The arguments and the folder may be left out.
        let bare: UserProfileDto = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "A", "program": "sh"
        }))
        .expect("bare");
        assert!(bare.args.is_empty());
        assert_eq!(bare.cwd, None);
        assert!(
            serde_json::from_value::<UserProfileDto>(serde_json::json!({ "id": "a" })).is_err()
        );
    }

    #[test]
    fn the_folder_of_a_profile_is_checked_and_a_given_folder_replaces_it() {
        let dir = TempDir::new("profile-cwd");
        let missing = dir.0.join("not-there");

        // The folder of the profile is used when the session names none.
        let mut with_folder = profile("dev", "Dev");
        with_folder.cwd = Some(dir.0.to_string_lossy().into_owned());
        let applied =
            apply_session_options(with_folder.spawn_spec(80, 24), None, None).expect("exists");
        assert_eq!(applied.cwd.as_deref(), Some(dir.0.as_path()));

        // One that does not exist is a clear error before any process starts.
        let mut gone = profile("gone", "Gone");
        gone.cwd = Some(missing.to_string_lossy().into_owned());
        let error = apply_session_options(gone.spawn_spec(80, 24), None, None).expect_err("gone");
        assert!(
            error.contains("does not exist or is not a folder"),
            "{error}"
        );
        assert!(error.contains("not-there"), "{error}");

        // The folder a session names (a tab opened in a folder) wins, even over a missing one.
        let given = std::env::temp_dir();
        let applied = apply_session_options(gone.spawn_spec(80, 24), given.to_str(), None)
            .expect("the given folder replaces the profile's");
        assert_eq!(applied.cwd.as_deref(), Some(given.as_path()));
    }

    /// The output of a profile of the user, run for real in a pseudo terminal: what it was told to run.
    #[test]
    fn a_session_of_a_user_profile_runs_its_program_arguments_and_folder() {
        let dir = TempDir::new("profile-run");
        let (program, args) = if cfg!(windows) {
            ("cmd.exe", ["/c", "echo profile-ran & cd"])
        } else {
            ("sh", ["-c", "echo profile-ran; pwd"])
        };
        let mut dev = user("dev-shell", program);
        dev.args = args.iter().map(|a| (*a).to_owned()).collect();
        dev.cwd = Some(dir.0.to_string_lossy().into_owned());
        let state = detected_state();
        state.set_user_profiles(&[dev]).expect("valid");

        let profile = state.find_profile(Some("dev-shell")).expect("listed");
        let spec = apply_session_options(profile.spawn_spec(80, 24), None, None).expect("spec");
        let (tx, rx) = std::sync::mpsc::channel();
        let id = state
            .sessions
            .spawn(spec, move |event| {
                // The bytes are borrowed for the call; `None` is the end of the session.
                let _ = tx.send(match event {
                    SessionEvent::Output(bytes) => Some(bytes.to_vec()),
                    SessionEvent::Exit(_) => None,
                });
            })
            .expect("spawn");

        let mut output = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while let Some(bytes) = rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .expect("the session ends in time")
        {
            output.extend_from_slice(&bytes);
        }
        let _ = state.sessions.kill(id);
        let text = String::from_utf8_lossy(&output);
        let folder = dir
            .0
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        assert!(text.contains("profile-ran"), "{text}");
        assert!(
            text.contains(&folder),
            "the session did not start in {folder}: {text}"
        );
    }

    #[test]
    fn dtos_mark_only_the_default_profile() {
        let set = ProfileSet {
            profiles: vec![
                profile("pwsh", "PowerShell"),
                profile("cmd", "Command Prompt"),
            ],
            default_id: Some("cmd".to_owned()),
        };
        assert_eq!(
            profile_dtos(&set),
            vec![
                ProfileDto {
                    id: "pwsh".into(),
                    name: "PowerShell".into(),
                    is_default: false,
                    kind: None,
                },
                ProfileDto {
                    id: "cmd".into(),
                    name: "Command Prompt".into(),
                    is_default: true,
                    kind: None,
                },
            ]
        );
    }

    #[test]
    fn no_profiles_gives_an_empty_list() {
        assert!(profile_dtos(&ProfileSet::default()).is_empty());
    }

    fn spec() -> SpawnSpec {
        profile("sh", "Shell").spawn_spec(80, 24)
    }

    #[test]
    fn session_options_default_to_the_profile_spec() {
        let applied = apply_session_options(spec(), None, None).expect("no options");
        assert!(applied.cwd.is_none());
        assert!(applied.env.is_empty());
        let empty = apply_session_options(spec(), Some(""), Some(HashMap::new())).expect("empty");
        assert!(empty.cwd.is_none());
        assert!(empty.env.is_empty());
    }

    #[test]
    fn session_options_pass_cwd_and_sorted_env() {
        let dir = std::env::temp_dir();
        let env = HashMap::from([
            ("B_VAR".to_owned(), "2".to_owned()),
            ("A_VAR".to_owned(), "1".to_owned()),
        ]);
        let applied = apply_session_options(spec(), dir.to_str(), Some(env)).expect("valid");
        assert_eq!(applied.cwd.as_deref(), Some(dir.as_path()));
        assert_eq!(
            applied.env,
            vec![
                ("A_VAR".to_owned(), "1".to_owned()),
                ("B_VAR".to_owned(), "2".to_owned())
            ]
        );
    }

    #[test]
    fn missing_cwd_is_a_clear_error() {
        let missing = std::env::temp_dir().join("noren-no-such-folder-0f7c1a");
        let cwd = missing.to_string_lossy().into_owned();
        let error = apply_session_options(spec(), Some(&cwd), None).expect_err("must fail");
        assert!(
            error.contains("does not exist or is not a folder"),
            "{error}"
        );
        assert!(error.contains("noren-no-such-folder-0f7c1a"), "{error}");
    }

    #[test]
    fn a_file_is_not_a_valid_cwd() {
        let file = std::env::current_exe().expect("test executable");
        let cwd = file.to_string_lossy().into_owned();
        assert!(apply_session_options(spec(), Some(&cwd), None).is_err());
    }

    #[test]
    fn invalid_env_names_are_rejected() {
        for key in ["", "A=B", "A\0B"] {
            let env = HashMap::from([(key.to_owned(), "x".to_owned())]);
            assert!(
                apply_session_options(spec(), None, Some(env)).is_err(),
                "{key:?}"
            );
        }
        let env = HashMap::from([("OK".to_owned(), "a\0b".to_owned())]);
        assert!(apply_session_options(spec(), None, Some(env)).is_err());
    }

    #[test]
    fn git_info_has_the_fields_the_interface_reads() {
        let info = GitInfoDto::from(GitHead {
            branch: "feature/x".to_owned(),
            detached: false,
        });
        assert_eq!(
            serde_json::to_value(&info).expect("serializes"),
            serde_json::json!({ "branch": "feature/x", "detached": false })
        );
    }

    struct NoProcesses;
    impl ProcessSource for NoProcesses {
        fn snapshot(&self) -> Vec<noren_core::ProcessInfo> {
            panic!("a scan with no live shell needs no picture");
        }
    }

    fn agent_entry(id: &str) -> AgentEntryDto {
        AgentEntryDto {
            id: id.to_owned(),
            executables: vec![id.to_owned()],
            packages: Vec::new(),
        }
    }

    #[test]
    fn a_scan_of_sessions_that_do_not_exist_finds_nothing() {
        let state = detected_state();
        let found = scan_agents(
            &state,
            &NoProcesses,
            &[1, 2, 3],
            vec![agent_entry("claude")],
        );
        assert_eq!(found, Ok(Vec::new()));
    }

    #[test]
    fn a_scan_refuses_a_catalog_that_is_not_in_bounds() {
        let state = detected_state();
        let twice = vec![agent_entry("claude"), agent_entry("claude")];
        assert!(scan_agents(&state, &NoProcesses, &[1], twice).is_err());
        let blank = vec![agent_entry(" ")];
        assert!(scan_agents(&state, &NoProcesses, &[1], blank).is_err());
    }

    #[test]
    fn the_catalog_the_page_sends_has_the_fields_the_command_reads() {
        let entry: AgentEntryDto =
            serde_json::from_str(r#"{"id":"claude","executables":["claude"]}"#).expect("entry");
        assert_eq!(entry.packages, Vec::<String>::new());
        let with_package: AgentEntryDto =
            serde_json::from_str(r#"{"id":"aider","executables":["aider"],"packages":["aider"]}"#)
                .expect("entry");
        assert_eq!(with_package.packages, vec!["aider".to_owned()]);
        // A field the command does not know is refused instead of ignored.
        assert!(
            serde_json::from_str::<AgentEntryDto>(r#"{"id":"a","executables":[],"run":"x"}"#)
                .is_err()
        );
        let hit = serde_json::to_value(AgentHitDto {
            session_id: 7,
            agent_id: "claude".to_owned(),
        })
        .expect("hit");
        assert_eq!(
            hit,
            serde_json::json!({"sessionId": 7, "agentId": "claude"})
        );
    }

    #[test]
    fn git_info_of_a_folder_outside_a_repository_is_none() {
        // Relative paths are never looked up, whatever folder the app runs in.
        let found = tauri::async_runtime::block_on(git_info("relative/folder".to_owned()));
        assert_eq!(found, Ok(None));
    }

    /// A folder in the temp dir that no other test or run uses, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-bridge-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn config_state_loads_and_saves_through_its_store() {
        let dir = TempDir::new("config-load");
        let state = ConfigState::new(ConfigStore::new(dir.0.join(CONFIG_FILE_NAME)));
        assert_eq!(state.store.load().expect("no file"), None);
        state.store.save("// mine\n{}").expect("save");
        assert_eq!(
            state.store.load().expect("load"),
            Some("// mine\n{}".to_owned())
        );
    }

    #[test]
    fn config_save_writes_the_text_as_given_and_creates_the_folder() {
        let dir = TempDir::new("config-save");
        let file = dir.0.join("not-yet").join(CONFIG_FILE_NAME);
        let state = ConfigState::new(ConfigStore::new(&file));
        let text = "// kept\n{\n  \"appearance\": { \"tabs\": \"top\", }, /* trailing */\n}\n";
        state.save(text).expect("save");
        assert_eq!(std::fs::read_to_string(&file).expect("read"), text);
        // The next load, and so the next start of the app, finds the same text.
        assert_eq!(state.store.load().expect("load"), Some(text.to_owned()));
    }

    #[test]
    fn config_save_failure_is_a_message_for_the_interface() {
        let dir = TempDir::new("config-save-fails");
        // A folder named like the file: the text cannot go there.
        let in_the_way = dir.0.join(CONFIG_FILE_NAME);
        std::fs::create_dir(&in_the_way).expect("create the folder");
        let state = ConfigState::new(ConfigStore::new(&in_the_way));
        let message = state.save("{}").expect_err("the save fails");
        assert!(!message.is_empty());
        assert!(in_the_way.is_dir());
    }

    #[test]
    fn config_save_comes_back_through_the_watching_as_one_change() {
        let dir = TempDir::new("config-save-watched");
        let state = ConfigState::new(ConfigStore::new(dir.0.join(CONFIG_FILE_NAME)));
        let (reports, heard) = std::sync::mpsc::channel();
        state
            .watch(move |text| {
                let _ = reports.send(text);
            })
            .expect("watch");
        state.save("{ \"a\": 1 }").expect("save");
        assert_eq!(
            heard.recv_timeout(Duration::from_secs(15)),
            Ok(Some("{ \"a\": 1 }".to_owned()))
        );
        // The same text again is not a change.
        state.save("{ \"a\": 1 }").expect("save again");
        assert_eq!(
            heard.recv_timeout(Duration::from_millis(800)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn config_watching_starts_once_and_reports_changes() {
        let dir = TempDir::new("config-watch");
        let state = ConfigState::new(ConfigStore::new(dir.0.join(CONFIG_FILE_NAME)));
        let (first, first_heard) = std::sync::mpsc::channel();
        let (second, second_heard) = std::sync::mpsc::channel();
        state
            .watch(move |text| {
                let _ = first.send(text);
            })
            .expect("watch");
        // The page reloaded and asked again: the first watching goes on, this callback is dropped.
        state
            .watch(move |text| {
                let _ = second.send(text);
            })
            .expect("watch again");

        state.store.save("{ \"a\": 1 }").expect("save");
        assert_eq!(
            first_heard.recv_timeout(Duration::from_secs(15)),
            Ok(Some("{ \"a\": 1 }".to_owned()))
        );
        assert_eq!(
            second_heard.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
    }

    #[test]
    fn config_state_without_watching_leaves_the_folder_alone() {
        let dir = TempDir::new("config-no-watch");
        let folder = dir.0.join("not-yet");
        let state =
            ConfigState::new(ConfigStore::new(folder.join(CONFIG_FILE_NAME))).without_watching();
        let (heard, never) = std::sync::mpsc::channel();
        state
            .watch(move |text| {
                let _ = heard.send(text);
            })
            .expect("watch");
        assert!(!folder.exists(), "the config folder was created");
        assert_eq!(
            never.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
        // Reading still works, and finds no file.
        assert_eq!(state.store.load().expect("load"), None);
    }

    #[test]
    fn config_state_without_watching_does_not_write_either() {
        // The smoke run: saving would make the folder and the file of the user.
        let dir = TempDir::new("config-no-write");
        let folder = dir.0.join("not-yet");
        let state =
            ConfigState::new(ConfigStore::new(folder.join(CONFIG_FILE_NAME))).without_watching();
        let message = state.save("{}").expect_err("the save is refused");
        assert!(message.contains("does not write"));
        assert!(!folder.exists(), "the config folder was created");
    }

    #[test]
    fn theme_state_saves_and_lists_through_its_store() {
        let dir = TempDir::new("themes-round-trip");
        let folder = dir.0.join("not-yet").join(THEMES_DIR_NAME);
        let state = ThemeState::new(ThemeStore::new(&folder));
        assert_eq!(state.list(), Ok(Vec::new()));
        assert!(!folder.exists(), "listing created the themes folder");
        state
            .save("lagoon", "{ \"id\": \"lagoon\" }\n")
            .expect("save");
        assert_eq!(
            std::fs::read_to_string(folder.join("lagoon.json")).expect("read"),
            "{ \"id\": \"lagoon\" }\n"
        );
        assert_eq!(
            state.list(),
            Ok(vec!["{ \"id\": \"lagoon\" }\n".to_owned()])
        );
    }

    #[test]
    fn theme_save_refuses_an_id_that_is_a_path_and_failures_are_messages() {
        let dir = TempDir::new("themes-bad-id");
        let folder = dir.0.join(THEMES_DIR_NAME);
        let state = ThemeState::new(ThemeStore::new(&folder));
        let message = state.save("../config", "{}").expect_err("refused");
        assert_eq!(message, "'../config' is not a valid theme id");
        assert!(!folder.exists());
        assert!(!dir.0.join("config.json").exists());

        // A file where the folder should be: the text cannot go there, and the message says so.
        let blocked = dir.0.join("blocked");
        std::fs::write(&blocked, b"in the way").expect("write");
        let message = ThemeState::new(ThemeStore::new(&blocked))
            .save("lagoon", "{}")
            .expect_err("fails");
        assert!(message.starts_with("could not write the theme file"));
    }

    #[test]
    fn theme_state_without_writing_lists_but_does_not_write() {
        // The smoke run: saving would make the folder and the file of the user.
        let dir = TempDir::new("themes-no-write");
        let folder = dir.0.join("not-yet");
        let state = ThemeState::new(ThemeStore::new(&folder)).without_writing();
        let message = state.save("lagoon", "{}").expect_err("the save is refused");
        assert!(message.contains("does not write"));
        assert!(!folder.exists(), "the themes folder was created");
        assert_eq!(state.list(), Ok(Vec::new()));
    }

    #[test]
    fn bench_state_saves_and_lists_through_its_store() {
        let dir = TempDir::new("bench-round-trip");
        let folder = dir.0.join("not-yet").join(BENCH_DIR_NAME);
        let state = BenchState::new(BenchStore::new(&folder));
        assert_eq!(state.list(), Ok(Vec::new()));
        assert!(!folder.exists(), "listing created the bench results folder");
        let older = "{\"startedAt\":\"2026-10-20T14:05:09.000Z\"}";
        let newer = "{\"startedAt\":\"2026-10-20T14:06:00.000Z\"}";
        assert_eq!(state.save(older), Ok("2026-10-20-140509.json".to_owned()));
        assert_eq!(state.save(newer), Ok("2026-10-20-140600.json".to_owned()));
        assert_eq!(
            std::fs::read_to_string(folder.join("2026-10-20-140509.json")).expect("read"),
            older
        );
        assert_eq!(
            state.list(),
            Ok(vec![
                BenchFileDto {
                    name: "2026-10-20-140600.json".to_owned(),
                    text: newer.to_owned()
                },
                BenchFileDto {
                    name: "2026-10-20-140509.json".to_owned(),
                    text: older.to_owned()
                },
            ])
        );
    }

    #[test]
    fn bench_save_refuses_what_is_not_a_run_and_failures_are_messages() {
        let dir = TempDir::new("bench-bad-run");
        let folder = dir.0.join(BENCH_DIR_NAME);
        let state = BenchState::new(BenchStore::new(&folder));
        let message = state
            .save("{\"startedAt\":\"../../config\"}")
            .expect_err("refused");
        assert!(message.starts_with("the bench result is not a run"));
        assert!(!folder.exists());
        assert!(!dir.0.join("config.json").exists());

        // A file where the folder should be: the text cannot go there, and the message says so.
        let blocked = dir.0.join("blocked");
        std::fs::write(&blocked, b"in the way").expect("write");
        let message = BenchState::new(BenchStore::new(&blocked))
            .save("{\"startedAt\":\"2026-10-20T14:05:09Z\"}")
            .expect_err("fails");
        assert!(message.starts_with("could not write the bench result"));
    }

    #[test]
    fn bench_state_without_writing_lists_but_does_not_write() {
        // The smoke run: saving would make the folder and the file of the user.
        let dir = TempDir::new("bench-no-write");
        let folder = dir.0.join("not-yet");
        let state = BenchState::new(BenchStore::new(&folder)).without_writing();
        let message = state
            .save("{\"startedAt\":\"2026-10-20T14:05:09Z\"}")
            .expect_err("the save is refused");
        assert!(message.contains("does not write"));
        assert!(!folder.exists(), "the bench results folder was created");
        assert_eq!(state.list(), Ok(Vec::new()));
    }

    #[test]
    fn scrollback_state_saves_loads_and_deletes_through_its_store() {
        let dir = TempDir::new("scrollback-round-trip");
        let folder = dir.0.join("not-yet").join(SCROLLBACK_DIR_NAME);
        let state = ScrollbackState::new(ScrollbackStore::new(&folder));
        assert_eq!(state.load("pane-1"), Ok(None));
        assert!(!folder.exists(), "loading created the scrollback folder");
        state.delete("pane-1").expect("deleting nothing is fine");
        assert!(!folder.exists(), "deleting created the scrollback folder");

        state
            .save("pane-1", "\u{1b}[2mold output\u{1b}[0m\n")
            .expect("save");
        assert_eq!(
            std::fs::read_to_string(folder.join("pane-1.txt")).expect("read"),
            "\u{1b}[2mold output\u{1b}[0m\n"
        );
        assert_eq!(
            state.load("pane-1"),
            Ok(Some("\u{1b}[2mold output\u{1b}[0m\n".to_owned()))
        );
        state.delete("pane-1").expect("delete");
        assert_eq!(state.load("pane-1"), Ok(None));
    }

    #[test]
    fn scrollback_save_refuses_an_id_that_is_a_path_and_a_text_that_is_too_large() {
        let dir = TempDir::new("scrollback-bad-id");
        let folder = dir.0.join(SCROLLBACK_DIR_NAME);
        let state = ScrollbackState::new(ScrollbackStore::new(&folder));
        let message = state.save("../config", "x").expect_err("refused");
        assert_eq!(message, "'../config' is not a valid pane id");
        assert!(state.load("../config").is_err());
        assert!(state.delete("../config").is_err());
        let too_large = "x".repeat(5 * 1024 * 1024);
        let message = state.save("pane-1", &too_large).expect_err("refused");
        assert!(message.contains("a snapshot is at most"), "{message}");
        assert!(!folder.exists());
        assert!(!dir.0.join("config.txt").exists());
    }

    #[test]
    fn scrollback_state_without_writing_loads_but_does_not_write_or_delete() {
        // The smoke run: saving would make the folder and the file of the user, and deleting would
        // remove one.
        let dir = TempDir::new("scrollback-no-write");
        let folder = dir.0.join("not-yet");
        let state = ScrollbackState::new(ScrollbackStore::new(&folder)).without_writing();
        let message = state.save("pane-1", "x").expect_err("the save is refused");
        assert!(message.contains("does not write"));
        let message = state.delete("pane-1").expect_err("the delete is refused");
        assert!(message.contains("does not remove"));
        assert!(!folder.exists(), "the scrollback folder was created");
        assert_eq!(state.load("pane-1"), Ok(None));

        // What is already there still reads, and stays.
        std::fs::create_dir_all(&folder).expect("folder");
        std::fs::write(folder.join("pane-2.txt"), "kept").expect("write");
        let state = ScrollbackState::new(ScrollbackStore::new(&folder)).without_writing();
        assert_eq!(state.load("pane-2"), Ok(Some("kept".to_owned())));
        assert!(state.delete("pane-2").is_err());
        assert!(folder.join("pane-2.txt").is_file());
    }

    #[test]
    fn mod_state_lists_the_files_without_making_the_folder() {
        let dir = TempDir::new("mods-list");
        let folder = dir.0.join("not-yet").join(MODS_DIR_NAME);
        let state = ModState::new(ModStore::new(&folder));
        assert_eq!(state.list(), Ok(Vec::new()));
        assert!(!folder.exists(), "listing created the mods folder");

        std::fs::create_dir_all(&folder).expect("folder");
        std::fs::write(folder.join("b.css"), ".b { color: red }").expect("write");
        std::fs::write(folder.join("a.css"), ".a {}").expect("write");
        std::fs::write(folder.join("notes.txt"), "not a mod").expect("write");
        assert_eq!(
            state.list(),
            Ok(vec![
                ModFileDto {
                    name: "a.css".to_owned(),
                    text: ".a {}".to_owned()
                },
                ModFileDto {
                    name: "b.css".to_owned(),
                    text: ".b { color: red }".to_owned()
                },
            ])
        );
    }

    #[test]
    fn mod_list_failure_is_a_message_for_the_interface() {
        let dir = TempDir::new("mods-blocked");
        let blocked = dir.0.join("blocked");
        std::fs::write(&blocked, b"in the way").expect("write");
        let message = ModState::new(ModStore::new(&blocked))
            .list()
            .expect_err("fails");
        assert!(message.starts_with("could not read the mods folder"));
    }

    #[test]
    fn plugin_folders_reach_the_interface_as_files_or_a_sentence() {
        let dir = TempDir::new("plugins-list");
        let folder = dir.0.join("not-yet").join(PLUGINS_DIR_NAME);
        let store = PluginStore::new(&folder);
        assert_eq!(list_plugins(&store), Ok(Vec::new()));
        assert!(!folder.exists(), "listing created the plugins folder");

        std::fs::create_dir_all(folder.join("a")).expect("folder");
        std::fs::create_dir_all(folder.join("b")).expect("folder");
        std::fs::write(folder.join("a").join("plugin.json"), r#"{"main":"m.js"}"#).expect("write");
        std::fs::write(folder.join("a").join("m.js"), "ok").expect("write");
        assert_eq!(
            list_plugins(&store),
            Ok(vec![
                PluginFolderDto {
                    folder: "a".to_owned(),
                    manifest: Some(r#"{"main":"m.js"}"#.to_owned()),
                    main: Some("ok".to_owned()),
                    error: None,
                },
                PluginFolderDto {
                    folder: "b".to_owned(),
                    manifest: None,
                    main: None,
                    error: Some("plugin.json not found".to_owned()),
                },
            ])
        );
        let json = serde_json::to_string(&list_plugins(&store).expect("list")).expect("json");
        assert_eq!(
            json,
            r#"[{"folder":"a","manifest":"{\"main\":\"m.js\"}","main":"ok"},{"folder":"b","error":"plugin.json not found"}]"#
        );
    }

    #[test]
    fn plugin_list_failure_is_a_message_for_the_interface() {
        let dir = TempDir::new("plugins-blocked");
        let blocked = dir.0.join("blocked");
        std::fs::write(&blocked, b"in the way").expect("write");
        let message = list_plugins(&PluginStore::new(&blocked)).expect_err("fails");
        assert!(message.starts_with("could not read the plugins folder"));
    }

    #[test]
    fn installed_gallery_items_reach_the_interface_with_the_kind_as_text() {
        let json = serde_json::to_string(&InstalledItemDto::from(InstalledItem {
            id: "lagoon".to_owned(),
            kind: noren_core::ItemKind::Theme,
            version: "1.0.0".to_owned(),
            sha256: "a".repeat(64),
        }))
        .expect("serialize");
        assert_eq!(
            json,
            format!(
                r#"{{"id":"lagoon","kind":"theme","version":"1.0.0","sha256":"{}"}}"#,
                "a".repeat(64)
            )
        );
    }

    #[test]
    fn a_fresh_gallery_has_nothing_installed_and_a_smoke_run_installs_nothing() {
        let dir = TempDir::new("gallery");
        let state = GalleryState::new(Gallery::new(&dir.0).expect("gallery"));
        assert_eq!(state.installed(), Vec::new());
        // The refusal comes before any request, so this test never reaches a network.
        let message = tauri::async_runtime::block_on(
            GalleryState::new(Gallery::new(&dir.0).expect("gallery"))
                .without_installing()
                .install("lagoon"),
        )
        .expect_err("refused");
        assert_eq!(message, "this run does not install from the gallery");
        assert!(!dir.0.join(THEMES_DIR_NAME).exists());
        assert!(!dir.0.join(MODS_DIR_NAME).exists());
    }

    #[test]
    fn sync_answers_reach_the_interface_in_the_wire_shape() {
        let status = serde_json::to_string(&SyncStatusDto::from(SyncStatus {
            connected: true,
            remote: Some("/srv/notes.git".to_owned()),
            branch: Some("main".to_owned()),
            pending: vec![noren_core::PendingChange {
                path: "config.jsonc".to_owned(),
                kind: noren_core::ChangeKind::Modified,
            }],
            ahead: 1,
            behind: 2,
        }))
        .expect("serialize");
        assert_eq!(
            status,
            r#"{"connected":true,"remote":"/srv/notes.git","branch":"main","pending":[{"path":"config.jsonc","change":"modified"}],"ahead":1,"behind":2}"#
        );
        let pulls = [
            SyncPullDto::from(PullOutcome::UpToDate),
            SyncPullDto::from(PullOutcome::Updated(vec!["a".to_owned()])),
            SyncPullDto::from(PullOutcome::Conflicts(vec!["b".to_owned()])),
        ];
        assert_eq!(
            serde_json::to_string(&pulls).expect("serialize"),
            r#"[{"kind":"up_to_date"},{"kind":"updated","files":["a"]},{"kind":"conflict","paths":["b"]}]"#
        );
        assert_eq!(
            serde_json::to_string(&SyncPushDto::from(PushOutcome {
                committed: true,
                pushed: false,
                files: vec!["c".to_owned()],
            }))
            .expect("serialize"),
            r#"{"committed":true,"pushed":false,"files":["c"]}"#
        );
    }

    #[test]
    fn space_files_reach_the_interface_in_the_wire_shape_and_come_back_the_same_way() {
        let dir = TempDir::new("sync-spaces");
        let state = SyncState::new(SyncRepo::new(&dir.0));
        state
            .spaces_write(vec![SyncSpaceWriteDto {
                name: "Work.noren-space.json".to_owned(),
                text: "{}\n".to_owned(),
                space_id: "s1".to_owned(),
            }])
            .expect("write");
        assert_eq!(
            state.spaces_read("Work.noren-space.json").as_deref(),
            Ok("{}\n")
        );
        let listed = serde_json::to_string(&state.spaces_list().expect("list")).expect("json");
        let hash = "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356";
        assert_eq!(
            listed,
            format!(
                r#"{{"files":[{{"name":"Work.noren-space.json","hash":"{hash}","linked":{{"spaceId":"s1","hash":"{hash}"}}}}],"cloned":[]}}"#
            )
        );
        // What the interface sends is read with camelCase keys.
        let sent: Vec<SyncSpaceWriteDto> =
            serde_json::from_str(r#"[{"name":"Play.noren-space.json","text":"x","spaceId":"s2"}]"#)
                .expect("write request");
        assert_eq!(sent[0].space_id, "s2");
        let links: Vec<SyncSpaceLinkRequestDto> =
            serde_json::from_str(r#"[{"name":"Play.noren-space.json","spaceId":"s2"}]"#)
                .expect("link request");
        assert_eq!(links[0].space_id, "s2");
        // A name off the closed list is refused with words.
        let refused = state.spaces_read("../config.jsonc").expect_err("refused");
        assert!(refused.contains("not a name the sync carries"), "{refused}");
    }

    #[test]
    fn a_smoke_run_reads_the_space_files_but_does_not_write_them() {
        let dir = TempDir::new("sync-spaces-smoke");
        let smoke = SyncState::new(SyncRepo::new(&dir.0)).without_syncing();
        assert_eq!(
            smoke
                .spaces_write(vec![SyncSpaceWriteDto {
                    name: "Work.noren-space.json".to_owned(),
                    text: "{}".to_owned(),
                    space_id: "s1".to_owned(),
                }])
                .expect_err("refused"),
            "this run does not sync"
        );
        assert_eq!(
            smoke
                .spaces_link(vec![SyncSpaceLinkRequestDto {
                    name: "Work.noren-space.json".to_owned(),
                    space_id: "s1".to_owned(),
                }])
                .expect_err("refused"),
            "this run does not sync"
        );
        assert_eq!(smoke.spaces_list().expect("list").files, Vec::new());
        assert!(!dir.0.join("spaces").exists());
    }

    #[test]
    fn a_fresh_sync_is_not_connected_and_a_smoke_run_does_not_sync() {
        let dir = TempDir::new("sync");
        let state = SyncState::new(SyncRepo::new(&dir.0));
        assert_eq!(
            state.status().expect("status"),
            SyncStatusDto::from(SyncStatus::default())
        );
        let smoke = SyncState::new(SyncRepo::new(&dir.0)).without_syncing();
        // Every refusal comes before any git command and any network.
        assert_eq!(
            smoke.connect("https://example.com/me/x.git"),
            Err("this run does not sync".to_owned())
        );
        assert_eq!(smoke.pull(), Err("this run does not sync".to_owned()));
        assert_eq!(smoke.push(), Err("this run does not sync".to_owned()));
        assert!(!dir.0.join("sync").exists());
    }

    #[test]
    fn gist_status_reaches_the_interface_in_the_wire_shape_and_never_holds_the_token() {
        let token = "ghp_TestTokenNeverReal0123456789";
        let dir = TempDir::new("sync-gist");
        let vault = Arc::new(noren_core::MemoryVault::new());
        let state = GistState::new(GistSync::new(&dir.0, vault.clone()).expect("gist sync"));
        let fresh = serde_json::to_string(&state.status().expect("status")).expect("json");
        assert_eq!(
            fresh,
            r#"{"connected":false,"gistId":null,"public":false,"hasToken":false,"pending":[]}"#
        );
        state.set_token(token).expect("store the token");
        assert_eq!(
            vault.get(noren_core::SYNC_GIST_TOKEN_ENTRY),
            Ok(Some(token.to_owned()))
        );
        let stored = serde_json::to_string(&state.status().expect("status")).expect("json");
        assert!(stored.contains(r#""hasToken":true"#), "{stored}");
        assert!(!stored.contains(token), "{stored}");
        let wire = serde_json::to_string(&SyncGistStatusDto::from(GistStatus {
            connected: true,
            gist_id: Some("abc123".to_owned()),
            public: true,
            has_token: true,
            pending: vec![noren_core::PendingChange {
                path: "themes/lagoon.json".to_owned(),
                kind: noren_core::ChangeKind::Added,
            }],
        }))
        .expect("json");
        assert_eq!(
            wire,
            r#"{"connected":true,"gistId":"abc123","public":true,"hasToken":true,"pending":[{"path":"themes/lagoon.json","change":"added"}]}"#
        );
        // A bad token is refused with words that do not repeat it.
        let message = state.set_token("two words").expect_err("refused");
        assert!(!message.contains("two words"), "{message}");
        state.clear_token().expect("clear");
        assert_eq!(vault.get(noren_core::SYNC_GIST_TOKEN_ENTRY), Ok(None));
        assert!(!state.status().expect("status").has_token);
        // Nothing was written to the config folder.
        assert_eq!(std::fs::read_dir(&dir.0).expect("dir").count(), 0);
    }

    #[test]
    fn a_smoke_run_neither_stores_a_token_nor_syncs_through_a_gist() {
        let dir = TempDir::new("sync-gist-smoke");
        let vault = Arc::new(noren_core::MemoryVault::new());
        let smoke = GistState::new(GistSync::new(&dir.0, vault.clone()).expect("gist sync"))
            .without_syncing();
        let refused = "this run does not sync";
        assert_eq!(smoke.set_token("ghp_x").expect_err("refused"), refused);
        assert_eq!(smoke.clear_token().expect_err("refused"), refused);
        // Every refusal comes before any request, so these never reach a network.
        let connect = tauri::async_runtime::block_on(smoke.connect(Some("abc123")));
        assert_eq!(connect.expect_err("refused"), refused);
        let create = tauri::async_runtime::block_on(smoke.connect(None));
        assert_eq!(create.expect_err("refused"), refused);
        let pull = tauri::async_runtime::block_on(smoke.pull());
        assert_eq!(pull.expect_err("refused"), refused);
        let push = tauri::async_runtime::block_on(smoke.push());
        assert_eq!(push.expect_err("refused"), refused);
        assert_eq!(vault.get(noren_core::SYNC_GIST_TOKEN_ENTRY), Ok(None));
        // The status is only a read, and a fresh folder is not connected.
        assert!(!smoke.status().expect("status").connected);
        assert_eq!(std::fs::read_dir(&dir.0).expect("dir").count(), 0);
    }

    #[test]
    fn mod_files_reach_the_interface_as_name_and_text() {
        let json = serde_json::to_string(&ModFileDto::from(ModFile {
            name: "dark.css".to_owned(),
            text: ".a { color: red }".to_owned(),
        }))
        .expect("serialize");
        assert_eq!(json, r#"{"name":"dark.css","text":".a { color: red }"}"#);
    }

    #[test]
    fn mod_watching_starts_once_and_reports_the_whole_list() {
        let dir = TempDir::new("mods-watch");
        let folder = dir.0.join(MODS_DIR_NAME);
        let state = ModState::new(ModStore::new(&folder));
        let (first, first_heard) = std::sync::mpsc::channel();
        let (second, second_heard) = std::sync::mpsc::channel();
        state
            .watch(move |files| {
                let _ = first.send(files);
            })
            .expect("watch");
        // The page reloaded and asked again: the first watching goes on, this callback is dropped.
        state
            .watch(move |files| {
                let _ = second.send(files);
            })
            .expect("watch again");
        assert!(folder.is_dir(), "watching makes the folder to put files in");

        std::fs::write(folder.join("dark.css"), ".a {}").expect("write");
        assert_eq!(
            first_heard.recv_timeout(Duration::from_secs(15)),
            Ok(vec![ModFileDto {
                name: "dark.css".to_owned(),
                text: ".a {}".to_owned()
            }])
        );
        assert_eq!(
            second_heard.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
    }

    #[test]
    fn mod_state_without_watching_leaves_the_folders_alone() {
        // The smoke run: watching would make the mods folder of the user.
        let dir = TempDir::new("mods-no-watch");
        let folder = dir.0.join("not-yet").join(MODS_DIR_NAME);
        let state = ModState::new(ModStore::new(&folder)).without_watching();
        let (heard, never) = std::sync::mpsc::channel();
        state
            .watch(move |files| {
                let _ = heard.send(files);
            })
            .expect("watch");
        assert!(!folder.exists(), "the mods folder was created");
        assert!(
            !dir.0.join("not-yet").exists(),
            "the config folder was created"
        );
        assert_eq!(
            never.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Disconnected)
        );
        // Reading still works, and finds no files.
        assert_eq!(state.list(), Ok(Vec::new()));
    }

    /// Calls `cmd` the way the page does, in the mock runtime of Tauri, with the state a run has.
    fn call_command(
        cmd: &str,
        args: serde_json::Value,
        pictures: &Path,
    ) -> Result<InvokeResponseBody, serde_json::Value> {
        call_command_after(cmd, args, pictures, |_| {})
    }

    /// [`call_command`] with `prepare` run on the app once the `main` window exists and before the
    /// call: what a test needs to have in place (a browser pane open in the window, say).
    fn call_command_after(
        cmd: &str,
        args: serde_json::Value,
        pictures: &Path,
        prepare: impl FnOnce(&tauri::AppHandle<tauri::test::MockRuntime>),
    ) -> Result<InvokeResponseBody, serde_json::Value> {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
        use tauri::webview::InvokeRequest;

        let app = mock_builder()
            .manage(BackgroundState::new(BackgroundStore::new(pictures)))
            .manage(ScrollbackState::new(ScrollbackStore::new(
                pictures.join(SCROLLBACK_DIR_NAME),
            )))
            .invoke_handler(tauri::generate_handler![
                background_image_read,
                file_preview_read,
                git_diff_read,
                fonts_list_monospace,
                hardware_read,
                window_effect_set,
                scrollback_save,
                scrollback_load,
                scrollback_list,
                scrollback_delete
            ])
            .build(mock_context(noop_assets()))
            .expect("build the mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build the mock window");
        prepare(app.handle());
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.parse().expect("url"),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn the_page_lists_the_monospace_fonts_through_the_command() {
        let dir = TempDir::new("fonts-command");
        let answer =
            call_command("fonts_list_monospace", serde_json::json!({}), &dir.0).expect("the fonts");
        let InvokeResponseBody::Json(json) = answer else {
            panic!("a raw answer for a list of names");
        };
        let names: Vec<String> = serde_json::from_str(&json).expect("a list of names");
        for name in &names {
            assert!(
                noren_core::is_font_name(name),
                "{name:?} is not a font name"
            );
        }
        let mut sorted = names.clone();
        sorted.sort_by_key(|name| name.to_lowercase());
        assert_eq!(names, sorted);
        if cfg!(any(windows, target_os = "macos")) {
            assert!(!names.is_empty(), "no monospaced font was listed");
        }
        // Reading the fonts leaves nothing behind in the folder the run was given.
        assert_eq!(std::fs::read_dir(&dir.0).expect("dir").count(), 0);
    }

    /// A made-up source for the command.
    struct MadeUp(Option<u64>, Option<u64>);

    impl noren_core::HardwareSource for MadeUp {
        fn total_ram_bytes(&self) -> Option<u64> {
            self.0
        }
        fn total_vram_bytes(&self) -> Option<u64> {
            self.1
        }
    }

    /// What the page gets from `hardware_read` over a source that says `ram` and `vram`.
    fn hardware_answer(ram: Option<u64>, vram: Option<u64>) -> serde_json::Value {
        let dir = TempDir::new("hardware-command");
        let answer = call_command_after("hardware_read", serde_json::json!({}), &dir.0, |app| {
            app.manage(HardwareState::with_source(MadeUp(ram, vram)));
        })
        .expect("the hardware");
        let InvokeResponseBody::Json(json) = answer else {
            panic!("a raw answer for the memory");
        };
        // Reading the memory leaves nothing behind in the folder the run was given.
        assert_eq!(std::fs::read_dir(&dir.0).expect("dir").count(), 0);
        serde_json::from_str(&json).expect("JSON")
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn the_page_reads_the_memory_of_the_machine_through_the_command() {
        assert_eq!(
            hardware_answer(Some(16 * GIB), Some(8 * GIB)),
            serde_json::json!({ "ramBytes": 16 * GIB, "vramBytes": 8 * GIB })
        );
    }

    #[test]
    fn the_command_answers_a_null_vram_when_it_is_unknown_and_never_leaves_the_field_out() {
        assert_eq!(
            hardware_answer(Some(8 * GIB), None),
            serde_json::json!({ "ramBytes": 8 * GIB, "vramBytes": null })
        );
        // A VRAM that makes no sense is an unknown one, the RAM stays.
        for vram in [0, noren_core::MAX_EXACT_BYTES + 1, u64::MAX] {
            assert_eq!(
                hardware_answer(Some(8 * GIB), Some(vram)),
                serde_json::json!({ "ramBytes": 8 * GIB, "vramBytes": null }),
                "vram {vram}"
            );
        }
    }

    #[test]
    fn the_command_answers_null_when_the_ram_is_not_known_or_makes_no_sense() {
        for ram in [None, Some(0), Some(noren_core::MAX_EXACT_BYTES + 1)] {
            assert_eq!(
                hardware_answer(ram, Some(8 * GIB)),
                serde_json::Value::Null,
                "ram {ram:?}"
            );
        }
    }

    #[test]
    fn the_memory_answer_names_its_fields_in_camel_case_and_keeps_null() {
        let known = HardwareInfo {
            ram_bytes: 17_179_869_184,
            vram_bytes: Some(8_589_934_592),
        };
        assert_eq!(
            serde_json::to_value(known).expect("JSON"),
            serde_json::json!({ "ramBytes": 17_179_869_184u64, "vramBytes": 8_589_934_592u64 })
        );
        let unknown = HardwareInfo::from(noren_core::Hardware {
            ram_bytes: 4_294_967_296,
            vram_bytes: None,
        });
        assert_eq!(
            serde_json::to_value(unknown).expect("JSON"),
            serde_json::json!({ "ramBytes": 4_294_967_296u64, "vramBytes": null })
        );
    }

    const PNG_BYTES: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

    #[test]
    fn the_page_reads_a_picture_through_the_command_as_raw_bytes() {
        let dir = TempDir::new("picture-command");
        std::fs::create_dir_all(dir.0.join("backgrounds")).expect("folder");
        std::fs::write(dir.0.join("backgrounds").join("sky.png"), PNG_BYTES).expect("write");
        // A path inside the config folder, and an absolute one.
        for path in [
            "backgrounds/sky.png".to_owned(),
            dir.0
                .join("backgrounds")
                .join("sky.png")
                .display()
                .to_string(),
        ] {
            let answer = call_command(
                "background_image_read",
                serde_json::json!({ "path": path }),
                &dir.0,
            )
            .expect("the picture");
            match answer {
                InvokeResponseBody::Raw(bytes) => assert_eq!(bytes, PNG_BYTES, "{path}"),
                InvokeResponseBody::Json(json) => panic!("a JSON answer for a picture: {json}"),
            }
        }
    }

    // The file chooser itself is the system's and is never opened by a test (D19); what is ours is
    // the text the page puts on it and the kinds of file it lists.
    #[test]
    fn the_text_on_the_file_chooser_is_clean_and_short() {
        assert_eq!(picker_text("  Choose a picture  ", "x"), "Choose a picture");
        assert_eq!(picker_text("Pic\u{0}tures\n", "x"), "Pictures");
        assert_eq!(picker_text("", "Pictures"), "Pictures");
        assert_eq!(picker_text(" \t\r\n ", "Pictures"), "Pictures");
        let long = "a".repeat(PICKER_TEXT_MAX + 50);
        assert_eq!(picker_text(&long, "x").chars().count(), PICKER_TEXT_MAX);
        // Words of another language stay whole (a character is not a byte).
        assert_eq!(
            picker_text("Escolher imagem de fundo…", "x"),
            "Escolher imagem de fundo…"
        );
    }

    #[test]
    fn the_file_chooser_lists_the_kinds_of_picture_a_background_can_be() {
        let kinds = noren_core::background::BACKGROUND_EXTENSIONS;
        for kind in ["png", "jpg", "jpeg", "webp", "gif", "bmp"] {
            assert!(kinds.contains(&kind), "{kind}");
        }
        // Every one of them is accepted by the check the read applies to the path it gets back.
        for kind in kinds {
            assert_eq!(
                noren_core::background::path_problem(&format!("C:\\Pictures\\sky.{kind}")),
                None,
                "{kind}"
            );
        }
    }

    #[test]
    fn the_picture_command_refuses_what_is_not_a_local_picture_with_a_sentence() {
        let dir = TempDir::new("picture-refused");
        std::fs::write(dir.0.join("notes.png"), b"not a picture").expect("write");
        for (path, words) in [
            ("https://example.com/sky.png", "web addresses"),
            ("\\\\server\\share\\sky.png", "network paths"),
            ("../sky.png", "climb out"),
            ("sky.txt", "png, jpg"),
            ("missing.png", "was not found"),
            ("notes.png", "not a picture"),
        ] {
            let refusal = call_command(
                "background_image_read",
                serde_json::json!({ "path": path }),
                &dir.0,
            )
            .expect_err(path);
            let text = refusal.as_str().unwrap_or_default();
            assert!(text.contains(words), "{path}: {refusal}");
        }
    }

    /// Splits the frame a preview answers with into its JSON header and its body.
    fn preview_frame(answer: InvokeResponseBody) -> (serde_json::Value, Vec<u8>) {
        let InvokeResponseBody::Raw(frame) = answer else {
            panic!("a JSON answer for a preview: the frame is raw bytes");
        };
        let length = u32::from_be_bytes(frame[..4].try_into().expect("a length")) as usize;
        let header = serde_json::from_slice(&frame[4..4 + length]).expect("a JSON header");
        (header, frame[4 + length..].to_vec())
    }

    fn preview_of(path: &str, folder: &Path) -> (serde_json::Value, Vec<u8>) {
        preview_frame(
            call_command(
                "file_preview_read",
                serde_json::json!({ "path": path }),
                folder,
            )
            .expect("an answer, even for a file that is not shown"),
        )
    }

    #[test]
    fn the_page_reads_a_file_for_a_preview_through_the_command_as_one_raw_frame() {
        let dir = TempDir::new("preview-command");
        let markdown = dir.0.join("notes.md");
        std::fs::write(&markdown, "# Notes\n\nbody").expect("write");
        let picture = dir.0.join("pixel.png");
        std::fs::write(&picture, PNG_BYTES).expect("write");
        let data = dir.0.join("data.json");
        std::fs::write(&data, r#"{"a":1}"#).expect("write");

        let (header, body) = preview_of(&markdown.display().to_string(), &dir.0);
        assert_eq!(header, serde_json::json!({ "kind": "markdown" }));
        assert_eq!(body, b"# Notes\n\nbody");

        let (header, body) = preview_of(&data.display().to_string(), &dir.0);
        assert_eq!(header, serde_json::json!({ "kind": "json" }));
        assert_eq!(body, br#"{"a":1}"#);

        let (header, body) = preview_of(&picture.display().to_string(), &dir.0);
        assert_eq!(
            header,
            serde_json::json!({ "kind": "image", "mime": "image/png" })
        );
        assert_eq!(body, PNG_BYTES);
    }

    #[test]
    fn the_preview_command_answers_a_refusal_with_its_reason_and_not_an_error() {
        let dir = TempDir::new("preview-refused");
        let binary = dir.0.join("prog.bin");
        std::fs::write(&binary, b"MZ\0\x01").expect("write");
        let big = dir.0.join("big.txt");
        std::fs::write(&big, vec![b'a'; 1024 * 1024 + 1]).expect("write");
        for (path, reason) in [
            (binary.display().to_string(), "binary"),
            (big.display().to_string(), "too-large"),
            (dir.0.display().to_string(), "directory"),
            (dir.0.join("none.md").display().to_string(), "missing"),
            ("notes.md".to_owned(), "relative"),
            ("\\\\server\\share\\a.md".to_owned(), "network"),
            (String::new(), "invalid"),
        ] {
            let (header, body) = preview_of(&path, &dir.0);
            assert_eq!(header["kind"], "refused", "{path}");
            assert_eq!(header["reason"], reason, "{path}");
            assert!(body.is_empty(), "{path}");
        }
        let (header, _) = preview_of(&big.display().to_string(), &dir.0);
        assert_eq!(header["size"], 1024 * 1024 + 1);
    }

    fn diff_of(folder: &str, scratch: &Path) -> serde_json::Value {
        let answer = call_command(
            "git_diff_read",
            serde_json::json!({ "cwd": folder }),
            scratch,
        )
        .expect("an answer, even for a folder that has no diff");
        let InvokeResponseBody::Json(json) = answer else {
            panic!("a raw answer for a diff: it is JSON");
        };
        serde_json::from_str(&json).expect("a JSON answer")
    }

    #[test]
    fn the_diff_command_answers_a_refusal_with_its_reason_and_not_an_error() {
        let dir = TempDir::new("diff-refused");
        for (folder, reason) in [
            ("repo", "relative"),
            ("\\\\server\\share\\repo", "network"),
            ("", "invalid"),
            (dir.0.join("none").display().to_string().as_str(), "missing"),
        ] {
            let answer = diff_of(folder, &dir.0);
            assert_eq!(answer["kind"], "refused", "{folder}");
            assert_eq!(answer["reason"], reason, "{folder}");
            assert!(answer.get("text").is_none(), "{folder}");
        }
    }

    #[test]
    fn the_diff_command_reads_a_repository_through_the_real_git() {
        let git = std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success());
        if !git {
            eprintln!("warning: git is not installed; skipping the diff command against git");
            return;
        }
        let dir = TempDir::new("diff-command");
        let repo = dir.0.join("repo");
        std::fs::create_dir_all(&repo).expect("create the repository folder");
        let run = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=Noren Test",
                    "-c",
                    "user.email=t@example.com",
                ])
                .args([
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "init.defaultBranch=main",
                ])
                .args(args)
                .current_dir(&repo)
                .env("HOME", &dir.0)
                .env("USERPROFILE", &dir.0)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", dir.0.join("none"))
                .env("GIT_CEILING_DIRECTORIES", &dir.0)
                .output()
                .expect("run git");
            assert!(output.status.success(), "git {args:?} failed");
        };
        run(&["init", "--quiet"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        run(&["add", "a.txt"]);
        run(&["commit", "--quiet", "-m", "first"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").expect("write");

        let answer = diff_of(&repo.display().to_string(), &dir.0);
        assert_eq!(answer["kind"], "diff");
        let text = answer["text"].as_str().expect("the text of the diff");
        assert!(text.contains("diff --git a/a.txt b/a.txt"), "{text}");
        assert!(text.contains("+two\n"), "{text}");
    }

    #[test]
    fn the_page_saves_loads_and_deletes_a_snapshot_through_the_commands() {
        let dir = TempDir::new("scrollback-command");
        let text = "\u{1b}[2mold\u{1b}[0m\nlines \u{e9}";
        call_command(
            "scrollback_save",
            serde_json::json!({ "paneId": "pane-1", "content": text }),
            &dir.0,
        )
        .expect("save");
        assert_eq!(
            std::fs::read_to_string(dir.0.join(SCROLLBACK_DIR_NAME).join("pane-1.txt"))
                .expect("the file"),
            text
        );
        let answer = call_command(
            "scrollback_load",
            serde_json::json!({ "paneId": "pane-1" }),
            &dir.0,
        )
        .expect("load");
        let InvokeResponseBody::Json(json) = answer else {
            panic!("a raw answer for text");
        };
        assert_eq!(
            serde_json::from_str::<Option<String>>(&json).expect("text or null"),
            Some(text.to_owned())
        );

        call_command(
            "scrollback_delete",
            serde_json::json!({ "paneId": "pane-1" }),
            &dir.0,
        )
        .expect("delete");
        let answer = call_command(
            "scrollback_load",
            serde_json::json!({ "paneId": "pane-1" }),
            &dir.0,
        )
        .expect("load again");
        let InvokeResponseBody::Json(json) = answer else {
            panic!("a raw answer for null");
        };
        assert_eq!(json, "null");
    }

    #[test]
    fn the_page_lists_the_snapshots_through_the_command() {
        let dir = TempDir::new("scrollback-list-command");
        let list = || {
            let answer =
                call_command("scrollback_list", serde_json::json!({}), &dir.0).expect("list");
            let InvokeResponseBody::Json(json) = answer else {
                panic!("a raw answer for a list");
            };
            serde_json::from_str::<Vec<String>>(&json).expect("a list of ids")
        };
        // No folder yet: an empty list, and the folder is not created by asking.
        assert_eq!(list(), Vec::<String>::new());
        assert!(!dir.0.join(SCROLLBACK_DIR_NAME).exists());
        for id in ["pane-b", "pane-a"] {
            call_command(
                "scrollback_save",
                serde_json::json!({ "paneId": id, "content": "x" }),
                &dir.0,
            )
            .expect("save");
        }
        std::fs::write(dir.0.join(SCROLLBACK_DIR_NAME).join("notes.md"), "x").expect("other");
        assert_eq!(list(), ["pane-a", "pane-b"]);
    }

    #[test]
    fn the_snapshot_commands_refuse_an_id_that_is_a_path_with_a_sentence() {
        let dir = TempDir::new("scrollback-command-refused");
        for command in ["scrollback_save", "scrollback_load", "scrollback_delete"] {
            let refusal = call_command(
                command,
                serde_json::json!({ "paneId": "../escape", "content": "x" }),
                &dir.0,
            )
            .expect_err(command);
            assert_eq!(
                refusal.as_str(),
                Some("'../escape' is not a valid pane id"),
                "{command}"
            );
        }
        assert!(!dir.0.join("escape.txt").exists());
        assert!(!dir.0.join(SCROLLBACK_DIR_NAME).exists());
    }

    #[test]
    fn an_effect_that_is_not_one_is_an_error_and_nothing_is_painted() {
        let dir = TempDir::new("effect-unknown");
        for effect in ["blur", "Mica", "", "tabbed"] {
            let refusal = call_command(
                "window_effect_set",
                serde_json::json!({ "effect": effect, "scheme": "dark" }),
                &dir.0,
            )
            .expect_err(effect);
            assert_eq!(
                refusal.as_str(),
                Some(format!("'{effect}' is not a window effect").as_str())
            );
        }
    }

    #[test]
    fn the_effect_is_set_from_the_main_window_with_a_browser_pane_open() {
        // Tauri stops calling a window a webview window while a web view of a pane is a child of it,
        // and refused the command when it asked for a `WebviewWindow` (finding 259). The mock paints
        // nothing, so what is checked is that the call is answered and not refused, and that the
        // answer names what was asked.
        let dir = TempDir::new("effect-with-a-pane");
        let answer = call_command_after(
            "window_effect_set",
            serde_json::json!({ "effect": "mica", "scheme": "dark" }),
            &dir.0,
            |app| {
                crate::browser_pane::open_a_pane_in_main(app);
                assert!(app.get_webview_window("main").is_none());
            },
        )
        .expect("the effect is set, the call is not refused");
        let InvokeResponseBody::Json(json) = answer else {
            panic!("a raw answer for a report");
        };
        let report: serde_json::Value = serde_json::from_str(&json).expect("a report");
        assert_eq!(report["requested"], "mica");
        assert!(report["applied"].is_string());
    }

    #[test]
    fn a_scheme_that_is_not_one_is_an_error_too() {
        let dir = TempDir::new("effect-scheme");
        for scheme in ["Dark", "auto", "", "true"] {
            let refusal = call_command(
                "window_effect_set",
                serde_json::json!({ "effect": "mica", "scheme": scheme }),
                &dir.0,
            )
            .expect_err(scheme);
            assert_eq!(
                refusal.as_str(),
                Some(format!("'{scheme}' is not a window scheme").as_str())
            );
        }
    }

    #[test]
    fn write_data_converts_text_and_bytes() {
        assert_eq!(WriteData::Text("é\r".into()).into_bytes(), b"\xc3\xa9\r");
        assert_eq!(WriteData::Bytes(vec![3, 4]).into_bytes(), vec![3, 4]);
    }

    // ---- Moving the output of a live session to another channel (the quick window's promotion) ----

    /// Everything a channel received, as bytes.
    type Received = Arc<Mutex<Vec<u8>>>;

    fn collecting() -> (Channel<InvokeResponseBody>, Received) {
        let received: Received = Arc::default();
        let sink = Arc::clone(&received);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend_from_slice(&bytes);
            }
            Ok(())
        });
        (channel, received)
    }

    fn received(of: &Received) -> Vec<u8> {
        of.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// A shell that stays up and can be told to print the number of its own process.
    #[cfg(windows)]
    fn shell_profile() -> Profile {
        Profile {
            args: vec!["-NoLogo".to_owned(), "-NoProfile".to_owned()],
            inject_integration: false,
            remote: None,
            ..profile_running("powershell.exe")
        }
    }
    #[cfg(not(windows))]
    fn shell_profile() -> Profile {
        Profile {
            inject_integration: false,
            remote: None,
            ..profile_running("sh")
        }
    }

    fn profile_running(program: &str) -> Profile {
        Profile {
            id: "test".to_owned(),
            name: "Test shell".to_owned(),
            program: program.to_owned(),
            args: Vec::new(),
            cwd: None,
            inject_integration: false,
            remote: None,
        }
    }

    /// The line that makes the shell print `noren-pid-<its process number>-end`. The shell echoes
    /// what is typed, but that text has `$PID` or `$$` where the number goes, so only the output of
    /// the command has digits there.
    #[cfg(windows)]
    const PID_COMMAND: &[u8] = b"Write-Output \"noren-pid-$PID-end\"\r";
    #[cfg(not(windows))]
    const PID_COMMAND: &[u8] = b"echo \"noren-pid-$$-end\"\n";

    /// The line that makes the shell end by itself, with code 0.
    #[cfg(windows)]
    const EXIT_COMMAND: &[u8] = b"exit\r";
    #[cfg(not(windows))]
    const EXIT_COMMAND: &[u8] = b"exit\n";

    /// The process number the shell printed in answer to [`PID_COMMAND`], when it has.
    fn printed_pid(output: &[u8]) -> Option<u32> {
        let text = crate::smoke::strip_ansi(&String::from_utf8_lossy(output));
        text.split("noren-pid-").skip(1).find_map(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            (!digits.is_empty() && rest[digits.len()..].starts_with("-end"))
                .then(|| digits.parse().ok())
                .flatten()
        })
    }

    fn wait_for_pid(output: &Received) -> u32 {
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        loop {
            if let Some(pid) = printed_pid(&received(output)) {
                return pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the shell never printed its process number; it printed {:?}",
                String::from_utf8_lossy(&received(output))
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn state_with_shell() -> AppState {
        AppState::with_detected(ProfileSet {
            profiles: vec![shell_profile()],
            default_id: Some("test".to_owned()),
        })
    }

    #[test]
    fn printed_pid_reads_the_answer_and_not_the_typed_line() {
        assert_eq!(printed_pid(b"noren-pid-4242-end\r\n"), Some(4242));
        assert_eq!(
            printed_pid(
                b"PS> \x1b[93mWrite-Output\x1b[m \"noren-pid-$PID-end\"\r\nnoren-pid-17-end\r\n"
            ),
            Some(17)
        );
        assert_eq!(printed_pid(b"echo \"noren-pid-$$-end\"\r\n"), None);
        assert_eq!(printed_pid(b"noren-pid-12"), None);
        assert_eq!(printed_pid(b""), None);
    }

    #[test]
    fn a_session_moved_to_a_new_channel_is_the_same_process_with_its_output_only_in_the_new_one() {
        moving_a_session_keeps_its_process(state_with_shell());
    }

    /// The scenario of the promotion of a quick-window session, for sessions that live wherever
    /// `state` keeps them.
    fn moving_a_session_keeps_its_process(state: AppState) {
        let app = tauri::test::mock_app();
        let (old, in_old) = collecting();
        let (id, profile) =
            create_session(app.handle(), &state, None, None, None, 120, 30, old).expect("start");
        assert_eq!(profile, "test");
        let route = state.route(id).expect("a live session has a route");
        assert_eq!(route.channels(), 1);

        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write");
        let pid_before = wait_for_pid(&in_old);

        let (new, in_new) = collecting();
        attach_session(&state, id, new, false).expect("attach");
        // Nothing was in flight past the replacement: what the old channel has is all it will have.
        let old_final = received(&in_old);
        assert_eq!(route.channels(), 2);
        assert_eq!(
            received(&in_new),
            Vec::<u8>::new(),
            "nothing reached the new one yet"
        );

        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write again");
        let pid_after = wait_for_pid(&in_new);

        assert_eq!(pid_before, pid_after, "the shell is the same process");
        assert_eq!(
            received(&in_old),
            old_final,
            "the old channel got output after the move"
        );
        assert!(
            state.route(id).is_some_and(|now| Arc::ptr_eq(&now, &route)),
            "the session has the same route"
        );
        assert_eq!(
            state.sessions.session_count(),
            1,
            "no session was started or ended"
        );

        state.sessions.kill(SessionId(id)).expect("kill");
    }

    /// How many times the shell answered [`PID_COMMAND`] in `output` (the typed line carries no
    /// number, so only the answers count).
    fn answers(output: &Received, pid: u32) -> usize {
        let text = crate::smoke::strip_ansi(&String::from_utf8_lossy(&received(output)));
        text.matches(&format!("noren-pid-{pid}-end")).count()
    }

    #[test]
    fn a_session_in_the_daemon_taken_over_with_the_replay_shows_what_it_printed_before_once() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let app = tauri::test::mock_app();
        let state = a_run_on(&name, None, false);
        let (id, pid) = start_pane_shell(&app, &state, None);
        let route = state.route(id).expect("a live session has a route");

        // Without the option the page gets what comes next only, as before.
        let (plain, plain_heard) = collecting();
        attach_session(&state, id, plain, false).expect("move the output");
        assert!(received(&plain_heard).is_empty(), "nothing old came along");

        // With it, the page that draws a new terminal gets what the shell printed before, first.
        let (page, heard) = collecting();
        attach_session(&state, id, page, true).expect("take it over with the replay");
        assert_eq!(wait_for_pid(&heard), pid, "what it printed before came");
        assert_eq!(route.channels(), 3, "the page changed twice");
        assert_eq!(answers(&heard, pid), 1, "and it came once");

        // After it, what the shell prints now, on the same channel, behind it.
        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write again");
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        while answers(&heard, pid) < 2 {
            assert!(
                std::time::Instant::now() < deadline,
                "the shell did not answer again"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(answers(&heard, pid), 2);
        assert_eq!(
            answers(&plain_heard, pid),
            0,
            "the channel it left got nothing more"
        );
        assert_eq!(daemon.session_count(), 1, "nothing was started");
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    #[test]
    fn a_replay_asked_for_a_session_in_this_process_moves_it_without_one() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = state_with_shell();
        let app = tauri::test::mock_app();
        let (old, in_old) = collecting();
        let (id, _) =
            create_session(app.handle(), &state, None, None, None, 80, 24, old).expect("start");
        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write");
        let pid = wait_for_pid(&in_old);

        let (page, heard) = collecting();
        attach_session(&state, id, page, true).expect("it moves, with nothing to replay");
        assert!(received(&heard).is_empty(), "this process keeps nothing");
        assert_eq!(state.route(id).expect("route").channels(), 2);
        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write again");
        assert_eq!(wait_for_pid(&heard), pid);
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    #[test]
    fn a_session_that_ended_has_no_route_left_and_cannot_be_taken_over() {
        let state = state_with_shell();
        let app = tauri::test::mock_app();
        let (channel, _) = collecting();
        let (id, _) =
            create_session(app.handle(), &state, None, None, None, 80, 24, channel).expect("start");
        assert!(state.route(id).is_some());
        state.sessions.kill(SessionId(id)).expect("kill");
        assert!(state.route(id).is_none(), "the route went with the session");

        let (late, in_late) = collecting();
        let refusal = attach_session(&state, id, late, false).expect_err("the session is gone");
        assert!(refusal.contains("unknown session"), "{refusal}");
        assert!(received(&in_late).is_empty());
    }

    /// A `state.json` whose active pane asks for the default profile in `cwd`.
    fn saved_state_in(cwd: &Path) -> PathBuf {
        let file = cwd.join("state.json");
        let state = serde_json::json!({
            "version": 2,
            "activeSpaceId": "s1",
            "spaces": [{
                "id": "s1",
                "defaults": { "env": {} },
                "activeItemId": "i1",
                "items": { "i1": {
                    "focusedPaneId": "p1",
                    "layout": { "kind": "pane", "pane": {
                        "id": "p1", "type": "terminal", "profileId": "default",
                        "cwd": cwd.to_string_lossy(),
                    } },
                } },
            }],
        });
        std::fs::write(&file, state.to_string()).expect("write the saved state");
        file
    }

    /// Starts the search for the shell ahead and waits until it is running.
    fn wait_for_prespawned(app: &tauri::App<tauri::test::MockRuntime>, file: PathBuf) {
        crate::prespawn::start(app.handle(), file);
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        loop {
            let state = app.state::<AppState>();
            let slot = state.prespawn.lock().unwrap();
            if matches!(*slot, crate::prespawn::Slot::Ready(_)) {
                return;
            }
            assert!(
                !matches!(*slot, crate::prespawn::Slot::Closed),
                "no shell was started ahead"
            );
            drop(slot);
            assert!(std::time::Instant::now() < deadline, "no shell in time");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn temp_folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("noren-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("make the folder");
        dir
    }

    #[test]
    fn a_shell_started_ahead_is_handed_to_the_call_that_asks_for_the_same_thing_with_what_it_printed()
     {
        a_shell_started_ahead_is_claimed(state_with_shell(), "prespawn-claim");
    }

    /// The scenario of the shell started ahead, for sessions that live wherever `state` keeps them;
    /// `folder` names the scratch folder of the run.
    fn a_shell_started_ahead_is_claimed(state: AppState, folder: &str) {
        let dir = temp_folder(folder);
        let app = tauri::test::mock_app();
        app.manage(state);
        wait_for_prespawned(&app, saved_state_in(&dir));
        let state = app.state::<AppState>();
        assert_eq!(state.sessions.session_count(), 1, "one shell is running");
        // Let it print its first lines before anyone asks for it.
        std::thread::sleep(Duration::from_millis(1500));

        let (page, in_page) = collecting();
        let dir_text = dir.to_string_lossy().into_owned();
        let (id, profile) = create_session(
            app.handle(),
            &state,
            None,
            Some(&dir_text),
            None,
            80,
            24,
            page,
        )
        .expect("claim");
        assert_eq!(profile, "test");
        assert_eq!(state.sessions.session_count(), 1, "no second shell started");
        assert!(
            !received(&in_page).is_empty(),
            "what the shell printed before the call came with it"
        );
        let route = state.route(id).expect("a route");
        assert_eq!(route.channels(), 1, "the page did not move the session");

        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write");
        assert!(wait_for_pid(&in_page) > 0, "the claimed shell answers");
        state.sessions.kill(SessionId(id)).expect("kill");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_call_that_asks_for_something_else_starts_its_own_shell_and_closing_ends_the_other_silently()
     {
        let dir = temp_folder("prespawn-other");
        let app = tauri::test::mock_app();
        app.manage(state_with_shell());
        wait_for_prespawned(&app, saved_state_in(&dir));
        let state = app.state::<AppState>();

        // Another folder: not the shell that was started.
        let (page, in_page) = collecting();
        let (id, _) = create_session(app.handle(), &state, None, None, None, 80, 24, page)
            .expect("its own shell");
        assert_eq!(state.sessions.session_count(), 2, "both shells are running");
        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write");
        assert!(wait_for_pid(&in_page) > 0);

        state.close_prespawn();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while state.sessions.session_count() > 1 {
            assert!(
                std::time::Instant::now() < deadline,
                "the shell ahead stayed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            matches!(
                *state.prespawn.lock().unwrap(),
                crate::prespawn::Slot::Closed
            ),
            "nothing is kept"
        );
        // Nothing to claim any more.
        let (again, _) = collecting();
        assert!(state.claim_prespawned(&shell_spec(), &again).is_none());
        state.sessions.kill(SessionId(id)).expect("kill");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn shell_spec() -> SpawnSpec {
        shell_profile().spawn_spec(80, 24)
    }

    #[test]
    fn a_session_that_never_existed_cannot_be_taken_over() {
        let state = state_with_shell();
        let (channel, _) = collecting();
        let refusal = attach_session(&state, 99, channel, false).expect_err("no such session");
        assert_eq!(refusal, "unknown session 99");
    }

    // ---- The same, with the sessions in the session daemon (NOR-F14-02a) ----

    /// A daemon of the test on a name of its own, and a state whose sessions live in it.
    fn state_in_a_daemon() -> (noren_core::daemon::Daemon, AppState) {
        use crate::daemon_link::{DaemonSettings, Host};
        use noren_core::daemon::{Daemon, Endpoint, ServerConfig};
        use std::sync::atomic::{AtomicUsize, Ordering};

        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let name = format!(
            "bridge-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let daemon = Daemon::start(
            Endpoint::named(&name).expect("endpoint"),
            ServerConfig::default(),
        )
        .expect("start the daemon");
        let settings = DaemonSettings {
            // A path with nothing at it: the state must find the daemon, not start one.
            program: Some(std::env::temp_dir().join("noren-no-such-norend-77b2c0")),
            ..DaemonSettings::for_run(name)
        };
        let state = AppState::with_detected_in(
            ProfileSet {
                profiles: vec![shell_profile()],
                default_id: Some("test".to_owned()),
            },
            Host::Daemon(settings),
        );
        (daemon, state)
    }

    #[test]
    fn a_session_in_the_daemon_streams_to_the_page_and_its_end_is_announced_and_releases_its_route()
    {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        use tauri::Listener;

        let (daemon, state) = state_in_a_daemon();
        let app = tauri::test::mock_app();
        let (exits_tx, exits) = std::sync::mpsc::channel::<String>();
        app.listen(SESSION_EXIT_EVENT, move |event| {
            let _ = exits_tx.send(event.payload().to_owned());
        });

        let (page, in_page) = collecting();
        let (id, _) =
            create_session(app.handle(), &state, None, None, None, 120, 30, page).expect("start");
        assert_eq!(daemon.session_count(), 1, "the shell lives in the daemon");
        assert!(state.route(id).is_some());

        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write");
        let printed = wait_for_pid(&in_page);
        // The pid the daemon lists for the session is the pid the shell says it has.
        let listed = state.sessions.process_ids(&[SessionId(id)]);
        assert_eq!(listed, vec![(SessionId(id), Some(printed))]);

        // The shell ends on its own: the page is told, once, with the id and the code.
        state
            .sessions
            .write(SessionId(id), EXIT_COMMAND)
            .expect("write exit");
        let payload = exits
            .recv_timeout(Duration::from_secs(40))
            .expect("session-exit within 40 s");
        let payload: serde_json::Value = serde_json::from_str(&payload).expect("json");
        assert_eq!(payload["id"], id);
        assert_eq!(payload["code"], 0);
        assert!(state.route(id).is_none(), "the route went with the session");
        assert!(
            exits.recv_timeout(Duration::from_millis(300)).is_err(),
            "announced once"
        );

        // An ended session stays in the daemon until it is killed, like in the session manager.
        assert_eq!(daemon.session_count(), 1);
        state.sessions.kill(SessionId(id)).expect("release it");
        assert_eq!(daemon.session_count(), 0);
        assert_eq!(state.sessions.session_count(), 0);
    }

    #[test]
    fn a_session_in_the_daemon_moved_to_a_new_channel_is_the_same_process() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (_daemon, state) = state_in_a_daemon();
        moving_a_session_keeps_its_process(state);
    }

    #[test]
    fn a_shell_started_ahead_in_the_daemon_is_handed_to_the_call_that_asks_for_it() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, state) = state_in_a_daemon();
        a_shell_started_ahead_is_claimed(state, "prespawn-claim-daemon");
        assert_eq!(daemon.session_count(), 0, "it was killed at the end");
    }

    #[test]
    fn the_agent_scan_starts_from_the_pid_the_daemon_lists_for_each_session() {
        use noren_core::ProcessInfo;

        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (_daemon, state) = state_in_a_daemon();
        let app = tauri::test::mock_app();
        let (page, in_page) = collecting();
        let (id, _) =
            create_session(app.handle(), &state, None, None, None, 80, 24, page).expect("start");
        // The shell is up (it printed something) before anything is asked or closed.
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        while received(&in_page).is_empty() {
            assert!(std::time::Instant::now() < deadline, "the shell was silent");
            std::thread::sleep(Duration::from_millis(20));
        }
        let shell = state.sessions.process_ids(&[SessionId(id)])[0]
            .1
            .expect("a live shell has a pid");

        // A process tree made up around that pid: an agent under the shell of the session.
        struct Tree(Vec<ProcessInfo>);
        impl ProcessSource for Tree {
            fn snapshot(&self) -> Vec<ProcessInfo> {
                self.0.clone()
            }
        }
        let process = |pid: u32, parent: u32, name: &str| ProcessInfo {
            pid,
            parent: Some(parent),
            name: name.to_owned(),
            cmdline: vec![name.to_owned()],
        };
        let tree = Tree(vec![
            process(shell, 1, "shell"),
            process(shell + 100_000, shell, "claude"),
        ]);
        let found = scan_agents(&state, &tree, &[id, 987_654], vec![agent_entry("claude")]);
        assert_eq!(
            found,
            Ok(vec![AgentHitDto {
                session_id: id,
                agent_id: "claude".to_owned()
            }]),
            "the session that exists has its agent, the one that does not has none"
        );
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    // ---- The shells of the panes outliving the app (NOR-F14-02b) ----
    //
    // A "run" is an `AppState` on a daemon of the test; dropping it is the app going away (its
    // connection closes and the daemon, which is the test's, carries on).

    use crate::pane_sessions::Binding;

    /// A daemon of the test on a name of its own.
    fn a_daemon() -> (noren_core::daemon::Daemon, String) {
        use noren_core::daemon::{Daemon, Endpoint, ServerConfig};
        use std::sync::atomic::{AtomicUsize, Ordering};

        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let name = format!(
            "persist-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let daemon = Daemon::start(
            Endpoint::named(&name).expect("endpoint"),
            ServerConfig::default(),
        )
        .expect("start the daemon");
        (daemon, name)
    }

    /// One run of the app on the daemon `name`, with the setting as `keep` says and its book in
    /// `book` (in memory when `None`).
    fn a_run_on(name: &str, book: Option<&Path>, keep: bool) -> AppState {
        use crate::daemon_link::DaemonSettings;

        let state = AppState::with_detected_in(
            ProfileSet {
                profiles: vec![shell_profile()],
                default_id: Some("test".to_owned()),
            },
            Host::Daemon(DaemonSettings {
                endpoint: name.to_owned(),
                // A path with nothing at it: the run must find the daemon, not start one.
                program: Some(std::env::temp_dir().join("noren-no-such-norend-31c9d4")),
                ..DaemonSettings::normal()
            }),
        );
        state.set_keep_sessions(keep);
        if let Some(book) = book {
            state.use_pane_book(PaneBook::open(book.to_path_buf(), name));
        }
        state
    }

    /// Starts a shell the way the `session_create` command does for a pane (`pane` is its id, `None`
    /// for a shell with no pane, such as the quick window's) and waits until it has answered.
    fn start_pane_shell(
        app: &tauri::App<tauri::test::MockRuntime>,
        state: &AppState,
        pane: Option<&str>,
    ) -> (u64, u32) {
        let (output, heard) = collecting();
        let (id, _) = create_session(app.handle(), state, None, None, None, 80, 24, output)
            .expect("start a shell");
        if let Some(pane) = pane {
            state.bind_pane(pane, SessionId(id));
        }
        state
            .sessions
            .write(SessionId(id), PID_COMMAND)
            .expect("write");
        (id, wait_for_pid(&heard))
    }

    fn a_book_file(name: &str) -> PathBuf {
        temp_folder(name).join(crate::pane_sessions::BOOK_FILE_NAME)
    }

    /// Waits until the daemon holds `count` sessions.
    fn wait_for_session_count(daemon: &noren_core::daemon::Daemon, count: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        while daemon.session_count() != count {
            assert!(
                std::time::Instant::now() < deadline,
                "the daemon holds {} sessions, expected {count}",
                daemon.session_count()
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    /// Waits until the daemon says nobody is attached to the sessions `ids`: a run that went away
    /// closed its connection, and the daemon notices a moment later.
    fn wait_until_nobody_is_attached(state: &AppState, ids: &[u64]) {
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        loop {
            let attached = state
                .sessions
                .list()
                .expect("list")
                .iter()
                .filter(|info| ids.contains(&info.session.0) && info.attached > 0)
                .count();
            if attached == 0 {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{attached} session(s) still have a client attached"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    #[test]
    fn leaving_with_the_setting_on_keeps_the_shell_of_a_pane_running_and_ends_the_rest() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let state = a_run_on(&name, None, true);
        let app = tauri::test::mock_app();
        let (pane_shell, pid) = start_pane_shell(&app, &state, Some("pane-a"));
        // A shell with no pane to come back to, like the one in the quick window.
        let (_other, _) = start_pane_shell(&app, &state, None);
        assert_eq!(daemon.session_count(), 2);

        state.end_sessions_on_exit();

        wait_for_session_count(&daemon, 1);
        let listed = state.sessions.list().expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session, SessionId(pane_shell));
        assert_eq!(listed[0].pid, Some(pid), "the same process, still running");
        assert!(listed[0].exit.is_none());
        assert_eq!(
            state.pane_book.lock().unwrap().binding("pane-a"),
            Some(Binding {
                session: pane_shell,
                pid
            }),
            "the pane is still written down for the next run"
        );
        state
            .sessions
            .kill(SessionId(pane_shell))
            .expect("clean up");
    }

    #[test]
    fn leaving_with_the_setting_off_ends_every_session_and_forgets_the_panes() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let book = a_book_file("leave-off");
        let state = a_run_on(&name, Some(&book), false);
        let app = tauri::test::mock_app();
        start_pane_shell(&app, &state, Some("pane-a"));
        start_pane_shell(&app, &state, Some("pane-b"));
        assert_eq!(daemon.session_count(), 2);
        assert_eq!(state.pane_book.lock().unwrap().len(), 2);

        state.end_sessions_on_exit();

        wait_for_session_count(&daemon, 0);
        assert!(state.pane_book.lock().unwrap().is_empty());
        assert!(
            PaneBook::open(book.clone(), &name).is_empty(),
            "and so is the book on disk"
        );
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn quitting_for_good_ends_the_shells_of_the_panes_and_the_daemon_though_the_setting_keeps_them()
    {
        use crate::daemon_link::{DaemonSettings, Placement, norend_binary};

        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let name = format!("quit-{}", std::process::id());
        let book = a_book_file("quit-for-good");
        // A normal run: it starts a norend of its own that outlives it, and keeps the shells.
        let state = AppState::with_detected_in(
            ProfileSet {
                profiles: vec![shell_profile()],
                default_id: Some("test".to_owned()),
            },
            Host::Daemon(DaemonSettings {
                endpoint: name.clone(),
                program: Some(norend_binary()),
                ..DaemonSettings::normal()
            }),
        );
        state.set_keep_sessions(true);
        state.use_pane_book(PaneBook::open(book.clone(), &name));
        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = state.sessions.placement()
        else {
            panic!("expected a norend this run started");
        };
        let app = tauri::test::mock_app();
        let (_, pane_pid) = start_pane_shell(&app, &state, Some("pane-a"));
        let (_, other_pid) = start_pane_shell(&app, &state, Some("pane-b"));
        assert_eq!(state.pane_book.lock().unwrap().len(), 2);

        // Without the tray's quit the same exit leaves both shells (that is the setting).
        state.begin_quit();
        assert!(state.is_quitting());
        state.end_sessions_on_exit();

        // Everything is gone: the shells of the panes, the daemon, and the endpoint.
        let processes = SystemProcesses::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        for pid in [pane_pid, other_pid, norend] {
            loop {
                if !processes.snapshot().iter().any(|p| p.pid == pid) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "process {pid} outlived the quit"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        assert!(!state.sessions.daemon_listens(), "the endpoint is free");
        assert!(state.pane_book.lock().unwrap().is_empty());
        assert!(
            PaneBook::open(book.clone(), &name).is_empty(),
            "nothing is left written down for the next run to look for"
        );
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn the_next_run_gets_back_the_shell_of_the_pane_by_its_id_with_what_it_printed() {
        use tauri::Listener;

        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let book = a_book_file("reattach");
        let app = tauri::test::mock_app();

        let first = a_run_on(&name, Some(&book), true);
        let (id, pid) = start_pane_shell(&app, &first, Some("pane-a"));
        first.end_sessions_on_exit();
        drop(first);
        assert_eq!(daemon.session_count(), 1, "the shell outlived that run");

        let second = a_run_on(&name, Some(&book), true);
        let (exits_tx, exits) = std::sync::mpsc::channel::<String>();
        app.listen(SESSION_EXIT_EVENT, move |event| {
            let _ = exits_tx.send(event.payload().to_owned());
        });

        // A pane the book does not know gets nothing: the page starts a shell for it.
        let (stranger, _) = collecting();
        assert_eq!(second.reattach_pane(app.handle(), "pane-z", stranger), None);
        assert_eq!(second.sessions.session_count(), 0);

        let (output, heard) = collecting();
        let got = second
            .reattach_pane(app.handle(), "pane-a", output)
            .expect("the pane gets its shell back");
        assert_eq!(got, SessionId(id));
        assert!(
            second.route(id).is_some(),
            "it has a route like any session"
        );
        assert_eq!(second.sessions.session_count(), 1);
        assert_eq!(daemon.session_count(), 1, "nothing was started");
        // What it printed while no app was attached came with it ...
        assert_eq!(wait_for_pid(&heard), pid, "the buffer came back");
        // ... and it is the same process, answering.
        let (second_output, second_received) = collecting();
        attach_session(&second, id, second_output, false).expect("move the output");
        second.sessions.write(got, PID_COMMAND).expect("write");
        assert_eq!(wait_for_pid(&second_received), pid);

        // Its end is announced as for any session.
        second.sessions.write(got, EXIT_COMMAND).expect("exit");
        let payload = exits
            .recv_timeout(Duration::from_secs(40))
            .expect("session-exit within 40 s");
        let payload: serde_json::Value = serde_json::from_str(&payload).expect("json");
        assert_eq!(payload["id"], id);
        assert!(second.route(id).is_none());

        second.sessions.kill(got).expect("release it");
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn a_session_with_the_ids_of_the_pane_but_another_process_is_not_its_shell() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let book = a_book_file("another-process");
        let app = tauri::test::mock_app();

        let first = a_run_on(&name, Some(&book), true);
        let (id, pid) = start_pane_shell(&app, &first, Some("pane-a"));
        first.end_sessions_on_exit();
        drop(first);

        // The daemon started again would number its sessions from the start: same id, other process.
        let second = a_run_on(&name, Some(&book), true);
        second.pane_book.lock().unwrap().bind(
            "pane-a",
            Binding {
                session: id,
                pid: pid + 1,
            },
        );
        let (output, heard) = collecting();
        assert_eq!(second.reattach_pane(app.handle(), "pane-a", output), None);
        assert!(received(&heard).is_empty());
        assert_eq!(second.pane_book.lock().unwrap().binding("pane-a"), None);
        assert_eq!(second.sessions.session_count(), 0);
        assert_eq!(daemon.session_count(), 1, "and it was not touched");

        second.sessions.kill(SessionId(id)).expect("clean up");
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn the_shells_no_pane_came_back_for_are_ended_and_the_ones_somebody_is_attached_to_are_not() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let book = a_book_file("orphans");
        let app = tauri::test::mock_app();

        let first = a_run_on(&name, Some(&book), true);
        let (a, _) = start_pane_shell(&app, &first, Some("pane-a"));
        let (b, _) = start_pane_shell(&app, &first, Some("pane-b"));
        let (c, _) = start_pane_shell(&app, &first, Some("pane-c"));
        first.end_sessions_on_exit();
        drop(first);
        assert_eq!(daemon.session_count(), 3);

        // The next run restores one pane. Another client is attached to the shell of a third.
        let second = a_run_on(&name, Some(&book), true);
        let elsewhere = a_run_on(&name, None, true);
        wait_until_nobody_is_attached(&second, &[a, b, c]);
        let (output, _received) = collecting();
        assert_eq!(
            second.reattach_pane(app.handle(), "pane-a", output),
            Some(SessionId(a))
        );
        elsewhere
            .sessions
            .reattach(SessionId(c), |_| {})
            .expect("another client attaches");

        assert_eq!(second.reap_orphans(), 1, "only the one nobody wants");
        wait_for_session_count(&daemon, 2);
        let left: Vec<u64> = second
            .sessions
            .list()
            .expect("list")
            .iter()
            .map(|info| info.session.0)
            .collect();
        assert!(left.contains(&a), "the pane's own shell stays");
        assert!(left.contains(&c), "so does the one a client is attached to");
        assert!(!left.contains(&b));
        assert_eq!(
            second.pane_book.lock().unwrap().binding("pane-b"),
            None,
            "its pane is forgotten"
        );
        assert_eq!(second.reap_orphans(), 0, "nothing more to end");

        second.sessions.kill(SessionId(a)).expect("clean up");
        elsewhere.sessions.kill(SessionId(c)).expect("clean up");
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn with_the_setting_off_nothing_is_taken_over_and_what_was_left_is_ended() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let book = a_book_file("setting-off");
        let app = tauri::test::mock_app();

        let first = a_run_on(&name, Some(&book), true);
        let (a, _) = start_pane_shell(&app, &first, Some("pane-a"));
        first.end_sessions_on_exit();
        drop(first);

        let second = a_run_on(&name, Some(&book), false);
        wait_until_nobody_is_attached(&second, &[a]);
        let (output, heard) = collecting();
        assert_eq!(second.reattach_pane(app.handle(), "pane-a", output), None);
        assert!(received(&heard).is_empty());
        assert_eq!(daemon.session_count(), 1, "it asked for nothing");

        assert_eq!(second.reap_orphans(), 1);
        wait_for_session_count(&daemon, 0);
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn a_shell_that_ended_while_the_app_was_away_is_released_and_the_pane_gets_a_new_one() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let book = a_book_file("ended-away");
        let app = tauri::test::mock_app();

        let first = a_run_on(&name, Some(&book), true);
        let (a, _) = start_pane_shell(&app, &first, Some("pane-a"));
        first.end_sessions_on_exit();
        drop(first);

        // Somebody else ends the shell while no app is there.
        let elsewhere = a_run_on(&name, None, true);
        elsewhere
            .sessions
            .write(SessionId(a), EXIT_COMMAND)
            .expect("write exit");
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        while elsewhere
            .sessions
            .list()
            .expect("list")
            .iter()
            .any(|info| info.session.0 == a && info.exit.is_none())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the shell did not end"
            );
            std::thread::sleep(Duration::from_millis(30));
        }

        let second = a_run_on(&name, Some(&book), true);
        let (output, heard) = collecting();
        assert_eq!(second.reattach_pane(app.handle(), "pane-a", output), None);
        assert!(received(&heard).is_empty());
        assert_eq!(second.pane_book.lock().unwrap().binding("pane-a"), None);
        wait_for_session_count(&daemon, 0);
        let _ = std::fs::remove_dir_all(book.parent().unwrap());
    }

    #[test]
    fn killing_the_session_of_a_pane_forgets_the_pane() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (daemon, name) = a_daemon();
        let app = tauri::test::mock_app();
        app.manage(a_run_on(&name, None, true));
        let state = app.state::<AppState>();
        let (id, _) = start_pane_shell(&app, &state, Some("pane-a"));
        assert!(state.pane_book.lock().unwrap().binding("pane-a").is_some());

        tauri::async_runtime::block_on(session_kill(app.state::<AppState>(), id)).expect("kill");

        assert_eq!(state.pane_book.lock().unwrap().binding("pane-a"), None);
        wait_for_session_count(&daemon, 0);
    }

    #[test]
    fn sessions_in_this_process_are_never_left_written_down_or_taken_over() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let state = state_with_shell();
        state.set_keep_sessions(true);
        let app = tauri::test::mock_app();
        let (id, _) = start_pane_shell(&app, &state, Some("pane-a"));
        assert!(
            state.pane_book.lock().unwrap().is_empty(),
            "a session that cannot outlive the app is not written down"
        );
        let (output, heard) = collecting();
        assert_eq!(state.reattach_pane(app.handle(), "pane-a", output), None);
        assert!(received(&heard).is_empty());
        assert_eq!(state.reap_orphans(), 0);

        state.end_sessions_on_exit();
        assert!(
            !state.sessions.owns(SessionId(id)),
            "the setting cannot keep it"
        );
    }

    #[test]
    fn no_shell_is_started_ahead_for_a_pane_whose_shell_is_waiting_in_the_daemon() {
        let _turn = crate::daemon_link::ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = temp_folder("prespawn-kept");
        let (daemon, name) = a_daemon();
        let app = tauri::test::mock_app();
        app.manage(a_run_on(&name, None, true));
        let state = app.state::<AppState>();
        // The book says the pane `saved_state_in` asks for first ("p1") had a shell.
        state.pane_book.lock().unwrap().bind(
            "p1",
            Binding {
                session: 1,
                pid: 4242,
            },
        );

        crate::prespawn::start(app.handle(), saved_state_in(&dir));

        // The search ends with nothing started: the page takes the old shell back instead.
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        while !matches!(
            *state.prespawn.lock().unwrap(),
            crate::prespawn::Slot::Closed
        ) {
            assert!(
                std::time::Instant::now() < deadline,
                "the search for a shell ahead never ended"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(daemon.session_count(), 0, "no shell was started ahead");
        assert_eq!(state.sessions.session_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- Profiles of kind ssh: a shell in a norend on another machine (NOR-F14-04b) ----

    use crate::remote::{REMOTE_ID_BASE, RemoteSessions, is_remote};
    use crate::remote_fake::{FakeDaemon, fast, wait_for};
    use noren_core::daemon::Connector;

    fn dto(json: serde_json::Value) -> UserProfileDto {
        serde_json::from_value(json).expect("a profile the interface could send")
    }

    fn ssh_dto() -> UserProfileDto {
        dto(serde_json::json!({
            "kind": "ssh", "id": "build-box", "name": "Build box",
            "host": "build.example.org", "user": "deploy", "port": 2222,
            "identityFile": "C:\\keys\\id_ed25519", "knownHostsFile": "C:\\keys\\known_hosts"
        }))
    }

    #[test]
    fn the_dto_of_an_ssh_profile_carries_the_machine_and_leaves_the_program_to_the_login_shell() {
        let profile = UserProfile::try_from(ssh_dto()).expect("an ssh profile");
        assert_eq!(profile.id, "build-box");
        assert_eq!(profile.program, "");
        assert_eq!(
            profile.ssh,
            Some(SshProfile {
                host: "build.example.org".into(),
                user: Some("deploy".into()),
                port: Some(2222),
                identity_file: Some("C:\\keys\\id_ed25519".into()),
                known_hosts_file: Some("C:\\keys\\known_hosts".into()),
            })
        );
        // The shell of the remote side may be named too.
        let with_shell = UserProfile::try_from(dto(serde_json::json!({
            "kind": "ssh", "id": "b", "name": "B", "host": "h",
            "program": "bash", "args": ["-l"], "cwd": "/srv/app"
        })))
        .expect("an ssh profile");
        assert_eq!(with_shell.program, "bash");
        assert_eq!(with_shell.args, ["-l"]);
        assert_eq!(with_shell.cwd.as_deref(), Some("/srv/app"));
        assert_eq!(with_shell.validate(), Ok(()));
    }

    #[test]
    fn what_the_interface_could_not_have_sent_is_refused_with_the_profile_named() {
        let no_host = UserProfile::try_from(dto(serde_json::json!({
            "kind": "ssh", "id": "b", "name": "B"
        })))
        .expect_err("no host");
        assert_eq!(no_host, "profile 'b': an ssh profile needs a host");
        let shell_with_host = UserProfile::try_from(dto(serde_json::json!({
            "id": "s", "name": "S", "program": "sh", "host": "h"
        })))
        .expect_err("a shell naming a machine");
        assert!(shell_with_host.contains("profile 's'"), "{shell_with_host}");
        let strange = UserProfile::try_from(dto(serde_json::json!({
            "kind": "serial", "id": "x", "name": "X", "program": "sh"
        })))
        .expect_err("another kind");
        assert_eq!(strange, "profile 'x': unknown kind 'serial'");
        // A shell profile with its kind spelled out is the same as one without.
        let shell = UserProfile::try_from(dto(serde_json::json!({
            "kind": "shell", "id": "s", "name": "S", "program": "sh"
        })))
        .expect("a shell");
        assert_eq!(shell.ssh, None);
        // And a shell with no program is refused where profiles are checked, as before.
        let state = detected_state();
        let empty = UserProfile::try_from(dto(serde_json::json!({ "id": "e", "name": "E" })))
            .expect("it parses");
        let refused = state.set_user_profiles(&[empty]).expect_err("no program");
        assert!(refused.contains("program"), "{refused}");
    }

    #[test]
    fn an_ssh_profile_is_listed_with_its_kind_and_is_never_the_default() {
        let state = detected_state();
        let ssh = UserProfile::try_from(ssh_dto()).expect("ssh");
        state
            .set_user_profiles(&[ssh, user("other", "sh")])
            .expect("valid");
        let listed = state.list_profiles();
        let kinds: Vec<(&str, Option<&str>, bool)> = listed
            .iter()
            .map(|p| (p.id.as_str(), p.kind, p.is_default))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("pwsh", None, true),
                ("cmd", None, false),
                ("build-box", Some("ssh"), false),
                ("other", None, false),
            ]
        );
        // On the wire a local shell has no kind at all, and an ssh one has "ssh".
        let wire = serde_json::to_value(&listed).expect("json");
        assert!(wire[0].get("kind").is_none(), "{wire}");
        assert_eq!(wire[2]["kind"], "ssh");
        assert_eq!(wire[2]["default"], false);
        // It is a profile with a machine and no command of its own to start here.
        let found = state.find_profile(Some("build-box")).expect("listed");
        assert!(found.remote.is_some());
        assert!(!found.inject_integration);
    }

    #[test]
    fn the_payload_of_the_link_event_says_the_state_and_leaves_out_what_does_not_apply() {
        let id = SessionId(REMOTE_ID_BASE + 3);
        let up =
            serde_json::to_value(SessionLinkPayload::new(id, &LinkState::Connected)).expect("json");
        assert_eq!(
            up,
            serde_json::json!({ "id": REMOTE_ID_BASE + 3, "state": "connected" })
        );
        let retrying = serde_json::to_value(SessionLinkPayload::new(
            id,
            &LinkState::Reconnecting {
                attempt: 2,
                max_attempts: 20,
                retry_in: Duration::from_millis(1500),
                reason: "Connection reset by peer".into(),
            },
        ))
        .expect("json");
        assert_eq!(
            retrying,
            serde_json::json!({
                "id": REMOTE_ID_BASE + 3, "state": "reconnecting", "attempt": 2,
                "maxAttempts": 20, "retryInMs": 1500, "reason": "Connection reset by peer"
            })
        );
        let failed = serde_json::to_value(SessionLinkPayload::new(
            id,
            &LinkState::Failed {
                reason: "Permission denied (publickey)".into(),
            },
        ))
        .expect("json");
        assert_eq!(
            failed,
            serde_json::json!({
                "id": REMOTE_ID_BASE + 3, "state": "failed",
                "reason": "Permission denied (publickey)"
            })
        );
    }

    /// An app state whose ssh sessions reach `daemon`, with an ssh profile named `box` (and `home`,
    /// the same without a folder) in its list.
    fn state_with_a_remote(daemon: &FakeDaemon, attempts: u32) -> AppState {
        let reach = daemon.clone();
        let remote = RemoteSessions::new(
            std::sync::Arc::new(move |_| Ok(Box::new(reach.connector()) as Box<dyn Connector>)),
            fast(attempts),
        );
        let mut state = detected_state();
        state.sessions = Sessions::new(Host::InProcess).with_remote(remote);
        let mut with_folder = UserProfile::try_from(dto(serde_json::json!({
            "kind": "ssh", "id": "box", "name": "Box", "host": "build.example.org",
            "program": "bash", "args": ["-l"], "cwd": "/srv/app"
        })))
        .expect("ssh");
        with_folder.name = "Box".into();
        let home = UserProfile::try_from(dto(serde_json::json!({
            "kind": "ssh", "id": "home", "name": "Home", "host": "build.example.org"
        })))
        .expect("ssh");
        state
            .set_user_profiles(&[with_folder, home])
            .expect("valid");
        state
    }

    #[test]
    fn a_tab_of_an_ssh_profile_starts_what_the_profile_says_and_nothing_of_this_machine() {
        // Finding 198, all the way from the call the page makes: it passes the folder of the space
        // and the environment of the tab, and none of it goes to the other machine.
        let daemon = FakeDaemon::new();
        let state = state_with_a_remote(&daemon, 5);
        let app = tauri::test::mock_app();
        let (page, in_page) = collecting();
        let this_folder = std::env::current_dir().expect("a folder");
        let env = HashMap::from([("USERPROFILE".to_owned(), "C:\\Users\\me".to_owned())]);

        let (id, profile) = create_session(
            app.handle(),
            &state,
            Some("box"),
            Some(this_folder.to_str().expect("utf-8")),
            Some(env.clone()),
            120,
            30,
            page,
        )
        .expect("start");
        assert_eq!(profile, "box");
        assert!(is_remote(SessionId(id)), "{id}");
        let created = daemon.creates();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].program, "bash");
        assert_eq!(created[0].args, ["-l"]);
        assert!(created[0].env.is_empty(), "{:?}", created[0].env);
        assert_eq!(
            created[0].cwd.as_deref(),
            Some(Path::new("/srv/app")),
            "the folder of the profile, not the one of the call"
        );
        assert_eq!((created[0].cols, created[0].rows), (120, 30));

        // Without a folder in the profile there is none on the wire: the home of the user there.
        let (other, _) = collecting();
        create_session(
            app.handle(),
            &state,
            Some("home"),
            Some(this_folder.to_str().expect("utf-8")),
            Some(env),
            80,
            24,
            other,
        )
        .expect("start");
        let created = daemon.creates();
        assert_eq!(created[1].cwd, None);
        assert!(created[1].env.is_empty());
        // No program either: the login shell of the user there.
        assert_eq!(created[1].program, "sh");
        assert_eq!(created[1].args, ["-c", "exec \"${SHELL:-/bin/sh}\" -l"]);

        // The output reaches the page by the route, in order, and what is typed goes back.
        let session = daemon.session_ids()[0];
        daemon.print(session, b"remote prompt$ ");
        wait_for("the output in the page", || {
            received(&in_page) == b"remote prompt$ "
        });
        state.sessions.write(SessionId(id), b"ls\r").expect("write");
        state
            .sessions
            .resize(SessionId(id), 100, 40)
            .expect("resize");
        assert_eq!(daemon.written_text(session), "ls\r");
        assert_eq!(daemon.resizes(), vec![(session, 100, 40)]);
        assert_eq!(state.sessions.session_count(), 2);
        // An agent scan has no process of this machine to look at.
        assert_eq!(
            state.sessions.process_ids(&[SessionId(id)]),
            vec![(SessionId(id), None)]
        );
    }

    #[test]
    fn the_shell_of_an_ssh_profile_is_not_written_down_for_a_pane_to_find_again() {
        let daemon = FakeDaemon::new();
        let state = state_with_a_remote(&daemon, 5);
        let app = tauri::test::mock_app();
        let (page, _) = collecting();
        let (id, _) = create_session(app.handle(), &state, Some("box"), None, None, 80, 24, page)
            .expect("start");
        state.bind_pane("pane-remote", SessionId(id));
        assert!(
            !state.has_kept_shell("pane-remote"),
            "a remote shell has no process here to check the book against"
        );
    }

    #[test]
    fn the_page_is_told_when_the_connection_of_a_tab_breaks_and_comes_back_and_the_shell_goes_on() {
        use tauri::Listener;
        let daemon = FakeDaemon::new();
        let state = state_with_a_remote(&daemon, 50);
        let app = tauri::test::mock_app();
        let (links_tx, links) = std::sync::mpsc::channel::<String>();
        app.listen(SESSION_LINK_EVENT, move |event| {
            let _ = links_tx.send(event.payload().to_owned());
        });
        let (page, in_page) = collecting();
        let (id, _) = create_session(app.handle(), &state, Some("box"), None, None, 80, 24, page)
            .expect("start");
        let session = daemon.session_ids()[0];
        daemon.print(session, b"before\r\n");
        wait_for("the first output", || received(&in_page) == b"before\r\n");

        daemon.set_down(true);
        daemon.cut_all();
        let first = links
            .recv_timeout(Duration::from_secs(30))
            .expect("session-link when it breaks");
        let first: serde_json::Value = serde_json::from_str(&first).expect("json");
        assert_eq!(first["id"], id);
        assert_eq!(first["state"], "reconnecting");
        assert_eq!(first["attempt"], 1);
        assert_eq!(first["maxAttempts"], 50);
        assert!(first["retryInMs"].is_u64(), "{first}");
        assert!(first["reason"].is_string(), "{first}");

        daemon.print(session, b"while down\r\n");
        daemon.set_down(false);
        let mut last = serde_json::Value::Null;
        for _ in 0..200 {
            let Ok(text) = links.recv_timeout(Duration::from_secs(30)) else {
                break;
            };
            last = serde_json::from_str(&text).expect("json");
            if last["state"] == "connected" {
                break;
            }
        }
        assert_eq!(last["state"], "connected", "{last}");
        assert_eq!(last["id"], id);
        assert!(last.get("attempt").is_none(), "{last}");
        // The tab shows each line once, and the one printed while down arrived.
        wait_for("the line printed while down", || {
            received(&in_page) == b"before\r\nwhile down\r\n"
        });
        assert_eq!(
            daemon.creates().len(),
            1,
            "the same shell: nothing was started again"
        );
        state
            .sessions
            .write(SessionId(id), b"still here\r")
            .expect("write after");
        assert_eq!(daemon.written_text(session), "still here\r");
    }

    #[test]
    fn the_page_can_ask_for_another_try_and_a_shell_of_this_machine_has_nothing_to_retry() {
        use tauri::Listener;
        let daemon = FakeDaemon::new();
        let state = state_with_a_remote(&daemon, 50);
        let app = tauri::test::mock_app();
        let (links_tx, links) = std::sync::mpsc::channel::<String>();
        app.listen(SESSION_LINK_EVENT, move |event| {
            let _ = links_tx.send(event.payload().to_owned());
        });
        let (page, _) = collecting();
        let (id, _) = create_session(app.handle(), &state, Some("box"), None, None, 80, 24, page)
            .expect("start");

        daemon.refuse(Some("Permission denied (publickey)"));
        daemon.cut_all();
        let failed = loop {
            let text = links
                .recv_timeout(Duration::from_secs(30))
                .expect("session-link");
            let payload: serde_json::Value = serde_json::from_str(&text).expect("json");
            if payload["state"] == "failed" {
                break payload;
            }
        };
        assert!(
            failed["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("Permission denied")),
            "{failed}"
        );

        daemon.refuse(None);
        state.sessions.retry(SessionId(id)).expect("retry");
        loop {
            let text = links
                .recv_timeout(Duration::from_secs(30))
                .expect("session-link after the retry");
            let payload: serde_json::Value = serde_json::from_str(&text).expect("json");
            if payload["state"] == "connected" {
                break;
            }
        }

        // A session that is not on another machine has no connection to retry.
        let local = state.sessions.retry(SessionId(7)).expect_err("local id");
        assert!(local.to_string().contains("no connection"), "{local}");
        assert!(
            state
                .sessions
                .retry(SessionId(REMOTE_ID_BASE + 500))
                .is_err()
        );
    }

    #[test]
    fn the_command_to_retry_is_one_the_page_can_call_and_names_what_is_wrong() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
        use tauri::webview::InvokeRequest;

        let daemon = FakeDaemon::new();
        let app = mock_builder()
            .manage(state_with_a_remote(&daemon, 5))
            .invoke_handler(tauri::generate_handler![session_retry])
            .build(mock_context(noop_assets()))
            .expect("build the mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build the mock window");
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        let ask = |id: u64| {
            get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: "session_retry".into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: url.parse().expect("url"),
                    body: InvokeBody::Json(serde_json::json!({ "id": id })),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
        };
        let unknown = ask(REMOTE_ID_BASE + 1).expect_err("no such session");
        assert!(
            unknown
                .as_str()
                .unwrap_or_default()
                .contains("unknown session"),
            "{unknown}"
        );
        let local = ask(3).expect_err("a local id");
        assert!(
            local.as_str().unwrap_or_default().contains("no connection"),
            "{local}"
        );
    }

    #[test]
    fn leaving_the_app_ends_the_shells_on_other_machines_whatever_the_setting_says() {
        // A shell on another machine has no pane to come back to yet, so it does not outlive the
        // app on that machine either: leaving it would pile up shells nobody can see.
        for keep in [true, false] {
            let daemon = FakeDaemon::new();
            let state = state_with_a_remote(&daemon, 5);
            let app = tauri::test::mock_app();
            let (page, _) = collecting();
            let (id, _) =
                create_session(app.handle(), &state, Some("box"), None, None, 80, 24, page)
                    .expect("start");
            state.set_keep_sessions(keep);
            assert_eq!(daemon.session_ids().len(), 1);

            state.end_sessions_on_exit();
            assert_eq!(daemon.session_ids(), Vec::<u64>::new(), "keep={keep}");
            assert_eq!(state.sessions.session_count(), 0);
            assert!(state.sessions.write(SessionId(id), b"x").is_err());
            wait_for("the connection to close", || daemon.connections() == 0);
        }
    }

    #[test]
    fn a_shell_started_ahead_is_never_the_shell_of_an_ssh_profile() {
        let daemon = FakeDaemon::new();
        let state = state_with_a_remote(&daemon, 5);
        let app = tauri::test::mock_app();
        let refused = session_spec(app.handle(), &state, Some("box"), None, None, 80, 24)
            .expect_err("it has no command to run here");
        assert!(refused.contains("another machine"), "{refused}");
        // The shell the machine defaults to still is a local one.
        assert!(session_spec(app.handle(), &state, None, None, None, 80, 24).is_ok());
        assert!(daemon.creates().is_empty(), "nothing was sent anywhere");
    }

    // ---- the output of a session reaches the events of the local API (NOR-F17-01f) ----

    fn page_channel() -> (
        Channel<InvokeResponseBody>,
        std::sync::mpsc::Receiver<Vec<u8>>,
    ) {
        let (tx, rx) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = tx.send(bytes);
            }
            Ok(())
        });
        (channel, rx)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_publishes_its_output_with_its_own_id_and_the_page_gets_the_same_bytes() {
        use crate::api_events::test_support::TestApi;
        let api = TestApi::start();
        let mut client = api.subscriber(&["terminal.output"]).await;
        let state = detected_state();
        let (page, page_rx) = page_channel();
        // The callback of the session, kept to play the thread that reads the shell.
        type Callback = Box<dyn FnMut(SessionEvent<'_>) + Send>;
        let reader: Arc<Mutex<Option<Callback>>> = Arc::new(Mutex::new(None));
        let kept = Arc::clone(&reader);
        // The shell prints before `begin` returns, as a fast one can: its id is not known yet.
        let id = route_session(api.app.handle(), &state, page, None, move |mut on_event| {
            on_event(SessionEvent::Output(b"early "));
            *kept.lock().unwrap() = Some(on_event);
            Ok(SessionId(7))
        })
        .expect("the session starts");
        assert_eq!(id, SessionId(7));

        // A character cut in two chunks by the reader.
        let euro = "€".as_bytes();
        {
            let mut guard = reader.lock().unwrap();
            let on_event = guard.as_mut().expect("the callback");
            on_event(SessionEvent::Output(&[b'a', euro[0]]));
            on_event(SessionEvent::Output(&euro[1..]));
        }

        let heard = client.output_of("7", "early a€".len()).await;
        assert_eq!(heard, "early a€");
        assert_eq!(
            page_rx.try_iter().collect::<Vec<_>>(),
            vec![
                b"early ".to_vec(),
                [&b"a"[..], &euro[..1]].concat(),
                euro[1..].to_vec()
            ],
            "the page gets the bytes as they came, not the text"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_whose_api_is_off_runs_as_before_and_publishes_nothing() {
        use tauri::test::{mock_builder, mock_context};
        let app = mock_builder()
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        crate::api_bridge::install(app.handle(), Err("off".into()));
        assert!(crate::api_events::output_events(app.handle()).is_none());
        // An app that never installed the API is the same.
        let bare = mock_builder()
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        assert!(crate::api_events::output_events(bare.handle()).is_none());

        let state = detected_state();
        let (page, page_rx) = page_channel();
        let id = route_session(app.handle(), &state, page, None, |mut on_event| {
            on_event(SessionEvent::Output(b"hello"));
            Ok(SessionId(3))
        })
        .expect("the session starts");
        assert_eq!(id, SessionId(3));
        assert_eq!(
            page_rx.try_iter().collect::<Vec<_>>(),
            vec![b"hello".to_vec()]
        );
    }
}

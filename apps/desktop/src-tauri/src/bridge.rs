//! Tauri commands on top of the `noren-core` session manager and shell profiles.
//!
//! Terminal output goes to the interface through a `tauri::ipc::Channel` as raw bytes
//! (`InvokeResponseBody::Raw`), never as JSON; the end of a session is announced with the
//! `session-exit` event.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use noren_core::{
    ACTIONS_FILE_PATH, BackgroundStore, CONFIG_FILE_NAME, ConfigStore, ConfigWatcher, GitHead,
    MODS_DIR_NAME, ModFile, ModStore, ModWatcher, Profile, ProfileSet, SCROLLBACK_DIR_NAME,
    ScrollbackStore, SessionEvent, SessionId, SessionManager, SpawnSpec, StateStore,
    THEMES_DIR_NAME, ThemeStore, UserProfile, WindowEffect, detect_system_profiles, read_head,
    read_project_file, run_short,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::route::OutputRoute;

/// File name of the workspace state inside the app data folder.
pub const STATE_FILE_NAME: &str = "state.json";

/// Where the shell integration scripts are inside the app's resource folder (see `bundle.resources`
/// in tauri.conf.json).
pub const INTEGRATION_RESOURCE_DIR: &str = "resources/shell-integration";

/// Name of the event emitted when a session's child ended and all its output was delivered.
pub const SESSION_EXIT_EVENT: &str = "session-exit";

/// State managed by Tauri: every PTY session and the shell profiles: the ones found on this machine,
/// and the ones the user defined (`profiles` of `config.jsonc`), which the interface hands over.
pub struct AppState {
    pub sessions: SessionManager,
    /// The shells found on this machine, detected once.
    detected: ProfileSet,
    /// The detected shells followed by the profiles of the user: what is listed and what starts.
    profiles: RwLock<ProfileSet>,
    /// Where the output of each live session goes, by session id. A route is added when the session
    /// starts and removed when it ends; `session_attach` changes the channel behind it.
    routes: Arc<Mutex<HashMap<u64, Arc<OutputRoute>>>>,
}

/// What a `%NAME%` in a profile of the user is replaced with: the environment of the process.
fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

impl AppState {
    /// Detects the system profiles (once) and starts with no session and no profile of the user.
    pub fn detect() -> Self {
        Self::with_detected(detect_system_profiles())
    }

    /// The same around profiles already known (a test builds its own).
    pub fn with_detected(detected: ProfileSet) -> Self {
        Self {
            sessions: SessionManager::new(),
            profiles: RwLock::new(detected.clone()),
            detected,
            routes: Arc::default(),
        }
    }

    /// The profile `id`, or the default one for `None`.
    pub fn find_profile(&self, id: Option<&str>) -> Result<Profile, String> {
        let profiles = self.profiles.read().unwrap_or_else(|e| e.into_inner());
        match id {
            Some(id) => profiles
                .get(id)
                .cloned()
                .ok_or_else(|| format!("unknown shell profile '{id}'")),
            None => profiles
                .default_profile()
                .cloned()
                .ok_or_else(|| "no shell profile was found on this machine".to_owned()),
        }
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
        profile_dtos(&self.profiles.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Replaces the profiles of the user. The whole list is refused, and the profiles stay as they
    /// were, when one is not valid (an empty program, for one), an id repeats or an id is one of the
    /// shells found on this machine.
    pub fn set_user_profiles(&self, user: &[UserProfile]) -> Result<(), String> {
        let joined = self
            .detected
            .with_user_profiles(user, &process_env)
            .map_err(|e| e.to_string())?;
        *self.profiles.write().unwrap_or_else(|e| e.into_inner()) = joined;
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
}

/// A profile of the user as the interface sends it (an entry of `profiles` in `config.jsonc`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UserProfileDto {
    pub id: String,
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

impl From<UserProfileDto> for UserProfile {
    fn from(dto: UserProfileDto) -> Self {
        Self {
            id: dto.id,
            name: dto.name,
            program: dto.program,
            args: dto.args,
            cwd: dto.cwd,
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
    let profile = state.find_profile(profile_id)?;

    let spec = apply_session_options(
        profile.spawn_spec_with_integration(cols, rows, integration_dir(app).as_deref()),
        cwd,
        env,
    )?;

    // The exit event carries the session id, which exists only after `spawn` returned. The
    // callback waits on this lock for it; a session that ends at once cannot report too early.
    let id_slot: Arc<Mutex<Option<SessionId>>> = Arc::new(Mutex::new(None));
    let mut slot = id_slot.lock().unwrap_or_else(|e| e.into_inner());

    let callback_slot = Arc::clone(&id_slot);
    let route = Arc::new(OutputRoute::new(output));
    let sink = Arc::clone(&route);
    let routes = Arc::clone(&state.routes);
    let app = app.clone();
    let id = state
        .sessions
        .spawn(spec, move |event| match event {
            // A failed send means the page is gone; the session ends with the app.
            SessionEvent::Output(bytes) => sink.send(bytes),
            SessionEvent::Exit(info) => {
                let id = *callback_slot.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(id) = id {
                    routes
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id.0);
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
        })
        .map_err(|e| e.to_string())?;
    // Before the lock is released: the exit callback waits for it, so it cannot remove a route
    // that was not added yet.
    state
        .routes
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.0, route);
    *slot = Some(id);
    Ok((id.0, profile.id.clone()))
}

/// Moves the output of the live session `id` to `output`: what the shell prints from now on goes
/// there and no longer to the channel that had it. The shell is not touched, it is the same process
/// under the same id; this is how a session opened in the quick window is handed to the main one.
/// Fails when no live session has the id.
pub fn attach_session(
    state: &AppState,
    id: u64,
    output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let route = state
        .route(id)
        .ok_or_else(|| format!("unknown session {id}"))?;
    drop(route.replace(output));
    Ok(())
}

/// Takes over the output of a live session that another window started (see [`attach_session`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn session_attach(
    state: State<'_, AppState>,
    id: u64,
    on_output: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    attach_session(&state, id, on_output)
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
    let user: Vec<UserProfile> = profiles.into_iter().map(UserProfile::from).collect();
    state.set_user_profiles(&user)
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
    on_output: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    create_session(
        &app,
        &state,
        profile_id.as_deref(),
        cwd.as_deref(),
        env,
        cols,
        rows,
        on_output,
    )
    .map(|(id, _)| id)
}

/// Builds the store for `state.json` inside the app data folder. Only resolves the path: the
/// folder is created on the first save.
pub fn state_store(app: &AppHandle) -> Result<StateStore, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not find the app data folder: {e}"))?;
    Ok(StateStore::new(dir.join(STATE_FILE_NAME)))
}

/// Reads `state.json` as text; `None` when there is no file yet. Bytes that are not valid UTF-8
/// are replaced, so a damaged file still reaches the interface, fails to parse there and goes to
/// `state_quarantine` (which copies the original bytes, not this text).
#[tauri::command]
pub async fn state_load(store: State<'_, StateStore>) -> Result<Option<String>, String> {
    store
        .load()
        .map(|bytes| bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
        .map_err(|e| e.to_string())
}

/// Replaces `state.json` atomically with `content`.
#[tauri::command]
pub async fn state_save(store: State<'_, StateStore>, content: String) -> Result<(), String> {
    store.save(content.as_bytes()).map_err(|e| e.to_string())
}

/// Copies `state.json` to `state.broken-<UTC date and time>.json` next to it, leaves the
/// original in place and returns the path of the copy.
#[tauri::command]
pub async fn state_quarantine(store: State<'_, StateStore>) -> Result<String, String> {
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

/// Gives the window the effect named `effect` (`none`, `mica`, `acrylic` or `vibrancy`), painted in
/// the look `scheme` names (`dark` or `light`: the kind of a theme that was chosen; `system`: the
/// mode of the system), and answers what it has: a system that cannot paint it keeps the window
/// opaque and the answer says why. The outcome goes to the log.
#[tauri::command]
pub async fn window_effect_set<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
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
    state
        .sessions
        .kill(SessionId(id))
        .map_err(|e| e.to_string())
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
                is_default: false
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
            UserProfile::from(dto),
            UserProfile {
                id: "dev-shell".into(),
                name: "Dev".into(),
                program: "pwsh.exe".into(),
                args: vec!["-NoLogo".into()],
                cwd: Some("C:\\work".into()),
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
                    is_default: false
                },
                ProfileDto {
                    id: "cmd".into(),
                    name: "Command Prompt".into(),
                    is_default: true
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
                fonts_list_monospace,
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
            ..profile_running("powershell.exe")
        }
    }
    #[cfg(not(windows))]
    fn shell_profile() -> Profile {
        Profile {
            inject_integration: false,
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
        }
    }

    /// The line that makes the shell print `noren-pid-<its process number>-end`. The shell echoes
    /// what is typed, but that text has `$PID` or `$$` where the number goes, so only the output of
    /// the command has digits there.
    #[cfg(windows)]
    const PID_COMMAND: &[u8] = b"Write-Output \"noren-pid-$PID-end\"\r";
    #[cfg(not(windows))]
    const PID_COMMAND: &[u8] = b"echo \"noren-pid-$$-end\"\n";

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
        let state = state_with_shell();
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
        attach_session(&state, id, new).expect("attach");
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
        let refusal = attach_session(&state, id, late).expect_err("the session is gone");
        assert!(refusal.contains("unknown session"), "{refusal}");
        assert!(received(&in_late).is_empty());
    }

    #[test]
    fn a_session_that_never_existed_cannot_be_taken_over() {
        let state = state_with_shell();
        let (channel, _) = collecting();
        let refusal = attach_session(&state, 99, channel).expect_err("no such session");
        assert_eq!(refusal, "unknown session 99");
    }
}

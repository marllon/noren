//! Tauri commands on top of the `noren-core` session manager and shell profiles.
//!
//! Terminal output goes to the interface through a `tauri::ipc::Channel` as raw bytes
//! (`InvokeResponseBody::Raw`), never as JSON; the end of a session is announced with the
//! `session-exit` event.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use noren_core::{
    ACTIONS_FILE_PATH, CONFIG_FILE_NAME, ConfigStore, ConfigWatcher, GitHead, ProfileSet,
    SessionEvent, SessionId, SessionManager, SpawnSpec, StateStore, THEMES_DIR_NAME, ThemeStore,
    detect_system_profiles, read_head, read_project_file, run_short,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

/// File name of the workspace state inside the app data folder.
pub const STATE_FILE_NAME: &str = "state.json";

/// Where the shell integration scripts are inside the app's resource folder (see `bundle.resources`
/// in tauri.conf.json).
pub const INTEGRATION_RESOURCE_DIR: &str = "resources/shell-integration";

/// Name of the event emitted when a session's child ended and all its output was delivered.
pub const SESSION_EXIT_EVENT: &str = "session-exit";

/// State managed by Tauri: every PTY session and the shell profiles found on this machine.
pub struct AppState {
    pub sessions: SessionManager,
    pub profiles: ProfileSet,
}

impl AppState {
    /// Detects the system profiles (once) and starts with no session.
    pub fn detect() -> Self {
        Self {
            sessions: SessionManager::new(),
            profiles: detect_system_profiles(),
        }
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
/// silently opens somewhere else (or fails to start).
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
pub fn integration_dir(app: &AppHandle) -> Option<PathBuf> {
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
/// `cwd` and `env` are optional (see [`apply_session_options`]).
///
/// Shared by the `session_create` command and by `--smoke`, so the smoke test exercises the
/// same path the interface uses.
#[allow(clippy::too_many_arguments)]
pub fn create_session(
    app: &AppHandle,
    state: &AppState,
    profile_id: Option<&str>,
    cwd: Option<&str>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
) -> Result<(u64, String), String> {
    let profile = match profile_id {
        Some(id) => state
            .profiles
            .get(id)
            .ok_or_else(|| format!("unknown shell profile '{id}'"))?,
        None => state
            .profiles
            .default_profile()
            .ok_or_else(|| "no shell profile was found on this machine".to_owned())?,
    };

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
    let app = app.clone();
    let id = state
        .sessions
        .spawn(spec, move |event| match event {
            SessionEvent::Output(bytes) => {
                // A failed send means the interface is gone; the session ends with the app.
                let _ = output.send(InvokeResponseBody::Raw(bytes.to_vec()));
            }
            SessionEvent::Exit(info) => {
                let id = *callback_slot.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(id) = id {
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
    *slot = Some(id);
    Ok((id.0, profile.id.clone()))
}

#[tauri::command]
pub fn profiles_list(state: State<'_, AppState>) -> Vec<ProfileDto> {
    profile_dtos(&state.profiles)
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
            inject_integration: true,
        }
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
    fn write_data_converts_text_and_bytes() {
        assert_eq!(WriteData::Text("é\r".into()).into_bytes(), b"\xc3\xa9\r");
        assert_eq!(WriteData::Bytes(vec![3, 4]).into_bytes(), vec![3, 4]);
    }
}

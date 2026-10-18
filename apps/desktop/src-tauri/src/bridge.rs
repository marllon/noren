//! Tauri commands on top of the `noren-core` session manager and shell profiles.
//!
//! Terminal output goes to the interface through a `tauri::ipc::Channel` as raw bytes
//! (`InvokeResponseBody::Raw`), never as JSON; the end of a session is announced with the
//! `session-exit` event.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use noren_core::{
    ProfileSet, SessionEvent, SessionId, SessionManager, SpawnSpec, StateStore,
    detect_system_profiles,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

/// File name of the workspace state inside the app data folder.
pub const STATE_FILE_NAME: &str = "state.json";

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

    let spec = apply_session_options(profile.spawn_spec(cols, rows), cwd, env)?;

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
    fn write_data_converts_text_and_bytes() {
        assert_eq!(WriteData::Text("é\r".into()).into_bytes(), b"\xc3\xa9\r");
        assert_eq!(WriteData::Bytes(vec![3, 4]).into_bytes(), vec![3, 4]);
    }
}

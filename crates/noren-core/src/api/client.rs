//! The client of the local API: what a program on this machine (the `noren-cli` command, a
//! script) uses to reach a running Noren. It finds the endpoint and the token file the app
//! uses, reads the token **each time it connects** (a new data folder or a damaged file gives a
//! new one), authenticates, and makes calls one at a time, getting the `result` or the error.
//!
//! No Tauri here, and no window: only the pipe or socket, the token file and the frames of
//! [`protocol`](super::protocol).
//!
//! ## Where the app keeps its token
//!
//! `<data folder of the app>/api/token`. The data folder is the one Tauri gives the app for its
//! identifier ([`APP_IDENTIFIER`], the same as `tauri.conf.json`; a test keeps them equal):
//! `%APPDATA%\<identifier>` on Windows, `~/Library/Application Support/<identifier>` on macOS,
//! `$XDG_DATA_HOME/<identifier>` or `~/.local/share/<identifier>` elsewhere. [`token_file_in`]
//! is the one rule for the app and for the clients.

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::protocol::{API_PROTOCOL_VERSION, ApiMethod};
use super::{DEFAULT_API_NAME, api_endpoint, token};
use crate::daemon::frame::{FrameError, read_frame, write_frame};
use crate::daemon::ipc::{self, ClientStream, Endpoint};

/// The identifier of the app (`identifier` in `tauri.conf.json`), the name of its data folder.
pub const APP_IDENTIFIER: &str = "io.github.marllon.noren";
/// The folder of the token file inside the data folder of the app.
pub const API_DIR_NAME: &str = "api";
/// The name of the token file.
pub const TOKEN_FILE_NAME: &str = "token";

/// Longest the connection and the authentication may take together.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest one call may take: the server gives up on a call at 30 s and says so.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(40);

/// The token file inside `data_dir`, the data folder of the app: `<data_dir>/api/token`.
pub fn token_file_in(data_dir: &Path) -> PathBuf {
    data_dir.join(API_DIR_NAME).join(TOKEN_FILE_NAME)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Os {
    Windows,
    Macos,
    Other,
}

impl Os {
    const CURRENT: Os = if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Macos
    } else {
        Os::Other
    };
}

/// The data folder of the app on this machine, as Tauri's `app_data_dir` gives it; `None` when
/// the environment does not say where the user's folders are.
pub fn app_data_dir() -> Option<PathBuf> {
    data_dir_for(Os::CURRENT, |name| std::env::var_os(name))
}

fn data_dir_for(os: Os, get: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |name: &str| {
        get(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let base = match os {
        Os::Windows => set("APPDATA")
            .or_else(|| set("USERPROFILE").map(|home| home.join("AppData").join("Roaming")))?,
        Os::Macos => set("HOME")?.join("Library").join("Application Support"),
        Os::Other => set("XDG_DATA_HOME")
            .filter(|dir| dir.is_absolute())
            .or_else(|| set("HOME").map(|home| home.join(".local").join("share")))?,
    };
    Some(base.join(APP_IDENTIFIER))
}

/// The token file of a normal installation (see [`app_data_dir`]).
pub fn default_token_file() -> Result<PathBuf, ClientError> {
    app_data_dir()
        .map(|dir| token_file_in(&dir))
        .ok_or(ClientError::NoDataFolder)
}

/// Where to reach a Noren: its endpoint and the file that holds its token.
#[derive(Debug, Clone)]
pub struct ApiTarget {
    pub endpoint: Endpoint,
    pub token_file: PathBuf,
}

impl ApiTarget {
    /// The endpoint and the token file of a normal installation.
    pub fn standard() -> Result<Self, ClientError> {
        Self::named(DEFAULT_API_NAME, default_token_file()?)
    }

    /// The API called `name` (`api-<name>`, see [`api_endpoint`]) and a token file of your choice.
    pub fn named(name: &str, token_file: PathBuf) -> Result<Self, ClientError> {
        let endpoint = api_endpoint(name).map_err(|e| ClientError::BadEndpoint {
            name: name.to_owned(),
            reason: e.to_string(),
        })?;
        Ok(Self {
            endpoint,
            token_file,
        })
    }
}

/// Why a call did not come back with a result.
#[derive(Debug)]
pub enum ClientError {
    /// The environment does not say where the data folder of the user is.
    NoDataFolder,
    /// The name of the endpoint is not allowed.
    BadEndpoint { name: String, reason: String },
    /// Nothing listens on the endpoint: Noren is not running (or runs without the API).
    NotRunning,
    /// There is no token file. Noren makes it the first time it starts.
    TokenMissing(PathBuf),
    /// The token file cannot be used: it does not hold a token, or it cannot be read.
    TokenUnusable { path: PathBuf, reason: String },
    /// The endpoint exists but could not be opened (another user's, no permission...).
    Connect(io::Error),
    /// The connection broke.
    Io(io::Error),
    /// The connection closed before the answer.
    Closed,
    /// The server did not answer in time.
    Timeout,
    /// The server said something that is not the protocol.
    Protocol(String),
    /// The server answered with an error: the `code` and the sentence it sent. The refusal of a
    /// wrong token is one of these (`unauthorized`).
    Api { code: String, message: String },
}

impl ClientError {
    /// The code of an error the server sent, when this is one.
    pub fn api_code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code),
            _ => None,
        }
    }

    /// Whether Noren could not be reached at all (as opposed to reached and said no): not
    /// running, no or bad token, or a token it refused.
    pub fn is_unreachable(&self) -> bool {
        match self {
            Self::NoDataFolder
            | Self::BadEndpoint { .. }
            | Self::NotRunning
            | Self::TokenMissing(_)
            | Self::TokenUnusable { .. }
            | Self::Connect(_)
            | Self::Io(_)
            | Self::Closed
            | Self::Timeout
            | Self::Protocol(_) => true,
            Self::Api { code, .. } => {
                matches!(
                    code.as_str(),
                    "unauthorized" | "unauthenticated" | "unsupported_version"
                )
            }
        }
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDataFolder => write!(
                f,
                "cannot tell where the Noren data folder is (set NOREN_API_TOKEN_FILE to the token file)"
            ),
            Self::BadEndpoint { name, reason } => {
                write!(f, "the endpoint name {name:?} is not allowed: {reason}")
            }
            Self::NotRunning => write!(f, "Noren is not running (nothing listens on its API)"),
            Self::TokenMissing(path) => write!(
                f,
                "there is no API token at {}; Noren makes it when it starts",
                path.display()
            ),
            Self::TokenUnusable { path, reason } => {
                write!(
                    f,
                    "the API token file {} cannot be used: {reason}",
                    path.display()
                )
            }
            Self::Connect(e) => write!(f, "could not open the Noren API: {e}"),
            Self::Io(e) => write!(f, "the connection to Noren broke: {e}"),
            Self::Closed => write!(f, "Noren closed the connection"),
            Self::Timeout => write!(f, "Noren did not answer in time"),
            Self::Protocol(what) => write!(f, "Noren said something unexpected: {what}"),
            Self::Api { code, message } => write!(f, "{code}: {message}"),
        }
    }
}

impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Connect(e) | Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<FrameError> for ClientError {
    fn from(error: FrameError) -> Self {
        match error {
            FrameError::Closed => Self::Closed,
            FrameError::Io(e) => Self::Io(e),
            FrameError::Protocol(e) => Self::Protocol(e.to_string()),
        }
    }
}

/// An authenticated connection to the API. Calls go one at a time; drop it to disconnect.
pub struct ApiClient {
    stream: ClientStream,
    next_id: u64,
}

impl ApiClient {
    /// Reads the token file, connects to the endpoint and authenticates. Each call to this reads
    /// the file again.
    pub async fn connect(target: &ApiTarget) -> Result<Self, ClientError> {
        let token = token::read_token(&target.token_file).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => ClientError::TokenMissing(target.token_file.clone()),
            _ => ClientError::TokenUnusable {
                path: target.token_file.clone(),
                reason: e.to_string(),
            },
        })?;
        match tokio::time::timeout(CONNECT_TIMEOUT, Self::open(target, &token.to_hex())).await {
            Ok(result) => result,
            Err(_) => Err(ClientError::Timeout),
        }
    }

    async fn open(target: &ApiTarget, token_hex: &str) -> Result<Self, ClientError> {
        let stream = ipc::connect(&target.endpoint)
            .await
            .map_err(|e| match e.kind() {
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => {
                    ClientError::NotRunning
                }
                _ => ClientError::Connect(e),
            })?;
        let mut client = Self { stream, next_id: 0 };
        let auth = json!({
            "type": "auth",
            "version": API_PROTOCOL_VERSION,
            "token": token_hex,
        });
        client.send(&auth).await?;
        let welcome = client.read_value().await?;
        if let Some(error) = api_error_of(&welcome) {
            return Err(error);
        }
        if welcome.get("type").and_then(Value::as_str) != Some("welcome") {
            return Err(ClientError::Protocol("no welcome after the token".into()));
        }
        Ok(client)
    }

    /// Calls `method` and returns its `result`. An error answer is [`ClientError::Api`].
    pub async fn call(&mut self, method: ApiMethod, params: Value) -> Result<Value, ClientError> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "id": id, "method": method.name(), "params": params }))
            .await?;
        match tokio::time::timeout(REQUEST_TIMEOUT, self.read_answer(id)).await {
            Ok(result) => result,
            Err(_) => Err(ClientError::Timeout),
        }
    }

    async fn read_answer(&mut self, id: u64) -> Result<Value, ClientError> {
        loop {
            let mut answer = self.read_value().await?;
            // A frame with an `event` is a push for a subscriber; this client asks for none.
            if answer.get("event").is_some() {
                continue;
            }
            match answer.get("id") {
                Some(Value::Null) => {
                    return Err(api_error_of(&answer).unwrap_or_else(|| {
                        ClientError::Protocol("an answer without an id".into())
                    }));
                }
                Some(got) if got.as_u64() == Some(id) => {}
                _ => return Err(ClientError::Protocol("an answer for another call".into())),
            }
            if let Some(error) = api_error_of(&answer) {
                return Err(error);
            }
            return answer
                .get_mut("result")
                .map(Value::take)
                .ok_or_else(|| ClientError::Protocol("an answer with no result".into()));
        }
    }

    async fn send(&mut self, message: &Value) -> Result<(), ClientError> {
        let frame = super::protocol::to_frame(message.to_string().as_bytes())
            .map_err(|e| ClientError::Protocol(e.to_string()))?;
        write_frame(&mut self.stream, &frame)
            .await
            .map_err(ClientError::Io)
    }

    async fn read_value(&mut self) -> Result<Value, ClientError> {
        let payload = read_frame(&mut self.stream).await?;
        serde_json::from_slice(&payload)
            .map_err(|e| ClientError::Protocol(format!("not JSON: {e}")))
    }
}

/// The error an answer carries, if it carries one.
fn api_error_of(answer: &Value) -> Option<ClientError> {
    let error = answer.get("error")?;
    let text = |key: &str| {
        error
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_owned()
    };
    Some(ClientError::Api {
        code: text("code"),
        message: text("message"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(*value))
        }
    }

    #[test]
    fn the_token_file_is_api_token_inside_the_data_folder() {
        assert_eq!(
            token_file_in(Path::new("data")),
            Path::new("data").join("api").join("token")
        );
    }

    #[test]
    fn the_data_folder_follows_the_rule_of_each_system() {
        let windows = data_dir_for(
            Os::Windows,
            env(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming")]),
        );
        assert_eq!(
            windows,
            Some(PathBuf::from("C:\\Users\\a\\AppData\\Roaming").join(APP_IDENTIFIER))
        );
        let windows_without = data_dir_for(Os::Windows, env(&[("USERPROFILE", "C:\\Users\\a")]));
        assert_eq!(
            windows_without,
            Some(
                PathBuf::from("C:\\Users\\a")
                    .join("AppData")
                    .join("Roaming")
                    .join(APP_IDENTIFIER)
            )
        );
        let mac = data_dir_for(Os::Macos, env(&[("HOME", "/Users/a")]));
        assert_eq!(
            mac,
            Some(
                PathBuf::from("/Users/a")
                    .join("Library")
                    .join("Application Support")
                    .join(APP_IDENTIFIER)
            )
        );
        let home = data_dir_for(Os::Other, env(&[("HOME", "/home/a")]));
        assert_eq!(
            home,
            Some(
                PathBuf::from("/home/a")
                    .join(".local")
                    .join("share")
                    .join(APP_IDENTIFIER)
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn xdg_data_home_wins_when_it_is_an_absolute_path() {
        let set = data_dir_for(
            Os::Other,
            env(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/a")]),
        );
        assert_eq!(set, Some(PathBuf::from("/data").join(APP_IDENTIFIER)));
        let relative = data_dir_for(
            Os::Other,
            env(&[("XDG_DATA_HOME", "data"), ("HOME", "/home/a")]),
        );
        assert_eq!(
            relative,
            Some(
                PathBuf::from("/home/a")
                    .join(".local")
                    .join("share")
                    .join(APP_IDENTIFIER)
            )
        );
    }

    #[test]
    fn no_environment_means_no_data_folder() {
        for os in [Os::Windows, Os::Macos, Os::Other] {
            assert_eq!(data_dir_for(os, env(&[])), None);
            assert_eq!(
                data_dir_for(os, env(&[("HOME", ""), ("APPDATA", "")])),
                None
            );
        }
    }

    #[test]
    fn the_identifier_is_the_one_of_the_app() {
        let conf = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop/src-tauri/tauri.conf.json"),
        )
        .expect("tauri.conf.json");
        let conf: Value = serde_json::from_str(&conf).expect("JSON");
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn only_a_server_that_could_not_be_reached_or_refused_the_token_is_unreachable() {
        let api = |code: &str| ClientError::Api {
            code: code.into(),
            message: String::new(),
        };
        assert!(ClientError::NotRunning.is_unreachable());
        assert!(ClientError::TokenMissing(PathBuf::from("t")).is_unreachable());
        assert!(api("unauthorized").is_unreachable());
        assert!(!api("not_found").is_unreachable());
        assert!(!api("invalid_params").is_unreachable());
        assert!(!api("failed").is_unreachable());
    }
}

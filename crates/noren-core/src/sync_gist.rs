//! Sync of the settings through a GitHub Gist of the user (NOR-F19-02a), the other way to carry
//! the same files [`crate::sync`] carries through git: the config, the themes, the mods and the
//! spaces of this computer go to one secret gist the person owns, and come back on another
//! computer. No Tauri dependency, and no screen: the screen is NOR-F19-02b.
//!
//! **What travels** is exactly the closed list of [`crate::sync::is_syncable`] (`config.jsonc`,
//! `themes/<id>.json`, `mods/<name>.css`, `spaces/<name>.noren-space.json`); `state.json`, the
//! scrollback, `gallery.json`, `plugins/`, the record of the spaces ([`crate::sync_spaces`]), the
//! record of this module and any stray file never do, and a file of the gist that is not on the
//! list is never read into the config folder. The API keys live in the keychain and never in
//! these files.
//!
//! **File names.** A gist has no folders, so a path is sent as one flat name: the first `/` becomes
//! `--` (`themes/x.json` is `themes--x.json`, `config.jsonc` stays as it is). The mapping is one to
//! one: [`path_of_gist_file`] accepts a name only when it maps back to a path of the closed list
//! *and* that path maps to exactly that name, so a name made to look like a path
//! (`themes--../x.json`) or a file someone else put in the gist is ignored. A gist cannot hold an
//! empty file, so an empty file of the config folder is left out, as if it were not there.
//!
//! **The token** is a personal access token of GitHub with the gist permission. It lives in the
//! keychain of the system, behind [`KeyVault`], under a name no AI provider can have
//! ([`SYNC_GIST_TOKEN_ENTRY`]). It is checked before it is stored, it is sent only as the
//! `Authorization` header of a request to the fixed address of the API, it is never returned by
//! any function of this module (the status only says whether there is one), and no error text
//! carries it: a message the server sends back has the token taken out of it.
//!
//! **The address** is [`GIST_API_BASE`], fixed. A test may point at `http://127.0.0.1:<port>`
//! and at nothing else. Every request has a deadline, a ceiling on the bytes read, follows no
//! redirect and asks nothing of the person.
//!
//! **The local record** is `sync-gist.json` next to `config.jsonc`: the id of the gist, whether it
//! is public, and the sha256 of each file as the gist held it when this computer last synced. It
//! is not on the closed list, so it never travels. A record that cannot be read is an error, never
//! an empty record (an empty one would make every file of the gist look new).
//!
//! **The steps**, one at a time ([`GistSync`] holds a turn):
//!
//! - **connect** with an id reads that gist (nothing is copied yet: the record starts empty, so the
//!   first pull brings its files); with no id it creates a secret gist from the files of this
//!   computer, the way a first push does.
//! - **status** has no network: whether there is a token, the gist, and the files whose bytes
//!   differ from the record (what a push would carry).
//! - **push** reads the gist first and refuses ([`GistError::Changed`]) when any file of it is not
//!   as this computer last saw it: pull, then push again. Only then are the files that changed
//!   here sent, in one request. The check and the request are two calls, and the API has no
//!   conditional update, so a change that lands between them is not seen.
//! - **pull** reads the gist and, file by file against the record: a file the gist did not change is
//!   left alone (a local edit stays pending); one it changed is written when this computer did not
//!   change it, and is a conflict when both changed to different bytes. On any conflict nothing is
//!   written and the record is not touched ([`PullOutcome::Conflicts`]); only a clean pull writes
//!   files and moves the record.
//! - **Nothing is deleted.** A file removed on one side is not removed on the other.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{Map, Value, json};

use crate::gallery::{describe, sha256_hex};
use crate::mods::MODS_DIR_NAME;
use crate::sync::{
    ChangeKind, MAX_SYNC_FILE_BYTES, MAX_SYNC_FILES, PendingChange, PullOutcome, PushOutcome,
    SPACES_DIR_NAME, SyncError, is_syncable, syncable_files_in, write_bytes,
};
use crate::themes::THEMES_DIR_NAME;
use crate::vault::{KeyVault, MAX_KEY_CHARS, SYNC_GIST_TOKEN_ENTRY, VaultError};

/// Where the API of GitHub is. The only address a real run talks to.
pub const GIST_API_BASE: &str = "https://api.github.com";

/// The record of this module, in the config folder (not on the closed list).
pub const GIST_STATE_FILE_NAME: &str = "sync-gist.json";

/// How long one request may take, from the connection to the last byte of the answer.
pub const GIST_TIMEOUT: Duration = Duration::from_secs(30);

/// The most bytes read from one answer of the API (a gist of 500 files of 1 MiB would be larger,
/// and is not a gist of settings).
pub const MAX_GIST_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

/// The most bytes of file content one request sends.
pub const MAX_GIST_PAYLOAD_BYTES: u64 = 8 * 1024 * 1024;

/// The most bytes read from the answer to a request that failed (only its message is used).
const MAX_ERROR_BODY_BYTES: u64 = 64 * 1024;

/// The longest message of the API kept in an error, in characters.
const MAX_MESSAGE_CHARS: usize = 200;

/// The longest id of a gist, in characters (real ones have 20 or 32).
const MAX_GIST_ID_CHARS: usize = 64;

/// The most bytes the record may hold.
const MAX_STATE_BYTES: u64 = 512 * 1024;

/// The version of the record this build writes and reads.
const STATE_VERSION: u64 = 1;

/// The version of the API the requests ask for.
const API_VERSION: &str = "2022-11-28";

/// The description of the gist this module creates.
const GIST_DESCRIPTION: &str = "Noren settings (sync)";

/// The text that stands for the token in a message.
const HIDDEN_TOKEN: &str = "[token]";

/// What separates the folder from the name in a flat gist file name.
const FOLDER_SEPARATOR: &str = "--";

/// The folders of the closed list.
const FOLDERS: [&str; 3] = [THEMES_DIR_NAME, MODS_DIR_NAME, SPACES_DIR_NAME];

/// Why a step of the sync through a gist did not happen. None of the texts holds the token.
#[derive(Debug)]
pub enum GistError {
    /// No gist is connected yet: connect first.
    NotConnected,
    /// There is no token in the keychain: store one first.
    NoToken,
    /// The text is not usable as a token; the sentence says why.
    InvalidToken(String),
    /// The text is not the id of a gist.
    InvalidGistId,
    /// The base address is not one this module talks to.
    InsecureAddress(String),
    /// The keychain of the system said no.
    Vault(VaultError),
    /// The API could not be reached.
    Network(String),
    /// The request took longer than the deadline.
    Timeout,
    /// The API answered with this status (a redirect included); the message is the one it sent.
    Http { status: u16, message: String },
    /// An answer is larger than this many bytes.
    TooLarge(u64),
    /// The answer is not a gist as the API describes one.
    BadResponse(String),
    /// The gist lists more files than the API returns, or has too many to sync.
    Truncated,
    /// The gist has changes this computer does not have (the paths): pull, then push again.
    Changed(Vec<String>),
    /// There is nothing to send: a gist cannot be made without a file.
    NothingToSend,
    /// A file of the config folder is not UTF-8 text, which is all a gist holds.
    NotText(String),
    /// The record of this module cannot be read.
    Record(String),
    /// A file or folder of the config folder could not be read or written, or a file is over the
    /// ceiling of the sync.
    Local(SyncError),
}

impl fmt::Display for GistError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConnected => f.write_str("no gist is connected yet: connect to one first"),
            Self::NoToken => f.write_str(
                "no GitHub token is stored on this computer: save one first (it needs the gist permission)",
            ),
            Self::InvalidToken(reason) => write!(f, "this is not a usable token: {reason}"),
            Self::InvalidGistId => {
                f.write_str("this is not the id of a gist: use the letters and digits after the last / of its address")
            }
            Self::InsecureAddress(address) => {
                write!(f, "'{address}' is not an address the gist sync talks to")
            }
            Self::Vault(error) => write!(f, "{error}"),
            Self::Network(reason) => write!(f, "could not reach GitHub: {reason}"),
            Self::Timeout => write!(
                f,
                "GitHub took more than {} seconds to answer",
                GIST_TIMEOUT.as_secs()
            ),
            Self::Http { status, message } => {
                let hint = match status {
                    401 => " (the token was refused: check that it is right and has not expired)",
                    403 | 429 => " (not allowed, or the rate limit was reached)",
                    404 => " (there is no such gist, or the token cannot see it)",
                    422 => " (GitHub refused what was sent)",
                    _ => "",
                };
                if message.is_empty() {
                    write!(f, "GitHub answered with status {status}{hint}")
                } else {
                    write!(f, "GitHub answered with status {status}{hint}: {message}")
                }
            }
            Self::TooLarge(limit) => write!(f, "the answer is larger than {limit} bytes"),
            Self::BadResponse(reason) => write!(f, "GitHub answered with something that is not a gist: {reason}"),
            Self::Truncated => f.write_str("the gist has more files than a sync carries"),
            Self::Changed(paths) => {
                let shown: Vec<&str> = paths.iter().take(5).map(String::as_str).collect();
                let more = paths.len().saturating_sub(shown.len());
                write!(
                    f,
                    "the gist has changes this computer does not have: pull first, then push again ({}{})",
                    shown.join(", "),
                    if more > 0 { format!(" and {more} more") } else { String::new() }
                )
            }
            Self::NothingToSend => f.write_str(
                "there is nothing to send yet: a gist cannot be made without a file, and the config folder has none that may travel",
            ),
            Self::NotText(path) => write!(f, "{path} is not UTF-8 text and a gist cannot hold it"),
            Self::Record(reason) => write!(f, "{reason}"),
            Self::Local(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for GistError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Vault(error) => Some(error),
            Self::Local(error) => Some(error),
            _ => None,
        }
    }
}

impl From<SyncError> for GistError {
    fn from(error: SyncError) -> Self {
        Self::Local(error)
    }
}

impl From<VaultError> for GistError {
    fn from(error: VaultError) -> Self {
        Self::Vault(error)
    }
}

/// Where the sync through a gist stands, without any network.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GistStatus {
    /// A gist is connected.
    pub connected: bool,
    /// The id of the gist, when connected.
    pub gist_id: Option<String>,
    /// The gist was public when this computer last read it: anyone can read the settings in it.
    pub public: bool,
    /// A token is stored in the keychain (the token itself is never given).
    pub has_token: bool,
    /// Files of the config folder whose bytes differ from the gist as last synced, in path order.
    pub pending: Vec<PendingChange>,
}

/// Whether `id` can be the id of a gist: 1 to 64 ASCII letters or digits (so it is safe in the
/// address of a request).
pub fn is_valid_gist_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_GIST_ID_CHARS && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The flat file name a gist holds `path` as, when `path` is on the closed list: the first `/`
/// becomes `--`. `None` for any other path.
pub fn gist_file_name(path: &str) -> Option<String> {
    is_syncable(path).then(|| path.replacen('/', FOLDER_SEPARATOR, 1))
}

/// The path of the config folder a gist file name stands for, when it stands for one: the name
/// must map to a path of the closed list that maps back to exactly that name. `None` for any other
/// name (a file someone else put in the gist, a name made to look like a path).
pub fn path_of_gist_file(name: &str) -> Option<String> {
    let path = FOLDERS
        .iter()
        .find_map(|folder| {
            name.strip_prefix(*folder)
                .and_then(|rest| rest.strip_prefix(FOLDER_SEPARATOR))
                .map(|rest| format!("{folder}/{rest}"))
        })
        .unwrap_or_else(|| name.to_owned());
    (gist_file_name(&path).as_deref() == Some(name)).then_some(path)
}

/// Whether `address` is the base address of the API, or (with `allow_local_http`, a test) a plain
/// `http` address of `127.0.0.1` with a port and nothing else.
fn is_api_base(address: &str, allow_local_http: bool) -> bool {
    address == GIST_API_BASE
        || (allow_local_http
            && address
                .strip_prefix("http://127.0.0.1:")
                .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())))
}

/// Why `token` cannot be a token, or `None` when it can. A token is one run of visible ASCII
/// (GitHub tokens are letters, digits and `_`), which also keeps it a valid header value.
fn token_problem(token: &str) -> Option<&'static str> {
    if token.is_empty() {
        return Some("it is empty");
    }
    if token.chars().count() > MAX_KEY_CHARS {
        return Some("it is too long");
    }
    if !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Some("it has a space or a character that a token does not have");
    }
    None
}

/// `text` with the token taken out.
fn scrub(text: &str, token: &str) -> String {
    if token.is_empty() {
        text.to_owned()
    } else {
        text.replace(token, HIDDEN_TOKEN)
    }
}

/// The `message` an error answer of the API carries, cleaned: no token, no control character, at
/// most [`MAX_MESSAGE_CHARS`] characters. Empty when the answer has none.
fn api_message(body: &[u8], token: &str) -> String {
    let Ok(Value::Object(root)) = serde_json::from_slice::<Value>(body) else {
        return String::new();
    };
    let Some(Value::String(message)) = root.get("message") else {
        return String::new();
    };
    scrub(message, token)
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_MESSAGE_CHARS)
        .collect()
}

/// What the gist held, as the record keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    gist_id: String,
    public: bool,
    /// Path to the sha256 of the file in the gist when this computer last synced.
    files: BTreeMap<String, String>,
}

/// A gist as the API describes it, reduced to what the sync uses.
#[derive(Debug)]
struct RemoteGist {
    id: String,
    public: bool,
    /// The files of the closed list, by path, with their bytes. Anything else is left out.
    files: BTreeMap<String, Vec<u8>>,
}

impl RemoteGist {
    fn hashes(&self) -> BTreeMap<String, String> {
        self.files
            .iter()
            .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
            .collect()
    }
}

/// The files a request sends: the JSON for the API, and the hash of each file by path.
struct Payload {
    files: Map<String, Value>,
    sent: BTreeMap<String, String>,
}

/// The paths where `known` and `now` differ (a path in only one of them included), in order.
fn differing(known: &BTreeMap<String, String>, now: &BTreeMap<String, String>) -> Vec<String> {
    let paths: BTreeSet<&String> = known.keys().chain(now.keys()).collect();
    paths
        .into_iter()
        .filter(|path| known.get(*path) != now.get(*path))
        .cloned()
        .collect()
}

/// Reads an answer of the API into the files of the closed list it holds. A name that does not map
/// to a path of the list is ignored; a file the API cut short or an empty one is not a file to
/// sync.
fn parse_gist(value: &Value) -> Result<RemoteGist, GistError> {
    let bad = |reason: &str| GistError::BadResponse(reason.to_owned());
    let Value::Object(root) = value else {
        return Err(bad("it is not an object"));
    };
    let id = root
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_valid_gist_id(id))
        .ok_or_else(|| bad("it has no valid id"))?;
    if root.get("truncated").and_then(Value::as_bool) == Some(true) {
        return Err(GistError::Truncated);
    }
    let Some(Value::Object(listed)) = root.get("files") else {
        return Err(bad("it has no list of files"));
    };
    let mut files = BTreeMap::new();
    for (name, entry) in listed {
        let Some(path) = path_of_gist_file(name) else {
            continue;
        };
        let Value::Object(entry) = entry else {
            return Err(bad("a file is not an object"));
        };
        if entry.get("truncated").and_then(Value::as_bool) == Some(true) {
            return Err(GistError::Local(SyncError::FileTooLarge(path)));
        }
        let Some(Value::String(content)) = entry.get("content") else {
            return Err(bad("a file has no content"));
        };
        if content.len() as u64 > MAX_SYNC_FILE_BYTES {
            return Err(GistError::Local(SyncError::FileTooLarge(path)));
        }
        if content.is_empty() {
            continue;
        }
        files.insert(path, content.as_bytes().to_vec());
    }
    if files.len() > MAX_SYNC_FILES {
        return Err(GistError::Truncated);
    }
    Ok(RemoteGist {
        id: id.to_owned(),
        public: root.get("public").and_then(Value::as_bool).unwrap_or(false),
        files,
    })
}

/// Reads at most `limit` bytes of the body of `response`.
async fn read_body(mut response: reqwest::Response, limit: u64) -> Result<Vec<u8>, GistError> {
    if response.content_length().is_some_and(|n| n > limit) {
        return Err(GistError::TooLarge(limit));
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| GistError::Network(describe(&e)))?
    {
        if (body.len() + chunk.len()) as u64 > limit {
            return Err(GistError::TooLarge(limit));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The sync of one config folder through a gist.
pub struct GistSync {
    config_dir: PathBuf,
    vault: Arc<dyn KeyVault>,
    http: reqwest::Client,
    base: String,
    timeout: Duration,
    max_response: u64,
    /// Held for a whole step: a pull during a push would fight over the record.
    turn: tokio::sync::Mutex<()>,
}

// The vault holds the token and the client holds its headers: neither is printed.
impl fmt::Debug for GistSync {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GistSync")
            .field("config_dir", &self.config_dir)
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl GistSync {
    /// The sync of the config folder `config_dir`, with the token in `vault`, talking to
    /// [`GIST_API_BASE`]. Nothing is made on disk until a gist is connected.
    pub fn new(
        config_dir: impl Into<PathBuf>,
        vault: Arc<dyn KeyVault>,
    ) -> Result<Self, GistError> {
        Self::build(
            config_dir.into(),
            vault,
            GIST_API_BASE,
            false,
            GIST_TIMEOUT,
            MAX_GIST_RESPONSE_BYTES,
        )
    }

    /// A sync that talks to a server on `127.0.0.1` (a test), with its own deadline and ceiling.
    #[cfg(test)]
    fn at(
        config_dir: impl Into<PathBuf>,
        vault: Arc<dyn KeyVault>,
        base: &str,
        timeout: Duration,
        max_response: u64,
    ) -> Result<Self, GistError> {
        Self::build(config_dir.into(), vault, base, true, timeout, max_response)
    }

    fn build(
        config_dir: PathBuf,
        vault: Arc<dyn KeyVault>,
        base: &str,
        allow_local_http: bool,
        timeout: Duration,
        max_response: u64,
    ) -> Result<Self, GistError> {
        if !is_api_base(base, allow_local_http) {
            return Err(GistError::InsecureAddress(base.to_owned()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(timeout)
            // A redirect could leave the API, and the token goes with the request.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("noren/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| GistError::Network(describe(&e)))?;
        Ok(Self {
            config_dir,
            vault,
            http,
            base: base.to_owned(),
            timeout,
            max_response,
            turn: tokio::sync::Mutex::new(()),
        })
    }

    // ---- the token ---------------------------------------------------------------------------

    /// Stores the token in the keychain, replacing the one there. Blanks around it are dropped, as
    /// a paste brings them. The token is checked first and is never part of an error.
    pub fn set_token(&self, token: &str) -> Result<(), GistError> {
        let token = token.trim();
        if let Some(reason) = token_problem(token) {
            return Err(GistError::InvalidToken(reason.to_owned()));
        }
        self.vault.set(SYNC_GIST_TOKEN_ENTRY, token)?;
        Ok(())
    }

    /// Removes the token from the keychain. Having none is not an error.
    pub fn clear_token(&self) -> Result<(), GistError> {
        self.vault.delete(SYNC_GIST_TOKEN_ENTRY)?;
        Ok(())
    }

    fn token(&self) -> Result<String, GistError> {
        self.vault
            .get(SYNC_GIST_TOKEN_ENTRY)?
            .ok_or(GistError::NoToken)
    }

    // ---- the record --------------------------------------------------------------------------

    fn record_path(&self) -> PathBuf {
        self.config_dir.join(GIST_STATE_FILE_NAME)
    }

    /// The record, `None` when none was ever written; one that cannot be read is an error.
    fn load_record(&self) -> Result<Option<Record>, GistError> {
        let path = self.record_path();
        let damaged = |why: &str| {
            GistError::Record(format!(
                "{GIST_STATE_FILE_NAME} cannot be read ({why}): fix or delete it, then connect again"
            ))
        };
        let meta = match fs::metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(GistError::Local(SyncError::Io(error.to_string()))),
        };
        if meta.len() > MAX_STATE_BYTES {
            return Err(damaged("it is too large"));
        }
        let bytes = fs::read(&path).map_err(|e| GistError::Local(SyncError::Io(e.to_string())))?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| damaged("not JSON"))?;
        if value.get("version").and_then(Value::as_u64) != Some(STATE_VERSION) {
            return Err(damaged("another version"));
        }
        let gist_id = value
            .get("gistId")
            .and_then(Value::as_str)
            .filter(|id| is_valid_gist_id(id))
            .ok_or_else(|| damaged("no valid gist id"))?;
        let public = value
            .get("public")
            .and_then(Value::as_bool)
            .ok_or_else(|| damaged("no public flag"))?;
        let entries = value
            .get("files")
            .and_then(Value::as_object)
            .ok_or_else(|| damaged("no list of files"))?;
        let mut files = BTreeMap::new();
        for (path, hash) in entries {
            let hash = hash.as_str().filter(|h| is_sha256_hex(h));
            let Some(hash) = hash else {
                return Err(damaged("an entry is not valid"));
            };
            // A path off the list can never be asked for; it is dropped, not an error.
            if is_syncable(path) {
                files.insert(path.clone(), hash.to_owned());
            }
        }
        Ok(Some(Record {
            gist_id: gist_id.to_owned(),
            public,
            files,
        }))
    }

    fn save_record(&self, record: &Record) -> Result<(), GistError> {
        let files: Map<String, Value> = record
            .files
            .iter()
            .map(|(path, hash)| (path.clone(), Value::String(hash.clone())))
            .collect();
        let value = json!({
            "version": STATE_VERSION,
            "gistId": record.gist_id,
            "public": record.public,
            "files": files,
        });
        let mut text = serde_json::to_string_pretty(&value)
            .map_err(|e| GistError::Local(SyncError::Io(e.to_string())))?;
        text.push('\n');
        write_bytes(&self.record_path(), text.as_bytes())?;
        Ok(())
    }

    fn require_record(&self) -> Result<Record, GistError> {
        self.load_record()?.ok_or(GistError::NotConnected)
    }

    // ---- the files of this computer ----------------------------------------------------------

    /// The bytes of `path` in the config folder, `None` when it is not a plain file or is empty.
    fn read_local(&self, path: &str) -> Result<Option<Vec<u8>>, GistError> {
        let file = self.config_dir.join(path);
        let meta = match fs::symlink_metadata(&file) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(GistError::Local(SyncError::Io(error.to_string()))),
        };
        if !meta.is_file() || meta.len() == 0 {
            return Ok(None);
        }
        if meta.len() > MAX_SYNC_FILE_BYTES {
            return Err(GistError::Local(SyncError::FileTooLarge(path.to_owned())));
        }
        let bytes = fs::read(&file).map_err(|e| GistError::Local(SyncError::Io(e.to_string())))?;
        if bytes.len() as u64 > MAX_SYNC_FILE_BYTES {
            return Err(GistError::Local(SyncError::FileTooLarge(path.to_owned())));
        }
        Ok((!bytes.is_empty()).then_some(bytes))
    }

    /// The sha256 of every file of the closed list that the config folder holds (an empty one is
    /// left out), by path.
    fn local_hashes(&self) -> Result<BTreeMap<String, String>, GistError> {
        let mut hashes = BTreeMap::new();
        for path in syncable_files_in(&self.config_dir)? {
            if let Some(bytes) = self.read_local(&path)? {
                hashes.insert(path, sha256_hex(&bytes));
            }
        }
        Ok(hashes)
    }

    /// The files of `paths` as the request body holds them. Every file is read, checked as UTF-8
    /// text and measured against the ceiling before anything is sent.
    fn payload(&self, paths: &[String]) -> Result<Payload, GistError> {
        let mut files = Map::new();
        let mut sent = BTreeMap::new();
        let mut total = 0u64;
        for path in paths {
            let Some(name) = gist_file_name(path) else {
                return Err(GistError::Local(SyncError::NotSyncable(path.clone())));
            };
            let Some(bytes) = self.read_local(path)? else {
                continue;
            };
            total += bytes.len() as u64;
            if total > MAX_GIST_PAYLOAD_BYTES {
                return Err(GistError::TooLarge(MAX_GIST_PAYLOAD_BYTES));
            }
            let hash = sha256_hex(&bytes);
            let content = String::from_utf8(bytes).map_err(|_| GistError::NotText(path.clone()))?;
            files.insert(name, json!({ "content": content }));
            sent.insert(path.clone(), hash);
        }
        Ok(Payload { files, sent })
    }

    /// The hash of each sent file as the answer to the request holds it (the gist keeps what it
    /// was given, but if it did not, the record must follow the gist), else the hash sent.
    fn hashes_after(answer: &Value, sent: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        sent.iter()
            .map(|(path, sent_hash)| {
                let held = gist_file_name(path)
                    .and_then(|name| answer.get("files")?.get(name)?.as_object().cloned())
                    .filter(|entry| entry.get("truncated").and_then(Value::as_bool) != Some(true))
                    .and_then(|entry| entry.get("content")?.as_str().map(sha256_hex_of_text));
                (path.clone(), held.unwrap_or_else(|| sent_hash.clone()))
            })
            .collect()
    }

    // ---- the network -------------------------------------------------------------------------

    /// One request to the API, answered with its JSON. The token goes only in the header.
    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        token: &str,
    ) -> Result<Value, GistError> {
        let url = format!("{}{path}", self.base);
        let request = async {
            let mut builder = self
                .http
                .request(method, &url)
                .bearer_auth(token)
                .header(ACCEPT, "application/vnd.github+json")
                .header("X-GitHub-Api-Version", API_VERSION);
            if let Some(body) = body {
                builder = builder.header(CONTENT_TYPE, "application/json").body(body);
            }
            let response = builder
                .send()
                .await
                .map_err(|e| GistError::Network(scrub(&describe(&e), token)))?;
            let status = response.status();
            if !status.is_success() {
                // Only the message matters, and a body that is too large has none worth reading.
                let body = read_body(response, MAX_ERROR_BODY_BYTES)
                    .await
                    .unwrap_or_default();
                return Err(GistError::Http {
                    status: status.as_u16(),
                    message: api_message(&body, token),
                });
            }
            let bytes = read_body(response, self.max_response).await?;
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| GistError::BadResponse("it is not JSON".to_owned()))
        };
        tokio::time::timeout(self.timeout, request)
            .await
            .map_err(|_| GistError::Timeout)?
    }

    async fn fetch(&self, id: &str, token: &str) -> Result<RemoteGist, GistError> {
        let answer = self
            .call(Method::GET, &format!("/gists/{id}"), None, token)
            .await?;
        let gist = parse_gist(&answer)?;
        if gist.id != id {
            return Err(GistError::BadResponse(
                "it is another gist than the one asked for".to_owned(),
            ));
        }
        Ok(gist)
    }

    // ---- the steps ---------------------------------------------------------------------------

    /// Where the sync stands, with no network.
    pub fn status(&self) -> Result<GistStatus, GistError> {
        let has_token = matches!(self.vault.get(SYNC_GIST_TOKEN_ENTRY), Ok(Some(_)));
        let Some(record) = self.load_record()? else {
            return Ok(GistStatus {
                has_token,
                ..GistStatus::default()
            });
        };
        let pending = self
            .local_hashes()?
            .into_iter()
            .filter_map(|(path, hash)| match record.files.get(&path) {
                None => Some(PendingChange {
                    path,
                    kind: ChangeKind::Added,
                }),
                Some(known) if *known != hash => Some(PendingChange {
                    path,
                    kind: ChangeKind::Modified,
                }),
                Some(_) => None,
            })
            .collect();
        Ok(GistStatus {
            connected: true,
            gist_id: Some(record.gist_id),
            public: record.public,
            has_token,
            pending,
        })
    }

    /// Connects to the gist `gist_id`, or (with `None`) makes a secret gist from the files of this
    /// computer. Connecting to a gist copies nothing into the config folder: that is what a pull
    /// does. Connecting to the gist that is already connected keeps what the record knows.
    pub async fn connect(&self, gist_id: Option<&str>) -> Result<GistStatus, GistError> {
        let _turn = self.turn.lock().await;
        let token = self.token()?;
        let record = match gist_id {
            Some(id) => {
                let id = id.trim();
                if !is_valid_gist_id(id) {
                    return Err(GistError::InvalidGistId);
                }
                let gist = self.fetch(id, &token).await?;
                let files = match self.load_record()? {
                    Some(known) if known.gist_id == id => known.files,
                    _ => BTreeMap::new(),
                };
                Record {
                    gist_id: id.to_owned(),
                    public: gist.public,
                    files,
                }
            }
            None => self.create(&token).await?,
        };
        self.save_record(&record)?;
        self.status()
    }

    /// Makes a secret gist holding the files of the closed list that this computer has.
    async fn create(&self, token: &str) -> Result<Record, GistError> {
        let paths: Vec<String> = self.local_hashes()?.into_keys().collect();
        let payload = self.payload(&paths)?;
        if payload.sent.is_empty() {
            return Err(GistError::NothingToSend);
        }
        let body = serde_json::to_vec(&json!({
            "description": GIST_DESCRIPTION,
            "public": false,
            "files": payload.files,
        }))
        .map_err(|e| GistError::BadResponse(e.to_string()))?;
        let answer = self.call(Method::POST, "/gists", Some(body), token).await?;
        let gist = parse_gist(&answer)?;
        Ok(Record {
            gist_id: gist.id,
            public: gist.public,
            files: Self::hashes_after(&answer, &payload.sent),
        })
    }

    /// Sends the files that changed here. The gist is read first, and when any file of it is not as
    /// this computer last saw it nothing is sent ([`GistError::Changed`]).
    pub async fn push(&self) -> Result<PushOutcome, GistError> {
        let _turn = self.turn.lock().await;
        let mut record = self.require_record()?;
        let token = self.token()?;
        let remote = self.fetch(&record.gist_id, &token).await?;
        let theirs = remote.hashes();
        let moved = differing(&record.files, &theirs);
        if !moved.is_empty() {
            return Err(GistError::Changed(moved));
        }
        let mine = self.local_hashes()?;
        let changed: Vec<String> = mine
            .iter()
            .filter(|(path, hash)| record.files.get(*path) != Some(*hash))
            .map(|(path, _)| path.clone())
            .collect();
        if changed.is_empty() {
            return Ok(PushOutcome {
                committed: false,
                pushed: false,
                files: Vec::new(),
            });
        }
        let payload = self.payload(&changed)?;
        if payload.sent.is_empty() {
            return Ok(PushOutcome {
                committed: false,
                pushed: false,
                files: Vec::new(),
            });
        }
        let body = serde_json::to_vec(&json!({ "files": payload.files }))
            .map_err(|e| GistError::BadResponse(e.to_string()))?;
        let answer = self
            .call(
                Method::PATCH,
                &format!("/gists/{}", record.gist_id),
                Some(body),
                &token,
            )
            .await?;
        record
            .files
            .extend(Self::hashes_after(&answer, &payload.sent));
        record.public = remote.public;
        self.save_record(&record)?;
        Ok(PushOutcome {
            committed: true,
            pushed: true,
            files: payload.sent.into_keys().collect(),
        })
    }

    /// Brings the gist into the config folder (see the top of this file): a conflict writes
    /// nothing and returns the paths; a clean pull writes the files the gist changed.
    pub async fn pull(&self) -> Result<PullOutcome, GistError> {
        let _turn = self.turn.lock().await;
        let mut record = self.require_record()?;
        let token = self.token()?;
        let remote = self.fetch(&record.gist_id, &token).await?;
        let mine = self.local_hashes()?;
        let mut deliver: Vec<(&String, &Vec<u8>)> = Vec::new();
        let mut conflicts: Vec<String> = Vec::new();
        for (path, bytes) in &remote.files {
            let theirs = sha256_hex(bytes);
            let known = record.files.get(path);
            if known == Some(&theirs) {
                continue;
            }
            match mine.get(path) {
                None => deliver.push((path, bytes)),
                Some(held) if *held == theirs => {}
                Some(held) if Some(held) == known => deliver.push((path, bytes)),
                Some(_) => conflicts.push(path.clone()),
            }
        }
        if !conflicts.is_empty() {
            return Ok(PullOutcome::Conflicts(conflicts));
        }
        for (path, bytes) in &deliver {
            write_bytes(&self.config_dir.join(path), bytes)?;
        }
        record.files = remote.hashes();
        record.public = remote.public;
        self.save_record(&record)?;
        let written: Vec<String> = deliver.into_iter().map(|(path, _)| path.clone()).collect();
        Ok(if written.is_empty() {
            PullOutcome::UpToDate
        } else {
            PullOutcome::Updated(written)
        })
    }
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha256_hex_of_text(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

#[cfg(test)]
mod tests;

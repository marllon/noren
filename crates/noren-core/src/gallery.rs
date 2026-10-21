//! The gallery of themes and mods, without any Tauri dependency (NOR-F18-02a): reading the index a
//! gallery publishes, downloading an item, checking its hash and installing it. The screen that
//! shows the gallery is not here.
//!
//! The gallery is one JSON file in a public repository ([`DEFAULT_INDEX_URL`]) that lists items. An
//! item is a theme (a JSON file, installed as `themes/<id>.json`) or a mod (a CSS file, installed
//! as `mods/<id>.css`); it carries the address of its file, the sha256 of the bytes at that address
//! and their size. The rules of the index are the ones of `galleryIndexSchema` in `@noren/model`.
//!
//! - **Reading the index** ([`parse_index`]) is strict: version 1, no field that is not known, an
//!   id that is a theme id (so it is a safe file name for both kinds), no id twice, an https
//!   address with no user name, a lower case sha256 of 64 digits and a size from 1 byte to
//!   [`MAX_ITEM_BYTES`]. The index itself is read up to [`MAX_INDEX_BYTES`].
//! - **Downloading** ([`Gallery`]) is https only (a test may use a local `http` address), has one
//!   deadline for the whole request ([`GALLERY_TIMEOUT`]), follows no redirect (a redirect could
//!   leave https) and never reads more than the ceiling it was given: the index limit for the
//!   index, and for an item the size the index declares for it.
//! - **Installing** ([`Gallery::install`]) downloads the index again, finds the item, downloads
//!   its file, and only if the sha256 of the bytes is the declared one, the bytes are UTF-8 text
//!   and (for a theme) a JSON object whose `id`, when it has one, is the id of the item, saves it
//!   with [`ThemeStore::save`] or [`ModStore::save`] and records the item as installed. Anything
//!   that fails before the save writes nothing, the record included.
//! - **The record** is `gallery.json` next to `config.jsonc`: the id, kind, version and sha256 of
//!   each item installed, in the order they were first installed. A missing or unreadable record is
//!   an empty one (the files are intact; installing again brings the record back).

use std::fmt;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::mods::{MODS_DIR_NAME, ModError, ModStore};
use crate::store::write_atomic;
use crate::themes::{THEMES_DIR_NAME, ThemeError, ThemeStore, is_valid_theme_id};

/// Where the index of the official gallery is. The repository (`noren-gallery`) is made apart from
/// this code; until it exists the address answers an error and the gallery reports it.
pub const DEFAULT_INDEX_URL: &str =
    "https://raw.githubusercontent.com/marllon/noren-gallery/main/index.json";

/// Name of the file that records what was installed, in the config folder of the app.
pub const GALLERY_FILE_NAME: &str = "gallery.json";

/// The version of the index this build reads.
pub const INDEX_VERSION: u64 = 1;

/// The most bytes of an index read.
pub const MAX_INDEX_BYTES: usize = 512 * 1024;

/// The most bytes an item may have: the size of a theme file and of a mod file.
pub const MAX_ITEM_BYTES: u64 = 256 * 1024;

/// The most items an index may hold.
pub const MAX_ITEMS: usize = 500;

/// How long one download may take, from the request to the last byte.
pub const GALLERY_TIMEOUT: Duration = Duration::from_secs(30);

const MAX_NAME_CHARS: usize = 60;
const MAX_VERSION_CHARS: usize = 32;
const MAX_URL_CHARS: usize = 512;

/// What an item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    Theme,
    Mod,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Theme => "theme",
            Self::Mod => "mod",
        }
    }

    fn from_text(text: &str) -> Option<Self> {
        match text {
            "theme" => Some(Self::Theme),
            "mod" => Some(Self::Mod),
            _ => None,
        }
    }
}

/// One item of the index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GalleryItem {
    pub id: String,
    pub kind: ItemKind,
    pub name: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// The index of a gallery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GalleryIndex {
    pub items: Vec<GalleryItem>,
}

/// What the app records about an item it installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledItem {
    pub id: String,
    pub kind: ItemKind,
    pub version: String,
    pub sha256: String,
}

/// Errors returned by [`Gallery`] and [`parse_index`].
#[derive(Debug)]
pub enum GalleryError {
    /// An address that is not https (or not an address at all).
    InsecureAddress(String),
    /// The gallery could not be reached.
    Network(String),
    /// The request took longer than [`GALLERY_TIMEOUT`].
    Timeout,
    /// The gallery answered with this status (a redirect included).
    Http(u16),
    /// The answer is larger than the ceiling for it, in bytes.
    TooLarge(u64),
    /// The index is not a valid index of version 1; the sentence says where.
    BadIndex(String),
    /// The index has no item with this id.
    UnknownItem(String),
    /// The sha256 of the bytes downloaded is not the one the index declares.
    HashMismatch { expected: String, actual: String },
    /// The file is not what its kind needs (not UTF-8 text, not a theme object, a wrong id).
    BadContent(String),
    /// The theme could not be saved.
    Theme(ThemeError),
    /// The mod could not be saved.
    Mod(ModError),
    /// The record of what is installed could not be written.
    Record(String),
}

impl fmt::Display for GalleryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InsecureAddress(url) => write!(f, "'{url}' is not an https address"),
            Self::Network(reason) => write!(f, "could not reach the gallery: {reason}"),
            Self::Timeout => write!(f, "the gallery took too long to answer"),
            Self::Http(status) => write!(f, "the gallery answered with status {status}"),
            Self::TooLarge(limit) => write!(f, "the download is larger than {limit} bytes"),
            Self::BadIndex(reason) => write!(f, "the gallery index is not valid: {reason}"),
            Self::UnknownItem(id) => write!(f, "the gallery has no item '{id}'"),
            Self::HashMismatch { expected, actual } => write!(
                f,
                "the download does not match the sha256 of the index (expected {expected}, got {actual}); nothing was installed"
            ),
            Self::BadContent(reason) => write!(f, "the download is not usable: {reason}"),
            Self::Theme(source) => write!(f, "{source}"),
            Self::Mod(source) => write!(f, "{source}"),
            Self::Record(reason) => write!(f, "could not record the installed item: {reason}"),
        }
    }
}

impl std::error::Error for GalleryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Theme(source) => Some(source),
            Self::Mod(source) => Some(source),
            _ => None,
        }
    }
}

/// Whether `version` looks like `1.2.3`, optionally with a `-pre` or `+build` suffix, in at most 32
/// characters (the rule of the manifest of a plugin and of `galleryItemSchema`).
pub fn is_valid_version(version: &str) -> bool {
    if version.is_empty() || version.len() > MAX_VERSION_CHARS {
        return false;
    }
    let (core, suffix) = match version.find(['-', '+']) {
        Some(at) => (&version[..at], Some(&version[at + 1..])),
        None => (version, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers
            .iter()
            .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

/// Whether `address` is an https address with a host and no user name or password, and no blank or
/// control character. With `allow_http` an `http` address passes too (tests, on `127.0.0.1`).
fn is_gallery_address(address: &str, allow_http: bool) -> bool {
    let rest = address.strip_prefix("https://").or_else(|| {
        allow_http
            .then(|| address.strip_prefix("http://"))
            .flatten()
    });
    let Some(rest) = rest else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    address.len() <= MAX_URL_CHARS
        && !authority.is_empty()
        && !authority.contains('@')
        && !address.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String {
    use fmt::Write;
    bytes.iter().fold(String::with_capacity(64), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// The sha256 of `bytes` as 64 lower case hexadecimal digits.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// Reads and checks an index (see the top of this file). Only https addresses are accepted.
pub fn parse_index(text: &str) -> Result<GalleryIndex, GalleryError> {
    parse_index_with(text, false)
}

fn parse_index_with(text: &str, allow_http: bool) -> Result<GalleryIndex, GalleryError> {
    let bad = |reason: String| GalleryError::BadIndex(reason);
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value: Value =
        serde_json::from_str(text).map_err(|_| bad("it is not valid JSON".to_owned()))?;
    let Value::Object(root) = value else {
        return Err(bad("it is not a JSON object".to_owned()));
    };
    if let Some(unknown) = root.keys().find(|k| *k != "version" && *k != "items") {
        return Err(bad(format!("'{unknown}' is not a field of the index")));
    }
    if root.get("version").and_then(Value::as_u64) != Some(INDEX_VERSION) {
        return Err(bad(format!("version must be {INDEX_VERSION}")));
    }
    let Some(Value::Array(entries)) = root.get("items") else {
        return Err(bad("items must be a list".to_owned()));
    };
    if entries.len() > MAX_ITEMS {
        return Err(bad(format!("an index holds at most {MAX_ITEMS} items")));
    }
    let mut items: Vec<GalleryItem> = Vec::with_capacity(entries.len());
    for (position, entry) in entries.iter().enumerate() {
        let item = parse_item(entry, allow_http)
            .map_err(|reason| bad(format!("items.{position}.{reason}")))?;
        if items.iter().any(|other| other.id == item.id) {
            return Err(bad(format!(
                "items.{position}.id: id \"{}\" is listed twice",
                item.id
            )));
        }
        items.push(item);
    }
    Ok(GalleryIndex { items })
}

/// One item, or `field: sentence` for the first thing wrong.
fn parse_item(entry: &Value, allow_http: bool) -> Result<GalleryItem, String> {
    let Value::Object(fields) = entry else {
        return Err("item: it is not an object".to_owned());
    };
    const KNOWN: [&str; 7] = ["id", "kind", "name", "version", "url", "sha256", "size"];
    if let Some(unknown) = fields.keys().find(|k| !KNOWN.contains(&k.as_str())) {
        return Err(format!("{unknown}: it is not a field of an item"));
    }
    let text = |field: &str| -> Result<&str, String> {
        fields
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}: {field} must be text"))
    };
    let id = text("id")?;
    if !is_valid_theme_id(id) {
        return Err("id: id must be lower case words joined by hyphens".to_owned());
    }
    let kind = ItemKind::from_text(text("kind")?)
        .ok_or_else(|| "kind: kind must be one of theme, mod".to_owned())?;
    let name = text("name")?.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "name: name must be 1 to {MAX_NAME_CHARS} characters"
        ));
    }
    let version = text("version")?;
    if !is_valid_version(version) {
        return Err("version: version must look like 1.2.3".to_owned());
    }
    let url = text("url")?;
    if !is_gallery_address(url, allow_http) {
        return Err("url: url must be an https address with no user name".to_owned());
    }
    let sha256 = text("sha256")?;
    if !is_sha256(sha256) {
        return Err("sha256: sha256 must be 64 lower case hexadecimal digits".to_owned());
    }
    let size = fields
        .get("size")
        .and_then(Value::as_u64)
        .filter(|size| (1..=MAX_ITEM_BYTES).contains(size))
        .ok_or_else(|| format!("size: size must be a whole number from 1 to {MAX_ITEM_BYTES}"))?;
    Ok(GalleryItem {
        id: id.to_owned(),
        kind,
        name: name.to_owned(),
        version: version.to_owned(),
        url: url.to_owned(),
        sha256: sha256.to_owned(),
        size,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The text of a request error with its causes, without the address.
fn describe(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    let text = parts.join(": ");
    match error.url() {
        Some(url) => text.replace(url.as_str(), "the address"),
        None => text,
    }
}

/// The gallery: downloads from the index address and installs into the config folder.
#[derive(Debug)]
pub struct Gallery {
    http: reqwest::Client,
    timeout: Duration,
    index_url: String,
    allow_http: bool,
    themes: ThemeStore,
    mods: ModStore,
    record: PathBuf,
    busy: Mutex<()>,
}

impl Gallery {
    /// A gallery that installs into `config_dir` (the folder of `config.jsonc`: `themes/`, `mods/`
    /// and `gallery.json` are inside it) and downloads from [`DEFAULT_INDEX_URL`]. Nothing is
    /// touched on disk until something is installed.
    pub fn new(config_dir: impl Into<PathBuf>) -> Result<Self, GalleryError> {
        Self::at(config_dir, DEFAULT_INDEX_URL, false, GALLERY_TIMEOUT)
    }

    fn at(
        config_dir: impl Into<PathBuf>,
        index_url: &str,
        allow_http: bool,
        timeout: Duration,
    ) -> Result<Self, GalleryError> {
        let config_dir = config_dir.into();
        let http = reqwest::Client::builder()
            .connect_timeout(timeout)
            // A redirect could leave https, and the address of an item is the one the index gave.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("noren/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| GalleryError::Network(describe(&e)))?;
        Ok(Self {
            http,
            timeout,
            index_url: index_url.to_owned(),
            allow_http,
            themes: ThemeStore::new(config_dir.join(THEMES_DIR_NAME)),
            mods: ModStore::new(config_dir.join(MODS_DIR_NAME)),
            record: config_dir.join(GALLERY_FILE_NAME),
            busy: Mutex::new(()),
        })
    }

    /// The text of the index, downloaded and checked with [`parse_index`], exactly as served.
    pub async fn index_text(&self) -> Result<String, GalleryError> {
        self.fetch_index().await.map(|(text, _)| text)
    }

    /// The index, downloaded and checked.
    pub async fn index(&self) -> Result<GalleryIndex, GalleryError> {
        self.fetch_index().await.map(|(_, index)| index)
    }

    async fn fetch_index(&self) -> Result<(String, GalleryIndex), GalleryError> {
        let bytes = self
            .download(&self.index_url, MAX_INDEX_BYTES as u64)
            .await?;
        let text = String::from_utf8(bytes)
            .map_err(|_| GalleryError::BadIndex("it is not UTF-8 text".to_owned()))?;
        let index = parse_index_with(&text, self.allow_http)?;
        Ok((text, index))
    }

    /// What was installed from the gallery, in the order of the first installation.
    pub fn installed(&self) -> Vec<InstalledItem> {
        let _guard = lock(&self.busy);
        self.read_record()
    }

    /// Installs, or updates, the item `id` (see the top of this file) and answers its record.
    pub async fn install(&self, id: &str) -> Result<InstalledItem, GalleryError> {
        let (_, index) = self.fetch_index().await?;
        let item = index
            .items
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| GalleryError::UnknownItem(id.to_owned()))?;
        // The index declares the size, and nothing larger is read.
        let bytes = self.download(&item.url, item.size).await?;
        let actual = sha256_hex(&bytes);
        if actual != item.sha256 {
            return Err(GalleryError::HashMismatch {
                expected: item.sha256,
                actual,
            });
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| GalleryError::BadContent("it is not UTF-8 text".to_owned()))?;
        let _guard = lock(&self.busy);
        match item.kind {
            ItemKind::Theme => {
                check_theme(&item.id, &text)?;
                self.themes
                    .save(&item.id, &text)
                    .map_err(GalleryError::Theme)?;
            }
            ItemKind::Mod => self
                .mods
                .save(&format!("{}.css", item.id), &text)
                .map_err(GalleryError::Mod)?,
        }
        let installed = InstalledItem {
            id: item.id,
            kind: item.kind,
            version: item.version,
            sha256: item.sha256,
        };
        self.write_record(&installed)?;
        Ok(installed)
    }

    /// Downloads `url` and gives the body, which is never larger than `limit` bytes. The whole
    /// request (connection, answer and body) has [`Gallery::timeout`].
    async fn download(&self, url: &str, limit: u64) -> Result<Vec<u8>, GalleryError> {
        if !is_gallery_address(url, self.allow_http) {
            return Err(GalleryError::InsecureAddress(url.to_owned()));
        }
        let request = async {
            let mut response = self
                .http
                .get(url)
                .send()
                .await
                .map_err(|e| GalleryError::Network(describe(&e)))?;
            let status = response.status();
            if !status.is_success() {
                return Err(GalleryError::Http(status.as_u16()));
            }
            if response.content_length().is_some_and(|n| n > limit) {
                return Err(GalleryError::TooLarge(limit));
            }
            let mut body: Vec<u8> = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|e| GalleryError::Network(describe(&e)))?
            {
                if (body.len() + chunk.len()) as u64 > limit {
                    return Err(GalleryError::TooLarge(limit));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        };
        tokio::time::timeout(self.timeout, request)
            .await
            .map_err(|_| GalleryError::Timeout)?
    }

    fn read_record(&self) -> Vec<InstalledItem> {
        let Ok(text) = fs::read_to_string(&self.record) else {
            return Vec::new();
        };
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&text) else {
            return Vec::new();
        };
        let Some(Value::Array(entries)) = root.get("installed") else {
            return Vec::new();
        };
        entries
            .iter()
            .filter_map(|entry| {
                let field = |name: &str| entry.get(name).and_then(Value::as_str);
                let id = field("id").filter(|id| is_valid_theme_id(id))?;
                let version = field("version").filter(|v| is_valid_version(v))?;
                let sha256 = field("sha256").filter(|h| is_sha256(h))?;
                Some(InstalledItem {
                    id: id.to_owned(),
                    kind: ItemKind::from_text(field("kind")?)?,
                    version: version.to_owned(),
                    sha256: sha256.to_owned(),
                })
            })
            .collect()
    }

    /// Puts `installed` in the record, replacing the entry of the same id and kind.
    fn write_record(&self, installed: &InstalledItem) -> Result<(), GalleryError> {
        let mut all = self.read_record();
        match all
            .iter_mut()
            .find(|entry| entry.id == installed.id && entry.kind == installed.kind)
        {
            Some(entry) => *entry = installed.clone(),
            None => all.push(installed.clone()),
        }
        let entries: Vec<Value> = all
            .iter()
            .map(|entry| {
                json!({
                    "id": entry.id,
                    "kind": entry.kind.as_str(),
                    "version": entry.version,
                    "sha256": entry.sha256,
                })
            })
            .collect();
        let mut root = Map::new();
        root.insert("version".to_owned(), json!(1));
        root.insert("installed".to_owned(), Value::Array(entries));
        let text = serde_json::to_string_pretty(&Value::Object(root))
            .map_err(|e| GalleryError::Record(e.to_string()))?;
        write_atomic(&self.record, format!("{text}\n").as_bytes())
            .map_err(|e| GalleryError::Record(e.to_string()))
    }
}

/// A theme must be a JSON object, and its `id`, when it has one, is the id of the item (the file
/// is named after the item, so a theme that calls itself something else would not be found).
fn check_theme(id: &str, text: &str) -> Result<(), GalleryError> {
    let bad = |reason: &str| GalleryError::BadContent(reason.to_owned());
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Ok(Value::Object(theme)) = serde_json::from_str::<Value>(body) else {
        return Err(bad("a theme must be a JSON object"));
    };
    match theme.get("id") {
        Some(Value::String(own)) if own != id => {
            Err(bad("the id in the theme is not the id of the item"))
        }
        Some(Value::String(_)) | None => Ok(()),
        Some(_) => Err(bad("the id in the theme must be text")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A folder under the system temp dir with a unique name, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-gallery-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        fn themes(&self) -> PathBuf {
            self.0.join(THEMES_DIR_NAME)
        }

        fn mods(&self) -> PathBuf {
            self.0.join(MODS_DIR_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// What a path answers.
    #[derive(Clone)]
    enum Reply {
        Body(Vec<u8>),
        Status(u16),
        Redirect(String),
        /// Reads the request and then says nothing for a while.
        Silent,
    }

    /// A server on `127.0.0.1` at a port the system picks; the routes can change while it runs.
    struct TestServer {
        base: String,
        routes: Arc<Mutex<Vec<(String, Reply)>>>,
        hits: Arc<Mutex<Vec<String>>>,
    }

    impl TestServer {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
            let base = format!("http://{}", listener.local_addr().expect("local address"));
            let routes: Arc<Mutex<Vec<(String, Reply)>>> = Arc::new(Mutex::new(Vec::new()));
            let hits = Arc::new(Mutex::new(Vec::new()));
            let (shared, log) = (routes.clone(), hits.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    let (shared, log) = (shared.clone(), log.clone());
                    std::thread::spawn(move || serve(stream, &shared, &log));
                }
            });
            Self { base, routes, hits }
        }

        fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base)
        }

        fn set(&self, path: &str, reply: Reply) {
            let mut routes = lock(&self.routes);
            routes.retain(|(p, _)| p != path);
            routes.push((path.to_owned(), reply));
        }

        fn body(&self, path: &str, body: &str) {
            self.set(path, Reply::Body(body.as_bytes().to_vec()));
        }

        fn hits(&self) -> Vec<String> {
            lock(&self.hits).clone()
        }

        /// Serves `items` as the index at `/index.json`: `(id, kind, version, path, body)`, each
        /// declaring the real hash and size of its body, which is served at its path.
        fn publish(&self, items: &[(&str, &str, &str, &str)]) {
            let mut entries = Vec::new();
            for (id, kind, version, body) in items {
                let path = format!("/files/{id}");
                self.body(&path, body);
                entries.push(item_json(
                    id,
                    kind,
                    version,
                    &self.url(&path),
                    &sha256_hex(body.as_bytes()),
                    body.len(),
                ));
            }
            self.body("/index.json", &index_json(&entries));
        }
    }

    fn serve(stream: TcpStream, routes: &Mutex<Vec<(String, Reply)>>, hits: &Mutex<Vec<String>>) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let Ok(reader_side) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(reader_side);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return;
        }
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim_end().is_empty() {
                break;
            }
        }
        let path = request_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("/")
            .to_owned();
        lock(hits).push(path.clone());
        let reply = lock(routes)
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, reply)| reply.clone())
            .unwrap_or(Reply::Status(404));
        let mut stream = stream;
        let head = |status: &str, length: usize, extra: &str| {
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {length}\r\n{extra}Connection: close\r\n\r\n"
            )
        };
        match reply {
            Reply::Body(body) => {
                let _ = stream.write_all(head("200 OK", body.len(), "").as_bytes());
                let _ = stream.write_all(&body);
            }
            Reply::Status(code) => {
                let _ = stream.write_all(head(&format!("{code} Nope"), 0, "").as_bytes());
            }
            Reply::Redirect(to) => {
                let _ = stream
                    .write_all(head("302 Found", 0, &format!("Location: {to}\r\n")).as_bytes());
            }
            Reply::Silent => {
                let mut rest = Vec::new();
                let _ = reader.read_to_end(&mut rest);
                std::thread::sleep(Duration::from_secs(3));
            }
        }
        let _ = stream.flush();
    }

    fn item_json(id: &str, kind: &str, version: &str, url: &str, sha: &str, size: usize) -> String {
        format!(
            r#"{{"id":"{id}","kind":"{kind}","name":"{id} name","version":"{version}","url":"{url}","sha256":"{sha}","size":{size}}}"#
        )
    }

    fn index_json(entries: &[String]) -> String {
        format!(r#"{{"version":1,"items":[{}]}}"#, entries.join(","))
    }

    fn gallery(dir: &TempDir, server: &TestServer) -> Gallery {
        Gallery::at(
            &dir.0,
            &server.url("/index.json"),
            true,
            Duration::from_secs(10),
        )
        .expect("gallery")
    }

    const THEME_V1: &str = r#"{"id":"lagoon","name":"Lagoon","v":1}"#;
    const THEME_V2: &str = r#"{"id":"lagoon","name":"Lagoon","v":2}"#;
    const MOD_V1: &str = ".a { color: red }\n";

    // ---- the index -----------------------------------------------------------------------

    fn sha() -> String {
        "a".repeat(64)
    }

    fn one(item: &str) -> String {
        format!(r#"{{"version":1,"items":[{item}]}}"#)
    }

    fn good_item() -> String {
        item_json(
            "lagoon",
            "theme",
            "1.0.0",
            "https://example.com/l.json",
            &sha(),
            100,
        )
    }

    fn reason(text: &str) -> String {
        match parse_index(text) {
            Err(GalleryError::BadIndex(reason)) => reason,
            other => panic!("expected a bad index, got {other:?}"),
        }
    }

    #[test]
    fn a_valid_index_is_read_with_both_kinds() {
        let mod_item = item_json(
            "compact-tabs",
            "mod",
            "2.0.1-beta",
            "https://example.com/m.css",
            &sha(),
            5,
        );
        let index = parse_index(&format!("\u{feff}{}", index_json(&[good_item(), mod_item])))
            .expect("valid");
        assert_eq!(index.items.len(), 2);
        assert_eq!(index.items[0].kind, ItemKind::Theme);
        assert_eq!(index.items[1].kind, ItemKind::Mod);
        assert_eq!(index.items[1].version, "2.0.1-beta");
        assert_eq!(index.items[0].size, 100);
        assert_eq!(
            parse_index(r#"{"version":1,"items":[]}"#)
                .expect("empty")
                .items,
            []
        );
    }

    #[test]
    fn what_is_not_an_index_is_refused_with_a_reason() {
        assert!(reason("not json").contains("not valid JSON"));
        assert!(reason("[]").contains("not a JSON object"));
        assert!(reason(r#"{"version":2,"items":[]}"#).contains("version must be 1"));
        assert!(reason(r#"{"items":[]}"#).contains("version must be 1"));
        assert!(reason(r#"{"version":1}"#).contains("items must be a list"));
        assert!(reason(r#"{"version":1,"items":[],"x":1}"#).contains("'x'"));
        assert!(reason(&one("3")).contains("items.0.item"));
        assert!(reason(&one(&good_item().replace("}", r#","home":"x"}"#))).contains("home"));
    }

    #[test]
    fn every_field_of_an_item_is_checked() {
        let with = |from: &str, to: &str| one(&good_item().replace(from, to));
        for (from, to, field) in [
            ("lagoon\",\"kind", "Lagoon\",\"kind", "items.0.id"),
            ("lagoon\",\"kind", "../lagoon\",\"kind", "items.0.id"),
            ("lagoon\",\"kind", "con\",\"kind", "items.0.id"),
            ("\"theme\"", "\"plugin\"", "items.0.kind"),
            ("lagoon name", "  ", "items.0.name"),
            ("1.0.0", "1.0", "items.0.version"),
            ("1.0.0", "v1.0.0", "items.0.version"),
            (
                "https://example.com/l.json",
                "http://example.com/l.json",
                "items.0.url",
            ),
            (
                "https://example.com/l.json",
                "https://u:p@example.com/l.json",
                "items.0.url",
            ),
            (
                "https://example.com/l.json",
                "file:///etc/passwd",
                "items.0.url",
            ),
            ("https://example.com/l.json", "https://", "items.0.url"),
            (&sha(), &"A".repeat(64), "items.0.sha256"),
            (&sha(), &"a".repeat(63), "items.0.sha256"),
            (&sha(), &"g".repeat(64), "items.0.sha256"),
            ("\"size\":100", "\"size\":0", "items.0.size"),
            ("\"size\":100", "\"size\":262145", "items.0.size"),
            ("\"size\":100", "\"size\":1.5", "items.0.size"),
            ("\"size\":100", "\"size\":\"100\"", "items.0.size"),
        ] {
            let text = with(from, to);
            let message = reason(&text);
            assert!(message.starts_with(field), "{from} -> {to}: {message}");
        }
        let at_the_limit = with("\"size\":100", "\"size\":262144");
        assert!(parse_index(&at_the_limit).is_ok());
    }

    #[test]
    fn an_id_listed_twice_is_refused_even_with_another_kind() {
        let other = item_json(
            "lagoon",
            "mod",
            "1.0.0",
            "https://example.com/m.css",
            &sha(),
            5,
        );
        let message = reason(&index_json(&[good_item(), other]));
        assert_eq!(message, "items.1.id: id \"lagoon\" is listed twice");
    }

    #[test]
    fn too_many_items_are_refused() {
        let items: Vec<String> = (0..=MAX_ITEMS)
            .map(|n| {
                item_json(
                    &format!("t{n}"),
                    "theme",
                    "1.0.0",
                    "https://example.com/t.json",
                    &sha(),
                    5,
                )
            })
            .collect();
        assert!(reason(&index_json(&items)).contains("at most"));
    }

    #[test]
    fn versions_are_numbers_with_an_optional_suffix() {
        for v in [
            "0.0.0",
            "1.2.3",
            "10.20.30",
            "1.0.0-beta.1",
            "1.0.0+build-5",
        ] {
            assert!(is_valid_version(v), "{v}");
        }
        for v in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "a.b.c",
            "1.2.3-",
            "1.2. 3",
            "1..3",
            &format!("1.0.0-{}", "x".repeat(32)),
        ] {
            assert!(!is_valid_version(v), "{v:?}");
        }
    }

    #[test]
    fn sha256_matches_the_known_answers() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    // ---- the download --------------------------------------------------------------------

    #[tokio::test]
    async fn the_index_is_downloaded_and_checked() {
        let dir = TempDir::new("index");
        let server = TestServer::start();
        server.publish(&[("lagoon", "theme", "1.0.0", THEME_V1)]);
        let gallery = gallery(&dir, &server);
        let index = gallery.index().await.expect("index");
        assert_eq!(index.items.len(), 1);
        assert_eq!(index.items[0].id, "lagoon");
        assert!(
            gallery
                .index_text()
                .await
                .expect("text")
                .contains("\"lagoon\"")
        );
        assert!(!dir.themes().exists(), "reading the index writes nothing");
    }

    #[tokio::test]
    async fn the_index_that_is_wrong_or_missing_is_an_error() {
        let dir = TempDir::new("index-errors");
        let server = TestServer::start();
        let gallery = gallery(&dir, &server);
        assert!(matches!(
            gallery.index().await,
            Err(GalleryError::Http(404))
        ));

        server.set("/index.json", Reply::Status(500));
        assert!(matches!(
            gallery.index().await,
            Err(GalleryError::Http(500))
        ));

        server.body("/index.json", "{ not json");
        assert!(matches!(
            gallery.index().await,
            Err(GalleryError::BadIndex(_))
        ));

        server.set("/index.json", Reply::Body(vec![0xff, 0xfe, 0x00]));
        assert!(matches!(
            gallery.index().await,
            Err(GalleryError::BadIndex(_))
        ));

        server.body("/index.json", r#"{"version":9,"items":[]}"#);
        assert!(matches!(
            gallery.index().await,
            Err(GalleryError::BadIndex(_))
        ));
    }

    #[tokio::test]
    async fn an_index_over_the_ceiling_is_refused() {
        let dir = TempDir::new("index-big");
        let server = TestServer::start();
        let padding = " ".repeat(MAX_INDEX_BYTES);
        server.body(
            "/index.json",
            &format!(r#"{{"version":1,"items":[]}}{padding}"#),
        );
        let error = gallery(&dir, &server).index().await.expect_err("too large");
        assert!(matches!(error, GalleryError::TooLarge(n) if n == MAX_INDEX_BYTES as u64));
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed() {
        let dir = TempDir::new("redirect");
        let server = TestServer::start();
        server.body("/elsewhere", r#"{"version":1,"items":[]}"#);
        server.set("/index.json", Reply::Redirect(server.url("/elsewhere")));
        let error = gallery(&dir, &server).index().await.expect_err("redirect");
        assert!(matches!(error, GalleryError::Http(302)));
        assert_eq!(server.hits(), ["/index.json"]);
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let dir = TempDir::new("timeout");
        let server = TestServer::start();
        server.set("/index.json", Reply::Silent);
        let slow = Gallery::at(
            &dir.0,
            &server.url("/index.json"),
            true,
            Duration::from_millis(300),
        )
        .expect("gallery");
        assert!(matches!(slow.index().await, Err(GalleryError::Timeout)));
    }

    #[tokio::test]
    async fn an_http_address_is_refused_outside_the_tests_without_asking_the_server() {
        let dir = TempDir::new("insecure");
        let server = TestServer::start();
        server.publish(&[("lagoon", "theme", "1.0.0", THEME_V1)]);
        // The same address, but a gallery that does not allow http (the one the app builds).
        let strict = Gallery::at(
            &dir.0,
            &server.url("/index.json"),
            false,
            Duration::from_secs(5),
        )
        .expect("gallery");
        assert!(matches!(
            strict.index().await,
            Err(GalleryError::InsecureAddress(_))
        ));
        assert!(server.hits().is_empty(), "no request was made");
        // And an index whose items point to http is not an index for it either.
        assert!(parse_index(&server_index_text(&server)).is_err());
    }

    fn server_index_text(server: &TestServer) -> String {
        let routes = lock(&server.routes);
        match &routes
            .iter()
            .find(|(p, _)| p == "/index.json")
            .expect("route")
            .1
        {
            Reply::Body(body) => String::from_utf8(body.clone()).expect("text"),
            _ => panic!("not a body"),
        }
    }

    // ---- installing ----------------------------------------------------------------------

    #[tokio::test]
    async fn a_theme_is_installed_as_its_file_and_recorded() {
        let dir = TempDir::new("theme");
        let server = TestServer::start();
        server.publish(&[("lagoon", "theme", "1.0.0", THEME_V1)]);
        let gallery = gallery(&dir, &server);
        let installed = gallery.install("lagoon").await.expect("install");
        assert_eq!(
            installed,
            InstalledItem {
                id: "lagoon".to_owned(),
                kind: ItemKind::Theme,
                version: "1.0.0".to_owned(),
                sha256: sha256_hex(THEME_V1.as_bytes()),
            }
        );
        assert_eq!(
            fs::read_to_string(dir.themes().join("lagoon.json")).expect("file"),
            THEME_V1
        );
        assert_eq!(gallery.installed(), [installed]);
        assert!(!dir.mods().exists());
    }

    #[tokio::test]
    async fn a_mod_is_installed_as_its_file_and_recorded() {
        let dir = TempDir::new("mod");
        let server = TestServer::start();
        server.publish(&[("compact-tabs", "mod", "1.2.0", MOD_V1)]);
        let gallery = gallery(&dir, &server);
        let installed = gallery.install("compact-tabs").await.expect("install");
        assert_eq!(installed.kind, ItemKind::Mod);
        assert_eq!(
            fs::read_to_string(dir.mods().join("compact-tabs.css")).expect("file"),
            MOD_V1
        );
        assert_eq!(gallery.installed(), [installed]);
        assert!(!dir.themes().exists());
        // The mods folder lists it like a mod put there by hand.
        let listed = ModStore::new(dir.mods()).list().expect("list");
        assert_eq!(listed[0].name, "compact-tabs.css");
    }

    #[tokio::test]
    async fn a_hash_that_does_not_match_installs_nothing() {
        let dir = TempDir::new("hash");
        let server = TestServer::start();
        // The index declares the hash of other bytes than the ones served.
        server.body("/files/lagoon", THEME_V2);
        server.body(
            "/index.json",
            &index_json(&[item_json(
                "lagoon",
                "theme",
                "1.0.0",
                &server.url("/files/lagoon"),
                &sha256_hex(THEME_V1.as_bytes()),
                THEME_V2.len(),
            )]),
        );
        let gallery = gallery(&dir, &server);
        let error = gallery.install("lagoon").await.expect_err("must refuse");
        match &error {
            GalleryError::HashMismatch { expected, actual } => {
                assert_eq!(expected, &sha256_hex(THEME_V1.as_bytes()));
                assert_eq!(actual, &sha256_hex(THEME_V2.as_bytes()));
            }
            other => panic!("expected a hash mismatch, got {other:?}"),
        }
        assert!(error.to_string().contains("nothing was installed"));
        assert!(!dir.themes().exists(), "no theme folder, no file");
        assert!(!dir.0.join(GALLERY_FILE_NAME).exists(), "no record");
        assert_eq!(gallery.installed(), []);
    }

    #[tokio::test]
    async fn a_hash_that_does_not_match_leaves_the_installed_version_as_it_was() {
        let dir = TempDir::new("hash-update");
        let server = TestServer::start();
        server.publish(&[("lagoon", "theme", "1.0.0", THEME_V1)]);
        let gallery = gallery(&dir, &server);
        gallery.install("lagoon").await.expect("first");

        // The file is changed on the server after the index was written.
        server.body("/files/lagoon", r#"{"id":"lagoon","name":"Tampered"}"#);
        let index = server_index_text(&server).replace("1.0.0", "2.0.0");
        server.body("/index.json", &index);
        let error = gallery.install("lagoon").await.expect_err("must refuse");
        assert!(matches!(error, GalleryError::HashMismatch { .. }));
        assert_eq!(
            fs::read_to_string(dir.themes().join("lagoon.json")).expect("file"),
            THEME_V1
        );
        assert_eq!(gallery.installed()[0].version, "1.0.0");
    }

    #[tokio::test]
    async fn a_file_over_the_declared_size_is_refused_and_nothing_is_written() {
        let dir = TempDir::new("size");
        let server = TestServer::start();
        // The hash is right, but the index says the file is smaller than it is.
        server.body("/files/lagoon", THEME_V1);
        server.body(
            "/index.json",
            &index_json(&[item_json(
                "lagoon",
                "theme",
                "1.0.0",
                &server.url("/files/lagoon"),
                &sha256_hex(THEME_V1.as_bytes()),
                THEME_V1.len() - 1,
            )]),
        );
        let gallery = gallery(&dir, &server);
        let error = gallery.install("lagoon").await.expect_err("too large");
        assert!(matches!(error, GalleryError::TooLarge(n) if n == THEME_V1.len() as u64 - 1));
        assert!(!dir.themes().exists());
        assert_eq!(gallery.installed(), []);
    }

    #[tokio::test]
    async fn a_file_that_is_not_what_its_kind_needs_is_refused() {
        let dir = TempDir::new("content");
        let server = TestServer::start();
        let cases: [(&str, &str, Vec<u8>); 4] = [
            ("not-an-object", "theme", b"[1,2]".to_vec()),
            ("other-id", "theme", br#"{"id":"someone-else"}"#.to_vec()),
            ("bad-bytes", "theme", vec![b'{', 0xff, b'}']),
            ("bad-css", "mod", vec![b'a', 0xff, b'{', b'}']),
        ];
        let mut entries = Vec::new();
        for (id, kind, bytes) in &cases {
            server.set(&format!("/files/{id}"), Reply::Body(bytes.clone()));
            entries.push(item_json(
                id,
                kind,
                "1.0.0",
                &server.url(&format!("/files/{id}")),
                &sha256_hex(bytes),
                bytes.len(),
            ));
        }
        server.body("/index.json", &index_json(&entries));
        let gallery = gallery(&dir, &server);
        for (id, _, _) in &cases {
            let error = gallery.install(id).await.expect_err(id);
            assert!(
                matches!(error, GalleryError::BadContent(_)),
                "{id}: {error}"
            );
        }
        assert!(!dir.themes().exists());
        assert!(!dir.mods().exists());
        assert_eq!(gallery.installed(), []);
    }

    #[tokio::test]
    async fn an_unknown_id_and_a_missing_file_are_errors() {
        let dir = TempDir::new("unknown");
        let server = TestServer::start();
        server.publish(&[("lagoon", "theme", "1.0.0", THEME_V1)]);
        let gallery = gallery(&dir, &server);
        assert!(matches!(
            gallery.install("nothing").await,
            Err(GalleryError::UnknownItem(id)) if id == "nothing"
        ));
        assert!(matches!(
            gallery.install("../lagoon").await,
            Err(GalleryError::UnknownItem(_))
        ));
        server.set("/files/lagoon", Reply::Status(404));
        assert!(matches!(
            gallery.install("lagoon").await,
            Err(GalleryError::Http(404))
        ));
        assert!(!dir.themes().exists());
    }

    #[tokio::test]
    async fn an_update_replaces_the_file_and_the_version_and_keeps_one_record() {
        let dir = TempDir::new("update");
        let server = TestServer::start();
        server.publish(&[
            ("lagoon", "theme", "1.0.0", THEME_V1),
            ("compact-tabs", "mod", "1.0.0", MOD_V1),
        ]);
        let gallery = gallery(&dir, &server);
        gallery.install("lagoon").await.expect("theme");
        gallery.install("compact-tabs").await.expect("mod");

        server.publish(&[
            ("lagoon", "theme", "1.1.0", THEME_V2),
            ("compact-tabs", "mod", "1.0.0", MOD_V1),
        ]);
        let updated = gallery.install("lagoon").await.expect("update");
        assert_eq!(updated.version, "1.1.0");
        assert_eq!(updated.sha256, sha256_hex(THEME_V2.as_bytes()));
        assert_eq!(
            fs::read_to_string(dir.themes().join("lagoon.json")).expect("file"),
            THEME_V2
        );
        let installed = gallery.installed();
        assert_eq!(installed.len(), 2, "one record per item, the order kept");
        assert_eq!(installed[0].id, "lagoon");
        assert_eq!(installed[0].version, "1.1.0");
        assert_eq!(installed[1].id, "compact-tabs");
        let names: Vec<String> = fs::read_dir(dir.themes())
            .expect("folder")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["lagoon.json"], "no temporary file is left");
    }

    #[tokio::test]
    async fn the_record_survives_a_new_gallery_and_an_unreadable_record_is_empty() {
        let dir = TempDir::new("record");
        let server = TestServer::start();
        server.publish(&[("lagoon", "theme", "1.0.0", THEME_V1)]);
        let first = gallery(&dir, &server);
        assert_eq!(first.installed(), [], "no record yet");
        assert!(!dir.0.join(GALLERY_FILE_NAME).exists());
        first.install("lagoon").await.expect("install");

        let again = gallery(&dir, &server);
        assert_eq!(again.installed().len(), 1);
        let text = fs::read_to_string(dir.0.join(GALLERY_FILE_NAME)).expect("record");
        assert!(
            text.contains("\"lagoon\"") && text.contains("\"theme\"") && text.contains("1.0.0")
        );

        // Entries that are not valid are left out; a file that is not JSON is no record.
        fs::write(
            dir.0.join(GALLERY_FILE_NAME),
            r#"{"version":1,"installed":[{"id":"../x","kind":"theme","version":"1.0.0","sha256":"a"},{"id":"ok","kind":"mod","version":"1.0.0","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"#,
        )
        .expect("write");
        let kept = again.installed();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "ok");
        fs::write(dir.0.join(GALLERY_FILE_NAME), "{ broken").expect("write");
        assert_eq!(again.installed(), []);
    }

    #[tokio::test]
    async fn the_same_id_as_a_theme_and_as_a_mod_is_two_records_in_two_indexes() {
        // An index never lists an id twice, but the item may change kind between two indexes.
        let dir = TempDir::new("kinds");
        let server = TestServer::start();
        server.publish(&[("same", "theme", "1.0.0", r#"{"id":"same"}"#)]);
        let gallery = gallery(&dir, &server);
        gallery.install("same").await.expect("theme");
        server.publish(&[("same", "mod", "1.0.0", MOD_V1)]);
        gallery.install("same").await.expect("mod");
        let kinds: Vec<ItemKind> = gallery.installed().iter().map(|i| i.kind).collect();
        assert_eq!(kinds, [ItemKind::Theme, ItemKind::Mod]);
    }

    #[test]
    fn the_default_address_is_https_and_valid() {
        assert!(is_gallery_address(DEFAULT_INDEX_URL, false));
    }
}

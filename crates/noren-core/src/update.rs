//! The update of the app itself (NOR-F20-02a): the part that has no Tauri in it. The app finds out
//! whether a newer version exists, and installs it, only when the person asks; this module is how
//! the bytes reach the app and how the settings of the updater are read. What decides about them
//! (the platform entry, the comparison of the versions, the minisign signature) is
//! `tauri-plugin-updater`, in the app crate (`update.rs` of `src-tauri`), which is also what runs the
//! installer of the system.
//!
//! **The feed** is the file the updater of Tauri reads: one JSON object with the `version`, the
//! `notes`, the `pub_date` and a `platforms` map from a target (`windows-x86_64-nsis`,
//! `linux-x86_64-appimage`, `darwin-aarch64`) to the `url` of the package and its `signature`
//! (the text of the `.sig` file). On GitHub it is the asset `latest.json` of the latest release.
//! [`Fetcher::feed`] only gets it and checks that it is a JSON object within the ceiling; reading
//! it is the plugin's job, so the format cannot drift from what the release tooling writes.
//!
//! **The package** is downloaded by [`Fetcher::package`] into memory, because the signature covers
//! the whole file and nothing may reach the disk before it has been checked. The plugin's own
//! download has no ceiling and no deadline; this one has both ([`Limits`]).
//!
//! **The addresses.** The feed and the package are fetched over `https` only. The one exception is
//! a feed whose own address is `http://127.0.0.1:<port>` (a test): then the package and the
//! redirects may be on `127.0.0.1` too, and nowhere else. A redirect is followed (the assets of a
//! GitHub release are served from another host) up to [`MAX_REDIRECTS`] times, and never to an
//! address this module would not have fetched itself. Nothing asks the person anything, and no
//! request carries a credential.
//!
//! **The key.** The public key of the updater lives in one place, `plugins > updater > pubkey` of
//! `tauri.conf.json`. Until the maintainer replaces [`PUBKEY_NOT_SET`] there with the real key
//! (NOR-F21-07), [`key_is_set`] is false and the app neither checks nor installs: an update is never
//! trusted without a key to check it against.

use std::fmt;
use std::time::Duration;

use reqwest::Url;
use reqwest::header::ACCEPT;
use serde_json::Value;

use crate::gallery::describe;

/// What stands for the public key in `tauri.conf.json` until the real one is put there. It is not
/// a key: nothing can be verified against it, so no update is ever accepted while it is there.
pub const PUBKEY_NOT_SET: &str = "NOT-SET-replace-with-the-updater-public-key-NOR-F21-07";

/// How long getting the feed may take, from the connection to the last byte.
pub const FEED_TIMEOUT: Duration = Duration::from_secs(30);

/// How long downloading the package may take, from the connection to the last byte. At the
/// ceiling of [`MAX_PACKAGE_BYTES`] this is still more than 0.5 MB/s.
pub const PACKAGE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The most bytes the feed may have (a real one has a few hundred).
pub const MAX_FEED_BYTES: u64 = 1024 * 1024;

/// The most bytes the package may have. The installers of the app are some tens of MiB.
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;

/// The most redirects one request follows.
pub const MAX_REDIRECTS: usize = 5;

/// The longest text of release notes kept, in characters.
pub const MAX_NOTES_CHARS: usize = 8000;

/// The shortest base64 text that can be a minisign public key (the real ones have 100 characters).
const MIN_PUBKEY_CHARS: usize = 40;

/// Why a step of the update did not happen. The texts are sentences for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    /// There is no public key to check an update against yet ([`PUBKEY_NOT_SET`]).
    NotConfigured,
    /// This run does not update (a smoke run).
    Off,
    /// The configuration of the updater is not usable; the sentence says why.
    BadConfig(String),
    /// The address is not one this module fetches; the sentence says why.
    InsecureAddress(String),
    /// The server could not be reached, or the connection broke.
    Network(String),
    /// The request took longer than the deadline.
    Timeout,
    /// The server answered with this status.
    Http(u16),
    /// The answer is larger than this many bytes.
    TooLarge(u64),
    /// The feed is not usable; the sentence says why.
    BadFeed(String),
    /// There is no update found to install: check first.
    NothingToInstall,
    /// Another step of the update is still running.
    Busy,
    /// The update was found but cannot be used or is not to be trusted (no package for this
    /// platform, a signature that does not match); the sentence says why.
    Refused(String),
    /// The installer of the system could not be started.
    Install(String),
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => f.write_str(
                "this build has no update key yet, so it cannot check or install updates",
            ),
            Self::Off => f.write_str("this run does not update"),
            Self::BadConfig(why) => write!(f, "the update settings are not usable: {why}"),
            Self::InsecureAddress(why) => write!(f, "the update address is not usable: {why}"),
            Self::Network(why) => write!(f, "the update server could not be reached: {why}"),
            Self::Timeout => f.write_str("the update server took too long to answer"),
            Self::Http(status) => write!(f, "the update server answered {status}"),
            Self::TooLarge(limit) => {
                write!(f, "the update answer is larger than {limit} bytes")
            }
            Self::BadFeed(why) => write!(f, "the update feed is not usable: {why}"),
            Self::NothingToInstall => f.write_str("there is no update to install: check first"),
            Self::Busy => f.write_str("another step of the update is still running"),
            Self::Refused(why) => write!(f, "the update was refused: {why}"),
            Self::Install(why) => write!(f, "the update could not be installed: {why}"),
        }
    }
}

impl std::error::Error for UpdateError {}

/// The ceilings and deadlines of the requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub feed_timeout: Duration,
    pub package_timeout: Duration,
    pub max_feed_bytes: u64,
    pub max_package_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            feed_timeout: FEED_TIMEOUT,
            package_timeout: PACKAGE_TIMEOUT,
            max_feed_bytes: MAX_FEED_BYTES,
            max_package_bytes: MAX_PACKAGE_BYTES,
        }
    }
}

/// How much of a download is in memory. `total` is what the server announced, when it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// A newer version, as the person is told about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    /// The version that would be installed.
    pub version: String,
    /// The version that is running.
    pub current_version: String,
    /// The release notes, cleaned (no control character but the line break and the tab, at most
    /// [`MAX_NOTES_CHARS`] characters), or `None` when there are none.
    pub notes: Option<String>,
    /// When the release was published, in seconds since 1970, when the feed says.
    pub published_at: Option<i64>,
}

impl UpdateInfo {
    pub fn new(
        version: &str,
        current_version: &str,
        notes: Option<&str>,
        published_at: Option<i64>,
    ) -> Self {
        Self {
            version: version.to_owned(),
            current_version: current_version.to_owned(),
            notes: notes.and_then(clean_notes),
            published_at,
        }
    }
}

/// `notes` without control characters (a line break and a tab stay), trimmed and cut at
/// [`MAX_NOTES_CHARS`] characters; `None` when nothing is left.
fn clean_notes(notes: &str) -> Option<String> {
    let kept: String = notes
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let kept = kept.trim();
    if kept.is_empty() {
        return None;
    }
    let mut chars = kept.chars();
    let head: String = chars.by_ref().take(MAX_NOTES_CHARS).collect();
    Some(if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    })
}

// ---- the settings --------------------------------------------------------------------------

/// The first update endpoint of the plugin configuration (`plugins > updater` of
/// `tauri.conf.json`, as a JSON value), which must be an address a [`Fetcher`] accepts: `https`,
/// or a local test server.
pub fn endpoint_of(config: &Value) -> Result<String, UpdateError> {
    let bad = |why: &str| UpdateError::BadConfig(why.to_owned());
    let endpoint = config
        .get("endpoints")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(Value::as_str)
        .ok_or_else(|| bad("there is no endpoint"))?;
    let url = Url::parse(endpoint).map_err(|_| bad("the endpoint is not an address"))?;
    if let Some(why) = address_problem(&url, true) {
        return Err(UpdateError::BadConfig(format!("the endpoint: {why}")));
    }
    Ok(endpoint.to_owned())
}

/// Whether the plugin configuration holds a public key: base64 text that is not the placeholder
/// [`PUBKEY_NOT_SET`]. Whether it is the *right* key is for the signature check to say.
pub fn key_is_set(config: &Value) -> bool {
    let Some(key) = config.get("pubkey").and_then(Value::as_str) else {
        return false;
    };
    key != PUBKEY_NOT_SET
        && key.len() >= MIN_PUBKEY_CHARS
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

// ---- the addresses -------------------------------------------------------------------------

/// Whether `url` is the address of a local test server: `http://127.0.0.1:<port>`.
fn is_loopback(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some()
}

/// Why `url` may not be fetched, or `None` when it may: `https` with a host and no credentials,
/// or (with `loopback`) a local test server.
fn address_problem(url: &Url, loopback: bool) -> Option<&'static str> {
    if !url.username().is_empty() || url.password().is_some() {
        return Some("it has a user name or a password in it");
    }
    match url.scheme() {
        "https" if url.host_str().is_some() => None,
        "http" if loopback && is_loopback(url) => None,
        _ => Some("it is not https"),
    }
}

// ---- the requests --------------------------------------------------------------------------

/// Gets the feed and the package of an update from one endpoint.
#[derive(Debug)]
pub struct Fetcher {
    http: reqwest::Client,
    endpoint: Url,
    loopback: bool,
    limits: Limits,
}

impl Fetcher {
    /// A fetcher of the feed at `endpoint`, with the ceilings and deadlines of this module.
    pub fn new(endpoint: &str) -> Result<Self, UpdateError> {
        Self::with_limits(endpoint, Limits::default())
    }

    /// The same with other ceilings and deadlines (a test makes them small).
    pub fn with_limits(endpoint: &str, limits: Limits) -> Result<Self, UpdateError> {
        let url = Url::parse(endpoint)
            .map_err(|_| UpdateError::InsecureAddress("it is not an address".to_owned()))?;
        let loopback = is_loopback(&url);
        if let Some(why) = address_problem(&url, loopback) {
            return Err(UpdateError::InsecureAddress(why.to_owned()));
        }
        let mut builder = reqwest::Client::builder()
            .connect_timeout(limits.feed_timeout)
            .user_agent(concat!("noren/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                // `previous` holds the address asked first and each one followed since.
                if attempt.previous().len() > MAX_REDIRECTS {
                    attempt.error("too many redirects")
                } else if address_problem(attempt.url(), loopback).is_some() {
                    attempt.error("a redirect to an address that is not allowed")
                } else {
                    attempt.follow()
                }
            }));
        if loopback {
            // A proxy of the environment must not stand between a test and its own server.
            builder = builder.no_proxy();
        } else {
            builder = builder.https_only(true);
        }
        let http = builder
            .build()
            .map_err(|e| UpdateError::Network(describe(&e)))?;
        Ok(Self {
            http,
            endpoint: url,
            loopback,
            limits,
        })
    }

    /// The feed: `None` when the server answers 204 (no update to offer), otherwise the JSON
    /// object it sent. Whether it announces a newer version, and a package for this platform, is
    /// for the updater plugin to say. The status other than a success, a body over the ceiling, a
    /// body that is not a JSON object and a request over the deadline are errors.
    pub async fn feed(&self) -> Result<Option<Value>, UpdateError> {
        let request = async {
            let response = self.get(self.endpoint.clone(), "application/json").await?;
            let status = response.status();
            if !status.is_success() {
                return Err(UpdateError::Http(status.as_u16()));
            }
            if status == reqwest::StatusCode::NO_CONTENT {
                return Ok(None);
            }
            let bytes = read_body(response, self.limits.max_feed_bytes, |_| {}).await?;
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(value @ Value::Object(_)) => Ok(Some(value)),
                Ok(_) => Err(UpdateError::BadFeed("it is not a JSON object".to_owned())),
                Err(_) => Err(UpdateError::BadFeed("it is not JSON".to_owned())),
            }
        };
        tokio::time::timeout(self.limits.feed_timeout, request)
            .await
            .map_err(|_| UpdateError::Timeout)?
    }

    /// The bytes of the package at `address`, with `on_progress` told after every piece. The
    /// address must be one this fetcher may fetch; a size over the ceiling (announced, or reached
    /// while reading) and a download over the deadline are errors, and nothing is kept then.
    pub async fn package(
        &self,
        address: &str,
        mut on_progress: impl FnMut(Progress),
    ) -> Result<Vec<u8>, UpdateError> {
        let url = Url::parse(address).map_err(|_| {
            UpdateError::BadFeed("the address of the package is not an address".to_owned())
        })?;
        if let Some(why) = address_problem(&url, self.loopback) {
            return Err(UpdateError::InsecureAddress(format!(
                "the address of the package: {why}"
            )));
        }
        let request = async {
            let response = self.get(url, "application/octet-stream").await?;
            let status = response.status();
            if !status.is_success() {
                return Err(UpdateError::Http(status.as_u16()));
            }
            let total = response.content_length();
            read_body(response, self.limits.max_package_bytes, |downloaded| {
                on_progress(Progress { downloaded, total });
            })
            .await
        };
        tokio::time::timeout(self.limits.package_timeout, request)
            .await
            .map_err(|_| UpdateError::Timeout)?
    }

    async fn get(&self, url: Url, accept: &str) -> Result<reqwest::Response, UpdateError> {
        self.http
            .get(url)
            .header(ACCEPT, accept)
            .send()
            .await
            .map_err(|e| UpdateError::Network(describe(&e)))
    }
}

/// Reads the whole body of `response`, at most `limit` bytes, calling `each` with the number of
/// bytes read so far after every piece. A length announced over the limit fails before a byte is
/// read.
async fn read_body(
    mut response: reqwest::Response,
    limit: u64,
    mut each: impl FnMut(u64),
) -> Result<Vec<u8>, UpdateError> {
    if response.content_length().is_some_and(|n| n > limit) {
        return Err(UpdateError::TooLarge(limit));
    }
    // What the server announced is not trusted for the allocation, only used up to a small size.
    let announced = response.content_length().unwrap_or(0).min(8 * 1024 * 1024);
    let mut body: Vec<u8> = Vec::with_capacity(announced as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| UpdateError::Network(describe(&e)))?
    {
        if (body.len() + chunk.len()) as u64 > limit {
            return Err(UpdateError::TooLarge(limit));
        }
        body.extend_from_slice(&chunk);
        each(body.len() as u64);
    }
    Ok(body)
}

#[cfg(test)]
mod tests;

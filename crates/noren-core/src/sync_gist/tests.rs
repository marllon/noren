//! Tests of the sync through a gist: a fake of the Gist API on `127.0.0.1` at a port the system
//! picks (it keeps gists in memory and logs every request), a vault in memory, and a config
//! folder in the temp dir. Nothing touches the network of the machine or its keychain.

use super::*;
use crate::vault::MemoryVault;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN: &str = "ghp_TestTokenNeverReal0123456789";

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
            "noren-gist-{label}-{}-{nanos}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create the test folder");
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// ---- the fake of the Gist API ------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    authorization: Option<String>,
    user_agent: Option<String>,
    body: String,
}

#[derive(Debug, Clone, Default)]
struct FakeGist {
    public: bool,
    files: BTreeMap<String, String>,
    /// Names the answer marks as cut short, as the API does for a file over 1 MB.
    truncated: BTreeSet<String>,
}

#[derive(Debug, Clone)]
enum Forced {
    /// Every request answers with this status and body.
    Reply(u16, String),
    /// Every request is answered with a redirect.
    Redirect,
    /// Every request is read and then nothing is said for a while.
    Silent,
    /// Every request is answered with a body of this many bytes.
    Huge(usize),
}

#[derive(Default)]
struct Hub {
    gists: BTreeMap<String, FakeGist>,
    seen: Vec<Seen>,
    next_id: u64,
    forced: Option<Forced>,
    /// The gist keeps `\n` for every `\r\n` it is given.
    normalize_newlines: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

struct TestServer {
    base: String,
    hub: Arc<Mutex<Hub>>,
}

impl TestServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let base = format!("http://{}", listener.local_addr().expect("local address"));
        let hub = Arc::new(Mutex::new(Hub::default()));
        let shared = hub.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let hub = shared.clone();
                std::thread::spawn(move || serve(stream, &hub));
            }
        });
        Self { base, hub }
    }

    fn put_gist(&self, id: &str, public: bool, files: &[(&str, &str)]) {
        lock(&self.hub).gists.insert(
            id.to_owned(),
            FakeGist {
                public,
                files: files
                    .iter()
                    .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
                    .collect(),
                truncated: BTreeSet::new(),
            },
        );
    }

    /// Another computer (or the web page of the gist) sets a file.
    fn set_file(&self, id: &str, name: &str, text: &str) {
        let mut hub = lock(&self.hub);
        let gist = hub.gists.get_mut(id).expect("the gist exists");
        gist.files.insert(name.to_owned(), text.to_owned());
    }

    fn remove_file(&self, id: &str, name: &str) {
        let mut hub = lock(&self.hub);
        let gist = hub.gists.get_mut(id).expect("the gist exists");
        gist.files.remove(name);
    }

    fn truncate(&self, id: &str, name: &str) {
        let mut hub = lock(&self.hub);
        let gist = hub.gists.get_mut(id).expect("the gist exists");
        gist.truncated.insert(name.to_owned());
    }

    fn file(&self, id: &str, name: &str) -> Option<String> {
        lock(&self.hub).gists.get(id)?.files.get(name).cloned()
    }

    fn file_names(&self, id: &str) -> Vec<String> {
        lock(&self.hub)
            .gists
            .get(id)
            .map(|gist| gist.files.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn gist_ids(&self) -> Vec<String> {
        lock(&self.hub).gists.keys().cloned().collect()
    }

    fn force(&self, forced: Option<Forced>) {
        lock(&self.hub).forced = forced;
    }

    fn normalize_newlines(&self, on: bool) {
        lock(&self.hub).normalize_newlines = on;
    }

    fn seen(&self) -> Vec<Seen> {
        lock(&self.hub).seen.clone()
    }

    fn methods(&self) -> Vec<String> {
        self.seen()
            .iter()
            .map(|s| format!("{} {}", s.method, s.path))
            .collect()
    }

    fn clear_seen(&self) {
        lock(&self.hub).seen.clear();
    }
}

fn gist_json(id: &str, gist: &FakeGist) -> String {
    let files: Map<String, Value> = gist
        .files
        .iter()
        .map(|(name, text)| {
            let cut = gist.truncated.contains(name);
            let shown: String = if cut {
                text.chars().take(4).collect()
            } else {
                text.clone()
            };
            (
                name.clone(),
                json!({
                    "filename": name,
                    "type": "text/plain",
                    "size": text.len(),
                    "truncated": cut,
                    "content": shown,
                }),
            )
        })
        .collect();
    json!({
        "id": id,
        "public": gist.public,
        "truncated": false,
        "files": files,
    })
    .to_string()
}

/// Whether a request body sets the files like the real API accepts them: every file has content,
/// and a gist cannot hold an empty one.
fn files_of_body(body: &Value) -> Result<BTreeMap<String, Option<String>>, String> {
    let Some(Value::Object(files)) = body.get("files") else {
        return Err("files wasn't supplied".to_owned());
    };
    let mut out = BTreeMap::new();
    for (name, entry) in files {
        match entry {
            Value::Null => {
                out.insert(name.clone(), None);
            }
            Value::Object(entry) => match entry.get("content").and_then(Value::as_str) {
                Some(content) if !content.is_empty() => {
                    out.insert(name.clone(), Some(content.to_owned()));
                }
                _ => return Err(format!("files.{name}.content is missing or empty")),
            },
            _ => return Err("files is not an object of objects".to_owned()),
        }
    }
    Ok(out)
}

fn serve(stream: TcpStream, hub: &Mutex<Hub>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(reader_side) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader_side);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut length = 0usize;
    let mut authorization = None;
    let mut user_agent = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = line.trim_end().split_once(':') {
            let value = value.trim().to_owned();
            match name.to_ascii_lowercase().as_str() {
                "content-length" => length = value.parse().unwrap_or(0),
                "authorization" => authorization = Some(value),
                "user-agent" => user_agent = Some(value),
                _ => {}
            }
        }
    }
    let mut body = vec![0u8; length];
    let _ = reader.read_exact(&mut body);
    let body = String::from_utf8_lossy(&body).into_owned();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("/").to_owned();

    let (status, text, forced) = {
        let mut hub = lock(hub);
        hub.seen.push(Seen {
            method: method.clone(),
            path: path.clone(),
            authorization,
            user_agent,
            body: body.clone(),
        });
        let forced = hub.forced.clone();
        let (status, text) = match &forced {
            Some(Forced::Reply(status, text)) => (*status, text.clone()),
            Some(Forced::Huge(size)) => (200, " ".repeat(*size)),
            Some(_) => (200, String::new()),
            None => route(&mut hub, &method, &path, &body),
        };
        (status, text, forced)
    };
    let mut stream = stream;
    let head = |status: &str, length: usize, extra: &str| {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {length}\r\n{extra}Connection: close\r\n\r\n"
        )
    };
    match forced {
        Some(Forced::Redirect) => {
            let _ = stream.write_all(
                head("302 Found", 0, "Location: http://127.0.0.1:1/elsewhere\r\n").as_bytes(),
            );
        }
        Some(Forced::Silent) => {
            let mut rest = Vec::new();
            let _ = reader.read_to_end(&mut rest);
            std::thread::sleep(Duration::from_secs(3));
        }
        _ => {
            let _ = stream.write_all(head(&format!("{status} Reply"), text.len(), "").as_bytes());
            let _ = stream.write_all(text.as_bytes());
        }
    }
    let _ = stream.flush();
}

/// The texts the gist keeps for the texts it was given.
fn kept(
    normalize_newlines: bool,
    files: BTreeMap<String, Option<String>>,
) -> BTreeMap<String, Option<String>> {
    files
        .into_iter()
        .map(|(name, text)| {
            let text = text.map(|text| {
                if normalize_newlines {
                    text.replace("\r\n", "\n")
                } else {
                    text
                }
            });
            (name, text)
        })
        .collect()
}

/// The few calls of the API the sync makes: read a gist, create one, change one.
fn route(hub: &mut Hub, method: &str, path: &str, body: &str) -> (u16, String) {
    let not_found = || (404, r#"{"message":"Not Found"}"#.to_owned());
    let invalid = |why: &str| {
        (
            422,
            json!({ "message": "Validation Failed", "errors": [why] }).to_string(),
        )
    };
    if method == "POST" && path == "/gists" {
        let Ok(body) = serde_json::from_str::<Value>(body) else {
            return invalid("body");
        };
        let files = match files_of_body(&body) {
            Ok(files) if !files.is_empty() => files,
            Ok(_) => return invalid("no files"),
            Err(why) => return invalid(&why),
        };
        let files = kept(hub.normalize_newlines, files);
        hub.next_id += 1;
        let id = format!("a1b2c3d4e5f6a7b8c9d{}", hub.next_id);
        let gist = FakeGist {
            public: body.get("public").and_then(Value::as_bool).unwrap_or(true),
            files: files
                .into_iter()
                .filter_map(|(name, text)| text.map(|text| (name, text)))
                .collect(),
            truncated: BTreeSet::new(),
        };
        let text = gist_json(&id, &gist);
        hub.gists.insert(id, gist);
        return (201, text);
    }
    let Some(id) = path.strip_prefix("/gists/") else {
        return not_found();
    };
    match method {
        "GET" => match hub.gists.get(id) {
            Some(gist) => (200, gist_json(id, gist)),
            None => not_found(),
        },
        "PATCH" => {
            let Ok(body) = serde_json::from_str::<Value>(body) else {
                return invalid("body");
            };
            let files = match files_of_body(&body) {
                Ok(files) => kept(hub.normalize_newlines, files),
                Err(why) => return invalid(&why),
            };
            let Some(gist) = hub.gists.get_mut(id) else {
                return not_found();
            };
            for (name, text) in files {
                match text {
                    Some(text) => {
                        gist.files.insert(name, text);
                    }
                    None => {
                        gist.files.remove(&name);
                    }
                }
            }
            (200, gist_json(id, gist))
        }
        _ => not_found(),
    }
}

// ---- a computer --------------------------------------------------------------------------------

struct Machine {
    dir: TempDir,
    vault: Arc<MemoryVault>,
    sync: GistSync,
}

impl Machine {
    fn new(server: &TestServer) -> Self {
        Self::with(server, Duration::from_secs(10), MAX_GIST_RESPONSE_BYTES)
    }

    fn with(server: &TestServer, timeout: Duration, max_response: u64) -> Self {
        let dir = TempDir::new("machine");
        let vault = Arc::new(MemoryVault::new());
        vault.set(SYNC_GIST_TOKEN_ENTRY, TOKEN).expect("token");
        let sync = GistSync::at(&dir.0, vault.clone(), &server.base, timeout, max_response)
            .expect("a sync on a local server");
        Self { dir, vault, sync }
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.dir.0.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("folder");
        fs::write(path, text).expect("write");
    }

    fn read(&self, relative: &str) -> Option<String> {
        fs::read_to_string(self.dir.0.join(relative)).ok()
    }

    fn exists(&self, relative: &str) -> bool {
        self.dir.0.join(relative).exists()
    }

    /// Every file of the config folder, with its text, for a search for what must not be there.
    fn all_files(&self) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(dir).expect("read dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push((
                        path.to_string_lossy().into_owned(),
                        fs::read(&path).unwrap_or_default(),
                    ));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.dir.0, &mut out);
        out
    }
}

fn pending_paths(status: &GistStatus) -> Vec<&str> {
    status.pending.iter().map(|p| p.path.as_str()).collect()
}

const THEME: &str = r#"{"id":"lagoon","name":"Lagoon"}"#;
const CONFIG: &str = "{ \"theme\": \"lagoon\" }\n";

/// A computer with a few files that may travel, connected to a new secret gist.
async fn connected_with_files(server: &TestServer) -> (Machine, String) {
    let machine = Machine::new(server);
    machine.write("config.jsonc", CONFIG);
    machine.write("themes/lagoon.json", THEME);
    machine.write("mods/tweak.css", ".a { color: red }\n");
    let status = machine.sync.connect(None).await.expect("create a gist");
    let id = status.gist_id.expect("the id of the gist");
    (machine, id)
}

// ---- the file names ----------------------------------------------------------------------------

#[test]
fn a_path_is_sent_as_one_flat_name_and_comes_back_the_same() {
    let cases = [
        ("config.jsonc", "config.jsonc"),
        ("themes/lagoon.json", "themes--lagoon.json"),
        ("themes/sea-glass-2.json", "themes--sea-glass-2.json"),
        ("mods/tweak.css", "mods--tweak.css"),
        ("mods/a--b.css", "mods--a--b.css"),
        (
            "spaces/Work.noren-space.json",
            "spaces--Work.noren-space.json",
        ),
        (
            "spaces/My notes (2).noren-space.json",
            "spaces--My notes (2).noren-space.json",
        ),
        (
            "spaces/themes--x.noren-space.json",
            "spaces--themes--x.noren-space.json",
        ),
    ];
    for (path, name) in cases {
        assert_eq!(gist_file_name(path).as_deref(), Some(name), "{path}");
        assert!(!name.contains('/'), "{name} is flat");
        assert_eq!(path_of_gist_file(name).as_deref(), Some(path), "{name}");
    }
    // One to one: no two paths share a name.
    let names: BTreeSet<_> = cases.iter().map(|(path, _)| gist_file_name(path)).collect();
    assert_eq!(names.len(), cases.len());
}

#[test]
fn only_the_closed_list_has_a_name_in_the_gist() {
    for path in [
        "state.json",
        "gallery.json",
        GIST_STATE_FILE_NAME,
        "sync-spaces.json",
        "themes/Bad Id.json",
        "themes/.json",
        "themes/a/b.json",
        "mods/x.txt",
        "spaces/x.json",
        "plugins/p/main.js",
        "scrollback/pane.txt",
        "config.jsonc.bak",
        "../config.jsonc",
        "",
    ] {
        assert_eq!(gist_file_name(path), None, "{path:?}");
    }
}

#[test]
fn a_name_that_does_not_come_back_to_a_path_of_the_list_is_refused() {
    for name in [
        "README.md",
        "notes.txt",
        "state.json",
        GIST_STATE_FILE_NAME,
        "themes--.json",
        "themes--../x.json",
        "themes--..%2fx.json",
        "themes--Bad Id.json",
        "themes--a--b.json", // not a theme id: a theme id has single dashes
        "mods--x.txt",
        "mods--",
        "spaces--x.json",
        "spaces--.noren-space.json",
        "plugins--p.js",
        // The path form is not a name: the name is the flat one.
        "themes/lagoon.json",
        "config.jsonc/",
        "themes--",
        "",
    ] {
        assert_eq!(path_of_gist_file(name), None, "{name:?}");
    }
}

// ---- the address -------------------------------------------------------------------------------

#[test]
fn http_is_accepted_only_for_a_port_of_127_0_0_1_and_only_in_a_test() {
    assert!(is_api_base(GIST_API_BASE, false));
    assert!(is_api_base(GIST_API_BASE, true));
    for local in ["http://127.0.0.1:8080", "http://127.0.0.1:1"] {
        assert!(is_api_base(local, true), "{local}");
        assert!(!is_api_base(local, false), "{local} outside a test");
    }
    for bad in [
        "http://api.github.com",
        "https://api.github.com/",
        "https://api.github.com.evil.example",
        "https://evil.example",
        "http://localhost:8080",
        "http://127.0.0.1",
        "http://127.0.0.1:",
        "http://127.0.0.1:80@evil.example",
        "http://127.0.0.1.evil.example:80",
        "http://127.0.0.2:80",
        "https://127.0.0.1:80",
        "ftp://127.0.0.1:80",
        "",
    ] {
        assert!(!is_api_base(bad, true), "{bad}");
        assert!(!is_api_base(bad, false), "{bad}");
    }
    let vault: Arc<dyn KeyVault> = Arc::new(MemoryVault::new());
    let dir = TempDir::new("base");
    assert!(GistSync::new(&dir.0, vault.clone()).is_ok());
    assert!(matches!(
        GistSync::at(
            &dir.0,
            vault,
            "http://api.github.com",
            GIST_TIMEOUT,
            MAX_GIST_RESPONSE_BYTES
        ),
        Err(GistError::InsecureAddress(_))
    ));
}

#[test]
fn a_gist_id_is_letters_and_digits_only() {
    for good in ["aa5a315d61ae9438b18d", "1234567", &"a".repeat(64), "A1"] {
        assert!(is_valid_gist_id(good), "{good}");
    }
    for bad in [
        "",
        "a b",
        "a/b",
        "../x",
        "a?b=c",
        "a-b",
        "é",
        &"a".repeat(65),
    ] {
        assert!(!is_valid_gist_id(bad), "{bad:?}");
    }
}

// ---- the token ---------------------------------------------------------------------------------

#[test]
fn the_token_is_stored_in_the_vault_under_a_name_no_provider_has_and_never_given_back() {
    let dir = TempDir::new("token");
    let vault = Arc::new(MemoryVault::new());
    let sync = GistSync::new(&dir.0, vault.clone()).expect("sync");
    assert!(!sync.status().expect("status").has_token);

    sync.set_token(&format!("  {TOKEN}\n")).expect("set");
    assert_eq!(
        vault.get(SYNC_GIST_TOKEN_ENTRY),
        Ok(Some(TOKEN.to_owned())),
        "blanks around the paste are dropped"
    );
    assert!(!crate::vault::is_valid_provider_id(SYNC_GIST_TOKEN_ENTRY));
    // No provider id reads it.
    for provider in [
        "openai",
        "anthropic",
        "ollama",
        "sync",
        "gist-token",
        "sync-gist-token",
    ] {
        assert_eq!(vault.get(provider), Ok(None), "{provider}");
    }
    let status = sync.status().expect("status");
    assert!(status.has_token);
    // Nothing in the status or in a debug print is the token.
    assert!(!format!("{status:?}").contains(TOKEN));
    assert!(!format!("{sync:?}").contains(TOKEN));

    sync.set_token("ghp_other").expect("replace");
    assert_eq!(
        vault.get(SYNC_GIST_TOKEN_ENTRY),
        Ok(Some("ghp_other".to_owned()))
    );
    sync.clear_token().expect("clear");
    assert_eq!(vault.get(SYNC_GIST_TOKEN_ENTRY), Ok(None));
    assert!(!sync.status().expect("status").has_token);
    sync.clear_token().expect("clearing nothing is fine");
    // Nothing was written to the config folder.
    assert_eq!(fs::read_dir(&dir.0).expect("dir").count(), 0);
}

#[test]
fn a_token_that_is_not_one_is_refused_without_being_printed() {
    let dir = TempDir::new("badtoken");
    let vault = Arc::new(MemoryVault::new());
    let sync = GistSync::new(&dir.0, vault.clone()).expect("sync");
    let huge = "t".repeat(MAX_KEY_CHARS + 1);
    for bad in [
        "",
        "   ",
        "two words",
        "ghp_with\ttab",
        "line\nbreak",
        "ação",
        "ghp_é",
        huge.as_str(),
    ] {
        let error = sync.set_token(bad).expect_err("refused");
        assert!(matches!(error, GistError::InvalidToken(_)), "{bad:?}");
        let text = error.to_string();
        assert!(
            bad.trim().is_empty() || !text.contains(bad.trim()),
            "the text repeats the token: {text}"
        );
    }
    assert_eq!(vault.get(SYNC_GIST_TOKEN_ENTRY), Ok(None));
}

#[tokio::test]
async fn without_a_token_nothing_is_asked_of_the_network() {
    let server = TestServer::start();
    server.put_gist("abc123", false, &[("config.jsonc", CONFIG)]);
    let machine = Machine::new(&server);
    machine.vault.delete(SYNC_GIST_TOKEN_ENTRY).expect("delete");
    machine.write("config.jsonc", CONFIG);
    assert!(matches!(
        machine.sync.connect(Some("abc123")).await,
        Err(GistError::NoToken)
    ));
    assert!(matches!(
        machine.sync.connect(None).await,
        Err(GistError::NoToken)
    ));
    // Connected by hand (a record exists), still no token: push and pull say so.
    machine.write(
        GIST_STATE_FILE_NAME,
        r#"{"version":1,"gistId":"abc123","public":false,"files":{}}"#,
    );
    assert!(matches!(machine.sync.push().await, Err(GistError::NoToken)));
    assert!(matches!(machine.sync.pull().await, Err(GistError::NoToken)));
    assert!(server.seen().is_empty(), "no request without a token");
    assert!(GistError::NoToken.to_string().contains("token"));
}

#[tokio::test]
async fn a_broken_keychain_stops_the_step_and_the_text_has_no_token() {
    let server = TestServer::start();
    let dir = TempDir::new("broken");
    let vault = Arc::new(MemoryVault::broken());
    let sync = GistSync::at(
        &dir.0,
        vault,
        &server.base,
        Duration::from_secs(10),
        MAX_GIST_RESPONSE_BYTES,
    )
    .expect("sync");
    let error = sync.set_token(TOKEN).expect_err("broken");
    assert!(matches!(
        error,
        GistError::Vault(VaultError::Unavailable(_))
    ));
    assert!(!error.to_string().contains(TOKEN));
    let error = sync.connect(Some("abc123")).await.expect_err("broken");
    assert!(matches!(error, GistError::Vault(_)));
    // The status is only a read: a keychain that fails reads as no token.
    assert!(!sync.status().expect("status").has_token);
    assert!(server.seen().is_empty());
}

// ---- connect -----------------------------------------------------------------------------------

#[test]
fn nothing_is_connected_at_first() {
    let dir = TempDir::new("fresh");
    let sync = GistSync::new(&dir.0, Arc::new(MemoryVault::new())).expect("sync");
    assert_eq!(sync.status().expect("status"), GistStatus::default());
}

#[tokio::test]
async fn connecting_with_no_id_makes_a_secret_gist_of_exactly_the_closed_list() {
    let server = TestServer::start();
    let machine = Machine::new(&server);
    machine.write("config.jsonc", CONFIG);
    machine.write("themes/lagoon.json", THEME);
    machine.write("mods/tweak.css", ".a { color: red }\n");
    machine.write(
        "spaces/Work.noren-space.json",
        "{\"format\":\"noren-space\"}",
    );
    // Files that never travel, and a file a gist cannot hold.
    machine.write("state.json", "{\"secret\":\"state\"}");
    machine.write("gallery.json", "{}");
    machine.write("plugins/p/main.js", "alert(1)");
    machine.write("scrollback/pane.txt", "history");
    machine.write("sync-spaces.json", "{}");
    machine.write("themes/Bad Id.json", "{}");
    machine.write("mods/empty.css", "");

    let status = machine.sync.connect(None).await.expect("connect");
    assert!(status.connected);
    assert!(!status.public, "the gist is secret");
    assert!(status.has_token);
    assert!(status.pending.is_empty(), "{:?}", status.pending);
    let id = status.gist_id.expect("id");
    assert!(is_valid_gist_id(&id));

    assert_eq!(
        server.file_names(&id),
        vec![
            "config.jsonc",
            "mods--tweak.css",
            "spaces--Work.noren-space.json",
            "themes--lagoon.json",
        ]
    );
    assert_eq!(
        server.file(&id, "themes--lagoon.json").as_deref(),
        Some(THEME)
    );
    let gist = lock(&server.hub).gists.get(&id).cloned().expect("gist");
    assert!(!gist.public);

    // One POST, with the token only in the header, and a user agent of the app.
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        (seen[0].method.as_str(), seen[0].path.as_str()),
        ("POST", "/gists")
    );
    assert_eq!(
        seen[0].authorization.as_deref(),
        Some(&*format!("Bearer {TOKEN}"))
    );
    assert!(
        seen[0]
            .user_agent
            .as_deref()
            .is_some_and(|ua| ua.starts_with("noren/"))
    );
    assert!(!seen[0].body.contains(TOKEN));
    assert!(!seen[0].path.contains(TOKEN));
    for secret in ["secret", "history", "alert(1)"] {
        assert!(!seen[0].body.contains(secret), "{secret} left the computer");
    }
}

#[tokio::test]
async fn the_record_is_beside_the_config_is_off_the_list_and_has_no_token() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    assert!(!is_syncable(GIST_STATE_FILE_NAME));
    assert!(machine.exists(GIST_STATE_FILE_NAME));
    let record = machine.read(GIST_STATE_FILE_NAME).expect("record");
    assert!(record.contains(&id));
    // A second computer gets the record's files only through the gist, never the record itself.
    assert!(server.file(&id, GIST_STATE_FILE_NAME).is_none());
    assert!(
        !server
            .file_names(&id)
            .iter()
            .any(|n| n.contains("sync-gist"))
    );
    // The token is in no file of the config folder.
    for (path, bytes) in machine.all_files() {
        assert!(
            !String::from_utf8_lossy(&bytes).contains(TOKEN),
            "the token is in {path}"
        );
    }
}

#[tokio::test]
async fn there_is_no_gist_to_make_without_a_file_that_may_travel() {
    let server = TestServer::start();
    let machine = Machine::new(&server);
    machine.write("state.json", "{}");
    machine.write("mods/empty.css", "");
    assert!(matches!(
        machine.sync.connect(None).await,
        Err(GistError::NothingToSend)
    ));
    assert!(server.seen().is_empty());
    assert!(!machine.exists(GIST_STATE_FILE_NAME));
}

#[tokio::test]
async fn connecting_to_a_gist_by_id_reads_it_and_copies_nothing() {
    let server = TestServer::start();
    server.put_gist(
        "abc123",
        false,
        &[("config.jsonc", CONFIG), ("themes--lagoon.json", THEME)],
    );
    let machine = Machine::new(&server);
    machine.write("mods/mine.css", ".m {}\n");
    let status = machine
        .sync
        .connect(Some("  abc123 "))
        .await
        .expect("connect");
    assert!(status.connected);
    assert_eq!(status.gist_id.as_deref(), Some("abc123"));
    assert!(!status.public);
    // Nothing came yet; the file of this computer is waiting to go.
    assert!(!machine.exists("config.jsonc"));
    assert!(!machine.exists("themes/lagoon.json"));
    assert_eq!(pending_paths(&status), vec!["mods/mine.css"]);
    assert_eq!(server.methods(), vec!["GET /gists/abc123"]);
}

#[tokio::test]
async fn a_public_gist_is_told_in_the_status() {
    let server = TestServer::start();
    server.put_gist("pub1", true, &[("config.jsonc", CONFIG)]);
    let machine = Machine::new(&server);
    let status = machine.sync.connect(Some("pub1")).await.expect("connect");
    assert!(
        status.public,
        "the person must be able to see that anyone can read it"
    );
}

#[tokio::test]
async fn an_id_that_is_not_an_id_never_reaches_the_network() {
    let server = TestServer::start();
    let machine = Machine::new(&server);
    for bad in ["", "  ", "a/b", "../gists", "abc?x=1", "abc def", "a-b"] {
        assert!(
            matches!(
                machine.sync.connect(Some(bad)).await,
                Err(GistError::InvalidGistId)
            ),
            "{bad:?}"
        );
    }
    assert!(server.seen().is_empty());
}

#[tokio::test]
async fn a_gist_that_is_not_there_is_an_error_and_connects_nothing() {
    let server = TestServer::start();
    let machine = Machine::new(&server);
    let error = machine
        .sync
        .connect(Some("missing1"))
        .await
        .expect_err("404");
    assert!(matches!(error, GistError::Http { status: 404, .. }));
    assert!(error.to_string().contains("404"));
    assert!(!machine.exists(GIST_STATE_FILE_NAME));
    assert!(!machine.sync.status().expect("status").connected);
}

#[tokio::test]
async fn connecting_again_to_the_same_gist_keeps_what_the_record_knows() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    machine.write("config.jsonc", "{ \"edited\": 1 }\n");
    let again = machine.sync.connect(Some(&id)).await.expect("again");
    // The record still says what the gist held, so the edit is still a change to send.
    assert_eq!(pending_paths(&again), vec!["config.jsonc"]);
    // Another gist starts a record of its own.
    server.put_gist("other1", false, &[("config.jsonc", CONFIG)]);
    let other = machine.sync.connect(Some("other1")).await.expect("other");
    assert_eq!(other.gist_id.as_deref(), Some("other1"));
    assert_eq!(other.pending.len(), 3, "{:?}", other.pending);
}

// ---- push --------------------------------------------------------------------------------------

#[tokio::test]
async fn push_sends_only_the_files_that_changed_and_then_there_is_nothing_pending() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    machine.write("config.jsonc", "{ \"theme\": \"other\" }\n");
    machine.write("themes/new.json", "{\"id\":\"new\"}");
    machine.write("state.json", "{\"never\":true}");
    let status = machine.sync.status().expect("status");
    assert_eq!(
        pending_paths(&status),
        vec!["config.jsonc", "themes/new.json"]
    );
    assert_eq!(status.pending[0].kind, ChangeKind::Modified);
    assert_eq!(status.pending[1].kind, ChangeKind::Added);

    server.clear_seen();
    let outcome = machine.sync.push().await.expect("push");
    assert!(outcome.pushed && outcome.committed);
    assert_eq!(outcome.files, vec!["config.jsonc", "themes/new.json"]);
    assert_eq!(
        server.methods(),
        vec![format!("GET /gists/{id}"), format!("PATCH /gists/{id}")]
    );
    let patch = &server.seen()[1];
    // Only the two changed files are in the request, with the token only in the header.
    let body: Value = serde_json::from_str(&patch.body).expect("json");
    let sent: BTreeSet<&str> = body["files"]
        .as_object()
        .expect("files")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(sent, BTreeSet::from(["config.jsonc", "themes--new.json"]));
    assert_eq!(
        patch.authorization.as_deref(),
        Some(&*format!("Bearer {TOKEN}"))
    );
    assert!(!patch.body.contains(TOKEN));
    assert_eq!(
        server.file(&id, "config.jsonc").as_deref(),
        Some("{ \"theme\": \"other\" }\n")
    );
    assert_eq!(
        server.file(&id, "themes--new.json").as_deref(),
        Some("{\"id\":\"new\"}")
    );
    assert!(server.file(&id, "state.json").is_none());
    assert!(machine.sync.status().expect("status").pending.is_empty());

    // Nothing changed since: nothing is sent.
    server.clear_seen();
    let again = machine.sync.push().await.expect("push again");
    assert!(!again.pushed && !again.committed && again.files.is_empty());
    assert_eq!(server.methods(), vec![format!("GET /gists/{id}")]);
}

#[tokio::test]
async fn push_is_refused_when_the_gist_changed_since_the_last_sync_and_sends_nothing() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    machine.write("config.jsonc", "{ \"mine\": true }\n");
    // Another computer edits a file, adds one, and a third file is edited on the web page.
    server.set_file(&id, "themes--lagoon.json", "{\"id\":\"lagoon\",\"v\":2}");
    server.set_file(&id, "themes--theirs.json", "{\"id\":\"theirs\"}");

    server.clear_seen();
    let error = machine.sync.push().await.expect_err("refused");
    let GistError::Changed(paths) = &error else {
        panic!("not Changed: {error}");
    };
    assert_eq!(paths, &vec!["themes/lagoon.json", "themes/theirs.json"]);
    assert!(error.to_string().contains("pull first"));
    // Only the read was made: no PATCH, and the gist is as the other computer left it.
    assert_eq!(server.methods(), vec![format!("GET /gists/{id}")]);
    assert_eq!(server.file(&id, "config.jsonc").as_deref(), Some(CONFIG));
    // The edit of this computer is intact and still pending.
    assert_eq!(
        machine.read("config.jsonc").as_deref(),
        Some("{ \"mine\": true }\n")
    );
    assert_eq!(
        pending_paths(&machine.sync.status().expect("status")),
        vec!["config.jsonc"]
    );
}

#[tokio::test]
async fn a_file_taken_out_of_the_gist_also_means_it_changed() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    server.remove_file(&id, "mods--tweak.css");
    machine.write("config.jsonc", "{ \"mine\": true }\n");
    assert!(matches!(
        machine.sync.push().await,
        Err(GistError::Changed(paths)) if paths == vec!["mods/tweak.css"]
    ));
    // A pull takes note (nothing is deleted here), and then the push goes through.
    assert!(matches!(
        machine.sync.pull().await,
        Ok(PullOutcome::UpToDate)
    ));
    assert!(machine.exists("mods/tweak.css"), "nothing is deleted");
    let outcome = machine.sync.push().await.expect("push after the pull");
    assert!(outcome.pushed);
    assert_eq!(outcome.files, vec!["config.jsonc", "mods/tweak.css"]);
    assert!(
        server.file(&id, "mods--tweak.css").is_some(),
        "the file is back in the gist"
    );
}

#[tokio::test]
async fn the_first_push_to_a_gist_that_has_files_waits_for_a_pull() {
    let server = TestServer::start();
    server.put_gist("abc123", false, &[("config.jsonc", "{ \"theirs\": 1 }\n")]);
    let machine = Machine::new(&server);
    machine.write("config.jsonc", CONFIG);
    machine.sync.connect(Some("abc123")).await.expect("connect");
    assert!(matches!(
        machine.sync.push().await,
        Err(GistError::Changed(paths)) if paths == vec!["config.jsonc"]
    ));
    assert_eq!(
        server.file("abc123", "config.jsonc").as_deref(),
        Some("{ \"theirs\": 1 }\n")
    );
    // The pull sees both sides differ and writes nothing.
    assert!(matches!(
        machine.sync.pull().await,
        Ok(PullOutcome::Conflicts(paths)) if paths == vec!["config.jsonc"]
    ));
}

#[tokio::test]
async fn a_gist_with_only_files_of_someone_else_takes_the_first_push() {
    let server = TestServer::start();
    server.put_gist(
        "notes1",
        false,
        &[("README.md", "my notes"), ("todo.txt", "x")],
    );
    let machine = Machine::new(&server);
    machine.write("config.jsonc", CONFIG);
    machine.sync.connect(Some("notes1")).await.expect("connect");
    let outcome = machine.sync.push().await.expect("push");
    assert!(outcome.pushed);
    assert_eq!(
        server.file_names("notes1"),
        vec!["README.md", "config.jsonc", "todo.txt"]
    );
    assert_eq!(
        server.file("notes1", "README.md").as_deref(),
        Some("my notes")
    );
}

#[tokio::test]
async fn files_over_the_ceiling_or_not_text_are_refused_before_anything_is_sent() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    server.clear_seen();

    machine.write(
        "config.jsonc",
        &"x".repeat(MAX_SYNC_FILE_BYTES as usize + 1),
    );
    let error = machine.sync.push().await.expect_err("too large");
    assert!(
        matches!(error, GistError::Local(SyncError::FileTooLarge(ref p)) if p == "config.jsonc")
    );
    machine.write("config.jsonc", CONFIG);

    fs::write(
        machine.dir.0.join("mods/tweak.css"),
        [0xff, 0xfe, 0x00, 0x61],
    )
    .expect("bytes");
    let error = machine.sync.push().await.expect_err("not text");
    assert!(matches!(error, GistError::NotText(ref p) if p == "mods/tweak.css"));

    assert!(
        server.seen().iter().all(|s| s.method == "GET"),
        "{:?}",
        server.methods()
    );
    assert_eq!(server.file(&id, "config.jsonc").as_deref(), Some(CONFIG));
}

#[tokio::test]
async fn an_empty_file_is_left_out_and_is_never_pending() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    machine.write("mods/empty.css", "");
    machine.write("config.jsonc", "{ \"a\": 1 }\n");
    let status = machine.sync.status().expect("status");
    assert_eq!(pending_paths(&status), vec!["config.jsonc"]);
    let outcome = machine.sync.push().await.expect("push");
    assert_eq!(outcome.files, vec!["config.jsonc"]);
    assert!(server.file(&id, "mods--empty.css").is_none());
}

#[tokio::test]
async fn the_record_follows_what_the_gist_answers_when_it_keeps_other_bytes() {
    // If the gist changes the bytes it is given (a line ending, say), the record must hold what the
    // gist holds, or every later push would find the gist "changed" and be refused for good.
    let server = TestServer::start();
    server.normalize_newlines(true);
    let machine = Machine::new(&server);
    machine.write("config.jsonc", "{\r\n}\r\n");
    let id = machine
        .sync
        .connect(None)
        .await
        .expect("connect")
        .gist_id
        .expect("id");
    assert_eq!(server.file(&id, "config.jsonc").as_deref(), Some("{\n}\n"));
    // The file of this computer still has the other line endings, so it stays pending; sending it
    // again is harmless, and the push is not refused.
    machine.write("mods/a.css", ".a {}\r\n");
    let first = machine.sync.push().await.expect("push");
    assert!(first.pushed);
    assert_eq!(first.files, vec!["config.jsonc", "mods/a.css"]);
    let second = machine.sync.push().await.expect("push again");
    assert!(second.pushed, "not refused as if the gist had changed");
    // A pull finds nothing the gist changed.
    assert_eq!(
        machine.sync.pull().await.expect("pull"),
        PullOutcome::UpToDate
    );
}

// ---- pull --------------------------------------------------------------------------------------

#[tokio::test]
async fn a_clean_pull_brings_the_files_the_gist_added_or_changed_and_only_those() {
    let server = TestServer::start();
    let (a, id) = connected_with_files(&server).await;
    // A second computer joins, with a file of its own that the gist does not have.
    let b = Machine::new(&server);
    b.write("mods/b-only.css", ".b {}\n");
    b.sync.connect(Some(&id)).await.expect("connect b");
    // The first pull on b brings the three files and leaves its own alone.
    let pulled = b.sync.pull().await.expect("first pull");
    assert_eq!(
        pulled,
        PullOutcome::Updated(vec![
            "config.jsonc".into(),
            "mods/tweak.css".into(),
            "themes/lagoon.json".into()
        ])
    );
    assert_eq!(b.read("config.jsonc").as_deref(), Some(CONFIG));
    assert_eq!(b.read("themes/lagoon.json").as_deref(), Some(THEME));
    assert_eq!(b.read("mods/b-only.css").as_deref(), Some(".b {}\n"));
    assert_eq!(
        pending_paths(&b.sync.status().expect("status")),
        vec!["mods/b-only.css"]
    );
    // Nothing new: a second pull writes nothing.
    assert_eq!(b.sync.pull().await.expect("again"), PullOutcome::UpToDate);

    // a changes a theme and adds a space; b has not touched them: both arrive.
    a.write("themes/lagoon.json", "{\"id\":\"lagoon\",\"v\":2}");
    a.write(
        "spaces/Work.noren-space.json",
        "{\"format\":\"noren-space\"}",
    );
    assert!(a.sync.push().await.expect("a pushes").pushed);
    assert_eq!(
        b.sync.pull().await.expect("pull"),
        PullOutcome::Updated(vec![
            "spaces/Work.noren-space.json".into(),
            "themes/lagoon.json".into()
        ])
    );
    assert_eq!(
        b.read("themes/lagoon.json").as_deref(),
        Some("{\"id\":\"lagoon\",\"v\":2}")
    );
    // b's own file still waits, and now b can push it: the gist has not moved since the pull.
    let pushed = b.sync.push().await.expect("b pushes");
    assert_eq!(pushed.files, vec!["mods/b-only.css"]);
    // a is behind now: its push is refused until it pulls.
    a.write("config.jsonc", "{ \"a\": 2 }\n");
    assert!(matches!(a.sync.push().await, Err(GistError::Changed(_))));
    assert_eq!(
        a.sync.pull().await.expect("a pulls"),
        PullOutcome::Updated(vec!["mods/b-only.css".into()])
    );
    assert!(a.sync.push().await.expect("a pushes again").pushed);
}

#[tokio::test]
async fn a_local_edit_the_gist_did_not_touch_survives_a_pull() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    machine.write("config.jsonc", "{ \"mine\": true }\n");
    server.set_file(&id, "themes--lagoon.json", "{\"id\":\"lagoon\",\"v\":2}");
    let pulled = machine.sync.pull().await.expect("pull");
    assert_eq!(
        pulled,
        PullOutcome::Updated(vec!["themes/lagoon.json".into()])
    );
    assert_eq!(
        machine.read("config.jsonc").as_deref(),
        Some("{ \"mine\": true }\n")
    );
    assert_eq!(
        pending_paths(&machine.sync.status().expect("status")),
        vec!["config.jsonc"]
    );
}

#[tokio::test]
async fn a_file_changed_here_and_there_is_a_conflict_that_writes_nothing_at_all() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    // Both sides edit the config; the gist also has a theme that would come cleanly.
    machine.write("config.jsonc", "{ \"here\": 1 }\n");
    server.set_file(&id, "config.jsonc", "{ \"there\": 2 }\n");
    server.set_file(&id, "themes--new.json", "{\"id\":\"new\"}");
    // And a second file in conflict.
    machine.write("mods/tweak.css", ".local {}\n");
    server.set_file(&id, "mods--tweak.css", ".remote {}\n");

    let record_before = machine.read(GIST_STATE_FILE_NAME);
    let outcome = machine.sync.pull().await.expect("pull");
    assert_eq!(
        outcome,
        PullOutcome::Conflicts(vec!["config.jsonc".into(), "mods/tweak.css".into()])
    );
    // Nothing was written: the local edits are intact and the clean theme did not come either.
    assert_eq!(
        machine.read("config.jsonc").as_deref(),
        Some("{ \"here\": 1 }\n")
    );
    assert_eq!(
        machine.read("mods/tweak.css").as_deref(),
        Some(".local {}\n")
    );
    assert!(!machine.exists("themes/new.json"));
    assert_eq!(
        machine.read(GIST_STATE_FILE_NAME),
        record_before,
        "the record did not move"
    );
    // The gist is as the other side left it.
    assert_eq!(
        server.file(&id, "config.jsonc").as_deref(),
        Some("{ \"there\": 2 }\n")
    );
    // And the push is refused too: the gist changed.
    assert!(matches!(
        machine.sync.push().await,
        Err(GistError::Changed(_))
    ));

    // The person settles it by hand (takes the gist's text for one, keeps the other as it is).
    machine.write("config.jsonc", "{ \"there\": 2 }\n");
    server.set_file(&id, "mods--tweak.css", ".local {}\n");
    let settled = machine.sync.pull().await.expect("pull after settling");
    assert_eq!(
        settled,
        PullOutcome::Updated(vec!["themes/new.json".into()])
    );
    assert_eq!(
        machine.read("themes/new.json").as_deref(),
        Some("{\"id\":\"new\"}")
    );
    assert!(machine.sync.status().expect("status").pending.is_empty());
}

#[tokio::test]
async fn files_of_the_gist_off_the_list_are_never_written() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    for (name, text) in [
        ("README.md", "hello"),
        ("state.json", "{\"owned\":true}"),
        ("gallery.json", "{}"),
        ("sync-gist.json", "{\"version\":1}"),
        ("sync-spaces.json", "{}"),
        ("themes--../../evil.json", "{}"),
        ("themes--..%2f..%2fevil.json", "{}"),
        ("themes--Bad Id.json", "{}"),
        ("themes--a--b.json", "{}"),
        ("mods--x.js", "alert(1)"),
        ("spaces--x.json", "{}"),
        ("plugins--p.js", "alert(2)"),
        ("config.jsonc.bak", "{}"),
        ("themes/lagoon.json", "{\"id\":\"sneaky\"}"),
        ("..", "{}"),
    ] {
        server.set_file(&id, name, text);
    }
    server.set_file(&id, "themes--fine.json", "{\"id\":\"fine\"}");
    let before = machine.all_files().len();
    let pulled = machine.sync.pull().await.expect("pull");
    assert_eq!(
        pulled,
        PullOutcome::Updated(vec!["themes/fine.json".into()])
    );
    assert_eq!(
        machine.all_files().len(),
        before + 1,
        "exactly one file came"
    );
    for path in [
        "README.md",
        "state.json",
        "gallery.json",
        "sync-spaces.json",
        "evil.json",
    ] {
        assert!(!machine.exists(path), "{path}");
    }
    assert!(!machine.exists("../evil.json"));
    assert_eq!(machine.read("themes/lagoon.json").as_deref(), Some(THEME));
    // The names off the list do not make the gist look changed, either.
    machine.write("config.jsonc", "{ \"x\": 1 }\n");
    assert!(machine.sync.push().await.expect("push").pushed);
}

#[tokio::test]
async fn a_file_of_the_gist_cut_short_by_the_api_is_not_taken() {
    let server = TestServer::start();
    let (machine, id) = connected_with_files(&server).await;
    server.set_file(
        &id,
        "themes--big.json",
        "{\"id\":\"big\",\"padding\":\"...\"}",
    );
    server.truncate(&id, "themes--big.json");
    let error = machine.sync.pull().await.expect_err("truncated");
    assert!(matches!(
        error,
        GistError::Local(SyncError::FileTooLarge(ref p)) if p == "themes/big.json"
    ));
    assert!(!machine.exists("themes/big.json"));
    // A cut file that is not on the list is nobody's business.
    server.remove_file(&id, "themes--big.json");
    server.set_file(&id, "notes.txt", "long text");
    server.truncate(&id, "notes.txt");
    assert_eq!(
        machine.sync.pull().await.expect("pull"),
        PullOutcome::UpToDate
    );
}

#[tokio::test]
async fn pull_and_push_need_a_connected_gist() {
    let server = TestServer::start();
    let machine = Machine::new(&server);
    assert!(matches!(
        machine.sync.push().await,
        Err(GistError::NotConnected)
    ));
    assert!(matches!(
        machine.sync.pull().await,
        Err(GistError::NotConnected)
    ));
    assert!(server.seen().is_empty());
}

#[tokio::test]
async fn a_record_that_cannot_be_read_is_an_error_and_not_an_empty_record() {
    let server = TestServer::start();
    let machine = Machine::new(&server);
    for damaged in [
        "not json",
        r#"{"version":2,"gistId":"abc","public":false,"files":{}}"#,
        r#"{"version":1,"gistId":"a/b","public":false,"files":{}}"#,
        r#"{"version":1,"gistId":"abc","files":{}}"#,
        r#"{"version":1,"gistId":"abc","public":false,"files":{"config.jsonc":"zz"}}"#,
        r#"{"version":1,"gistId":"abc","public":false}"#,
    ] {
        machine.write(GIST_STATE_FILE_NAME, damaged);
        let error = machine.sync.status().expect_err(damaged);
        assert!(matches!(error, GistError::Record(_)), "{damaged}");
        assert!(error.to_string().contains(GIST_STATE_FILE_NAME));
        assert!(matches!(
            machine.sync.pull().await,
            Err(GistError::Record(_))
        ));
    }
    assert!(server.seen().is_empty());
    // A path off the list in the record is dropped, not an error.
    machine.write(
        GIST_STATE_FILE_NAME,
        &format!(
            r#"{{"version":1,"gistId":"abc","public":false,"files":{{"state.json":"{}"}}}}"#,
            "a".repeat(64)
        ),
    );
    assert!(machine.sync.status().expect("status").connected);
}

// ---- errors and limits -------------------------------------------------------------------------

#[tokio::test]
async fn an_http_error_has_the_status_and_the_message_but_never_the_token() {
    let server = TestServer::start();
    let (machine, _) = connected_with_files(&server).await;
    // A server that echoes what it was given into its message.
    server.force(Some(Forced::Reply(
        401,
        json!({ "message": format!("Bad credentials for {TOKEN}"), "documentation_url": "x" })
            .to_string(),
    )));
    let error = machine.sync.push().await.expect_err("401");
    assert!(matches!(error, GistError::Http { status: 401, .. }));
    let text = error.to_string();
    let debug = format!("{error:?}");
    assert!(
        text.contains("401") && text.contains("Bad credentials"),
        "{text}"
    );
    assert!(text.contains("token was refused"), "{text}");
    assert!(
        !text.contains(TOKEN) && !debug.contains(TOKEN),
        "{text} / {debug}"
    );
    assert!(text.contains(HIDDEN_TOKEN), "{text}");

    // The same for each step, and for answers that are not JSON or are long.
    for forced in [
        Forced::Reply(500, format!("<html>{TOKEN}</html>")),
        Forced::Reply(
            403,
            json!({ "message": "x".repeat(5000) + TOKEN }).to_string(),
        ),
        Forced::Reply(
            422,
            json!({ "message": ["not", "text", TOKEN] }).to_string(),
        ),
    ] {
        server.force(Some(forced));
        for error in [
            machine.sync.pull().await.expect_err("fails"),
            machine.sync.push().await.expect_err("fails"),
            machine
                .sync
                .connect(Some("abc123"))
                .await
                .expect_err("fails"),
            machine.sync.connect(None).await.expect_err("fails"),
        ] {
            let text = format!("{error} {error:?}");
            assert!(!text.contains(TOKEN), "{text}");
            assert!(
                text.chars().count() < 1000,
                "the message is cut: {}",
                text.len()
            );
        }
    }
}

#[tokio::test]
async fn a_server_that_is_not_there_gives_an_error_without_the_token_or_the_address() {
    let server = TestServer::start();
    let (machine, _) = connected_with_files(&server).await;
    // A sync pointed at a port nobody listens on.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        format!("http://{}", listener.local_addr().expect("addr"))
    };
    let dir = TempDir::new("closed");
    fs::copy(
        machine.dir.0.join(GIST_STATE_FILE_NAME),
        dir.0.join(GIST_STATE_FILE_NAME),
    )
    .expect("copy the record");
    let vault = Arc::new(MemoryVault::new());
    vault.set(SYNC_GIST_TOKEN_ENTRY, TOKEN).expect("token");
    let sync = GistSync::at(
        &dir.0,
        vault,
        &closed,
        Duration::from_secs(5),
        MAX_GIST_RESPONSE_BYTES,
    )
    .expect("sync");
    let error = sync.pull().await.expect_err("nobody answers");
    assert!(matches!(error, GistError::Network(_)), "{error}");
    let text = error.to_string();
    assert!(!text.contains(TOKEN), "{text}");
    assert!(!text.contains(&closed), "{text}");
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let server = TestServer::start();
    let (machine, _) = connected_with_files(&server).await;
    server.force(Some(Forced::Redirect));
    server.clear_seen();
    let error = machine.sync.pull().await.expect_err("redirect");
    assert!(
        matches!(error, GistError::Http { status: 302, .. }),
        "{error}"
    );
    assert_eq!(server.seen().len(), 1, "the redirect was not followed");
}

#[tokio::test]
async fn a_server_that_says_nothing_ends_in_a_timeout() {
    let server = TestServer::start();
    let (machine, _) = connected_with_files(&server).await;
    server.force(Some(Forced::Silent));
    let quick = Machine::with(&server, Duration::from_millis(400), MAX_GIST_RESPONSE_BYTES);
    fs::copy(
        machine.dir.0.join(GIST_STATE_FILE_NAME),
        quick.dir.0.join(GIST_STATE_FILE_NAME),
    )
    .expect("copy the record");
    let started = std::time::Instant::now();
    let error = quick.sync.pull().await.expect_err("no answer");
    assert!(matches!(error, GistError::Timeout), "{error}");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn an_answer_over_the_ceiling_is_refused() {
    let server = TestServer::start();
    let (machine, _) = connected_with_files(&server).await;
    let small = Machine::with(&server, Duration::from_secs(10), 1024);
    fs::copy(
        machine.dir.0.join(GIST_STATE_FILE_NAME),
        small.dir.0.join(GIST_STATE_FILE_NAME),
    )
    .expect("copy the record");
    server.force(Some(Forced::Huge(4096)));
    let error = small.sync.pull().await.expect_err("too large");
    assert!(matches!(error, GistError::TooLarge(1024)), "{error}");
    // A gist that is not JSON, or not a gist, is a bad answer.
    server.force(Some(Forced::Reply(200, "not json".to_owned())));
    assert!(matches!(
        machine.sync.pull().await,
        Err(GistError::BadResponse(_))
    ));
    for body in [
        "[]",
        "{}",
        r#"{"id":"abc","files":[]}"#,
        r#"{"id":"a/b","files":{}}"#,
        r#"{"id":"abc"}"#,
    ] {
        server.force(Some(Forced::Reply(200, body.to_owned())));
        assert!(
            matches!(machine.sync.pull().await, Err(GistError::BadResponse(_))),
            "{body}"
        );
    }
    // Another gist than the one asked for is not taken for it.
    let id = machine.sync.status().expect("status").gist_id.expect("id");
    server.force(Some(Forced::Reply(
        200,
        json!({ "id": "someoneelse", "public": false, "files": {} }).to_string(),
    )));
    let error = machine.sync.pull().await.expect_err("another gist");
    assert!(matches!(error, GistError::BadResponse(_)), "{id} / {error}");
}

#[tokio::test]
async fn a_gist_the_api_lists_in_part_is_refused() {
    let server = TestServer::start();
    let (machine, _) = connected_with_files(&server).await;
    server.force(Some(Forced::Reply(
        200,
        json!({
            "id": machine.sync.status().expect("status").gist_id,
            "public": false,
            "truncated": true,
            "files": {},
        })
        .to_string(),
    )));
    assert!(matches!(
        machine.sync.pull().await,
        Err(GistError::Truncated)
    ));
    assert!(matches!(
        machine.sync.push().await,
        Err(GistError::Truncated)
    ));
}

#[tokio::test]
async fn each_computer_makes_its_own_gist_and_the_ids_do_not_clash() {
    let server = TestServer::start();
    let (_, first) = connected_with_files(&server).await;
    let (_, second) = connected_with_files(&server).await;
    assert_ne!(first, second);
    assert_eq!(server.gist_ids().len(), 2);
}

#[test]
fn the_texts_of_the_errors_are_plain() {
    let errors = [
        GistError::NotConnected,
        GistError::NoToken,
        GistError::InvalidGistId,
        GistError::Timeout,
        GistError::Truncated,
        GistError::NothingToSend,
        GistError::TooLarge(10),
        GistError::Changed(vec!["a".into(), "b".into()]),
        GistError::Http {
            status: 404,
            message: "Not Found".into(),
        },
        GistError::Http {
            status: 418,
            message: String::new(),
        },
    ];
    for error in errors {
        let text = error.to_string();
        assert!(!text.is_empty() && !text.contains("{}"), "{text}");
    }
    let many = GistError::Changed((0..8).map(|n| format!("p{n}")).collect()).to_string();
    assert!(many.contains("and 3 more"), "{many}");
}

//! Tests of the update of the app, through the real updater plugin in the mock runtime of Tauri and
//! a server on `127.0.0.1` at a port the system picks that plays the feed and the package. The
//! packages are signed with keys made for tests (the private halves are not kept anywhere); the
//! installer is a recorder, so nothing is installed and no window is opened. Nothing touches the
//! network of the machine.
//!
//! The fixtures below were made with the Tauri CLI (`tauri signer generate -p ""` twice, then
//! `tauri signer sign --app-version 0.2.0` on `PACKAGE`). To make new ones, do the same and replace
//! the strings: the signatures are the text of the `.sig` files, the keys the text of the `.pub`
//! files.

use super::*;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use tauri::Listener;
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};

/// The public key the packages of these tests are signed for.
const TRUSTED_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBFNEMxMDczMTE1OTkwMUIKUldRYmtGa1JjeEJNRGlOcXN4dlBTZi9SUGs1L3FMS25zS2R1MGwwM1IyWjdPaGV0Mit4TXRmY1AK";

/// A file that is not an installer: it only exists to be signed.
const PACKAGE: &[u8] = b"NOREN-UPDATER-TEST-PACKAGE 0.2.0: this is not an installer, it only exists to be signed with a test key.";

/// `PACKAGE` signed with the key of `TRUSTED_PUBKEY`, for version 0.2.0.
const SIGNATURE_FOR_0_2_0: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRYmtGa1JjeEJNRHVKTlJ1ZmlYTElzUjQ2ZzlicTdaVnJjMFRaZE9JNzBiSktRbnBONklLaE5jU2VFN1hBQjVUcyt0aXBaTHF6RFRyRTNNay96Um5talg0RWd4cU1UWmdBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNjAyMjk0CWZpbGU6cGFja2FnZS5iaW4JdmVyc2lvbjowLjIuMApDODVDTjZ0OFdMeEV1OW9nYW1RNG42S3o3Znd4SjNoOHVOMEVuTzR4YUZuZFVsL2tQZWtlT3dpM1cvSHdtQjY2SlFURmVLdGxVKzUycmVhYkVtWFhCQT09Cg==";

/// `PACKAGE` signed for version 0.2.0 with another key than `TRUSTED_PUBKEY`'s.
const SIGNATURE_OF_ANOTHER_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSVVdWeUV0Lzh4cG9ZYXB0QzJxYnFRQVZGVmhKN3B5aGZJRlFrSjR2Vmlyc0dyYVZBcENCYVU0S3N1YWhabUVDT2ZvVkN5RWxmZnpIWjByY0RqWnBoZ0tOUmJMQ2V1bVFFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNjAyMjk1CWZpbGU6cGFja2FnZS5iaW4JdmVyc2lvbjowLjIuMAp2VnhzTHo4bUQzSFRkVDhRcVFtZjBLWHZxWVREWGxlUUcrRmpWNGJzNnRNWWZiNWRpOVZsaXFCWDFGUVBoMUlFbmdtTWlGazJLWXRFYmdzbDBhUk1Bdz09Cg==";

/// `PACKAGE` signed with the key of `TRUSTED_PUBKEY`, without a version in the signature (the
/// Tauri CLI of before `--app-version`).
const SIGNATURE_WITHOUT_VERSION: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRYmtGa1JjeEJNRHV3cTJtWExTaDRJekZaL2w1TUxrSHc0WlluUnFUOFBteDdyelFQdVNlcnVaTFd4bjJacXRNUG5QS0VYVGkyMy92WkM5SjAwM0sxQ0RtU0pwMDJtWkFZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNjAyMjk2CWZpbGU6cGFja2FnZS5iaW4KNzF1SnZiaEh3Zy9GMEZ6WjFYdURjNFhkUWdSQXY3WVc1VWtLZUgzUEpZVW5BYitDKzNNWWlQY2xrSUhQamdtZldQTFgwOFZkUElYMEJROTY3MEpNQUE9PQo=";

/// The version the mock app says it is.
const CURRENT: &str = "0.1.0";

// ---- the server -----------------------------------------------------------------------------

#[derive(Clone)]
struct Route {
    status: u16,
    body: Vec<u8>,
    /// Wait this long after the head, before the body.
    hang: Option<Duration>,
}

impl Route {
    fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            body: body.into(),
            hang: None,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            ..Self::ok(Vec::new())
        }
    }

    fn hanging(mut self, wait: Duration) -> Self {
        self.hang = Some(wait);
        self
    }
}

struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Server {
    /// Starts a server; `routes` is given the port, for a feed that names the package.
    fn start(routes: impl FnOnce(u16) -> Vec<(&'static str, Route)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let port = listener.local_addr().expect("address").port();
        let routes: Arc<HashMap<String, Route>> = Arc::new(
            routes(port)
                .into_iter()
                .map(|(path, route)| (path.to_owned(), route))
                .collect(),
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let routes = Arc::clone(&routes);
                let log = Arc::clone(&log);
                std::thread::spawn(move || serve(stream, &routes, &log));
            }
        });
        Self { port, seen }
    }

    /// A server with the feed at `/latest.json` and `PACKAGE` at `/package.bin`; the feed is made
    /// by `feed` from the address of the package.
    fn with_package(feed: impl FnOnce(&str) -> String, package: &[u8]) -> Self {
        Self::start(|port| {
            vec![
                (
                    "/latest.json",
                    Route::ok(feed(&format!("http://127.0.0.1:{port}/package.bin"))),
                ),
                ("/package.bin", Route::ok(package)),
            ]
        })
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn seen(&self) -> Vec<String> {
        self.seen.lock().expect("log").clone()
    }
}

fn serve(mut stream: TcpStream, routes: &HashMap<String, Route>, log: &Mutex<Vec<String>>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let path = head
        .lines()
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .unwrap_or("/")
        .to_owned();
    log.lock().expect("log").push(path.clone());
    let route = routes
        .get(&path)
        .cloned()
        .unwrap_or_else(|| Route::status(404));
    let out = format!(
        "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        route.status,
        route.body.len()
    );
    if stream.write_all(out.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    if let Some(wait) = route.hang {
        std::thread::sleep(wait);
    }
    for piece in route.body.chunks(32) {
        if stream.write_all(piece).is_err() {
            return;
        }
        let _ = stream.flush();
    }
}

// ---- the app ----------------------------------------------------------------------------------

/// The static feed of the Tauri updater, with the entry of this platform.
fn feed(version: &str, url: &str, signature: &str) -> String {
    let target = tauri_plugin_updater::target().expect("a platform the updater supports");
    json!({
        "version": version,
        "notes": "Fixes\r\n- one thing",
        "pub_date": "2026-10-21T12:00:00Z",
        "platforms": { target: { "url": url, "signature": signature } }
    })
    .to_string()
}

/// The `plugins > updater` of a build whose feed is at `port` of `127.0.0.1` and whose packages are
/// signed for `pubkey`.
fn plugin_config(port: u16, pubkey: &str) -> Value {
    json!({
        "pubkey": pubkey,
        "endpoints": [format!("http://127.0.0.1:{port}/latest.json")],
        "requireSignedVersion": true,
        "dangerousInsecureTransportProtocol": true,
    })
}

/// A mock app with the updater plugin configured as `config` says, as the real one is by
/// tauri.conf.json.
fn app_with(config: &Value) -> tauri::App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert(PLUGIN_NAME.to_owned(), config.clone());
    mock_builder()
        .plugin(plugin())
        .build(context)
        .expect("build the mock app")
}

/// What the recorder was asked to install: the version and the bytes.
#[derive(Default)]
struct Recorder {
    installed: Mutex<Vec<(String, Vec<u8>)>>,
}

impl PackageInstaller for Recorder {
    fn install(&self, update: &Update, package: Vec<u8>) -> Result<(), UpdateError> {
        self.installed
            .lock()
            .expect("log")
            .push((update.version.clone(), package));
        Ok(())
    }
}

impl Recorder {
    fn installed(&self) -> Vec<(String, Vec<u8>)> {
        self.installed.lock().expect("log").clone()
    }
}

/// An app, an update state over `server` with the recorder, and the recorder.
fn setup(
    server: &Server,
    pubkey: &str,
    limits: UpdateLimits,
) -> (tauri::App<MockRuntime>, UpdateState, Arc<Recorder>) {
    let config = plugin_config(server.port, pubkey);
    let app = app_with(&config);
    assert_eq!(app.package_info().version.to_string(), CURRENT);
    let recorder = Arc::new(Recorder::default());
    let state = UpdateState::new(&config, CURRENT.to_owned(), recorder.clone(), limits);
    (app, state, recorder)
}

fn trusted(server: &Server) -> (tauri::App<MockRuntime>, UpdateState, Arc<Recorder>) {
    setup(server, TRUSTED_PUBKEY, UpdateLimits::default())
}

// ---- an update that is valid ------------------------------------------------------------------

#[tokio::test]
async fn a_valid_update_is_found_downloaded_checked_and_handed_to_the_installer() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (app, state, recorder) = trusted(&server);
    assert_eq!(
        state.status(),
        UpdateStatusDto {
            configured: true,
            current_version: CURRENT.to_owned(),
            pending: None
        }
    );

    let found = state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    assert_eq!(found.version, "0.2.0");
    assert_eq!(found.current_version, CURRENT);
    assert_eq!(found.notes.as_deref(), Some("Fixes\n- one thing"));
    assert_eq!(found.published_at, Some(1_792_584_000));
    // The check read the feed and nothing else: no package, nothing installed.
    assert_eq!(server.seen(), ["/latest.json"]);
    assert!(recorder.installed().is_empty());
    assert_eq!(
        state.status().pending,
        Some(UpdateInfoDto::from(&found)),
        "the update found is kept"
    );

    let mut told = Vec::new();
    state
        .install(|progress| told.push(progress))
        .await
        .expect("the install");
    assert_eq!(server.seen(), ["/latest.json", "/package.bin"]);
    assert_eq!(
        recorder.installed(),
        [("0.2.0".to_owned(), PACKAGE.to_vec())]
    );
    assert_eq!(
        told.last().map(|p| (p.downloaded, p.total)),
        Some((PACKAGE.len() as u64, Some(PACKAGE.len() as u64)))
    );
    assert_eq!(
        state.status().pending,
        None,
        "an installed update is not pending"
    );
}

#[tokio::test]
async fn a_feed_in_the_dynamic_format_is_accepted_too() {
    let server = Server::with_package(
        |url| {
            json!({ "version": "v0.2.0", "url": url, "signature": SIGNATURE_FOR_0_2_0 }).to_string()
        },
        PACKAGE,
    );
    let (app, state, recorder) = trusted(&server);
    let found = state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    assert_eq!(found.version, "0.2.0", "the v of a tag is dropped");
    state.install(|_| {}).await.expect("the install");
    assert_eq!(recorder.installed().len(), 1);
}

#[tokio::test]
async fn a_prerelease_of_a_later_version_is_newer_and_one_of_this_version_is_not() {
    for (announced, newer) in [
        ("0.2.0-beta.1", true),
        ("0.1.1", true),
        ("1.0.0", true),
        ("0.1.0", false),
        ("0.1.0-rc.1", false),
        ("0.0.9", false),
        ("0.1.0+build.5", false),
    ] {
        let server = Server::with_package(|url| feed(announced, url, SIGNATURE_FOR_0_2_0), PACKAGE);
        let (app, state, _recorder) = trusted(&server);
        let found = state.check(app.handle()).await.expect("the check");
        assert_eq!(found.is_some(), newer, "{announced} against {CURRENT}");
    }
}

// ---- an update that is refused ----------------------------------------------------------------

#[tokio::test]
async fn a_version_that_is_not_newer_is_no_update_and_nothing_is_kept() {
    for announced in ["0.1.0", "0.0.9", "0.0.1"] {
        let server = Server::with_package(|url| feed(announced, url, SIGNATURE_FOR_0_2_0), PACKAGE);
        let (app, state, recorder) = trusted(&server);
        assert_eq!(
            state.check(app.handle()).await,
            Ok(None),
            "{announced} against {CURRENT}"
        );
        assert_eq!(state.status().pending, None);
        assert_eq!(
            state.install(|_| {}).await,
            Err(UpdateError::NothingToInstall)
        );
        assert!(recorder.installed().is_empty());
        assert_eq!(server.seen(), ["/latest.json"], "{announced}");
    }
}

#[tokio::test]
async fn a_newer_version_with_no_package_for_this_platform_is_refused() {
    let server = Server::start(|port| {
        let feed = json!({
            "version": "0.2.0",
            "platforms": {
                "plan9-mips": {
                    "url": format!("http://127.0.0.1:{port}/package.bin"),
                    "signature": SIGNATURE_FOR_0_2_0
                }
            }
        });
        vec![
            ("/latest.json", Route::ok(feed.to_string())),
            ("/package.bin", Route::ok(PACKAGE)),
        ]
    });
    let (app, state, recorder) = trusted(&server);
    let Err(UpdateError::Refused(why)) = state.check(app.handle()).await else {
        panic!("a release with no package for this platform was accepted");
    };
    assert!(why.contains("no package for this platform"), "{why}");
    assert_eq!(state.status().pending, None);
    assert_eq!(server.seen(), ["/latest.json"]);
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn a_signature_made_with_another_key_is_refused_and_nothing_is_installed() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_OF_ANOTHER_KEY), PACKAGE);
    let (app, state, recorder) = trusted(&server);
    // The feed itself is well formed, so the update is found: it is the package that is refused.
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    let Err(UpdateError::Refused(why)) = state.install(|_| {}).await else {
        panic!("a package signed with another key was installed");
    };
    assert!(why.contains("signature does not match"), "{why}");
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn a_package_that_was_changed_by_one_byte_is_refused_and_nothing_is_installed() {
    for position in [0, PACKAGE.len() / 2, PACKAGE.len() - 1] {
        let mut altered = PACKAGE.to_vec();
        altered[position] ^= 0x01;
        let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), &altered);
        let (app, state, recorder) = trusted(&server);
        state
            .check(app.handle())
            .await
            .expect("the check")
            .expect("an update");
        let Err(UpdateError::Refused(why)) = state.install(|_| {}).await else {
            panic!("a package changed at byte {position} was installed");
        };
        assert!(why.contains("signature does not match"), "{why}");
        assert!(recorder.installed().is_empty(), "byte {position}");
    }
}

#[tokio::test]
async fn a_package_shorter_or_longer_than_the_signed_one_is_refused() {
    let mut longer = PACKAGE.to_vec();
    longer.push(b'!');
    for package in [&PACKAGE[..PACKAGE.len() - 1], &longer[..], &b""[..]] {
        let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), package);
        let (app, state, recorder) = trusted(&server);
        state
            .check(app.handle())
            .await
            .expect("the check")
            .expect("an update");
        assert!(matches!(
            state.install(|_| {}).await,
            Err(UpdateError::Refused(_))
        ));
        assert!(recorder.installed().is_empty(), "{} bytes", package.len());
    }
}

#[tokio::test]
async fn a_signature_that_is_not_one_is_refused() {
    for signature in ["", "not base64 at all!", "dGhpcyBpcyBub3QgYSBzaWduYXR1cmU="] {
        let server = Server::with_package(|url| feed("0.2.0", url, signature), PACKAGE);
        let (app, state, recorder) = trusted(&server);
        state
            .check(app.handle())
            .await
            .expect("the check")
            .expect("an update");
        assert!(
            matches!(state.install(|_| {}).await, Err(UpdateError::Refused(_))),
            "{signature:?}"
        );
        assert!(recorder.installed().is_empty());
    }
}

#[tokio::test]
async fn a_package_is_refused_for_a_key_that_did_not_sign_it() {
    // The feed and the package are the valid ones, the build holds another key.
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let other_key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEE2MzFGRkI3ODQ1QzU5NTQKUldSVVdWeUV0Lzh4cGpLVkxhcjBmV09EVEI3WnVyNkdWaVMwVVY5VldmTHhVNStGY1VOdFhsaEkK";
    let (app, state, recorder) = setup(&server, other_key, UpdateLimits::default());
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    assert!(matches!(
        state.install(|_| {}).await,
        Err(UpdateError::Refused(_))
    ));
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn a_feed_cannot_pair_a_new_version_with_an_older_signed_package() {
    // The package was signed for 0.2.0; a feed that announces 9.9.9 with it is the downgrade replay.
    let server = Server::with_package(|url| feed("9.9.9", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (app, state, recorder) = trusted(&server);
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    let Err(UpdateError::Refused(why)) = state.install(|_| {}).await else {
        panic!("a package signed for another version was installed");
    };
    assert!(
        why.contains("signed for version 0.2.0, not for 9.9.9"),
        "{why}"
    );
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn a_signature_that_does_not_say_its_version_is_refused() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_WITHOUT_VERSION), PACKAGE);
    let (app, state, recorder) = trusted(&server);
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    let Err(UpdateError::Refused(why)) = state.install(|_| {}).await else {
        panic!("a signature with no version was accepted");
    };
    assert!(why.contains("does not say which version"), "{why}");
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn a_feed_that_is_not_the_format_of_the_updater_is_refused() {
    for body in [
        // No platforms and no url.
        json!({ "version": "0.2.0" }),
        // No version.
        json!({ "platforms": {} }),
        // A version that is not one.
        json!({ "version": "soon", "platforms": {} }),
        // A package address that is not an address.
        json!({ "version": "0.2.0", "url": "nowhere", "signature": SIGNATURE_FOR_0_2_0 }),
        // A date that is not one.
        json!({ "version": "0.2.0", "pub_date": "yesterday", "url": "https://example.com/p", "signature": "s" }),
    ] {
        let server = Server::start(|_| vec![("/latest.json", Route::ok(body.to_string()))]);
        let (app, state, recorder) = trusted(&server);
        assert!(
            matches!(
                state.check(app.handle()).await,
                Err(UpdateError::BadFeed(_))
            ),
            "{body}"
        );
        assert_eq!(state.status().pending, None);
        assert!(recorder.installed().is_empty());
    }
}

#[tokio::test]
async fn a_package_address_that_is_not_https_is_not_downloaded() {
    for url in [
        "http://example.com/package.bin",
        "ftp://example.com/package.bin",
        "https://user:pw@example.com/package.bin",
    ] {
        let server = Server::with_package(|_| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
        let (app, state, recorder) = trusted(&server);
        state
            .check(app.handle())
            .await
            .expect("the check")
            .expect("an update");
        assert!(
            matches!(
                state.install(|_| {}).await,
                Err(UpdateError::InsecureAddress(_))
            ),
            "{url}"
        );
        assert_eq!(server.seen(), ["/latest.json"], "{url}");
        assert!(recorder.installed().is_empty());
    }
}

#[tokio::test]
async fn a_package_over_the_ceiling_is_not_kept_and_not_installed() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let limits = UpdateLimits {
        max_package_bytes: PACKAGE.len() as u64 - 1,
        ..UpdateLimits::default()
    };
    let (app, state, recorder) = setup(&server, TRUSTED_PUBKEY, limits);
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    assert_eq!(
        state.install(|_| {}).await,
        Err(UpdateError::TooLarge(PACKAGE.len() as u64 - 1))
    );
    assert!(recorder.installed().is_empty());
    // A package of exactly the ceiling comes through.
    let limits = UpdateLimits {
        max_package_bytes: PACKAGE.len() as u64,
        ..UpdateLimits::default()
    };
    let (app, state, recorder) = setup(&server, TRUSTED_PUBKEY, limits);
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    state.install(|_| {}).await.expect("the install");
    assert_eq!(recorder.installed().len(), 1);
}

#[tokio::test]
async fn a_server_that_answers_with_an_error_or_nothing_offers_no_update() {
    let server = Server::start(|_| {
        vec![
            ("/latest.json", Route::status(204)),
            ("/gone", Route::status(404)),
        ]
    });
    let (app, state, _recorder) = trusted(&server);
    assert_eq!(state.check(app.handle()).await, Ok(None));
    // The same state, an endpoint that answers 404.
    let mut config = plugin_config(server.port, TRUSTED_PUBKEY);
    config["endpoints"] = json!([server.url("/gone")]);
    let gone = UpdateState::new(
        &config,
        CURRENT.to_owned(),
        Arc::new(Recorder::default()),
        UpdateLimits::default(),
    );
    assert_eq!(gone.check(app.handle()).await, Err(UpdateError::Http(404)));
}

#[tokio::test]
async fn an_update_found_is_forgotten_when_the_next_check_finds_none() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (app, state, _recorder) = trusted(&server);
    state
        .check(app.handle())
        .await
        .expect("the check")
        .expect("an update");
    assert!(state.status().pending.is_some());
    // The feed now has no update to offer (204 for the next request is the other route).
    let gone = Server::start(|_| vec![("/latest.json", Route::status(204))]);
    let mut config = plugin_config(gone.port, TRUSTED_PUBKEY);
    config["endpoints"] = json!([gone.url("/latest.json")]);
    let next = UpdateState::new(
        &config,
        CURRENT.to_owned(),
        Arc::new(Recorder::default()),
        UpdateLimits::default(),
    );
    *next.pending() = state.pending().clone();
    assert_eq!(next.check(app.handle()).await, Ok(None));
    assert_eq!(next.status().pending, None);
}

// ---- when updating is not on ----------------------------------------------------------------

#[tokio::test]
async fn without_a_key_nothing_is_checked_and_nothing_is_installed() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    for pubkey in [noren_core::PUBKEY_NOT_SET, "", "not a key!"] {
        let (app, state, recorder) = setup(&server, pubkey, UpdateLimits::default());
        assert!(!state.status().configured, "{pubkey:?}");
        assert_eq!(
            state.check(app.handle()).await,
            Err(UpdateError::NotConfigured)
        );
        assert_eq!(state.install(|_| {}).await, Err(UpdateError::NotConfigured));
        assert!(recorder.installed().is_empty());
    }
    assert!(server.seen().is_empty(), "a check went out with no key");
}

#[tokio::test]
async fn a_smoke_run_neither_reaches_the_network_nor_installs() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (app, state, recorder) = trusted(&server);
    let state = state.without_updating();
    // The status is still a read.
    assert!(state.status().configured);
    assert_eq!(state.check(app.handle()).await, Err(UpdateError::Off));
    assert_eq!(state.install(|_| {}).await, Err(UpdateError::Off));
    assert!(server.seen().is_empty());
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn installing_with_no_update_found_is_refused() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (_app, state, recorder) = trusted(&server);
    assert_eq!(
        state.install(|_| {}).await,
        Err(UpdateError::NothingToInstall)
    );
    assert!(server.seen().is_empty());
    assert!(recorder.installed().is_empty());
}

#[tokio::test]
async fn a_second_step_while_one_runs_is_refused() {
    let server = Server::start(|port| {
        vec![(
            "/latest.json",
            Route::ok(feed(
                "0.2.0",
                &format!("http://127.0.0.1:{port}/package.bin"),
                SIGNATURE_FOR_0_2_0,
            ))
            .hanging(Duration::from_millis(600)),
        )]
    });
    let (app, state, _recorder) = trusted(&server);
    let (first, second) = tokio::join!(state.check(app.handle()), async {
        tokio::time::sleep(Duration::from_millis(150)).await;
        (state.check(app.handle()).await, state.install(|_| {}).await)
    });
    assert!(first.expect("the first check").is_some());
    assert_eq!(second, (Err(UpdateError::Busy), Err(UpdateError::Busy)));
}

#[test]
fn the_progress_is_told_at_the_start_every_step_and_at_the_end() {
    let progress = |downloaded, total| UpdateProgress { downloaded, total };
    let mut last = 0;
    assert!(worth_telling(&mut last, progress(100, Some(2_000_000))));
    assert!(!worth_telling(&mut last, progress(200, Some(2_000_000))));
    assert!(!worth_telling(
        &mut last,
        progress(100 + PROGRESS_STEP - 1, Some(2_000_000))
    ));
    assert!(worth_telling(
        &mut last,
        progress(100 + PROGRESS_STEP, Some(2_000_000))
    ));
    assert!(!worth_telling(
        &mut last,
        progress(100 + PROGRESS_STEP + 5, Some(2_000_000))
    ));
    assert!(worth_telling(
        &mut last,
        progress(2_000_000, Some(2_000_000))
    ));
    // No size announced: the start and every step, and there is no end to tell.
    let mut last = 0;
    assert!(worth_telling(&mut last, progress(10, None)));
    assert!(!worth_telling(&mut last, progress(20, None)));
    assert!(worth_telling(&mut last, progress(10 + PROGRESS_STEP, None)));
}

// ---- the page's way in ------------------------------------------------------------------------

/// Calls `cmd` from the window `label` the way the page does, in the mock runtime.
fn call(
    label: &str,
    cmd: &str,
    app: &tauri::App<MockRuntime>,
) -> Result<serde_json::Value, serde_json::Value> {
    use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
    use tauri::webview::InvokeRequest;

    let webview = match app.get_webview_window(label) {
        Some(webview) => webview,
        None => tauri::WebviewWindowBuilder::new(app, label, Default::default())
            .build()
            .expect("build the mock window"),
    };
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
            body: InvokeBody::Json(json!({})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| match body {
        InvokeResponseBody::Json(text) => serde_json::from_str(&text).expect("JSON"),
        InvokeResponseBody::Raw(_) => panic!("a raw answer"),
    })
}

/// An app with the plugin, the state over `server` and the three commands.
fn app_with_commands(server: &Server) -> (tauri::App<MockRuntime>, Arc<Recorder>) {
    let config = plugin_config(server.port, TRUSTED_PUBKEY);
    let mut context = mock_context(noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert(PLUGIN_NAME.to_owned(), config.clone());
    let recorder = Arc::new(Recorder::default());
    let state = UpdateState::new(
        &config,
        CURRENT.to_owned(),
        recorder.clone(),
        UpdateLimits::default(),
    );
    let app = mock_builder()
        .plugin(plugin())
        .manage(Arc::new(state))
        .invoke_handler(tauri::generate_handler![
            update_status,
            update_check,
            update_install
        ])
        .build(context)
        .expect("build the mock app");
    (app, recorder)
}

#[test]
fn the_page_checks_and_installs_through_the_commands_in_the_wire_shape() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (app, recorder) = app_with_commands(&server);
    let told: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = Arc::clone(&told);
    app.listen_any(PROGRESS_EVENT, move |event| {
        sink.lock()
            .expect("log")
            .push(serde_json::from_str(event.payload()).expect("a JSON payload"));
    });

    assert_eq!(
        call("main", "update_status", &app),
        Ok(json!({ "configured": true, "currentVersion": "0.1.0", "pending": null }))
    );
    let found = json!({
        "version": "0.2.0",
        "currentVersion": "0.1.0",
        "notes": "Fixes\n- one thing",
        "publishedAt": 1_792_584_000
    });
    assert_eq!(call("main", "update_check", &app), Ok(found.clone()));
    assert_eq!(
        call("main", "update_status", &app),
        Ok(json!({ "configured": true, "currentVersion": "0.1.0", "pending": found }))
    );
    assert!(
        recorder.installed().is_empty(),
        "a check installed something"
    );

    assert_eq!(call("main", "update_install", &app), Ok(json!(null)));
    assert_eq!(
        recorder.installed(),
        [("0.2.0".to_owned(), PACKAGE.to_vec())]
    );
    let told = told.lock().expect("log").clone();
    assert_eq!(
        told.last(),
        Some(&json!({ "downloaded": PACKAGE.len(), "total": PACKAGE.len() }))
    );
}

#[test]
fn the_commands_that_reach_out_are_for_the_main_window_alone() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_FOR_0_2_0), PACKAGE);
    let (app, recorder) = app_with_commands(&server);
    for label in ["quick", "window-1", "browser-p1"] {
        for cmd in ["update_check", "update_install"] {
            assert!(
                call(label, cmd, &app).is_err(),
                "{label} was allowed to call {cmd}"
            );
        }
    }
    assert!(
        server.seen().is_empty(),
        "a request went out for a window that may not ask"
    );
    assert!(recorder.installed().is_empty());
}

#[test]
fn the_refusals_reach_the_page_as_sentences() {
    let server = Server::with_package(|url| feed("0.2.0", url, SIGNATURE_OF_ANOTHER_KEY), PACKAGE);
    let (app, recorder) = app_with_commands(&server);
    assert!(call("main", "update_check", &app).is_ok());
    let refused = call("main", "update_install", &app).expect_err("refused");
    let text = refused.as_str().expect("a sentence");
    assert!(text.starts_with("the update was refused: "), "{text}");
    assert!(recorder.installed().is_empty());
}

// ---- the configuration of the app -------------------------------------------------------------

const TAURI_CONF: &str = include_str!("../../tauri.conf.json");

fn conf_updater() -> Value {
    let conf: Value = serde_json::from_str(TAURI_CONF).expect("tauri.conf.json is JSON");
    conf["plugins"][PLUGIN_NAME].clone()
}

#[test]
fn the_configuration_of_the_app_updates_from_the_github_releases_and_asks_for_a_signed_version() {
    let updater = conf_updater();
    assert_eq!(
        updater["endpoints"],
        json!(["https://github.com/marllon/noren/releases/latest/download/latest.json"])
    );
    assert_eq!(
        update_endpoint_of(&updater).as_deref(),
        Ok("https://github.com/marllon/noren/releases/latest/download/latest.json")
    );
    assert_eq!(updater["requireSignedVersion"], json!(true));
    // Nothing that loosens the checks.
    for loosening in [
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
        "allowDowngrades",
    ] {
        assert!(updater.get(loosening).is_none(), "{loosening}");
    }
}

#[test]
fn the_key_of_the_app_is_one_value_and_either_the_placeholder_or_a_public_key() {
    let updater = conf_updater();
    let key = updater["pubkey"].as_str().expect("a pubkey");
    if key == noren_core::PUBKEY_NOT_SET {
        assert!(!update_key_is_set(&updater));
    } else {
        // The real one: the base64 of a minisign public key file.
        assert!(update_key_is_set(&updater), "{key}");
        assert!(key.starts_with("dW50cnVzdGVkIGNvbW1lbnQ6"), "{key}");
    }
    // The key is written in tauri.conf.json and nowhere in the code that is not a test.
    for source in [
        include_str!("../update.rs"),
        include_str!("../main.rs"),
        include_str!("../bridge.rs"),
    ] {
        assert!(
            !source.contains("dW50cnVzdGVkIGNvbW1lbnQ6"),
            "a key in the code"
        );
    }
}

#[tokio::test]
async fn the_state_of_the_app_reads_its_own_configuration_and_stays_off_until_a_key_is_set() {
    // The real configuration of the app in the mock runtime: the plugin accepts it, and the state
    // built from the app says it cannot update while the key is the placeholder.
    let updater = conf_updater();
    let app = app_with(&updater);
    app.updater_builder()
        .build()
        .expect("the plugin takes the configuration of the app");
    let state = UpdateState::from_app(app.handle());
    assert_eq!(state.status().current_version, CURRENT);
    assert_eq!(
        state.status().configured,
        update_key_is_set(&updater),
        "the state follows the key of tauri.conf.json"
    );
    if !update_key_is_set(&updater) {
        assert_eq!(
            state.check(app.handle()).await,
            Err(UpdateError::NotConfigured)
        );
    }
}

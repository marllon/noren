//! Tests of the update module: a server on `127.0.0.1` at a port the system picks that plays the
//! feed and the package (and a redirect, a slow answer, a body that is too large), and the pure
//! parts. Nothing touches the network of the machine.

use super::*;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

/// A public key made for tests (the private half is not kept anywhere): the shape of a real one.
const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBFNEMxMDczMTE1OTkwMUIKUldRYmtGa1JjeEJNRGlOcXN4dlBTZi9SUGs1L3FMS25zS2R1MGwwM1IyWjdPaGV0Mit4TXRmY1AK";

// ---- the server -----------------------------------------------------------------------------

/// What the server answers at one path.
#[derive(Clone)]
struct Route {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// The `Content-Length` to claim; `None` sends the length of the body, and `without_length`
    /// sends none (the body ends where the connection does).
    claim: Option<usize>,
    without_length: bool,
    /// Wait this long after the head, before the body.
    hang: Option<Duration>,
}

impl Route {
    fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            headers: Vec::new(),
            body: body.into(),
            claim: None,
            without_length: false,
            hang: None,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            ..Self::ok(Vec::new())
        }
    }

    fn redirect_to(location: &str) -> Self {
        Self {
            headers: vec![("Location".to_owned(), location.to_owned())],
            ..Self::status(302)
        }
    }

    fn claiming(mut self, bytes: usize) -> Self {
        self.claim = Some(bytes);
        self
    }

    fn unmeasured(mut self) -> Self {
        self.without_length = true;
        self
    }

    fn hanging(mut self, wait: Duration) -> Self {
        self.hang = Some(wait);
        self
    }
}

/// One request the server saw.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    accept: Option<String>,
    user_agent: Option<String>,
}

struct Server {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    /// Starts a server; `routes` is given the port, for a route that redirects to the server.
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
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let routes = Arc::clone(&routes);
                let log = Arc::clone(&log);
                thread::spawn(move || serve(stream, &routes, &log));
            }
        });
        Self { port, seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("log").clone()
    }
}

fn serve(mut stream: TcpStream, routes: &HashMap<String, Route>, log: &Mutex<Vec<Seen>>) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head.lines();
    let path = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .unwrap_or("/")
        .to_owned();
    let header = |name: &str| {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    };
    log.lock().expect("log").push(Seen {
        path: path.clone(),
        accept: header("accept"),
        user_agent: header("user-agent"),
    });
    let route = routes
        .get(&path)
        .cloned()
        .unwrap_or_else(|| Route::status(404));
    let mut out = format!("HTTP/1.1 {} Test\r\n", route.status);
    for (key, value) in &route.headers {
        out.push_str(&format!("{key}: {value}\r\n"));
    }
    if !route.without_length {
        out.push_str(&format!(
            "Content-Length: {}\r\n",
            route.claim.unwrap_or(route.body.len())
        ));
    }
    out.push_str("Connection: close\r\n\r\n");
    if stream.write_all(out.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    if let Some(wait) = route.hang {
        thread::sleep(wait);
    }
    // Pieces, so a reader sees the body arrive and can stop before the end.
    for piece in route.body.chunks(1024) {
        if stream.write_all(piece).is_err() {
            return;
        }
        let _ = stream.flush();
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
}

fn small_limits() -> Limits {
    Limits {
        feed_timeout: Duration::from_millis(500),
        package_timeout: Duration::from_millis(500),
        max_feed_bytes: 2048,
        max_package_bytes: 4096,
    }
}

const FEED: &str = r#"{"version":"0.2.0","notes":"Fixes","platforms":{"windows-x86_64":{"url":"u","signature":"s"}}}"#;

// ---- the addresses ----------------------------------------------------------------------------

#[test]
fn only_https_is_fetched_and_a_local_test_server_is_the_one_exception() {
    for address in [
        "https://github.com/marllon/noren/releases/latest/download/latest.json",
        "https://example.com:8443/a/b.json?x=1",
        "http://127.0.0.1:8123/latest.json",
    ] {
        assert!(Fetcher::new(address).is_ok(), "{address}");
    }
    for address in [
        "http://github.com/latest.json",
        "http://localhost:8123/latest.json",
        "http://127.0.0.1/latest.json",
        "http://127.0.0.2:8123/latest.json",
        "http://[::1]:8123/latest.json",
        "ftp://example.com/latest.json",
        "file:///C:/latest.json",
        "https://user:secret@example.com/latest.json",
        "https://user@example.com/latest.json",
        "latest.json",
        "",
    ] {
        assert!(
            matches!(Fetcher::new(address), Err(UpdateError::InsecureAddress(_))),
            "{address}"
        );
    }
}

#[test]
fn the_endpoint_of_the_configuration_is_the_first_one_and_must_be_https_or_local() {
    let config = serde_json::json!({
        "endpoints": [
            "https://github.com/marllon/noren/releases/latest/download/latest.json",
            "https://example.com/second.json"
        ]
    });
    assert_eq!(
        endpoint_of(&config).as_deref(),
        Ok("https://github.com/marllon/noren/releases/latest/download/latest.json")
    );
    let local = serde_json::json!({ "endpoints": ["http://127.0.0.1:9/x.json"] });
    assert_eq!(
        endpoint_of(&local).as_deref(),
        Ok("http://127.0.0.1:9/x.json")
    );
    for config in [
        serde_json::json!({}),
        serde_json::json!({ "endpoints": [] }),
        serde_json::json!({ "endpoints": "https://example.com/x.json" }),
        serde_json::json!({ "endpoints": [42] }),
        serde_json::json!({ "endpoints": ["not an address"] }),
        serde_json::json!({ "endpoints": ["http://example.com/x.json"] }),
        serde_json::json!({ "endpoints": ["http://localhost:9/x.json"] }),
        serde_json::json!({ "endpoints": ["https://user:pw@example.com/x.json"] }),
        // Only the first one counts.
        serde_json::json!({ "endpoints": ["http://example.com/x.json", "https://example.com/y.json"] }),
    ] {
        assert!(
            matches!(endpoint_of(&config), Err(UpdateError::BadConfig(_))),
            "{config}"
        );
    }
}

#[test]
fn a_key_counts_as_set_only_when_it_is_base64_text_and_not_the_placeholder() {
    assert!(key_is_set(&serde_json::json!({ "pubkey": TEST_PUBKEY })));
    for config in [
        serde_json::json!({}),
        serde_json::json!({ "pubkey": null }),
        serde_json::json!({ "pubkey": 7 }),
        serde_json::json!({ "pubkey": "" }),
        serde_json::json!({ "pubkey": PUBKEY_NOT_SET }),
        serde_json::json!({ "pubkey": "dW50cnVzdGVk" }),
        serde_json::json!({ "pubkey": "not base64 text, it has spaces and punctuation!!!!!!" }),
    ] {
        assert!(!key_is_set(&config), "{config}");
    }
}

// ---- the feed ---------------------------------------------------------------------------------

#[test]
fn the_feed_is_the_json_object_the_server_sends() {
    let server = Server::start(|_| vec![("/latest.json", Route::ok(FEED))]);
    let fetcher = Fetcher::new(&server.url("/latest.json")).expect("fetcher");
    let feed = runtime()
        .block_on(fetcher.feed())
        .expect("the feed")
        .expect("a feed");
    assert_eq!(feed["version"], "0.2.0");
    assert_eq!(feed["platforms"]["windows-x86_64"]["signature"], "s");
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].accept.as_deref(), Some("application/json"));
    assert!(
        seen[0]
            .user_agent
            .as_deref()
            .is_some_and(|agent| agent.starts_with("noren/")),
        "{seen:?}"
    );
}

#[test]
fn a_204_means_there_is_nothing_to_offer() {
    let server = Server::start(|_| vec![("/latest.json", Route::status(204))]);
    let fetcher = Fetcher::new(&server.url("/latest.json")).expect("fetcher");
    assert_eq!(runtime().block_on(fetcher.feed()), Ok(None));
}

#[test]
fn a_feed_that_is_not_a_success_is_an_error_with_the_status() {
    let server = Server::start(|_| {
        vec![
            ("/gone.json", Route::status(404)),
            ("/broken.json", Route::status(500)),
        ]
    });
    for (path, status) in [
        ("/gone.json", 404),
        ("/broken.json", 500),
        ("/nowhere", 404),
    ] {
        let fetcher = Fetcher::new(&server.url(path)).expect("fetcher");
        assert_eq!(
            runtime().block_on(fetcher.feed()),
            Err(UpdateError::Http(status)),
            "{path}"
        );
    }
}

#[test]
fn a_feed_that_is_not_a_json_object_is_refused() {
    let server = Server::start(|_| {
        vec![
            ("/text.json", Route::ok("this is not json")),
            ("/list.json", Route::ok("[1,2,3]")),
            ("/number.json", Route::ok("7")),
            ("/empty.json", Route::ok("")),
        ]
    });
    for path in ["/text.json", "/list.json", "/number.json", "/empty.json"] {
        let fetcher = Fetcher::new(&server.url(path)).expect("fetcher");
        assert!(
            matches!(
                runtime().block_on(fetcher.feed()),
                Err(UpdateError::BadFeed(_))
            ),
            "{path}"
        );
    }
}

#[test]
fn a_feed_over_the_ceiling_is_refused_whether_or_not_the_server_says_its_size() {
    let big = vec![b' '; 4096];
    let server = Server::start(|_| {
        vec![
            ("/measured.json", Route::ok(big.clone())),
            ("/unmeasured.json", Route::ok(big.clone()).unmeasured()),
            // Claims little, sends much: the claim is not what is trusted.
            ("/lying.json", Route::ok(big.clone()).claiming(10)),
        ]
    });
    for path in ["/measured.json", "/unmeasured.json"] {
        let fetcher = Fetcher::with_limits(&server.url(path), small_limits()).expect("fetcher");
        assert_eq!(
            runtime().block_on(fetcher.feed()),
            Err(UpdateError::TooLarge(2048)),
            "{path}"
        );
    }
    // A body that does not match the length it claims never becomes a feed.
    let fetcher =
        Fetcher::with_limits(&server.url("/lying.json"), small_limits()).expect("fetcher");
    assert!(runtime().block_on(fetcher.feed()).is_err());
}

#[test]
fn a_feed_that_takes_longer_than_the_deadline_is_a_timeout() {
    let server = Server::start(|_| {
        vec![(
            "/slow.json",
            Route::ok(FEED).hanging(Duration::from_secs(3)),
        )]
    });
    let fetcher = Fetcher::with_limits(&server.url("/slow.json"), small_limits()).expect("fetcher");
    let started = std::time::Instant::now();
    assert_eq!(
        runtime().block_on(fetcher.feed()),
        Err(UpdateError::Timeout)
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_server_that_is_not_there_is_a_network_error_without_the_address() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("address").port()
    };
    let fetcher = Fetcher::new(&format!("http://127.0.0.1:{port}/latest.json")).expect("fetcher");
    let Err(UpdateError::Network(why)) = runtime().block_on(fetcher.feed()) else {
        panic!("not a network error");
    };
    assert!(!why.contains(&port.to_string()), "{why}");
}

// ---- the redirects ----------------------------------------------------------------------------

#[test]
fn a_redirect_is_followed_to_the_asset_and_the_chain_has_an_end() {
    let server = Server::start(|port| {
        let at = |path: &str| format!("http://127.0.0.1:{port}{path}");
        vec![
            (
                "/latest.json",
                Route::redirect_to(&at("/assets/latest.json")),
            ),
            ("/assets/latest.json", Route::ok(FEED)),
            ("/loop", Route::redirect_to(&at("/loop"))),
            ("/package", Route::redirect_to(&at("/blob/package.bin"))),
            ("/blob/package.bin", Route::ok(vec![7u8; 100])),
        ]
    });
    let fetcher = Fetcher::new(&server.url("/latest.json")).expect("fetcher");
    let feed = runtime().block_on(fetcher.feed()).expect("feed");
    assert_eq!(feed.expect("a feed")["version"], "0.2.0");
    let bytes = runtime()
        .block_on(fetcher.package(&server.url("/package"), |_| {}))
        .expect("the package after the redirect");
    assert_eq!(bytes, vec![7u8; 100]);
    // A redirect that never ends stops after MAX_REDIRECTS hops.
    let looped = Fetcher::new(&server.url("/loop")).expect("fetcher");
    let Err(UpdateError::Network(why)) = runtime().block_on(looped.feed()) else {
        panic!("a loop was not stopped");
    };
    assert!(why.contains("too many redirects"), "{why}");
    let hops = server.seen().iter().filter(|s| s.path == "/loop").count();
    assert_eq!(hops, MAX_REDIRECTS + 1);
}

#[test]
fn a_redirect_to_an_address_that_is_not_allowed_is_not_followed() {
    let server = Server::start(|_| {
        vec![
            (
                "/to-plain-http",
                Route::redirect_to("http://example.com/latest.json"),
            ),
            (
                "/to-credentials",
                Route::redirect_to("https://user:pw@example.com/latest.json"),
            ),
            (
                "/to-other-scheme",
                Route::redirect_to("ftp://example.com/latest.json"),
            ),
        ]
    });
    for path in ["/to-plain-http", "/to-credentials", "/to-other-scheme"] {
        let fetcher = Fetcher::new(&server.url(path)).expect("fetcher");
        let Err(UpdateError::Network(why)) = runtime().block_on(fetcher.feed()) else {
            panic!("{path} was followed");
        };
        assert!(why.contains("not allowed"), "{path}: {why}");
    }
}

// ---- the package ------------------------------------------------------------------------------

#[test]
fn the_package_comes_whole_with_the_progress_told_on_the_way() {
    let package: Vec<u8> = (0..3000u32).map(|n| (n % 251) as u8).collect();
    let server = Server::start(|_| {
        vec![
            ("/latest.json", Route::ok(FEED)),
            ("/package.bin", Route::ok(package.clone())),
        ]
    });
    let fetcher =
        Fetcher::with_limits(&server.url("/latest.json"), small_limits()).expect("fetcher");
    let mut steps = Vec::new();
    let bytes = runtime()
        .block_on(fetcher.package(&server.url("/package.bin"), |p| steps.push(p)))
        .expect("the package");
    assert_eq!(bytes, package);
    assert!(!steps.is_empty());
    assert!(
        steps
            .windows(2)
            .all(|pair| pair[0].downloaded < pair[1].downloaded)
    );
    assert_eq!(steps.last().expect("a step").downloaded, 3000);
    assert!(steps.iter().all(|p| p.total == Some(3000)));
    let seen = server.seen();
    let download = seen
        .iter()
        .find(|s| s.path == "/package.bin")
        .expect("seen");
    assert_eq!(download.accept.as_deref(), Some("application/octet-stream"));
}

#[test]
fn a_package_over_the_ceiling_is_refused_and_a_package_at_it_is_not() {
    let at = vec![1u8; 4096];
    let over = vec![1u8; 4097];
    let server = Server::start(|_| {
        vec![
            ("/latest.json", Route::ok(FEED)),
            ("/at.bin", Route::ok(at.clone())),
            ("/measured.bin", Route::ok(over.clone())),
            ("/unmeasured.bin", Route::ok(over.clone()).unmeasured()),
        ]
    });
    let fetcher =
        Fetcher::with_limits(&server.url("/latest.json"), small_limits()).expect("fetcher");
    let rt = runtime();
    assert_eq!(
        rt.block_on(fetcher.package(&server.url("/at.bin"), |_| {})),
        Ok(at)
    );
    for path in ["/measured.bin", "/unmeasured.bin"] {
        let mut told = 0u64;
        assert_eq!(
            rt.block_on(fetcher.package(&server.url(path), |p| told = p.downloaded)),
            Err(UpdateError::TooLarge(4096)),
            "{path}"
        );
        if path == "/measured.bin" {
            // Announced over the ceiling: refused before a byte is read.
            assert_eq!(told, 0);
        } else {
            assert!(told <= 4096, "{told}");
        }
    }
}

#[test]
fn a_package_that_is_cut_short_or_slow_or_missing_is_an_error() {
    let server = Server::start(|_| {
        vec![
            ("/latest.json", Route::ok(FEED)),
            ("/cut.bin", Route::ok(vec![1u8; 100]).claiming(500)),
            (
                "/slow.bin",
                Route::ok(vec![1u8; 100]).hanging(Duration::from_secs(3)),
            ),
            ("/denied.bin", Route::status(403)),
        ]
    });
    let fetcher =
        Fetcher::with_limits(&server.url("/latest.json"), small_limits()).expect("fetcher");
    let rt = runtime();
    assert!(matches!(
        rt.block_on(fetcher.package(&server.url("/cut.bin"), |_| {})),
        Err(UpdateError::Network(_))
    ));
    assert_eq!(
        rt.block_on(fetcher.package(&server.url("/slow.bin"), |_| {})),
        Err(UpdateError::Timeout)
    );
    assert_eq!(
        rt.block_on(fetcher.package(&server.url("/denied.bin"), |_| {})),
        Err(UpdateError::Http(403))
    );
    assert_eq!(
        rt.block_on(fetcher.package(&server.url("/missing.bin"), |_| {})),
        Err(UpdateError::Http(404))
    );
}

#[test]
fn the_package_address_follows_the_same_rule_as_the_feed() {
    let server = Server::start(|_| vec![("/latest.json", Route::ok(FEED))]);
    let fetcher = Fetcher::new(&server.url("/latest.json")).expect("fetcher");
    let rt = runtime();
    for address in [
        "http://example.com/package.bin",
        "http://localhost:9/package.bin",
        "ftp://example.com/package.bin",
        "https://user:pw@example.com/package.bin",
        "package.bin",
    ] {
        let result = rt.block_on(fetcher.package(address, |_| {}));
        assert!(
            matches!(
                result,
                Err(UpdateError::InsecureAddress(_) | UpdateError::BadFeed(_))
            ),
            "{address}: {result:?}"
        );
    }
    // Nothing was requested for any of them.
    assert!(server.seen().is_empty());
}

// ---- the words --------------------------------------------------------------------------------

#[test]
fn release_notes_are_cleaned_for_a_screen() {
    assert_eq!(
        UpdateInfo::new(
            "0.2.0",
            "0.1.0",
            Some("  Fixes\r\n- one\r\n- two\t!  "),
            Some(5)
        )
        .notes,
        Some("Fixes\n- one\n- two\t!".to_owned())
    );
    // Control characters are taken out; the escape of a terminal included.
    assert_eq!(
        UpdateInfo::new("0.2.0", "0.1.0", Some("a\u{1b}[31mred\u{0}\u{7}b"), None).notes,
        Some("a[31mredb".to_owned())
    );
    for empty in [None, Some(""), Some("  \r\n\t "), Some("\u{1b}\u{0}")] {
        assert_eq!(
            UpdateInfo::new("0.2.0", "0.1.0", empty, None).notes,
            None,
            "{empty:?}"
        );
    }
    let long = "x".repeat(MAX_NOTES_CHARS + 50);
    let notes = UpdateInfo::new("0.2.0", "0.1.0", Some(&long), None)
        .notes
        .expect("notes");
    assert_eq!(notes.chars().count(), MAX_NOTES_CHARS + 1);
    assert!(notes.ends_with('…'));
    let exact = "y".repeat(MAX_NOTES_CHARS);
    assert_eq!(
        UpdateInfo::new("0.2.0", "0.1.0", Some(&exact), None).notes,
        Some(exact)
    );
}

#[test]
fn the_errors_are_sentences_for_the_person() {
    assert_eq!(
        UpdateError::Http(404).to_string(),
        "the update server answered 404"
    );
    assert!(
        UpdateError::NotConfigured
            .to_string()
            .contains("no update key")
    );
    for error in [
        UpdateError::NotConfigured,
        UpdateError::Off,
        UpdateError::BadConfig("x".to_owned()),
        UpdateError::InsecureAddress("x".to_owned()),
        UpdateError::Network("x".to_owned()),
        UpdateError::Timeout,
        UpdateError::Http(500),
        UpdateError::TooLarge(10),
        UpdateError::BadFeed("x".to_owned()),
        UpdateError::NothingToInstall,
        UpdateError::Busy,
        UpdateError::Refused("x".to_owned()),
        UpdateError::Install("x".to_owned()),
    ] {
        let text = error.to_string();
        assert!(text.starts_with(|c: char| c.is_ascii_lowercase()), "{text}");
        assert!(!text.ends_with('.'), "{text}");
    }
}

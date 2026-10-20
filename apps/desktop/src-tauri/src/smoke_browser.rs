//! The browser pane in the real app (`noren --smoke`, NOR-F15-01a).
//!
//! A web server of a few lines on `127.0.0.1` and a free port (the standard library, no crate)
//! serves one page with a known title. The run opens a browser pane on it, in the `main` window
//! that stays hidden, through the same `browser_pane::open` the command uses, and waits for the
//! page-load event of that web view. The page is real code running in the web view, so it also
//! reports back what it can see, which is what the security of the pane is checked with:
//!
//! - its title, which proves the page was loaded and its script ran;
//! - that the test hook of the interface (`window.__norenTest`) is not there;
//! - that asking the app for a command (`fonts_list_monospace`) is refused;
//! - that a navigation it starts to `http://tauri.localhost/`, the address the pages of the app are
//!   served from on Windows, does not happen (a page there would be the app's own and be granted
//!   its commands): the old page is still the one running a moment later, and no second load came.
//!
//! The run then takes the pane to a second page of the same server, checks that the addresses
//! `file`, `javascript`, `data` and `noren` are refused, moves the pane and closes it. Every step
//! prints a `SMOKE browser pane ...` line; the line `SMOKE browser pane loaded <url>` is the one the
//! smoke script requires.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

use crate::browser_pane::{self, Bounds, LoadHook};
use crate::smoke::print_line;

/// The pane the run opens (the id of a pane made by the app is a UUID; this one is not).
const PANE_ID: &str = "smoke-browser-pane";

/// The title of the test page.
pub const PAGE_TITLE: &str = "Noren browser pane smoke";

/// How long each wait for the page may take.
const WAIT: Duration = Duration::from_secs(25);

/// How long to wait for something that must NOT happen to show up (a second load, a page that was
/// replaced). The page waits 1.5 s before it says it is still there.
const STAY_WAIT: Duration = Duration::from_secs(12);

/// The place the pane is opened at, and then moved to.
const OPENED_AT: Bounds = Bounds {
    x: 40.0,
    y: 40.0,
    width: 600.0,
    height: 400.0,
};
const MOVED_TO: Bounds = Bounds {
    x: 100.0,
    y: 60.0,
    width: 500.0,
    height: 300.0,
};

/// What the page tells the server.
#[derive(Debug)]
enum Heard {
    /// `/report?...`: what the page can see of the app.
    Report(HashMap<String, String>),
    /// `/after?href=...`: the page is still running, at this address, after it tried to leave.
    After(String),
}

/// The test page. The script reports what it can see, then (on the first page only) tries to go to
/// an address of the app and reports again that it is still where it was.
fn page() -> String {
    format!(
        r#"<!doctype html>
<html>
<head><meta charset="utf-8"><title>{PAGE_TITLE}</title></head>
<body>
<p>noren browser pane smoke</p>
<script>
(async () => {{
  const report = {{
    path: location.pathname,
    title: document.title,
    hook: typeof window.__norenTest,
    ipc: "none",
  }};
  const internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === "function") {{
    try {{
      await internals.invoke("fonts_list_monospace");
      report.ipc = "allowed";
    }} catch (error) {{
      report.ipc = "denied: " + String(error).slice(0, 120);
    }}
  }}
  await fetch("/report?" + new URLSearchParams(report));
  if (location.pathname === "/") {{
    location.href = "http://tauri.localhost/";
    setTimeout(() => fetch("/after?href=" + encodeURIComponent(location.href)), 1500);
  }}
}})();
</script>
</body>
</html>
"#
    )
}

/// The address a request asks for: `GET /path?query HTTP/1.1` gives `/path?query`.
fn request_target(head: &str) -> Option<&str> {
    let line = head.lines().next()?;
    let mut words = line.split(' ');
    (words.next()? == "GET").then_some(())?;
    words.next()
}

/// Reads the head of a request (up to the blank line, at most 16 KiB).
fn read_head(stream: &mut TcpStream) -> io::Result<String> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut head = Vec::new();
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 16 * 1024 {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&chunk[..read]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    // A browser that went away before the answer is of no interest to the run.
    let _ = stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(body.as_bytes()))
        .and_then(|()| stream.flush());
}

/// Answers one connection: the page for `/` and `/second`, `204` for the two reports (and tells the
/// run what they said), `404` for the rest.
fn serve_connection(mut stream: TcpStream, heard: &Sender<Heard>) {
    // The accepted socket must block (the listener it came from does not).
    let _ = stream.set_nonblocking(false);
    let Ok(head) = read_head(&mut stream) else {
        return;
    };
    let Some(target) = request_target(&head) else {
        respond(&mut stream, "400 Bad Request", "text/plain", "bad request");
        return;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        respond(&mut stream, "400 Bad Request", "text/plain", "bad request");
        return;
    };
    let pairs: HashMap<String, String> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    match url.path() {
        "/" | "/second" => respond(&mut stream, "200 OK", "text/html; charset=utf-8", &page()),
        "/report" => {
            let _ = heard.send(Heard::Report(pairs));
            respond(&mut stream, "204 No Content", "text/plain", "");
        }
        "/after" => {
            let href = pairs.get("href").cloned().unwrap_or_default();
            let _ = heard.send(Heard::After(href));
            respond(&mut stream, "204 No Content", "text/plain", "");
        }
        _ => respond(&mut stream, "404 Not Found", "text/plain", "not found"),
    }
}

/// The test server: it lives on a thread of its own until it is dropped.
struct TestServer {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    heard: Receiver<Heard>,
}

impl TestServer {
    /// Binds `127.0.0.1` on a free port and starts answering.
    fn start() -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, heard) = mpsc::channel();
        let stopping = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let tx = tx.clone();
                        thread::spawn(move || serve_connection(stream, &tx));
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            port,
            stop,
            thread: Some(thread),
            heard,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    /// The next thing the page said, or why there was none.
    fn hear(&self, within: Duration, what: &str) -> Result<Heard, String> {
        self.heard.recv_timeout(within).map_err(|e| {
            format!(
                "browser pane: nothing came from the page within {}s ({what}): {e}",
                within.as_secs()
            )
        })
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What the page said about itself must show a page that cannot reach the app.
fn check_report(report: &HashMap<String, String>, path: &str) -> Result<(), String> {
    let field = |name: &str| report.get(name).map_or("", String::as_str);
    if field("path") != path {
        return Err(format!(
            "browser pane: the report came from {:?}, expected {path:?}",
            field("path")
        ));
    }
    if field("title") != PAGE_TITLE {
        return Err(format!(
            "browser pane: the page title is {:?}, expected {PAGE_TITLE:?}",
            field("title")
        ));
    }
    if field("hook") != "undefined" {
        return Err(format!(
            "browser pane: the page sees the test hook of the interface (typeof is {:?})",
            field("hook")
        ));
    }
    let ipc = field("ipc");
    if ipc != "none" && !ipc.starts_with("denied") {
        return Err(format!(
            "browser pane: the page could call a command: {ipc:?}"
        ));
    }
    Ok(())
}

/// Waits for the load event of the web view for `expected`. A late event for `previous` (the page
/// that was showing before, which reports the end of a navigation that was refused) is skipped; an
/// event for any other address fails.
fn expect_load(loads: &Receiver<String>, expected: &str, previous: &str) -> Result<(), String> {
    let deadline = Instant::now() + WAIT;
    loop {
        match loads.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(loaded) if loaded == expected => return Ok(()),
            Ok(loaded) if loaded == previous => {}
            Ok(loaded) => {
                return Err(format!(
                    "browser pane: loaded {loaded}, expected {expected}"
                ));
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "browser pane: {expected} did not finish loading within {}s",
                    WAIT.as_secs()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(
                    "browser pane: the web view went away before the page loaded".to_owned(),
                );
            }
        }
    }
}

fn expect_report(server: &TestServer, path: &str) -> Result<HashMap<String, String>, String> {
    match server.hear(WAIT, "its report")? {
        Heard::Report(report) => check_report(&report, path).map(|()| report),
        other => Err(format!(
            "browser pane: expected the report, heard {other:?}"
        )),
    }
}

/// The addresses the pane must refuse, whatever the interface says.
const REFUSED: [&str; 6] = [
    "file:///C:/Windows/win.ini",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "noren://open?path=/tmp",
    "http://tauri.localhost/",
    "https://user@example.com/",
];

fn run(
    app: &AppHandle,
    server: &TestServer,
    loads: &Receiver<String>,
    first: &str,
) -> Result<(), String> {
    expect_load(loads, first, first)?;
    print_line(&format!("SMOKE browser pane loaded {first}"));
    let report = expect_report(server, "/")?;
    // The refusal the app answers with has several lines; the first says what was refused.
    let ipc = report.get("ipc").map_or("?", String::as_str);
    print_line(&format!(
        "SMOKE browser pane page title {:?}, test hook {}, commands {}",
        PAGE_TITLE,
        report.get("hook").map_or("?", String::as_str),
        ipc.lines().next().unwrap_or(ipc),
    ));

    // The page tried to go to an address of the app; it must still be the one running.
    match server.hear(STAY_WAIT, "it stayed where it was")? {
        Heard::After(href) if href == first => {}
        Heard::After(href) => {
            return Err(format!(
                "browser pane: the page moved to {href}, expected it to stay at {first}"
            ));
        }
        other => {
            return Err(format!(
                "browser pane: expected the page to stay, heard {other:?}"
            ));
        }
    }
    // A navigation that is refused still ends with a load event for the page that stays, so a load
    // of the same address is not a new page; any other address is the navigation that got through.
    while let Ok(other) = loads.try_recv() {
        if other != first {
            return Err(format!(
                "browser pane: a page other than the first loaded ({other}): the navigation to an address of the app was not refused"
            ));
        }
    }
    print_line(
        "SMOKE browser pane stayed on its page (a navigation to the app's own address was refused)",
    );

    // The interface takes the pane to another page of the same server.
    let second = server.url("/second");
    browser_pane::navigate(app, PANE_ID, &second)?;
    expect_load(loads, &second, first)?;
    expect_report(server, "/second")?;
    print_line(&format!("SMOKE browser pane navigated to {second}"));

    for address in REFUSED {
        if browser_pane::navigate(app, PANE_ID, address).is_ok() {
            return Err(format!("browser pane: navigated to {address}"));
        }
    }
    if let Ok(extra) = loads.recv_timeout(Duration::from_millis(500)) {
        return Err(format!("browser pane: a refused address loaded {extra}"));
    }
    print_line("SMOKE browser pane refused file, javascript, data, noren and app addresses");

    browser_pane::set_bounds(app, PANE_ID, MOVED_TO)?;
    print_line("SMOKE browser pane moved");

    // How the interface hides a pane that is out of view (`browser-view.ts`): the same place with no
    // area, and its bounds back when the pane returns. The web view has to take both, keep its page
    // and the size it was given.
    let label = browser_pane::pane_label(PANE_ID)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser pane: the web view is gone before it was hidden".to_owned())?;
    let no_area = Bounds {
        width: 0.0,
        height: 0.0,
        ..MOVED_TO
    };
    browser_pane::set_bounds(app, PANE_ID, no_area)?;
    let hidden = webview
        .size()
        .map_err(|e| format!("browser pane: could not read the size of the hidden view: {e}"))?;
    if hidden.width != 0 || hidden.height != 0 {
        return Err(format!(
            "browser pane: taken to no area it is {}x{}",
            hidden.width, hidden.height
        ));
    }
    browser_pane::set_bounds(app, PANE_ID, MOVED_TO)?;
    let shown = webview
        .size()
        .map_err(|e| format!("browser pane: could not read the size of the shown view: {e}"))?;
    if shown.width == 0 || shown.height == 0 {
        return Err("browser pane: it came back from no area with no area".to_owned());
    }
    // The page went through it without being loaded again, and is still at its address.
    if let Ok(extra) = loads.recv_timeout(Duration::from_millis(500)) {
        return Err(format!(
            "browser pane: hiding it loaded a page again ({extra})"
        ));
    }
    let at = webview
        .url()
        .map_err(|e| format!("browser pane: could not read the address of the view: {e}"))?;
    if at.as_str() != second {
        return Err(format!(
            "browser pane: hiding it left it at {at}, not {second}"
        ));
    }
    print_line(&format!(
        "SMOKE browser pane hidden at no area and shown again ({}x{}, still at {at})",
        shown.width, shown.height
    ));
    Ok(())
}

/// Opens a browser pane on a local page and proves it loads with the window hidden and that the page
/// reaches nothing of the app (see the top of the file). Always closes the pane.
pub(crate) fn check_browser_pane(app: &AppHandle) -> Result<(), String> {
    let server = TestServer::start()
        .map_err(|e| format!("browser pane: could not start the test server: {e}"))?;
    let (load_tx, loads) = mpsc::channel::<String>();
    let hook: LoadHook = Arc::new(move |url| {
        // The run may be over by the time a late load is reported.
        let _ = load_tx.send(url.to_string());
    });
    let first = server.url("/");
    browser_pane::open(app, PANE_ID, &first, OPENED_AT, Some(hook))?;
    let label = browser_pane::pane_label(PANE_ID)?;
    let result = run(app, &server, &loads, &first);
    let closed = browser_pane::close(app, PANE_ID);
    result?;
    closed?;
    if app.get_webview(&label).is_some() {
        return Err("browser pane: the web view was still there after it was closed".to_owned());
    }
    print_line("SMOKE browser pane closed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, target: &str) -> (String, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write!(stream, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").expect("send");
        let mut answer = String::new();
        stream.read_to_string(&mut answer).expect("read");
        let (head, body) = answer.split_once("\r\n\r\n").unwrap_or((&answer, ""));
        (head.to_owned(), body.to_owned())
    }

    #[test]
    fn the_request_target_is_the_second_word_of_a_get() {
        assert_eq!(
            request_target("GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
            Some("/")
        );
        assert_eq!(
            request_target("GET /report?a=1&b=2 HTTP/1.1\r\n\r\n"),
            Some("/report?a=1&b=2")
        );
        assert_eq!(request_target("POST / HTTP/1.1\r\n\r\n"), None);
        assert_eq!(request_target(""), None);
    }

    #[test]
    fn the_server_serves_the_page_with_its_title_on_a_free_loopback_port() {
        let server = TestServer::start().expect("start");
        assert!(server.url("/").starts_with("http://127.0.0.1:"));
        let (head, body) = get(server.port, "/");
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(body.contains(&format!("<title>{PAGE_TITLE}</title>")));
        let (second, _) = get(server.port, "/second");
        assert!(second.starts_with("HTTP/1.1 200 OK"));
        let (missing, _) = get(server.port, "/favicon.ico");
        assert!(missing.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn the_server_hears_what_the_page_reports() {
        let server = TestServer::start().expect("start");
        let (head, _) = get(
            server.port,
            "/report?path=%2F&title=Noren+browser+pane+smoke&hook=undefined&ipc=denied%3A+nope",
        );
        assert!(head.starts_with("HTTP/1.1 204"), "{head}");
        let Heard::Report(report) = server
            .hear(Duration::from_secs(2), "report")
            .expect("heard")
        else {
            panic!("expected a report");
        };
        assert_eq!(report["title"], PAGE_TITLE);
        assert_eq!(report["ipc"], "denied: nope");
        assert_eq!(check_report(&report, "/"), Ok(()));

        get(server.port, "/after?href=http%3A%2F%2F127.0.0.1%3A1%2F");
        let Heard::After(href) = server.hear(Duration::from_secs(2), "after").expect("heard")
        else {
            panic!("expected the after message");
        };
        assert_eq!(href, "http://127.0.0.1:1/");
    }

    #[test]
    fn a_report_of_a_page_that_reaches_the_app_fails_the_run() {
        let good: HashMap<String, String> = [
            ("path", "/"),
            ("title", PAGE_TITLE),
            ("hook", "undefined"),
            ("ipc", "none"),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .into();
        assert_eq!(check_report(&good, "/"), Ok(()));
        let with = |key: &str, value: &str| {
            let mut report = good.clone();
            report.insert(key.to_owned(), value.to_owned());
            report
        };
        assert!(check_report(&with("ipc", "allowed"), "/").is_err());
        assert!(check_report(&with("hook", "object"), "/").is_err());
        assert!(check_report(&with("title", "other"), "/").is_err());
        assert!(check_report(&good, "/second").is_err());
        assert!(check_report(&HashMap::new(), "/").is_err());
    }

    #[test]
    fn every_address_the_run_tries_is_refused_by_the_check() {
        for address in REFUSED {
            assert!(browser_pane::check_url(address).is_err(), "{address}");
        }
    }
}

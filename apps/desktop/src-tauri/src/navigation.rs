//! A web view of the app never leaves the page it was made to show.
//!
//! The pages are served by the app itself (`tauri://localhost`, or `http(s)://tauri.localhost` on
//! Windows). Everything the page shows is data it renders as text, and the Content Security Policy
//! (`tauri.conf.json`) already keeps it from loading anything remote; this is the second wall: if a
//! link, a form or a script ever managed to start a navigation to another address, the web view
//! refuses it. Links the person wants to open go through `link.rs`, in the system browser.
//!
//! The one exception is the web view of a browser pane (`browser_pane.rs`), whose whole purpose is
//! to show a page that is not the app's: it may go to an `http` or `https` page and nowhere else,
//! and never to an address of the app itself, so it cannot turn into one of the app's pages.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

use crate::browser_pane;

/// Whether `url` is a page served by the app: the custom protocol, or its host on Windows. The
/// empty page (`about:blank`) is allowed too: an engine may pass through it, and it loads nothing.
fn is_app_page(url: &Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank",
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Whether the web view called `label` may go to `url`: a web view of a browser pane to an `http`
/// or `https` page that is not the app's, every other web view only to the pages of the app.
fn allowed(label: &str, url: &Url) -> bool {
    if browser_pane::is_pane_label(label) {
        browser_pane::allows_navigation(url)
    } else {
        is_app_page(url)
    }
}

/// The plugin that refuses a navigation away from the pages of the app (see the top of this file).
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let allowed = allowed(webview.label(), url);
            if !allowed {
                eprintln!("noren: refused a navigation to {}", url.scheme());
            }
            allowed
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str) -> bool {
        is_app_page(&Url::parse(url).expect("a valid address"))
    }

    fn allowed_in(label: &str, url: &str) -> bool {
        super::allowed(label, &Url::parse(url).expect("a valid address"))
    }

    #[test]
    fn the_pages_of_the_app_are_allowed() {
        assert!(allowed("tauri://localhost/"));
        assert!(allowed("tauri://localhost/index.html"));
        assert!(allowed("http://tauri.localhost/"));
        assert!(allowed("https://tauri.localhost/index.html?quick#x"));
        assert!(allowed("about:blank"));
    }

    #[test]
    fn every_other_address_is_refused() {
        for url in [
            "https://example.com/",
            "http://localhost:1420/",
            "http://tauri.localhost.evil.example/",
            "https://evil.example/tauri.localhost",
            "http://ipc.localhost/",
            "tauri://evil/",
            "file:///C:/Windows/win.ini",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "blob:http://tauri.localhost/1",
            "about:srcdoc",
            "ftp://tauri.localhost/",
        ] {
            assert!(!allowed(url), "{url}");
        }
    }

    #[test]
    fn the_web_view_of_a_browser_pane_goes_to_web_pages_and_nothing_of_the_app() {
        for url in [
            "https://example.com/",
            "http://127.0.0.1:8080/index.html",
            "http://localhost:3000/",
        ] {
            assert!(allowed_in("browser-p1", url), "{url}");
            // The page of the app is not for the web views of the other windows to leave to.
            assert!(!allowed_in("main", url), "{url}");
            assert!(!allowed_in("quick", url), "{url}");
        }
        for url in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "noren://open?path=/tmp",
            "blob:http://tauri.localhost/1",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://ipc.localhost/session_create",
            "about:blank",
        ] {
            assert!(!allowed_in("browser-p1", url), "{url}");
        }
    }

    #[test]
    fn the_pages_of_the_app_stay_with_the_windows_of_the_app() {
        assert!(allowed_in("main", "tauri://localhost/"));
        assert!(allowed_in("quick", "http://tauri.localhost/?quick"));
        // A web view of a pane is not given the pages of the app, even by a navigation.
        assert!(!allowed_in("browser-p1", "http://tauri.localhost/"));
    }
}

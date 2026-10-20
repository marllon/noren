//! A web view of the app never leaves the page it was made to show.
//!
//! The pages are served by the app itself (`tauri://localhost`, or `http(s)://tauri.localhost` on
//! Windows). Everything the page shows is data it renders as text, and the Content Security Policy
//! (`tauri.conf.json`) already keeps it from loading anything remote; this is the second wall: if a
//! link, a form or a script ever managed to start a navigation to another address, the web view
//! refuses it. Links the person wants to open go through `link.rs`, in the system browser.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

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

/// The plugin that refuses a navigation away from the pages of the app (see the top of this file).
pub fn guard<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            let allowed = is_app_page(url);
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
}

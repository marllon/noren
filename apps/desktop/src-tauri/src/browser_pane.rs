//! The web view of a browser pane (NOR-F15-01a).
//!
//! A browser pane shows a web page of someone else. The page lives in a web view that is a child of
//! the `main` window or of one of the windows besides it (`Window::add_child`, the `unstable` feature
//! of Tauri), laid over the window at the place the interface gives it and named
//! `browser-<pane id>`. The interface never draws the page: it tells this side where the pane is
//! (`browser_set_bounds`), where to go (`browser_navigate`) and when the pane is gone
//! (`browser_close`).
//!
//! **Whose child.** The pane of a tab shown by the `main` window gets a web view that is a child of
//! `main`. The page of a window besides the main one (`window-<id>`) can call none of these
//! commands (its capability has no `browser_*`), so the main window opens the web view for it with
//! the bounds that page measured and sent: `browser_open` takes the window the web view is a child
//! of ([`Parent`]), which must be one the app opened ([`crate::windows::WindowBook`]) and cannot be
//! named any other way, and only the main window may call it. A web view goes away with its window,
//! so closing a window leaves no web view behind; the pane of a tab that comes back is opened again
//! by the main window as a child of `main`.
//!
//! What the page can reach is nothing of the app, and three walls keep it so:
//!
//! 1. **No capability.** The capability files name the windows `main` and `quick` and no web view,
//!    and none has a `remote` origin, so a page whose address is not one of the app's own cannot
//!    call a command or listen to an event (a test in `capabilities.rs` holds the files to that).
//! 2. **No address of the app.** The pages of the app are served from `tauri.localhost` (and its
//!    siblings `ipc.localhost` and `asset.localhost`) on Windows, and a page opened there would
//!    count as the app's own and be granted its commands. [`check_url`] and [`allows_navigation`]
//!    refuse every name ending in `.localhost`, and nothing but `http` and `https`: not `file`,
//!    `javascript`, `data`, `blob`, `noren` or `tauri`. The same rule holds for the address the
//!    interface asks for and for every navigation the page makes by itself (a link, a redirect, a
//!    script), through the handler of the web view and the guard of `navigation.rs`.
//! 3. **Nothing else it asks for.** No new window, no download and no permission (camera,
//!    microphone, location, notifications) is granted, and the web view gets no initialization
//!    script: it has nothing of the test hooks of the interface.
//!
//! The checks of the address and of the place are pure functions, tested here; the web view itself
//! is tested in the mock runtime of Tauri and, with a real page, by `noren --smoke`
//! (`smoke_browser.rs`).

use std::sync::Arc;

use serde::Deserialize;
use tauri::webview::{
    DownloadEvent, NewWindowResponse, PageLoadEvent, PermissionResponse, WebviewBuilder,
};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl, Window};

use crate::windows::{self, WindowBook};

/// The start of the label of every web view of a browser pane. The interface chooses only what
/// follows, so a pane can never name `main`, `quick` or any other web view of the app.
pub const LABEL_PREFIX: &str = "browser-";

/// The window the web view of a pane is a child of when no other is asked for.
const PARENT_WINDOW: &str = "main";

/// The longest pane id a web view is named after.
const MAX_PANE_ID: usize = 64;

/// The most CSS pixels, wide or high, a web view may be given; the same limit as
/// `MAX_BROWSER_EXTENT` of `@noren/model`.
const MAX_EXTENT: f64 = 32_768.0;

/// Where the web view of a pane sits in the window: the top left corner and the size, in CSS
/// pixels from the top left corner of the page of the window.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What is called when a page of the web view has finished loading, with the address it loaded.
pub type LoadHook = Arc<dyn Fn(&Url) + Send + Sync>;

/// The window the web view of a pane is made a child of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent<'a> {
    /// The `main` window, the one that owns the workspace.
    Main,
    /// A window of the workspace besides the main one, by its id (`window-<id>` is the label of
    /// its native window). It must be open: in the book of [`crate::windows::WindowBook`].
    Window(&'a str),
}

/// The label of the web view of the pane `pane_id`, or why the id cannot name one: ASCII letters,
/// digits, `-` and `_`, at most 64 (the id of a pane made by the app, a UUID, is one).
pub fn pane_label(pane_id: &str) -> Result<String, String> {
    let fits = !pane_id.is_empty()
        && pane_id.len() <= MAX_PANE_ID
        && pane_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if fits {
        Ok(format!("{LABEL_PREFIX}{pane_id}"))
    } else {
        Err(format!("{pane_id:?} is not a pane id."))
    }
}

/// Whether `label` names the web view of a browser pane.
pub fn is_pane_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Whether `host` is one of the names the pages of the app are served from. On Windows they are
/// `tauri.localhost`, `ipc.localhost` and `asset.localhost`; every name under `.localhost` is
/// refused rather than listing them, because the engine would read `tauri.localhost.` (a final dot)
/// and `TAURI.localhost` as the same name.
fn is_app_host(host: &str) -> bool {
    host.trim_end_matches('.')
        .to_ascii_lowercase()
        .ends_with(".localhost")
}

/// Why a page of a browser pane may not be at `url`, or `None` when it may: only `http` and
/// `https`, a host, no user name or password in front of it, and not a name of the app.
fn refusal(url: &Url) -> Option<&'static str> {
    if !matches!(url.scheme(), "http" | "https") {
        return Some("Only http and https pages can be shown.");
    }
    let Some(host) = url.host_str() else {
        return Some("The address has no host.");
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Some("The address has a user name or password before the host.");
    }
    if is_app_host(host) {
        return Some("The address is one of the app's own.");
    }
    None
}

/// Whether the web view of a pane may go to `url`: the rule for the navigations the page makes by
/// itself (a link, a redirect, a script) and for the ones the interface asks for.
pub fn allows_navigation(url: &Url) -> bool {
    refusal(url).is_none()
}

/// The address the interface asked for, checked: it passes `check_external_link` (only `http` and
/// `https`, no blanks or control characters, a host, no user name; the rule of the links of the
/// terminal) and then [`refusal`] on what the engine will read.
pub fn check_url(address: &str) -> Result<Url, String> {
    noren_core::check_external_link(address).map_err(|e| e.to_string())?;
    let url = Url::parse(address).map_err(|e| format!("The address is not valid: {e}."))?;
    match refusal(&url) {
        None => Ok(url),
        Some(reason) => Err(reason.to_owned()),
    }
}

/// Checks the place asked for: finite numbers, a size that is not negative, nothing beyond the
/// limit (the position may be negative, a pane scrolled partly out of view).
pub fn check_bounds(bounds: &Bounds) -> Result<(), String> {
    let numbers = [
        ("x", bounds.x),
        ("y", bounds.y),
        ("width", bounds.width),
        ("height", bounds.height),
    ];
    for (name, value) in numbers {
        if !value.is_finite() {
            return Err(format!("{name} is not a finite number."));
        }
    }
    if bounds.width < 0.0 || bounds.height < 0.0 {
        return Err("The size cannot be negative.".to_owned());
    }
    if bounds.width > MAX_EXTENT || bounds.height > MAX_EXTENT {
        return Err("The size is too large.".to_owned());
    }
    if bounds.x.abs() > MAX_EXTENT || bounds.y.abs() > MAX_EXTENT {
        return Err("The position is too far from the window.".to_owned());
    }
    Ok(())
}

/// The native window `parent` names, or why it cannot be one: a window id that cannot name one, a
/// window the app did not open (or has closed), or one that is not there.
fn parent_window<R: Runtime>(app: &AppHandle<R>, parent: Parent) -> Result<Window<R>, String> {
    match parent {
        Parent::Main => app
            .get_window(PARENT_WINDOW)
            .ok_or_else(|| "The main window does not exist.".to_owned()),
        Parent::Window(window_id) => {
            let label = windows::window_label(window_id)?;
            let open = app
                .try_state::<WindowBook>()
                .is_some_and(|book| book.get(window_id).is_some());
            if !open {
                return Err(format!("Window {window_id} is not open."));
            }
            app.get_window(&label)
                .ok_or_else(|| format!("Window {window_id} does not exist."))
        }
    }
}

/// Opens the web view of the pane `pane_id` as a child of the `main` window (see [`open_in`]).
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    pane_id: &str,
    address: &str,
    bounds: Bounds,
    on_load: Option<LoadHook>,
) -> Result<(), String> {
    open_in(app, Parent::Main, pane_id, address, bounds, on_load)
}

/// Opens the web view of the pane `pane_id` as a child of `parent`, at `bounds` (from the top left
/// corner of the page of that window), showing `address`. Nothing is opened when the id, the address
/// or the place is refused, when the pane has a web view already (of any window) or when the parent
/// is not a window that exists and is open. `on_load` is called each time a page of the web view
/// finishes loading. Must not be called from the main thread: the web view is made there and this
/// waits for it.
pub fn open_in<R: Runtime>(
    app: &AppHandle<R>,
    parent: Parent,
    pane_id: &str,
    address: &str,
    bounds: Bounds,
    on_load: Option<LoadHook>,
) -> Result<(), String> {
    let label = pane_label(pane_id)?;
    let url = check_url(address)?;
    check_bounds(&bounds)?;
    if app.get_webview(&label).is_some() {
        return Err(format!("Pane {pane_id} has a web view already."));
    }
    let window = parent_window(app, parent)?;
    // Nothing is added to the builder that the page could use: no initialization script, no
    // custom protocol, no IPC handler of its own.
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .on_navigation(allows_navigation)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, event| !matches!(event, DownloadEvent::Requested { .. }))
        .on_permission_request(|_webview, _kind| PermissionResponse::Deny);
    if let Some(hook) = on_load {
        builder = builder.on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                hook(payload.url());
            }
        });
    }
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("Could not open the web view: {e}"))?;
    Ok(())
}

/// Takes the web view of the pane `pane_id` to `address`. The address is checked first; a pane
/// with no web view is an error.
pub fn navigate<R: Runtime>(
    app: &AppHandle<R>,
    pane_id: &str,
    address: &str,
) -> Result<(), String> {
    let label = pane_label(pane_id)?;
    let url = check_url(address)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Pane {pane_id} has no web view."))?;
    webview
        .navigate(url)
        .map_err(|e| format!("Could not go to the address: {e}"))
}

/// Moves and resizes the web view of the pane `pane_id`.
pub fn set_bounds<R: Runtime>(
    app: &AppHandle<R>,
    pane_id: &str,
    bounds: Bounds,
) -> Result<(), String> {
    let label = pane_label(pane_id)?;
    check_bounds(&bounds)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("Pane {pane_id} has no web view."))?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|()| webview.set_size(LogicalSize::new(bounds.width, bounds.height)))
        .map_err(|e| format!("Could not move the web view: {e}"))
}

/// Closes the web view of the pane `pane_id`. A pane with none is not an error.
pub fn close<R: Runtime>(app: &AppHandle<R>, pane_id: &str) -> Result<(), String> {
    let label = pane_label(pane_id)?;
    match app.get_webview(&label) {
        Some(webview) => webview
            .close()
            .map_err(|e| format!("Could not close the web view: {e}")),
        None => Ok(()),
    }
}

/// Closes the web view of every pane that is a child of the window `window_label`, so a window that
/// goes away leaves none behind (the pane of a tab that came back is opened again, as a child of
/// `main`, by the page that shows it). The window itself and its own page are not touched.
pub fn close_children<R: Runtime>(app: &AppHandle<R>, window_label: &str) {
    for (label, webview) in app.webviews() {
        if is_pane_label(&label) && webview.window().label() == window_label {
            // A web view that is going away already is of no interest.
            let _ = webview.close();
        }
    }
}

/// Runs `work` on a thread that may block, as the commands that touch a web view must: building one
/// waits for the main thread, which a command running on it would deadlock.
async fn off_the_main_thread(
    work: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("The web view task failed: {e}"))?
}

/// Opens the web view of the pane `pane_id`, a child of the window `window_id` or, when none is
/// given, of the `main` window (see [`open_in`]). Only the main window may call it: the page of a
/// window besides it asks the main window, which checks the request and calls this for it.
#[tauri::command(rename_all = "camelCase")]
pub async fn browser_open<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    pane_id: String,
    url: String,
    bounds: Bounds,
    window_id: Option<String>,
) -> Result<(), String> {
    windows::require_owner(&window)?;
    off_the_main_thread(move || {
        let parent = match window_id.as_deref() {
            Some(id) => Parent::Window(id),
            None => Parent::Main,
        };
        open_in(&app, parent, &pane_id, &url, bounds, None)
    })
    .await
}

/// Takes the web view of the pane `pane_id` to `url` (see [`navigate`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn browser_navigate<R: Runtime>(
    app: AppHandle<R>,
    pane_id: String,
    url: String,
) -> Result<(), String> {
    off_the_main_thread(move || navigate(&app, &pane_id, &url)).await
}

/// Moves and resizes the web view of the pane `pane_id` (see [`set_bounds`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn browser_set_bounds<R: Runtime>(
    app: AppHandle<R>,
    pane_id: String,
    bounds: Bounds,
) -> Result<(), String> {
    off_the_main_thread(move || set_bounds(&app, &pane_id, bounds)).await
}

/// Closes the web view of the pane `pane_id` (see [`close`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn browser_close<R: Runtime>(app: AppHandle<R>, pane_id: String) -> Result<(), String> {
    off_the_main_thread(move || close(&app, &pane_id)).await
}

/// For the tests of other files: opens the web view of a pane as a child of the `main` window of a
/// mock app and checks the fact they are about, that Tauri no longer finds that window as a webview
/// window (so a lookup of the old kind misses it).
#[cfg(test)]
pub(crate) fn open_a_pane_in_main<R: Runtime>(app: &AppHandle<R>) {
    let bounds = Bounds {
        x: 10.0,
        y: 20.0,
        width: 400.0,
        height: 300.0,
    };
    open(app, "p1", "https://example.com/", bounds, None).expect("a pane in the main window");
    assert!(app.get_webview_window(PARENT_WINDOW).is_none());
    assert!(app.get_window(PARENT_WINDOW).is_some());
}

#[cfg(test)]
mod tests;

//! The windows of the app besides the main one (NOR-F15-04a).
//!
//! A window shows one space of the workspace and no other window shows that space. The workspace says
//! which windows there are and which space each shows (`Workspace.windows` of `@noren/model`); this
//! side makes the native windows, tells which ones are open, and moves the output of the sessions of a
//! tab to the page of the window it was moved to.
//!
//! **One owner of the state.** The main window loads the workspace and is the only page that writes
//! `state.json`. The page of every other window (`WindowApp.tsx`) holds no workspace: it draws the
//! terminals of the sessions it is given. Three things keep it so: the page of a window `window-<id>`
//! never imports the app (`main.tsx`), its capability (`capabilities/window.json`) holds no command of
//! the state, the settings or the files, and the commands of the state refuse to answer to anything
//! but the main window ([`require_owner`]) even if a capability ever granted them.
//!
//! **Moving a tab** is moving the output of its sessions, not the sessions: the shells are the same
//! processes under the same ids ([`crate::bridge::attach_session`] puts another channel behind the
//! route of a session). A channel belongs to the page that made it, so the page of the window has to ask
//! for it: [`move_sessions`] tells that page which sessions to take (`window-take-sessions`) and waits
//! for its answer (`window-sessions-taken`).
//!
//! **Hidden windows.** A normal start shows a window it opens; every smoke run keeps them hidden
//! ([`WindowBook::new`]), so no run takes the focus of whoever is using the computer.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{
    AppHandle, Emitter, Listener, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};

use crate::bridge::AppState;
use crate::lifecycle::MAIN_LABEL;

/// The start of the label of the native window of every window of the workspace. The interface
/// chooses only what follows, so a window can never be named `main`, `quick` or the web view of a
/// browser pane (`browser-<pane id>`). `windowLabel` of `@noren/model` is the same rule.
pub const LABEL_PREFIX: &str = "window-";

/// Window page → everyone: the page listens for [`TAKE_EVENT`], `{ "windowId": "w1" }`.
pub const READY_EVENT: &str = "window-ready";
/// Rust → window pages: the window takes the output of these sessions over,
/// `{ "windowId": "w1", "request": 4, "ids": [3, 4] }`.
pub const TAKE_EVENT: &str = "window-take-sessions";
/// Window page → Rust: what became of a request, `{ "windowId": "w1", "request": 4, "ok": true,
/// "ids": [3, 4] }` or, for a refusal, `"ok": false` with the sessions taken before it and a `reason`.
pub const TAKEN_EVENT: &str = "window-sessions-taken";
/// Rust → everyone: the person closed the window, `{ "windowId": "w1" }`.
pub const CLOSED_EVENT: &str = "window-closed";
/// Main window → window pages: the space a window shows, `{ "windowId": "w1", "space": { ... } }`
/// (`window-sync.ts`; the smoke run plays the main window with it).
pub const STATE_EVENT: &str = "window-state";
/// Window page → main window: a change the window asks for, `{ "windowId": "w1", "action": { ... } }`.
pub const ACTION_EVENT: &str = "window-action";

/// The longest window id a label is made of; the same limit as `isWindowId` of `@noren/model`.
const MAX_WINDOW_ID: usize = 64;

/// How long the page of a window that was just made has to come up before a move gives up on it.
pub const READY_WAIT: Duration = Duration::from_secs(15);
/// How long the page of a window has to take over the sessions it was told to.
pub const TAKE_WAIT: Duration = Duration::from_secs(15);

/// The label of the native window of the window `window_id`, or why the id cannot name one: ASCII
/// letters, digits, `-` and `_`, at most 64 (the id the app makes, a UUID, is one).
pub fn window_label(window_id: &str) -> Result<String, String> {
    if is_window_id(window_id) {
        Ok(format!("{LABEL_PREFIX}{window_id}"))
    } else {
        Err(format!("{window_id:?} is not a window id."))
    }
}

fn is_window_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_WINDOW_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The id of the window a native window label names, or `None` for any other label.
pub fn window_id_of_label(label: &str) -> Option<&str> {
    label
        .strip_prefix(LABEL_PREFIX)
        .filter(|id| is_window_id(id))
}

/// Whether `label` names the native window of a window of the workspace.
pub fn is_window_label(label: &str) -> bool {
    window_id_of_label(label).is_some()
}

/// A window of the workspace that is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenWindow {
    /// The space it was opened for.
    pub space_id: String,
    /// Its page said it listens ([`READY_EVENT`]).
    pub ready: bool,
}

/// The windows that are open, by id, and whether the app shows the ones it opens.
pub struct WindowBook {
    show: bool,
    open: Mutex<HashMap<String, OpenWindow>>,
    changed: Condvar,
    requests: AtomicU64,
}

impl WindowBook {
    /// `show`: a window the app opens is shown at once (a normal start). Every smoke run passes
    /// `false` and its windows stay hidden.
    pub fn new(show: bool) -> Self {
        Self {
            show,
            open: Mutex::default(),
            changed: Condvar::new(),
            requests: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, OpenWindow>> {
        self.open.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a window the app opens is shown.
    pub fn shows_new_windows(&self) -> bool {
        self.show
    }

    /// Notes that the window is open for `space_id`. Fails when it is open already.
    pub fn add(&self, window_id: &str, space_id: &str) -> Result<(), String> {
        let mut open = self.lock();
        if open.contains_key(window_id) {
            return Err(format!("Window {window_id} is open already."));
        }
        open.insert(
            window_id.to_owned(),
            OpenWindow {
                space_id: space_id.to_owned(),
                ready: false,
            },
        );
        Ok(())
    }

    /// Notes that the window is gone. Returns whether it was noted as open.
    pub fn remove(&self, window_id: &str) -> bool {
        let removed = self.lock().remove(window_id).is_some();
        self.changed.notify_all();
        removed
    }

    /// Forgets every window (the app is going away).
    pub fn clear(&self) {
        self.lock().clear();
        self.changed.notify_all();
    }

    /// Notes that the page of the window listens. An id nobody opened is ignored.
    pub fn mark_ready(&self, window_id: &str) {
        if let Some(window) = self.lock().get_mut(window_id) {
            window.ready = true;
        }
        self.changed.notify_all();
    }

    /// The window, if it is open.
    pub fn get(&self, window_id: &str) -> Option<OpenWindow> {
        self.lock().get(window_id).cloned()
    }

    /// The ids of the open windows, in alphabetical order.
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Waits until the page of the window listens. Fails when the window is not open or is closed
    /// meanwhile, and when the page does not come up within `timeout`.
    pub fn wait_ready(&self, window_id: &str, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut open = self.lock();
        loop {
            match open.get(window_id) {
                None => return Err(format!("Window {window_id} is not open.")),
                Some(window) if window.ready => return Ok(()),
                Some(_) => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!(
                    "The page of window {window_id} did not come up within {} seconds.",
                    timeout.as_secs()
                ));
            }
            open = self
                .changed
                .wait_timeout(open, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// A number for the next request to a page, so an answer is known for the request it answers.
    fn next_request(&self) -> u64 {
        self.requests.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Listens for [`READY_EVENT`] for the life of the app, so [`move_sessions`] knows when a page that
/// was just made is up. Called once, when the app is set up.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.listen(READY_EVENT, move |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        let Some(window_id) = payload.get("windowId").and_then(Value::as_str) else {
            return;
        };
        if let Some(book) = handle.try_state::<WindowBook>() {
            book.mark_ready(window_id);
        }
    });
}

/// Makes the native window of the window `window_id` showing the space `space_id`: it loads the page
/// of the app (which draws only the tabs moved to it, see the top of this file), and is shown unless
/// the run is a smoke run. Fails, making nothing, when the id cannot name a window, the space is
/// blank or the window is open already.
pub fn open_window<R: Runtime>(
    app: &AppHandle<R>,
    window_id: &str,
    space_id: &str,
) -> Result<WebviewWindow<R>, String> {
    let label = window_label(window_id)?;
    if space_id.trim().is_empty() {
        return Err("A window needs the space it shows.".to_owned());
    }
    let book = app.state::<WindowBook>();
    book.add(window_id, space_id)?;
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Noren")
        .inner_size(960.0, 640.0)
        .visible(false)
        .focused(false)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            book.remove(window_id);
            return Err(error.to_string());
        }
    };
    if book.shows_new_windows() {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(window)
}

/// Closes the window `window_id`. A window that is not open is not an error. The sessions it was
/// showing are not ended: they stay as they are, with nowhere to send their output until a page
/// takes them over. A close the app asks for is not told as one the person made ([`on_destroyed`]).
pub fn close_window<R: Runtime>(app: &AppHandle<R>, window_id: &str) -> Result<(), String> {
    let label = window_label(window_id)?;
    app.state::<WindowBook>().remove(window_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Called when the native window of a window is gone. One the app did not ask to close (the person
/// used the close button) is told to the interface, which takes it out of the workspace.
pub fn on_destroyed<R: Runtime>(app: &AppHandle<R>, window_id: &str) {
    let Some(book) = app.try_state::<WindowBook>() else {
        return;
    };
    if book.remove(window_id) {
        let _ = app.emit(CLOSED_EVENT, json!({ "windowId": window_id }));
    }
}

/// Destroys every window besides the main one, for the app is closing (a hidden window would keep
/// it running with nothing to see).
pub fn destroy_all<R: Runtime>(app: &AppHandle<R>) {
    if let Some(book) = app.try_state::<WindowBook>() {
        book.clear();
    }
    for (label, window) in app.webview_windows() {
        if is_window_label(&label) {
            let _ = window.destroy();
        }
    }
}

/// Fails unless the command came from the main window, the one that owns the workspace and writes
/// `state.json`. The capabilities already give the commands of the state to no other window; this is
/// the second wall, for a capability added by mistake.
pub fn require_owner<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    if window.label() == MAIN_LABEL {
        Ok(())
    } else {
        Err(format!(
            "The window {} does not own the state of the app.",
            window.label()
        ))
    }
}

/// What a page answered to a request: `Some(Ok)` when it took the sessions, `Some(Err(reason))` when
/// it refused, and `None` when the answer is about another window or another request.
fn verdict(payload: &Value, window_id: &str, request: u64) -> Option<Result<(), String>> {
    if payload.get("windowId").and_then(Value::as_str) != Some(window_id)
        || payload.get("request").and_then(Value::as_u64) != Some(request)
    {
        return None;
    }
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        return Some(Ok(()));
    }
    let reason = payload
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("no reason given");
    Some(Err(reason.to_owned()))
}

/// Waits for the answer to `request` from the page of `window_id`, up to `timeout`.
fn wait_for_answer(
    answers: &Receiver<Value>,
    window_id: &str,
    request: u64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match answers.recv_timeout(remaining) {
            Ok(payload) => {
                if let Some(result) = verdict(&payload, window_id, request) {
                    return result;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "The page of window {window_id} did not take the sessions over within {} seconds.",
                    timeout.as_secs()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("The app stopped listening for the page of the window.".to_owned());
            }
        }
    }
}

/// Moves the output of the live sessions `session_ids` to the page of the window `window_id`: the
/// page is told which sessions to take and takes them over with `session_attach` from its own
/// page, so each one is the same process under the same id and nothing it prints is lost. Returns
/// when the page has taken all of them. Fails, before anything is moved, when the window is not
/// open or a session is not a live one; fails when the page does not come up, does not answer
/// within [`TAKE_WAIT`] or refuses. This blocks the thread: it runs in `spawn_blocking`.
pub fn move_sessions<R: Runtime>(
    app: &AppHandle<R>,
    window_id: &str,
    session_ids: &[u64],
    ready_wait: Duration,
    take_wait: Duration,
) -> Result<(), String> {
    let book = app.state::<WindowBook>();
    if book.get(window_id).is_none() {
        return Err(format!("Window {window_id} is not open."));
    }
    // A tab with no shell (a page, a file, a diff) has nothing to take over.
    if session_ids.is_empty() {
        return Ok(());
    }
    let state = app.state::<AppState>();
    for id in session_ids {
        if state.route(*id).is_none() {
            return Err(format!("unknown session {id}"));
        }
    }
    book.wait_ready(window_id, ready_wait)?;

    let request = book.next_request();
    let (tx, answers) = mpsc::channel::<Value>();
    // Listening before asking, so an answer that is quick cannot be missed.
    let listener = app.listen(TAKEN_EVENT, move |event| {
        if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
            let _ = tx.send(payload);
        }
    });
    let asked = app.emit(
        TAKE_EVENT,
        json!({ "windowId": window_id, "request": request, "ids": session_ids }),
    );
    let outcome = match asked {
        Ok(()) => wait_for_answer(&answers, window_id, request, take_wait),
        Err(error) => Err(error.to_string()),
    };
    app.unlisten(listener);
    outcome
}

/// Makes the native window of a window of the workspace (see [`open_window`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn window_open<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    window_id: String,
    space_id: String,
) -> Result<(), String> {
    require_owner(&window)?;
    open_window(&app, &window_id, &space_id).map(|_| ())
}

/// Closes the native window of a window of the workspace (see [`close_window`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn window_close<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    window_id: String,
) -> Result<(), String> {
    require_owner(&window)?;
    close_window(&app, &window_id)
}

/// Moves the output of the sessions of a tab to the window (see [`move_sessions`]).
#[tauri::command(rename_all = "camelCase")]
pub async fn window_move_tab<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    window_id: String,
    session_ids: Vec<u64>,
) -> Result<(), String> {
    require_owner(&window)?;
    // The page of the window answers on its own thread of the web view; this one waits for it.
    tauri::async_runtime::spawn_blocking(move || {
        move_sessions(&app, &window_id, &session_ids, READY_WAIT, TAKE_WAIT)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use noren_core::{Profile, ProfileSet, SessionId};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

    use super::*;
    use crate::bridge::create_session;

    // ---- Labels ----

    #[test]
    fn a_label_is_the_prefix_and_an_id_made_of_letters_digits_dash_and_underscore() {
        assert_eq!(window_label("w1"), Ok("window-w1".to_owned()));
        assert_eq!(
            window_label("3f2b9c1e-7d4a-4b6e-9a51-0c2d8e7f1a33"),
            Ok("window-3f2b9c1e-7d4a-4b6e-9a51-0c2d8e7f1a33".to_owned())
        );
        assert!(window_label(&"x".repeat(64)).is_ok());
        for id in ["", "a b", "a/b", "a:b", "é", "../w", "w*", "w\n"] {
            assert!(window_label(id).is_err(), "{id:?}");
        }
        assert!(window_label(&"x".repeat(65)).is_err());
    }

    #[test]
    fn only_a_label_with_the_prefix_and_a_good_id_names_a_window() {
        assert_eq!(window_id_of_label("window-w1"), Some("w1"));
        assert!(is_window_label("window-3f2b"));
        for label in [
            "main",
            "quick",
            "browser-p1",
            "window-",
            "window-a b",
            "window-*",
            "windows-w1",
            "Window-w1",
            "",
        ] {
            assert!(!is_window_label(label), "{label:?}");
        }
    }

    #[test]
    fn a_window_label_is_never_the_label_of_another_kind_of_webview() {
        for id in ["main", "quick", "browser-p1", "w1"] {
            let label = window_label(id).expect("a label");
            assert_ne!(label, MAIN_LABEL);
            assert_ne!(label, crate::quick::QUICK_LABEL);
            assert!(!crate::browser_pane::is_pane_label(&label), "{label}");
        }
        // And no web view of a pane is read as a window.
        assert!(!is_window_label(
            &crate::browser_pane::pane_label("w1").expect("a pane label")
        ));
    }

    #[test]
    fn the_names_are_the_ones_the_page_uses() {
        // The same strings are in apps/desktop/src/window-events.ts and packages/model/src/windows.ts.
        assert_eq!(LABEL_PREFIX, "window-");
        assert_eq!(READY_EVENT, "window-ready");
        assert_eq!(TAKE_EVENT, "window-take-sessions");
        assert_eq!(TAKEN_EVENT, "window-sessions-taken");
        assert_eq!(CLOSED_EVENT, "window-closed");
        assert_eq!(STATE_EVENT, "window-state");
        assert_eq!(ACTION_EVENT, "window-action");
    }

    // ---- The book ----

    #[test]
    fn a_window_is_open_once_and_again_after_it_is_removed() {
        let book = WindowBook::new(false);
        assert!(book.add("w1", "s2").is_ok());
        assert_eq!(
            book.add("w1", "s3"),
            Err("Window w1 is open already.".to_owned())
        );
        assert_eq!(
            book.get("w1"),
            Some(OpenWindow {
                space_id: "s2".to_owned(),
                ready: false
            })
        );
        assert!(book.add("w2", "s3").is_ok());
        assert_eq!(book.ids(), ["w1", "w2"]);
        assert!(book.remove("w1"));
        assert!(!book.remove("w1"), "removed once");
        assert!(book.add("w1", "s2").is_ok());
        book.clear();
        assert!(book.ids().is_empty());
    }

    #[test]
    fn a_smoke_run_shows_nothing_a_normal_start_shows_what_it_opens() {
        assert!(!WindowBook::new(false).shows_new_windows());
        assert!(WindowBook::new(true).shows_new_windows());
    }

    #[test]
    fn waiting_for_a_page_ends_when_it_says_it_listens() {
        let book = Arc::new(WindowBook::new(false));
        book.add("w1", "s2").expect("add");
        let waiting = {
            let book = Arc::clone(&book);
            std::thread::spawn(move || book.wait_ready("w1", Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(50));
        // A page that is not this one's does not release it.
        book.mark_ready("w9");
        assert!(!waiting.is_finished());
        book.mark_ready("w1");
        assert_eq!(waiting.join().expect("the waiting thread"), Ok(()));
        assert_eq!(book.wait_ready("w1", Duration::ZERO), Ok(()));
    }

    #[test]
    fn waiting_for_a_page_fails_on_the_time_and_on_a_window_that_is_gone() {
        let book = Arc::new(WindowBook::new(false));
        assert_eq!(
            book.wait_ready("w1", Duration::ZERO),
            Err("Window w1 is not open.".to_owned())
        );
        book.add("w1", "s2").expect("add");
        let error = book
            .wait_ready("w1", Duration::from_millis(30))
            .expect_err("nobody answers");
        assert!(error.contains("did not come up"), "{error}");

        let waiting = {
            let book = Arc::clone(&book);
            std::thread::spawn(move || book.wait_ready("w1", Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(50));
        book.remove("w1");
        assert_eq!(
            waiting.join().expect("the waiting thread"),
            Err("Window w1 is not open.".to_owned())
        );
    }

    #[test]
    fn each_request_has_a_number_of_its_own() {
        let book = WindowBook::new(false);
        let numbers: Vec<u64> = (0..3).map(|_| book.next_request()).collect();
        assert_eq!(numbers, [1, 2, 3]);
    }

    // ---- What a page answers ----

    #[test]
    fn an_answer_counts_for_its_window_and_its_request_only() {
        let ok = json!({ "windowId": "w1", "request": 4, "ok": true, "ids": [3] });
        assert_eq!(verdict(&ok, "w1", 4), Some(Ok(())));
        assert_eq!(verdict(&ok, "w2", 4), None, "another window");
        assert_eq!(verdict(&ok, "w1", 5), None, "another request");
        let refused =
            json!({ "windowId": "w1", "request": 4, "ok": false, "ids": [], "reason": "no" });
        assert_eq!(verdict(&refused, "w1", 4), Some(Err("no".to_owned())));
        let silent = json!({ "windowId": "w1", "request": 4, "ok": false });
        assert_eq!(
            verdict(&silent, "w1", 4),
            Some(Err("no reason given".to_owned()))
        );
        // Anything that is not an answer is not one.
        for junk in [json!(null), json!("ok"), json!({}), json!({ "ok": true })] {
            assert_eq!(verdict(&junk, "w1", 4), None, "{junk}");
        }
        // `ok` must be the boolean true.
        let loose = json!({ "windowId": "w1", "request": 4, "ok": "true" });
        assert!(matches!(verdict(&loose, "w1", 4), Some(Err(_))));
    }

    #[test]
    fn waiting_for_an_answer_skips_the_ones_that_are_not_its_own() {
        let (tx, rx) = mpsc::channel();
        tx.send(json!({ "windowId": "w2", "request": 1, "ok": false, "reason": "other" }))
            .expect("send");
        tx.send(json!({ "windowId": "w1", "request": 9, "ok": false, "reason": "old" }))
            .expect("send");
        tx.send(json!({ "windowId": "w1", "request": 1, "ok": true }))
            .expect("send");
        assert_eq!(
            wait_for_answer(&rx, "w1", 1, Duration::from_secs(1)),
            Ok(())
        );

        let (tx, rx) = mpsc::channel::<Value>();
        let error =
            wait_for_answer(&rx, "w1", 1, Duration::from_millis(30)).expect_err("no answer");
        assert!(error.contains("did not take the sessions over"), "{error}");
        drop(tx);
        let error = wait_for_answer(&rx, "w1", 1, Duration::from_secs(1)).expect_err("closed");
        assert!(error.contains("stopped listening"), "{error}");
    }

    // ---- Windows in the mock runtime ----

    fn app_with_book(show: bool) -> tauri::App<MockRuntime> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("a mock app");
        app.manage(WindowBook::new(show));
        install(app.handle());
        tauri::WebviewWindowBuilder::new(&app, MAIN_LABEL, WebviewUrl::default())
            .build()
            .expect("the main window");
        app
    }

    #[test]
    fn a_window_is_made_with_a_label_of_its_own_and_cannot_be_made_twice() {
        let app = app_with_book(false);
        let window = open_window(app.handle(), "w1", "s2").expect("open");
        assert_eq!(window.label(), "window-w1");
        assert!(app.get_webview_window("window-w1").is_some());
        assert_eq!(app.state::<WindowBook>().ids(), ["w1"]);
        assert_eq!(
            open_window(app.handle(), "w1", "s3").err(),
            Some("Window w1 is open already.".to_owned())
        );
        open_window(app.handle(), "w2", "s3").expect("another window");
        assert_eq!(app.state::<WindowBook>().ids(), ["w1", "w2"]);
        // The window of the main page and the two others, nothing else.
        assert_eq!(app.webview_windows().len(), 3);
    }

    #[test]
    fn a_window_that_cannot_be_named_or_has_no_space_is_not_made() {
        let app = app_with_book(false);
        for id in ["", "a b", "../x", "w/1"] {
            assert!(open_window(app.handle(), id, "s2").is_err(), "{id:?}");
        }
        // A good id that is also the name of another window only ever becomes `window-main` or
        // `window-quick`: never the label of the main window or of the quick one.
        for id in ["main", "quick"] {
            let window = open_window(app.handle(), id, "s2").expect("an id that is a name");
            assert_eq!(window.label(), format!("window-{id}"));
            close_window(app.handle(), id).expect("close");
        }
        assert!(open_window(app.handle(), "w1", "  ").is_err());
        assert!(open_window(app.handle(), "w1", "").is_err());
        // Nothing was made for the ones that were refused, and nothing is noted as open (the
        // mock runtime has no event loop, so the two windows that were closed still show in its list).
        for label in [
            "window-",
            "window-a b",
            "window-../x",
            "window-w/1",
            "window-w1",
        ] {
            assert!(app.get_webview_window(label).is_none(), "{label}");
        }
        assert!(app.state::<WindowBook>().ids().is_empty());
        assert!(app.get_webview_window("main").is_some());
    }

    #[test]
    fn closing_a_window_closes_only_that_one_and_is_not_told_as_the_persons() {
        let app = app_with_book(false);
        open_window(app.handle(), "w1", "s2").expect("open");
        open_window(app.handle(), "w2", "s3").expect("open");
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&told);
        app.listen(CLOSED_EVENT, move |event| {
            sink.lock().unwrap().push(event.payload().to_owned());
        });

        // (The mock runtime has no event loop, so a window it destroys stays in its list: that
        // it goes, and the event of its going, are what `noren --smoke-window` shows for real.)
        close_window(app.handle(), "w1").expect("close");
        assert!(app.get_webview_window("window-w2").is_some());
        assert!(app.get_webview_window("main").is_some());
        assert_eq!(app.state::<WindowBook>().ids(), ["w2"]);
        // Closing one that is not open is fine.
        close_window(app.handle(), "w1").expect("close again");
        close_window(app.handle(), "w9").expect("close one that was never open");
        // The window event of the destruction finds the book without it: the app asked for this.
        on_destroyed(app.handle(), "w1");
        assert!(told.lock().unwrap().is_empty());
    }

    #[test]
    fn a_window_the_person_closed_is_told_once() {
        let app = app_with_book(false);
        open_window(app.handle(), "w1", "s2").expect("open");
        let told = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&told);
        app.listen(CLOSED_EVENT, move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).expect("a payload"));
        });
        on_destroyed(app.handle(), "w1");
        on_destroyed(app.handle(), "w1");
        assert_eq!(*told.lock().unwrap(), [json!({ "windowId": "w1" })]);
        assert!(app.state::<WindowBook>().ids().is_empty());
    }

    #[test]
    fn closing_the_app_destroys_every_window_but_the_main_one_and_the_web_views_of_panes() {
        let app = app_with_book(false);
        open_window(app.handle(), "w1", "s2").expect("open");
        open_window(app.handle(), "w2", "s3").expect("open");
        destroy_all(app.handle());
        assert!(app.state::<WindowBook>().ids().is_empty());
        assert!(app.get_webview_window("main").is_some());
    }

    #[test]
    fn the_page_saying_it_listens_marks_its_window_ready() {
        let app = app_with_book(false);
        open_window(app.handle(), "w1", "s2").expect("open");
        let book = app.state::<WindowBook>();
        assert_eq!(book.get("w1").map(|w| w.ready), Some(false));
        app.emit(READY_EVENT, json!({ "windowId": "w1" }))
            .expect("emit");
        assert_eq!(book.get("w1").map(|w| w.ready), Some(true));
        // Junk and unknown windows are ignored.
        app.emit(READY_EVENT, json!({ "windowId": "w9" }))
            .expect("emit");
        app.emit(READY_EVENT, json!("w1")).expect("emit");
        app.emit(READY_EVENT, json!({ "windowId": 3 }))
            .expect("emit");
        assert_eq!(book.ids(), ["w1"]);
    }

    #[test]
    fn only_the_main_window_owns_the_state() {
        let app = app_with_book(false);
        open_window(app.handle(), "w1", "s2").expect("open");
        let main = app.get_webview_window("main").expect("main");
        assert_eq!(require_owner(&main.as_ref().window()), Ok(()));
        let other = app.get_webview_window("window-w1").expect("the window");
        let refused = require_owner(&other.as_ref().window()).expect_err("not the owner");
        assert!(refused.contains("window-w1"), "{refused}");
        // Neither the quick window nor a window that borrows the name `main` after the prefix.
        let quick = tauri::WebviewWindowBuilder::new(&app, "quick", WebviewUrl::default())
            .build()
            .expect("quick");
        assert!(require_owner(&quick.as_ref().window()).is_err());
        let sneaky = open_window(app.handle(), "main", "s3").expect("a window called main");
        assert_eq!(sneaky.label(), "window-main");
        assert!(require_owner(&sneaky.as_ref().window()).is_err());
    }

    // ---- The commands, called the way the page calls them ----

    /// Calls `cmd` as the page of the window `label` does, through the same dispatch as a real page.
    /// (The mock runtime has no capabilities: what refuses a call here is the command itself.)
    fn call_from(
        app: &tauri::App<MockRuntime>,
        label: &str,
        cmd: &str,
        args: Value,
    ) -> Result<InvokeResponseBody, Value> {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response};
        use tauri::webview::InvokeRequest;

        let webview = app
            .get_webview_window(label)
            .expect("the window of the page");
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
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    /// An app that has the commands of the windows and of the state registered, a book, a state file
    /// in a folder of its own, the main window and a window `window-w1`.
    fn app_with_the_commands(folder: &str) -> (tauri::App<MockRuntime>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("noren-test-{folder}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("make the folder");
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                window_open,
                window_close,
                window_move_tab,
                crate::bridge::state_load,
                crate::bridge::state_save,
                crate::bridge::state_quarantine
            ])
            .build(mock_context(noop_assets()))
            .expect("a mock app");
        app.manage(WindowBook::new(false));
        app.manage(noren_core::StateStore::new(dir.join("state.json")));
        app.manage(shell_state());
        install(app.handle());
        tauri::WebviewWindowBuilder::new(&app, MAIN_LABEL, WebviewUrl::default())
            .build()
            .expect("the main window");
        open_window(app.handle(), "w1", "s2").expect("a window");
        (app, dir)
    }

    #[test]
    fn the_main_window_makes_moves_and_closes_windows_with_the_names_the_page_sends() {
        let (app, dir) = app_with_the_commands("window-commands");
        let book = app.state::<WindowBook>();
        let from_main = |cmd: &str, args: Value| call_from(&app, MAIN_LABEL, cmd, args);

        from_main("window_open", json!({ "windowId": "w2", "spaceId": "s3" })).expect("open");
        assert_eq!(book.ids(), ["w1", "w2"]);
        let error = from_main("window_open", json!({ "windowId": "w2", "spaceId": "s3" }))
            .expect_err("open already");
        assert_eq!(error, json!("Window w2 is open already."));
        let error = from_main("window_open", json!({ "windowId": "a b", "spaceId": "s3" }))
            .expect_err("not a name");
        assert!(
            error
                .as_str()
                .is_some_and(|e| e.contains("not a window id"))
        );

        // A tab with no shell resolves at once; one for a window that is not open does not.
        from_main(
            "window_move_tab",
            json!({ "windowId": "w1", "sessionIds": [] }),
        )
        .expect("move");
        let error = from_main(
            "window_move_tab",
            json!({ "windowId": "w9", "sessionIds": [] }),
        )
        .expect_err("not open");
        assert_eq!(error, json!("Window w9 is not open."));
        let error = from_main(
            "window_move_tab",
            json!({ "windowId": "w1", "sessionIds": [4242] }),
        )
        .expect_err("no such session");
        assert_eq!(error, json!("unknown session 4242"));

        from_main("window_close", json!({ "windowId": "w2" })).expect("close");
        assert_eq!(book.ids(), ["w1"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_window_besides_the_main_one_is_refused_by_every_command_that_owns_the_workspace() {
        let (app, dir) = app_with_the_commands("window-owner");
        let from_window = |cmd: &str, args: Value| call_from(&app, "window-w1", cmd, args);
        let refused = |answer: Result<InvokeResponseBody, Value>| {
            let error = answer.expect_err("refused");
            assert!(
                error
                    .as_str()
                    .is_some_and(|e| e.contains("does not own the state")),
                "{error}"
            );
        };
        refused(from_window(
            "window_open",
            json!({ "windowId": "w2", "spaceId": "s3" }),
        ));
        refused(from_window("window_close", json!({ "windowId": "w1" })));
        refused(from_window(
            "window_move_tab",
            json!({ "windowId": "w1", "sessionIds": [] }),
        ));
        refused(from_window("state_load", json!({})));
        refused(from_window("state_save", json!({ "content": "{}" })));
        refused(from_window("state_quarantine", json!({})));
        // Nothing was done: no window made or closed, and no file written.
        assert_eq!(app.state::<WindowBook>().ids(), ["w1"]);
        assert!(!dir.join("state.json").exists());

        // The main window gets the same calls through.
        let from_main = |cmd: &str, args: Value| call_from(&app, MAIN_LABEL, cmd, args);
        from_main("state_save", json!({ "content": "{}" })).expect("save");
        assert!(dir.join("state.json").exists());
        from_main("state_load", json!({})).expect("load");
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---- Moving the output of sessions to a window ----

    /// Everything a channel received, as bytes.
    type Received = Arc<Mutex<Vec<u8>>>;

    fn collecting() -> (Channel<InvokeResponseBody>, Received) {
        let received: Received = Arc::default();
        let sink = Arc::clone(&received);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend_from_slice(&bytes);
            }
            Ok(())
        });
        (channel, received)
    }

    fn shell_state() -> AppState {
        AppState::with_detected(ProfileSet {
            profiles: vec![shell_profile()],
            default_id: Some("test".to_owned()),
        })
    }

    #[cfg(windows)]
    fn shell_profile() -> Profile {
        Profile {
            id: "test".to_owned(),
            name: "Test shell".to_owned(),
            program: "powershell.exe".to_owned(),
            args: vec!["-NoLogo".to_owned(), "-NoProfile".to_owned()],
            cwd: None,
            inject_integration: false,
            remote: None,
        }
    }
    #[cfg(not(windows))]
    fn shell_profile() -> Profile {
        Profile {
            id: "test".to_owned(),
            name: "Test shell".to_owned(),
            program: "sh".to_owned(),
            args: Vec::new(),
            cwd: None,
            inject_integration: false,
            remote: None,
        }
    }

    /// An app with a main window, a window `w1` and a live shell whose output is collected.
    fn app_with_a_shell() -> (tauri::App<MockRuntime>, u64, Received) {
        let app = app_with_book(false);
        app.manage(shell_state());
        open_window(app.handle(), "w1", "s2").expect("open");
        let (channel, received) = collecting();
        let state = app.state::<AppState>();
        let (id, _) = create_session(app.handle(), &state, None, None, None, 80, 24, channel)
            .expect("start the shell");
        (app, id, received)
    }

    /// Stands in for the page of the window: answers each request with `answer`, which is given the
    /// payload of the request and returns what to say back.
    fn page_of_window(
        app: &tauri::App<MockRuntime>,
        answer: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) {
        let handle = app.handle().clone();
        let answer = Arc::new(answer);
        app.listen(TAKE_EVENT, move |event| {
            let request: Value = serde_json::from_str(event.payload()).expect("a request");
            // From a thread of its own, as a page answers: not from inside the event it answers.
            let handle = handle.clone();
            let answer = Arc::clone(&answer);
            std::thread::spawn(move || {
                let _ = handle.emit(TAKEN_EVENT, answer(&request));
            });
        });
    }

    fn said_yes(request: &Value) -> Value {
        json!({
            "windowId": request["windowId"],
            "request": request["request"],
            "ok": true,
            "ids": request["ids"],
        })
    }

    const SHORT: Duration = Duration::from_millis(300);

    #[test]
    fn the_page_is_asked_for_the_sessions_and_the_move_ends_when_it_has_taken_them() {
        let (app, id, _received) = app_with_a_shell();
        let asked = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = Arc::clone(&asked);
        page_of_window(&app, move |request| {
            sink.lock().unwrap().push(request.clone());
            said_yes(request)
        });
        app.emit(READY_EVENT, json!({ "windowId": "w1" }))
            .expect("the page is up");

        move_sessions(app.handle(), "w1", &[id], SHORT, Duration::from_secs(5)).expect("move");
        let asked = asked.lock().unwrap();
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0]["windowId"], "w1");
        assert_eq!(asked[0]["ids"], json!([id]));
        assert!(asked[0]["request"].as_u64().is_some());
        let state = app.state::<AppState>();
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    #[test]
    fn a_page_that_refuses_fails_the_move_with_its_reason() {
        let (app, id, _received) = app_with_a_shell();
        page_of_window(&app, |request| {
            json!({
                "windowId": request["windowId"],
                "request": request["request"],
                "ok": false,
                "ids": [],
                "reason": "unknown session 7",
            })
        });
        app.emit(READY_EVENT, json!({ "windowId": "w1" }))
            .expect("up");
        let error = move_sessions(app.handle(), "w1", &[id], SHORT, Duration::from_secs(5))
            .expect_err("refused");
        assert_eq!(error, "unknown session 7");
        let state = app.state::<AppState>();
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    #[test]
    fn a_page_that_does_not_answer_ends_the_wait_and_one_that_never_came_up_ends_it_sooner() {
        let (app, id, _received) = app_with_a_shell();
        let error = move_sessions(app.handle(), "w1", &[id], SHORT, SHORT).expect_err("not up");
        assert!(error.contains("did not come up"), "{error}");
        app.emit(READY_EVENT, json!({ "windowId": "w1" }))
            .expect("up");
        let error = move_sessions(app.handle(), "w1", &[id], SHORT, SHORT).expect_err("silent");
        assert!(error.contains("did not take the sessions over"), "{error}");
        let state = app.state::<AppState>();
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    #[test]
    fn nothing_is_asked_of_the_page_for_a_window_that_is_not_open_or_a_session_that_is_not_alive() {
        let (app, id, _received) = app_with_a_shell();
        let asked = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&asked);
        page_of_window(&app, move |request| {
            flag.store(true, Ordering::SeqCst);
            said_yes(request)
        });
        app.emit(READY_EVENT, json!({ "windowId": "w1" }))
            .expect("up");
        assert_eq!(
            move_sessions(app.handle(), "w9", &[id], SHORT, SHORT),
            Err("Window w9 is not open.".to_owned())
        );
        assert_eq!(
            move_sessions(app.handle(), "w1", &[id, id + 1000], SHORT, SHORT),
            Err(format!("unknown session {}", id + 1000))
        );
        assert!(!asked.load(Ordering::SeqCst), "the page was asked nothing");
        // A tab with no shell has nothing to take, and the page is not asked either.
        assert_eq!(move_sessions(app.handle(), "w1", &[], SHORT, SHORT), Ok(()));
        assert!(!asked.load(Ordering::SeqCst));
        let state = app.state::<AppState>();
        state.sessions.kill(SessionId(id)).expect("kill");
    }

    #[test]
    fn the_answer_of_an_older_request_does_not_end_a_newer_one() {
        let (app, id, _received) = app_with_a_shell();
        page_of_window(&app, |request| {
            // First a stale answer (an earlier request), then the right one.
            json!({
                "windowId": request["windowId"],
                "request": request["request"].as_u64().unwrap_or(0) + 100,
                "ok": false,
                "reason": "an old one",
            })
        });
        app.emit(READY_EVENT, json!({ "windowId": "w1" }))
            .expect("up");
        let error =
            move_sessions(app.handle(), "w1", &[id], SHORT, SHORT).expect_err("only stale answers");
        assert!(error.contains("did not take the sessions over"), "{error}");
        let state = app.state::<AppState>();
        state.sessions.kill(SessionId(id)).expect("kill");
    }
}

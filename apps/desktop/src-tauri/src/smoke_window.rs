//! A second window in the real app, and a tab moved to it (`noren --smoke-window`, NOR-F15-04a).
//!
//! The run makes the second window through the same `windows::open_window` the command uses, hidden
//! like every window of a smoke run, and lets its page come up for real: the page of the window
//! (`WindowApp.tsx`) is code running in the web view, under the capability `capabilities/window.json`
//! and the navigation guard of `navigation.rs`. What the run checks, in order:
//!
//! 1. the second window exists, is hidden (and so is the main one), and its page says it listens;
//! 2. the page can call none of the commands that own or change the workspace (the state, the
//!    settings, starting or ending a shell, making or closing windows, the web views of panes), each
//!    refused by the access control of the app, and cannot be taken to a web page;
//! 3. a shell that is running, standing for a tab of the main window (the run reads its output
//!    through a channel of its own), is moved to the window through `windows::move_sessions`, the
//!    function behind the `window_move_tab` command: the page takes the output over from its own page
//!    (`session_attach` under its own capability) and answers. The shell is the same session under the
//!    same id and the same process, nothing was started or ended, the output of the old channel
//!    stopped and what the shell prints now reaches the channel of the page. The run then plays the
//!    main window and sends the page the space it shows (`window-state`): the page draws the sidebar
//!    with its tab and a terminal for the session, and a click on the tab, and one on the button for a
//!    new tab, reach the main window as requests (`window-action`, NOR-F15-04b and 04c). What the
//!    shell printed before the move is what the terminal of the page starts with: the page asks for
//!    it (`session_attach` with `replay`) and the daemon sends it ahead of the output that follows
//!    (NOR-F15-04c);
//! 4. a browser pane shown by the window: its web view is opened as a child of `window-<id>` (the
//!    way the main window does it for the page of the window, which cannot call `browser_*`), hidden
//!    with its window, on a local page that can reach nothing of the app, and it goes with the window
//!    when the app closes it (NOR-F15-04e, `smoke_browser.rs`);
//! 5. a window the app closes is gone and a shell that was in it is not touched, and a window the
//!    person closes (the run closes it the way the close button does) is told with `window-closed`.
//!
//! Every step prints a `SMOKE ...` line; `scripts/smoke.mjs` requires the ones that matter.

use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use noren_core::SessionId;
use serde_json::{Value, json};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::bridge::{self, AppState};
use crate::smoke::{
    Heard, Inbox, check_daemon_stopped, check_no_global_shortcut, check_runs_in_daemon,
    check_window_hidden, fresh_dir, locate_in_daemon, print_line, wait_for_route_line,
};
use crate::smoke_browser;
use crate::windows::{self, ACTION_EVENT, CLOSED_EVENT, READY_WAIT, STATE_EVENT, TAKE_WAIT};

pub const SMOKE_WINDOW_FLAG: &str = "--smoke-window";

/// The whole run, from `app-ready` to the daemon stopped, has this long.
const TIMEOUT: Duration = Duration::from_secs(50);
/// The windows the run makes (a window id is a name: letters, digits, `-` and `_`).
const WINDOW_ID: &str = "smoke-window-1";
const SECOND_WINDOW_ID: &str = "smoke-window-2";
/// The space the windows stand for (the run holds no workspace of its own to look one up in).
const SPACE_ID: &str = "smoke-space";
/// Lines the shell prints before and after the move.
const BEFORE: &str = "noren-window-before";
const AFTER: &str = "noren-window-after";
/// How much of the output the run keeps to look for those lines in.
const TAIL_BYTES: usize = 16 * 1024;
/// What the page reports to the run (`eval` cannot answer, so the page emits this event).
const PROBE_EVENT: &str = "window-probe";
/// The tab and the pane of the space the run sends the window, as the main window would.
const TAB_ID: &str = "smoke-tab";
const PANE_ID: &str = "smoke-pane";

/// Whether `--smoke-window` is among the arguments (the first one is the program).
pub fn has_flag(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == SMOKE_WINDOW_FLAG)
}

/// The folder the run keeps the files of the app in. The page of the main window saves the workspace
/// it makes, and the files of the user must not be written by a run that is not about them, so the
/// run has a folder of its own, removed when it ends.
#[derive(Clone, Debug)]
pub struct WindowSandbox {
    pub state_dir: PathBuf,
}

impl WindowSandbox {
    pub fn new() -> Self {
        Self {
            state_dir: fresh_dir("noren-smoke-window"),
        }
    }

    /// Deletes the folder this run made (only that one).
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

impl Default for WindowSandbox {
    fn default() -> Self {
        Self::new()
    }
}

/// The commands the page of a window besides the main one must be refused, each with the arguments
/// it would need, so a refusal can only be the access control: the state and the settings, the
/// shells (starting and ending one), the windows, the web views of panes, a file of the machine.
const FORBIDDEN: [(&str, &str); 16] = [
    ("state_save", r#"{ content: "{}" }"#),
    ("state_load", "{}"),
    ("state_quarantine", "{}"),
    ("config_load", "{}"),
    ("config_save", r#"{ content: "" }"#),
    ("session_create", "{ cols: 80, rows: 24 }"),
    ("session_kill", "{ id: 1 }"),
    ("window_open", r#"{ windowId: "intruder", spaceId: "x" }"#),
    ("window_close", r#"{ windowId: "intruder" }"#),
    (
        "window_move_tab",
        r#"{ windowId: "intruder", sessionIds: [] }"#,
    ),
    (
        "browser_open",
        r#"{ paneId: "p", url: "https://example.com/", bounds: { x: 0, y: 0, width: 1, height: 1 } }"#,
    ),
    (
        "browser_navigate",
        r#"{ paneId: "p", url: "https://example.com/" }"#,
    ),
    (
        "browser_set_bounds",
        r#"{ paneId: "p", bounds: { x: 0, y: 0, width: 1, height: 1 } }"#,
    ),
    ("browser_close", r#"{ paneId: "p" }"#),
    ("fonts_list_monospace", "{}"),
    (
        "background_image_read",
        r#"{ path: "C:\\Windows\\win.ini" }"#,
    ),
];

/// The script that asks for each of [`FORBIDDEN`] and reports which ones the access control let
/// through. A command is counted as refused only when the answer says it is *not allowed*: any other
/// failure (a missing argument, say) would not be the access control and counts as let through.
fn acl_probe(window_id: &str) -> String {
    let tries = FORBIDDEN
        .iter()
        .map(|(command, args)| format!(r#"["{command}", {args}]"#))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"(async () => {{
  const internals = window.__TAURI_INTERNALS__;
  const refused = {{}};
  const letThrough = [];
  for (const [command, args] of [{tries}]) {{
    try {{
      await internals.invoke(command, args);
      letThrough.push(command);
    }} catch (error) {{
      const message = String(error);
      if (/not allowed/.test(message)) refused[command] = message.split("\n")[0].slice(0, 90);
      else letThrough.push(command + " (" + message.slice(0, 60) + ")");
    }}
  }}
  await internals.invoke("plugin:event|emit", {{
    event: "{PROBE_EVENT}",
    payload: {{ kind: "acl", windowId: "{window_id}", refused, letThrough }},
  }});
}})();"#
    )
}

/// The script that tries to take the page to a web page, as a link or a script of the page could,
/// and reports where the page is a moment later. The address is one that nobody listens on, so even
/// a navigation that got through would reach no server.
fn navigation_probe(window_id: &str) -> String {
    format!(
        r#"(() => {{
  const internals = window.__TAURI_INTERNALS__;
  setTimeout(() => internals.invoke("plugin:event|emit", {{
    event: "{PROBE_EVENT}",
    payload: {{ kind: "stay", windowId: "{window_id}", href: location.href }},
  }}), 1500);
  location.href = "http://127.0.0.1:1/";
}})();"#
    )
}

/// The script that reports what the page drew for the space it was sent: the tabs of the space and
/// one terminal for each session it was given. The state reaches the page as an event, so the script
/// waits (a few seconds at most) until the page has drawn the terminal, then reports what is there.
fn dom_probe(window_id: &str) -> String {
    format!(
        r#"(() => {{
  const internals = window.__TAURI_INTERNALS__;
  const look = () => ({{
    tabs: document.querySelectorAll('[data-nr-part="window-sidebar"] [data-nr-part="item"]').length,
    newTab: document.querySelectorAll('[data-nr-part="window-new-tab"]').length,
    terminals: document.querySelectorAll('[data-nr-part="window-terminal"]').length,
    xterms: document.querySelectorAll('[data-nr-part="window-terminal"] .xterm').length,
    title: (document.querySelector('[data-nr-part="window-title"]') || {{}}).textContent || "",
  }});
  const report = () => internals.invoke("plugin:event|emit", {{
    event: "{PROBE_EVENT}",
    payload: {{ kind: "dom", windowId: "{window_id}", ...look() }},
  }});
  const started = Date.now();
  const wait = () => {{
    const seen = look();
    if ((seen.tabs > 0 && seen.xterms > 0) || Date.now() - started > 8000) report();
    else setTimeout(wait, 100);
  }};
  wait();
}})();"#
    )
}

/// The script that presses the tab button of the sidebar of the page, as a click of the person would.
fn click_tab_probe() -> &'static str {
    r#"(() => {
  const tab = document.querySelector('[data-nr-part="window-sidebar"] [data-nr-part="item"]');
  if (tab) tab.click();
})();"#
}

/// The script that presses the button for a new tab of the page.
fn click_new_tab_probe() -> &'static str {
    r#"(() => {
  const button = document.querySelector('[data-nr-part="window-new-tab"]');
  if (button) button.click();
})();"#
}

/// What the main window sends a window to draw: the space it shows, with one tab holding one pane
/// whose shell is the session `session` (the same JSON `window-sync.ts` sends, the shape of
/// `Space` in `@noren/model`).
fn state_payload(window_id: &str, session: u64) -> Value {
    json!({
        "windowId": window_id,
        "space": {
            "id": SPACE_ID,
            "name": "Smoke window",
            "icon": "terminal",
            "color": "#6b8afd",
            "modIds": [],
            "defaults": { "env": {} },
            "aiEnabled": true,
            "saveScrollback": true,
            "pinned": [],
            "tree": [{ "kind": "item", "id": TAB_ID }],
            "items": {
                TAB_ID: {
                    "id": TAB_ID,
                    "titleLocked": false,
                    "layout": {
                        "kind": "pane",
                        "pane": {
                            "id": PANE_ID,
                            "type": "terminal",
                            "profileId": "default",
                            "status": "idle",
                            "unread": false,
                            "bell": false,
                            "sessionId": session.to_string()
                        }
                    },
                    "focusedPaneId": PANE_ID,
                    "lastActivityAt": 1
                }
            },
            "activeItemId": TAB_ID
        }
    })
}

/// Fails unless the window `label` exists and is hidden. (Looked up as a window: Tauri does not call
/// one a webview window once the web view of a browser pane is a child of it.)
fn check_label_hidden(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_window(label)
        .ok_or_else(|| format!("the window {label} does not exist"))?;
    if window.is_visible().map_err(|e| e.to_string())? {
        return Err(format!(
            "the window {label} is visible; the smoke run must keep it hidden"
        ));
    }
    Ok(())
}

/// Waits until `label` is no longer a window of the app (the event loop destroys it a moment after
/// the request).
fn wait_until_gone(app: &AppHandle, label: &str, deadline: Instant) -> Result<(), String> {
    while app.get_window(label).is_some() {
        if Instant::now() >= deadline {
            return Err(format!(
                "the window {label} was still there after it was closed"
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// What one page reports for a probe of `kind` from the window `window_id`.
fn probe_report(payload: &Value, window_id: &str, kind: &str) -> Option<Value> {
    (payload.get("windowId").and_then(Value::as_str) == Some(window_id)
        && payload.get("kind").and_then(Value::as_str) == Some(kind))
    .then(|| payload.clone())
}

/// A channel that only counts the bytes it receives: the output of a shell as the main window's
/// page would get it, before the tab moves.
fn counting_channel() -> (Channel<InvokeResponseBody>, Arc<AtomicUsize>) {
    let received = Arc::new(AtomicUsize::new(0));
    let sink = Arc::clone(&received);
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Raw(bytes) = body {
            sink.fetch_add(bytes.len(), Ordering::SeqCst);
        }
        Ok(())
    });
    (channel, received)
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| entry.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The whole run, from the main page being up to the daemon stopped.
fn run(app: &AppHandle, inbox: &mut Inbox, deadline: Instant) -> Result<u64, String> {
    inbox.wait("app-ready", "app-ready", deadline, |_| Some(()))?;
    print_line("SMOKE app-ready received");
    check_window_hidden(app)?;

    // The second window: made hidden, and its page comes up.
    let window = windows::open_window(app, WINDOW_ID, SPACE_ID)?;
    let label = window.label().to_owned();
    let book = app.state::<windows::WindowBook>();
    book.wait_ready(WINDOW_ID, READY_WAIT)?;
    check_label_hidden(app, &label)?;
    check_window_hidden(app)?;
    print_line(&format!(
        "SMOKE second window {label} created for space {SPACE_ID}, hidden, its page is up"
    ));

    // What its page may call: none of what owns or changes the workspace.
    window
        .eval(acl_probe(WINDOW_ID))
        .map_err(|e| format!("could not run the access probe in the second window: {e}"))?;
    let acl = inbox.wait(PROBE_EVENT, "the access report", deadline, |payload| {
        probe_report(payload, WINDOW_ID, "acl")
    })?;
    let through = string_list(&acl, "letThrough");
    if !through.is_empty() {
        return Err(format!(
            "the second window was not refused: {}",
            through.join(", ")
        ));
    }
    let refused = acl
        .get("refused")
        .and_then(Value::as_object)
        .map_or(0, |m| m.len());
    if refused != FORBIDDEN.len() {
        return Err(format!(
            "the second window was refused {refused} of {} commands",
            FORBIDDEN.len()
        ));
    }
    print_line(&format!(
        "SMOKE second window refused {refused} commands of the state, the settings, the shells, the windows and the web views"
    ));

    // And where it may go: not to a web page.
    window
        .eval(navigation_probe(WINDOW_ID))
        .map_err(|e| format!("could not run the navigation probe in the second window: {e}"))?;
    let stayed = inbox.wait(PROBE_EVENT, "the navigation report", deadline, |payload| {
        probe_report(payload, WINDOW_ID, "stay")
    })?;
    let href = stayed.get("href").and_then(Value::as_str).unwrap_or("");
    if href.starts_with("http://127.0.0.1") || !href.contains("localhost") {
        return Err(format!(
            "the second window went to {href} instead of staying on the page of the app"
        ));
    }
    print_line("SMOKE second window stayed on its page (a navigation to a web page was refused)");

    // A tab of the main window: a shell whose output goes to a channel the run counts.
    let state = app.state::<AppState>();
    let (origin, in_origin) = counting_channel();
    let (id, _) = bridge::create_session(app, &state, None, None, None, 120, 30, origin)?;
    print_line(&format!("SMOKE session {id} opened as the tab to move"));
    check_runs_in_daemon(&state, id)?;
    let before = locate_in_daemon(&state, id)?;
    let route = state
        .route(id)
        .ok_or_else(|| format!("session {id} has no route for its output"))?;
    if route.channels() != 1 {
        return Err(format!(
            "session {id} had {} channels before the move, expected 1",
            route.channels()
        ));
    }
    route.record_tail(TAIL_BYTES);
    let write = |marker: &str| {
        state
            .sessions
            .write(SessionId(id), format!("echo {marker}\r").as_bytes())
            .map_err(|e| format!("could not write to session {id}: {e}"))
    };
    write(BEFORE)?;
    wait_for_route_line(&route, BEFORE, "before the move", deadline)?;
    let sessions = state.sessions.session_count();
    let threads = state.sessions.live_threads();

    // The move: the page of the window takes the output over and answers.
    windows::move_sessions(app, WINDOW_ID, &[id], READY_WAIT, TAKE_WAIT)?;
    print_line(&format!("SMOKE session {id} moved to the second window"));

    // The same session: the same route and wiring, moved once, nothing started or ended.
    if !state.route(id).is_some_and(|now| Arc::ptr_eq(&now, &route)) {
        return Err(format!(
            "session {id} was replaced by another during the move"
        ));
    }
    if route.channels() != 2 {
        return Err(format!(
            "the output of session {id} moved {} times, expected once",
            route.channels() - 1
        ));
    }
    if state.sessions.session_count() != sessions || state.sessions.live_threads() != threads {
        return Err(format!(
            "the move changed the sessions: {sessions} sessions and {threads} threads before, {} and {} after",
            state.sessions.session_count(),
            state.sessions.live_threads()
        ));
    }
    if inbox.saw(bridge::SESSION_EXIT_EVENT, |payload| {
        payload.get("id").and_then(Value::as_u64) == Some(id)
    }) {
        return Err(format!("session {id} ended during the move"));
    }
    let origin_bytes = in_origin.load(Ordering::SeqCst);

    // The page asked for what the shell printed before (the daemon keeps it): the new channel got
    // it ahead of everything else, so the terminal of the window is not drawn blank.
    wait_for_route_line(&route, BEFORE, "replayed to the second window", deadline)?;
    print_line(&format!(
        "SMOKE session {id} output printed before the move reached the second window (replay)"
    ));

    // Alive, the same process, and what it prints now reaches the window and no longer the old page.
    write(AFTER)?;
    wait_for_route_line(&route, AFTER, "after the move", deadline)?;
    let after = locate_in_daemon(&state, id)?;
    if after.shell != before.shell {
        return Err(format!(
            "the shell of session {id} was process {} and is {} after the move",
            before.shell, after.shell
        ));
    }
    if in_origin.load(Ordering::SeqCst) != origin_bytes {
        return Err(format!(
            "the old channel of session {id} went on receiving output after the move"
        ));
    }
    print_line(&format!(
        "SMOKE session {id} still alive after the move, same shell pid {}, {} chunks of its output reached the second window and none the old one",
        after.shell,
        route.delivered()
    ));

    // The main window sends the window the space it shows, and the page draws it: the tab and a
    // terminal for the session it took over.
    app.emit(STATE_EVENT, state_payload(WINDOW_ID, id))
        .map_err(|e| format!("could not send the space to the second window: {e}"))?;
    window
        .eval(dom_probe(WINDOW_ID))
        .map_err(|e| format!("could not run the page probe in the second window: {e}"))?;
    let dom = inbox.wait(PROBE_EVENT, "the page report", deadline, |payload| {
        probe_report(payload, WINDOW_ID, "dom")
    })?;
    let tabs = dom.get("tabs").and_then(Value::as_u64).unwrap_or(0);
    let new_tab = dom.get("newTab").and_then(Value::as_u64).unwrap_or(0);
    let terminals = dom.get("terminals").and_then(Value::as_u64).unwrap_or(0);
    let xterms = dom.get("xterms").and_then(Value::as_u64).unwrap_or(0);
    let title = dom.get("title").and_then(Value::as_str).unwrap_or("");
    if tabs != 1 || new_tab != 1 || terminals != 1 || xterms != 1 || title != "Smoke window" {
        return Err(format!(
            "the second window drew {tabs} tabs, {new_tab} new tab buttons, {terminals} terminals and {xterms} xterm views titled {title:?} for the one tab and session it was given"
        ));
    }
    print_line(
        "SMOKE second window drew the space it was sent: its sidebar with its tab and a terminal for the session it was given",
    );

    // A change the window asks for reaches the main window as an event: pressing its tab button.
    window
        .eval(click_tab_probe())
        .map_err(|e| format!("could not press the tab in the second window: {e}"))?;
    inbox.wait(
        ACTION_EVENT,
        "the request of the second window",
        deadline,
        |payload| {
            let action = payload.get("action")?;
            (payload.get("windowId").and_then(Value::as_str) == Some(WINDOW_ID)
                && action.get("type").and_then(Value::as_str) == Some("space/set-active-item")
                && action.get("spaceId").and_then(Value::as_str) == Some(SPACE_ID)
                && action.get("itemId").and_then(Value::as_str) == Some(TAB_ID))
            .then_some(())
        },
    )?;
    print_line("SMOKE second window asked the main window to show its tab (window-action)");

    // And a new tab: the page asks the main window, which starts the shell (the run plays the main
    // window and only listens).
    window
        .eval(click_new_tab_probe())
        .map_err(|e| format!("could not press New tab in the second window: {e}"))?;
    inbox.wait(
        ACTION_EVENT,
        "the new tab request of the second window",
        deadline,
        |payload| {
            let action = payload.get("action")?;
            (payload.get("windowId").and_then(Value::as_str) == Some(WINDOW_ID)
                && action.get("type").and_then(Value::as_str) == Some("item/create")
                && action.get("spaceId").and_then(Value::as_str) == Some(SPACE_ID))
            .then_some(())
        },
    )?;
    print_line("SMOKE second window asked the main window for a new tab (window-action)");

    check_label_hidden(app, &label)?;
    check_window_hidden(app)?;
    print_line("SMOKE second window hidden");

    // A tab with a browser pane in the window: the main window opens its web view as a child of the
    // window (with the bounds the page of the window would send), the page in it is as shut in as
    // in the main window, and the web view goes with the window when the app closes it, so there
    // is no web view of a window that is gone. The window is closed here, by the app, so the next
    // step has a window that is gone and a shell that is not touched.
    smoke_browser::check_browser_pane_in_window(app, WINDOW_ID, || {
        windows::close_window(app, WINDOW_ID)
    })?;

    // A window the app closes is gone; the shell that was in it is not touched.
    wait_until_gone(app, &label, deadline)?;
    if inbox.saw(CLOSED_EVENT, |payload| {
        payload.get("windowId").and_then(Value::as_str) == Some(WINDOW_ID)
    }) {
        return Err("a window the app closed was told as closed by the person".to_owned());
    }
    write("noren-window-closed")?;
    wait_for_route_line(
        &route,
        "noren-window-closed",
        "after the window closed",
        deadline,
    )?;
    if state.route(id).is_none() || state.sessions.session_count() != sessions {
        return Err(format!("closing the window touched session {id}"));
    }
    print_line(&format!(
        "SMOKE second window closed by the app, session {id} untouched"
    ));

    // A window the person closes (the run does what the close button does) is told to the interface.
    let other = windows::open_window(app, SECOND_WINDOW_ID, SPACE_ID)?;
    book.wait_ready(SECOND_WINDOW_ID, READY_WAIT)?;
    check_label_hidden(app, other.label())?;
    other
        .close()
        .map_err(|e| format!("could not close the third window: {e}"))?;
    inbox.wait(CLOSED_EVENT, "window-closed", deadline, |payload| {
        (payload.get("windowId").and_then(Value::as_str) == Some(SECOND_WINDOW_ID)).then_some(())
    })?;
    wait_until_gone(app, &format!("window-{SECOND_WINDOW_ID}"), deadline)?;
    if !book.ids().is_empty() {
        return Err(format!("the book still lists windows: {:?}", book.ids()));
    }
    print_line("SMOKE a window closed by the person was reported as closed");

    check_no_global_shortcut(app)?;
    check_window_hidden(app)?;
    let _ = state.sessions.kill(SessionId(id));
    check_daemon_stopped(&state)?;
    Ok(id)
}

/// Like `smoke::fail`, and removes the folder of the run, last: the page of the main window may
/// still save its state while the sessions end, and that would put the folder back.
fn fail_window(app: &AppHandle, sandbox: &WindowSandbox, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    app.state::<AppState>().sessions.shutdown();
    sandbox.remove();
    process::exit(1);
}

/// Window smoke mode (`noren --smoke-window`): see the top of this file. Then `SMOKE WINDOW OK` and
/// exit 0; anything else within the time of the run ends with code 1. Every window stays hidden.
pub fn arm(app: &tauri::App, sandbox: WindowSandbox) {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Heard>();
    for name in [
        "app-ready",
        bridge::SESSION_EXIT_EVENT,
        CLOSED_EVENT,
        ACTION_EVENT,
        PROBE_EVENT,
    ] {
        let tx = tx.clone();
        app.listen(name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            // The run is over once the receiver is gone; late events are of no interest.
            let _ = tx.send((name.to_owned(), payload));
        });
    }

    let handle = app.handle().clone();
    thread::spawn(move || {
        let mut inbox = Inbox {
            rx,
            kept: Vec::new(),
        };
        match run(&handle, &mut inbox, started + TIMEOUT) {
            Ok(id) => {
                print_line("SMOKE window hidden");
                print_line(&format!("SMOKE WINDOW OK session {id}"));
                handle.exit(0);
            }
            Err(message) => fail_window(&handle, &sandbox, &message),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_flag_is_found_after_the_program_name_only() {
        assert!(has_flag(&args(&["noren", "--smoke-window"])));
        assert!(!has_flag(&args(&["--smoke-window"])));
        assert!(!has_flag(&args(&["noren", "--smoke"])));
        assert!(!has_flag(&args(&["noren", "--smoke-quick"])));
    }

    #[test]
    fn the_windows_of_the_run_have_names_a_window_can_have() {
        for id in [WINDOW_ID, SECOND_WINDOW_ID] {
            assert!(windows::window_label(id).is_ok(), "{id}");
        }
        assert_ne!(WINDOW_ID, SECOND_WINDOW_ID);
    }

    #[test]
    fn the_probes_name_the_window_and_the_event_the_run_listens_to() {
        for script in [acl_probe("w1"), navigation_probe("w1"), dom_probe("w1")] {
            assert!(script.contains(r#"windowId: "w1""#), "{script}");
            assert!(script.contains(PROBE_EVENT), "{script}");
        }
        let acl = acl_probe("w1");
        for (command, _) in FORBIDDEN {
            assert!(acl.contains(command), "{command}");
        }
        assert!(
            navigation_probe("w1").contains("127.0.0.1:1"),
            "the address nobody listens on"
        );
    }

    #[test]
    fn the_space_the_run_sends_is_one_tab_with_one_pane_holding_the_session() {
        let payload = state_payload("w1", 7);
        assert_eq!(payload["windowId"], "w1");
        let space = &payload["space"];
        assert_eq!(space["id"], SPACE_ID);
        // The tree, the items and the active tab name the same tab, as the invariants of the model ask.
        assert_eq!(space["tree"][0]["id"], TAB_ID);
        assert_eq!(space["activeItemId"], TAB_ID);
        let item = &space["items"][TAB_ID];
        assert_eq!(item["id"], TAB_ID);
        assert_eq!(item["focusedPaneId"], PANE_ID);
        let pane = &item["layout"]["pane"];
        assert_eq!(pane["id"], PANE_ID);
        assert_eq!(pane["type"], "terminal");
        // The session is written the way the model keeps it: as text.
        assert_eq!(pane["sessionId"], "7");
    }

    #[test]
    fn the_click_probes_press_the_buttons_the_sidebar_of_the_page_draws() {
        assert!(click_tab_probe().contains(r#"[data-nr-part="window-sidebar"]"#));
        assert!(click_tab_probe().contains(r#"[data-nr-part="item"]"#));
        assert!(click_tab_probe().contains(".click()"));
        assert!(click_new_tab_probe().contains(r#"[data-nr-part="window-new-tab"]"#));
        assert!(click_new_tab_probe().contains(".click()"));
    }

    #[test]
    fn nothing_the_page_may_call_is_in_the_list_of_what_it_must_be_refused() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/window.json"))
            .expect("the capability file is JSON");
        let granted: Vec<&str> = capability["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for (command, _) in FORBIDDEN {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(!granted.contains(&permission.as_str()), "{permission}");
        }
    }

    #[test]
    fn a_report_counts_for_its_window_and_its_kind_only() {
        let report = serde_json::json!({ "kind": "acl", "windowId": "w1", "refused": {} });
        assert!(probe_report(&report, "w1", "acl").is_some());
        assert!(probe_report(&report, "w2", "acl").is_none());
        assert!(probe_report(&report, "w1", "dom").is_none());
        assert!(probe_report(&Value::Null, "w1", "acl").is_none());
    }

    #[test]
    fn a_list_of_names_is_read_and_anything_else_is_empty() {
        let report = serde_json::json!({ "letThrough": ["a", "b"], "n": 3, "mixed": ["a", 1] });
        assert_eq!(string_list(&report, "letThrough"), ["a", "b"]);
        assert_eq!(string_list(&report, "mixed"), ["a"]);
        assert!(string_list(&report, "n").is_empty());
        assert!(string_list(&report, "none").is_empty());
    }

    #[test]
    fn the_folder_of_the_run_is_its_own_and_is_removed() {
        let first = WindowSandbox::new();
        let second = WindowSandbox::new();
        assert_ne!(first.state_dir, second.state_dir);
        std::fs::create_dir_all(&first.state_dir).expect("make the folder");
        first.remove();
        assert!(!first.state_dir.exists());
        assert!(crate::smoke::fresh_dir("x").starts_with(std::env::temp_dir()));
    }
}

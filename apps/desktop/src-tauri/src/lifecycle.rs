//! Closing the main window gives the page a moment to save what it has in memory (the scrollback
//! snapshots of the panes, the pending state), and then closes it.
//!
//! The page cannot be trusted to finish its saves from `beforeunload`: when the window is torn down
//! a call to the Rust side may never leave. So, when the page has said it listens (`app_close_listening`),
//! a request to close is held: the window stays, the page is told (`close-requested`), saves, and says
//! it is done (`app_close_ready`), which destroys the window. A page that never answers does not hold
//! the window: after [`CLOSE_WAIT`] it is destroyed anyway. A page that has not said it listens (the
//! interface is still loading, or it failed to start), or a second request while one is held (the user
//! is impatient), closes at once, as every close did before this existed.
//!
//! One case comes before all that (NOR-F14-02c): with the shells kept in the daemon and the tray icon
//! up, a request to close hides the window and the app stays (`tray::close_outcome`).

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager, Runtime, State, Window, WindowEvent};

use crate::bridge::AppState;
use crate::tray::{self, CloseFacts, CloseOutcome};

/// The event the page hears when the window is asked to close and it should save now.
pub const CLOSE_REQUESTED_EVENT: &str = "close-requested";

/// The longest the window stays open for the page to save. The page itself gives up on a slow save
/// before this (see `close-handler.ts`), so this only covers a page that is gone.
pub const CLOSE_WAIT: Duration = Duration::from_secs(4);

/// What to do with a request to close the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Close it now.
    Close,
    /// Keep it open, tell the page and wait for its answer (or [`CLOSE_WAIT`]).
    Wait,
}

#[derive(Default)]
struct GateState {
    listening: bool,
    waiting: bool,
}

/// Remembers whether the page listens for the close and whether a close is being held.
#[derive(Default)]
pub struct CloseGate {
    state: Mutex<GateState>,
}

impl CloseGate {
    /// The page listens for [`CLOSE_REQUESTED_EVENT`] and will answer with `app_close_ready`.
    pub fn page_is_listening(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .listening = true;
    }

    /// The user (or the system) asked to close the window.
    pub fn request(&self) -> CloseAction {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.listening || state.waiting {
            return CloseAction::Close;
        }
        state.waiting = true;
        CloseAction::Wait
    }
}

/// The label of the window of the workspace, the one that closing ends the app with.
pub const MAIN_LABEL: &str = "main";

/// Handles the window events of the app: a request to close the main window is held when the page
/// asked for it, and once the main window is gone the quick window goes with it (it is hidden, so
/// it would keep the app running with nothing to see; with no window left the app ends as it always
/// did). The other windows are left to the default.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_LABEL {
        return;
    }
    if let WindowEvent::Destroyed = event {
        if let Some(quick) = window
            .app_handle()
            .get_webview_window(crate::quick::QUICK_LABEL)
        {
            let _ = quick.destroy();
        }
        return;
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    // The shells are kept in the daemon and the tray icon is there to come back through: closing
    // only hides the window and the app stays (NOR-F14-02c). The page is not asked to save: nothing
    // is going away, and the real quit from the tray closes the window the normal way.
    if tray::close_outcome(close_facts(window)) == CloseOutcome::Hide {
        api.prevent_close();
        let _ = window.hide();
        return;
    }
    let Some(gate) = window.try_state::<CloseGate>() else {
        return;
    };
    if gate.request() == CloseAction::Close {
        return;
    }
    api.prevent_close();
    // A failed emit means the page is gone; the wait below ends the window.
    let _ = window.emit(CLOSE_REQUESTED_EVENT, ());
    let held = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_WAIT);
        // The window may be gone already (the page answered): then there is nothing to destroy.
        let _ = held.destroy();
    });
}

/// What `tray::close_outcome` needs to know about this run. Nothing here waits: the handler runs on
/// the thread of the event loop, so a daemon still being looked for counts as not there (the window
/// closes as it always did).
fn close_facts<R: Runtime>(window: &Window<R>) -> CloseFacts {
    let Some(state) = window.try_state::<AppState>() else {
        return CloseFacts::default();
    };
    CloseFacts {
        keep_sessions: state.keeps_sessions(),
        sessions_in_daemon: state.sessions.in_daemon_now().unwrap_or(false),
        tray_present: window.app_handle().tray_by_id(tray::TRAY_ID).is_some(),
        quitting: state.is_quitting(),
    }
}

/// The page says it listens for the close, so a request to close waits for it.
#[tauri::command]
pub fn app_close_listening(gate: State<'_, CloseGate>) {
    gate.page_is_listening();
}

/// The page has saved: the window closes now.
#[tauri::command]
pub async fn app_close_ready(window: Window) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_that_has_not_said_it_listens_does_not_hold_the_window() {
        let gate = CloseGate::default();
        assert_eq!(gate.request(), CloseAction::Close);
        assert_eq!(gate.request(), CloseAction::Close);
    }

    #[test]
    fn a_page_that_listens_holds_the_first_request() {
        let gate = CloseGate::default();
        gate.page_is_listening();
        assert_eq!(gate.request(), CloseAction::Wait);
    }

    #[test]
    fn a_second_request_while_one_is_held_closes_at_once() {
        let gate = CloseGate::default();
        gate.page_is_listening();
        assert_eq!(gate.request(), CloseAction::Wait);
        assert_eq!(gate.request(), CloseAction::Close);
        assert_eq!(gate.request(), CloseAction::Close);
    }

    /// Whether a mock app can have a tray icon here. On Linux the tray icon needs GTK, which the
    /// mock runtime does not start (see `tray::tests`): there the window has no tray in these tests.
    const TRAY_IN_TESTS: bool = cfg!(not(target_os = "linux"));

    /// Puts the tray icon on a mock app that has an icon, where that is possible.
    fn put_a_tray_icon(app: &tauri::App<tauri::test::MockRuntime>) {
        if TRAY_IN_TESTS {
            tray::install(app.handle()).expect("the tray icon");
        }
    }

    /// A window of a mock app that has an icon, a tray icon (where the system allows it in a test)
    /// and sessions in a daemon of the test.
    fn an_app_with_a_tray_and_a_daemon(
        keep: bool,
    ) -> (
        tauri::App<tauri::test::MockRuntime>,
        noren_core::daemon::Daemon,
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};

        use noren_core::daemon::{Daemon, Endpoint, ServerConfig};

        use crate::daemon_link::{DaemonSettings, Host};

        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let name = format!(
            "lifecycle-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        );
        let daemon = Daemon::start(
            Endpoint::named(&name).expect("endpoint"),
            ServerConfig::default(),
        )
        .expect("start the daemon");
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.set_default_window_icon(Some(tauri::image::Image::new_owned(vec![255; 4], 1, 1)));
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("a mock app");
        let state = AppState::with_detected_in(
            noren_core::ProfileSet {
                profiles: Vec::new(),
                default_id: None,
            },
            Host::Daemon(DaemonSettings {
                endpoint: name,
                // Nothing at the path: the run must find the daemon, not start one.
                program: Some(std::env::temp_dir().join("noren-no-such-norend-77d1e0")),
                ..DaemonSettings::normal()
            }),
        );
        state.set_keep_sessions(keep);
        // Wait for the search, as the first session would.
        assert!(
            state.sessions.in_daemon(),
            "the daemon of the test is found"
        );
        app.manage(state);
        put_a_tray_icon(&app);
        tauri::WebviewWindowBuilder::new(&app, MAIN_LABEL, tauri::WebviewUrl::default())
            .build()
            .expect("the main window");
        (app, daemon)
    }

    fn facts_of(app: &tauri::App<tauri::test::MockRuntime>) -> CloseFacts {
        let window = app
            .get_webview_window(MAIN_LABEL)
            .expect("the main window")
            .as_ref()
            .window();
        close_facts(&window)
    }

    #[test]
    fn the_facts_of_a_window_come_from_the_app_and_only_the_full_set_hides_it() {
        let (app, _daemon) = an_app_with_a_tray_and_a_daemon(true);
        // Without a tray icon (Linux, in a test) the window has no way back, so it closes.
        let full = if TRAY_IN_TESTS {
            CloseOutcome::Hide
        } else {
            CloseOutcome::Exit
        };
        let facts = facts_of(&app);
        assert_eq!(
            facts,
            CloseFacts {
                keep_sessions: true,
                sessions_in_daemon: true,
                tray_present: TRAY_IN_TESTS,
                quitting: false
            }
        );
        assert_eq!(tray::close_outcome(facts), full);

        // The setting turned off: the very same window now closes.
        app.state::<AppState>().set_keep_sessions(false);
        assert_eq!(tray::close_outcome(facts_of(&app)), CloseOutcome::Exit);
        app.state::<AppState>().set_keep_sessions(true);
        assert_eq!(tray::close_outcome(facts_of(&app)), full);

        // The tray's quit: it closes, whatever the setting.
        app.state::<AppState>().begin_quit();
        assert!(facts_of(&app).quitting);
        assert_eq!(tray::close_outcome(facts_of(&app)), CloseOutcome::Exit);
    }

    #[test]
    fn a_window_whose_app_never_heard_from_the_interface_closes_as_before() {
        // The setting has not been handed over (the default of the Rust side is off).
        let (app, _daemon) = an_app_with_a_tray_and_a_daemon(false);
        assert_eq!(tray::close_outcome(facts_of(&app)), CloseOutcome::Exit);
    }

    #[test]
    fn with_the_sessions_in_the_app_or_no_app_state_the_window_closes() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.set_default_window_icon(Some(tauri::image::Image::new_owned(vec![255; 4], 1, 1)));
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("a mock app");
        put_a_tray_icon(&app);
        tauri::WebviewWindowBuilder::new(&app, MAIN_LABEL, tauri::WebviewUrl::default())
            .build()
            .expect("the main window");
        // No state at all: nothing to read, nothing kept (not even the tray counts).
        assert_eq!(facts_of(&app), CloseFacts::default());
        assert_eq!(tray::close_outcome(facts_of(&app)), CloseOutcome::Exit);

        // The sessions in the app's own process, the setting on: still nothing to stay for.
        let state = AppState::with_detected(noren_core::ProfileSet {
            profiles: Vec::new(),
            default_id: None,
        });
        state.set_keep_sessions(true);
        app.manage(state);
        let facts = facts_of(&app);
        assert!(facts.keep_sessions && facts.tray_present == TRAY_IN_TESTS);
        assert!(!facts.sessions_in_daemon);
        assert_eq!(tray::close_outcome(facts), CloseOutcome::Exit);
    }

    #[test]
    fn the_event_and_the_wait_are_what_the_page_expects() {
        assert_eq!(CLOSE_REQUESTED_EVENT, "close-requested");
        // The page gives up on a slow save before the window does.
        assert!(CLOSE_WAIT > Duration::from_secs(2));
    }
}

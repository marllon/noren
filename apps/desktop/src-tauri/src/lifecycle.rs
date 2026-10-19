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

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager, State, Window, WindowEvent};

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

/// Handles the window events of the app: a request to close the main window is held when the page
/// asked for it. Anything else is left to the default.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
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

    #[test]
    fn the_event_and_the_wait_are_what_the_page_expects() {
        assert_eq!(CLOSE_REQUESTED_EVENT, "close-requested");
        // The page gives up on a slow save before the window does.
        assert!(CLOSE_WAIT > Duration::from_secs(2));
    }
}

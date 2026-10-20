//! The tray icon of the app (NOR-F14-02c).
//!
//! With the shells kept (`sessions.keepOnClose`) and the sessions in the session daemon, closing the
//! window must not end the app: the shells go on in `norend`, and the app goes on in the tray with
//! its window hidden. The icon has two entries:
//!
//! - **Open Noren** shows the window again and focuses it (so does a click on the icon, and a second
//!   launch of the program, see `deeplink::on_second_instance`).
//! - **Quit Noren and end all sessions** is the real quit: the sessions end, the daemon is told to
//!   stop and the app goes away once the endpoint is free (`AppState::end_sessions_on_exit` after
//!   `AppState::begin_quit`). The window closes the normal way for that, so the page still saves
//!   what it keeps in memory (the scrollback snapshots) first.
//!
//! What closing the window does is decided by [`close_outcome`], a function of four facts and
//! nothing else, so the decision has a test of its own. The icon is made only by a normal run (never
//! in the `--smoke*` modes, which have no one to click it); a system that cannot show it (a Linux
//! desktop with no notification area library) leaves the app without one, and then closing the
//! window quits as it did before, since hiding the window would leave no way back to it.

use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::AppState;
use crate::deeplink::focus_main_window;
use crate::lifecycle::MAIN_LABEL;

/// The id of the one tray icon of the app.
pub const TRAY_ID: &str = "noren-tray";
/// The ids of the entries of its menu.
pub const OPEN_ID: &str = "open";
pub const QUIT_ID: &str = "quit";
/// What the entries say, and the tooltip of the icon.
pub const OPEN_LABEL: &str = "Open Noren";
pub const QUIT_LABEL: &str = "Quit Noren and end all sessions";
pub const TOOLTIP: &str = "Noren";

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseOutcome {
    /// The window is hidden and the app stays in the tray.
    Hide,
    /// The window closes and the app goes away (the shells stay in the daemon, or end, as the
    /// settings say; see `AppState::end_sessions_on_exit`).
    Exit,
}

/// The facts that decide [`close_outcome`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CloseFacts {
    /// `sessions.keepOnClose`, as the interface last handed it over.
    pub keep_sessions: bool,
    /// The sessions live in the daemon. `false` also while the search for it is still going on.
    pub sessions_in_daemon: bool,
    /// The tray icon exists: without it a hidden window could not be brought back.
    pub tray_present: bool,
    /// "Quit" of the tray icon was chosen: this close is the real one.
    pub quitting: bool,
}

/// Hide the window only when there is something to keep (shells that outlive the app) and a way
/// back (the tray icon), and the person has not asked to quit. Every other case closes the window as
/// it always did: the setting off, the sessions in the app's own process, no tray icon, quitting.
pub fn close_outcome(facts: CloseFacts) -> CloseOutcome {
    if facts.keep_sessions && facts.sessions_in_daemon && facts.tray_present && !facts.quitting {
        CloseOutcome::Hide
    } else {
        CloseOutcome::Exit
    }
}

/// Makes the icon and its menu. The error is the reason there is no icon.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "the app has no icon to show".to_owned())?;
    let menu = build_menu(app).map_err(|e| e.to_string())?;
    // A system with no notification-area library can make the builder panic (Linux); that is a
    // missing icon, not a reason to stop the app.
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(icon)
            .tooltip(TOOLTIP)
            .menu(&menu)
            // The menu is for the right button; the left one opens the window.
            .show_menu_on_left_click(false)
            .on_menu_event(on_menu_event)
            .on_tray_icon_event(|tray, event| on_tray_icon_event(tray.app_handle(), &event))
            .build(app)
    }));
    match built {
        Ok(Ok(_tray)) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("the system could not show a tray icon".to_owned()),
    }
}

/// The menu of the icon.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, OPEN_ID, OPEN_LABEL, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, QUIT_LABEL, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN_ID => focus_main_window(app),
        QUIT_ID => quit_for_good(app),
        _ => {}
    }
}

/// A click of the left button brings the window back, the way the icon of most programs does.
fn on_tray_icon_event<R: Runtime>(app: &AppHandle<R>, event: &TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        focus_main_window(app);
    }
}

/// The real quit. The app is told it is quitting (so the close of the window is not turned into
/// hiding it, and the way out ends the sessions and the daemon) and the main window is asked to
/// close like any other time, which lets the page save first. With no window to ask, the app exits
/// at once.
pub fn quit_for_good<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<AppState>() {
        state.begin_quit();
    }
    if !ask_main_window_to_close(app) {
        app.exit(0);
    }
}

/// Asks the main window to close the normal way (a close request, which the page answers by
/// saving). `false` when there is no such window or it could not be asked.
fn ask_main_window_to_close<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(MAIN_LABEL)
        .is_some_and(|window| window.close().is_ok())
}

#[cfg(test)]
mod tests {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::*;

    fn facts(keep: bool, daemon: bool, tray: bool, quitting: bool) -> CloseFacts {
        CloseFacts {
            keep_sessions: keep,
            sessions_in_daemon: daemon,
            tray_present: tray,
            quitting,
        }
    }

    #[test]
    fn closing_hides_the_window_when_the_shells_are_kept_in_the_daemon() {
        assert_eq!(
            close_outcome(facts(true, true, true, false)),
            CloseOutcome::Hide
        );
    }

    #[test]
    fn closing_quits_when_the_setting_is_off() {
        assert_eq!(
            close_outcome(facts(false, true, true, false)),
            CloseOutcome::Exit
        );
    }

    #[test]
    fn closing_quits_when_the_sessions_live_in_the_app() {
        // No norend: nothing would outlive the app, so there is nothing to stay for.
        assert_eq!(
            close_outcome(facts(true, false, true, false)),
            CloseOutcome::Exit
        );
    }

    #[test]
    fn closing_quits_when_there_is_no_tray_icon_to_come_back_through() {
        assert_eq!(
            close_outcome(facts(true, true, false, false)),
            CloseOutcome::Exit
        );
    }

    #[test]
    fn closing_for_the_real_quit_is_never_turned_into_hiding() {
        assert_eq!(
            close_outcome(facts(true, true, true, true)),
            CloseOutcome::Exit
        );
    }

    #[test]
    fn only_one_of_the_sixteen_combinations_hides_the_window() {
        let mut hides = Vec::new();
        for bits in 0u8..16 {
            let f = facts(bits & 1 != 0, bits & 2 != 0, bits & 4 != 0, bits & 8 != 0);
            if close_outcome(f) == CloseOutcome::Hide {
                hides.push(f);
            }
        }
        assert_eq!(hides, vec![facts(true, true, true, false)]);
    }

    #[test]
    fn the_unknown_start_of_a_run_closes_as_before() {
        // Nothing has been handed over yet and the daemon is not known: the default is to quit.
        assert_eq!(close_outcome(CloseFacts::default()), CloseOutcome::Exit);
    }

    #[test]
    fn the_menu_offers_open_and_quit_in_that_order() {
        let app = tauri::test::mock_app();
        let menu = build_menu(app.handle()).expect("the menu");
        let items = menu.items().expect("its items");
        let ids: Vec<String> = items.iter().map(|item| item.id().0.clone()).collect();
        assert_eq!(ids, vec![OPEN_ID, QUIT_ID]);
        let texts: Vec<String> = items
            .iter()
            .map(|item| item.as_menuitem().expect("a plain entry").text().unwrap())
            .collect();
        assert_eq!(texts, vec![OPEN_LABEL, QUIT_LABEL]);
    }

    fn an_app_state() -> AppState {
        AppState::with_detected(noren_core::ProfileSet {
            profiles: Vec::new(),
            default_id: None,
        })
    }

    #[test]
    fn quit_says_so_to_the_app_and_asks_the_main_window_to_close() {
        let app = tauri::test::mock_app();
        app.manage(an_app_state());
        WebviewWindowBuilder::new(&app, MAIN_LABEL, WebviewUrl::default())
            .build()
            .expect("a window");
        assert!(!app.state::<AppState>().is_quitting());

        // The window is there to be asked, so the app is not told to exit at once: it goes away
        // when the window has closed, after the page saved.
        assert!(ask_main_window_to_close(app.handle()));
        on_menu_event(app.handle(), MenuEvent { id: QUIT_ID.into() });

        assert!(app.state::<AppState>().is_quitting());
    }

    #[test]
    fn with_no_window_to_ask_there_is_nobody_to_close() {
        let app = tauri::test::mock_app();
        assert!(!ask_main_window_to_close(app.handle()));
        // Another window is not the main one.
        WebviewWindowBuilder::new(&app, "other", WebviewUrl::default())
            .build()
            .expect("a window");
        assert!(!ask_main_window_to_close(app.handle()));
    }

    // On Linux the tray icon is a GTK widget and the mock runtime does not start GTK, so building
    // one there panics inside the builder (the next test is about exactly that).
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn the_icon_is_registered_under_the_id_the_window_event_looks_for() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.set_default_window_icon(Some(tauri::image::Image::new_owned(vec![255; 4], 1, 1)));
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("a mock app");
        assert!(
            app.tray_by_id(TRAY_ID).is_none(),
            "no icon before it is made"
        );

        install(app.handle()).expect("the icon");

        assert!(
            app.tray_by_id(TRAY_ID).is_some(),
            "lifecycle.rs asks for exactly this id to know there is a way back"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_system_that_cannot_show_the_icon_gets_a_reason_and_not_a_crash() {
        // GTK is not started in a test, which is what a Linux session with no way to show a tray
        // icon looks like to the builder: it panics. `install` must turn that into a reason.
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.set_default_window_icon(Some(tauri::image::Image::new_owned(vec![255; 4], 1, 1)));
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("a mock app");
        let reason = install(app.handle()).expect_err("no way to show it");
        assert!(reason.contains("could not show a tray icon"), "{reason}");
        assert!(app.tray_by_id(TRAY_ID).is_none());
    }

    #[test]
    fn an_app_with_no_icon_gets_no_tray_icon_and_says_why() {
        let app = tauri::test::mock_app();
        let reason = install(app.handle()).expect_err("nothing to show");
        assert!(reason.contains("no icon"), "{reason}");
        assert!(app.tray_by_id(TRAY_ID).is_none());
    }

    #[test]
    fn the_entries_nobody_knows_do_nothing() {
        let app = tauri::test::mock_app();
        app.manage(an_app_state());
        on_menu_event(
            app.handle(),
            MenuEvent {
                id: "something-else".into(),
            },
        );
        assert!(!app.state::<AppState>().is_quitting());
    }
}

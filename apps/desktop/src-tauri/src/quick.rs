//! The quick terminal window: a second, frameless window at the top of the screen that carries one
//! terminal with the default profile. It is created hidden and stays hidden until the global
//! shortcut (`shortcut.rs`) or the palette toggles it; this module makes it, places it and holds the
//! steps of showing and hiding it.
//!
//! The window loads the same page as the main one, in a minimal form (`QuickApp.tsx`): the page picks
//! the form from the label of its window. The shell of the quick window is an ordinary session of the
//! app; "promoting" it to a tab of the main window moves its output there (`session_attach`) and
//! keeps the process.

use tauri::{
    AppHandle, Emitter, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// The label of the quick window; the page tells its form from it (`quick.ts`).
pub const QUICK_LABEL: &str = "quick";

/// Rust → quick page: open a shell now, unless one is open.
pub const OPEN_EVENT: &str = "quick-open";
/// Quick page → everyone: it listens for [`OPEN_EVENT`] and [`PROMOTED_EVENT`].
pub const READY_EVENT: &str = "quick-ready";
/// Quick page → everyone: the shell it opened, `{ "id": 3 }`.
pub const SESSION_EVENT: &str = "quick-session";
/// Anyone → main page: take the session `{ "id": 3 }` over into a tab of the active space.
pub const PROMOTE_EVENT: &str = "quick-promote";
/// Main page → everyone: what became of a promotion, `{ "id": 3, "ok": true, "itemId": "..." }`.
pub const PROMOTED_EVENT: &str = "quick-promoted";

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Share of the width and of the height of the screen the window takes, and the limits in logical
/// pixels (a window is not worth having on a small screen, nor stretched across a huge one).
const WIDTH_SHARE: f64 = 0.6;
const HEIGHT_SHARE: f64 = 0.45;
const MIN_WIDTH: f64 = 640.0;
const MAX_WIDTH: f64 = 1600.0;
const MIN_HEIGHT: f64 = 320.0;
const MAX_HEIGHT: f64 = 720.0;

/// Where the quick window goes on a screen whose usable area (the screen without the taskbar) is
/// `area`, at `scale` physical pixels per logical one: centered, against the top edge, never larger
/// than the area.
pub fn top_bounds(area: Bounds, scale: f64) -> Bounds {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let logical_width = f64::from(area.width) / scale;
    let logical_height = f64::from(area.height) / scale;
    let width = (logical_width * WIDTH_SHARE)
        .clamp(MIN_WIDTH, MAX_WIDTH)
        .min(logical_width);
    let height = (logical_height * HEIGHT_SHARE)
        .clamp(MIN_HEIGHT, MAX_HEIGHT)
        .min(logical_height);
    // Rounded to whole pixels; the casts cannot overflow, the values are at most the area's.
    let width = ((width * scale).round() as u32).min(area.width);
    let height = ((height * scale).round() as u32).min(area.height);
    Bounds {
        x: area.x + i32::try_from((area.width - width) / 2).unwrap_or(0),
        y: area.y,
        width,
        height,
    }
}

/// Puts the window at the top of the main screen, centered (see [`top_bounds`]). A machine that
/// reports no screen (nothing is attached) leaves the window where it is.
pub fn place_on_top<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let bounds = top_bounds(
        Bounds {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        monitor.scale_factor(),
    );
    window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
    window.set_position(PhysicalPosition::new(bounds.x, bounds.y))?;
    Ok(())
}

/// The quick window, made if it does not exist yet: frameless, always on top, out of the taskbar,
/// hidden and not focused, placed at the top of the screen. It starts loading the page at once, so
/// it is ready when something shows it. Creating it twice gives the same window.
pub fn create_hidden<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(QUICK_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(app, QUICK_LABEL, WebviewUrl::App("index.html".into()))
        .title("Noren quick terminal")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .build()?;
    place_on_top(&window)?;
    Ok(window)
}

/// What the toggle does to the quick window, one step at a time, so the order is a plain function
/// that a test can run against a recording stand-in (no test or smoke run may show the real window).
pub trait QuickWindow {
    fn is_visible(&self) -> Result<bool, String>;
    fn hide(&self) -> Result<(), String>;
    /// Puts the window at the top of the screen (see [`place_on_top`]).
    fn place(&self) -> Result<(), String>;
    /// Tells the page to open a shell if it has none (`quick-open`).
    fn open_shell(&self) -> Result<(), String>;
    fn show(&self) -> Result<(), String>;
    /// Gives the window the keyboard.
    fn focus(&self) -> Result<(), String>;
}

/// Shows the window if it is hidden (place it, ask for the shell, show it, focus it) and hides it
/// if it is showing. Returns whether it is visible now. A step that fails stops the rest; the
/// window is never left hidden when showing it failed halfway only because of the focus (the error
/// is returned all the same).
pub fn toggle<W: QuickWindow>(window: &W) -> Result<bool, String> {
    if window.is_visible()? {
        window.hide()?;
        return Ok(false);
    }
    window.place()?;
    window.open_shell()?;
    window.show()?;
    window.focus()?;
    Ok(true)
}

/// The real window and the app it belongs to, as a [`QuickWindow`].
struct Live<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    window: &'a WebviewWindow<R>,
}

impl<R: Runtime> QuickWindow for Live<'_, R> {
    fn is_visible(&self) -> Result<bool, String> {
        self.window.is_visible().map_err(|e| e.to_string())
    }
    fn hide(&self) -> Result<(), String> {
        self.window.hide().map_err(|e| e.to_string())
    }
    fn place(&self) -> Result<(), String> {
        place_on_top(self.window).map_err(|e| e.to_string())
    }
    fn open_shell(&self) -> Result<(), String> {
        self.app.emit(OPEN_EVENT, ()).map_err(|e| e.to_string())
    }
    fn show(&self) -> Result<(), String> {
        self.window.show().map_err(|e| e.to_string())
    }
    fn focus(&self) -> Result<(), String> {
        self.window.set_focus().map_err(|e| e.to_string())
    }
}

/// [`toggle`] on the quick window of the app, which is made first if a failure at start left it
/// out. Returns whether the window is visible afterwards.
pub fn toggle_window<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let window = create_hidden(app).map_err(|e| e.to_string())?;
    toggle(&Live {
        app,
        window: &window,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// A window that is only a list of what was done to it.
    #[derive(Default)]
    struct Recording {
        visible: Cell<bool>,
        calls: RefCell<Vec<&'static str>>,
        /// The step that fails, if any.
        failing: Option<&'static str>,
    }

    impl Recording {
        fn step(&self, name: &'static str) -> Result<(), String> {
            self.calls.borrow_mut().push(name);
            if self.failing == Some(name) {
                Err(format!("{name} failed"))
            } else {
                Ok(())
            }
        }
    }

    impl QuickWindow for Recording {
        fn is_visible(&self) -> Result<bool, String> {
            Ok(self.visible.get())
        }
        fn hide(&self) -> Result<(), String> {
            self.step("hide")?;
            self.visible.set(false);
            Ok(())
        }
        fn place(&self) -> Result<(), String> {
            self.step("place")
        }
        fn open_shell(&self) -> Result<(), String> {
            self.step("open")
        }
        fn show(&self) -> Result<(), String> {
            self.step("show")?;
            self.visible.set(true);
            Ok(())
        }
        fn focus(&self) -> Result<(), String> {
            self.step("focus")
        }
    }

    #[test]
    fn a_hidden_window_is_placed_opened_shown_and_focused_in_that_order() {
        let window = Recording::default();
        assert_eq!(toggle(&window), Ok(true));
        assert_eq!(
            window.calls.borrow().as_slice(),
            ["place", "open", "show", "focus"]
        );
        assert!(window.visible.get());
    }

    #[test]
    fn a_visible_window_is_hidden_and_nothing_else_is_done() {
        let window = Recording::default();
        window.visible.set(true);
        assert_eq!(toggle(&window), Ok(false));
        assert_eq!(window.calls.borrow().as_slice(), ["hide"]);
        assert!(!window.visible.get());
    }

    #[test]
    fn the_shortcut_pressed_twice_comes_back_to_where_it_started() {
        let window = Recording::default();
        assert_eq!(toggle(&window), Ok(true));
        assert_eq!(toggle(&window), Ok(false));
        assert_eq!(toggle(&window), Ok(true));
        assert_eq!(
            window.calls.borrow().as_slice(),
            [
                "place", "open", "show", "focus", "hide", "place", "open", "show", "focus"
            ]
        );
    }

    #[test]
    fn a_step_that_fails_stops_the_ones_after_it() {
        let window = Recording {
            failing: Some("place"),
            ..Recording::default()
        };
        assert_eq!(toggle(&window), Err("place failed".to_owned()));
        // Never shown at a wrong place.
        assert_eq!(window.calls.borrow().as_slice(), ["place"]);
        assert!(!window.visible.get());

        let window = Recording {
            failing: Some("focus"),
            ..Recording::default()
        };
        assert_eq!(toggle(&window), Err("focus failed".to_owned()));
        assert!(window.visible.get(), "shown, only the focus was refused");

        let window = Recording {
            failing: Some("hide"),
            ..Recording::default()
        };
        window.visible.set(true);
        assert_eq!(toggle(&window), Err("hide failed".to_owned()));
        assert!(window.visible.get());
    }

    const fn area(x: i32, y: i32, width: u32, height: u32) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn on_a_full_hd_screen_the_window_is_centered_against_the_top_edge() {
        let bounds = top_bounds(area(0, 0, 1920, 1080), 1.0);
        assert_eq!(bounds.width, 1152, "60% of the width");
        assert_eq!(bounds.height, 486, "45% of the height");
        assert_eq!(bounds.x, (1920 - 1152) / 2);
        assert_eq!(bounds.y, 0);
    }

    #[test]
    fn the_size_follows_the_logical_pixels_on_a_scaled_screen() {
        // 3840x2160 at 200% is 1920x1080 logical: the same window, twice the pixels.
        let bounds = top_bounds(area(0, 0, 3840, 2160), 2.0);
        assert_eq!((bounds.width, bounds.height), (2304, 972));
        assert_eq!((bounds.x, bounds.y), ((3840 - 2304) / 2, 0));
    }

    #[test]
    fn a_huge_screen_does_not_stretch_it_past_the_limits() {
        let bounds = top_bounds(area(0, 0, 5120, 2880), 1.0);
        assert_eq!((bounds.width, bounds.height), (1600, 720));
        assert_eq!(bounds.x, (5120 - 1600) / 2);
    }

    #[test]
    fn a_small_screen_gets_the_minimum_but_never_more_than_the_area() {
        let bounds = top_bounds(area(0, 0, 1024, 600), 1.0);
        assert_eq!((bounds.width, bounds.height), (640, 320));
        let tiny = top_bounds(area(0, 0, 500, 300), 1.0);
        assert_eq!((tiny.width, tiny.height), (500, 300));
        assert_eq!((tiny.x, tiny.y), (0, 0));
    }

    #[test]
    fn it_sits_against_the_top_of_the_usable_area_of_a_screen_that_is_not_the_origin() {
        // A second screen to the left of the first, and a taskbar of 48 pixels at the top.
        let bounds = top_bounds(area(-1920, 48, 1920, 1032), 1.0);
        assert_eq!(bounds.y, 48);
        assert_eq!(bounds.x, -1920 + (1920 - bounds.width as i32) / 2);
        assert!(bounds.x >= -1920 && bounds.x + bounds.width as i32 <= 0);
    }

    #[test]
    fn a_scale_that_is_not_a_number_counts_as_one() {
        let one = top_bounds(area(0, 0, 1920, 1080), 1.0);
        assert_eq!(top_bounds(area(0, 0, 1920, 1080), 0.0), one);
        assert_eq!(top_bounds(area(0, 0, 1920, 1080), -2.0), one);
        assert_eq!(top_bounds(area(0, 0, 1920, 1080), f64::NAN), one);
    }

    #[test]
    fn the_event_names_are_the_ones_the_page_uses() {
        // The same strings are in apps/desktop/src/quick.ts.
        assert_eq!(QUICK_LABEL, "quick");
        assert_eq!(OPEN_EVENT, "quick-open");
        assert_eq!(READY_EVENT, "quick-ready");
        assert_eq!(SESSION_EVENT, "quick-session");
        assert_eq!(PROMOTE_EVENT, "quick-promote");
        assert_eq!(PROMOTED_EVENT, "quick-promoted");
    }

    #[test]
    fn the_window_is_made_once() {
        use tauri::Manager;
        let app = tauri::test::mock_app();
        let first = create_hidden(app.handle()).expect("the quick window");
        assert_eq!(first.label(), QUICK_LABEL);
        let again = create_hidden(app.handle()).expect("the same window");
        assert_eq!(again.label(), QUICK_LABEL);
        assert_eq!(app.webview_windows().len(), 1);
        // That it starts hidden, frameless and at the top of the screen is something only a real
        // window shows (the mock runtime ignores those options): `--smoke-quick` checks it.
    }
}

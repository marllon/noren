//! System notifications and the focus of the window.
//!
//! The interface decides when a notification is worth showing (`packages/model/src/notifications.ts`);
//! this side only shows it. Nothing here runs unless the interface calls `notify_show`: the smoke
//! modes never do.

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::lifecycle::main_window;

/// Longest title and body handed to the system. The interface already keeps them short; this is
/// the bound the system gets whatever the page sends.
const MAX_TITLE_CHARS: usize = 80;
const MAX_BODY_CHARS: usize = 200;

/// Plain text for the system: control characters (the escape that starts a terminal sequence, a
/// stray BEL) become spaces, runs of spaces collapse, and the text is cut at `max` characters.
pub fn plain_text(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Shows a notification of the system. The plugin is only used from here (its own commands have no
/// capability), so the page can ask for nothing but this.
#[tauri::command]
pub fn notify_show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(plain_text(&title, MAX_TITLE_CHARS))
        .body(plain_text(&body, MAX_BODY_CHARS))
        .show()
        .map_err(|e| e.to_string())
}

/// Whether the main window has the keyboard focus of the system now. False when the window is
/// hidden, minimized or gone.
#[tauri::command]
pub fn window_is_focused(app: AppHandle) -> Result<bool, String> {
    Ok(main_window_focus(&app)?.unwrap_or(false))
}

/// The focus of the main window, found with a browser pane open too (see [`main_window`]); `None`
/// when there is no such window.
fn main_window_focus<R: Runtime>(app: &AppHandle<R>) -> Result<Option<bool>, String> {
    main_window(app)
        .map(|window| window.is_focused().map_err(|e| e.to_string()))
        .transpose()
}

#[cfg(test)]
mod tests {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    use super::*;

    #[test]
    fn the_focus_is_read_from_the_main_window_with_or_without_a_browser_pane_open() {
        // The mock window never has the focus, so what tells "found" from "not found" is `Some`.
        // The web view of a pane makes Tauri stop calling the main window a webview window; it must
        // be found all the same, or the notification would be decided on a focus nobody read
        // (finding 256).
        let app = tauri::test::mock_app();
        assert_eq!(main_window_focus(app.handle()), Ok(None));
        WebviewWindowBuilder::new(&app, "other", WebviewUrl::default())
            .build()
            .expect("a window");
        assert_eq!(main_window_focus(app.handle()), Ok(None));
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .expect("the main window");
        assert_eq!(main_window_focus(app.handle()), Ok(Some(false)));
        crate::browser_pane::open_a_pane_in_main(app.handle());
        assert_eq!(main_window_focus(app.handle()), Ok(Some(false)));
    }

    #[test]
    fn plain_text_drops_control_characters_and_collapses_spaces() {
        assert_eq!(plain_text("a\x1b[31m  b\x07\n\tc", 80), "a [31m b c");
        assert_eq!(plain_text("  \n ", 80), "");
    }

    #[test]
    fn plain_text_cuts_long_text_with_an_ellipsis() {
        let cut = plain_text(&"x".repeat(300), 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'));
        assert_eq!(plain_text("short", 10), "short");
    }

    #[test]
    fn plain_text_counts_characters_not_bytes() {
        assert_eq!(plain_text("ééééé", 5), "ééééé");
        assert_eq!(plain_text("éééééé", 5), "éééé…");
    }
}

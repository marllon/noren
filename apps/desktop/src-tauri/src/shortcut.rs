//! The global shortcut of the quick terminal: the one key that works with any program in front and
//! shows or hides the quick window (`quick::toggle`).
//!
//! The chord is the interface's to choose (the shortcuts screen records it); it tells this side
//! through `quick_shortcut_set` and the old registration is replaced. The default is registered at
//! start so the key works before the page has loaded. A chord the system will not give (another
//! program holds it) is a warning in the log, never a reason to stop the app. The smoke runs make
//! the state with `enabled` off: nothing is registered then, whoever asks.

use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

use crate::quick;

/// The chord the quick terminal has until the user records another (same spelling as the chords of
/// `apps/desktop/src/keybindings.ts`: modifiers, then the physical key).
pub const DEFAULT_CHORD: &str = "Ctrl+Backquote";

/// What the shortcut needs from the system: put a shortcut in, take it out. The plugin implements it
/// for real; the tests use a list.
pub trait Hotkeys {
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

/// The chord as a shortcut of the system. Refused when it does not parse, or when it has neither
/// Ctrl nor Alt: a global shortcut on a bare key (or Shift+key) would take typing from every
/// program, and the page could ask for it with whatever text it likes.
pub fn parse_chord(chord: &str) -> Result<Shortcut, String> {
    let shortcut =
        Shortcut::from_str(chord).map_err(|e| format!("not a shortcut ({chord}): {e}"))?;
    if shortcut
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT)
    {
        Ok(shortcut)
    } else {
        Err(format!("a global shortcut needs Ctrl or Alt ({chord})"))
    }
}

/// Moves the registration from `current` to `wanted` (`None` leaves no shortcut). The new one is
/// registered first: when the system refuses it (another program has it) nothing changes and the
/// old shortcut keeps working. The error is the reason.
pub fn rebind<H: Hotkeys>(
    hotkeys: &H,
    current: &mut Option<Shortcut>,
    wanted: Option<Shortcut>,
) -> Result<(), String> {
    if *current == wanted {
        return Ok(());
    }
    if let Some(shortcut) = wanted {
        hotkeys
            .register(shortcut)
            .map_err(|e| format!("could not register the shortcut: {e}"))?;
    }
    if let Some(old) = current.take() {
        // The old one is gone from our books either way; a failure here only leaves a registration
        // that nothing handles (the handler checks `current`).
        if let Err(error) = hotkeys.unregister(old) {
            eprintln!("could not release the old quick terminal shortcut: {error}");
        }
    }
    *current = wanted;
    Ok(())
}

/// The shortcut in force and whether this run may register one.
pub struct QuickShortcut {
    enabled: bool,
    current: Mutex<Option<Shortcut>>,
    /// Requests that arrived while `enabled` was off (the smoke runs print it).
    refused: AtomicUsize,
}

impl QuickShortcut {
    pub const fn new(enabled: bool) -> Self {
        Self {
            enabled,
            current: Mutex::new(None),
            refused: AtomicUsize::new(0),
        }
    }

    /// The shortcut registered now.
    pub fn current(&self) -> Option<Shortcut> {
        *self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// How many requests were turned down because this run registers none.
    pub fn refused(&self) -> usize {
        self.refused.load(Ordering::SeqCst)
    }

    /// Applies `chord` (`None`: no shortcut) through `hotkeys`. With `enabled` off it registers
    /// nothing and says nothing: the run asked for no global shortcuts.
    pub fn apply<H: Hotkeys>(&self, hotkeys: &H, chord: Option<&str>) -> Result<(), String> {
        if !self.enabled {
            self.refused.fetch_add(1, Ordering::SeqCst);
            return Ok(());
        }
        let wanted = chord.map(parse_chord).transpose()?;
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        rebind(hotkeys, &mut current, wanted)
    }
}

/// The plugin, as the [`Hotkeys`] of a running app.
struct Plugin<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> Hotkeys for Plugin<'_, R> {
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(shortcut)
            .map_err(|e| e.to_string())
    }

    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|e| e.to_string())
    }
}

/// Applies `chord` for the running app (see [`QuickShortcut::apply`]).
pub fn apply<R: Runtime>(app: &AppHandle<R>, chord: Option<&str>) -> Result<(), String> {
    app.state::<QuickShortcut>().apply(&Plugin(app), chord)
}

/// How many global shortcuts the system holds for this app: what the smoke runs check is zero.
/// The default chord is asked of the plugin itself, not only of our books.
pub fn registered<R: Runtime>(app: &AppHandle<R>) -> usize {
    let state = app.state::<QuickShortcut>();
    let default_held = parse_chord(DEFAULT_CHORD)
        .map(|shortcut| app.global_shortcut().is_registered(shortcut))
        .unwrap_or(false);
    usize::from(state.current().is_some() || default_held)
}

/// What the plugin calls for every shortcut event: a press of the quick terminal's shortcut shows
/// or hides the window.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    if app.state::<QuickShortcut>().current() != Some(*shortcut) {
        return;
    }
    if let Err(error) = quick::toggle_window(app) {
        eprintln!("could not show or hide the quick window: {error}");
    }
}

/// Sets the chord of the quick terminal's global shortcut (the page's `Backend.setQuickShortcut`);
/// `chord` is `None` to have none. The error is the reason, for the page to show.
#[tauri::command]
pub fn quick_shortcut_set(app: AppHandle, chord: Option<String>) -> Result<(), String> {
    apply(&app, chord.as_deref())
}

/// Shows the quick window or hides it, as the shortcut does (the palette and the in-window key use it).
#[tauri::command]
pub fn quick_toggle(app: AppHandle) -> Result<bool, String> {
    quick::toggle_window(&app)
}

/// Keeps the app from stopping on a refused shortcut at start: the warning goes to the log.
pub fn register_default<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = apply(app, Some(DEFAULT_CHORD)) {
        eprintln!(
            "warning: the quick terminal shortcut ({DEFAULT_CHORD}) is not available: {error}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A system that holds some shortcuts and refuses the ones in `taken`.
    #[derive(Default)]
    struct Fake {
        held: RefCell<Vec<Shortcut>>,
        taken: Vec<Shortcut>,
    }

    impl Hotkeys for Fake {
        fn register(&self, shortcut: Shortcut) -> Result<(), String> {
            if self.taken.contains(&shortcut) {
                return Err("HotKey already registered".to_owned());
            }
            self.held.borrow_mut().push(shortcut);
            Ok(())
        }
        fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
            self.held.borrow_mut().retain(|s| *s != shortcut);
            Ok(())
        }
    }

    fn chord(text: &str) -> Shortcut {
        parse_chord(text).expect("a valid chord")
    }

    #[test]
    fn the_chords_the_interface_writes_parse() {
        for text in [
            DEFAULT_CHORD,
            "Ctrl+Alt+Shift+KeyT",
            "Ctrl+Alt+Digit1",
            "Alt+ArrowLeft",
            "Ctrl+Tab",
            "Alt+F4",
            "Ctrl+Equal",
            "Ctrl+Space",
        ] {
            assert!(parse_chord(text).is_ok(), "{text} should parse");
        }
        let default = chord(DEFAULT_CHORD);
        assert_eq!(default.mods, Modifiers::CONTROL);
        assert_eq!(default.key, tauri_plugin_global_shortcut::Code::Backquote);
    }

    #[test]
    fn a_chord_without_ctrl_or_alt_is_refused() {
        assert!(parse_chord("Shift+KeyA").is_err());
        assert!(parse_chord("KeyA").is_err());
        assert!(parse_chord("Backquote").is_err());
        assert!(parse_chord("").is_err());
        assert!(parse_chord("Ctrl+").is_err());
        assert!(parse_chord("Ctrl+NotAKey").is_err());
    }

    #[test]
    fn the_first_registration_holds_the_shortcut() {
        let system = Fake::default();
        let mut current = None;
        rebind(&system, &mut current, Some(chord(DEFAULT_CHORD))).unwrap();
        assert_eq!(current, Some(chord(DEFAULT_CHORD)));
        assert_eq!(system.held.borrow().as_slice(), [chord(DEFAULT_CHORD)]);
    }

    #[test]
    fn a_new_chord_replaces_the_old_one() {
        let system = Fake::default();
        let mut current = None;
        rebind(&system, &mut current, Some(chord(DEFAULT_CHORD))).unwrap();
        rebind(&system, &mut current, Some(chord("Ctrl+Alt+KeyQ"))).unwrap();
        assert_eq!(current, Some(chord("Ctrl+Alt+KeyQ")));
        assert_eq!(system.held.borrow().as_slice(), [chord("Ctrl+Alt+KeyQ")]);
    }

    #[test]
    fn asking_for_the_chord_it_has_registers_nothing_again() {
        let system = Fake::default();
        let mut current = None;
        rebind(&system, &mut current, Some(chord(DEFAULT_CHORD))).unwrap();
        // A second registration of the same key would fail on a real system.
        let busy = Fake {
            taken: vec![chord(DEFAULT_CHORD)],
            ..Fake::default()
        };
        rebind(&busy, &mut current, Some(chord(DEFAULT_CHORD))).unwrap();
        assert_eq!(current, Some(chord(DEFAULT_CHORD)));
    }

    #[test]
    fn no_chord_releases_the_shortcut() {
        let system = Fake::default();
        let mut current = None;
        rebind(&system, &mut current, Some(chord(DEFAULT_CHORD))).unwrap();
        rebind(&system, &mut current, None).unwrap();
        assert_eq!(current, None);
        assert!(system.held.borrow().is_empty());
    }

    #[test]
    fn a_chord_another_program_holds_is_an_error_and_the_old_shortcut_stays() {
        let taken = chord("Ctrl+Alt+KeyQ");
        let system = Fake {
            taken: vec![taken],
            ..Fake::default()
        };
        let mut current = None;
        rebind(&system, &mut current, Some(chord(DEFAULT_CHORD))).unwrap();
        let error = rebind(&system, &mut current, Some(taken)).unwrap_err();
        assert!(error.contains("could not register"), "{error}");
        assert_eq!(current, Some(chord(DEFAULT_CHORD)));
        assert_eq!(system.held.borrow().as_slice(), [chord(DEFAULT_CHORD)]);
    }

    #[test]
    fn a_default_another_program_holds_leaves_no_shortcut_and_the_app_goes_on() {
        let system = Fake {
            taken: vec![chord(DEFAULT_CHORD)],
            ..Fake::default()
        };
        let state = QuickShortcut::new(true);
        let error = state.apply(&system, Some(DEFAULT_CHORD)).unwrap_err();
        assert!(error.contains("could not register"), "{error}");
        assert_eq!(state.current(), None);
        // The user can still pick another one afterwards.
        state.apply(&system, Some("Ctrl+Alt+KeyQ")).unwrap();
        assert_eq!(state.current(), Some(chord("Ctrl+Alt+KeyQ")));
    }

    #[test]
    fn a_bad_chord_changes_nothing() {
        let system = Fake::default();
        let state = QuickShortcut::new(true);
        state.apply(&system, Some(DEFAULT_CHORD)).unwrap();
        assert!(state.apply(&system, Some("KeyA")).is_err());
        assert!(state.apply(&system, Some("nonsense")).is_err());
        assert_eq!(state.current(), Some(chord(DEFAULT_CHORD)));
        assert_eq!(system.held.borrow().len(), 1);
    }

    #[test]
    fn a_run_with_shortcuts_off_registers_nothing_whatever_it_is_asked() {
        let system = Fake::default();
        let state = QuickShortcut::new(false);
        state.apply(&system, Some(DEFAULT_CHORD)).unwrap();
        state.apply(&system, Some("Ctrl+Alt+KeyQ")).unwrap();
        state.apply(&system, Some("nonsense")).unwrap();
        assert!(system.held.borrow().is_empty());
        assert_eq!(state.current(), None);
        assert_eq!(state.refused(), 3);
    }
}

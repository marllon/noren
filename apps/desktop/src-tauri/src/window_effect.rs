//! The effect painted behind the main window (Mica, Acrylic, vibrancy).
//!
//! The rule that decides what the window has after a request, and the fallback to an opaque
//! window, are in `noren_core::window` and tested there. This file is the part that touches the
//! native window: [`NativePainter`] paints with the `window-vibrancy` crate, and
//! [`apply_on_main_thread`] runs it where the system wants it (macOS only lets the main thread touch
//! a window).
//!
//! `window-vibrancy` is a direct dependency, although Tauri uses it too (`Window::set_effects`),
//! because the Tauri call drops the result: it cannot say whether the system painted the effect,
//! and the log and the settings screen have to say so. The window is created transparent
//! (tauri.conf.json), which is what lets an effect show through the page.

use std::sync::mpsc;
use std::time::Duration;

use noren_core::{EffectOutcome, WindowEffect, WindowPainter, apply_effect};
use serde::Serialize;
use tauri::{Runtime, Theme, Window};
use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};

/// How long the caller waits for the main thread to paint. A window that does not answer in this
/// time is a problem of the app, not of the system's support, so it is an error and not a fallback.
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Paints on a native window with `window-vibrancy`. Every call goes to the system and comes back
/// with its answer; on a system that does not have the effect that answer is an error, which
/// [`apply_effect`] turns into the opaque fallback.
///
/// It takes the window as a `Window`: Tauri stops calling a window a webview window while a web view
/// of a browser pane is a child of it, and the effect is the window's, not the page's.
pub struct NativePainter<'a, R: Runtime>(pub &'a Window<R>);

fn text(error: window_vibrancy::Error) -> String {
    error.to_string()
}

impl<R: Runtime> WindowPainter for NativePainter<'_, R> {
    fn mica(&self) -> Result<(), String> {
        // `None`: the backdrop follows the dark or light mode of the system.
        window_vibrancy::apply_mica(self.0, None).map_err(text)
    }

    fn acrylic(&self) -> Result<(), String> {
        // `None`: the default tint of the system.
        window_vibrancy::apply_acrylic(self.0, None).map_err(text)
    }

    fn vibrancy(&self) -> Result<(), String> {
        window_vibrancy::apply_vibrancy(
            self.0,
            NSVisualEffectMaterial::UnderWindowBackground,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
        .map_err(text)
    }

    fn clear(&self) {
        // Each call undoes one kind of effect and fails where that kind does not exist; there is
        // nothing to undo then, so the answers are not looked at.
        let _ = window_vibrancy::clear_mica(self.0);
        let _ = window_vibrancy::clear_acrylic(self.0);
        let _ = window_vibrancy::clear_blur(self.0);
        let _ = window_vibrancy::clear_vibrancy(self.0);
    }
}

/// Gives `window` the effect on the main thread and returns what it has afterwards.
///
/// `scheme` is the dark or light look the effect is painted in: with an effect on, the window takes
/// it as its theme, so Mica and Acrylic match the theme of Noren and not the mode of the system. With
/// no effect (or no scheme: `None`, see [`parse_scheme`]) the window goes back to following the
/// system, which is how it always was. That matters for more than the backdrop: a window with a
/// theme of its own also tells the page which color scheme it prefers, so a theme that follows the
/// system must not be given one.
///
/// Must not be called from the main thread itself: it waits for the main thread to answer. The
/// Tauri commands that call it are `async`, which runs them elsewhere.
pub fn apply_on_main_thread<R: Runtime>(
    window: &Window<R>,
    requested: WindowEffect,
    scheme: Option<Theme>,
) -> Result<EffectOutcome, String> {
    let (sender, receiver) = mpsc::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            // A system that does not take a window theme is not worth failing for: the effect is
            // the point.
            let own_theme = if requested == WindowEffect::None {
                None
            } else {
                scheme
            };
            let _ = target.set_theme(own_theme);
            let outcome = apply_effect(&NativePainter(&target), requested);
            // The receiver is gone only when the caller gave up waiting.
            let _ = sender.send(outcome);
        })
        .map_err(|e| format!("could not reach the main thread: {e}"))?;
    receiver
        .recv_timeout(MAIN_THREAD_TIMEOUT)
        .map_err(|_| "the window did not answer the request for an effect".to_owned())
}

/// The look a request names: `dark` and `light` are the window theme to force, `system` leaves the
/// window following the mode of the system (`None`). Anything else is an error.
pub fn parse_scheme(name: &str) -> Result<Option<Theme>, String> {
    match name {
        "dark" => Ok(Some(Theme::Dark)),
        "light" => Ok(Some(Theme::Light)),
        "system" => Ok(None),
        other => Err(format!("'{other}' is not a window scheme")),
    }
}

/// Whether the system has its transparency effects turned off: the "Transparency effects" switch of
/// Windows (Settings > Personalization > Colors), kept as the `EnableTransparency` value (0 is off)
/// under the Personalize key of the settings of the current user. Only that value is read, never
/// written, and nothing else of the registry is looked at. The web view does not always report the
/// switch as `prefers-reduced-transparency`, so the glass style asks the system itself and draws
/// opaque panels when either says so. `false` where there is no such switch (other systems) and
/// when the value is missing or cannot be read: then the system has the effects, as it does by default.
#[cfg(windows)]
pub fn transparency_reduced() -> bool {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    use windows::core::w;

    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: `data` and `size` are live locals of the sizes the call is told (one DWORD); the key
    // and value names are NUL-terminated literals; the key is opened read only by the call itself
    // and closed again before it returns.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("EnableTransparency"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut data as *mut u32).cast()),
            Some(&mut size),
        )
    };
    reduced_from_value(status.is_ok().then_some(data))
}

#[cfg(not(windows))]
pub fn transparency_reduced() -> bool {
    false
}

/// The rule on the value of `EnableTransparency`: only an explicit 0 turns the effects off.
#[cfg(any(windows, test))]
fn reduced_from_value(value: Option<u32>) -> bool {
    value == Some(0)
}

/// What the interface gets back: [`EffectOutcome`] with the names the interface uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffectReportDto {
    pub requested: String,
    pub applied: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl From<EffectOutcome> for EffectReportDto {
    fn from(outcome: EffectOutcome) -> Self {
        Self {
            requested: outcome.requested.as_str().to_owned(),
            applied: outcome.applied.as_str().to_owned(),
            reason: outcome.reason,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scheme_is_dark_light_or_the_system_and_nothing_else() {
        assert_eq!(parse_scheme("dark"), Ok(Some(Theme::Dark)));
        assert_eq!(parse_scheme("light"), Ok(Some(Theme::Light)));
        assert_eq!(parse_scheme("system"), Ok(None));
        for name in ["", "Dark", "auto", "true", " light"] {
            assert_eq!(
                parse_scheme(name),
                Err(format!("'{name}' is not a window scheme"))
            );
        }
    }

    #[test]
    fn only_an_explicit_zero_turns_the_transparency_effects_off() {
        assert!(reduced_from_value(Some(0)));
        assert!(!reduced_from_value(Some(1)));
        assert!(!reduced_from_value(Some(2)));
        // A missing value, or one that could not be read, is the default of the system: effects on.
        assert!(!reduced_from_value(None));
    }

    #[test]
    fn the_transparency_setting_can_be_read_without_changing_anything() {
        // The answer depends on the machine, so only that the read comes back (and twice the same).
        assert_eq!(transparency_reduced(), transparency_reduced());
    }

    #[test]
    fn the_report_uses_the_names_of_the_interface_and_leaves_out_a_missing_reason() {
        let applied = EffectReportDto::from(EffectOutcome {
            requested: WindowEffect::Mica,
            applied: WindowEffect::Mica,
            reason: None,
        });
        assert_eq!(
            serde_json::to_string(&applied).expect("json"),
            r#"{"requested":"mica","applied":"mica"}"#
        );
        let fallback = EffectReportDto::from(EffectOutcome {
            requested: WindowEffect::Vibrancy,
            applied: WindowEffect::None,
            reason: Some("only on macOS".to_owned()),
        });
        assert_eq!(
            serde_json::to_string(&fallback).expect("json"),
            r#"{"requested":"vibrancy","applied":"none","reason":"only on macOS"}"#
        );
    }
}

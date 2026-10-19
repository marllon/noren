//! The effect the system paints behind the window (Mica, Acrylic, vibrancy), without any Tauri
//! dependency: the name of each effect, and the rule that decides what the window has after a
//! request. Painting is done by a [`WindowPainter`], which the desktop app implements over the
//! native window; the tests here use a fake one.
//!
//! The rule is the fallback of the product: a system that cannot paint the effect (Mica before
//! Windows 11, vibrancy anywhere but macOS) keeps an opaque window. That is an answer, not an error:
//! the outcome says which effect the window has and, when it is not the one asked for, why.

use std::fmt;

/// An effect the window can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowEffect {
    /// The plain opaque window every system has.
    None,
    /// Mica, the backdrop of Windows 11.
    Mica,
    /// Acrylic, the blurred backdrop of Windows 10 and 11.
    Acrylic,
    /// Vibrancy, the translucent material of macOS.
    Vibrancy,
}

impl WindowEffect {
    /// Every effect, in the order the settings list them.
    pub const ALL: [WindowEffect; 4] = [Self::None, Self::Mica, Self::Acrylic, Self::Vibrancy];

    /// The effect a name in the settings file or in a request stands for (`none`, `mica`,
    /// `acrylic`, `vibrancy`, lower case); `None` for any other text.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|effect| effect.as_str() == name)
    }

    /// The name used in the settings file and by the interface.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Mica => "mica",
            Self::Acrylic => "acrylic",
            Self::Vibrancy => "vibrancy",
        }
    }

    /// The name for a person.
    pub fn label(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::Mica => "Mica",
            Self::Acrylic => "Acrylic",
            Self::Vibrancy => "Vibrancy",
        }
    }
}

impl fmt::Display for WindowEffect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What the window has after a request for an effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectOutcome {
    /// The effect that was asked for.
    pub requested: WindowEffect,
    /// The effect the window has now: `requested`, or [`WindowEffect::None`] when the system
    /// could not paint it.
    pub applied: WindowEffect,
    /// Why `applied` is not `requested`; `None` when it is.
    pub reason: Option<String>,
}

impl EffectOutcome {
    /// The window kept its opaque look although an effect was asked for.
    pub fn is_fallback(&self) -> bool {
        self.applied != self.requested
    }

    /// One line for the log, such as `window effect mica applied` or
    /// `window effect mica not applied, opaque window kept: <why>`.
    pub fn log_line(&self) -> String {
        match (&self.reason, self.requested) {
            (Some(reason), requested) => {
                format!("window effect {requested} not applied, opaque window kept: {reason}")
            }
            (None, WindowEffect::None) => "window effect none, opaque window".to_owned(),
            (None, requested) => format!("window effect {requested} applied"),
        }
    }
}

/// What paints an effect on a window. Each method either paints it or says why the system cannot.
pub trait WindowPainter {
    /// Paints Mica.
    fn mica(&self) -> Result<(), String>;
    /// Paints Acrylic.
    fn acrylic(&self) -> Result<(), String>;
    /// Paints vibrancy.
    fn vibrancy(&self) -> Result<(), String>;
    /// Takes any effect away. Never fails: where there is nothing to take away there is nothing to do.
    fn clear(&self);
}

/// Gives the window `requested`, and says what it has afterwards. The effect it had is taken away
/// first, so two effects never stack. When the system cannot paint the effect the window is left
/// opaque and the outcome carries the reason. Never fails.
pub fn apply_effect(painter: &dyn WindowPainter, requested: WindowEffect) -> EffectOutcome {
    painter.clear();
    let painted = match requested {
        WindowEffect::None => return outcome(requested, requested, None),
        WindowEffect::Mica => painter.mica(),
        WindowEffect::Acrylic => painter.acrylic(),
        WindowEffect::Vibrancy => painter.vibrancy(),
    };
    match painted {
        Ok(()) => outcome(requested, requested, None),
        Err(reason) => {
            // A call that failed half way must not leave an effect behind.
            painter.clear();
            outcome(requested, WindowEffect::None, Some(reason))
        }
    }
}

fn outcome(
    requested: WindowEffect,
    applied: WindowEffect,
    reason: Option<String>,
) -> EffectOutcome {
    EffectOutcome {
        requested,
        applied,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Paints what `supports` lists and records every call.
    struct Fake {
        supports: Vec<WindowEffect>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Fake {
        fn new(supports: &[WindowEffect]) -> Self {
            Self {
                supports: supports.to_vec(),
                calls: RefCell::new(Vec::new()),
            }
        }

        fn paint(&self, call: &'static str, effect: WindowEffect) -> Result<(), String> {
            self.calls.borrow_mut().push(call);
            if self.supports.contains(&effect) {
                Ok(())
            } else {
                Err(format!(
                    "{} is not available on this system",
                    effect.label()
                ))
            }
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl WindowPainter for Fake {
        fn mica(&self) -> Result<(), String> {
            self.paint("mica", WindowEffect::Mica)
        }
        fn acrylic(&self) -> Result<(), String> {
            self.paint("acrylic", WindowEffect::Acrylic)
        }
        fn vibrancy(&self) -> Result<(), String> {
            self.paint("vibrancy", WindowEffect::Vibrancy)
        }
        fn clear(&self) {
            self.calls.borrow_mut().push("clear");
        }
    }

    #[test]
    fn names_round_trip_and_nothing_else_parses() {
        for effect in WindowEffect::ALL {
            assert_eq!(WindowEffect::parse(effect.as_str()), Some(effect));
        }
        for name in ["", "Mica", "MICA", " mica", "blur", "tabbed", "mica "] {
            assert_eq!(WindowEffect::parse(name), None, "{name:?}");
        }
    }

    #[test]
    fn a_supported_effect_is_applied_after_the_old_one_is_cleared() {
        let painter = Fake::new(&[WindowEffect::Mica]);
        let outcome = apply_effect(&painter, WindowEffect::Mica);
        assert_eq!(outcome.applied, WindowEffect::Mica);
        assert_eq!(outcome.reason, None);
        assert!(!outcome.is_fallback());
        assert_eq!(painter.calls(), ["clear", "mica"]);
        assert_eq!(outcome.log_line(), "window effect mica applied");
    }

    #[test]
    fn an_effect_the_system_cannot_paint_falls_back_to_opaque_with_the_reason() {
        let painter = Fake::new(&[]);
        for requested in [
            WindowEffect::Mica,
            WindowEffect::Acrylic,
            WindowEffect::Vibrancy,
        ] {
            let outcome = apply_effect(&painter, requested);
            assert_eq!(outcome.requested, requested);
            assert_eq!(outcome.applied, WindowEffect::None);
            assert!(outcome.is_fallback());
            assert_eq!(
                outcome.reason,
                Some(format!(
                    "{} is not available on this system",
                    requested.label()
                ))
            );
            assert_eq!(
                outcome.log_line(),
                format!(
                    "window effect {requested} not applied, opaque window kept: {} is not available on this system",
                    requested.label()
                )
            );
        }
        // A failed call leaves nothing behind: the window is cleared again after it.
        let painter = Fake::new(&[]);
        apply_effect(&painter, WindowEffect::Acrylic);
        assert_eq!(painter.calls(), ["clear", "acrylic", "clear"]);
    }

    #[test]
    fn none_only_clears() {
        let painter = Fake::new(&[WindowEffect::Mica]);
        let outcome = apply_effect(&painter, WindowEffect::None);
        assert_eq!(outcome.applied, WindowEffect::None);
        assert_eq!(outcome.reason, None);
        assert!(!outcome.is_fallback());
        assert_eq!(painter.calls(), ["clear"]);
        assert_eq!(outcome.log_line(), "window effect none, opaque window");
    }

    #[test]
    fn each_effect_calls_its_own_painter() {
        let all = WindowEffect::ALL;
        for (effect, call) in [
            (WindowEffect::Mica, "mica"),
            (WindowEffect::Acrylic, "acrylic"),
            (WindowEffect::Vibrancy, "vibrancy"),
        ] {
            let painter = Fake::new(&all);
            let outcome = apply_effect(&painter, effect);
            assert_eq!(outcome.applied, effect);
            assert_eq!(painter.calls(), ["clear", call]);
        }
    }
}

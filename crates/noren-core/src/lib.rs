//! Noren core library. Kept free of Tauri so it can be tested on its own.

pub mod profiles;
pub mod pty;

pub use profiles::{
    Platform, ProbeEnv, Profile, ProfileSet, SystemEnv, detect_profiles, detect_system_profiles,
};
pub use pty::{ExitInfo, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec};

/// Returns the product name.
pub fn name() -> &'static str {
    "noren"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_noren() {
        assert_eq!(name(), "noren");
    }
}

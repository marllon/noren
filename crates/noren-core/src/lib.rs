//! Noren core library. Kept free of Tauri so it can be tested on its own.

pub mod profiles;
pub mod project;
pub mod pty;
pub mod store;

pub use profiles::{
    Platform, ProbeEnv, Profile, ProfileSet, SystemEnv, detect_profiles, detect_system_profiles,
};
pub use project::{ACTIONS_FILE_PATH, ShortRunError, read_project_file, run_short};
pub use pty::{ExitInfo, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec};
pub use store::{StateStore, StoreError};

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

//! Noren core library. Kept free of Tauri so it can be tested on its own.

pub mod config;
pub mod git;
pub mod integration;
pub mod profiles;
pub mod project;
pub mod pty;
pub mod store;
pub mod themes;

pub use config::{CONFIG_FILE_NAME, ConfigError, ConfigStore, ConfigWatcher};
pub use git::{GitHead, read_head};
pub use integration::{
    BASH_LOGIN_VAR, BASH_SCRIPT, POWERSHELL_SCRIPT, ZSH_DIR, ZSH_RC, ZSH_USER_DIR_VAR,
    cmd_integration_prompt, is_bash, is_cmd, is_powershell, is_zsh, powershell_integration_args,
};
pub use profiles::{
    Platform, ProbeEnv, Profile, ProfileSet, SystemEnv, detect_profiles, detect_system_profiles,
};
pub use project::{ACTIONS_FILE_PATH, ShortRunError, read_project_file, run_short};
pub use pty::{ExitInfo, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec};
pub use store::{StateStore, StoreError};
pub use themes::{THEMES_DIR_NAME, ThemeError, ThemeStore, is_valid_theme_id};

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

//! Noren core library. Kept free of Tauri so it can be tested on its own.

pub mod ai;
pub mod background;
pub mod config;
pub mod fonts;
pub mod git;
pub mod integration;
pub mod mods;
pub mod profiles;
pub mod project;
pub mod pty;
pub mod scrollback;
pub mod store;
pub mod themes;
pub mod window;

pub use ai::{
    AiClient, AiError, ChatMessage, DEFAULT_TIMEOUT, OLLAMA_DEFAULT_URL, OllamaProbe, Provider,
    ProviderKind, Role, SseDecoder, SseMessage, StreamEvent, StreamParser,
};
pub use background::{BackgroundError, BackgroundStore, MAX_BACKGROUND_BYTES, sniff_image};
pub use config::{CONFIG_FILE_NAME, ConfigError, ConfigStore, ConfigWatcher};
pub use fonts::{MAX_FONT_NAME_CHARS, is_font_name, list_monospace_families, monospace_families};
pub use git::{GitHead, read_head};
pub use integration::{
    BASH_LOGIN_VAR, BASH_SCRIPT, POWERSHELL_SCRIPT, ZSH_DIR, ZSH_RC, ZSH_USER_DIR_VAR,
    cmd_integration_prompt, is_bash, is_cmd, is_powershell, is_zsh, powershell_integration_args,
};
pub use mods::{
    MAX_MOD_BYTES, MAX_MODS, MODS_DIR_NAME, ModError, ModFile, ModStore, ModWatcher,
    is_valid_mod_file_name,
};
pub use profiles::{
    MAX_USER_PROFILES, Platform, ProbeEnv, Profile, ProfileSet, RESERVED_PROFILE_ID, SystemEnv,
    UserProfile, UserProfileError, detect_profiles, detect_system_profiles, expand_env_vars,
};
pub use project::{ACTIONS_FILE_PATH, ShortRunError, read_project_file, run_short};
pub use pty::{ExitInfo, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec};
pub use scrollback::{
    MAX_SCROLLBACK_BYTES, SCROLLBACK_DIR_NAME, ScrollbackError, ScrollbackStore, is_valid_pane_id,
};
pub use store::{StateStore, StoreError};
pub use themes::{THEMES_DIR_NAME, ThemeError, ThemeStore, is_valid_theme_id};
pub use window::{EffectOutcome, WindowEffect, WindowPainter, apply_effect};

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

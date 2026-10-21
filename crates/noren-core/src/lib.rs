//! Noren core library. Kept free of Tauri so it can be tested on its own.

pub mod agents;
pub mod ai;
pub mod background;
pub mod bench;
pub mod config;
pub mod daemon;
pub mod fonts;
pub mod git;
pub mod git_diff;
pub mod integration;
pub mod link;
pub mod mods;
pub mod preview;
pub mod profiles;
pub mod project;
pub mod pty;
pub mod scrollback;
pub mod store;
pub mod themes;
pub mod vault;
pub mod window;
pub mod worktree;

pub use agents::{
    AgentEntry, AgentMatch, CatalogError, MAX_CATALOG_ENTRIES, MAX_ENTRY_NAMES, MAX_NAME_CHARS,
    ProcessInfo, ProcessSource, SystemProcesses, check_catalog, find_agent, program_name,
    scan_sessions,
};
pub use ai::{
    AiClient, AiError, ChatMessage, DEFAULT_TIMEOUT, OLLAMA_DEFAULT_URL, OllamaMemory, OllamaProbe,
    Provider, ProviderKind, Role, SseDecoder, SseMessage, StreamEvent, StreamParser,
    is_http_address,
};
// Re-exported so the app can cancel a request without depending on tokio-util itself.
pub use background::{BackgroundError, BackgroundStore, MAX_BACKGROUND_BYTES, sniff_image};
pub use bench::{
    BENCH_DIR_NAME, BenchError, BenchFile, BenchStore, MAX_BENCH_BYTES, MAX_BENCH_RESULTS,
    is_valid_bench_stamp,
};
pub use config::{CONFIG_FILE_NAME, ConfigError, ConfigStore, ConfigWatcher};
pub use fonts::{MAX_FONT_NAME_CHARS, is_font_name, list_monospace_families, monospace_families};
pub use git::{GitHead, read_head};
pub use git_diff::{GitDiff, GitDiffRefusal, MAX_GIT_DIFF_BYTES, read_git_diff};
pub use integration::{
    BASH_LOGIN_VAR, BASH_SCRIPT, POWERSHELL_SCRIPT, ZSH_DIR, ZSH_RC, ZSH_USER_DIR_VAR,
    cmd_integration_prompt, is_bash, is_cmd, is_powershell, is_zsh, powershell_integration_args,
};
pub use link::{LinkError, MAX_LINK_BYTES, check_external_link};
pub use mods::{
    MAX_MOD_BYTES, MAX_MODS, MODS_DIR_NAME, ModError, ModFile, ModStore, ModWatcher,
    is_valid_mod_file_name,
};
pub use preview::{
    FilePreview, MAX_PREVIEW_IMAGE_BYTES, MAX_PREVIEW_PATH, MAX_PREVIEW_TEXT_BYTES, PreviewImage,
    PreviewRefusal, TextKind, read_file_preview, sniff_preview_image, text_kind_of,
};
pub use profiles::{
    MAX_USER_PROFILES, Platform, ProbeEnv, Profile, ProfileSet, RESERVED_PROFILE_ID, SshProfile,
    SystemEnv, UserProfile, UserProfileError, detect_profiles, detect_system_profiles,
    expand_env_vars,
};
pub use project::{ACTIONS_FILE_PATH, ShortRunError, read_project_file, run_short};
pub use pty::{ExitInfo, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec};
pub use scrollback::{
    MAX_SCROLLBACK_BYTES, SCROLLBACK_DIR_NAME, ScrollbackError, ScrollbackStore, is_valid_pane_id,
};
pub use store::{StateStore, StoreError};
pub use themes::{THEMES_DIR_NAME, ThemeError, ThemeStore, is_valid_theme_id};
pub use tokio_util::sync::CancellationToken;
pub use vault::{
    KeyVault, KeyringVault, MAX_KEY_CHARS, MAX_PROVIDER_ID_LEN, MemoryVault,
    SERVICE as KEYCHAIN_SERVICE, VaultError, is_valid_provider_id,
};
pub use window::{EffectOutcome, WindowEffect, WindowPainter, apply_effect};
pub use worktree::{
    GitCli, Worktree, WorktreeError, create_worktree, list_worktrees, native_path,
    parse_worktree_list, remove_worktree, validate_branch_name, worktree_destination,
    worktree_folder_name,
};

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

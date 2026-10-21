//! Noren core library. Kept free of Tauri so it can be tested on its own.

pub mod agents;
pub mod ai;
pub mod api;
pub mod background;
pub mod bench;
pub mod config;
pub mod daemon;
pub mod docker;
pub mod fonts;
pub mod gallery;
pub mod git;
pub mod git_diff;
pub mod hardware;
pub mod integration;
pub mod link;
pub mod mods;
pub mod plugins;
pub mod preview;
pub mod profiles;
pub mod project;
pub mod pty;
pub mod scrollback;
pub mod ssh_config;
pub mod store;
pub mod sync;
pub mod sync_spaces;
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
pub use docker::{
    DOCKER_TIMEOUT, DockerCli, DockerError, MAX_CONTAINER_NAME_CHARS, MAX_DOCKER_OUTPUT_BYTES,
    is_safe_container_name, list_running_containers, parse_container_names,
};
pub use fonts::{MAX_FONT_NAME_CHARS, is_font_name, list_monospace_families, monospace_families};
pub use gallery::{
    DEFAULT_INDEX_URL, GALLERY_FILE_NAME, GALLERY_TIMEOUT, Gallery, GalleryError, GalleryIndex,
    GalleryItem, INDEX_VERSION, InstalledItem, ItemKind, MAX_INDEX_BYTES, MAX_ITEM_BYTES,
    MAX_ITEMS, is_valid_version, parse_index, sha256_hex,
};
pub use git::{GitHead, read_head};
pub use git_diff::{GitDiff, GitDiffRefusal, MAX_GIT_DIFF_BYTES, read_git_diff};
pub use hardware::{
    Hardware, HardwareSource, MAX_EXACT_BYTES, SystemHardware, VRAM_TIMEOUT,
    parse_nvidia_smi_memory, read_hardware, read_system_hardware,
};
pub use integration::{
    BASH_LOGIN_VAR, BASH_SCRIPT, POWERSHELL_SCRIPT, ZSH_DIR, ZSH_RC, ZSH_USER_DIR_VAR,
    cmd_integration_prompt, is_bash, is_cmd, is_powershell, is_zsh, powershell_integration_args,
};
pub use link::{LinkError, MAX_LINK_BYTES, check_external_link};
pub use mods::{
    MAX_MOD_BYTES, MAX_MODS, MODS_DIR_NAME, ModError, ModFile, ModStore, ModWatcher,
    is_valid_mod_file_name,
};
pub use plugins::{
    MANIFEST_FILE_NAME, MAX_PLUGIN_FILE_BYTES, MAX_PLUGINS, PLUGINS_DIR_NAME, PluginError,
    PluginFiles, PluginFolder, PluginStore,
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
pub use ssh_config::{
    MAX_SSH_CONFIG_BYTES, MAX_SSH_HOST_CHARS, is_safe_host_name, parse_ssh_hosts, read_ssh_hosts,
    read_ssh_hosts_from, ssh_config_path,
};
pub use store::{StateStore, StoreError};
pub use sync::{
    ChangeKind, MAX_REMOTE_CHARS, MAX_SYNC_FILE_BYTES, MAX_SYNC_FILES, PendingChange, PullOutcome,
    PushOutcome, SPACE_FILE_SUFFIX, SPACES_DIR_NAME, SYNC_DIR_NAME, SYNC_TIMEOUT, SyncError,
    SyncRepo, SyncStatus, is_syncable, validate_remote_url,
};
pub use sync_spaces::{
    SPACE_LINKS_FILE_NAME, SpaceFileInfo, SpaceFileLink, SpaceFileWrite, SpaceFiles, SpaceFolder,
    SpaceLink,
};
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

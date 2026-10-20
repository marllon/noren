/// Every command the page can invoke (the list of `generate_handler!` in `src/main.rs`; a test in
/// `src/capabilities.rs` keeps the two the same). Declaring them here is what turns the access to
/// app commands from "every window may call every command" into "a window may call the commands
/// its capability names": each one gets a permission `allow-<command with dashes>`, and the files
/// in `capabilities/` pick the ones each window gets.
const COMMANDS: &[&str] = &[
    "ai_providers",
    "ai_configure",
    "ai_ollama_models",
    "ai_test_connection",
    "ai_set_key",
    "ai_chat_stream",
    "ai_cancel",
    "profiles_list",
    "profiles_set_user",
    "session_create",
    "session_attach",
    "session_reattach",
    "sessions_keep_set",
    "quick_shortcut_set",
    "quick_toggle",
    "session_write",
    "session_resize",
    "session_kill",
    "session_retry",
    "state_load",
    "state_save",
    "state_quarantine",
    "project_actions_read",
    "project_command_run",
    "git_info",
    "agents_scan",
    "worktree_list",
    "worktree_create",
    "worktree_remove",
    "config_load",
    "config_save",
    "config_watch",
    "theme_list",
    "theme_save",
    "scrollback_load",
    "scrollback_list",
    "scrollback_save",
    "scrollback_delete",
    "app_close_listening",
    "app_close_ready",
    "mod_list",
    "mod_watch",
    "window_effect_set",
    "background_image_read",
    "file_preview_read",
    "fonts_list_monospace",
    "link_open",
    "browser_open",
    "browser_navigate",
    "browser_set_bounds",
    "browser_close",
    "notify_show",
    "window_is_focused",
    "deep_link_take_waiting",
    "deep_link_applied",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}

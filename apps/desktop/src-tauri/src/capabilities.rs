//! Tests that keep the security configuration of the app honest: the commands the page can call,
//! what each window is granted, and the Content Security Policy. They read the files as they are
//! (`build.rs`, `main.rs`, `capabilities/*.json`, `tauri.conf.json`), so a command added in one place
//! and forgotten in another, a broad permission set added to a window, or a loosened policy fails here.

use serde_json::Value;
use std::collections::BTreeSet;

const BUILD_RS: &str = include_str!("../build.rs");
const MAIN_RS: &str = include_str!("main.rs");
const MAIN_CAPABILITY: &str = include_str!("../capabilities/default.json");
const QUICK_CAPABILITY: &str = include_str!("../capabilities/quick.json");
const WINDOW_CAPABILITY: &str = include_str!("../capabilities/window.json");
const TAURI_CONF: &str = include_str!("../tauri.conf.json");

/// The names in `const COMMANDS: &[&str] = [ ... ];` of `build.rs`.
fn declared_commands() -> BTreeSet<String> {
    let start = BUILD_RS
        .find("const COMMANDS")
        .expect("COMMANDS in build.rs");
    let body = &BUILD_RS[start..];
    let body = &body[..body.find("];").expect("end of COMMANDS")];
    body.lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.strip_suffix("\","))
        .map(str::to_owned)
        .collect()
}

/// The commands of `generate_handler![ ... ]` in `main.rs` (`module::command`).
fn handled_commands() -> BTreeSet<String> {
    let start = MAIN_RS
        .find("tauri::generate_handler![")
        .expect("generate_handler in main.rs");
    let body = &MAIN_RS[start..];
    let body = &body[..body.find("])").expect("end of the handler list")];
    body.lines()
        .filter_map(|line| {
            let line = line.trim().strip_suffix(',')?;
            let (_module, command) = line.split_once("::")?;
            command
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_')
                .then(|| command.to_owned())
        })
        .collect()
}

fn permission(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

fn capability(text: &str) -> Value {
    serde_json::from_str(text).expect("a capability file is JSON")
}

fn permissions_of(capability: &Value) -> BTreeSet<String> {
    capability["permissions"]
        .as_array()
        .expect("permissions")
        .iter()
        .map(|p| p.as_str().expect("a permission is a string").to_owned())
        .collect()
}

#[test]
fn the_commands_of_the_handler_and_of_the_build_script_are_the_same() {
    let handled = handled_commands();
    assert!(handled.len() > 30, "found {} commands", handled.len());
    assert_eq!(
        handled,
        declared_commands(),
        "main.rs (generate_handler) and build.rs (COMMANDS) must list the same commands"
    );
}

#[test]
fn the_main_window_is_granted_every_command_and_only_those_of_the_core_it_uses() {
    let main = capability(MAIN_CAPABILITY);
    assert_eq!(main["windows"], serde_json::json!(["main"]));
    let granted = permissions_of(&main);
    for command in declared_commands() {
        assert!(
            granted.contains(&permission(&command)),
            "main lacks {command}"
        );
    }
    let core: BTreeSet<&str> = granted
        .iter()
        .filter(|p| p.starts_with("core:"))
        .map(String::as_str)
        .collect();
    assert_eq!(
        core,
        BTreeSet::from([
            "core:event:allow-emit",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:path:allow-resolve-directory",
            "core:window:allow-close",
            "core:window:allow-internal-toggle-maximize",
            "core:window:allow-is-maximized",
            "core:window:allow-minimize",
            "core:window:allow-start-dragging",
            "core:window:allow-toggle-maximize",
        ])
    );
}

#[test]
fn the_quick_window_is_granted_one_shell_and_a_confirmed_link_and_nothing_else() {
    let quick = capability(QUICK_CAPABILITY);
    assert_eq!(quick["windows"], serde_json::json!(["quick"]));
    assert_eq!(
        permissions_of(&quick),
        BTreeSet::from(
            [
                "allow-link-open",
                "allow-session-create",
                "allow-session-kill",
                "allow-session-resize",
                "allow-session-write",
                "core:event:allow-emit",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "core:window:allow-hide",
            ]
            .map(str::to_owned)
        )
    );
}

#[test]
fn a_window_besides_the_main_one_is_granted_the_sessions_moved_to_it_and_nothing_else() {
    let window = capability(WINDOW_CAPABILITY);
    // One pattern, the label of the windows the app makes (`window-<id>`, `windows.rs`).
    assert_eq!(window["windows"], serde_json::json!(["window-*"]));
    assert_eq!(
        permissions_of(&window),
        BTreeSet::from(
            [
                "allow-session-attach",
                "allow-session-resize",
                "allow-session-write",
                "core:event:allow-emit",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
            ]
            .map(str::to_owned)
        )
    );
}

#[test]
fn only_the_main_window_may_call_what_owns_or_changes_the_workspace() {
    // The state and the files of the app, and the commands that make, close and fill the other
    // windows: the main window owns the workspace and is the only page that writes `state.json`.
    let owner_only = [
        "state_load",
        "state_save",
        "state_quarantine",
        "config_load",
        "config_save",
        "config_watch",
        "theme_save",
        "bench_save",
        "scrollback_save",
        "scrollback_delete",
        "profiles_set_user",
        "sessions_keep_set",
        "window_open",
        "window_close",
        "window_move_tab",
        // The web view of a browser pane shown by a window is opened, moved and closed by the main
        // window, with the bounds the page of that window sends it (NOR-F15-04e).
        "browser_open",
        "browser_navigate",
        "browser_set_bounds",
        "browser_close",
    ];
    let main = permissions_of(&capability(MAIN_CAPABILITY));
    let quick = permissions_of(&capability(QUICK_CAPABILITY));
    let window = permissions_of(&capability(WINDOW_CAPABILITY));
    for command in owner_only {
        assert!(main.contains(&permission(command)), "main lacks {command}");
        assert!(
            !quick.contains(&permission(command)),
            "quick may call {command}"
        );
        assert!(
            !window.contains(&permission(command)),
            "a window may call {command}"
        );
    }
    // A window is given the sessions that are already running, never the power to start or end one:
    // the quick window starts its own shell, and the main window starts the rest.
    for command in ["session_create", "session_kill", "session_reattach"] {
        assert!(
            !window.contains(&permission(command)),
            "a window may call {command}"
        );
    }
}

#[test]
fn no_capability_uses_a_default_set_a_wildcard_or_a_remote_origin() {
    for text in [MAIN_CAPABILITY, QUICK_CAPABILITY, WINDOW_CAPABILITY] {
        let capability = capability(text);
        for permission in permissions_of(&capability) {
            assert!(!permission.ends_with(":default"), "{permission}");
            assert!(!permission.contains('*'), "{permission}");
            // A permission is a command the page may call or a core permission; the plugins that
            // the Rust side uses (notification, global shortcut, deep link) get none.
            assert!(
                permission.starts_with("allow-") || permission.starts_with("core:"),
                "{permission}"
            );
        }
        assert!(
            capability.get("remote").is_none(),
            "no remote origin may call a command"
        );
        assert!(capability.get("webviews").is_none());
    }
    // Only the three capabilities exist.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .expect("capabilities folder")
        .filter_map(|entry| Some(entry.ok()?.file_name().to_str()?.to_owned()))
        .collect();
    files.sort();
    assert_eq!(files, ["default.json", "quick.json", "window.json"]);
}

#[test]
fn the_web_view_of_a_browser_pane_is_granted_nothing() {
    // A web view of a pane is a child of `main`, so a capability for the window `main` reaches it by
    // the window. What keeps its page out is the origin: a page that is not the app's is a remote
    // origin, and only a capability with a `remote` entry can grant that. None has one (the test
    // above), the web view has no name in any file, and the commands that make one are the only
    // ones of the pane (a page cannot open another). The one pattern in any file is the label of the
    // windows the app makes, `window-*`, which no web view of a pane can have: its label starts with
    // `browser-` and the id of a pane cannot change that.
    for text in [MAIN_CAPABILITY, QUICK_CAPABILITY, WINDOW_CAPABILITY] {
        let capability = capability(text);
        for window in capability["windows"].as_array().expect("windows") {
            let window = window.as_str().expect("a window label");
            assert!(
                !crate::browser_pane::is_pane_label(window),
                "{window} names a web view of a browser pane"
            );
            if window.contains('*') {
                assert_eq!(window, "window-*", "the one pattern a capability may have");
                let prefix = window.trim_end_matches('*');
                assert_eq!(prefix, crate::windows::LABEL_PREFIX);
                for id in ["p1", "window-x", "", "main"] {
                    let pane = crate::browser_pane::pane_label(id).unwrap_or_default();
                    assert!(!pane.starts_with(prefix), "{pane} matches {window}");
                }
            }
        }
        assert!(capability.get("webviews").is_none());
        assert!(capability.get("remote").is_none());
    }
    let quick = permissions_of(&capability(QUICK_CAPABILITY));
    for command in [
        "browser_open",
        "browser_navigate",
        "browser_set_bounds",
        "browser_close",
    ] {
        assert!(
            !quick.contains(&permission(command)),
            "the quick window may call {command}"
        );
    }
    let tauri_conf: Value = serde_json::from_str(TAURI_CONF).expect("tauri.conf.json");
    let windows = tauri_conf["app"]["windows"].as_array().expect("windows");
    assert_eq!(
        windows.len(),
        1,
        "the web views of panes are made at run time, not declared"
    );
    assert_eq!(windows[0]["label"], "main");
}

fn csp() -> serde_json::Map<String, Value> {
    let conf: Value = serde_json::from_str(TAURI_CONF).expect("tauri.conf.json");
    conf["app"]["security"]["csp"]
        .as_object()
        .expect("the CSP is a map of directives, not null")
        .clone()
}

fn sources(csp: &serde_json::Map<String, Value>, directive: &str) -> Vec<String> {
    csp.get(directive)
        .unwrap_or_else(|| panic!("the CSP has no {directive}"))
        .as_str()
        .expect("a directive is a string")
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_content_security_policy_is_strict() {
    let csp = csp();
    assert_eq!(sources(&csp, "default-src"), ["'none'"]);
    assert_eq!(sources(&csp, "script-src"), ["'self'"]);
    // Inline styles are the one relaxation: the mods are style elements written at run time and the
    // terminal library writes its own. Scripts never are (above), and nothing loads from the network.
    assert_eq!(sources(&csp, "style-src"), ["'self'", "'unsafe-inline'"]);
    assert_eq!(sources(&csp, "img-src"), ["'self'", "blob:"]);
    assert_eq!(sources(&csp, "font-src"), ["'self'"]);
    assert_eq!(
        sources(&csp, "connect-src"),
        ["ipc:", "http://ipc.localhost"]
    );
    for directive in [
        "object-src",
        "base-uri",
        "form-action",
        "frame-src",
        "worker-src",
        "media-src",
        "manifest-src",
    ] {
        assert_eq!(sources(&csp, directive), ["'none'"], "{directive}");
    }
    for (directive, value) in &csp {
        let value = value.as_str().expect("string");
        assert!(!value.contains("unsafe-eval"), "{directive}");
        assert!(!value.contains("wasm-unsafe-eval"), "{directive}");
        assert!(!value.contains('*'), "{directive}");
        assert!(!value.contains("data:"), "{directive}");
        assert!(!value.contains("https:"), "{directive}");
        if directive != "style-src" {
            assert!(!value.contains("unsafe-inline"), "{directive}");
        }
    }
}

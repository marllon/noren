//! Smoke mode (`noren --smoke`): proves the real app can start, load the interface and run a
//! real shell session through the same code path as the `session_create` command.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use noren_core::{
    BackgroundStore, CONFIG_FILE_NAME, ConfigStore, MODS_DIR_NAME, ModStore, SCROLLBACK_DIR_NAME,
    ScrollbackStore, SessionId, StateStore, THEMES_DIR_NAME, ThemeStore, WindowEffect,
    is_powershell,
};
use serde_json::{Value, json};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::bridge::{
    self, AppState, BackgroundState, ConfigState, ModState, STATE_FILE_NAME, ScrollbackState,
    ThemeState,
};
use crate::deeplink::{self, Links};
use crate::quick;
use crate::shortcut;
use crate::window_effect;

pub const SMOKE_FLAG: &str = "--smoke";
/// Text the smoke session must print on a line of its own.
pub const SMOKE_MARKER: &str = "noren-smoke-ok";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Characters of output quoted in the failure message.
const TAIL_CHARS: usize = 400;

/// Whether the main window is shown at startup. The smoke run keeps it hidden so it never takes
/// the focus (it would drop a full-screen game); every normal start shows it.
pub fn should_show_window(smoke: bool) -> bool {
    !smoke
}

/// Fails unless the `main` window exists and is hidden.
pub(crate) fn check_window_hidden(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window does not exist".to_string())?;
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    window_hidden_result(visible)
}

/// Fails when the app holds a global shortcut: no smoke run registers one (it would take a key
/// from the programs of whoever runs it). The plugin is asked, not only our own books. The page
/// of the main window does ask for the shortcut of the quick terminal at boot; this run refuses.
pub(crate) fn check_no_global_shortcut(app: &AppHandle) -> Result<(), String> {
    let held = shortcut::registered(app);
    if held != 0 {
        return Err(format!(
            "this run holds {held} global shortcut(s), expected none"
        ));
    }
    let refused = app.state::<shortcut::QuickShortcut>().refused();
    print_line(&format!(
        "SMOKE global shortcut none registered ({refused} requests refused)"
    ));
    Ok(())
}

/// The effect the smoke run asks the hidden window for: Mica on Windows, vibrancy on macOS, and
/// none where the system has no effect to ask for.
pub fn smoke_effect() -> WindowEffect {
    if cfg!(windows) {
        WindowEffect::Mica
    } else if cfg!(target_os = "macos") {
        WindowEffect::Vibrancy
    } else {
        WindowEffect::None
    }
}

/// Gives the hidden main window [`smoke_effect`] and prints what it has afterwards: the effect
/// applied, or the opaque fallback with the reason. A system that cannot paint the effect is not a
/// failure (the window stays opaque); the check fails only when the window cannot be reached.
fn check_window_effect(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window does not exist".to_string())?;
    // No scheme: the smoke run leaves the mode of the window as the system has it.
    let outcome = window_effect::apply_on_main_thread(&window, smoke_effect(), None)?;
    print_line(&format!("SMOKE {}", outcome.log_line()));
    Ok(())
}

/// Lists the monospaced fonts of the machine (the same call as the `fonts_list_monospace` command)
/// and prints how many families there are. It only reads the system font folders; a machine with
/// none (a server) is not a failure, since the terminal falls back to the generic monospace font.
fn check_fonts() {
    let families = noren_core::list_monospace_families();
    print_line(&format!(
        "SMOKE fonts {} monospaced families",
        families.len()
    ));
}

/// Saves, reads and removes a scrollback snapshot in a folder of its own in the temp folder, with the
/// same store the app uses. The folder of the user is never written: the run only reads it (the
/// `scrollback_load` command), and this proves the write path works without touching it.
fn check_scrollback() -> Result<(), String> {
    check_scrollback_in(&std::env::temp_dir())?;
    print_line("SMOKE scrollback round trip ok");
    Ok(())
}

/// The round trip of [`check_scrollback`] in a new folder inside `base`, which is removed after it.
fn check_scrollback_in(base: &std::path::Path) -> Result<(), String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let dir = base.join(format!("noren-smoke-scrollback-{}-{nanos}", process::id()));
    let result = scrollback_round_trip(&ScrollbackStore::new(dir.join(SCROLLBACK_DIR_NAME)));
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn scrollback_round_trip(store: &ScrollbackStore) -> Result<(), String> {
    let text = "\x1b[2msmoke\x1b[0m\nscrollback";
    store
        .save("smoke-pane", text)
        .map_err(|e| format!("scrollback save: {e}"))?;
    let back = store
        .load("smoke-pane")
        .map_err(|e| format!("scrollback load: {e}"))?;
    if back.as_deref() != Some(text) {
        return Err(format!("scrollback came back as {back:?}"));
    }
    store
        .delete("smoke-pane")
        .map_err(|e| format!("scrollback delete: {e}"))?;
    match store.load("smoke-pane") {
        Ok(None) => Ok(()),
        other => Err(format!(
            "scrollback was still there after delete: {other:?}"
        )),
    }
}

fn window_hidden_result(visible: bool) -> Result<(), String> {
    if visible {
        Err("the main window is visible; the smoke run must keep it hidden".to_string())
    } else {
        Ok(())
    }
}

/// Prints `line` to stdout and flushes it so a parent process sees it before we exit.
pub(crate) fn print_line(line: &str) {
    let mut out = std::io::stdout().lock();
    // A closed stdout must not turn the smoke check into a panic.
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Removes terminal escape sequences (CSI, OSC, DCS and the like) from `text`.
pub fn strip_ansi(text: &str) -> String {
    strip(text, false)
}

/// Like [`strip_ansi`], and the sequences that move the cursor to another row (a position, up or
/// down) leave a line break where they were: a terminal that was resized repaints the screen by
/// moving the cursor, not by printing line breaks, and the text on both sides would run together.
fn strip_with_row_breaks(text: &str) -> String {
    strip(text, true)
}

fn strip(text: &str, row_moves_break: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, ended by a byte in 0x40..=0x7e.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        if row_moves_break && matches!(c, 'H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'd') {
                            out.push('\n');
                        }
                        break;
                    }
                }
            }
            // OSC: ended by BEL or ST (ESC \).
            Some(']') => skip_string(&mut chars, true),
            // DCS, SOS, PM, APC: ended by ST.
            Some('P' | 'X' | '^' | '_') => skip_string(&mut chars, false),
            // Character set selection takes one more character.
            Some('(' | ')' | '*' | '+' | '#') => {
                chars.next();
            }
            // Any other two-character sequence.
            _ => {}
        }
    }
    out
}

/// Skips a string sequence up to its terminator (ST, and BEL when `bel_ends`).
fn skip_string(chars: &mut std::str::Chars<'_>, bel_ends: bool) {
    while let Some(c) = chars.next() {
        if bel_ends && c == '\x07' {
            return;
        }
        if c == '\x1b' {
            // ST is ESC followed by a backslash; any other escape also ends the string.
            let _ = chars.next();
            return;
        }
    }
}

/// True when some line of `output`, once escape sequences are removed and the line is trimmed,
/// is exactly [`SMOKE_MARKER`]. The echoed command (`echo noren-smoke-ok`) is a different line
/// and does not count.
pub fn has_marker_line(output: &[u8]) -> bool {
    has_line(output, SMOKE_MARKER)
}

/// True when some line of `output`, once escape sequences are removed and the line is trimmed, is
/// exactly `marker`.
fn has_line(output: &[u8], marker: &str) -> bool {
    let text = strip_ansi(&String::from_utf8_lossy(output));
    text.split(['\n', '\r']).any(|line| line.trim() == marker)
}

/// [`has_line`] for output a terminal repainted after a resize: a cursor move to another row counts
/// as a line break, and the text is also read as it was printed, in case a repaint moved the cursor
/// inside the marker. The echoed command is never the marker alone, so it still does not count.
fn has_line_after_repaint(output: &[u8], marker: &str) -> bool {
    let text = strip_with_row_breaks(&String::from_utf8_lossy(output));
    has_line(output, marker) || text.split(['\n', '\r']).any(|line| line.trim() == marker)
}

/// The last `TAIL_CHARS` characters of the visible output, for failure messages.
fn visible_tail(output: &[u8]) -> String {
    let text = strip_ansi(&String::from_utf8_lossy(output));
    let skip = text.chars().count().saturating_sub(TAIL_CHARS);
    text.chars().skip(skip).collect()
}

/// Reports a failure, ends every session and exits with code 1.
fn fail(app: &AppHandle, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    app.state::<AppState>().sessions.shutdown();
    process::exit(1);
}

/// Opens a session of the default profile through [`bridge::create_session`], types the marker
/// command and waits until the marker shows up on a line of its own. A PowerShell session must
/// also have loaded the shell integration script (its first prompt carries `OSC 133;A`), which
/// proves the script was found in the resource folder. Always releases the session.
fn check_session(app: &AppHandle, deadline: Instant) -> Result<(), String> {
    check_integration_files(app)?;
    let state = app.state::<AppState>();
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let output = Channel::new(move |body| {
        if let InvokeResponseBody::Raw(bytes) = body {
            // The receiver is gone once the check ended; late output is of no interest.
            let _ = tx.send(bytes);
        }
        Ok(())
    });
    let (id, profile) = bridge::create_session(app, &state, None, None, None, 120, 30, output)?;
    print_line(&format!(
        "SMOKE session {id} started with profile {profile}"
    ));

    let result = wait_for_marker(&state, SessionId(id), &rx, deadline);
    let _ = state.sessions.kill(SessionId(id));
    let seen = result?;
    let integrated = state
        .find_profile(Some(&profile))
        .is_ok_and(|p| p.inject_integration && is_powershell(&p.program));
    if integrated && !contains_bytes(&seen, PROMPT_START_MARK) {
        return Err(format!(
            "the {profile} session printed no OSC 133;A: the shell integration script was not loaded (looked in {:?})",
            bridge::integration_dir(app)
        ));
    }
    Ok(())
}

/// Every file of the shell integration that the bundle must carry, relative to the integration
/// folder. The zsh ones start with a dot, which a resource pattern could leave out.
const INTEGRATION_FILES: [&str; 6] = [
    "noren.ps1",
    "noren.bash",
    "zsh/.zshenv",
    "zsh/.zprofile",
    "zsh/.zshrc",
    "zsh/noren.zsh",
];

/// Fails when the resource folder lacks one of [`INTEGRATION_FILES`], which is how a build that
/// dropped a script (for any shell, not only the one this machine runs) is caught.
fn check_integration_files(app: &AppHandle) -> Result<(), String> {
    let dir = bridge::integration_dir(app)
        .ok_or_else(|| "the shell integration folder is missing from the resources".to_owned())?;
    for file in INTEGRATION_FILES {
        if !dir.join(file).is_file() {
            return Err(format!(
                "the shell integration file {file} is missing from {dir:?}"
            ));
        }
    }
    Ok(())
}

/// The sequence the integration script writes at the start of every prompt (`OSC 133;A`).
const PROMPT_START_MARK: &[u8] = b"\x1b]133;A\x07";

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn wait_for_marker(
    state: &AppState,
    id: SessionId,
    rx: &mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    state
        .sessions
        .write(id, format!("echo {SMOKE_MARKER}\r").as_bytes())
        .map_err(|e| e.to_string())?;

    let mut seen: Vec<u8> = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(bytes) => {
                seen.extend_from_slice(&bytes);
                if has_marker_line(&seen) {
                    return Ok(seen);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "{SMOKE_MARKER} not found in the session output within {}s; output ended with {:?}",
                    SMOKE_TIMEOUT.as_secs(),
                    visible_tail(&seen)
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "the session ended before printing {SMOKE_MARKER}; output ended with {:?}",
                    visible_tail(&seen)
                ));
            }
        }
    }
}

/// Smoke mode: wait for the interface to emit `app-ready`, then run a real shell session of the
/// default profile, report `SMOKE OK noren-smoke-ok` and quit with 0. Anything that does not
/// finish within `SMOKE_TIMEOUT` ends the process with an error and code 1.
pub fn arm(app: &tauri::App) {
    let started = Instant::now();
    let ready = Arc::new(AtomicBool::new(false));

    let handle = app.handle().clone();
    let listener_ready = Arc::clone(&ready);
    app.listen("app-ready", move |_event| {
        // Only the first signal starts the session check.
        if listener_ready.swap(true, Ordering::SeqCst) {
            return;
        }
        print_line("SMOKE app-ready received");
        let handle = handle.clone();
        thread::spawn(move || {
            // The effect goes on the hidden window, and the check that it stayed hidden comes after.
            let result = check_session(&handle, started + SMOKE_TIMEOUT)
                .and_then(|()| check_window_effect(&handle))
                .inspect(|()| check_fonts())
                .and_then(|()| check_scrollback())
                .and_then(|()| check_no_global_shortcut(&handle))
                .and_then(|()| check_window_hidden(&handle));
            match result {
                Ok(()) => {
                    print_line("SMOKE window hidden");
                    print_line(&format!("SMOKE OK {SMOKE_MARKER}"));
                    handle.exit(0);
                }
                Err(message) => fail(&handle, &message),
            }
        });
    });

    let handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(SMOKE_TIMEOUT);
        if !ready.load(Ordering::SeqCst) {
            fail(
                &handle,
                &format!("app-ready not received within {}s", SMOKE_TIMEOUT.as_secs()),
            );
        }
    });
}

/// What the deep-link smoke run was asked to prove, and the folder that holds its own state.
#[derive(Clone, Debug)]
pub struct DeepLinkTarget {
    /// The raw link given after `--smoke-deeplink`.
    pub url: String,
    /// The folder the link names, decoded.
    pub folder: String,
    /// A fresh folder for `state.json`, so the user's real file is neither read nor written.
    pub state_dir: PathBuf,
}

impl DeepLinkTarget {
    /// Deletes the state folder this run made (only that one).
    pub fn remove_state_dir(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

/// A folder name in the temp folder that no earlier run used.
fn fresh_state_dir() -> PathBuf {
    fresh_dir("noren-smoke-deeplink")
}

/// A folder name that starts with `prefix` in the temp folder, that no earlier run used.
pub(crate) fn fresh_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", process::id()))
}

/// Reads the arguments of `--smoke-deeplink <link>`: the link must look like a `noren://` link and
/// name a folder, which is what the run checks.
pub fn deeplink_target(args: &[String]) -> Result<DeepLinkTarget, String> {
    let url = deeplink::smoke_deeplink_arg(args).ok_or_else(|| {
        format!(
            "{} needs a noren:// link after it",
            deeplink::SMOKE_DEEPLINK_FLAG
        )
    })?;
    if !deeplink::looks_like_link(&url) {
        return Err(format!("{url:?} is not a noren:// link"));
    }
    let folder = deeplink::folder_of_link(&url)
        .ok_or_else(|| format!("the link {url:?} has no usable path parameter to check"))?;
    Ok(DeepLinkTarget {
        url,
        folder,
        state_dir: fresh_state_dir(),
    })
}

/// Every file of the app for a smoke run that must not touch the files of the user, kept in one
/// folder of its own: the saved state (empty), the settings, the themes, the scrollback snapshots,
/// the mods and the pictures of a background (relative paths are inside the folder).
pub struct SandboxStores {
    pub state: StateStore,
    pub config: ConfigStore,
    pub themes: ThemeStore,
    pub scrollback: ScrollbackStore,
    pub mods: ModStore,
    pub background: BackgroundStore,
}

/// The stores of a smoke run that lives in `dir` (the files are made there, on demand).
pub fn sandbox_stores(dir: &Path) -> SandboxStores {
    SandboxStores {
        state: StateStore::new(dir.join(STATE_FILE_NAME)),
        config: ConfigStore::new(dir.join(CONFIG_FILE_NAME)),
        themes: ThemeStore::new(dir.join(THEMES_DIR_NAME)),
        scrollback: ScrollbackStore::new(dir.join(SCROLLBACK_DIR_NAME)),
        mods: ModStore::new(dir.join(MODS_DIR_NAME)),
        background: BackgroundStore::new(dir.to_path_buf()),
    }
}

/// Hands the app the stores of [`sandbox_stores`], so nothing of the user is read, watched or
/// written by a run that changes the workspace (the interface saves it) or that the user's files
/// do not belong in. The mods are not watched: watching would create the folder.
pub fn manage_sandbox_stores(app: &tauri::App, dir: &Path) {
    let stores = sandbox_stores(dir);
    app.manage(stores.state);
    app.manage(ConfigState::new(stores.config));
    app.manage(ThemeState::new(stores.themes));
    app.manage(ScrollbackState::new(stores.scrollback));
    app.manage(ModState::new(stores.mods).without_watching());
    app.manage(BackgroundState::new(stores.background));
}

/// Compares the folder the interface reports for the active space with the one in the link, by
/// the same rules the interface uses to pick a space for a link.
fn check_reported_folder(expected: &str, reported: Option<&str>) -> Result<(), String> {
    match reported {
        None => Err("the interface reported no folder for the active space".to_string()),
        Some(folder) if deeplink::same_folder(folder, expected) => Ok(()),
        Some(folder) => Err(format!(
            "the active space has the folder {folder:?}, expected {expected:?}"
        )),
    }
}

/// Like [`fail`], and removes the state folder of the run first.
fn fail_deeplink(app: &AppHandle, target: &DeepLinkTarget, message: &str) -> ! {
    target.remove_state_dir();
    fail(app, message)
}

/// Deep-link smoke mode (`noren --smoke-deeplink <link>`): the link goes the way a link from the
/// system goes on a first start (the command line, then the interface asks for it), the interface
/// applies it and reports the folder of the space it shows, and that folder must be the link's.
/// Then the same checks as `--smoke` (a real shell session, the window still hidden) and
/// `SMOKE DEEPLINK OK`, exit 0. Anything else within `SMOKE_TIMEOUT` ends with code 1.
pub fn arm_deeplink(app: &tauri::App, target: DeepLinkTarget) {
    let started = Instant::now();
    let ready = Arc::new(AtomicBool::new(false));

    let (tx, rx) = mpsc::channel::<Option<String>>();
    app.state::<Links>().watch_reports(tx);

    let listener_ready = Arc::clone(&ready);
    app.listen("app-ready", move |_event| {
        if !listener_ready.swap(true, Ordering::SeqCst) {
            print_line("SMOKE app-ready received");
        }
    });

    let handle = app.handle().clone();
    thread::spawn(move || {
        let remaining = (started + SMOKE_TIMEOUT).saturating_duration_since(Instant::now());
        let reported = match rx.recv_timeout(remaining) {
            Ok(folder) => folder,
            Err(_) => {
                let seen = if ready.load(Ordering::SeqCst) {
                    "the interface started but never reported the link as applied"
                } else {
                    "app-ready not received"
                };
                fail_deeplink(
                    &handle,
                    &target,
                    &format!("{seen} within {}s", SMOKE_TIMEOUT.as_secs()),
                );
            }
        };
        let result = check_reported_folder(&target.folder, reported.as_deref())
            .inspect(|()| {
                print_line(&format!(
                    "SMOKE link applied, active folder {}",
                    target.folder
                ))
            })
            .and_then(|()| check_session(&handle, started + SMOKE_TIMEOUT))
            .and_then(|()| check_no_global_shortcut(&handle))
            .and_then(|()| check_window_hidden(&handle));
        match result {
            Ok(()) => {
                print_line("SMOKE window hidden");
                print_line(&format!("SMOKE DEEPLINK OK {}", target.url));
                handle.exit(0);
            }
            Err(message) => fail_deeplink(&handle, &target, &message),
        }
    });
}

pub const SMOKE_QUICK_FLAG: &str = "--smoke-quick";

/// The quick run opens two pages and a shell, one after the other, so it gets longer than the rest.
const SMOKE_QUICK_TIMEOUT: Duration = Duration::from_secs(60);
/// Lines the quick run has the shell print, before and after the promotion.
const QUICK_BEFORE: &str = "noren-quick-before";
const QUICK_AFTER: &str = "noren-quick-after";
/// How much of the output of the shell the run keeps to look for those lines in.
const QUICK_TAIL_BYTES: usize = 16 * 1024;
/// How far from the top of the usable area of the screen the quick window may be found, in pixels
/// (the system may shift a frameless window by the width of its invisible border).
const TOP_TOLERANCE: i32 = 16;

/// Whether `--smoke-quick` is among the arguments (the first one is the program).
pub fn has_smoke_quick_flag(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == SMOKE_QUICK_FLAG)
}

/// The folder the quick run keeps the files of the app in. The run promotes a shell into a new tab
/// of the main window, and the interface saves what it shows: with the files of the user that
/// would add a tab to their workspace, so the run has a folder of its own, removed when it ends.
#[derive(Clone, Debug)]
pub struct QuickSandbox {
    pub state_dir: PathBuf,
}

impl QuickSandbox {
    pub fn new() -> Self {
        Self {
            state_dir: fresh_dir("noren-smoke-quick"),
        }
    }

    /// Deletes the folder this run made (only that one).
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

impl Default for QuickSandbox {
    fn default() -> Self {
        Self::new()
    }
}

/// An event the quick run listens to: its name and its payload (`null` when it has none).
type Heard = (String, Value);

/// The events the quick run heard, kept until something waits for them: the pages do not report in
/// the order the run waits, so an event that comes early must not be lost.
struct Inbox {
    rx: Receiver<Heard>,
    kept: Vec<Heard>,
}

impl Inbox {
    /// Waits until an event called `name` has a payload `accept` takes, and returns what it took.
    /// Other events stay for later waits.
    fn wait<T>(
        &mut self,
        name: &str,
        what: &str,
        deadline: Instant,
        accept: impl Fn(&Value) -> Option<T>,
    ) -> Result<T, String> {
        loop {
            let found = self
                .kept
                .iter()
                .enumerate()
                .find_map(|(at, (heard, payload))| {
                    (heard == name)
                        .then(|| accept(payload))
                        .flatten()
                        .map(|value| (at, value))
                });
            if let Some((at, value)) = found {
                self.kept.remove(at);
                return Ok(value);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(remaining) {
                Ok(heard) => self.kept.push(heard),
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!("{what} not received within the time of the run"));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(format!("the run stopped listening before {what}"));
                }
            }
        }
    }

    /// Whether an event called `name` with a payload `accept` takes has been heard so far.
    fn saw(&mut self, name: &str, accept: impl Fn(&Value) -> bool) -> bool {
        self.kept.extend(self.rx.try_iter());
        self.kept
            .iter()
            .any(|(heard, payload)| heard == name && accept(payload))
    }
}

/// What the main window answered to the promotion of session `id`: `Ok` when it made the tab, the
/// reason it gave when it did not, and `None` when the answer is about another session.
fn promoted_verdict(payload: &Value, id: u64) -> Option<Result<(), String>> {
    if payload.get("id").and_then(Value::as_u64) != Some(id) {
        return None;
    }
    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
        return Some(Ok(()));
    }
    let reason = payload
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("no reason given");
    Some(Err(reason.to_owned()))
}

/// Waits until the output the route handed to its current channel has a line that is `marker`.
fn wait_for_route_line(
    route: &crate::route::OutputRoute,
    marker: &str,
    when: &str,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        let tail = route.tail();
        if has_line_after_repaint(&tail, marker) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            let raw = &tail[tail.len().saturating_sub(TAIL_CHARS)..];
            return Err(format!(
                "{marker} not found {when}; the output ended with {:?}, raw {:?}",
                visible_tail(&tail),
                String::from_utf8_lossy(raw)
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Fails unless the quick window exists, is hidden, has no frame and sits against the top of the
/// usable area of the main screen (when the machine has one).
fn check_quick_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(quick::QUICK_LABEL)
        .ok_or_else(|| "the quick window does not exist".to_string())?;
    if window.is_visible().map_err(|e| e.to_string())? {
        return Err("the quick window is visible; the smoke run must keep it hidden".to_string());
    }
    if window.is_decorated().map_err(|e| e.to_string())? {
        return Err("the quick window has a frame".to_string());
    }
    if !window.is_always_on_top().map_err(|e| e.to_string())? {
        return Err("the quick window is not always on top".to_string());
    }
    let mut place = "no screen to place it on".to_string();
    if let Some(monitor) = window.primary_monitor().map_err(|e| e.to_string())? {
        let top = monitor.work_area().position.y;
        let at = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        if (at.y - top).abs() > TOP_TOLERANCE {
            return Err(format!(
                "the quick window is at y={}, not against the top of the screen (y={top})",
                at.y
            ));
        }
        place = format!("at {},{} {}x{}", at.x, at.y, size.width, size.height);
    }
    print_line(&format!(
        "SMOKE quick window hidden, frameless, always on top, {place}"
    ));
    Ok(())
}

/// The whole quick run, from the two pages being ready to the end: a shell opened in the quick
/// window is promoted to the main one, and it must be the same session and the same process.
fn run_quick(app: &AppHandle, inbox: &mut Inbox, deadline: Instant) -> Result<u64, String> {
    inbox.wait("app-ready", "app-ready", deadline, |_| Some(()))?;
    print_line("SMOKE app-ready received");
    inbox.wait(quick::READY_EVENT, "quick-ready", deadline, |_| Some(()))?;
    print_line("SMOKE quick page ready");
    check_quick_window(app)?;
    check_window_hidden(app)?;

    app.emit(quick::OPEN_EVENT, ())
        .map_err(|e| format!("could not ask the quick window for a shell: {e}"))?;
    let id = inbox.wait(quick::SESSION_EVENT, "quick-session", deadline, |payload| {
        payload.get("id").and_then(Value::as_u64)
    })?;
    print_line(&format!("SMOKE session {id} opened in the quick window"));

    let state = app.state::<AppState>();
    let route = state
        .route(id)
        .ok_or_else(|| format!("session {id} has no route for its output"))?;
    if route.channels() != 1 {
        return Err(format!(
            "session {id} had {} channels before the promotion, expected 1",
            route.channels()
        ));
    }
    route.record_tail(QUICK_TAIL_BYTES);
    let write = |marker: &str| {
        state
            .sessions
            .write(SessionId(id), format!("echo {marker}\r").as_bytes())
            .map_err(|e| format!("could not write to session {id}: {e}"))
    };
    write(QUICK_BEFORE)?;
    wait_for_route_line(&route, QUICK_BEFORE, "before the promotion", deadline)?;
    let sessions = state.sessions.session_count();
    let threads = state.sessions.live_threads();

    app.emit(quick::PROMOTE_EVENT, json!({ "id": id }))
        .map_err(|e| format!("could not ask for the promotion: {e}"))?;
    inbox
        .wait(
            quick::PROMOTED_EVENT,
            "quick-promoted",
            deadline,
            |payload| promoted_verdict(payload, id),
        )?
        .map_err(|reason| format!("the main window did not take session {id}: {reason}"))?;
    print_line(&format!("SMOKE session {id} promoted to the main window"));

    // The same session: the same route and wiring, moved once, nothing started or ended.
    let same = state.route(id).is_some_and(|now| Arc::ptr_eq(&now, &route));
    if !same {
        return Err(format!(
            "session {id} was replaced by another during the promotion"
        ));
    }
    if route.channels() != 2 {
        return Err(format!(
            "the output of session {id} moved {} times, expected once",
            route.channels() - 1
        ));
    }
    if state.sessions.session_count() != sessions || state.sessions.live_threads() != threads {
        return Err(format!(
            "the promotion changed the sessions: {sessions} sessions and {threads} threads before, {} and {} after",
            state.sessions.session_count(),
            state.sessions.live_threads()
        ));
    }
    let ended = inbox.saw(bridge::SESSION_EXIT_EVENT, |payload| {
        payload.get("id").and_then(Value::as_u64) == Some(id)
    });
    if ended {
        return Err(format!("session {id} ended during the promotion"));
    }
    // Alive, and what it prints now reaches the main window (the route cleared what the old
    // channel had received when it moved).
    write(QUICK_AFTER)?;
    wait_for_route_line(&route, QUICK_AFTER, "after the promotion", deadline)?;
    print_line(&format!(
        "SMOKE session {id} still alive after the promotion, {} chunks of its output reached the main window",
        route.delivered()
    ));

    check_quick_window(app)?;
    check_no_global_shortcut(app)?;
    check_window_hidden(app)?;
    Ok(id)
}

/// Like [`fail`], and removes the folder of the run, last: the page of the main window may still
/// save its state while the sessions end, and that would put the folder back.
fn fail_quick(app: &AppHandle, sandbox: &QuickSandbox, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    app.state::<AppState>().sessions.shutdown();
    sandbox.remove();
    process::exit(1);
}

/// Quick smoke mode (`noren --smoke-quick`): the quick window is made hidden and loads its page,
/// that page opens a shell, the main window takes that shell over as a tab (`quick-promote`), and
/// the run checks it is the same session (same id, same route, nothing started or ended) and that
/// it still answers, with its output now reaching the main window. Both windows must stay hidden.
/// Then `SMOKE QUICK OK` and exit 0; anything else within `SMOKE_QUICK_TIMEOUT` ends with code 1.
pub fn arm_quick(app: &tauri::App, sandbox: QuickSandbox) {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Heard>();
    for name in [
        "app-ready",
        quick::READY_EVENT,
        quick::SESSION_EVENT,
        quick::PROMOTED_EVENT,
        bridge::SESSION_EXIT_EVENT,
    ] {
        let tx = tx.clone();
        app.listen(name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            // The run is over once the receiver is gone; late events are of no interest.
            let _ = tx.send((name.to_owned(), payload));
        });
    }

    let handle = app.handle().clone();
    thread::spawn(move || {
        let mut inbox = Inbox {
            rx,
            kept: Vec::new(),
        };
        match run_quick(&handle, &mut inbox, started + SMOKE_QUICK_TIMEOUT) {
            Ok(id) => {
                print_line("SMOKE window hidden");
                print_line(&format!("SMOKE QUICK OK session {id}"));
                handle.exit(0);
            }
            Err(message) => fail_quick(&handle, &sandbox, &message),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_deeplink_target_reads_the_link_and_its_folder() {
        let list = args(&[
            "noren.exe",
            "--smoke-deeplink",
            "noren://open?path=C%3A%5CTemp%5Cnoren%20smoke",
        ]);
        let target = deeplink_target(&list).unwrap();
        assert_eq!(target.folder, "C:\\Temp\\noren smoke");
        assert_eq!(target.url, "noren://open?path=C%3A%5CTemp%5Cnoren%20smoke");
        assert!(target.state_dir.starts_with(std::env::temp_dir()));
        assert!(!target.state_dir.exists());
    }

    #[test]
    fn the_deeplink_target_refuses_what_it_cannot_check() {
        assert!(deeplink_target(&args(&["noren.exe", "--smoke-deeplink"])).is_err());
        assert!(deeplink_target(&args(&["noren.exe", "--smoke-deeplink", "--smoke"])).is_err());
        assert!(
            deeplink_target(&args(&["noren.exe", "--smoke-deeplink", "https://x.dev"])).is_err()
        );
        assert!(
            deeplink_target(&args(&["noren.exe", "--smoke-deeplink", "noren://open"])).is_err()
        );
    }

    #[test]
    fn each_deeplink_run_has_its_own_state_folder() {
        let list = args(&["noren.exe", "--smoke-deeplink", "noren://open?path=%2Fsrv"]);
        let first = deeplink_target(&list).unwrap();
        let second = deeplink_target(&list).unwrap();
        assert_ne!(first.state_dir, second.state_dir);
        let stores = sandbox_stores(&first.state_dir);
        assert_eq!(stores.state.path(), first.state_dir.join("state.json"));
        // The settings file is kept apart too, so the user's real one is neither read nor watched.
        assert_eq!(stores.config.path(), first.state_dir.join("config.jsonc"));
        // And the themes folder.
        assert_eq!(stores.themes.dir(), first.state_dir.join("themes"));
        // And the mods folder.
        assert_eq!(stores.mods.dir(), first.state_dir.join("mods"));
        // And the scrollback snapshots.
        assert_eq!(stores.scrollback.dir(), first.state_dir.join("scrollback"));
    }

    #[test]
    fn each_quick_run_has_its_own_folder_in_the_temp_folder() {
        let first = QuickSandbox::new();
        let second = QuickSandbox::new();
        assert_ne!(first.state_dir, second.state_dir);
        assert!(first.state_dir.starts_with(std::env::temp_dir()));
        assert!(!first.state_dir.exists());
        // Removing a folder that was never made is harmless, and it only touches that folder.
        std::fs::create_dir_all(&first.state_dir).unwrap();
        std::fs::write(first.state_dir.join("state.json"), b"{}").unwrap();
        first.remove();
        assert!(!first.state_dir.exists());
        first.remove();
    }

    #[test]
    fn the_quick_flag_is_found_among_the_arguments() {
        assert!(has_smoke_quick_flag(&args(&["noren.exe", "--smoke-quick"])));
        assert!(!has_smoke_quick_flag(&args(&["noren.exe", "--smoke"])));
        // The first argument is the program, whatever it is called.
        assert!(!has_smoke_quick_flag(&args(&["--smoke-quick"])));
    }

    #[test]
    fn a_line_is_found_by_its_own_marker_only() {
        let out = b"PS> echo noren-quick-after\r\n\x1b[32mnoren-quick-after\x1b[0m\r\nPS> ";
        assert!(has_line(out, "noren-quick-after"));
        assert!(!has_line(out, "noren-quick-before"));
        assert!(!has_line(
            b"PS> echo noren-quick-after\r\n",
            "noren-quick-after"
        ));
    }

    #[test]
    fn a_repaint_after_a_resize_does_not_hide_the_line_it_ran_together() {
        // What the real shell sent after the main window resized it: the typed command, a move of
        // the cursor to another row, the output.
        let repainted = b"\x1b[8;46;132t\x1b]633;E;echo noren-quick-after\x07\x1b[93mecho \x1b[37mnoren-quick-after\x1b[4;1H\x1b]133;C\x07\x1b[mnoren-quick-after\r\n\x1b]133;D;0\x07PS> ";
        assert!(!has_line(repainted, "noren-quick-after"));
        assert!(has_line_after_repaint(repainted, "noren-quick-after"));
        // The command typed and not run is still not the output.
        let typed = b"PS> \x1b[93mecho \x1b[37mnoren-quick-after\x1b[4;1H";
        assert!(!has_line_after_repaint(typed, "noren-quick-after"));
        assert!(!has_line_after_repaint(
            b"PS> echo noren-quick-after",
            "noren-quick-after"
        ));
        // A cursor move inside the printed text does not split it.
        assert!(has_line_after_repaint(
            b"\r\nnoren-quick-\x1b[4;13Hafter\r\n",
            "noren-quick-after"
        ));
        // Plain output still works.
        assert!(has_line_after_repaint(
            b"echo noren-quick-after\r\nnoren-quick-after\r\n",
            "noren-quick-after"
        ));
    }

    #[test]
    fn the_promoted_answer_is_read_for_the_session_and_its_verdict() {
        assert_eq!(
            promoted_verdict(&json!({"id": 4, "ok": true, "itemId": "x"}), 4),
            Some(Ok(()))
        );
        assert_eq!(
            promoted_verdict(&json!({"id": 4, "ok": false, "reason": "no tab"}), 4),
            Some(Err("no tab".to_string()))
        );
        // Another session's answer is not this one's.
        assert_eq!(promoted_verdict(&json!({"id": 5, "ok": true}), 4), None);
        assert_eq!(promoted_verdict(&json!(null), 4), None);
        assert_eq!(
            promoted_verdict(&json!({"id": 4}), 4),
            Some(Err("no reason given".to_string()))
        );
    }

    #[test]
    fn the_scrollback_check_writes_only_inside_the_folder_it_is_given_and_cleans_up() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let base = std::env::temp_dir().join(format!("noren-smoke-test-{}-{nanos}", process::id()));
        std::fs::create_dir_all(&base).unwrap();
        check_scrollback_in(&base).expect("the round trip works");
        assert_eq!(
            std::fs::read_dir(&base).unwrap().count(),
            0,
            "the check left something behind"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_reported_folder_must_match_the_link() {
        assert!(check_reported_folder("C:\\Temp\\a b", Some("c:/temp/a b/")).is_ok());
        assert!(check_reported_folder("/srv/proj", Some("/srv/proj")).is_ok());
        let wrong = check_reported_folder("/srv/proj", Some("/srv/other")).unwrap_err();
        assert!(wrong.contains("/srv/other") && wrong.contains("/srv/proj"));
        assert!(check_reported_folder("/srv/proj", None).is_err());
    }

    #[test]
    fn removing_the_state_folder_only_touches_that_folder() {
        let list = args(&["noren.exe", "--smoke-deeplink", "noren://open?path=%2Fsrv"]);
        let target = deeplink_target(&list).unwrap();
        std::fs::create_dir_all(&target.state_dir).unwrap();
        std::fs::write(target.state_dir.join("state.json"), b"{}").unwrap();
        target.remove_state_dir();
        assert!(!target.state_dir.exists());
        // Removing it again is harmless.
        target.remove_state_dir();
    }

    #[test]
    fn only_the_smoke_run_keeps_the_window_hidden() {
        assert!(!should_show_window(true));
        assert!(should_show_window(false));
    }

    #[test]
    fn a_visible_window_fails_the_smoke_check() {
        assert!(window_hidden_result(false).is_ok());
        let message = window_hidden_result(true).unwrap_err();
        assert!(message.contains("visible"));
    }

    #[test]
    fn strips_csi_osc_and_charset_sequences() {
        let raw =
            "\x1b[?25l\x1b[1;32mhello\x1b[0m\x1b]0;title\x07 \x1b]7;file:///c\x1b\\world\x1b(B";
        assert_eq!(strip_ansi(raw), "hello world");
    }

    #[test]
    fn finds_the_marker_with_ansi_around_it() {
        let out =
            b"\x1b[2J\x1b[Hnoren$ echo noren-smoke-ok\r\n\x1b[32mnoren-smoke-ok\x1b[0m\r\nnoren$ ";
        assert!(has_marker_line(out));
    }

    #[test]
    fn the_echoed_command_alone_does_not_count() {
        let out = b"PS C:\\> echo noren-smoke-ok\r\n";
        assert!(!has_marker_line(out));
        let colored = b"PS C:\\> \x1b[93mecho\x1b[m \x1b[37mnoren-smoke-ok\x1b[m";
        assert!(!has_marker_line(colored));
    }

    #[test]
    fn handles_crlf_and_padding() {
        assert!(has_marker_line(
            b"echo noren-smoke-ok\r\n  noren-smoke-ok  \r\n"
        ));
        assert!(has_marker_line(b"echo noren-smoke-ok\r\nnoren-smoke-ok\r"));
        assert!(has_marker_line(b"noren-smoke-ok"));
    }

    #[test]
    fn missing_line_is_not_found() {
        assert!(!has_marker_line(b""));
        assert!(!has_marker_line(
            b"noren-smoke-ok-not\r\nxnoren-smoke-ok\r\n"
        ));
        assert!(!has_marker_line(b"noren-smoke\r\nok\r\n"));
    }

    #[test]
    fn marker_split_across_batches_is_found_once_joined() {
        let mut seen = b"echo noren-smoke-ok\r\nnoren-sm".to_vec();
        assert!(!has_marker_line(&seen));
        seen.extend_from_slice(b"oke-ok\r\n");
        assert!(has_marker_line(&seen));
    }

    #[test]
    fn invalid_utf8_does_not_panic() {
        assert!(has_marker_line(b"\xff\xfe\r\nnoren-smoke-ok\r\n"));
    }
}

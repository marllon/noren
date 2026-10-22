//! A picture of the real window (`noren --smoke-shot <png>`, NOR-F20-05, D22 item 1).
//!
//! Nothing visual had been seen in the real app: the pure parts were tested and the computed styles
//! were read in a browser, but how the window looks in the web view of the app was never looked at.
//! This mode makes the main window draw its page and writes the PNG of it, without the window ever
//! being on a monitor of whoever runs it, with the focus, or on the taskbar or in Alt+Tab (no key and
//! no mouse input is sent either):
//!
//! 1. the run keeps the files of the app in a folder of its own, like every smoke mode (the state of
//!    the person is neither read nor written); `--settings <file>` is copied there as `config.jsonc`
//!    before the app starts, `--live-settings <file>` is written there once the page is up (the way
//!    the settings screen writes it: the app watches the file and applies it at once) and
//!    `--image <file>` goes to `backgrounds/<name>`, so a picture and a see-through window can be
//!    asked for;
//! 2. before anything starts, the mode refuses to run while the signal of game mode exists
//!    (`D:/Projetos/.modo-jogo`; `NOREN_MODO_JOGO_ARQUIVO` points it elsewhere for the tests),
//!    whatever its age: the person is playing, and even a window out of sight costs a game a frame;
//! 3. the windows of `tauri.conf.json` are created for this run without asking for the focus and
//!    not focusable (see [`smoke_focus::quiet_windows`]): a window that is hidden can still become the foreground
//!    window of the system while the app starts, which was measured here (the foreground window was
//!    the hidden main window about 100 ms after the program started, in roughly one run in five),
//!    and the interface inside asks for the focus of its page when it starts;
//! 4. from the first instruction of the program a thread looks at the foreground window of the
//!    system (read only, `GetForegroundWindow`) every few milliseconds and keeps the first look that
//!    finds a window of this program there, with when it was ([`Watch`], shared with every smoke mode in `smoke_focus.rs`);
//! 5. when the page says `app-ready`, the window (hidden) is taken off the taskbar and out of Alt+Tab
//!    (`WS_EX_TOOLWINDOW`, `WS_EX_NOACTIVATE`), disabled (it takes no focus from anything, not even the
//!    web view asking for the focus of its page), moved to the right of the union of every monitor, and
//!    only when its rectangle is proved to touch none of them it is shown with `SW_SHOWNOACTIVATE`.
//!    `set_focus` is never called;
//! 6. the picture comes from the web view itself: `Page.captureScreenshot` through
//!    `ICoreWebView2::CallDevToolsProtocolMethod`, a call inside the process. No debugging port is
//!    opened and nothing captures the desktop, so the picture holds what the page paints and not what
//!    is behind the window (the Mica of the system, the desktop through a see-through window). A
//!    picture asked for with `--image` that is not on screen is a failure, after the PNG is written;
//! 7. the run checks and prints that the window never had the focus of the system (no look of
//!    [`Watch`] found a window of this program in front), lies outside every monitor, is out of the
//!    taskbar and Alt+Tab, is disabled, and that the foreground window just before the window was
//!    shown is the one after the picture, and fails if not. Then the window is hidden again, the daemon
//!    of the run stops and the app quits. Anything that takes longer than [`TIMEOUT`] ends the
//!    process with code 1.
//!
//! Only Windows has a web view that can be asked for the picture (WebView2); elsewhere the mode
//! says so and fails. `scripts/shot.mjs` (`pnpm shot`) builds the app and runs this mode for a
//! default window and for one with a picture behind it and a see-through interface.

use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::config::CONFIG_FILE_NAME;
use serde_json::{Value, json};
use tauri::{AppHandle, Listener, Manager};

use crate::bridge::AppState;
use crate::lifecycle::MAIN_LABEL;
use crate::smoke::{
    Heard, Inbox, check_daemon_stopped, check_no_global_shortcut, fresh_dir, print_line,
};
use crate::smoke_focus::{self, Watch};

pub const SMOKE_SHOT_FLAG: &str = "--smoke-shot";
const SETTINGS_FLAG: &str = "--settings";
const LIVE_SETTINGS_FLAG: &str = "--live-settings";
const IMAGE_FLAG: &str = "--image";

/// The whole run, from the start of the program to the app quitting, has this long.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Longest one call to the web view may take.
const CALL: Duration = Duration::from_secs(20);
/// Longest the page may take to be ready once the window is shown.
const PAGE_WAIT: Duration = Duration::from_secs(30);
/// Pause between two looks at the page while it comes up.
const POLL: Duration = Duration::from_millis(250);
/// After the page is up: the first prompt of the shell and the picture are drawn in this time.
const SETTLE: Duration = Duration::from_millis(2500);
/// The exit code of a run that was refused because the person is playing.
pub const REFUSED_EXIT_CODE: i32 = 3;

/// Where the signal of game mode is (the contract is in `D:/Projetos/_modo-jogo/LEIA-ME.md`).
pub const GAME_MODE_SIGNAL: &str = "D:/Projetos/.modo-jogo";
/// The variable that points the signal elsewhere, for the tests (`scripts/game-mode.mjs` has the same).
pub const GAME_MODE_ENV: &str = "NOREN_MODO_JOGO_ARQUIVO";

/// A PNG smaller than this holds nothing the page painted (a window of one flat color compresses to
/// a few hundred bytes; the interface with a sidebar and a terminal does not).
const BLANK_BELOW: usize = 3000;

// The extended styles that keep the window out of the taskbar and Alt+Tab and make it never take the
// focus. The values are the ones of winuser.h; a test on Windows holds them equal to the crate's.
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
const WS_EX_APPWINDOW: u32 = 0x0004_0000;

/// The gap between the right edge of the last monitor and the window, in pixels.
const MARGIN: i32 = 64;

/// Whether `--smoke-shot` is among the arguments (the first one is the program).
pub fn has_flag(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == SMOKE_SHOT_FLAG)
}

// ---- the arguments and the refusal ---------------------------------------------------------------

/// What the run was asked: the file to write and, optionally, the settings and the picture of the
/// background the window is to have. `settings` is there when the app starts, as a settings file the
/// person wrote before opening it; `live_settings` is written when the page is up, as the settings
/// screen writes the file of a running app, and the app applies it at once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShotArgs {
    pub out: PathBuf,
    pub settings: Option<PathBuf>,
    pub live_settings: Option<PathBuf>,
    pub image: Option<PathBuf>,
}

/// Reads `--smoke-shot <png> [--settings <file>] [--live-settings <file>] [--image <file>]`.
pub fn parse_args(args: &[String]) -> Result<ShotArgs, String> {
    let at = args
        .iter()
        .skip(1)
        .position(|arg| arg == SMOKE_SHOT_FLAG)
        .map(|at| at + 2)
        .ok_or_else(|| format!("{SMOKE_SHOT_FLAG} is not among the arguments"))?;
    let mut rest = args[at..].iter();
    let out = rest
        .next()
        .filter(|arg| !arg.starts_with("--"))
        .ok_or_else(|| format!("{SMOKE_SHOT_FLAG} needs the path of the PNG to write after it"))?;
    if !out.to_lowercase().ends_with(".png") {
        return Err(format!("{out:?} is not a .png file"));
    }
    let mut parsed = ShotArgs {
        out: PathBuf::from(out),
        settings: None,
        live_settings: None,
        image: None,
    };
    while let Some(flag) = rest.next() {
        let slot = match flag.as_str() {
            SETTINGS_FLAG => &mut parsed.settings,
            LIVE_SETTINGS_FLAG => &mut parsed.live_settings,
            IMAGE_FLAG => &mut parsed.image,
            other => {
                return Err(format!(
                    "unknown argument {other:?} after {SMOKE_SHOT_FLAG}"
                ));
            }
        };
        let value = rest
            .next()
            .ok_or_else(|| format!("{flag} needs a file after it"))?;
        if slot.replace(PathBuf::from(value)).is_some() {
            return Err(format!("{flag} was given twice"));
        }
    }
    Ok(parsed)
}

/// The file the signal of game mode is: the one the variable names (when it is not empty), else the
/// real one.
pub fn signal_path(custom: Option<&str>) -> PathBuf {
    match custom {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(GAME_MODE_SIGNAL),
    }
}

/// Whether the signal file is there, of any age. A file that cannot be looked at for another reason
/// than being absent counts as there: the run only goes ahead when it knows the person is not playing.
fn signal_present(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// The sentence that refuses the run, or `None` when the signal is not there. Unlike the readers of
/// the other scripts, which take a signal older than 60 s for a watcher that stopped, this one
/// refuses at any age: a window that draws, even out of sight, is not worth a dropped frame.
pub fn refusal(signal: &Path) -> Option<String> {
    signal_present(signal).then(|| {
        format!(
            "game mode is on ({} exists, whatever its age): {SMOKE_SHOT_FLAG} does not run while the person is playing",
            signal.display()
        )
    })
}

/// Why the run did not start: the person is playing, or the arguments or the folder are wrong.
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Refused(String),
    Failed(String),
}

impl StartError {
    /// The code the program exits with.
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Refused(_) => REFUSED_EXIT_CODE,
            Self::Failed(_) => 1,
        }
    }

    /// The line the program prints on stderr.
    pub fn line(&self) -> String {
        match self {
            Self::Refused(message) => format!("SMOKE SHOT REFUSED: {message}"),
            Self::Failed(message) => format!("SMOKE FAILED: {message}"),
        }
    }
}

/// The run as the program starts it: the signal is the one of [`signal_path`].
pub fn start(args: &[String]) -> Result<ShotRun, StartError> {
    let custom = std::env::var(GAME_MODE_ENV).ok();
    start_with(args, &signal_path(custom.as_deref()))
}

/// Like [`start`], with the signal named. The signal is looked at first: nothing is read, made or
/// copied while the person is playing.
pub fn start_with(args: &[String], signal: &Path) -> Result<ShotRun, StartError> {
    if let Some(message) = refusal(signal) {
        return Err(StartError::Refused(message));
    }
    let parsed = parse_args(args).map_err(StartError::Failed)?;
    ShotRun::prepare(parsed).map_err(StartError::Failed)
}

// ---- the folder of the run ------------------------------------------------------------------------

/// The run: what it was asked, the folder it keeps the files of the app in and the window that was
/// in front of the others when the program started.
#[derive(Clone, Debug)]
pub struct ShotRun {
    pub args: ShotArgs,
    /// The files of the app for this run. The page of the main window saves the workspace it makes, and
    /// the state, the settings and the token of the person must not be touched by a run that is not
    /// about them.
    pub state_dir: PathBuf,
    /// The window in front of the others when the program started (0 when none).
    pub foreground_before: isize,
    /// The text of `live_settings`, read when the run was made so a file that is missing is told at once.
    pub live_text: Option<String>,
    /// The looks at the foreground window, from the first moment of the program.
    pub watch: Watch,
}

impl ShotRun {
    /// Makes the folder of the run with the settings and the picture it was given.
    pub fn prepare(args: ShotArgs) -> Result<Self, String> {
        let watch = smoke_focus::begin();
        let foreground_before = platform::foreground();
        let state_dir = fresh_dir("noren-smoke-shot");
        let live_text = match &args.live_settings {
            Some(file) => Some(
                std::fs::read_to_string(file)
                    .map_err(|e| format!("could not read the settings {}: {e}", file.display()))?,
            ),
            None => None,
        };
        let run = Self {
            args,
            state_dir,
            foreground_before,
            live_text,
            watch,
        };
        if let Err(message) = run.fill_folder() {
            run.remove();
            return Err(message);
        }
        Ok(run)
    }

    fn fill_folder(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.state_dir)
            .map_err(|e| format!("could not make {}: {e}", self.state_dir.display()))?;
        if let Some(settings) = &self.args.settings {
            std::fs::copy(settings, self.state_dir.join(CONFIG_FILE_NAME))
                .map_err(|e| format!("could not read the settings {}: {e}", settings.display()))?;
        }
        if let Some(image) = &self.args.image {
            let name = image
                .file_name()
                .ok_or_else(|| format!("{} is not a file", image.display()))?;
            let folder = self.state_dir.join("backgrounds");
            std::fs::create_dir_all(&folder)
                .map_err(|e| format!("could not make {}: {e}", folder.display()))?;
            std::fs::copy(image, folder.join(name))
                .map_err(|e| format!("could not read the picture {}: {e}", image.display()))?;
        }
        Ok(())
    }

    /// Deletes the folder this run made (only that one).
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }

    /// Whether the run was given a picture to put behind the window.
    fn wants_picture(&self) -> bool {
        self.args.image.is_some()
    }

    /// Writes the settings of `--live-settings` as the file of the app, which is running: the app
    /// watches the file and applies what it says at once, with no restart.
    fn apply_live_settings(&self) -> Result<bool, String> {
        let Some(text) = &self.live_text else {
            return Ok(false);
        };
        let file = self.state_dir.join(CONFIG_FILE_NAME);
        std::fs::write(&file, text)
            .map_err(|e| format!("could not write the settings {}: {e}", file.display()))?;
        Ok(true)
    }
}

// ---- the window the run is made with ----------------------------------------------------------------

// ---- where the window goes ------------------------------------------------------------------------

/// A rectangle on the virtual screen, in pixels: where a monitor or the window is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// Whether the two share at least one pixel. Rectangles that only touch along an edge do not.
    pub fn intersects(&self, other: &Rect) -> bool {
        i64::from(self.x) < other.right()
            && i64::from(other.x) < self.right()
            && i64::from(self.y) < other.bottom()
            && i64::from(other.y) < self.bottom()
    }
}

/// The smallest rectangle that holds every monitor, or `None` when there is none.
pub fn union_bounds(monitors: &[Rect]) -> Option<Rect> {
    let left = monitors.iter().map(|m| i64::from(m.x)).min()?;
    let top = monitors.iter().map(|m| i64::from(m.y)).min()?;
    let right = monitors.iter().map(Rect::right).max()?;
    let bottom = monitors.iter().map(Rect::bottom).max()?;
    Some(Rect {
        x: i32::try_from(left).ok()?,
        y: i32::try_from(top).ok()?,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
    })
}

/// Whether the window touches no monitor at all (not one pixel of it can be on a screen).
pub fn outside_all(window: Rect, monitors: &[Rect]) -> bool {
    !monitors.iter().any(|monitor| window.intersects(monitor))
}

/// The top-left corner that puts a window of `size` to the right of every monitor, [`MARGIN`] pixels
/// past the last one and level with the top of the highest. `None` when there is no monitor to
/// put it away from (nothing could prove it is out of sight) or the corner does not fit.
pub fn place_outside(monitors: &[Rect], size: (u32, u32)) -> Option<(i32, i32)> {
    let bounds = union_bounds(monitors)?;
    let x = i32::try_from(bounds.right() + i64::from(MARGIN)).ok()?;
    // The window must fit in the coordinates of the system with room to spare.
    i32::try_from(i64::from(x) + i64::from(size.0)).ok()?;
    Some((x, bounds.y))
}

// ---- what is checked of the window ----------------------------------------------------------------

/// What the run looked at on the window after the picture was taken.
///
/// "The focus" here is the one of the system: the foreground window, the one that gets the keys and
/// that a game in full screen gives way to. A web view calls `SetFocus` on its own page when the
/// page focuses a field, and that moves the focus inside the input queue of the window (the
/// `is_focused` of Tauri turns true) without making the window the foreground one of the system, so
/// that is not what is held to "never". It is printed, apart, by [`run`].
#[derive(Clone, Debug)]
pub struct Facts {
    /// Where the window is.
    pub window: Rect,
    /// Where the monitors are.
    pub monitors: Vec<Rect>,
    /// The extended style of the window.
    pub ex_style: u32,
    /// Whether the window is enabled: an enabled window can be given the focus.
    pub window_enabled: bool,
    /// What the foreground window of the system was, when at any look from before the window was
    /// shown to after the picture it belonged to this program (the first such look).
    pub foreground_ours: Option<String>,
    /// The foreground window of the system just before the window of the run was shown and when
    /// the picture was taken. (The one at the start of the program is not the one compared: for a
    /// moment after the program that ran before it ended, the system itself is still choosing
    /// which window is in front. What this run must not do, take the front itself, is what the
    /// looks of [`Watch`] hold it to from the first instruction.)
    pub foreground_before: isize,
    pub foreground_after: isize,
}

/// The first thing the run promised that does not hold, as a sentence; `Ok` when all hold.
pub fn verdict(facts: &Facts) -> Result<(), String> {
    if let Some(window) = &facts.foreground_ours {
        return Err(format!(
            "a window of this program was the foreground window of the system ({window}); the run must never take the focus"
        ));
    }
    if facts.foreground_after != facts.foreground_before {
        return Err(format!(
            "the foreground window changed during the run: {:#x} before, {:#x} after",
            facts.foreground_before, facts.foreground_after
        ));
    }
    if !outside_all(facts.window, &facts.monitors) {
        return Err(format!(
            "the window of the run, at {:?}, is on a monitor; it must lie outside all of them",
            facts.window
        ));
    }
    let missing = (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & !facts.ex_style;
    if missing != 0 {
        return Err(format!(
            "the window of the run lacks the style {missing:#x} that keeps it out of Alt+Tab and out of the focus"
        ));
    }
    if facts.ex_style & WS_EX_APPWINDOW != 0 {
        return Err("the window of the run asks to be on the taskbar (WS_EX_APPWINDOW)".to_owned());
    }
    if facts.window_enabled {
        return Err(
            "the window of the run is enabled, so something could still give it the focus"
                .to_owned(),
        );
    }
    Ok(())
}

// ---- the picture ------------------------------------------------------------------------------------

/// The bytes a base64 text stands for (the alphabet of RFC 4648, padding and line breaks allowed).
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits = 0u32;
    let mut held = 0u32;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' => continue,
            other => return Err(format!("{:?} is not a base64 character", other as char)),
        };
        bits = (bits << 6) | u32::from(value);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    Ok(out)
}

/// The width and height a PNG says it has, or `None` when the bytes are not the start of a PNG.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let number =
        |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    Some((number(16), number(20)))
}

/// The PNG inside the answer of `Page.captureScreenshot` (`{ "data": "<base64>" }`), checked to be a
/// PNG with something in it.
fn png_of_answer(answer: &str) -> Result<Vec<u8>, String> {
    let value: Value = serde_json::from_str(answer)
        .map_err(|e| format!("the web view answered something that is not JSON: {e}"))?;
    let data = value
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("the web view's answer has no picture: {answer}"))?;
    let bytes = decode_base64(data)?;
    let (width, height) =
        png_size(&bytes).ok_or_else(|| "the picture of the web view is not a PNG".to_owned())?;
    if width == 0 || height == 0 {
        return Err(format!("the picture has no area ({width}x{height})"));
    }
    if bytes.len() < BLANK_BELOW {
        return Err(format!(
            "the picture is {} bytes for {width}x{height} pixels: the page painted nothing",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// What the page says about itself when asked (the JSON it returns as text).
const PROBE: &str = r#"(async () => {
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const root = document.querySelector(".app");
  const notice = document.querySelector('[data-nr-part="background-notice"]');
  return JSON.stringify({
    ready: document.readyState,
    picture: root ? root.getAttribute("data-nr-picture") : null,
    notice: notice ? notice.textContent : null,
    variable: root ? getComputedStyle(root).getPropertyValue("--nr-background-image").slice(0, 40) : null,
    terminals: document.querySelectorAll(".xterm").length,
    width: window.innerWidth,
    height: window.innerHeight,
  });
})()"#;

/// What the page reported.
#[derive(Debug, PartialEq, Eq)]
struct PageState {
    complete: bool,
    picture: bool,
    /// The sentence of the notice of a picture that cannot be shown, when the page shows one.
    notice: Option<String>,
    /// The start of `--nr-background-image` on the root of the window.
    variable: Option<String>,
    terminals: u64,
    width: u64,
    height: u64,
}

impl PageState {
    /// Whether the page is ready to be looked at: loaded, a terminal drawn and, when a picture was
    /// asked for, the picture on screen.
    fn ready(&self, wants_picture: bool) -> bool {
        self.complete && self.terminals > 0 && (self.picture || !wants_picture)
    }

    /// Whether the page has said all it is going to say about a picture that was asked for: it is on
    /// screen, or the page tells in a notice that it cannot be shown. Waiting longer would change
    /// nothing, and the run takes its picture of the window as it is.
    fn settled(&self, wants_picture: bool) -> bool {
        self.ready(wants_picture)
            || (self.complete && self.terminals > 0 && wants_picture && self.notice.is_some())
    }
}

/// Reads the answer of `Runtime.evaluate` to [`PROBE`].
fn page_state_of(answer: &str) -> Result<PageState, String> {
    let value: Value = serde_json::from_str(answer)
        .map_err(|e| format!("the web view answered something that is not JSON: {e}"))?;
    if let Some(problem) = value.get("exceptionDetails") {
        return Err(format!("the page could not be asked: {problem}"));
    }
    let text = value
        .pointer("/result/value")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("the page gave no answer: {answer}"))?;
    let page: Value = serde_json::from_str(text).map_err(|e| format!("the page's answer: {e}"))?;
    let number = |key: &str| page.get(key).and_then(Value::as_u64).unwrap_or(0);
    let text_of = |key: &str| page.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(PageState {
        complete: page.get("ready").and_then(Value::as_str) == Some("complete"),
        picture: page.get("picture").and_then(Value::as_str) == Some("shown"),
        notice: text_of("notice"),
        variable: text_of("variable"),
        terminals: number("terminals"),
        width: number("width"),
        height: number("height"),
    })
}

// ---- the system -----------------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::WebviewWindow;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, SW_HIDE,
        SW_SHOWNOACTIVATE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SetWindowLongPtrW, SetWindowPos, ShowWindow, WS_EX_APPWINDOW, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };
    use windows::core::HSTRING;

    use super::Rect;

    fn handle(hwnd: isize) -> HWND {
        HWND(hwnd as *mut c_void)
    }

    /// The window in front of the others (read only), 0 when there is none.
    pub fn foreground() -> isize {
        // SAFETY: a read of the state of the system, with no argument.
        unsafe { GetForegroundWindow() }.0 as isize
    }

    /// The system handle of the window.
    pub fn hwnd_of(window: &WebviewWindow) -> Result<isize, String> {
        window
            .hwnd()
            .map(|hwnd| hwnd.0 as isize)
            .map_err(|e| format!("the window has no handle: {e}"))
    }

    /// Takes the window off the taskbar and out of Alt+Tab, and makes it a window the system never
    /// activates. Done while it is hidden.
    pub fn detach(window: &WebviewWindow, hwnd: isize) -> Result<(), String> {
        window
            .set_skip_taskbar(true)
            .map_err(|e| format!("could not keep the window off the taskbar: {e}"))?;
        let hwnd = handle(hwnd);
        // SAFETY: `hwnd` is the handle of a window of this process; the calls change its style and
        // ask the system to redraw its frame, without moving, sizing, ordering or activating it.
        let framed = unsafe {
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let wanted = (current | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
        };
        framed.map_err(|e| format!("could not change the style of the window: {e}"))?;
        // A disabled window takes no focus and no activation, from the person or from the web view
        // inside it (which asks for the focus of its page): that is what keeps it from ever becoming
        // the foreground window of the system, which the style alone (it only stops the activation
        // that a click or the system's own order would give) does not. Done while it is hidden.
        // SAFETY: `hwnd` is the handle of a window of this process.
        let _ = unsafe { EnableWindow(hwnd, false) };
        Ok(())
    }

    /// Whether the window is enabled (it takes the focus and input).
    pub fn is_enabled(hwnd: isize) -> bool {
        // SAFETY: a read of a window of this process.
        unsafe { IsWindowEnabled(handle(hwnd)) }.as_bool()
    }

    /// The extended style of the window.
    pub fn ex_style(hwnd: isize) -> u32 {
        // SAFETY: a read of a window of this process.
        unsafe { GetWindowLongPtrW(handle(hwnd), GWL_EXSTYLE) as u32 }
    }

    /// Moves the window to `(x, y)` without sizing, ordering or activating it.
    pub fn move_to(hwnd: isize, x: i32, y: i32) -> Result<(), String> {
        // SAFETY: `hwnd` is the handle of a window of this process.
        let moved = unsafe {
            SetWindowPos(
                handle(hwnd),
                None,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        moved.map_err(|e| format!("could not move the window: {e}"))
    }

    /// Where the window is, as the system has it.
    pub fn rect_of(hwnd: isize) -> Result<Rect, String> {
        let mut rect = RECT::default();
        // SAFETY: `hwnd` is the handle of a window of this process and `rect` is ours to write.
        let read = unsafe { GetWindowRect(handle(hwnd), &mut rect) };
        read.map_err(|e| format!("could not read where the window is: {e}"))?;
        Ok(Rect {
            x: rect.left,
            y: rect.top,
            width: u32::try_from(rect.right - rect.left).unwrap_or(0),
            height: u32::try_from(rect.bottom - rect.top).unwrap_or(0),
        })
    }

    /// Shows the window without activating it (`SW_SHOWNOACTIVATE`).
    pub fn show_no_activate(hwnd: isize) {
        // SAFETY: `hwnd` is the handle of a window of this process.
        let _ = unsafe { ShowWindow(handle(hwnd), SW_SHOWNOACTIVATE) };
    }

    /// Hides the window.
    pub fn hide(hwnd: isize) {
        // SAFETY: `hwnd` is the handle of a window of this process.
        let _ = unsafe { ShowWindow(handle(hwnd), SW_HIDE) };
    }

    /// Calls a method of the DevTools protocol of the web view of `window` (inside the process, no
    /// debugging port) and returns its answer as JSON text.
    pub fn devtools(
        window: &WebviewWindow,
        method: &str,
        params: &str,
        wait: Duration,
    ) -> Result<String, String> {
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let method = HSTRING::from(method);
        let params = HSTRING::from(params);
        window
            .with_webview(move |webview| {
                let call = || -> windows::core::Result<()> {
                    // SAFETY: on the thread of the window, with the controller of its web view.
                    let core = unsafe { webview.controller().CoreWebView2() }?;
                    let done = tx.clone();
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |status, json| {
                            let _ = done.send(status.map(|()| json).map_err(|e| e.to_string()));
                            Ok(())
                        },
                    ));
                    // SAFETY: the strings and the handler live through the call.
                    unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) }
                };
                if let Err(error) = call() {
                    let _ = tx.send(Err(error.to_string()));
                }
            })
            .map_err(|e| format!("could not reach the web view: {e}"))?;
        rx.recv_timeout(wait)
            .map_err(|_| "the web view did not answer in time".to_owned())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_styles_of_the_module_are_the_ones_of_the_system() {
            assert_eq!(super::super::WS_EX_TOOLWINDOW, WS_EX_TOOLWINDOW.0);
            assert_eq!(super::super::WS_EX_NOACTIVATE, WS_EX_NOACTIVATE.0);
            assert_eq!(super::super::WS_EX_APPWINDOW, WS_EX_APPWINDOW.0);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::time::Duration;

    use tauri::WebviewWindow;

    use super::Rect;

    const NOT_WINDOWS: &str =
        "the picture of the window is taken from WebView2, so this mode runs on Windows only";

    pub fn foreground() -> isize {
        0
    }

    pub fn hwnd_of(_window: &WebviewWindow) -> Result<isize, String> {
        Err(NOT_WINDOWS.to_owned())
    }

    pub fn detach(_window: &WebviewWindow, _hwnd: isize) -> Result<(), String> {
        Err(NOT_WINDOWS.to_owned())
    }

    pub fn ex_style(_hwnd: isize) -> u32 {
        0
    }

    pub fn is_enabled(_hwnd: isize) -> bool {
        true
    }

    pub fn move_to(_hwnd: isize, _x: i32, _y: i32) -> Result<(), String> {
        Err(NOT_WINDOWS.to_owned())
    }

    pub fn rect_of(_hwnd: isize) -> Result<Rect, String> {
        Err(NOT_WINDOWS.to_owned())
    }

    pub fn show_no_activate(_hwnd: isize) {}

    pub fn hide(_hwnd: isize) {}

    pub fn devtools(
        _window: &WebviewWindow,
        _method: &str,
        _params: &str,
        _wait: Duration,
    ) -> Result<String, String> {
        Err(NOT_WINDOWS.to_owned())
    }
}

// ---- the run --------------------------------------------------------------------------------------

/// The monitors of the system, as rectangles on the virtual screen.
fn monitors_of(window: &tauri::WebviewWindow) -> Result<Vec<Rect>, String> {
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("could not list the monitors: {e}"))?;
    Ok(monitors
        .iter()
        .map(|monitor| Rect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect())
}

/// Calls `Runtime.evaluate` on [`PROBE`] and reads what the page said.
fn look_at_page(window: &tauri::WebviewWindow) -> Result<PageState, String> {
    let params = json!({ "expression": PROBE, "awaitPromise": true, "returnByValue": true });
    let answer = platform::devtools(window, "Runtime.evaluate", &params.to_string(), CALL)?;
    page_state_of(&answer)
}

/// Looks at the page until it is ready ([`PageState::ready`]) or the time of the run is up.
fn wait_for_page(
    window: &tauri::WebviewWindow,
    wants_picture: bool,
    deadline: Instant,
) -> Result<PageState, String> {
    loop {
        let state = look_at_page(window)?;
        if state.settled(wants_picture) {
            return Ok(state);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the page was not ready within the time of the run: {state:?}"
            ));
        }
        thread::sleep(POLL);
    }
}

/// What the program is doing, told to the looks at the foreground window so one that finds a
/// window of this program in front says when.
mod phase {
    pub const PAGE_UP: &str = "the page was up (the window was still hidden)";
    pub const SHOWING: &str = "the window was being shown";
    pub const PAGE_LOADING: &str = "the page was loading";
    pub const SETTINGS_WRITTEN: &str = "the settings were being applied";
    pub const SETTLING: &str = "the page was settling";
    pub const CAPTURING: &str = "the picture was being taken";
    pub const CHECKING: &str = "the run was checking";
}

/// The checks, in order. The page is up once it says `app-ready`.
fn run(
    app: &AppHandle,
    inbox: &mut Inbox,
    shot: &ShotRun,
    deadline: Instant,
) -> Result<(), String> {
    inbox.wait("app-ready", "app-ready", deadline, |_| Some(()))?;
    shot.watch.phase(phase::PAGE_UP);
    print_line("SMOKE app-ready received");

    let window = app
        .get_webview_window(MAIN_LABEL)
        .ok_or_else(|| "the main window does not exist".to_owned())?;
    let hwnd = platform::hwnd_of(&window)?;
    let monitors = monitors_of(&window)?;
    let size = window
        .outer_size()
        .map_err(|e| format!("could not read the size of the window: {e}"))?;

    // Out of the taskbar, out of Alt+Tab, never activated; then away from every monitor. The window
    // is hidden through all of this, and is shown only when its rectangle is proved to be out.
    platform::detach(&window, hwnd)?;
    let (x, y) = place_outside(&monitors, (size.width, size.height)).ok_or_else(|| {
        format!(
            "there is no place out of sight to put the window ({} monitor(s) reported)",
            monitors.len()
        )
    })?;
    platform::move_to(hwnd, x, y)?;
    let placed = platform::rect_of(hwnd)?;
    if !outside_all(placed, &monitors) {
        return Err(format!(
            "the window would be on a monitor at {placed:?}; it was not shown"
        ));
    }
    print_line(&format!(
        "SMOKE SHOT window placed outside every monitor: window {hwnd:#x} at {placed:?}, {} monitor(s) in {:?}",
        monitors.len(),
        union_bounds(&monitors)
    ));

    // From here until the picture is taken the foreground window of the system is looked at, many
    // times a second: not only at the end, where a window that took the focus and gave it back
    // would go unseen.
    shot.watch.phase(phase::SHOWING);
    let foreground_before = platform::foreground();
    platform::show_no_activate(hwnd);
    shot.watch.phase(phase::PAGE_LOADING);
    // A picture the settings name when the app starts has to be on screen by itself.
    let at_start = shot.wants_picture() && shot.live_text.is_none();
    wait_for_page(
        &window,
        at_start,
        (Instant::now() + PAGE_WAIT).min(deadline),
    )?;
    // Settings written while the app runs are applied at once, as the settings screen's writes are.
    if shot.apply_live_settings()? {
        shot.watch.phase(phase::SETTINGS_WRITTEN);
        print_line("SMOKE SHOT settings written while the app runs");
        wait_for_page(
            &window,
            shot.wants_picture(),
            (Instant::now() + PAGE_WAIT).min(deadline),
        )?;
    }
    // The first prompt of the shell, the picture and the fade of the interface are drawn in this time.
    shot.watch.phase(phase::SETTLING);
    thread::sleep(SETTLE);
    let state = look_at_page(&window)?;
    print_line(&format!(
        "SMOKE SHOT page drawn: {} x {} px, {} terminal(s), picture {}{}",
        state.width,
        state.height,
        state.terminals,
        if state.picture { "shown" } else { "none" },
        state
            .notice
            .as_ref()
            .map_or(String::new(), |notice| format!(", notice {notice:?}"))
    ));

    shot.watch.phase(phase::CAPTURING);
    let params = json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false });
    let answer = platform::devtools(&window, "Page.captureScreenshot", &params.to_string(), CALL)?;
    let png = png_of_answer(&answer)?;

    shot.watch.phase(phase::CHECKING);
    let looks = shot.watch.finish();
    let facts = Facts {
        window: platform::rect_of(hwnd)?,
        monitors,
        ex_style: platform::ex_style(hwnd),
        window_enabled: platform::is_enabled(hwnd),
        foreground_ours: looks.ours.clone(),
        foreground_before,
        foreground_after: platform::foreground(),
    };
    verdict(&facts)?;
    print_line(&format!(
        "SMOKE SHOT window never had the focus of the system: none of {} look(s) at the foreground window found one of this program",
        looks.count
    ));
    smoke_focus::conclude(&looks)?;
    // The focus inside the input queue of the window is the web view's own (it focuses the page).
    // It is told, so a reader knows what the answer of the window to "do you have the focus" is.
    print_line(&format!(
        "SMOKE SHOT focus inside the window's own input queue: {} (not the focus of the system)",
        window.is_focused().unwrap_or(false)
    ));
    print_line("SMOKE SHOT window disabled, so nothing can give it the focus");
    print_line(&format!(
        "SMOKE SHOT window outside every monitor: {:?}",
        facts.window
    ));
    print_line(
        "SMOKE SHOT window out of the taskbar and Alt+Tab (WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE)",
    );
    print_line(&format!(
        "SMOKE SHOT foreground window unchanged: {:#x} before the window was shown and after the picture (at the start of the program: {:#x})",
        facts.foreground_after, shot.foreground_before
    ));

    if let Some(folder) = shot.args.out.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(folder)
            .map_err(|e| format!("could not make {}: {e}", folder.display()))?;
    }
    std::fs::write(&shot.args.out, &png)
        .map_err(|e| format!("could not write {}: {e}", shot.args.out.display()))?;
    let (width, height) = png_size(&png).unwrap_or((0, 0));
    print_line(&format!(
        "SMOKE SHOT wrote {} ({width}x{height} px, {} bytes)",
        shot.args.out.display(),
        png.len()
    ));

    // Nothing of the window stays on the screen of the system, not even out of sight.
    platform::hide(hwnd);
    // The picture is written even then, to be looked at; but a picture that was asked for and is not
    // on screen is a failure of the app that this run is here to find.
    if shot.wants_picture() && !state.picture {
        return Err(format!(
            "the picture asked for is not on screen ({})",
            state
                .notice
                .as_deref()
                .unwrap_or("the page gives no reason")
        ));
    }
    check_no_global_shortcut(app)?;
    check_daemon_stopped(&app.state::<AppState>())
}

/// Like `smoke::fail`, hides the window and removes the folder of the run, last: the page of the
/// main window may still save its state while the sessions end, and that would put the folder back.
fn fail_shot(app: &AppHandle, shot: &ShotRun, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    if let Some(window) = app.get_webview_window(MAIN_LABEL)
        && let Ok(hwnd) = platform::hwnd_of(&window)
    {
        platform::hide(hwnd);
    }
    app.state::<AppState>().sessions.shutdown();
    shot.remove();
    process::exit(1);
}

/// Shot smoke mode (`noren --smoke-shot <png>`): see the top of this file. Then `SMOKE SHOT OK` and
/// exit 0; anything else within [`TIMEOUT`] ends with code 1.
pub fn arm(app: &tauri::App, shot: ShotRun) {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Heard>();
    {
        let tx = tx.clone();
        app.listen("app-ready", move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            // The run is over once the receiver is gone; late events are of no interest.
            let _ = tx.send(("app-ready".to_owned(), payload));
        });
    }

    let handle = app.handle().clone();
    let watched = shot.clone();
    let done = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&done);
    thread::spawn(move || {
        let mut inbox = Inbox {
            rx,
            kept: Vec::new(),
        };
        match run(&handle, &mut inbox, &shot, started + TIMEOUT) {
            Ok(()) => {
                flag.store(true, Ordering::SeqCst);
                print_line("SMOKE SHOT OK");
                handle.exit(0);
            }
            Err(message) => fail_shot(&handle, &shot, &message),
        }
    });

    // The time of the run is up whatever the page is doing.
    let handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(TIMEOUT + Duration::from_secs(5));
        if !done.load(Ordering::SeqCst) {
            fail_shot(
                &handle,
                &watched,
                &format!("the run did not end within {}s", TIMEOUT.as_secs()),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    /// The layouts people have: one monitor, two side by side, one on the left of the main one (so
    /// negative coordinates), one above, and a monitor lower than the other.
    fn layouts() -> Vec<Vec<Rect>> {
        vec![
            vec![rect(0, 0, 1920, 1080)],
            vec![rect(0, 0, 2560, 1440), rect(2560, 0, 1920, 1080)],
            vec![rect(-1920, 0, 1920, 1080), rect(0, 0, 2560, 1440)],
            vec![rect(0, -1080, 1920, 1080), rect(0, 0, 1920, 1080)],
            vec![rect(0, 0, 1920, 1080), rect(1920, 400, 1280, 1024)],
            vec![
                rect(-3840, -200, 3840, 2160),
                rect(0, 0, 3840, 2160),
                rect(3840, 600, 1920, 1080),
            ],
        ]
    }

    #[test]
    fn the_flag_is_found_after_the_program_name_only() {
        assert!(has_flag(&args(&["noren", "--smoke-shot", "a.png"])));
        assert!(!has_flag(&args(&["--smoke-shot"])));
        for other in [
            "--smoke",
            "--smoke-window",
            "--smoke-quick",
            "--smoke-shots",
        ] {
            assert!(!has_flag(&args(&["noren", other])), "{other}");
        }
    }

    #[test]
    fn the_arguments_are_a_png_and_optionally_the_settings_and_the_picture() {
        let plain = parse_args(&args(&["noren", "--smoke-shot", "out/a.png"])).unwrap();
        assert_eq!(plain.out, PathBuf::from("out/a.png"));
        assert_eq!(plain.settings, None);
        assert_eq!(plain.live_settings, None);
        assert_eq!(plain.image, None);
        let full = parse_args(&args(&[
            "noren",
            "--smoke-shot",
            "B.PNG",
            "--image",
            "sky.png",
            "--settings",
            "s.jsonc",
            "--live-settings",
            "l.jsonc",
        ]))
        .unwrap();
        assert_eq!(full.out, PathBuf::from("B.PNG"));
        assert_eq!(full.settings, Some(PathBuf::from("s.jsonc")));
        assert_eq!(full.live_settings, Some(PathBuf::from("l.jsonc")));
        assert_eq!(full.image, Some(PathBuf::from("sky.png")));
    }

    #[test]
    fn arguments_that_do_not_say_what_to_do_are_refused_with_a_reason() {
        let cases: [(&[&str], &str); 7] = [
            (&["noren", "--smoke-shot"], "needs the path of the PNG"),
            (
                &["noren", "--smoke-shot", "--image", "a.png"],
                "needs the path of the PNG",
            ),
            (&["noren", "--smoke-shot", "a.txt"], "not a .png file"),
            (
                &["noren", "--smoke-shot", "a.png", "--image"],
                "needs a file",
            ),
            (
                &["noren", "--smoke-shot", "a.png", "--wat"],
                "unknown argument",
            ),
            (
                &[
                    "noren",
                    "--smoke-shot",
                    "a.png",
                    "--image",
                    "x.png",
                    "--image",
                    "y.png",
                ],
                "given twice",
            ),
            (&["noren", "--smoke"], "not among the arguments"),
        ];
        for (list, reason) in cases {
            let error = parse_args(&args(list)).unwrap_err();
            assert!(error.contains(reason), "{list:?}: {error}");
        }
    }

    #[test]
    fn the_signal_is_the_real_one_unless_the_variable_names_another() {
        assert_eq!(signal_path(None), PathBuf::from(GAME_MODE_SIGNAL));
        assert_eq!(signal_path(Some("")), PathBuf::from(GAME_MODE_SIGNAL));
        assert_eq!(signal_path(Some("x/y")), PathBuf::from("x/y"));
        assert_eq!(GAME_MODE_SIGNAL, "D:/Projetos/.modo-jogo");
        assert_eq!(GAME_MODE_ENV, "NOREN_MODO_JOGO_ARQUIVO");
    }

    #[test]
    fn a_signal_of_any_age_refuses_the_run_and_none_lets_it_go() {
        let folder = fresh_dir("noren-shot-test-signal");
        std::fs::create_dir_all(&folder).unwrap();
        let signal = folder.join("signal");
        assert_eq!(refusal(&signal), None);

        std::fs::write(&signal, "{\"jogo\":\"test\"}").unwrap();
        let message = refusal(&signal).expect("a fresh signal refuses");
        assert!(message.contains("game mode is on"), "{message}");
        assert!(message.contains(&signal.display().to_string()), "{message}");

        // A signal the watcher left behind long ago refuses too: the readers of the other scripts
        // would call it stale after 60 s, this mode does not.
        let long_ago = std::time::SystemTime::now() - Duration::from_secs(3 * 24 * 3600);
        std::fs::File::options()
            .write(true)
            .open(&signal)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        assert!(refusal(&signal).is_some());

        std::fs::remove_file(&signal).unwrap();
        assert_eq!(refusal(&signal), None);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_run_refused_for_the_signal_makes_nothing_and_exits_with_its_own_code() {
        let folder = fresh_dir("noren-shot-test-refused");
        std::fs::create_dir_all(&folder).unwrap();
        let signal = folder.join("signal");
        std::fs::write(&signal, "x").unwrap();
        let out = folder.join("a.png");

        let error = start_with(
            &args(&["noren", "--smoke-shot", out.to_str().unwrap()]),
            &signal,
        )
        .unwrap_err();
        assert!(matches!(error, StartError::Refused(_)), "{error:?}");
        assert_eq!(error.exit_code(), REFUSED_EXIT_CODE);
        assert_ne!(error.exit_code(), 0);
        assert!(
            error
                .line()
                .starts_with("SMOKE SHOT REFUSED: game mode is on")
        );
        // The arguments are not even read: a call that is wrong is refused for the signal first.
        let error = start_with(&args(&["noren", "--smoke-shot"]), &signal).unwrap_err();
        assert!(matches!(error, StartError::Refused(_)), "{error:?}");
        // Only the signal stands in the folder: no sandbox, no picture.
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
        assert!(!out.exists());

        std::fs::remove_file(&signal).unwrap();
        let error = start_with(&args(&["noren", "--smoke-shot"]), &signal).unwrap_err();
        assert!(matches!(error, StartError::Failed(_)), "{error:?}");
        assert_eq!(error.exit_code(), 1);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_run_without_the_signal_gets_a_folder_of_its_own_with_the_settings_and_the_picture() {
        let given = fresh_dir("noren-shot-test-given");
        std::fs::create_dir_all(&given).unwrap();
        let settings = given.join("shot.jsonc");
        let image = given.join("sky.png");
        std::fs::write(&settings, "{ \"appearance\": {} }").unwrap();
        std::fs::write(&image, [0x89, b'P', b'N', b'G']).unwrap();
        let signal = given.join("no-signal-here");

        let run = start_with(
            &args(&[
                "noren",
                "--smoke-shot",
                given.join("out.png").to_str().unwrap(),
                "--settings",
                settings.to_str().unwrap(),
                "--image",
                image.to_str().unwrap(),
            ]),
            &signal,
        )
        .unwrap();
        assert!(run.state_dir.starts_with(std::env::temp_dir()));
        assert_eq!(
            std::fs::read_to_string(run.state_dir.join(CONFIG_FILE_NAME)).unwrap(),
            "{ \"appearance\": {} }"
        );
        assert_eq!(
            std::fs::read(run.state_dir.join("backgrounds").join("sky.png")).unwrap(),
            [0x89, b'P', b'N', b'G']
        );
        assert!(run.wants_picture());
        let other = ShotRun::prepare(ShotArgs {
            out: given.join("o.png"),
            settings: None,
            live_settings: None,
            image: None,
        })
        .unwrap();
        assert_ne!(run.state_dir, other.state_dir);
        assert!(!other.wants_picture());
        assert!(!other.state_dir.join(CONFIG_FILE_NAME).exists());
        run.remove();
        other.remove();
        assert!(!run.state_dir.exists());
        let _ = std::fs::remove_dir_all(&given);
    }

    #[test]
    fn a_settings_file_that_is_missing_stops_the_run_and_leaves_no_folder_behind() {
        let given = fresh_dir("noren-shot-test-missing");
        std::fs::create_dir_all(&given).unwrap();
        let error = ShotRun::prepare(ShotArgs {
            out: given.join("o.png"),
            settings: Some(given.join("nothing.jsonc")),
            live_settings: None,
            image: None,
        })
        .unwrap_err();
        assert!(error.contains("could not read the settings"), "{error}");
        let _ = std::fs::remove_dir_all(&given);
    }

    #[test]
    fn live_settings_are_read_at_once_and_written_only_when_the_run_applies_them() {
        let given = fresh_dir("noren-shot-test-live");
        std::fs::create_dir_all(&given).unwrap();
        let live = given.join("live.jsonc");
        std::fs::write(
            &live,
            "{ \"appearance\": { \"window\": { \"opacity\": 0.7 } } }",
        )
        .unwrap();
        let run = ShotRun::prepare(ShotArgs {
            out: given.join("o.png"),
            settings: None,
            live_settings: Some(live.clone()),
            image: None,
        })
        .unwrap();
        // The app starts with no settings of its own; the file appears when the run says so.
        assert!(!run.state_dir.join(CONFIG_FILE_NAME).exists());
        assert!(run.apply_live_settings().unwrap());
        assert_eq!(
            std::fs::read_to_string(run.state_dir.join(CONFIG_FILE_NAME)).unwrap(),
            "{ \"appearance\": { \"window\": { \"opacity\": 0.7 } } }"
        );
        // A run with none has nothing to write.
        let plain = ShotRun::prepare(ShotArgs {
            out: given.join("o.png"),
            settings: None,
            live_settings: None,
            image: None,
        })
        .unwrap();
        assert!(!plain.apply_live_settings().unwrap());
        assert!(!plain.state_dir.join(CONFIG_FILE_NAME).exists());
        // A file that is not there is told when the run is made, not after the window is shown.
        let error = ShotRun::prepare(ShotArgs {
            out: given.join("o.png"),
            settings: None,
            live_settings: Some(given.join("nothing.jsonc")),
            image: None,
        })
        .unwrap_err();
        assert!(error.contains("could not read the settings"), "{error}");
        run.remove();
        plain.remove();
        let _ = std::fs::remove_dir_all(&given);
    }

    #[test]
    fn a_page_is_settled_when_the_picture_shows_or_says_why_it_cannot() {
        let page =
            |picture: bool, notice: Option<&str>, terminals: u64, complete: bool| PageState {
                complete,
                picture,
                notice: notice.map(str::to_owned),
                variable: None,
                terminals,
                width: 1,
                height: 1,
            };
        // Nothing asked: a loaded page with a terminal is settled.
        assert!(page(false, None, 1, true).settled(false));
        // A picture asked for: on screen, or told to be impossible, and nothing else.
        assert!(page(true, None, 1, true).settled(true));
        assert!(page(false, Some("No backend"), 1, true).settled(true));
        assert!(!page(false, None, 1, true).settled(true));
        // A notice about a picture nobody asked for changes nothing: the page is settled anyway.
        assert!(page(false, Some("x"), 1, true).settled(false));
        // A page that is still loading or has no terminal yet is never settled.
        assert!(!page(true, None, 1, false).settled(true));
        assert!(!page(false, Some("x"), 0, true).settled(true));
        assert!(!page(false, None, 0, true).settled(false));
    }

    #[test]
    fn the_bounds_hold_every_monitor_whatever_the_layout() {
        assert_eq!(union_bounds(&[]), None);
        for layout in layouts() {
            let bounds = union_bounds(&layout).unwrap();
            for monitor in &layout {
                assert!(i64::from(bounds.x) <= i64::from(monitor.x));
                assert!(i64::from(bounds.y) <= i64::from(monitor.y));
                assert!(bounds.right() >= monitor.right());
                assert!(bounds.bottom() >= monitor.bottom());
            }
        }
        assert_eq!(
            union_bounds(&[rect(-1920, 0, 1920, 1080), rect(0, -100, 2560, 1440)]),
            Some(rect(-1920, -100, 4480, 1440))
        );
    }

    #[test]
    fn rectangles_that_only_touch_do_not_intersect_and_overlaps_do() {
        let a = rect(0, 0, 100, 100);
        assert!(a.intersects(&rect(50, 50, 100, 100)));
        assert!(a.intersects(&rect(99, 99, 10, 10)));
        assert!(a.intersects(&rect(10, 10, 5, 5)));
        assert!(!a.intersects(&rect(100, 0, 100, 100)));
        assert!(!a.intersects(&rect(0, 100, 100, 100)));
        assert!(!a.intersects(&rect(-100, 0, 100, 100)));
        assert!(!a.intersects(&rect(500, 500, 10, 10)));
    }

    #[test]
    fn the_window_is_put_wholly_outside_the_union_of_the_monitors_in_every_layout() {
        for layout in layouts() {
            for size in [(1280, 800), (1600, 1000), (3840, 2160), (1, 1)] {
                let (x, y) = place_outside(&layout, size).expect("a place for the window");
                let window = rect(x, y, size.0, size.1);
                assert!(
                    outside_all(window, &layout),
                    "{layout:?} {size:?} -> {window:?}"
                );
                // Wholly out: no corner and no edge touches the bounds of the monitors.
                let bounds = union_bounds(&layout).unwrap();
                assert!(!window.intersects(&bounds), "{layout:?} {size:?}");
                assert!(i64::from(window.x) > bounds.right());
            }
        }
    }

    #[test]
    fn a_window_with_one_pixel_on_a_monitor_is_not_outside() {
        let monitors = [rect(0, 0, 1920, 1080), rect(1920, 0, 1920, 1080)];
        assert!(!outside_all(rect(3839, 1079, 100, 100), &monitors));
        assert!(!outside_all(rect(100, 100, 100, 100), &monitors));
        assert!(!outside_all(rect(-99, -99, 100, 100), &monitors));
        assert!(outside_all(rect(3840, 0, 100, 100), &monitors));
        assert!(outside_all(rect(-100, 0, 100, 100), &monitors));
        assert!(outside_all(rect(0, 1080, 100, 100), &monitors));
        // The gap between two monitors that do not touch is not a monitor either.
        let gap = [rect(0, 0, 1000, 1000), rect(2000, 0, 1000, 1000)];
        assert!(outside_all(rect(1100, 0, 800, 800), &gap));
        assert!(!outside_all(rect(900, 0, 1200, 800), &gap));
    }

    #[test]
    fn without_a_monitor_there_is_nothing_to_hide_from_and_no_place() {
        assert_eq!(place_outside(&[], (1280, 800)), None);
        // A place that does not fit in the coordinates of the system is no place either.
        let far = [rect(i32::MAX - 1000, 0, 900, 900)];
        assert_eq!(place_outside(&far, (1280, 800)), None);
    }

    fn good_facts() -> Facts {
        Facts {
            window: rect(4000, 0, 1280, 800),
            monitors: vec![rect(0, 0, 1920, 1080), rect(1920, 0, 1920, 1080)],
            ex_style: WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            window_enabled: false,
            foreground_ours: None,
            foreground_before: 0x2222,
            foreground_after: 0x2222,
        }
    }

    #[test]
    fn a_window_that_kept_every_promise_passes() {
        assert_eq!(verdict(&good_facts()), Ok(()));
        // No window in front at all, before and after, is the same window.
        let nothing = Facts {
            foreground_before: 0,
            foreground_after: 0,
            ..good_facts()
        };
        assert_eq!(verdict(&nothing), Ok(()));
    }

    #[test]
    fn each_promise_that_is_broken_fails_the_run_with_its_own_sentence() {
        let cases: Vec<(Facts, &str)> = vec![
            (
                Facts {
                    foreground_ours: Some("window 0x1, class \"x\", title \"y\"".to_owned()),
                    ..good_facts()
                },
                "was the foreground window of the system (window 0x1",
            ),
            (
                Facts {
                    foreground_after: 0x3333,
                    ..good_facts()
                },
                "foreground window changed",
            ),
            (
                Facts {
                    foreground_before: 0,
                    ..good_facts()
                },
                "foreground window changed",
            ),
            (
                Facts {
                    window: rect(1900, 0, 1280, 800),
                    ..good_facts()
                },
                "is on a monitor",
            ),
            (
                Facts {
                    ex_style: WS_EX_NOACTIVATE,
                    ..good_facts()
                },
                "lacks the style",
            ),
            (
                Facts {
                    ex_style: WS_EX_TOOLWINDOW,
                    ..good_facts()
                },
                "lacks the style",
            ),
            (
                Facts {
                    window_enabled: true,
                    ..good_facts()
                },
                "is enabled",
            ),
            (
                Facts {
                    ex_style: 0,
                    ..good_facts()
                },
                "lacks the style",
            ),
            (
                Facts {
                    ex_style: WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_APPWINDOW,
                    ..good_facts()
                },
                "taskbar",
            ),
        ];
        for (facts, reason) in cases {
            let error = verdict(&facts).unwrap_err();
            assert!(error.contains(reason), "{facts:?}: {error}");
        }
    }

    #[test]
    fn base64_is_decoded_with_padding_and_line_breaks() {
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        assert_eq!(decode_base64("TW\r\nFu").unwrap(), b"Man");
        assert_eq!(decode_base64("+/8=").unwrap(), [0xfb, 0xff]);
        assert!(
            decode_base64("TW*u")
                .unwrap_err()
                .contains("not a base64 character")
        );
    }

    /// The bytes of a PNG header for a picture of `width` x `height` and `size` bytes in all.
    fn fake_png(width: u32, height: u32, size: usize) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.resize(size, 7);
        bytes
    }

    fn encode_base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for at in 0..4 {
                if at <= chunk.len() {
                    out.push(ALPHABET[((n >> (18 - 6 * at)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[test]
    fn the_size_of_a_png_is_read_from_its_header_and_anything_else_has_none() {
        assert_eq!(png_size(&fake_png(1600, 1000, 40)), Some((1600, 1000)));
        assert_eq!(png_size(&[]), None);
        assert_eq!(png_size(b"not a png at all, not at all, not at all"), None);
        assert_eq!(png_size(&fake_png(1, 1, 20)), None);
    }

    #[test]
    fn the_answer_of_the_screenshot_call_is_a_png_with_something_in_it_or_an_error() {
        let png = fake_png(1280, 800, 20_000);
        let answer = json!({ "data": encode_base64(&png) }).to_string();
        assert_eq!(png_of_answer(&answer).unwrap(), png);

        let blank = json!({ "data": encode_base64(&fake_png(1280, 800, 800)) }).to_string();
        assert!(
            png_of_answer(&blank)
                .unwrap_err()
                .contains("painted nothing")
        );
        let flat = json!({ "data": encode_base64(&fake_png(0, 800, 20_000)) }).to_string();
        assert!(png_of_answer(&flat).unwrap_err().contains("no area"));
        let jpeg = json!({ "data": encode_base64(&[0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) }).to_string();
        assert!(png_of_answer(&jpeg).unwrap_err().contains("not a PNG"));
        assert!(png_of_answer("{}").unwrap_err().contains("no picture"));
        assert!(png_of_answer("nope").unwrap_err().contains("not JSON"));
    }

    #[test]
    fn what_the_page_says_is_read_and_a_page_not_ready_is_told_apart() {
        let answer =
            |text: &str| json!({ "result": { "type": "string", "value": text } }).to_string();
        let up = answer(
            r#"{"ready":"complete","picture":"shown","notice":null,"variable":"url(blob:x)","terminals":1,"width":1600,"height":1000}"#,
        );
        let state = page_state_of(&up).unwrap();
        assert_eq!(
            state,
            PageState {
                complete: true,
                picture: true,
                notice: None,
                variable: Some("url(blob:x)".to_owned()),
                terminals: 1,
                width: 1600,
                height: 1000
            }
        );
        assert!(state.ready(true));
        assert!(state.ready(false));

        let no_picture = page_state_of(&answer(
            r#"{"ready":"complete","picture":null,"notice":"The background image cannot be shown. x","terminals":2,"width":1,"height":1}"#,
        ))
        .unwrap();
        assert_eq!(
            no_picture.notice.as_deref(),
            Some("The background image cannot be shown. x")
        );
        assert!(!no_picture.ready(true));
        assert!(no_picture.ready(false));
        let loading = page_state_of(&answer(
            r#"{"ready":"loading","picture":null,"terminals":0,"width":1,"height":1}"#,
        ))
        .unwrap();
        assert!(!loading.ready(false));
        let no_terminal = page_state_of(&answer(
            r#"{"ready":"complete","picture":"shown","terminals":0,"width":1,"height":1}"#,
        ))
        .unwrap();
        assert!(!no_terminal.ready(true));

        let thrown = json!({ "exceptionDetails": { "text": "boom" } }).to_string();
        assert!(
            page_state_of(&thrown)
                .unwrap_err()
                .contains("could not be asked")
        );
        assert!(page_state_of("{}").unwrap_err().contains("no answer"));
    }
}

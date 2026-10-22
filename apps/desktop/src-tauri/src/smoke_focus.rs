//! The focus of the system, which no smoke mode may ever take (NOR-F1-08-b, finding 310).
//!
//! A smoke run (`--smoke`, `--smoke-deeplink`, `--smoke-quick`, `--smoke-window`, `--smoke-api`,
//! `--smoke-persist`, `--smoke-perf`, `--smoke-shot`) opens the real app on the machine of whoever
//! runs it, and a person playing a game in full screen loses the game when a window of another
//! program becomes the foreground window of the system. Keeping the windows hidden is not enough: a
//! window created hidden still became the foreground window of the system about 100 ms after the
//! program started in roughly one run in five (8 in 43 measured with `--smoke-shot`). This module
//! holds the two things every mode shares:
//!
//! 1. every window a smoke run makes is made quiet: without the focus at creation (the web view
//!    inside follows it, so it does not ask for the focus of its page), not focusable, off the
//!    taskbar and hidden. The windows of `tauri.conf.json` ([`quiet_windows`]) and the ones made
//!    later (the second window, the quick window, [`quiet_builder`]) alike, and `set_focus` is never
//!    called by a smoke run;
//! 2. from the first instruction of the program a thread looks at the foreground window of the
//!    system (read only, `GetForegroundWindow`) every few milliseconds ([`Watch`]), and each mode
//!    ends with [`check_never_taken`]: `SMOKE focus never taken: <n> look(s)` before its OK line, or a
//!    failure that says which window of the program was in front, when and what the program was
//!    doing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};

use crate::smoke::print_line;

/// Pause between two looks at the foreground window of the system.
const WATCH: Duration = Duration::from_millis(20);

/// What the program is doing until a mode says otherwise.
pub const STARTING: &str = "the program was starting (the window was still hidden)";
/// What the program is doing once the page of the main window is up and the checks run.
pub const PAGE_UP: &str =
    "the page was up and the checks were running (the window was still hidden)";

// ---- which launches are smoke runs -----------------------------------------------------------------

/// Whether the command line asks for one of the smoke modes (after the program name): the launches
/// that must never take the focus. The same flags the modes themselves look for.
pub fn is_smoke_run(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| arg == crate::smoke::SMOKE_FLAG)
        || crate::deeplink::has_smoke_deeplink_flag(args)
        || crate::smoke::has_smoke_quick_flag(args)
        || crate::smoke_window::has_flag(args)
        || crate::smoke_api::has_flag(args)
        || crate::smoke_persist::has_flag(args)
        || crate::perf::has_perf_flag(args)
        || crate::smoke_shot::has_flag(args)
}

// ---- the windows ------------------------------------------------------------------------------------

/// Makes the windows of `tauri.conf.json` ones that never ask for the focus, for this run only:
/// created without it (`focus`, which the web view inside also follows, so it does not ask for the
/// focus of its page when it starts) and not focusable at all, off the taskbar, and hidden. The
/// window of a normal start keeps its configuration; a window that is hidden can still be the
/// foreground window of the system, and a smoke run is held to never being it.
pub fn quiet_windows(config: &mut tauri::Config) {
    for window in &mut config.app.windows {
        window.focus = false;
        window.focusable = false;
        window.skip_taskbar = true;
        window.visible = false;
    }
}

/// The same for a window made later, with a builder: without the focus, not focusable, off the
/// taskbar, hidden. `quiet` false leaves the builder as it is (a normal start).
pub fn quiet_builder<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    quiet: bool,
) -> WebviewWindowBuilder<'a, R, M> {
    if quiet {
        builder
            .visible(false)
            .focused(false)
            .focusable(false)
            .skip_taskbar(true)
    } else {
        builder
    }
}

/// Whether the windows this app makes from now on are quiet: true in a smoke run, the one in which
/// the windows besides the main one are never shown ([`crate::windows::WindowBook`]).
pub fn quiet_app<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<crate::windows::WindowBook>()
        .is_some_and(|book| !book.shows_new_windows())
}

// ---- the watch --------------------------------------------------------------------------------------

/// What the looks at the foreground window found.
#[derive(Clone, Debug)]
pub struct Looks {
    /// How many looks were made.
    pub count: u64,
    /// The first window of this program any of them found in front of the others, with when.
    pub ours: Option<String>,
}

struct WatchInner {
    began: Instant,
    stop: AtomicBool,
    /// What the program is doing, so a look that finds a window of it in front says when.
    phase: Mutex<&'static str>,
    looks: Mutex<Looks>,
}

impl WatchInner {
    /// One look at the foreground window (read only), kept in `looks`.
    fn look(&self) {
        let mut looks = self.looks.lock().unwrap_or_else(|e| e.into_inner());
        looks.count += 1;
        if looks.ours.is_none()
            && let Some(window) = platform::foreground_ours()
        {
            looks.ours = Some(format!(
                "{window}, {} ms after the program started, while {}",
                self.began.elapsed().as_millis(),
                *self.phase.lock().unwrap_or_else(|e| e.into_inner())
            ));
        }
    }
}

/// Looks at the foreground window of the system (read only) every few milliseconds, on a thread of
/// its own, from the first moment of the program: the window is hidden through the start and a
/// hidden window can be in front of the others too, so the whole life of the program is looked at,
/// and a look that finds a window of this program in front says what the program was doing.
#[derive(Clone)]
pub struct Watch {
    inner: Arc<WatchInner>,
}

impl std::fmt::Debug for Watch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Watch")
    }
}

impl Watch {
    /// Starts looking. The thread ends when the last copy of the watch is gone, or at `finish`.
    pub fn start() -> Self {
        let inner = Arc::new(WatchInner {
            began: Instant::now(),
            stop: AtomicBool::new(false),
            phase: Mutex::new(STARTING),
            looks: Mutex::new(Looks {
                count: 0,
                ours: None,
            }),
        });
        let weak = Arc::downgrade(&inner);
        thread::spawn(move || {
            while let Some(inner) = weak.upgrade() {
                if inner.stop.load(Ordering::SeqCst) {
                    return;
                }
                inner.look();
                drop(inner);
                thread::sleep(WATCH);
            }
        });
        Self { inner }
    }

    /// Tells the looks what the program is doing from now on.
    pub fn phase(&self, phase: &'static str) {
        *self.inner.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase;
    }

    /// One last look, then the answer; the looks stop.
    pub fn finish(&self) -> Looks {
        self.inner.look();
        self.inner.stop.store(true, Ordering::SeqCst);
        self.inner
            .looks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// The watch of this program, started once by [`begin`].
static WATCH_OF_THE_RUN: OnceLock<Watch> = OnceLock::new();

/// Starts the watch of the run, the first thing `main` does in a smoke run, and returns it. A second
/// call gives the same watch.
pub fn begin() -> Watch {
    WATCH_OF_THE_RUN.get_or_init(Watch::start).clone()
}

/// Tells the watch of the run what the program is doing from now on (nothing when none was started).
pub fn phase(phase: &'static str) {
    if let Some(watch) = WATCH_OF_THE_RUN.get() {
        watch.phase(phase);
    }
}

// ---- the verdict ------------------------------------------------------------------------------------

/// The sentence of a run that took the focus.
fn taken_sentence(window: &str) -> String {
    format!(
        "a window of this program was the foreground window of the system ({window}); a smoke run must never take the focus"
    )
}

/// The verdict on the looks: fails, saying which window was in front, when any look found one of
/// this program there; otherwise prints `SMOKE focus never taken: <n> look(s)` and gives the count.
pub fn conclude(looks: &Looks) -> Result<u64, String> {
    if let Some(window) = &looks.ours {
        return Err(taken_sentence(window));
    }
    print_line(&format!(
        "SMOKE focus never taken: {} look(s) at the foreground window, none found a window of this program",
        looks.count
    ));
    Ok(looks.count)
}

/// [`conclude`] on the watch given, a run that has none being a failure: the watch is what proves
/// the focus was never taken, and a mode that forgot to start it would pass without the proof.
fn check_with(watch: Option<&Watch>) -> Result<u64, String> {
    let watch = watch.ok_or_else(|| {
        "the watch of the foreground window was never started in this run".to_owned()
    })?;
    conclude(&watch.finish())
}

/// What every smoke mode calls before its OK line: the last look and the verdict of the whole run.
/// Gives the number of looks made.
pub fn check_looks() -> Result<u64, String> {
    check_with(WATCH_OF_THE_RUN.get())
}

/// [`check_looks`] for a mode that has no use for the count.
pub fn check_never_taken() -> Result<(), String> {
    check_looks().map(|_| ())
}

// ---- the system -------------------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    /// What the window in front of the others (read only) is when it belongs to this program: its
    /// handle, class and title. `None` when it is another program's, or there is none.
    pub fn foreground_ours() -> Option<String> {
        // SAFETY: reads of the state of the system; `process`, `class` and `title` are ours to write.
        unsafe {
            let front = GetForegroundWindow();
            if front.0.is_null() {
                return None;
            }
            let mut process = 0u32;
            GetWindowThreadProcessId(front, Some(&mut process));
            if process != std::process::id() {
                return None;
            }
            let mut class = [0u16; 128];
            let mut title = [0u16; 128];
            let class_len = usize::try_from(GetClassNameW(front, &mut class)).unwrap_or(0);
            let title_len = usize::try_from(GetWindowTextW(front, &mut title)).unwrap_or(0);
            Some(format!(
                "window {:#x}, class {:?}, title {:?}",
                front.0 as isize,
                String::from_utf16_lossy(&class[..class_len]),
                String::from_utf16_lossy(&title[..title_len])
            ))
        }
    }
}

#[cfg(not(windows))]
mod platform {
    /// Only Windows has a foreground window this program can be asked about; elsewhere the looks are
    /// counted and find nothing.
    pub fn foreground_ours() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn every_smoke_mode_is_a_quiet_launch() {
        for mode in [
            &["noren.exe", "--smoke"][..],
            &[
                "noren.exe",
                "--smoke-deeplink",
                "noren://open?path=C%3A%5Cx",
            ],
            &["noren.exe", "--smoke-quick"],
            &["noren.exe", "--smoke-window"],
            &["noren.exe", "--smoke-api"],
            &[
                "noren.exe",
                "--smoke-persist",
                "first",
                "endpoint",
                "folder",
            ],
            &["noren.exe", "--smoke-perf", "--perf-out", "out.json"],
            &["noren.exe", "--smoke-shot", "out.png"],
        ] {
            assert!(is_smoke_run(&args(mode)), "{mode:?}");
        }
    }

    #[test]
    fn a_normal_start_is_not_a_quiet_launch() {
        for normal in [
            &["noren.exe"][..],
            &["noren.exe", "noren://open?path=C%3A%5Cx"],
            &["noren.exe", "--some-other-flag"],
            // The flag counts after the name of the program only.
            &["--smoke"],
        ] {
            assert!(!is_smoke_run(&args(normal)), "{normal:?}");
        }
    }

    #[test]
    fn the_windows_of_a_smoke_run_are_made_without_asking_for_the_focus() {
        let mut config: tauri::Config = serde_json::from_value(serde_json::json!({
            "identifier": "test.focus",
            "app": { "windows": [
                { "label": "main", "title": "Noren", "visible": true },
                { "label": "other" }
            ] }
        }))
        .unwrap();
        // The defaults of Tauri ask for the focus, can be focused and sit on the taskbar.
        assert!(
            config
                .app
                .windows
                .iter()
                .all(|w| w.focus && w.focusable && !w.skip_taskbar)
        );
        quiet_windows(&mut config);
        assert_eq!(config.app.windows.len(), 2);
        for window in &config.app.windows {
            assert!(!window.focus, "{}", window.label);
            assert!(!window.focusable, "{}", window.label);
            assert!(window.skip_taskbar, "{}", window.label);
            assert!(!window.visible, "{}", window.label);
        }
    }

    #[test]
    fn the_configuration_of_the_windows_is_the_one_that_asks_for_the_focus() {
        // A normal start does not call `quiet_windows`; the built-in configuration is the one a
        // person gets: hidden at birth (shown and focused by the setup), focusable, on the taskbar.
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config.app.windows[0];
        assert!(main.focus && main.focusable && !main.skip_taskbar);
    }

    #[test]
    fn no_smoke_mode_shows_a_window_or_asks_for_the_focus() {
        // The code of the smoke modes never calls `set_focus` or `show`: the windows of a smoke run
        // stay hidden and are never given the focus (the one window the shot run shows is shown with
        // `SW_SHOWNOACTIVATE`, outside every monitor). Comment lines may talk about both.
        for (name, source) in [
            ("smoke.rs", include_str!("smoke.rs")),
            ("smoke_api.rs", include_str!("smoke_api.rs")),
            ("smoke_browser.rs", include_str!("smoke_browser.rs")),
            ("smoke_persist.rs", include_str!("smoke_persist.rs")),
            ("smoke_shot.rs", include_str!("smoke_shot.rs")),
            ("smoke_window.rs", include_str!("smoke_window.rs")),
            ("perf.rs", include_str!("perf.rs")),
        ] {
            // Only the code before the tests of the file.
            let code = source
                .split(
                    "#[cfg(test)]
mod tests",
                )
                .next()
                .unwrap_or(source);
            for (number, line) in code.lines().enumerate() {
                if line.trim_start().starts_with("//") {
                    continue;
                }
                for call in ["set_focus", ".show()", ".focus()", "unminimize"] {
                    assert!(
                        !line.contains(call),
                        "{name}:{} calls {call}: {line}",
                        number + 1
                    );
                }
            }
        }
    }

    #[test]
    fn looks_that_found_nothing_of_the_program_pass_and_one_that_did_fails_with_the_window() {
        let clean = Looks {
            count: 42,
            ours: None,
        };
        assert_eq!(conclude(&clean), Ok(42));
        let taken = Looks {
            count: 7,
            ours: Some(
                "window 0x1, class \"Tauri Window\", title \"Noren\", 98 ms after the program started, while the program was starting (the window was still hidden)"
                    .to_owned(),
            ),
        };
        let message = conclude(&taken).unwrap_err();
        assert!(
            message.contains("foreground window of the system"),
            "{message}"
        );
        assert!(message.contains("0x1"), "{message}");
        assert!(
            message.contains("98 ms after the program started"),
            "{message}"
        );
        assert!(message.contains("must never take the focus"), "{message}");
    }

    #[test]
    fn a_run_without_a_watch_does_not_pass() {
        let message = check_with(None).unwrap_err();
        assert!(message.contains("never started"), "{message}");
    }

    #[test]
    fn the_watch_looks_many_times_and_finds_no_window_of_a_test_process() {
        let watch = Watch::start();
        watch.phase(PAGE_UP);
        thread::sleep(Duration::from_millis(120));
        let looks = watch.finish();
        // The test process has no window: it is never in front, and the thread did look.
        assert!(looks.count >= 2, "{looks:?}");
        assert!(looks.ours.is_none(), "{looks:?}");
        assert!(check_with(Some(&watch)).is_ok());
    }

    #[test]
    fn the_watch_of_the_run_is_one_whatever_the_number_of_calls() {
        let first = begin();
        let second = begin();
        assert!(Arc::ptr_eq(&first.inner, &second.inner));
        phase(PAGE_UP);
        assert!(check_never_taken().is_ok());
    }
}

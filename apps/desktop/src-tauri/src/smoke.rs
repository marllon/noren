//! Smoke mode (`noren --smoke`): proves the real app can start, load the interface and run a
//! real shell session through the same code path as the `session_create` command.

use std::io::Write;
use std::process;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::SessionId;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Listener, Manager};

use crate::bridge::{self, AppState};

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
fn check_window_hidden(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "the main window does not exist".to_string())?;
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    window_hidden_result(visible)
}

fn window_hidden_result(visible: bool) -> Result<(), String> {
    if visible {
        Err("the main window is visible; the smoke run must keep it hidden".to_string())
    } else {
        Ok(())
    }
}

/// Prints `line` to stdout and flushes it so a parent process sees it before we exit.
fn print_line(line: &str) {
    let mut out = std::io::stdout().lock();
    // A closed stdout must not turn the smoke check into a panic.
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Removes terminal escape sequences (CSI, OSC, DCS and the like) from `text`.
pub fn strip_ansi(text: &str) -> String {
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
    let text = strip_ansi(&String::from_utf8_lossy(output));
    text.split(['\n', '\r'])
        .any(|line| line.trim() == SMOKE_MARKER)
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
/// command and waits until the marker shows up on a line of its own. Always releases the session.
fn check_session(app: &AppHandle, deadline: Instant) -> Result<(), String> {
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
    result
}

fn wait_for_marker(
    state: &AppState,
    id: SessionId,
    rx: &mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
) -> Result<(), String> {
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
                    return Ok(());
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
            let result = check_session(&handle, started + SMOKE_TIMEOUT)
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

#[cfg(test)]
mod tests {
    use super::*;

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

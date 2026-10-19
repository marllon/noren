//! Runs PowerShell in a real PTY with the integration script and checks the sequences it writes.
//! No window is involved and nothing touches the network. When no PowerShell is installed the
//! test prints a warning and returns.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::{Profile, SessionEvent, SessionManager, detect_system_profiles, is_powershell};

const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const STEP_TIMEOUT: Duration = Duration::from_secs(25);

/// The folder of the integration scripts, as the repository keeps them.
fn integration_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src-tauri/resources/shell-integration")
}

/// `pwsh` when installed, otherwise Windows PowerShell.
fn powershell_profile() -> Option<Profile> {
    let set = detect_system_profiles();
    let found = set
        .profiles
        .iter()
        .filter(|profile| is_powershell(&profile.program))
        .min_by_key(|profile| !profile.program.to_ascii_lowercase().contains("pwsh"));
    found.cloned()
}

/// Reads output until `needle` (raw text) shows up after the first `from` bytes already seen.
fn wait_for(rx: &Receiver<Vec<u8>>, seen: &mut Vec<u8>, needle: &str, from: usize) -> usize {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let text = String::from_utf8_lossy(seen).into_owned();
        if let Some(at) = text.get(from..).and_then(|tail| tail.find(needle)) {
            return from + at + needle.len();
        }
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(bytes) => seen.extend_from_slice(&bytes),
            Err(_) => panic!(
                "{needle:?} not found within {STEP_TIMEOUT:?}; output so far: {:?}",
                String::from_utf8_lossy(seen)
            ),
        }
    }
}

fn run() {
    let Some(profile) = powershell_profile() else {
        eprintln!("warning: no PowerShell found on this machine, shell integration test skipped");
        return;
    };
    eprintln!("shell integration test uses {}", profile.program);
    assert!(profile.inject_integration);

    let manager = SessionManager::new();
    let spec = profile.spawn_spec_with_integration(120, 30, Some(&integration_dir()));
    assert!(
        spec.args.iter().any(|arg| arg == "-Command"),
        "the integration must be injected: {:?}",
        spec.args
    );
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            if let SessionEvent::Output(bytes) = event {
                let _ = tx.send(bytes.to_vec());
            }
        })
        .expect("spawn PowerShell");

    let mut seen = Vec::new();
    // The first prompt: folder, prompt start and prompt end, and no command ended before it.
    let mut at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", 0);
    let first = String::from_utf8_lossy(&seen).into_owned();
    assert!(first.contains("\x1b]7;file://"), "OSC 7 missing: {first:?}");
    assert!(
        first.contains("\x1b]133;A\x07"),
        "OSC 133;A missing: {first:?}"
    );
    assert!(
        !first.contains("\x1b]133;D"),
        "no command ran yet, so there is no 133;D: {first:?}"
    );

    // A command that fails with a known code.
    #[cfg(windows)]
    let failing: &[u8] = b"cmd /c exit 3\r";
    #[cfg(not(windows))]
    let failing: &[u8] = b"sh -c 'exit 3'\r";
    manager.write(id, failing).expect("write the command");
    at = wait_for(&rx, &mut seen, "\x1b]133;D;3\x07", at);

    let text = String::from_utf8_lossy(&seen).into_owned();
    let command_line = text.find("\x1b]633;E;").expect("OSC 633;E missing");
    let command_start = text.find("\x1b]133;C\x07").expect("OSC 133;C missing");
    let command_end = text.find("\x1b]133;D;3\x07").expect("OSC 133;D missing");
    assert!(
        command_line < command_start && command_start < command_end,
        "E, C and D must come in this order: {text:?}"
    );
    #[cfg(windows)]
    assert!(text.contains("\x1b]633;E;cmd /c exit 3\x07"), "{text:?}");
    // The next prompt follows the end of the command.
    at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);

    // A command that succeeds ends with code 0, and a line with a ';' is escaped.
    manager
        .write(id, b"$null = 'a'; $null = 'b'\r")
        .expect("write the command");
    at = wait_for(&rx, &mut seen, "\x1b]133;D;0\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(
        text.contains("\x1b]633;E;$null = 'a'\\x3b $null = 'b'\x07"),
        "{text:?}"
    );
    wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);

    manager.kill(id).expect("kill the session");
    assert_eq!(manager.live_threads(), 0);
}

/// Runs `body` on its own thread and fails the test if it does not finish in `TEST_TIMEOUT`.
fn with_timeout(body: fn()) {
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        body();
        let _ = done_tx.send(());
    });
    match done_rx.recv_timeout(TEST_TIMEOUT) {
        Ok(()) => handle.join().unwrap(),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            if let Err(panic) = handle.join() {
                std::panic::resume_unwind(panic);
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("timed out after {TEST_TIMEOUT:?}"),
    }
}

/// The user's own prompt, defined before the script is loaded (as a profile would), keeps being
/// the prompt shown and keeps seeing the `$?` of the command that just ran.
fn run_with_user_prompt() {
    let Some(profile) = powershell_profile() else {
        eprintln!("warning: no PowerShell found on this machine, shell integration test skipped");
        return;
    };
    let plain = profile.spawn_spec_with_integration(120, 30, Some(&integration_dir()));
    let mut spec = profile.spawn_spec(120, 30);
    spec.args.extend(plain.args[..3].iter().cloned());
    spec.args.push(format!(
        "function prompt {{ 'MINE:' + $? + '> ' }}; {}",
        plain.args[3]
    ));

    let manager = SessionManager::new();
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            if let SessionEvent::Output(bytes) = event {
                let _ = tx.send(bytes.to_vec());
            }
        })
        .expect("spawn PowerShell");

    let mut seen = Vec::new();
    let mut at = wait_for(&rx, &mut seen, "MINE:True> \x1b]133;B\x07", 0);
    #[cfg(windows)]
    let failing: &[u8] = b"cmd /c exit 3\r";
    #[cfg(not(windows))]
    let failing: &[u8] = b"sh -c 'exit 3'\r";
    manager.write(id, failing).expect("write the command");
    at = wait_for(&rx, &mut seen, "MINE:False> \x1b]133;B\x07", at);
    manager
        .write(id, b"$null = 1\r")
        .expect("write the command");
    wait_for(&rx, &mut seen, "MINE:True> \x1b]133;B\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(text.contains("\x1b]133;D;3\x07"), "{text:?}");
    manager.kill(id).expect("kill the session");
}

#[test]
fn powershell_with_the_script_reports_the_exit_code() {
    with_timeout(run);
}

#[test]
fn the_script_keeps_the_prompt_of_the_user() {
    with_timeout(run_with_user_prompt);
}

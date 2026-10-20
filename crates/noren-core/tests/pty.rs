//! End-to-end tests for `SessionManager` against real PTYs. Every test runs under its own
//! timeout and uses only local processes (no network).

use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::{ExitInfo, SessionEvent, SessionId, SessionManager, SpawnSpec};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

enum Seen {
    Output(Vec<u8>),
    Exit(ExitInfo),
}

/// Runs `body` on its own thread and fails the test if it does not finish in `TEST_TIMEOUT`.
fn with_timeout(name: &'static str, body: impl FnOnce() + Send + 'static) {
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        body();
        let _ = done_tx.send(());
    });
    match done_rx.recv_timeout(TEST_TIMEOUT) {
        Ok(()) => handle.join().unwrap(),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            // The body panicked: re-raise its panic with the original message.
            if let Err(panic) = handle.join() {
                std::panic::resume_unwind(panic);
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("{name}: timed out after {TEST_TIMEOUT:?}"),
    }
}

fn spec(program: &str, args: &[&str]) -> SpawnSpec {
    SpawnSpec {
        program: program.to_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        cwd: None,
        env: vec![],
        cols: 80,
        rows: 24,
    }
}

fn start(manager: &SessionManager, spec: SpawnSpec) -> (SessionId, Receiver<Seen>) {
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            let seen = match event {
                SessionEvent::Output(bytes) => Seen::Output(bytes.to_vec()),
                SessionEvent::Exit(info) => Seen::Exit(info),
            };
            let _ = tx.send(seen);
        })
        .expect("spawn");
    (id, rx)
}

/// Collects events until the exit event arrives; returns all output and the exit info.
fn drain_until_exit(rx: &Receiver<Seen>, deadline: Instant) -> (String, ExitInfo) {
    let mut output = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left).expect("event before the deadline") {
            Seen::Output(bytes) => {
                output.extend_from_slice(&bytes);
            }
            Seen::Exit(info) => {
                assert!(rx.try_recv().is_err(), "exit must be the last event");
                return (String::from_utf8_lossy(&output).into_owned(), info);
            }
        }
    }
}

/// Waits until `needle` shows up in the output.
fn wait_for_text(rx: &Receiver<Seen>, needle: &str, deadline: Instant) {
    let mut output = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left).expect("event before the deadline") {
            Seen::Output(bytes) => {
                output.extend_from_slice(&bytes);
                if String::from_utf8_lossy(&output).contains(needle) {
                    return;
                }
            }
            Seen::Exit(info) => panic!("exited ({info:?}) before printing {needle:?}"),
        }
    }
}

#[cfg(windows)]
fn echo_spec() -> SpawnSpec {
    spec("cmd.exe", &["/c", "echo noren"])
}
#[cfg(not(windows))]
fn echo_spec() -> SpawnSpec {
    spec("sh", &["-c", "echo noren"])
}

/// A process that stays alive for about 30 s unless killed.
#[cfg(windows)]
fn long_spec() -> SpawnSpec {
    spec("ping.exe", &["-n", "30", "127.0.0.1"])
}
#[cfg(not(windows))]
fn long_spec() -> SpawnSpec {
    spec("sleep", &["30"])
}

#[test]
fn echo_output_and_exit_code_are_delivered() {
    with_timeout("echo", || {
        let manager = SessionManager::new();
        let (id, rx) = start(&manager, echo_spec());
        let (output, info) = drain_until_exit(&rx, Instant::now() + Duration::from_secs(8));
        // ConPTY wraps the text in escape sequences, so only check that it is contained.
        assert!(output.contains("noren"), "output was {output:?}");
        assert_eq!(info.code, 0);
        manager.kill(id).expect("release the finished session");
        assert_eq!(manager.live_threads(), 0);
    });
}

#[test]
fn resize_of_a_live_session_succeeds() {
    with_timeout("resize", || {
        let manager = SessionManager::new();
        let (id, rx) = start(&manager, long_spec());
        manager.resize(id, 120, 40).expect("resize a live session");
        manager.resize(id, 40, 10).expect("resize again");
        assert!(manager.resize(id, 0, 10).is_err(), "zero size is rejected");
        manager.kill(id).expect("kill");
        drain_until_exit(&rx, Instant::now() + Duration::from_secs(2));
        assert!(
            manager.resize(id, 80, 24).is_err(),
            "killed session is gone"
        );
        assert_eq!(manager.live_threads(), 0);
    });
}

#[test]
fn kill_ends_a_long_session_and_reports_the_exit() {
    with_timeout("kill", || {
        let manager = SessionManager::new();
        let (id, rx) = start(&manager, long_spec());
        let started = Instant::now();
        manager.kill(id).expect("kill");
        // kill() joins the session threads, so the exit event is already queued.
        let (_, info) = drain_until_exit(&rx, Instant::now() + Duration::from_secs(1));
        assert!(started.elapsed() < Duration::from_secs(8));
        assert_ne!(info.code, 0, "a killed process does not exit cleanly");
        assert_eq!(manager.live_threads(), 0);
        assert_eq!(manager.session_count(), 0);
    });
}

#[test]
fn twenty_sessions_open_and_close_without_leaving_threads() {
    with_timeout("twenty sessions", || {
        let manager = SessionManager::new();
        let mut sessions = Vec::new();
        for _ in 0..20 {
            sessions.push(start(&manager, long_spec()));
        }
        assert_eq!(manager.session_count(), 20);
        assert_eq!(manager.live_threads(), 60, "reader, pump and waiter each");
        for (id, rx) in &sessions {
            manager.kill(*id).expect("kill");
            drain_until_exit(rx, Instant::now() + Duration::from_secs(1));
        }
        assert_eq!(manager.session_count(), 0);
        assert_eq!(manager.live_threads(), 0);
    });
}

#[test]
fn write_reaches_the_child() {
    with_timeout("write", || {
        let manager = SessionManager::new();
        #[cfg(windows)]
        let (program, args): (&str, &[&str]) = ("cmd.exe", &["/k"]);
        #[cfg(not(windows))]
        let (program, args): (&str, &[&str]) = ("sh", &[]);
        let (id, rx) = start(&manager, spec(program, args));
        // The typed line is echoed back, so the command spells the word differently from
        // the text it prints.
        #[cfg(windows)]
        let line: &[u8] = b"echo noren-wr^itten\r";
        #[cfg(not(windows))]
        let line: &[u8] = b"echo noren-wr\"itten\"\n";
        manager.write(id, line).expect("write");
        wait_for_text(
            &rx,
            "noren-written",
            Instant::now() + Duration::from_secs(8),
        );
        manager.kill(id).expect("kill");
        assert_eq!(manager.live_threads(), 0);
    });
}

/// A shell that runs a program as a child (not as itself), for the agent detector.
#[cfg(windows)]
fn child_of_shell_spec() -> (SpawnSpec, &'static str) {
    (
        spec("cmd.exe", &["/c", "ping.exe -n 30 127.0.0.1 & rem"]),
        "ping",
    )
}
#[cfg(not(windows))]
fn child_of_shell_spec() -> (SpawnSpec, &'static str) {
    (spec("sh", &["-c", "sleep 30; true"]), "sleep")
}

#[test]
fn the_agent_detector_finds_a_real_child_of_a_real_session() {
    with_timeout("agent-detect", || {
        use noren_core::{AgentEntry, SystemProcesses, scan_sessions};
        let manager = SessionManager::new();
        let (spec, program) = child_of_shell_spec();
        let (id, rx) = start(&manager, spec);
        let pid = manager.process_id(id);
        assert!(pid.is_some(), "a live session has a pid");
        let catalog = [AgentEntry {
            id: "stand-in".to_owned(),
            executables: vec![program.to_owned()],
            packages: vec![],
        }];
        let source = SystemProcesses::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        let found = loop {
            let found = scan_sessions(&source, &[(id, pid)], &catalog);
            if !found.is_empty() || Instant::now() > deadline {
                break found;
            }
            thread::sleep(Duration::from_millis(100));
        };
        manager.kill(id).expect("kill");
        drain_until_exit(&rx, Instant::now() + Duration::from_secs(2));
        assert_eq!(found.len(), 1, "the child of the shell is found");
        assert_eq!(found[0].1.id, "stand-in");
        assert!(
            manager.process_id(id).is_none(),
            "a released session has no pid"
        );
    });
}

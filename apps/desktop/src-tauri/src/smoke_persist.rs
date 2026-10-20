//! The persistence smoke run (`noren --smoke-persist <first|second> <endpoint> <folder>`,
//! NOR-F14-02b): a shell outlives the app that started it.
//!
//! `scripts/smoke.mjs` starts the app twice, hidden, on a daemon name and a folder of their own:
//!
//! The folder starts with a saved workspace of one pane (`scripts/smoke-persist-state.json`, made by
//! the script), so the interface of each run restores a pane of its own, exactly as it does for the
//! user: through the commands of the app, over the real IPC of the window.
//!
//! - **first.** Waits for the interface (which hands over `sessions.keepOnClose`, on by default, and
//!   starts a shell for its pane), starts a shell for a pane of its own through the same code the
//!   `session_create` command runs, makes it print a line, starts one more for a pane that no
//!   saved workspace has, writes down their pids and the pid of the `norend` that holds them, and
//!   exits through the normal way out of the app. The shells must still be running afterwards.
//! - **second.** Starts again on the same endpoint and folder. The interface gets the shell of its
//!   pane back (`session_reattach`), which this run checks. It asks for the shell of its own pane the
//!   way the interface does, and checks that it is the same session and the same process, that the
//!   line the first run made it print came back with the buffer, and that it still answers. Then it
//!   ends the sessions no pane came back for (exactly the one that belonged to the pane nobody has),
//!   asks the daemon to stop, and checks that it did.
//!
//! The windows stay hidden throughout and the run never touches the files of the user.

use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::daemon::Endpoint;
use noren_core::{ProcessSource, SessionId, SystemProcesses};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Listener, Manager};

use crate::bridge::{self, AppState};
use crate::daemon_link::{DaemonSettings, Placement};
use crate::pane_sessions::{BOOK_FILE_NAME, Binding};
use crate::smoke::{
    check_no_global_shortcut, check_shell_runs_in, check_window_hidden, has_line, locate_in_daemon,
    print_line, visible_tail,
};

pub const SMOKE_PERSIST_FLAG: &str = "--smoke-persist";
/// The pane the run gives its shell to. The interface does not know this id: it is only a name in
/// the book of the run.
pub const PERSIST_PANE: &str = "smoke-persist-pane";
/// The pane of the saved workspace the script puts in the folder: the interface starts its shell,
/// and takes it back in the second run.
pub const PAGE_PANE: &str = "smoke-persist-page-pane";
/// A pane that no workspace has: its shell is the one the second run must end.
pub const ORPHAN_PANE: &str = "smoke-persist-orphan-pane";
/// What the first run writes down for the second.
const MARKER_FILE: &str = "persist.json";
/// The whole of one run.
const TIMEOUT: Duration = Duration::from_secs(60);
/// The lines the shell prints, before the app is closed and after it is opened again.
const BEFORE: &str = "noren-persist-before";
const AFTER: &str = "noren-persist-after";
/// How long a daemon that was asked to stop has to be gone.
const STOP_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    First,
    Second,
}

/// What a persistence run was asked to do, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistRun {
    pub role: Role,
    /// The daemon of the pair of runs.
    pub endpoint: String,
    /// The folder with the files of the app for both runs; it is made and removed by the script.
    pub dir: PathBuf,
}

impl PersistRun {
    /// The first run starts the daemon and leaves it running; the second finds it and stops it.
    pub fn daemon_settings(&self) -> DaemonSettings {
        DaemonSettings {
            stop_on_shutdown: self.role == Role::Second,
            ..DaemonSettings::for_run(self.endpoint.clone())
        }
    }

    /// Where the book of which shell is which pane's is kept.
    pub fn book_file(&self) -> PathBuf {
        self.dir.join(BOOK_FILE_NAME)
    }

    fn marker_file(&self) -> PathBuf {
        self.dir.join(MARKER_FILE)
    }
}

/// Whether `--smoke-persist` is among the arguments (the first one is the program).
pub fn has_flag(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == SMOKE_PERSIST_FLAG)
}

/// Reads `--smoke-persist <first|second> <endpoint> <folder>`.
pub fn parse_args(args: &[String]) -> Result<PersistRun, String> {
    let usage =
        format!("{SMOKE_PERSIST_FLAG} needs: first|second, a daemon name and an existing folder");
    let position = args
        .iter()
        .skip(1)
        .position(|arg| arg == SMOKE_PERSIST_FLAG)
        .ok_or_else(|| usage.clone())?;
    let mut rest = args.iter().skip(position + 2);
    let role = match rest.next().map(String::as_str) {
        Some("first") => Role::First,
        Some("second") => Role::Second,
        _ => return Err(usage),
    };
    let endpoint = rest.next().ok_or_else(|| usage.clone())?.clone();
    Endpoint::named(&endpoint).map_err(|e| format!("{endpoint:?} is not a daemon name: {e}"))?;
    let dir = PathBuf::from(rest.next().ok_or_else(|| usage.clone())?);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(PersistRun {
        role,
        endpoint,
        dir,
    })
}

/// What the first run tells the second.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Marker {
    session: u64,
    /// The process of the shell.
    shell: u32,
    /// The `norend` that holds it.
    norend: u32,
    /// The first app, which is gone by the time the second one reads this.
    app: u32,
    /// The shell the interface started for its own pane, and its process.
    page_session: u64,
    page_shell: u32,
    /// The shell of the pane nobody has.
    orphan_session: u64,
}

fn write_marker(run: &PersistRun, marker: &Marker) -> Result<(), String> {
    let text = serde_json::to_string_pretty(marker).map_err(|e| e.to_string())?;
    std::fs::write(run.marker_file(), text)
        .map_err(|e| format!("could not write {}: {e}", run.marker_file().display()))
}

fn read_marker(run: &PersistRun) -> Result<Marker, String> {
    let text = std::fs::read_to_string(run.marker_file())
        .map_err(|e| format!("could not read {}: {e}", run.marker_file().display()))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("{} is not usable: {e}", run.marker_file().display()))
}

/// Reports a failure, stops the daemon of the pair (so a failed run leaves none behind) and exits 1.
fn fail(app: &AppHandle, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    let state = app.state::<AppState>();
    let _ = state.sessions.stop_daemon();
    process::exit(1);
}

/// Smoke mode `--smoke-persist`: wait for the interface, then do what the role says. Anything that
/// does not finish within [`TIMEOUT`] ends the process with an error and code 1.
pub fn arm(app: &tauri::App, run: PersistRun) {
    let started = Instant::now();
    let ready = Arc::new(AtomicBool::new(false));

    let handle = app.handle().clone();
    let listener_ready = Arc::clone(&ready);
    let listener_run = run.clone();
    app.listen("app-ready", move |_event| {
        // Only the first signal starts the check.
        if listener_ready.swap(true, Ordering::SeqCst) {
            return;
        }
        print_line("SMOKE app-ready received");
        let handle = handle.clone();
        let run = listener_run.clone();
        thread::spawn(move || {
            let deadline = started + TIMEOUT;
            let result = match run.role {
                Role::First => run_first(&handle, &run, deadline),
                Role::Second => run_second(&handle, &run, deadline),
            }
            .and_then(|()| check_no_global_shortcut(&handle))
            .and_then(|()| check_window_hidden(&handle));
            match result {
                Ok(()) => {
                    print_line("SMOKE window hidden");
                    handle.exit(0);
                }
                Err(message) => fail(&handle, &message),
            }
        });
    });

    let handle = app.handle().clone();
    thread::spawn(move || {
        thread::sleep(TIMEOUT);
        if !ready.load(Ordering::SeqCst) {
            fail(
                &handle,
                &format!("app-ready not received within {}s", TIMEOUT.as_secs()),
            );
        }
    });
}

/// Everything the shell printed so far, and the way to wait for more.
struct Output {
    rx: Receiver<Vec<u8>>,
    seen: Vec<u8>,
}

impl Output {
    fn channel() -> (Channel<InvokeResponseBody>, Self) {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                // The receiver is gone once the run ended; late output is of no interest.
                let _ = tx.send(bytes);
            }
            Ok(())
        });
        (
            channel,
            Self {
                rx,
                seen: Vec::new(),
            },
        )
    }

    /// Waits until a line of the output is exactly `line`.
    fn wait_for_line(&mut self, line: &str, deadline: Instant) -> Result<(), String> {
        loop {
            if has_line(&self.seen, line) {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(remaining) {
                Ok(bytes) => self.seen.extend_from_slice(&bytes),
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "{line} not found in the session output in time; output ended with {:?}",
                        visible_tail(&self.seen)
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "the session ended before printing {line}; output ended with {:?}",
                        visible_tail(&self.seen)
                    ));
                }
            }
        }
    }
}

/// The interface hands over `sessions.keepOnClose` while it boots (on by default); a run that
/// reached `app-ready` without it never proved the setting reaches the Rust side.
fn require_keep(state: &AppState) -> Result<(), String> {
    if state.keeps_sessions() {
        Ok(())
    } else {
        Err("the interface did not hand over sessions.keepOnClose (the default is on)".to_owned())
    }
}

/// Waits until every session this run holds has printed something. On Windows, closing a pseudo
/// console right after another session was created can stall for a long time (finding 168), so
/// nothing is ended or detached before each shell has had its first output.
fn wait_for_first_output(state: &AppState, deadline: Instant) -> Result<(), String> {
    loop {
        let silent = state
            .sessions
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|info| {
                info.exit.is_none() && info.buffered == 0 && state.sessions.owns(info.session)
            })
            .count();
        if silent == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("{silent} session(s) never printed anything"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// What the book says about `pane` now.
fn binding_of(state: &AppState, pane: &str) -> Option<Binding> {
    state
        .pane_book
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .binding(pane)
}

/// Waits until the book has a shell for `pane`: the interface asked for it over the IPC of the window
/// (its restore finishes before it says it is up, so this is quick).
fn wait_for_binding(state: &AppState, pane: &str, deadline: Instant) -> Result<Binding, String> {
    loop {
        if let Some(binding) = binding_of(state, pane) {
            return Ok(binding);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the interface never started a shell for the pane {pane}"
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn run_first(app: &AppHandle, run: &PersistRun, deadline: Instant) -> Result<(), String> {
    let state = app.state::<AppState>();
    require_keep(&state)?;

    // The pane of the saved workspace: its shell was started by the interface, over the real IPC,
    // and written down because the interface named the pane.
    let page = wait_for_binding(&state, PAGE_PANE, deadline)?;

    let (channel, mut output) = Output::channel();
    let (id, profile) = bridge::create_session(app, &state, None, None, None, 120, 30, channel)?;
    state.bind_pane(PERSIST_PANE, SessionId(id));
    let found = locate_in_daemon(&state, id)?;
    print_line(&format!(
        "SMOKE PERSIST daemon norend pid {} on {} holds session {id} of pane {PERSIST_PANE} (profile {profile})",
        found.norend, found.endpoint
    ));
    // The pane nobody will have: its shell is what the second run must end.
    let (unheard, _) = Output::channel();
    let (orphan, _) = bridge::create_session(app, &state, None, None, None, 120, 30, unheard)?;
    state.bind_pane(ORPHAN_PANE, SessionId(orphan));

    state
        .sessions
        .write(SessionId(id), format!("echo {BEFORE}\r").as_bytes())
        .map_err(|e| e.to_string())?;
    output.wait_for_line(BEFORE, deadline)?;
    wait_for_first_output(&state, deadline)?;

    // The book is on disk before the app goes: that is what the second run reads.
    let bound = binding_of(&state, PERSIST_PANE);
    if bound.map(|binding| (binding.session, binding.pid)) != Some((id, found.shell)) {
        return Err(format!(
            "the book has {bound:?} for the pane, expected session {id} with process {}",
            found.shell
        ));
    }
    if !run.book_file().is_file() {
        return Err(format!("{} was not written", run.book_file().display()));
    }
    write_marker(
        run,
        &Marker {
            session: id,
            shell: found.shell,
            norend: found.norend,
            app: process::id(),
            page_session: page.session,
            page_shell: page.pid,
            orphan_session: orphan,
        },
    )?;
    print_line(&format!(
        "SMOKE PERSIST first run: shell pid {} (session {id}) in norend pid {}, leaving without ending it (the app is pid {})",
        found.shell,
        found.norend,
        process::id()
    ));
    Ok(())
}

/// Whether a process with this pid is running now.
fn process_running(pid: u32) -> bool {
    SystemProcesses::new()
        .snapshot()
        .iter()
        .any(|process| process.pid == pid)
}

fn run_second(app: &AppHandle, run: &PersistRun, deadline: Instant) -> Result<(), String> {
    let state = app.state::<AppState>();
    require_keep(&state)?;
    let marker = read_marker(run)?;

    // The daemon of the first run is still there, and this run found it instead of starting one.
    match state.sessions.placement() {
        Placement::Daemon {
            endpoint,
            norend_pid: None,
        } if endpoint == run.endpoint => {}
        other => {
            return Err(format!(
                "expected to find the daemon the first run left on {}, the sessions are at {other:?}",
                run.endpoint
            ));
        }
    }
    if !process_running(marker.norend) {
        return Err(format!(
            "norend {} (the daemon of the first run) did not survive the first app",
            marker.norend
        ));
    }
    if process_running(marker.app) && marker.app != process::id() {
        return Err(format!(
            "the first app, pid {}, is still running",
            marker.app
        ));
    }

    // The interface asked for the shell of its own pane at its start, over the real IPC of the
    // window, and got the one the first run left: the same session and process, taken over.
    let page = wait_for_binding(&state, PAGE_PANE, deadline)?;
    if (page.session, page.pid) != (marker.page_session, marker.page_shell) {
        return Err(format!(
            "the interface's pane has session {} with process {}, the first run left session {} with process {}: its restore started a new shell",
            page.session, page.pid, marker.page_session, marker.page_shell
        ));
    }
    if !state.sessions.owns(SessionId(page.session)) || state.route(page.session).is_none() {
        return Err(format!(
            "the session {} of the interface's pane was not taken over",
            page.session
        ));
    }
    check_shell_runs_in(page.pid, marker.norend, page.session)?;

    // Asked for the way the interface asks at its start: by pane.
    let (channel, mut output) = Output::channel();
    let session = state
        .reattach_pane(app, PERSIST_PANE, channel)
        .ok_or_else(|| format!("the pane {PERSIST_PANE} got no session back from the daemon"))?;
    if session.0 != marker.session {
        return Err(format!(
            "the pane got session {}, expected session {}",
            session.0, marker.session
        ));
    }
    let shell = state
        .sessions
        .process_ids(&[session])
        .first()
        .and_then(|(_, pid)| *pid)
        .ok_or_else(|| format!("the daemon reports no process for session {}", session.0))?;
    if shell != marker.shell {
        return Err(format!(
            "the shell is process {shell}, the first run left process {}",
            marker.shell
        ));
    }
    check_shell_runs_in(shell, marker.norend, session.0)?;

    // What it printed while no app was attached came back with the buffer ...
    output.wait_for_line(BEFORE, deadline)?;
    // ... and it still answers.
    state
        .sessions
        .write(session, format!("echo {AFTER}\r").as_bytes())
        .map_err(|e| e.to_string())?;
    output.wait_for_line(AFTER, deadline)?;
    print_line(&format!(
        "SMOKE PERSIST same shell pid {} before closing the app and {shell} after opening it again, session {}, in norend pid {} (apps {} and {}); it printed {BEFORE} before and answered {AFTER} after",
        marker.shell,
        session.0,
        marker.norend,
        marker.app,
        process::id()
    ));
    print_line(&format!(
        "SMOKE PERSIST page pane: the interface took back its shell too, pid {} (session {})",
        page.pid, page.session
    ));

    // The shell of the pane nobody has goes, and only that one: the other two belong to panes.
    wait_for_first_output(&state, deadline)?;
    let mut ended = 0;
    loop {
        ended += state.reap_orphans();
        let foreign = state
            .sessions
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|info| !state.sessions.owns(info.session))
            .count();
        if foreign == 0 {
            break;
        }
        // Something is still attached to it (the first app, if the daemon has not noticed it left).
        if Instant::now() >= deadline {
            return Err(format!(
                "{foreign} session(s) nobody owns were left in the daemon"
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    let left: Vec<u64> = state
        .sessions
        .list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|info| info.session.0)
        .collect();
    if ended != 1 || left.contains(&marker.orphan_session) {
        return Err(format!(
            "expected to end the shell of the pane nobody has (session {}) and only it; ended {ended}, the daemon holds {left:?}",
            marker.orphan_session
        ));
    }
    if !left.contains(&session.0) || !left.contains(&page.session) || left.len() != 2 {
        return Err(format!(
            "the daemon should hold the two shells of panes ({} and {}), it holds {left:?}",
            session.0, page.session
        ));
    }
    print_line(&format!(
        "SMOKE PERSIST orphans ended: {ended} (session {})",
        marker.orphan_session
    ));

    let stopped = state
        .sessions
        .stop_daemon()
        .map_err(|e| format!("the daemon would not stop: {e}"))?;
    debug_assert!(
        stopped.norend_pid.is_none(),
        "this run did not start the daemon"
    );
    // This run did not start the daemon, so it cannot wait on the process: the daemon ends the
    // sessions and its threads after it answers, and the endpoint closes with the process.
    let gone_by = Instant::now() + STOP_WAIT;
    while process_running(marker.norend) {
        if Instant::now() >= gone_by {
            return Err(format!("norend {} is still running", marker.norend));
        }
        thread::sleep(Duration::from_millis(50));
    }
    if state.sessions.daemon_listens() {
        return Err("something still listens on the endpoint of the run".to_owned());
    }
    print_line(&format!(
        "SMOKE PERSIST stopped norend pid {}, endpoint closed",
        marker.norend
    ));
    print_line(&format!(
        "SMOKE PERSIST OK shell pid {} then {shell}",
        marker.shell
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn the_flag_is_found_among_the_arguments() {
        assert!(has_flag(&args(&["noren", "--smoke-persist", "first"])));
        assert!(!has_flag(&args(&["noren", "--smoke"])));
        assert!(
            !has_flag(&args(&["--smoke-persist"])),
            "the first one is the program"
        );
    }

    #[test]
    fn the_run_reads_its_role_its_daemon_and_its_folder() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().into_owned();
        let first = parse_args(&args(&[
            "noren",
            "--smoke-persist",
            "first",
            "smoke-persist-1",
            &dir_text,
        ]))
        .expect("first");
        assert_eq!(first.role, Role::First);
        assert_eq!(first.endpoint, "smoke-persist-1");
        assert_eq!(first.dir, dir);
        assert!(
            !first.daemon_settings().stop_on_shutdown,
            "the first run leaves the daemon"
        );

        let second = parse_args(&args(&[
            "noren",
            "--smoke-persist",
            "second",
            "smoke-persist-1",
            &dir_text,
        ]))
        .expect("second");
        assert_eq!(second.role, Role::Second);
        assert!(
            second.daemon_settings().stop_on_shutdown,
            "the second run stops it"
        );
        assert_eq!(second.daemon_settings().endpoint, "smoke-persist-1");
        assert_eq!(second.book_file(), dir.join(BOOK_FILE_NAME));
    }

    #[test]
    fn a_run_that_cannot_be_checked_is_refused() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().into_owned();
        for bad in [
            args(&["noren", "--smoke-persist"]),
            args(&[
                "noren",
                "--smoke-persist",
                "third",
                "smoke-persist-1",
                &dir_text,
            ]),
            args(&["noren", "--smoke-persist", "first", "smoke-persist-1"]),
            args(&["noren", "--smoke-persist", "first", "bad name", &dir_text]),
            args(&[
                "noren",
                "--smoke-persist",
                "first",
                "smoke-persist-1",
                "/no/such/folder/at/all",
            ]),
        ] {
            assert!(parse_args(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_marker_goes_from_the_first_run_to_the_second() {
        let dir = std::env::temp_dir().join(format!("noren-test-marker-{}", process::id()));
        std::fs::create_dir_all(&dir).expect("folder");
        let run = PersistRun {
            role: Role::First,
            endpoint: "smoke-persist-2".to_owned(),
            dir: dir.clone(),
        };
        let marker = Marker {
            session: 7,
            shell: 4242,
            norend: 99,
            app: 5,
            page_session: 8,
            page_shell: 4243,
            orphan_session: 9,
        };
        write_marker(&run, &marker).expect("write");
        assert_eq!(read_marker(&run).expect("read"), marker);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read_marker(&run).is_err(), "no marker, no second run");
    }

    #[test]
    fn the_saved_workspace_the_script_puts_in_the_folder_has_the_one_pane_the_run_looks_for() {
        let text = include_str!("../../../../scripts/smoke-persist-state.json");
        let state: serde_json::Value = serde_json::from_str(text).expect("the fixture is JSON");
        let mut panes = Vec::new();
        for space in state["spaces"].as_array().expect("spaces") {
            for item in space["items"].as_object().expect("items").values() {
                panes.push(
                    item["layout"]["pane"]["id"]
                        .as_str()
                        .expect("a pane")
                        .to_owned(),
                );
            }
        }
        assert_eq!(panes, vec![PAGE_PANE.to_owned()]);
        // The prespawn reads the same file the interface does: it must understand it, and ask for
        // the same pane (a smoke run starts none ahead, but a fixture it cannot read is a fixture
        // nobody has checked).
        let wanted = crate::prespawn::wanted_from_state(text).expect("the file has a first pane");
        assert_eq!(wanted.pane_id, PAGE_PANE);
        // None of the other names a run uses may be a pane of the workspace.
        assert_ne!(PERSIST_PANE, PAGE_PANE);
        assert_ne!(ORPHAN_PANE, PAGE_PANE);
        assert_ne!(ORPHAN_PANE, PERSIST_PANE);
    }
}

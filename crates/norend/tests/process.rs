//! Integration tests of the `norend` program: the daemon runs in another process (the binary Cargo
//! builds for this package), the tests are its clients over the real named pipe or Unix socket,
//! and the sessions are real shells in real PTYs. No window is opened: the child is started with
//! its output captured, and on Windows with `CREATE_NO_WINDOW`. Every test has its own endpoint
//! (process id and a counter), so nothing meets anything else; nothing reaches the network.
//!
//! Not covered here: Ctrl+C on Windows. Sending it to a child needs a console shared with the
//! child, and the child has none of its own that the test could write to without a window; the
//! handler is `Signals` in `src/main.rs`. On Unix SIGTERM and SIGINT are sent for real.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::SpawnSpec;
use noren_core::daemon::ipc;
use noren_core::daemon::{
    ClientError, ClientEvent, ClientEvents, ClientMessage, Daemon, DaemonClient, Endpoint,
    ErrorCode, PROTOCOL_VERSION, ServerConfig, ServerMessage, read_frame, write_frame,
};
use noren_core::pty::SessionId;

/// Longest a whole test may take.
const TEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Longest one wait inside a test may take.
const STEP: Duration = Duration::from_secs(30);

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn unique_name() -> String {
    format!(
        "test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

/// The tests take turns: on a Windows machine whose `conpty.dll` is not the system's, ending a
/// session while another one is starting can block the first for as long as the second one lives
///. Each session below also waits for its first output before
/// anything else is done to the daemon.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn take_turn() -> std::sync::MutexGuard<'static, ()> {
    ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A `norend` process. Killed when dropped, so a failing test leaves nothing running.
struct Norend {
    child: Child,
    name: String,
    /// Everything the process printed, stdout and stderr, in the order the lines arrived.
    log: Arc<Mutex<Vec<String>>>,
    lines: mpsc::Receiver<String>,
}

impl Norend {
    /// Starts `norend` with `args` and returns once it has said it listens. `args` should carry
    /// the `--endpoint` the test chose; see [`Norend::start_named`].
    fn spawn(args: &[&str]) -> std::io::Result<Self> {
        let name = args
            .iter()
            .position(|a| *a == "--endpoint")
            .and_then(|i| args.get(i + 1))
            .map_or_else(|| "default".to_owned(), |n| (*n).to_owned());
        let mut command = Command::new(env!("CARGO_BIN_EXE_norend"));
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut command);
        let mut child = command.spawn()?;

        let log = Arc::new(Mutex::new(Vec::new()));
        let (tx, lines) = mpsc::channel();
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        for (tag, stream) in [
            ("out", Box::new(stdout) as Box<dyn std::io::Read + Send>),
            ("err", Box::new(stderr)),
        ] {
            let log = Arc::clone(&log);
            let tx = tx.clone();
            thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    log.lock().unwrap().push(format!("{tag}: {line}"));
                    let _ = tx.send(format!("{tag}: {line}"));
                }
            });
        }
        Ok(Self {
            child,
            name,
            log,
            lines,
        })
    }

    /// A daemon with an endpoint of its own, ready for clients.
    fn start_named(extra: &[&str]) -> (Self, Endpoint) {
        let name = unique_name();
        let mut args = vec!["--endpoint", name.as_str()];
        args.extend_from_slice(extra);
        let mut norend = Self::spawn(&args).expect("norend starts");
        norend.wait_for_line("listening on");
        let endpoint = Endpoint::named(&name).expect("a valid name");
        (norend, endpoint)
    }

    #[cfg(unix)]
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn output(&self) -> String {
        self.log.lock().unwrap().join("\n")
    }

    /// Waits until the process printed a line with `needle`.
    fn wait_for_line(&mut self, needle: &str) {
        let deadline = Instant::now() + STEP;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) if line.contains(needle) => return,
                Ok(_) => {}
                Err(_) => panic!(
                    "norend ({}) never printed {needle:?}; it printed:\n{}",
                    self.name,
                    self.output()
                ),
            }
        }
    }

    /// Waits for the process to end on its own.
    fn wait_exit(&mut self, limit: Duration) -> ExitStatus {
        let deadline = Instant::now() + limit;
        loop {
            match self.child.try_wait().expect("ask the child") {
                Some(status) => {
                    // The reader threads end with the pipes; give them a moment to log the tail.
                    thread::sleep(Duration::from_millis(100));
                    return status;
                }
                None if Instant::now() >= deadline => panic!(
                    "norend ({}) did not stop within {limit:?}; it printed:\n{}",
                    self.name,
                    self.output()
                ),
                None => thread::sleep(Duration::from_millis(25)),
            }
        }
    }
}

impl Drop for Norend {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
fn no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_command: &mut Command) {}

/// Whether a process with this id exists.
fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let mut command = Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
        no_window(&mut command);
        let output = command.output().expect("tasklist runs");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\",\"{pid}\","))
    }
    #[cfg(not(windows))]
    {
        // `kill` as a shell builtin: a minimal system may not have a `kill` program.
        Command::new("sh")
            .args(["-c", &format!("kill -0 {pid}")])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}

// ---- helpers for the client side ----

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
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

/// An interactive shell that stays until it is killed.
#[cfg(windows)]
fn shell() -> SpawnSpec {
    spec("cmd.exe", &["/k"])
}
#[cfg(not(windows))]
fn shell() -> SpawnSpec {
    spec("sh", &[])
}

/// The line to type so that the shell prints `marker`. The typed text spells the marker
/// differently (the shell echoes what is typed), so finding the marker means the command ran.
fn say(marker: &str) -> Vec<u8> {
    let (head, tail) = marker.split_at(marker.len() / 2);
    #[cfg(windows)]
    let line = format!("echo {head}^{tail}\r");
    #[cfg(not(windows))]
    let line = format!("echo {head}\"{tail}\"\n");
    line.into_bytes()
}

/// Connects, waiting for the endpoint if the daemon is slow to open it.
async fn connect(endpoint: &Endpoint) -> (DaemonClient, ClientEvents) {
    let deadline = tokio::time::Instant::now() + STEP;
    loop {
        match DaemonClient::connect(endpoint).await {
            Ok(pair) => return pair,
            Err(e) if tokio::time::Instant::now() >= deadline => {
                panic!("could not connect to {endpoint}: {e}")
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

async fn connect_raw(endpoint: &Endpoint) -> ipc::ClientStream {
    ipc::connect(endpoint).await.expect("connect by hand")
}

/// Reads the output of `session` until `needle` has shown up; returns all the text read.
async fn wait_for(events: &mut ClientEvents, session: SessionId, needle: &str) -> String {
    let mut text = String::new();
    let outcome = tokio::time::timeout(STEP, async {
        loop {
            match events.recv().await {
                Some(ClientEvent::Output { session: id, data }) if id == session => {
                    text.push_str(&String::from_utf8_lossy(&data));
                    if text.contains(needle) {
                        return;
                    }
                }
                Some(ClientEvent::Exit { session: id, info }) if id == session => {
                    panic!("the session ended ({info:?}) before it printed {needle:?}: {text:?}")
                }
                Some(_) => {}
                None => panic!("the connection ended before {needle:?} showed up: {text:?}"),
            }
        }
    })
    .await;
    assert!(outcome.is_ok(), "{needle:?} did not show up: {text:?}");
    text
}

/// Creates a session, attaches to it and waits for its first output, which is the sign that the
/// pseudo console has finished starting (see [`ONE_AT_A_TIME`]).
async fn start_session(
    client: &DaemonClient,
    events: &mut ClientEvents,
) -> (SessionId, Option<u32>) {
    let created = client.create(&shell()).await.expect("create");
    let attached = client.attach(created.session).await.expect("attach");
    if attached.replay.is_empty() {
        let first = tokio::time::timeout(STEP, async {
            loop {
                match events.recv().await {
                    Some(ClientEvent::Output { session, .. }) if session == created.session => {
                        return;
                    }
                    Some(_) => {}
                    None => panic!("the connection ended before the session printed anything"),
                }
            }
        })
        .await;
        assert!(first.is_ok(), "the session printed nothing within {STEP:?}");
    }
    (created.session, created.pid)
}

/// Fails the test instead of hanging it.
fn within<T>(body: impl std::future::Future<Output = T>) -> T {
    runtime().block_on(async {
        tokio::time::timeout(TEST_TIMEOUT, body)
            .await
            .expect("the test timed out")
    })
}

/// The endpoint is free: nothing answers there, and a new daemon can take the name.
async fn assert_endpoint_free(endpoint: &Endpoint) {
    assert!(
        matches!(
            DaemonClient::connect(endpoint).await,
            Err(ClientError::Connect(_))
        ),
        "nothing listens at {endpoint}"
    );
    #[cfg(unix)]
    assert!(
        !std::path::Path::new(endpoint.address()).exists(),
        "the socket file is removed"
    );
    let mut daemon = Daemon::start(endpoint.clone(), ServerConfig::default())
        .expect("a new daemon can take the endpoint");
    daemon.shutdown();
}

// ---- the tests ----

#[test]
fn a_session_lives_in_the_other_process_across_detach_and_reattach() {
    let _turn = take_turn();
    let (mut norend, endpoint) = Norend::start_named(&[]);
    within(async {
        let (client, mut events) = connect(&endpoint).await;
        let (session, pid) = start_session(&client, &mut events).await;
        let shell_pid = pid.expect("the system gave the shell a pid");
        assert_ne!(shell_pid, std::process::id());
        assert!(
            process_alive(shell_pid),
            "the shell runs, owned by the daemon"
        );

        // A second session with its own first output, to see that both end with the daemon.
        let (second, second_pid) = start_session(&client, &mut events).await;
        assert!(second_pid.is_some());
        assert_ne!(second, session);

        // Write and read.
        client.write(session, &say("alpha-one")).await.unwrap();
        wait_for(&mut events, session, "alpha-one").await;

        // Detach, write while nobody looks, and come back on a new connection: the session is
        // the same one, with the same process, and the buffer has what was printed meanwhile.
        client.detach(session).await.unwrap();
        client.write(session, &say("beta-two")).await.unwrap();
        drop(client);
        drop(events);

        let (client, mut events) = connect(&endpoint).await;
        let listed = client.list().await.unwrap();
        assert_eq!(listed.len(), 2, "both sessions outlived the connection");
        assert_eq!(listed[0].pid, Some(shell_pid), "the same process");
        let again = client.attach(session).await.unwrap();
        // The word typed while detached may still be on its way into the buffer.
        let mut replay = String::from_utf8_lossy(&again.replay).into_owned();
        if !replay.contains("beta-two") {
            replay.push_str(&wait_for(&mut events, session, "beta-two").await);
        }
        let alpha = replay.find("alpha-one").expect("the first word is kept");
        let beta = replay
            .find("beta-two")
            .expect("the word typed while detached");
        assert!(alpha < beta, "in the order it was printed: {replay:?}");

        // New output arrives as events, not as another copy of the buffer.
        client.write(session, &say("gamma-three")).await.unwrap();
        let text = wait_for(&mut events, session, "gamma-three").await;
        assert!(!text.contains("alpha-one"), "{text:?}");

        // Stop it from the protocol: the answer comes first, then the end of the connection.
        client.shutdown().await.expect("the daemon answers Ok");
        loop {
            if events.recv().await.is_none() {
                break;
            }
        }
    });
    let status = norend.wait_exit(STEP * 2);
    let output = norend.output();
    assert_eq!(status.code(), Some(0), "exit code; it printed:\n{output}");
    assert!(output.contains("norend: stopped"), "{output}");
    within(async {
        assert_endpoint_free(&endpoint).await;
    });
}

#[test]
fn the_sessions_end_with_the_daemon() {
    let _turn = take_turn();
    let (mut norend, endpoint) = Norend::start_named(&[]);
    let pids = within(async {
        let (client, mut events) = connect(&endpoint).await;
        let mut pids = Vec::new();
        for _ in 0..2 {
            let (_, pid) = start_session(&client, &mut events).await;
            pids.push(pid.expect("a pid"));
        }
        for pid in &pids {
            assert!(process_alive(*pid));
        }
        client.shutdown().await.expect("the daemon answers Ok");
        pids
    });
    let status = norend.wait_exit(STEP * 2);
    assert_eq!(status.code(), Some(0), "{}", norend.output());
    let deadline = Instant::now() + STEP;
    for pid in pids {
        while process_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "the shell {pid} outlived the daemon"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Runs `norend` with `args` to the end, as an installer would (no window, nothing on stdin).
fn run_to_the_end(args: &[&str]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_norend"));
    command.args(args).stdin(Stdio::null());
    no_window(&mut command);
    command.output().expect("norend runs")
}

#[test]
fn stop_ends_the_daemon_and_its_sessions_and_frees_the_endpoint() {
    let _turn = take_turn();
    let (mut norend, endpoint) = Norend::start_named(&[]);
    let name = norend.name.clone();
    let pids = within(async {
        let (client, mut events) = connect(&endpoint).await;
        let mut pids = Vec::new();
        for _ in 0..2 {
            let (_, pid) = start_session(&client, &mut events).await;
            pids.push(pid.expect("a pid"));
        }
        for pid in &pids {
            assert!(process_alive(*pid));
        }
        // The client that was in the middle of its work is let go with the daemon, as the app is.
        pids
    });

    // Another process of norend asks the first one to stop: this is the call of an installer.
    let stop = run_to_the_end(&["--stop", "--endpoint", &name]);
    let (out, err) = (
        String::from_utf8_lossy(&stop.stdout),
        String::from_utf8_lossy(&stop.stderr),
    );
    assert_eq!(stop.status.code(), Some(0), "stdout: {out}\nstderr: {err}");
    assert!(out.contains("stopped the norend on"), "{out}");
    // It found the process of the daemon by its command line, and says which it waited for.
    assert!(
        out.contains(&format!("process {} is gone", norend.child.id())),
        "{out}"
    );

    // It came back only when the daemon was gone, checked at once with nothing in between: the
    // process has ended (it can be collected), so have the shells, and the endpoint is free (a new
    // daemon can take the name).
    let ended = norend.child.try_wait().expect("ask the daemon");
    assert!(
        ended.is_some(),
        "the daemon was still running when --stop returned; it printed:\n{}",
        norend.output()
    );
    for pid in &pids {
        assert!(!process_alive(*pid), "the shell {pid} outlived the daemon");
    }
    within(async {
        assert_endpoint_free(&endpoint).await;
    });
    assert_eq!(
        ended.and_then(|status| status.code()),
        Some(0),
        "{}",
        norend.output()
    );
    assert!(norend.output().contains("norend: stopped"));
}

#[test]
fn stop_with_nothing_running_is_a_success_and_changes_nothing() {
    let name = unique_name();
    let stop = run_to_the_end(&["--stop", "--endpoint", &name]);
    let (out, err) = (
        String::from_utf8_lossy(&stop.stdout),
        String::from_utf8_lossy(&stop.stderr),
    );
    assert_eq!(stop.status.code(), Some(0), "stdout: {out}\nstderr: {err}");
    assert!(out.contains("nothing to stop"), "{out}");
    assert!(err.is_empty(), "{err}");
    // Twice, as an installer that runs again would.
    assert_eq!(
        run_to_the_end(&["--stop", "--endpoint", &name])
            .status
            .code(),
        Some(0)
    );
}

#[test]
fn a_second_norend_on_the_same_endpoint_stops_with_a_clear_error() {
    let _turn = take_turn();
    let (mut first, endpoint) = Norend::start_named(&[]);
    let name = first.name.clone();

    let mut second = Norend::spawn(&["--endpoint", &name]).expect("the second starts");
    let status = second.wait_exit(STEP);
    let output = second.output();
    assert_eq!(status.code(), Some(3), "{output}");
    assert!(
        output.contains("another norend already listens on"),
        "the message says what is wrong: {output}"
    );
    assert!(output.contains(&name), "and where: {output}");
    assert!(
        !output.lines().any(|line| line.starts_with("out:")),
        "it never claimed the endpoint, so it said nothing on stdout: {output}"
    );

    // The first one was not disturbed, and still stops cleanly.
    within(async {
        let (client, _events) = connect(&endpoint).await;
        assert!(client.list().await.unwrap().is_empty());
        client.shutdown().await.unwrap();
    });
    assert_eq!(first.wait_exit(STEP).code(), Some(0), "{}", first.output());
}

#[test]
fn the_buffer_size_option_is_applied() {
    let _turn = take_turn();
    let (mut norend, endpoint) = Norend::start_named(&["--buffer-bytes", "600"]);
    within(async {
        let (client, mut events) = connect(&endpoint).await;
        let (session, _) = start_session(&client, &mut events).await;
        client.write(session, &say("first-mark")).await.unwrap();
        wait_for(&mut events, session, "first-mark").await;
        // Far more output than the buffer holds, ending in a marker.
        let padding = "x".repeat(1500);
        let (head, tail) = ("last-m", "ark");
        #[cfg(windows)]
        let line = format!("echo {padding}{head}^{tail}\r");
        #[cfg(not(windows))]
        let line = format!("echo {padding}{head}\"{tail}\"\n");
        client.write(session, line.as_bytes()).await.unwrap();
        wait_for(&mut events, session, "last-mark").await;

        client.detach(session).await.unwrap();
        let attached = client.attach(session).await.unwrap();
        let replay = String::from_utf8_lossy(&attached.replay).into_owned();
        assert!(
            attached.replay.len() <= 600,
            "{} bytes",
            attached.replay.len()
        );
        assert!(replay.contains("last-mark"), "{replay:?}");
        assert!(!replay.contains("first-mark"), "{replay:?}");
        client.shutdown().await.unwrap();
    });
    assert_eq!(
        norend.wait_exit(STEP * 2).code(),
        Some(0),
        "{}",
        norend.output()
    );
}

#[test]
fn a_client_of_another_protocol_version_is_refused_by_name_and_the_daemon_goes_on() {
    let _turn = take_turn();
    let (mut norend, endpoint) = Norend::start_named(&[]);
    within(async {
        // Version 1 had no Shutdown request: a client built for it must be refused at the
        // handshake, not fail later on an unknown tag.
        for version in [1, PROTOCOL_VERSION + 98] {
            let mut stream = connect_raw(&endpoint).await;
            let hello = ClientMessage::Hello { version }.to_frame().unwrap();
            write_frame(&mut stream, &hello).await.unwrap();
            let answer = read_frame(&mut stream).await.expect("an answer");
            match ServerMessage::decode(&answer).unwrap() {
                ServerMessage::Error(body) => {
                    assert_eq!(body.code, ErrorCode::VersionMismatch);
                    assert!(
                        body.message.contains(&version.to_string())
                            && body.message.contains(&PROTOCOL_VERSION.to_string()),
                        "the message names both versions: {}",
                        body.message
                    );
                }
                other => panic!("expected a refusal, got {other:?}"),
            }
        }
        let (client, _events) = connect(&endpoint).await;
        client.shutdown().await.unwrap();
    });
    assert_eq!(
        norend.wait_exit(STEP).code(),
        Some(0),
        "{}",
        norend.output()
    );
}

#[test]
fn version_prints_the_version_of_the_program_and_of_the_protocol() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_norend"));
    command.arg("--version").stdin(Stdio::null());
    no_window(&mut command);
    let output = command.output().expect("norend runs");
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains(&format!("protocol version {PROTOCOL_VERSION}")),
        "{text}"
    );
}

#[test]
fn a_wrong_command_line_stops_at_once_with_code_2() {
    for (args, needle) in [
        (vec!["--endpoint", "a/b"], "not a valid daemon name"),
        (vec!["--endpoint", ""], "not a valid daemon name"),
        (vec!["--buffer-bytes", "lots"], "whole number"),
        (vec!["--buffer-bytes", "99999999"], "over the limit"),
        (vec!["--bogus"], "unknown argument"),
        (vec!["--endpoint"], "needs a value"),
        (
            vec!["--stop", "--endpoint", "a/b"],
            "not a valid daemon name",
        ),
        (vec!["--stop", "--buffer-bytes", "9"], "does not go with"),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_norend"));
        command.args(&args).stdin(Stdio::null());
        no_window(&mut command);
        let output = command.output().expect("norend runs");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {stderr}");
        assert!(stderr.contains(needle), "{args:?}: {stderr}");
        assert!(
            output.stdout.is_empty(),
            "nothing is claimed on stdout: {args:?}"
        );
    }
}

#[test]
fn help_prints_the_usage_and_exits_with_0() {
    let mut command = Command::new(env!("CARGO_BIN_EXE_norend"));
    command.arg("--help").stdin(Stdio::null());
    no_window(&mut command);
    let output = command.output().expect("norend runs");
    assert_eq!(output.status.code(), Some(0));
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        text.contains("--endpoint") && text.contains("--buffer-bytes"),
        "{text}"
    );
}

#[test]
fn a_session_that_asks_for_a_missing_session_is_an_error_and_the_daemon_goes_on() {
    let _turn = take_turn();
    let (mut norend, endpoint) = Norend::start_named(&[]);
    within(async {
        let (client, _events) = connect(&endpoint).await;
        match client.attach(SessionId(999)).await {
            Err(ClientError::Server(body)) => assert_eq!(body.code, ErrorCode::UnknownSession),
            other => panic!("expected an unknown session, got {other:?}"),
        }
        assert!(client.list().await.is_ok());
        client.shutdown().await.unwrap();
    });
    assert_eq!(
        norend.wait_exit(STEP).code(),
        Some(0),
        "{}",
        norend.output()
    );
}

/// SIGTERM and SIGINT are a clean stop on Unix: exit code 0, sessions ended, socket removed.
#[cfg(unix)]
#[test]
fn sigterm_and_sigint_stop_the_daemon_cleanly() {
    for signal in ["-TERM", "-INT"] {
        let _turn = take_turn();
        let (mut norend, endpoint) = Norend::start_named(&[]);
        let shell_pid = within(async {
            let (client, mut events) = connect(&endpoint).await;
            let (_, pid) = start_session(&client, &mut events).await;
            pid.expect("a pid")
        });
        let sent = Command::new("sh")
            .args(["-c", &format!("kill {signal} {}", norend.pid())])
            .status()
            .expect("kill runs");
        assert!(sent.success());
        let status = norend.wait_exit(STEP * 2);
        let output = norend.output();
        assert_eq!(status.code(), Some(0), "{signal}: {output}");
        assert!(output.contains("norend: stopped"), "{signal}: {output}");
        assert!(!process_alive(shell_pid), "{signal}: the shell is gone");
        within(async { assert_endpoint_free(&endpoint).await });
    }
}

//! Integration tests of `norend --bridge`: the program runs in another process with its standard
//! streams piped, and the tests speak the ordinary protocol over those pipes with a
//! `DaemonClient`, as the client of an `ssh` session does. The daemon it reaches is a real one on
//! a real pipe or socket with real shells, either started by the test or started by the bridge
//! itself. No window is opened (`CREATE_NO_WINDOW` on Windows) and nothing reaches the network.
//!
//! Every test has its own endpoint (process id and a counter). A daemon that a bridge started is
//! stopped with `norend --stop` when the test ends, even when it fails.

use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use noren_core::SpawnSpec;
use noren_core::daemon::{
    ClientError, ClientEvent, ClientEvents, Daemon, DaemonClient, Endpoint, ServerConfig,
};
use noren_core::pty::SessionId;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

const TEST_TIMEOUT: Duration = Duration::from_secs(120);
const STEP: Duration = Duration::from_secs(30);

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn unique_name() -> String {
    format!(
        "bridge-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

/// The tests take turns (see `tests/process.rs`: a Windows machine whose `conpty.dll` is not the
/// system's can block a session that ends while another one starts).
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn within<T>(body: impl std::future::Future<Output = T>) -> T {
    let _turn = ONE_AT_A_TIME.lock().await;
    tokio::time::timeout(TEST_TIMEOUT, body)
        .await
        .expect("the test timed out")
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

#[cfg(windows)]
fn shell() -> SpawnSpec {
    spec("cmd.exe", &["/k"])
}
#[cfg(not(windows))]
fn shell() -> SpawnSpec {
    spec("sh", &[])
}

fn say(marker: &str) -> Vec<u8> {
    let (head, tail) = marker.split_at(marker.len() / 2);
    #[cfg(windows)]
    let line = format!("echo {head}^{tail}\r");
    #[cfg(not(windows))]
    let line = format!("echo {head}\"{tail}\"\n");
    line.into_bytes()
}

/// `norend` with `args`, its three streams piped, no window.
fn norend(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_norend"));
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// A bridge process and the client over its pipes.
struct Bridge {
    child: Child,
    client: DaemonClient,
    events: ClientEvents,
}

impl Bridge {
    async fn start(name: &str) -> Self {
        let mut child = norend(&["--bridge", "--endpoint", name])
            .spawn()
            .expect("the bridge starts");
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let (client, events) =
            DaemonClient::connect_stream_within(tokio::io::join(stdout, stdin), STEP)
                .await
                .expect("the handshake over the bridge");
        Self {
            child,
            client,
            events,
        }
    }

    /// Lets go of the connection, as `ssh` does when it dies, and waits for the bridge to end.
    async fn hang_up(self) -> ExitStatus {
        let Self {
            mut child, client, ..
        } = self;
        drop(client);
        tokio::time::timeout(STEP, child.wait())
            .await
            .expect("the bridge ends when its input does")
            .expect("wait for the bridge")
    }
}

/// Stops the daemon a bridge started, whatever happens to the test.
struct StopDaemon(String);

impl Drop for StopDaemon {
    fn drop(&mut self) {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_norend"));
        command
            .args(["--stop", "--endpoint", &self.0])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let _ = command.status();
    }
}

/// Creates a session, attaches to it and waits for its first output (the sign that the pseudo
/// console has finished starting).
async fn start_session(
    client: &DaemonClient,
    events: &mut ClientEvents,
) -> (SessionId, Option<u32>) {
    let created = client.create(&shell()).await.expect("create");
    let attached = client.attach(created.session).await.expect("attach");
    if attached.replay.is_empty() {
        tokio::time::timeout(STEP, async {
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
        .await
        .expect("the session prints something");
    }
    (created.session, created.pid)
}

async fn wait_for(events: &mut ClientEvents, session: SessionId, needle: &str) -> String {
    let mut text = String::new();
    tokio::time::timeout(STEP, async {
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
    .await
    .unwrap_or_else(|_| panic!("{needle:?} did not show up: {text:?}"));
    text
}

/// Connects directly (not through a bridge), waiting for the endpoint if it is still opening.
async fn connect_direct(endpoint: &Endpoint) -> (DaemonClient, ClientEvents) {
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

#[tokio::test]
async fn a_bridge_to_a_running_daemon_carries_the_protocol_and_leaves_the_sessions_when_it_ends() {
    within(async {
        let name = unique_name();
        let endpoint = Endpoint::named(&name).expect("a valid name");
        let mut daemon = Daemon::start(endpoint.clone(), ServerConfig::default()).expect("start");

        let mut bridge = Bridge::start(&name).await;
        let (session, pid) = start_session(&bridge.client, &mut bridge.events).await;
        assert!(pid.is_some());
        bridge
            .client
            .write(session, &say("through-the-bridge"))
            .await
            .expect("write");
        wait_for(&mut bridge.events, session, "through-the-bridge").await;
        assert_eq!(daemon.session_count(), 1);

        // The connection goes away; the bridge ends cleanly, the daemon and the shell stay.
        let status = bridge.hang_up().await;
        assert_eq!(status.code(), Some(0), "{status:?}");
        assert_eq!(daemon.session_count(), 1, "the session outlives the bridge");

        // A new bridge, as from a new ssh connection, finds the same shell and its buffer.
        let mut again = Bridge::start(&name).await;
        let sessions = again.client.list().await.expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session, session);
        assert_eq!(sessions[0].pid, pid);
        let attached = again.client.attach(session).await.expect("attach");
        assert!(
            String::from_utf8_lossy(&attached.replay).contains("through-the-bridge"),
            "the buffer came back: {:?}",
            String::from_utf8_lossy(&attached.replay)
        );
        again
            .client
            .write(session, &say("second-bridge"))
            .await
            .expect("write");
        wait_for(&mut again.events, session, "second-bridge").await;
        again.client.kill(session).await.expect("kill");
        assert_eq!(again.hang_up().await.code(), Some(0));
        daemon.shutdown();
    })
    .await;
}

#[tokio::test]
async fn a_bridge_ends_when_the_daemon_closes_the_connection() {
    within(async {
        let name = unique_name();
        let endpoint = Endpoint::named(&name).expect("a valid name");
        let mut daemon = Daemon::start(endpoint, ServerConfig::default()).expect("start");

        let bridge = Bridge::start(&name).await;
        let Bridge {
            mut child, client, ..
        } = bridge;
        // The daemon is asked to stop: it answers, then closes every connection.
        client.shutdown().await.expect("shutdown");
        let status = tokio::time::timeout(STEP, child.wait())
            .await
            .expect("the bridge ends when the daemon closes the connection")
            .expect("wait for the bridge");
        assert_eq!(status.code(), Some(0), "{status:?}");
        drop(client);
        daemon.shutdown();
    })
    .await;
}

#[tokio::test]
async fn a_bridge_starts_a_daemon_of_its_own_when_none_answers_and_the_daemon_stays() {
    within(async {
        let name = unique_name();
        let endpoint = Endpoint::named(&name).expect("a valid name");
        let _cleanup = StopDaemon(name.clone());
        assert!(
            matches!(
                DaemonClient::connect(&endpoint).await,
                Err(ClientError::Connect(_))
            ),
            "nothing listens before the bridge"
        );

        let mut bridge = Bridge::start(&name).await;
        let (session, pid) = start_session(&bridge.client, &mut bridge.events).await;
        bridge
            .client
            .write(session, &say("started-by-the-bridge"))
            .await
            .expect("write");
        wait_for(&mut bridge.events, session, "started-by-the-bridge").await;
        let bridge_pid = bridge.child.id();

        let status = bridge.hang_up().await;
        assert_eq!(status.code(), Some(0), "{status:?}");

        // The daemon the bridge started is a program of its own: it answers after the bridge is
        // gone, with the same shell.
        let (direct, mut events) = connect_direct(&endpoint).await;
        let sessions = direct.list().await.expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pid, pid);
        direct.attach(session).await.expect("attach");
        direct
            .write(session, &say("daemon-outlived-the-bridge"))
            .await
            .expect("write");
        wait_for(&mut events, session, "daemon-outlived-the-bridge").await;
        assert!(bridge_pid.is_some());

        direct.kill(session).await.expect("kill");
        direct.shutdown().await.expect("shutdown");
    })
    .await;
}

#[tokio::test]
async fn bridges_that_start_together_end_up_on_one_daemon() {
    within(async {
        let name = unique_name();
        let endpoint = Endpoint::named(&name).expect("a valid name");
        let _cleanup = StopDaemon(name.clone());

        let (mut first, mut second) = tokio::join!(Bridge::start(&name), Bridge::start(&name));
        let (a, _) = start_session(&first.client, &mut first.events).await;
        let (b, _) = start_session(&second.client, &mut second.events).await;
        assert_ne!(a, b);

        // One daemon holds both sessions.
        let (direct, _events) = connect_direct(&endpoint).await;
        let listed: Vec<SessionId> = direct
            .list()
            .await
            .expect("list")
            .iter()
            .map(|s| s.session)
            .collect();
        assert!(listed.contains(&a) && listed.contains(&b), "{listed:?}");
        assert_eq!(listed.len(), 2);

        direct.kill(a).await.expect("kill");
        direct.kill(b).await.expect("kill");
        assert_eq!(first.hang_up().await.code(), Some(0));
        assert_eq!(second.hang_up().await.code(), Some(0));
        direct.shutdown().await.expect("shutdown");
    })
    .await;
}

#[tokio::test]
async fn a_bridge_with_a_bad_endpoint_name_prints_nothing_on_stdout_and_a_sentence_on_stderr() {
    within(async {
        let mut child = norend(&["--bridge", "--endpoint", "not/a/name"])
            .spawn()
            .expect("the bridge starts");
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let status = tokio::time::timeout(STEP, child.wait())
            .await
            .expect("the bridge ends")
            .expect("wait");
        assert_eq!(status.code(), Some(2), "a usage error: {status:?}");
        let (mut out, mut err) = (Vec::new(), Vec::new());
        stdout.read_to_end(&mut out).await.expect("read stdout");
        stderr.read_to_end(&mut err).await.expect("read stderr");
        assert!(out.is_empty(), "stdout carries only the protocol: {out:?}");
        let err = String::from_utf8_lossy(&err);
        assert!(err.contains("not a valid daemon name"), "{err}");
    })
    .await;
}

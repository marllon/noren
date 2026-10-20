//! Tests of the client for a daemon that is not on a local pipe: a `DaemonClient` over any
//! stream, and a `ReconnectingClient` whose connection breaks and comes back.
//!
//! The daemon is a real `Daemon` on a real pipe or socket with real shells (`cmd.exe` on Windows,
//! `sh` elsewhere), as in `tests/daemon.rs`. What stands in for the `ssh` process is a task that
//! copies bytes between an in-memory stream and the daemon's pipe: killing the task is what
//! killing `ssh` does to the connection (both ends see it end, the daemon and its sessions stay).
//! The real `ssh` is tested against a real sshd in `tests/ssh_docker.rs`, which needs Docker and
//! is ignored by default. Nothing here reaches the network.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use noren_core::SpawnSpec;
use noren_core::daemon::ipc;
use noren_core::daemon::{
    BackoffPolicy, ClientError, ClientEvent, ConnectFailure, Connector, Daemon, DaemonClient,
    Endpoint, Established, LinkEvent, LinkEvents, LinkState, ProtocolError, ReconnectingClient,
    ServerConfig, ServerMessage, Transport, read_frame, write_frame,
};
use noren_core::pty::SessionId;
use tokio::io::AsyncWriteExt;

const TEST_TIMEOUT: Duration = Duration::from_secs(120);
const STEP: Duration = Duration::from_secs(20);

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn endpoint() -> Endpoint {
    let name = format!(
        "link-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    Endpoint::named(&name).expect("a valid endpoint name")
}

/// Same reason as in `tests/daemon.rs`: on a Windows machine whose `conpty.dll` is not the
/// system's, ending a session while another one is starting can block the first, so the tests of
/// this file take turns.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn within<T>(body: impl std::future::Future<Output = T>) -> T {
    let _turn = ONE_AT_A_TIME.lock().await;
    tokio::time::timeout(TEST_TIMEOUT, body)
        .await
        .expect("the test timed out")
}

#[cfg(windows)]
fn shell() -> SpawnSpec {
    spec("cmd.exe", &["/k"])
}
#[cfg(not(windows))]
fn shell() -> SpawnSpec {
    spec("sh", &[])
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

/// The line to type so that the shell prints `marker`; the typed text spells it differently, so
/// finding the marker means the command ran.
fn say(marker: &str) -> Vec<u8> {
    let (head, tail) = marker.split_at(marker.len() / 2);
    #[cfg(windows)]
    let line = format!("echo {head}^{tail}\r");
    #[cfg(not(windows))]
    let line = format!("echo {head}\"{tail}\"\n");
    line.into_bytes()
}

#[cfg(windows)]
const EXIT_LINE: &[u8] = b"exit\r";
#[cfg(not(windows))]
const EXIT_LINE: &[u8] = b"exit\n";

// ---------------------------------------------------------------------------------------------
// A connector that reaches the daemon through something that can be cut
// ---------------------------------------------------------------------------------------------

/// An attempt of the connector that fails.
#[derive(Clone)]
struct Fail {
    message: &'static str,
    permanent: bool,
}

/// Reaches the daemon at `endpoint` through a relay task, like `ssh` does through its pipes.
#[derive(Clone)]
struct Relay {
    endpoint: Endpoint,
    /// The attempts that fail, in order; once empty every attempt works.
    plans: Arc<Mutex<VecDeque<Fail>>>,
    /// How many times `connect` was called.
    attempts: Arc<AtomicU32>,
    /// How many connections were made (the number a transport carries as its id).
    made: Arc<AtomicU32>,
    /// Set when a transport is dropped.
    dropped: Arc<AtomicU32>,
}

impl Relay {
    fn new(endpoint: Endpoint) -> Self {
        Self {
            endpoint,
            plans: Arc::default(),
            attempts: Arc::default(),
            made: Arc::default(),
            dropped: Arc::default(),
        }
    }

    fn fail_next(&self, plans: impl IntoIterator<Item = Fail>) {
        self.plans.lock().unwrap().extend(plans);
    }

    fn attempts(&self) -> u32 {
        self.attempts.load(Ordering::SeqCst)
    }
}

struct RelayTransport {
    id: u32,
    task: tokio::task::JoinHandle<()>,
    dropped: Arc<AtomicU32>,
    cut: Arc<AtomicBool>,
}

impl Transport for RelayTransport {
    fn id(&self) -> Option<u32> {
        Some(self.id)
    }

    fn cut(&mut self) {
        self.cut.store(true, Ordering::SeqCst);
        self.task.abort();
    }
}

impl Drop for RelayTransport {
    fn drop(&mut self) {
        self.task.abort();
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

impl Connector for Relay {
    fn connect(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Established, ConnectFailure>> + Send + '_>>
    {
        Box::pin(async move {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            if let Some(Fail { message, permanent }) = self.plans.lock().unwrap().pop_front() {
                return Err(ConnectFailure {
                    message: message.to_owned(),
                    permanent,
                });
            }
            let mut daemon = ipc::connect(&self.endpoint)
                .await
                .map_err(|e| ConnectFailure {
                    message: format!("the daemon is not there: {e}"),
                    permanent: false,
                })?;
            let (near, mut far) = tokio::io::duplex(64 * 1024);
            let task = tokio::spawn(async move {
                let _ = tokio::io::copy_bidirectional(&mut far, &mut daemon).await;
            });
            let id = self.made.fetch_add(1, Ordering::SeqCst) + 1;
            let transport = RelayTransport {
                id,
                task,
                dropped: Arc::clone(&self.dropped),
                cut: Arc::default(),
            };
            let (client, events) =
                DaemonClient::connect_stream(near)
                    .await
                    .map_err(|e| ConnectFailure {
                        message: e.to_string(),
                        permanent: false,
                    })?;
            Ok(Established {
                client,
                events,
                transport: Box::new(transport),
            })
        })
    }
}

fn fast(attempts: u32) -> BackoffPolicy {
    BackoffPolicy {
        first_delay: Duration::from_millis(10),
        max_delay: Duration::from_millis(40),
        max_attempts: attempts,
    }
}

/// Starts a daemon and a link to it.
async fn linked(policy: BackoffPolicy) -> (Daemon, Relay, ReconnectingClient, LinkEvents) {
    let daemon = Daemon::start(endpoint(), ServerConfig::default()).expect("the daemon starts");
    let relay = Relay::new(daemon.endpoint().clone());
    let (client, events) = ReconnectingClient::connect(relay.clone(), policy)
        .await
        .expect("the first connection");
    (daemon, relay, client, events)
}

/// Reads events until one satisfies `pick`; returns what `pick` returned and everything read
/// before it (so a test can check the order).
async fn until<T>(
    events: &mut LinkEvents,
    what: &str,
    mut pick: impl FnMut(&LinkEvent) -> Option<T>,
) -> (T, Vec<LinkEvent>) {
    let mut before = Vec::new();
    let outcome = tokio::time::timeout(STEP, async {
        loop {
            match events.recv().await {
                Some(event) => {
                    if let Some(found) = pick(&event) {
                        return found;
                    }
                    before.push(event);
                }
                None => panic!("the link ended before {what}; saw {before:?}"),
            }
        }
    })
    .await;
    match outcome {
        Ok(found) => (found, before),
        Err(_) => panic!("no {what} within {STEP:?}; saw {before:?}"),
    }
}

/// Waits for the output of `session` to contain `needle`.
async fn output_has(events: &mut LinkEvents, session: SessionId, needle: &str) -> String {
    let mut text = String::new();
    until(
        events,
        &format!("{needle:?} from the session"),
        |event| match event {
            LinkEvent::Output { session: id, data } if *id == session => {
                text.push_str(&String::from_utf8_lossy(data));
                text.contains(needle).then_some(())
            }
            LinkEvent::Exit { session: id, info } if *id == session => {
                panic!("the session ended ({info:?}) before it printed {needle:?}: {text:?}")
            }
            _ => None,
        },
    )
    .await;
    text
}

/// A session, attached through the link, that has printed something (see `start_session` in
/// `tests/daemon.rs` for why a session is not left to start while another is touched).
async fn attached_session(
    client: &ReconnectingClient,
    events: &mut LinkEvents,
) -> (SessionId, Option<u32>) {
    let created = client.create(&shell()).await.expect("create");
    let attached = client.attach(created.session).await.expect("attach");
    if attached.replay.is_empty() {
        until(events, "the first output", |event| match event {
            LinkEvent::Output { session, .. } if *session == created.session => Some(()),
            _ => None,
        })
        .await;
    }
    (created.session, created.pid)
}

fn is_reconnecting(event: &LinkEvent) -> bool {
    matches!(event, LinkEvent::State(LinkState::Reconnecting { .. }))
}

fn is_connected(event: &LinkEvent) -> bool {
    matches!(event, LinkEvent::State(LinkState::Connected))
}

// ---------------------------------------------------------------------------------------------
// DaemonClient over a stream
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_client_over_an_in_memory_stream_does_the_same_handshake_and_the_same_work() {
    within(async {
        let daemon = Daemon::start(endpoint(), ServerConfig::default()).expect("the daemon starts");
        let relay = Relay::new(daemon.endpoint().clone());
        let Established {
            client,
            mut events,
            transport: _transport,
        } = relay.connect().await.expect("connect through the relay");

        let created = client.create(&shell()).await.expect("create");
        client.attach(created.session).await.expect("attach");
        client
            .write(created.session, &say("stream-says-hi"))
            .await
            .expect("write");
        let mut text = String::new();
        tokio::time::timeout(STEP, async {
            while !text.contains("stream-says-hi") {
                match events.recv().await {
                    Some(ClientEvent::Output { data, .. }) => {
                        text.push_str(&String::from_utf8_lossy(&data));
                    }
                    Some(ClientEvent::Exit { .. }) | None => panic!("ended early: {text:?}"),
                }
            }
        })
        .await
        .expect("the output arrives");
        assert_eq!(client.list().await.expect("list").len(), 1);
        client.kill(created.session).await.expect("kill");
    })
    .await;
}

/// A fake server on the far end of an in-memory stream: runs `behave` with the stream.
fn fake_server<F, Fut>(behave: F) -> tokio::io::DuplexStream
where
    F: FnOnce(tokio::io::DuplexStream) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let (near, far) = tokio::io::duplex(4096);
    tokio::spawn(behave(far));
    near
}

#[tokio::test]
async fn the_handshake_over_a_stream_refuses_what_is_not_a_daemon() {
    within(async {
        // Bytes that are not a frame (a shell banner, say): a length far over the limit.
        let garbage = fake_server(|mut far| async move {
            let _ = read_frame(&mut far).await;
            let _ = write_frame(&mut far, b"\xff\xff\xff\xffWelcome to the machine\n").await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        match DaemonClient::connect_stream(garbage).await {
            Err(ClientError::Protocol(_)) => {}
            other => panic!("expected a protocol error, got {:?}", other.err()),
        }

        // A daemon of another version welcomes another version.
        let other_version = fake_server(|mut far| async move {
            let _ = read_frame(&mut far).await;
            let frame = ServerMessage::Welcome { version: 99 }.to_frame().unwrap();
            let _ = write_frame(&mut far, &frame).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        match DaemonClient::connect_stream(other_version).await {
            Err(ClientError::Protocol(ProtocolError::Unexpected(why))) => {
                assert!(why.contains("another protocol version"), "{why}");
            }
            other => panic!("expected a version refusal, got {:?}", other.err()),
        }

        // A stream that ends before the answer.
        let hangs_up = fake_server(|mut far| async move {
            let _ = read_frame(&mut far).await;
        });
        match DaemonClient::connect_stream(hangs_up).await {
            Err(ClientError::Closed | ClientError::Io(_)) => {}
            other => panic!("expected a closed connection, got {:?}", other.err()),
        }

        // Silence is a timeout, in the time asked for.
        let silent = fake_server(|mut far| async move {
            let _ = read_frame(&mut far).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let started = std::time::Instant::now();
        match DaemonClient::connect_stream_within(silent, Duration::from_millis(200)).await {
            Err(ClientError::Io(e)) => assert_eq!(e.kind(), std::io::ErrorKind::TimedOut),
            other => panic!("expected a timeout, got {:?}", other.err()),
        }
        assert!(started.elapsed() < Duration::from_secs(5));

        // Half a frame and then the end.
        let torn = fake_server(|mut far| async move {
            let _ = read_frame(&mut far).await;
            let _ = far.write_all(&[0, 0, 0, 9, 0x81]).await;
        });
        match DaemonClient::connect_stream(torn).await {
            Err(ClientError::Protocol(ProtocolError::Truncated)) => {}
            other => panic!("expected a truncated frame, got {:?}", other.err()),
        }
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// The link that comes back
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_cut_link_reconnects_and_the_same_session_answers_with_the_same_pid() {
    within(async {
        let (daemon, relay, client, mut events) = linked(fast(5)).await;
        assert_eq!(client.state(), LinkState::Connected);
        assert_eq!(client.transport_id(), Some(1));

        let (session, pid) = attached_session(&client, &mut events).await;
        assert!(pid.is_some());
        client
            .write(session, &say("before-the-cut"))
            .await
            .expect("write");
        output_has(&mut events, session, "before-the-cut").await;

        client.cut();

        // The order a person sees: reconnecting, the session attached again with the buffer
        // (which holds what was printed before the cut), connected.
        let (_, before) = until(&mut events, "the link reconnecting", |e| {
            is_reconnecting(e).then_some(())
        })
        .await;
        assert!(
            before.iter().all(|e| matches!(e, LinkEvent::Output { .. })),
            "{before:?}"
        );
        let (replay, between) = until(&mut events, "the session attached again", |e| match e {
            LinkEvent::Reattached {
                session: id,
                replay,
                exit: None,
            } if *id == session => Some(String::from_utf8_lossy(replay).into_owned()),
            _ => None,
        })
        .await;
        assert!(replay.contains("before-the-cut"), "{replay:?}");
        assert!(
            between.iter().all(is_reconnecting),
            "only reconnecting states came between: {between:?}"
        );
        until(&mut events, "the link connected", |e| {
            is_connected(e).then_some(())
        })
        .await;
        assert_eq!(client.state(), LinkState::Connected);
        assert_eq!(client.transport_id(), Some(2), "a new carrier was made");

        // Same session, same process, and it answers.
        let sessions = client.list().await.expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session, session);
        assert_eq!(sessions[0].pid, pid);
        client
            .write(session, &say("after-the-cut"))
            .await
            .expect("write");
        output_has(&mut events, session, "after-the-cut").await;
        assert_eq!(daemon.session_count(), 1, "nothing was created or lost");
        assert_eq!(relay.attempts(), 2);

        // Once more, to see that it was not a first time only.
        client.cut();
        until(&mut events, "the link connected again", |e| {
            is_connected(e).then_some(())
        })
        .await;
        assert_eq!(client.transport_id(), Some(3));
        client
            .write(session, &say("and-again"))
            .await
            .expect("write");
        output_has(&mut events, session, "and-again").await;

        client.kill(session).await.expect("kill");
        drop(client);
        // Dropping the link lets go of what carries the connection.
        tokio::time::timeout(STEP, async {
            while relay.dropped.load(Ordering::SeqCst) < 3 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("every carrier was dropped");
    })
    .await;
}

#[tokio::test]
async fn failed_attempts_back_off_up_to_the_limit_and_then_the_link_says_failed() {
    within(async {
        let (_daemon, relay, client, mut events) = linked(fast(3)).await;
        let fail = Fail {
            message: "the network is down",
            permanent: false,
        };
        relay.fail_next([fail.clone(), fail.clone(), fail]);
        client.cut();

        let (reason, seen) = until(&mut events, "the link failing", |e| match e {
            LinkEvent::State(LinkState::Failed { reason }) => Some(reason.clone()),
            _ => None,
        })
        .await;
        assert_eq!(reason, "the network is down");
        // Three attempts, each announced with the wait before it: 10 ms, 20 ms, then the cap.
        let waits: Vec<_> = seen
            .iter()
            .filter_map(|e| match e {
                LinkEvent::State(LinkState::Reconnecting {
                    attempt,
                    max_attempts,
                    retry_in,
                    reason,
                }) => Some((*attempt, *max_attempts, *retry_in, reason.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            waits,
            [
                (
                    1,
                    3,
                    Duration::from_millis(10),
                    "the connection to the daemon ended".to_owned()
                ),
                (
                    2,
                    3,
                    Duration::from_millis(20),
                    "the network is down".to_owned()
                ),
                (
                    3,
                    3,
                    Duration::from_millis(40),
                    "the network is down".to_owned()
                ),
            ]
        );
        assert_eq!(
            relay.attempts(),
            1 + 3,
            "the first connection and three attempts"
        );
        assert!(matches!(client.state(), LinkState::Failed { .. }));
        assert_eq!(client.transport_id(), None);

        // It stays failed: no attempt is made behind the person's back.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(relay.attempts(), 4);
        // Calls fail at once, they do not wait for a link that is not coming.
        assert!(matches!(client.list().await, Err(ClientError::Closed)));

        // Asking again starts over, and this time the network is back.
        client.retry_now();
        until(&mut events, "the link connected", |e| {
            is_connected(e).then_some(())
        })
        .await;
        assert_eq!(client.state(), LinkState::Connected);
        assert_eq!(relay.attempts(), 5);
        assert!(client.list().await.expect("list").is_empty());
    })
    .await;
}

#[tokio::test]
async fn a_failure_that_trying_again_cannot_fix_is_not_tried_again() {
    within(async {
        let (_daemon, relay, client, mut events) = linked(fast(10)).await;
        relay.fail_next([Fail {
            message: "Permission denied (publickey)",
            permanent: true,
        }]);
        client.cut();
        let (reason, _) = until(&mut events, "the link failing", |e| match e {
            LinkEvent::State(LinkState::Failed { reason }) => Some(reason.clone()),
            _ => None,
        })
        .await;
        assert_eq!(reason, "Permission denied (publickey)");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(relay.attempts(), 2, "one attempt, not ten");

        client.retry_now();
        until(&mut events, "the link connected", |e| {
            is_connected(e).then_some(())
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn the_first_connection_is_not_retried_and_says_why() {
    within(async {
        let daemon = Daemon::start(endpoint(), ServerConfig::default()).expect("the daemon starts");
        let relay = Relay::new(daemon.endpoint().clone());
        relay.fail_next([Fail {
            message: "Host key verification failed.",
            permanent: true,
        }]);
        let error = match ReconnectingClient::connect(relay.clone(), fast(5)).await {
            Ok(_) => panic!("the first attempt was made to fail"),
            Err(error) => error,
        };
        assert_eq!(error.message, "Host key verification failed.");
        assert!(error.permanent);
        assert_eq!(relay.attempts(), 1);
    })
    .await;
}

#[tokio::test]
async fn calls_made_while_the_link_is_down_fail_at_once_and_the_wait_can_be_cut_short() {
    within(async {
        // A wait of five seconds between attempts: the link stays down long enough to look at.
        let (_daemon, relay, client, mut events) = linked(BackoffPolicy {
            first_delay: Duration::from_secs(5),
            max_delay: Duration::from_secs(5),
            max_attempts: 3,
        })
        .await;
        let (session, _) = attached_session(&client, &mut events).await;
        client.cut();
        until(&mut events, "the link reconnecting", |e| {
            is_reconnecting(e).then_some(())
        })
        .await;
        assert!(matches!(
            client.state(),
            LinkState::Reconnecting { attempt: 1, .. }
        ));

        let started = std::time::Instant::now();
        assert!(matches!(client.list().await, Err(ClientError::Closed)));
        assert!(matches!(
            client.write(session, b"x").await,
            Err(ClientError::Closed)
        ));
        assert!(matches!(
            client.resize(session, 100, 30).await,
            Err(ClientError::Closed)
        ));
        assert!(matches!(
            client.create(&shell()).await,
            Err(ClientError::Closed)
        ));
        assert!(matches!(
            client.kill(session).await,
            Err(ClientError::Closed)
        ));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "calls do not wait for the link"
        );

        // "Try now" does not wait for the five seconds.
        let started = std::time::Instant::now();
        client.retry_now();
        let (_, between) = until(&mut events, "the link connected", |e| {
            is_connected(e).then_some(())
        })
        .await;
        assert!(started.elapsed() < Duration::from_secs(4));
        assert_eq!(relay.attempts(), 2);
        // The kill above failed, so it changed nothing: the session is still attached again.
        assert!(
            between
                .iter()
                .any(|e| matches!(e, LinkEvent::Reattached { session: id, .. } if *id == session)),
            "{between:?}"
        );
        let sessions = client.list().await.expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].attached, 1);
        client.kill(session).await.expect("kill");
    })
    .await;
}

#[tokio::test]
async fn a_session_the_daemon_lost_is_reported_and_one_that_ended_comes_back_with_its_exit() {
    within(async {
        let (daemon, _relay, client, mut events) = linked(BackoffPolicy {
            first_delay: Duration::from_secs(30),
            max_delay: Duration::from_secs(30),
            max_attempts: 3,
        })
        .await;
        let (lost, _) = attached_session(&client, &mut events).await;
        let (ended, _) = attached_session(&client, &mut events).await;
        let (kept, _) = attached_session(&client, &mut events).await;

        client.cut();
        until(&mut events, "the link reconnecting", |e| {
            is_reconnecting(e).then_some(())
        })
        .await;

        // While the link is down another client kills one session and ends another.
        let (other, mut other_events) = DaemonClient::connect(daemon.endpoint())
            .await
            .expect("a direct client");
        other.kill(lost).await.expect("kill");
        other.attach(ended).await.expect("attach");
        other.write(ended, EXIT_LINE).await.expect("write");
        tokio::time::timeout(STEP, async {
            while let Some(event) = other_events.recv().await {
                if matches!(event, ClientEvent::Exit { session, .. } if session == ended) {
                    return;
                }
            }
            panic!("the direct client lost its connection");
        })
        .await
        .expect("the shell exits");

        client.retry_now();
        let mut lost_seen = false;
        let mut reattached = Vec::new();
        until(&mut events, "the link connected", |e| {
            match e {
                LinkEvent::SessionLost { session } if *session == lost => lost_seen = true,
                LinkEvent::Reattached { session, exit, .. } => {
                    reattached.push((*session, exit.is_some()));
                }
                _ => {}
            }
            is_connected(e).then_some(())
        })
        .await;
        assert!(lost_seen, "the killed session was reported lost");
        reattached.sort();
        let mut expected = vec![(ended, true), (kept, false)];
        expected.sort();
        assert_eq!(
            reattached, expected,
            "the ended one comes with its exit, the kept one without"
        );

        // The lost and the ended sessions are not attached again after the next break; the
        // kept one is, and nothing is reported twice.
        client.cut();
        until(&mut events, "the link reconnecting", |e| {
            is_reconnecting(e).then_some(())
        })
        .await;
        client.retry_now();
        let mut again = Vec::new();
        until(&mut events, "the link connected again", |e| {
            if let LinkEvent::Reattached { session, .. } | LinkEvent::SessionLost { session } = e {
                again.push(*session);
            }
            is_connected(e).then_some(())
        })
        .await;
        assert_eq!(again, [kept]);
        client.kill(kept).await.expect("kill");
    })
    .await;
}

#[tokio::test]
async fn a_session_ended_on_the_link_is_not_attached_again_and_detached_ones_neither() {
    within(async {
        let (_daemon, _relay, client, mut events) = linked(fast(5)).await;
        let (ended, _) = attached_session(&client, &mut events).await;
        let (detached, _) = attached_session(&client, &mut events).await;
        let (kept, _) = attached_session(&client, &mut events).await;

        client.detach(detached).await.expect("detach");
        client.write(ended, EXIT_LINE).await.expect("write");
        until(&mut events, "the exit of the session", |e| match e {
            LinkEvent::Exit { session, .. } if *session == ended => Some(()),
            _ => None,
        })
        .await;

        client.cut();
        let mut attached_again = Vec::new();
        until(&mut events, "the link connected", |e| {
            if let LinkEvent::Reattached { session, .. } = e {
                attached_again.push(*session);
            }
            is_connected(e).then_some(())
        })
        .await;
        assert_eq!(
            attached_again,
            [kept],
            "only the session still attached comes back"
        );

        // The ones that ended and that were detached are still in the daemon, for the next client.
        let sessions = client.list().await.expect("list");
        assert_eq!(sessions.len(), 3);
        for session in [ended, detached, kept] {
            client.kill(session).await.expect("kill");
        }
    })
    .await;
}

#[tokio::test]
async fn an_attach_that_fails_because_the_link_is_down_is_done_when_the_link_is_back() {
    within(async {
        let (_daemon, _relay, client, mut events) = linked(BackoffPolicy {
            first_delay: Duration::from_secs(30),
            max_delay: Duration::from_secs(30),
            max_attempts: 3,
        })
        .await;
        let created = client.create(&shell()).await.expect("create");
        // Not attached yet. The link breaks, and the attach is asked for while it is down.
        client.cut();
        until(&mut events, "the link reconnecting", |e| {
            is_reconnecting(e).then_some(())
        })
        .await;
        assert!(matches!(
            client.attach(created.session).await,
            Err(ClientError::Closed)
        ));
        client.retry_now();
        let (_, between) = until(&mut events, "the link connected", |e| {
            is_connected(e).then_some(())
        })
        .await;
        assert!(
            between.iter().any(|e| matches!(
                e,
                LinkEvent::Reattached { session, .. } if *session == created.session
            )),
            "the session was attached when the link came back: {between:?}"
        );
        client
            .write(created.session, &say("late-attach"))
            .await
            .expect("write");
        output_has(&mut events, created.session, "late-attach").await;
        client.kill(created.session).await.expect("kill");
    })
    .await;
}

//! Integration tests of the session daemon: a real `Daemon` on a real named pipe or Unix socket,
//! real clients on the same machine, and real shells in real PTYs (`cmd.exe` on Windows, `sh`
//! elsewhere), as in `tests/pty.rs`. The daemon runs on its own thread with its own runtime and
//! the tests are its clients, so they cross the same boundary a second process would; nothing
//! here reaches the network. Every endpoint has its own name (process id and a counter), so the
//! tests run in parallel without meeting each other.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use noren_core::SpawnSpec;
use noren_core::daemon::ipc;
use noren_core::daemon::{
    ClientError, ClientEvent, ClientEvents, ClientMessage, Daemon, DaemonClient, Endpoint,
    ErrorCode, FrameError, PROTOCOL_VERSION, Request, Response, ServerConfig, ServerMessage,
    read_frame, write_frame,
};
use noren_core::pty::SessionId;

/// Longest a whole test may take.
const TEST_TIMEOUT: Duration = Duration::from_secs(120);
/// Longest one wait inside a test may take.
const STEP: Duration = Duration::from_secs(20);

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn endpoint() -> Endpoint {
    let name = format!(
        "test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    );
    Endpoint::named(&name).expect("a valid endpoint name")
}

fn start(config: ServerConfig) -> Daemon {
    Daemon::start(endpoint(), config).expect("the daemon starts")
}

async fn connect(daemon: &Daemon) -> (DaemonClient, ClientEvents) {
    DaemonClient::connect(daemon.endpoint())
        .await
        .expect("connect to the daemon")
}

/// Keeps the tests of this file from running at the same time. They share one process, and on a
/// Windows machine whose `conpty.dll` is not the system's (see `start_session`) one test ending a
/// session while another is starting its own can block the first for as long as the second one
/// lives. The tests still cover the same ground; they only take turns.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Runs a test body under a timeout, so a hang is a failure and not a stuck build.
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

/// An interactive shell that stays until it is killed.
#[cfg(windows)]
fn shell() -> SpawnSpec {
    spec("cmd.exe", &["/k"])
}
#[cfg(not(windows))]
fn shell() -> SpawnSpec {
    spec("sh", &[])
}

/// A program that prints a word and ends by itself.
#[cfg(windows)]
fn echo_once() -> SpawnSpec {
    spec("cmd.exe", &["/c", "echo noren-done"])
}
#[cfg(not(windows))]
fn echo_once() -> SpawnSpec {
    spec("sh", &["-c", "echo noren-done"])
}

/// A process that prints something at once and then stays alive for about 30 s unless killed.
#[cfg(windows)]
fn long_lived() -> SpawnSpec {
    spec("ping.exe", &["-n", "30", "127.0.0.1"])
}
#[cfg(not(windows))]
fn long_lived() -> SpawnSpec {
    spec("sh", &["-c", "echo up; exec sleep 30"])
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

/// Reads the output events of `session` until `needle` has shown up; returns all the text read.
async fn wait_for(events: &mut ClientEvents, session: SessionId, needle: &str) -> String {
    wait_for_within(events, session, needle, STEP).await
}

async fn wait_for_within(
    events: &mut ClientEvents,
    session: SessionId,
    needle: &str,
    limit: Duration,
) -> String {
    let mut text = String::new();
    let outcome = tokio::time::timeout(limit, async {
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
    assert!(
        outcome.is_ok(),
        "no {needle:?} within {limit:?}; saw {text:?}"
    );
    text
}

/// Takes what is already queued, so the next read starts at a known point.
fn drain(events: &mut ClientEvents) {
    while events.try_recv().is_some() {}
}

/// Starts a session, attaches to it and waits until it has printed something.
///
/// Every test that has more than one session alive goes through this, and the reason is not in
/// the daemon: on Windows, when the `conpty.dll` that gets loaded is not the one of the system
/// (portable-pty prefers a copy that sits next to the application or on the PATH, and a terminal
/// program installed on the machine can provide one), ending a session while another one is
/// still starting can block for as long as the other lives. Output is the sign that the pseudo
/// console has finished starting. Reproduced without the daemon, with `SessionManager` alone.
async fn start_session(
    client: &DaemonClient,
    events: &mut ClientEvents,
    spec: &SpawnSpec,
) -> SessionId {
    let session = client.create(spec).await.expect("create").session;
    let attached = client.attach(session).await.expect("attach");
    if attached.replay.is_empty() {
        let outcome = tokio::time::timeout(STEP, async {
            loop {
                match events.recv().await {
                    Some(ClientEvent::Output { session: id, .. }) if id == session => return,
                    Some(_) => {}
                    None => panic!("the connection ended before the session printed anything"),
                }
            }
        })
        .await;
        assert!(
            outcome.is_ok(),
            "the session printed nothing within {STEP:?}"
        );
    }
    session
}

fn server_error(result: Result<impl std::fmt::Debug, ClientError>) -> ErrorCode {
    match result {
        Err(ClientError::Server(body)) => body.code,
        other => panic!("expected an error from the daemon, got {other:?}"),
    }
}

/// Polls until `check` says yes, for at most `STEP`.
async fn until<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + STEP;
    while !check().await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "gave up waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn a_client_creates_a_session_writes_to_it_and_reads_the_output() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, mut events) = connect(&daemon).await;

        let created = client.create(&shell()).await.expect("create");
        assert!(created.pid.is_some(), "a live session has a pid");
        let attached = client.attach(created.session).await.expect("attach");
        assert_eq!(attached.exit, None);

        client
            .write(created.session, &say("noren-first-ok"))
            .await
            .expect("write");
        wait_for(&mut events, created.session, "noren-first-ok").await;

        let sessions = client.list().await.expect("list");
        assert_eq!(sessions.len(), 1);
        let info = &sessions[0];
        assert_eq!(info.session, created.session);
        assert_eq!(info.pid, created.pid);
        assert_eq!((info.cols, info.rows), (80, 24));
        assert_eq!(info.attached, 1);
        assert!(info.buffered > 0);
        assert_eq!(info.exit, None);
        assert_eq!(daemon.session_count(), 1);

        client.kill(created.session).await.expect("kill");
        assert_eq!(daemon.session_count(), 0);
    })
    .await;
}

#[tokio::test]
async fn detach_write_while_detached_and_reattach_returns_the_buffer() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, mut events) = connect(&daemon).await;
        // A second connection stays attached the whole time. Seeing a word on it proves the
        // daemon has that word in the buffer, which is what the first client needs to know.
        let (observer, mut observer_events) = connect(&daemon).await;

        let session = client.create(&shell()).await.expect("create").session;
        client.attach(session).await.expect("attach");
        observer.attach(session).await.expect("observer attach");

        client
            .write(session, &say("alpha-one"))
            .await
            .expect("write");
        wait_for(&mut events, session, "alpha-one").await;
        wait_for(&mut observer_events, session, "alpha-one").await;

        client.detach(session).await.expect("detach");
        // Output queued before the detach is ahead of its answer, so it is all in by now.
        drain(&mut events);
        assert_eq!(client.list().await.unwrap()[0].attached, 1);

        // Writing does not need an attachment.
        client
            .write(session, &say("beta-two"))
            .await
            .expect("write while detached");
        wait_for(&mut observer_events, session, "beta-two").await;
        assert!(
            events.try_recv().is_none(),
            "a detached client is sent nothing"
        );

        let again = client.attach(session).await.expect("attach again");
        let replay = String::from_utf8_lossy(&again.replay).into_owned();
        let alpha = replay
            .find("alpha-one")
            .expect("the buffer has the first word");
        let beta = replay
            .find("beta-two")
            .expect("the buffer has the word written while detached");
        assert!(alpha < beta, "in the order it was printed: {replay:?}");
        assert_eq!(again.exit, None);

        // What happens next arrives as events, and the buffer is not sent a second time.
        client
            .write(session, &say("gamma-three"))
            .await
            .expect("write");
        let text = wait_for(&mut events, session, "gamma-three").await;
        assert!(
            !text.contains("alpha-one") && !text.contains("beta-two"),
            "the events carry only what came after the buffer: {text:?}"
        );
        assert_eq!(client.list().await.unwrap()[0].attached, 2);
    })
    .await;
}

#[tokio::test]
async fn a_session_outlives_its_client_and_a_new_connection_gets_the_buffer() {
    within(async {
        let daemon = start(ServerConfig::default());

        let (first, mut first_events) = connect(&daemon).await;
        let created = first.create(&shell()).await.expect("create");
        let session = created.session;
        first.attach(session).await.expect("attach");
        first
            .write(session, &say("survive-one"))
            .await
            .expect("write");
        wait_for(&mut first_events, session, "survive-one").await;
        drop(first);
        drop(first_events);

        // The client is gone; the shell is not.
        let (second, mut second_events) = connect(&daemon).await;
        until("the daemon to notice the first client left", || async {
            second.list().await.unwrap()[0].attached == 0
        })
        .await;
        let sessions = second.list().await.expect("list");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].pid, created.pid, "the same process");
        assert_eq!(sessions[0].exit, None);

        let attached = second.attach(session).await.expect("attach");
        assert!(
            String::from_utf8_lossy(&attached.replay).contains("survive-one"),
            "the buffer holds what was printed while nobody watched"
        );
        second
            .write(session, &say("survive-two"))
            .await
            .expect("write");
        wait_for(&mut second_events, session, "survive-two").await;
        drop(second);
        drop(second_events);

        let (third, _third_events) = connect(&daemon).await;
        let attached = third.attach(session).await.expect("attach");
        let replay = String::from_utf8_lossy(&attached.replay).into_owned();
        assert!(replay.contains("survive-one") && replay.contains("survive-two"));
        assert_eq!(daemon.session_count(), 1);
    })
    .await;
}

#[tokio::test]
async fn two_clients_attached_to_one_session_both_get_the_output() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (a, mut a_events) = connect(&daemon).await;
        let (b, mut b_events) = connect(&daemon).await;
        let session = a.create(&shell()).await.expect("create").session;
        a.attach(session).await.expect("a attach");
        b.attach(session).await.expect("b attach");
        assert_eq!(a.list().await.unwrap()[0].attached, 2);

        // Either one may write; both read.
        a.write(session, &say("from-a")).await.unwrap();
        wait_for(&mut a_events, session, "from-a").await;
        wait_for(&mut b_events, session, "from-a").await;
        b.write(session, &say("from-b")).await.unwrap();
        wait_for(&mut a_events, session, "from-b").await;
        wait_for(&mut b_events, session, "from-b").await;

        // When b leaves, a still hears everything and b hears nothing.
        b.detach(session).await.unwrap();
        drain(&mut b_events);
        a.write(session, &say("after-b-left")).await.unwrap();
        wait_for(&mut a_events, session, "after-b-left").await;
        assert!(b_events.try_recv().is_none());
        assert_eq!(a.list().await.unwrap()[0].attached, 1);
    })
    .await;
}

#[tokio::test]
async fn kill_ends_the_session_and_attached_clients_hear_the_exit() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, mut events) = connect(&daemon).await;
        let (watcher, mut watcher_events) = connect(&daemon).await;
        let session = client.create(&long_lived()).await.expect("create").session;
        client.attach(session).await.unwrap();
        watcher.attach(session).await.unwrap();

        client.kill(session).await.expect("kill");
        assert_eq!(daemon.session_count(), 0);
        assert_eq!(daemon.live_threads(), 0, "the session threads were joined");
        assert!(client.list().await.unwrap().is_empty());

        // The exit event is already queued when the kill is answered, for every attachment.
        for stream in [&mut events, &mut watcher_events] {
            let info = loop {
                match stream.recv().await.expect("an event") {
                    ClientEvent::Exit { session: id, info } => {
                        assert_eq!(id, session);
                        break info;
                    }
                    ClientEvent::Output { .. } => {}
                }
            };
            assert_ne!(info.code, 0, "a killed process does not exit cleanly");
        }

        // The session is gone for good.
        assert_eq!(
            server_error(client.write(session, b"x").await),
            ErrorCode::UnknownSession
        );
        assert_eq!(
            server_error(client.kill(session).await),
            ErrorCode::UnknownSession
        );
    })
    .await;
}

#[tokio::test]
async fn a_process_that_ends_on_its_own_is_reported_and_its_output_is_kept() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, mut events) = connect(&daemon).await;
        let session = client.create(&echo_once()).await.expect("create").session;

        // The process may be done before the attach: then the answer carries everything, else
        // the events do.
        let attached = client.attach(session).await.expect("attach");
        let mut text = String::from_utf8_lossy(&attached.replay).into_owned();
        let mut exit = attached.exit;
        while exit.is_none() {
            match events.recv().await.expect("an event") {
                ClientEvent::Output { data, .. } => text.push_str(&String::from_utf8_lossy(&data)),
                ClientEvent::Exit { info, .. } => exit = Some(info),
            }
        }
        assert!(text.contains("noren-done"), "{text:?}");
        assert_eq!(exit.as_ref().map(|e| e.code), Some(0));

        // The session stays, ended, until somebody releases it.
        let info = client.list().await.unwrap().remove(0);
        assert_eq!(info.exit.as_ref().map(|e| e.code), Some(0));
        assert_eq!(info.attached, 0);
        assert_eq!(
            server_error(client.write(session, b"x").await),
            ErrorCode::SessionClosed
        );
        let again = client
            .attach(session)
            .await
            .expect("attach an ended session");
        assert!(String::from_utf8_lossy(&again.replay).contains("noren-done"));
        assert_eq!(again.exit.as_ref().map(|e| e.code), Some(0));
        assert!(
            events.try_recv().is_none(),
            "an ended session sends nothing more"
        );

        client.kill(session).await.expect("release");
        assert!(client.list().await.unwrap().is_empty());
        assert_eq!(daemon.live_threads(), 0);
    })
    .await;
}

#[tokio::test]
async fn resize_is_applied_and_checked() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, _events) = connect(&daemon).await;
        let session = client.create(&long_lived()).await.unwrap().session;

        client.resize(session, 120, 40).await.expect("resize");
        let info = client.list().await.unwrap().remove(0);
        assert_eq!((info.cols, info.rows), (120, 40));
        assert_eq!(
            server_error(client.resize(session, 0, 10).await),
            ErrorCode::InvalidSize
        );
        assert_eq!(
            server_error(client.resize(session, 10, 0).await),
            ErrorCode::InvalidSize
        );
        let info = client.list().await.unwrap().remove(0);
        assert_eq!(
            (info.cols, info.rows),
            (120, 40),
            "a refused size changes nothing"
        );

        let mut bad_start = long_lived();
        bad_start.cols = 0;
        assert_eq!(
            server_error(client.create(&bad_start).await),
            ErrorCode::InvalidSize
        );
        assert_eq!(client.list().await.unwrap().len(), 1);
    })
    .await;
}

#[tokio::test]
async fn a_session_that_does_not_exist_is_an_error_for_every_call() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, _events) = connect(&daemon).await;
        let nobody = SessionId(999);
        let unknown = ErrorCode::UnknownSession;
        assert_eq!(server_error(client.write(nobody, b"x").await), unknown);
        assert_eq!(server_error(client.resize(nobody, 80, 24).await), unknown);
        assert_eq!(server_error(client.attach(nobody).await), unknown);
        assert_eq!(server_error(client.detach(nobody).await), unknown);
        assert_eq!(server_error(client.kill(nobody).await), unknown);
        assert!(client.list().await.unwrap().is_empty());
    })
    .await;
}

#[tokio::test]
async fn a_program_that_cannot_start_is_an_error_and_leaves_nothing_behind() {
    within(async {
        let daemon = start(ServerConfig::default());
        let (client, mut events) = connect(&daemon).await;
        let missing = spec("noren-no-such-program-for-the-daemon-test", &[]);
        assert_eq!(
            server_error(client.create(&missing).await),
            ErrorCode::Spawn
        );
        assert!(client.list().await.unwrap().is_empty());
        assert_eq!(daemon.session_count(), 0);
        // And the daemon is fine.
        start_session(&client, &mut events, &long_lived()).await;
        assert_eq!(client.list().await.unwrap().len(), 1);
    })
    .await;
}

#[tokio::test]
async fn the_number_of_sessions_is_limited() {
    within(async {
        let daemon = start(ServerConfig {
            max_sessions: 2,
            ..ServerConfig::default()
        });
        let (client, mut events) = connect(&daemon).await;
        let first = start_session(&client, &mut events, &long_lived()).await;
        start_session(&client, &mut events, &long_lived()).await;
        assert_eq!(
            server_error(client.create(&long_lived()).await),
            ErrorCode::TooManySessions
        );
        client.kill(first).await.unwrap();
        start_session(&client, &mut events, &long_lived()).await; // a slot is free again
        assert_eq!(client.list().await.unwrap().len(), 2);
    })
    .await;
}

#[tokio::test]
async fn the_buffer_of_a_session_keeps_only_the_latest_bytes() {
    within(async {
        let daemon = start(ServerConfig {
            buffer_bytes: 600,
            ..ServerConfig::default()
        });
        let (client, mut events) = connect(&daemon).await;
        let session = client.create(&shell()).await.unwrap().session;
        client.attach(session).await.unwrap();

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
        assert!(
            replay.contains("last-mark"),
            "the newest output is kept: {replay:?}"
        );
        assert!(
            !replay.contains("first-mark"),
            "the oldest is dropped: {replay:?}"
        );
        assert!(client.list().await.unwrap()[0].buffered <= 600);
    })
    .await;
}

// ---- the conversation itself, spoken by hand ----

async fn raw_connect(daemon: &Daemon) -> ipc::ClientStream {
    ipc::connect(daemon.endpoint()).await.expect("connect")
}

async fn raw_send(stream: &mut ipc::ClientStream, message: &ClientMessage) {
    let frame = message.to_frame().expect("a frame");
    write_frame(stream, &frame).await.expect("write a frame");
}

async fn raw_next(stream: &mut ipc::ClientStream) -> Result<ServerMessage, FrameError> {
    let payload = tokio::time::timeout(STEP, read_frame(stream))
        .await
        .expect("an answer in time")?;
    Ok(ServerMessage::decode(&payload).expect("a message the client can read"))
}

async fn raw_hello(daemon: &Daemon) -> ipc::ClientStream {
    let mut stream = raw_connect(daemon).await;
    raw_send(
        &mut stream,
        &ClientMessage::Hello {
            version: PROTOCOL_VERSION,
        },
    )
    .await;
    match raw_next(&mut stream).await {
        Ok(ServerMessage::Welcome { version }) => assert_eq!(version, PROTOCOL_VERSION),
        other => panic!("expected Welcome, got {other:?}"),
    }
    stream
}

/// The daemon answers a healthy client, so whatever came before did not hurt it.
async fn assert_still_serving(daemon: &Daemon) {
    let (client, _events) = connect(daemon).await;
    client.list().await.expect("the daemon still answers");
}

#[tokio::test]
async fn a_request_is_answered_with_its_own_id() {
    within(async {
        let daemon = start(ServerConfig::default());
        let mut stream = raw_hello(&daemon).await;
        for id in [77, 5, u32::MAX] {
            raw_send(
                &mut stream,
                &ClientMessage::Request {
                    id,
                    request: Request::List,
                },
            )
            .await;
            match raw_next(&mut stream).await {
                Ok(ServerMessage::Response {
                    id: answered,
                    response: Response::Sessions(sessions),
                }) => {
                    assert_eq!(answered, id);
                    assert!(sessions.is_empty());
                }
                other => panic!("expected the list, got {other:?}"),
            }
        }
    })
    .await;
}

#[tokio::test]
async fn a_client_of_another_protocol_version_is_refused_with_a_clear_message() {
    within(async {
        let daemon = start(ServerConfig::default());
        let other_version = PROTOCOL_VERSION + 98;

        let mut stream = raw_connect(&daemon).await;
        raw_send(
            &mut stream,
            &ClientMessage::Hello {
                version: other_version,
            },
        )
        .await;
        match raw_next(&mut stream).await {
            Ok(ServerMessage::Error(body)) => {
                assert_eq!(body.code, ErrorCode::VersionMismatch);
                assert!(
                    body.message.contains(&other_version.to_string())
                        && body.message.contains(&PROTOCOL_VERSION.to_string()),
                    "the message names both versions: {}",
                    body.message
                );
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(
            matches!(raw_next(&mut stream).await, Err(FrameError::Closed)),
            "the connection is closed after the refusal"
        );

        // A newer greeting with fields this daemon does not know is refused the same way.
        let mut stream = raw_connect(&daemon).await;
        let mut hello = ClientMessage::Hello {
            version: other_version,
        }
        .to_frame()
        .unwrap();
        hello.extend_from_slice(b"fields of a later version");
        let len = u32::try_from(hello.len() - 4).unwrap();
        hello[..4].copy_from_slice(&len.to_be_bytes());
        write_frame(&mut stream, &hello).await.unwrap();
        match raw_next(&mut stream).await {
            Ok(ServerMessage::Error(body)) => assert_eq!(body.code, ErrorCode::VersionMismatch),
            other => panic!("expected a refusal, got {other:?}"),
        }

        assert_still_serving(&daemon).await;
    })
    .await;
}

#[tokio::test]
async fn a_connection_that_breaks_the_protocol_is_cut_and_the_daemon_goes_on() {
    within(async {
        let daemon = start(ServerConfig::default());

        // A request before the greeting.
        let mut stream = raw_connect(&daemon).await;
        raw_send(
            &mut stream,
            &ClientMessage::Request {
                id: 1,
                request: Request::List,
            },
        )
        .await;
        match raw_next(&mut stream).await {
            Ok(ServerMessage::Error(body)) => assert_eq!(body.code, ErrorCode::Protocol),
            other => panic!("expected a protocol error, got {other:?}"),
        }
        assert!(matches!(
            raw_next(&mut stream).await,
            Err(FrameError::Closed)
        ));

        // A frame that announces more than the limit, after a good greeting.
        let mut stream = raw_hello(&daemon).await;
        let too_big = u32::MAX.to_be_bytes();
        write_frame(&mut stream, &too_big).await.unwrap();
        match raw_next(&mut stream).await {
            Ok(ServerMessage::Error(body)) => {
                assert_eq!(body.code, ErrorCode::Protocol);
                assert!(body.message.contains("limit"), "{}", body.message);
            }
            other => panic!("expected a protocol error, got {other:?}"),
        }
        assert!(matches!(
            raw_next(&mut stream).await,
            Err(FrameError::Closed)
        ));

        // A frame with a tag that names nothing.
        let mut stream = raw_hello(&daemon).await;
        let garbage = [0, 0, 0, 3, 0x7f, 1, 2];
        write_frame(&mut stream, &garbage).await.unwrap();
        match raw_next(&mut stream).await {
            Ok(ServerMessage::Error(body)) => assert_eq!(body.code, ErrorCode::Protocol),
            other => panic!("expected a protocol error, got {other:?}"),
        }

        // A second greeting.
        let mut stream = raw_hello(&daemon).await;
        raw_send(
            &mut stream,
            &ClientMessage::Hello {
                version: PROTOCOL_VERSION,
            },
        )
        .await;
        match raw_next(&mut stream).await {
            Ok(ServerMessage::Error(body)) => assert_eq!(body.code, ErrorCode::Protocol),
            other => panic!("expected a protocol error, got {other:?}"),
        }

        // A client that leaves in the middle of a frame.
        let mut stream = raw_hello(&daemon).await;
        write_frame(&mut stream, &[0, 0, 0, 40, 0x16, 0])
            .await
            .unwrap();
        drop(stream);

        assert_still_serving(&daemon).await;
    })
    .await;
}

#[tokio::test]
async fn a_connection_that_says_nothing_is_closed() {
    within(async {
        let daemon = start(ServerConfig {
            handshake_timeout: Duration::from_millis(300),
            ..ServerConfig::default()
        });
        let mut silent = raw_connect(&daemon).await;
        assert!(
            matches!(
                raw_next(&mut silent).await,
                Err(FrameError::Closed | FrameError::Io(_))
            ),
            "the daemon gave up on the silent connection"
        );
        assert_still_serving(&daemon).await;
    })
    .await;
}

#[tokio::test]
async fn a_client_that_does_not_read_is_cut_without_stopping_the_session_or_the_others() {
    within(async {
        let daemon = start(ServerConfig {
            client_queue_frames: 2,
            ..ServerConfig::default()
        });
        let (watcher, mut watcher_events) = connect(&daemon).await;
        let session = watcher.create(&shell()).await.unwrap().session;
        watcher.attach(session).await.unwrap();

        // A client that attaches and then never reads another byte.
        let mut stuck = raw_hello(&daemon).await;
        raw_send(
            &mut stuck,
            &ClientMessage::Request {
                id: 1,
                request: Request::Attach { session },
            },
        )
        .await;
        assert!(matches!(
            raw_next(&mut stuck).await,
            Ok(ServerMessage::Response {
                response: Response::Attached { .. },
                ..
            })
        ));
        assert_eq!(watcher.list().await.unwrap()[0].attached, 2);

        // Output far beyond what the pipe and the queue can hold, then a marker.
        #[cfg(windows)]
        let flood = "for /l %i in (1,1,20000) do @echo flood-padding-padding-padding-%i\r";
        #[cfg(not(windows))]
        let flood = "seq -f 'flood-padding-padding-padding-%g' 1 20000\n";
        watcher.write(session, flood.as_bytes()).await.unwrap();
        watcher.write(session, &say("flood-over")).await.unwrap();
        wait_for_within(
            &mut watcher_events,
            session,
            "flood-over",
            Duration::from_secs(90),
        )
        .await;

        // The session went on and the other client heard all of it. Only the stuck one was cut.
        until("the stuck client to be cut", || async {
            watcher.list().await.unwrap()[0].attached == 1
        })
        .await;
        assert_eq!(daemon.session_count(), 1);
        let mut frames = 0;
        let ended = loop {
            match raw_next(&mut stuck).await {
                Ok(_) => frames += 1,
                Err(e) => break e,
            }
        };
        assert!(frames > 0, "it was served until it fell behind");
        assert!(
            matches!(
                ended,
                FrameError::Closed | FrameError::Io(_) | FrameError::Protocol(_)
            ),
            "{ended:?}"
        );

        // It can come back and is given the buffer again.
        let (back, _events) = connect(&daemon).await;
        let attached = back.attach(session).await.unwrap();
        assert!(String::from_utf8_lossy(&attached.replay).contains("flood-over"));
    })
    .await;
}

#[tokio::test]
async fn a_second_daemon_on_the_same_endpoint_is_refused() {
    within(async {
        let mut daemon = start(ServerConfig::default());
        let endpoint = daemon.endpoint().clone();
        let second = Daemon::start(endpoint.clone(), ServerConfig::default());
        assert!(second.is_err(), "the endpoint is taken");
        assert_still_serving(&daemon).await;

        // Once the first is gone the name is free again.
        daemon.shutdown();
        let mut again = Daemon::start(endpoint, ServerConfig::default()).expect("the name is free");
        assert_still_serving(&again).await;
        again.shutdown();
    })
    .await;
}

#[tokio::test]
async fn shutting_down_kills_every_session_and_joins_the_threads() {
    within(async {
        let mut daemon = start(ServerConfig::default());
        let endpoint = daemon.endpoint().clone();
        let (client, mut events) = connect(&daemon).await;
        for _ in 0..3 {
            start_session(&client, &mut events, &long_lived()).await;
        }
        assert_eq!(daemon.session_count(), 3);
        assert_eq!(daemon.live_threads(), 9, "reader, pump and waiter each");

        daemon.shutdown();
        assert_eq!(daemon.session_count(), 0);
        assert_eq!(daemon.live_threads(), 0);
        daemon.shutdown(); // a second call changes nothing

        // The clients see the connection end, and nothing listens any more.
        loop {
            if events.recv().await.is_none() {
                break;
            }
        }
        assert!(matches!(client.list().await, Err(ClientError::Closed)));
        assert!(
            matches!(
                DaemonClient::connect(&endpoint).await,
                Err(ClientError::Connect(_))
            ),
            "nothing listens at the endpoint"
        );
        #[cfg(unix)]
        assert!(
            !std::path::Path::new(endpoint.address()).exists(),
            "the socket file is removed"
        );
    })
    .await;
}

#[tokio::test]
async fn dropping_the_daemon_also_shuts_it_down() {
    within(async {
        let daemon = start(ServerConfig::default());
        let endpoint = daemon.endpoint().clone();
        let (client, _events) = connect(&daemon).await;
        client.create(&long_lived()).await.unwrap();
        drop(daemon);
        assert!(DaemonClient::connect(&endpoint).await.is_err());
    })
    .await;
}

#[tokio::test]
async fn many_clients_work_at_once() {
    within(async {
        const CLIENTS: usize = 8;
        let daemon = start(ServerConfig::default());
        // All the sessions are up before any is ended (see `start_session`).
        let all_started = Arc::new(tokio::sync::Barrier::new(CLIENTS));
        let mut tasks = Vec::new();
        for n in 0..CLIENTS {
            let endpoint = daemon.endpoint().clone();
            let all_started = Arc::clone(&all_started);
            tasks.push(tokio::spawn(async move {
                let (client, mut events) = DaemonClient::connect(&endpoint).await.unwrap();
                let session = start_session(&client, &mut events, &shell()).await;
                all_started.wait().await;
                let marker = format!("client-{n}-says-hi");
                client.write(session, &say(&marker)).await.unwrap();
                let text = wait_for(&mut events, session, &marker).await;
                for other in (0..CLIENTS).filter(|other| *other != n) {
                    assert!(
                        !text.contains(&format!("client-{other}-says-hi")),
                        "client {n} was sent the output of client {other}"
                    );
                }
                (client, session)
            }));
        }
        let mut finished = Vec::new();
        for task in tasks {
            finished.push(task.await.expect("a client finished"));
        }
        assert_eq!(daemon.session_count(), CLIENTS);
        for (client, session) in finished {
            client.kill(session).await.unwrap();
        }
        assert_eq!(daemon.session_count(), 0);
        assert_eq!(daemon.live_threads(), 0);
    })
    .await;
}

#[cfg(unix)]
mod unix_only {
    use std::fs;
    use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    use super::*;

    fn private_dir_name() -> PathBuf {
        std::env::temp_dir().join(format!(
            "nd-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().mode() & 0o777
    }

    #[tokio::test]
    async fn the_daemon_makes_a_private_folder_and_a_private_socket() {
        within(async {
            let dir = private_dir_name();
            let endpoint = Endpoint::in_dir(&dir, "daemon").unwrap();
            let mut daemon = Daemon::start(endpoint, ServerConfig::default()).unwrap();
            let socket = dir.join("daemon.sock");
            assert_eq!(mode(&dir), 0o700, "only the user may enter the folder");
            assert_eq!(mode(&socket), 0o600, "only the user may open the socket");
            assert!(
                fs::symlink_metadata(&socket)
                    .unwrap()
                    .file_type()
                    .is_socket()
            );
            assert_still_serving(&daemon).await;

            daemon.shutdown();
            assert!(!socket.exists());
            fs::remove_dir(&dir).unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn the_daemon_does_not_start_in_a_folder_others_can_enter() {
        within(async {
            let dir = private_dir_name();
            fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            let endpoint = Endpoint::in_dir(&dir, "daemon").unwrap();

            let error = Daemon::start(endpoint.clone(), ServerConfig::default())
                .err()
                .expect("a shared folder is refused");
            assert_eq!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied,
                "{error}"
            );
            assert!(!dir.join("daemon.sock").exists());
            assert!(matches!(
                DaemonClient::connect(&endpoint).await,
                Err(ClientError::Connect(_))
            ));
            fs::remove_dir(&dir).unwrap();
        })
        .await;
    }

    #[tokio::test]
    async fn a_socket_left_by_a_daemon_that_was_killed_does_not_block_the_next_one() {
        within(async {
            let dir = private_dir_name();
            let endpoint = Endpoint::in_dir(&dir, "daemon").unwrap();
            // Leave the file behind the way a killed process does: bind, then drop the listener
            // without removing the file.
            let leftover = std::os::unix::net::UnixListener::bind({
                fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
                dir.join("daemon.sock")
            })
            .unwrap();
            drop(leftover);
            assert!(dir.join("daemon.sock").exists());

            let mut daemon = Daemon::start(endpoint, ServerConfig::default()).unwrap();
            assert_still_serving(&daemon).await;
            daemon.shutdown();
            fs::remove_dir(&dir).unwrap();
        })
        .await;
    }
}

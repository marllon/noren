//! The SSH transport against a real OpenSSH server in a Docker container on this machine.
//!
//! Ignored by default: `cargo test` (and so `pnpm verify`) needs neither Docker nor `ssh`. Run it
//! with `pnpm test:ssh`, which builds the image (an sshd and a `norend` compiled for Linux),
//! starts the container, makes the keys and known hosts files, passes their paths in the
//! `NOREN_SSH_TEST_*` variables read below, runs this file with `--ignored`, and removes the
//! container, the image and the files afterwards, whatever the result.
//!
//! The client is what an app would use: [`SshTarget`] with the `ssh` of the system (on Windows the
//! OpenSSH of `System32`, started without a window), inside a [`ReconnectingClient`]. The only
//! address involved is the port the container published on 127.0.0.1.

use std::time::Duration;

use noren_core::SpawnSpec;
use noren_core::daemon::{
    BackoffPolicy, LinkEvent, LinkEvents, LinkState, ReconnectingClient, SshFailure, SshTarget,
};
use noren_core::pty::SessionId;

const STEP: Duration = Duration::from_secs(60);

/// What `pnpm test:ssh` tells this test about the container.
struct Fixture {
    host: String,
    port: u16,
    user: String,
    key: String,
    stranger_key: String,
    known_hosts: String,
    wrong_known_hosts: String,
    empty_known_hosts: String,
    config: String,
}

fn fixture() -> Fixture {
    let var = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| {
            panic!(
                "{name} is not set: this test needs the container that `pnpm test:ssh` starts; \
                 run that instead of the test by hand"
            )
        })
    };
    Fixture {
        host: var("NOREN_SSH_TEST_HOST"),
        port: var("NOREN_SSH_TEST_PORT").parse().expect("a port"),
        user: var("NOREN_SSH_TEST_USER"),
        key: var("NOREN_SSH_TEST_KEY"),
        stranger_key: var("NOREN_SSH_TEST_STRANGER_KEY"),
        known_hosts: var("NOREN_SSH_TEST_KNOWN_HOSTS"),
        wrong_known_hosts: var("NOREN_SSH_TEST_WRONG_KNOWN_HOSTS"),
        empty_known_hosts: var("NOREN_SSH_TEST_EMPTY_KNOWN_HOSTS"),
        config: var("NOREN_SSH_TEST_CONFIG"),
    }
}

impl Fixture {
    /// The target that is supposed to work.
    fn target(&self) -> SshTarget {
        let mut target = SshTarget::new(self.host.clone());
        target.user = Some(self.user.clone());
        target.port = Some(self.port);
        target.identity_file = Some(self.key.clone().into());
        target.known_hosts_file = Some(self.known_hosts.clone().into());
        target.config_file = Some(self.config.clone().into());
        target
    }
}

fn policy() -> BackoffPolicy {
    BackoffPolicy {
        first_delay: Duration::from_millis(200),
        max_delay: Duration::from_secs(2),
        max_attempts: 10,
    }
}

/// A shell on the remote machine (Linux, whatever the machine of the test is).
fn remote_shell() -> SpawnSpec {
    SpawnSpec {
        program: "sh".to_owned(),
        args: vec![],
        cwd: None,
        env: vec![],
        cols: 80,
        rows: 24,
    }
}

/// Reads events until one satisfies `pick`; returns what it picked and what came before.
async fn until<T>(
    events: &mut LinkEvents,
    what: &str,
    mut pick: impl FnMut(&LinkEvent) -> Option<T>,
) -> (T, Vec<LinkEvent>) {
    let mut before = Vec::new();
    let outcome = tokio::time::timeout(STEP, async {
        loop {
            match events.recv().await {
                Some(event) => match pick(&event) {
                    Some(found) => return found,
                    None => before.push(event),
                },
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

/// Waits for the output of `session` to hold `<prefix><digits>` and returns the digits: the shell
/// prints its own process id with `$$`, which the typed command (it holds `$$`, not digits) does
/// not contain, so a number after the prefix means the command ran.
async fn pid_printed(events: &mut LinkEvents, session: SessionId, prefix: &str) -> u32 {
    let mut text = String::new();
    let (pid, _) = until(events, &format!("{prefix}<pid> from the shell"), |event| {
        match event {
            LinkEvent::Output { session: id, data } if *id == session => {
                text.push_str(&String::from_utf8_lossy(data));
                let digits = text.split(prefix).skip(1).find_map(|rest| {
                    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                    // Digits are complete only when something follows them.
                    (!digits.is_empty() && rest.len() > digits.len()).then_some(digits)
                });
                digits.and_then(|d| d.parse().ok())
            }
            LinkEvent::Exit { session: id, info } if *id == session => {
                panic!("the shell ended ({info:?}) before it printed {prefix}<pid>: {text:?}")
            }
            _ => None,
        }
    })
    .await;
    pid
}

/// Ends a process the way `kill -9` or the task manager does: the system does it, not this client.
fn kill_process(pid: u32) {
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
    };
    #[cfg(not(windows))]
    let status = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    assert!(
        status.expect("run the kill command").success(),
        "kill {pid}"
    );
}

fn is_reconnecting(event: &LinkEvent) -> bool {
    matches!(event, LinkEvent::State(LinkState::Reconnecting { .. }))
}

fn is_connected(event: &LinkEvent) -> bool {
    matches!(event, LinkEvent::State(LinkState::Connected))
}

#[tokio::test]
#[ignore = "needs the container of `pnpm test:ssh`"]
async fn a_killed_ssh_process_is_reconnected_and_the_same_session_answers_with_the_same_pid() {
    let fixture = fixture();
    let (client, mut events) = ReconnectingClient::connect(fixture.target(), policy())
        .await
        .expect("the first connection through ssh");
    assert_eq!(client.state(), LinkState::Connected);
    let ssh_before = client.transport_id().expect("the pid of the ssh process");

    // A session on the remote machine, attached, that proves it runs there.
    let created = client.create(&remote_shell()).await.expect("create");
    let session = created.session;
    let pid = created.pid.expect("the daemon knows the pid of the shell");
    client.attach(session).await.expect("attach");
    client
        .write(session, b"echo \"first-pid=$$\"\n")
        .await
        .expect("write");
    assert_eq!(pid_printed(&mut events, session, "first-pid=").await, pid);
    client.write(session, b"uname -s\n").await.expect("write");
    let mut seen = String::new();
    until(&mut events, "Linux from uname", |event| match event {
        LinkEvent::Output { data, .. } => {
            seen.push_str(&String::from_utf8_lossy(data));
            seen.contains("Linux").then_some(())
        }
        _ => None,
    })
    .await;

    // The ssh process dies (the network drop).
    kill_process(ssh_before);
    let (_, _) = until(&mut events, "the link reconnecting", |e| {
        is_reconnecting(e).then_some(())
    })
    .await;
    let (replay, _) = until(&mut events, "the session attached again", |e| match e {
        LinkEvent::Reattached {
            session: id,
            replay,
            exit: None,
        } if *id == session => Some(String::from_utf8_lossy(replay).into_owned()),
        _ => None,
    })
    .await;
    assert!(
        replay.contains(&format!("first-pid={pid}")),
        "the buffer the daemon kept came back: {replay:?}"
    );
    until(&mut events, "the link connected", |e| {
        is_connected(e).then_some(())
    })
    .await;
    let ssh_after = client.transport_id().expect("a new ssh process");
    assert_ne!(
        ssh_before, ssh_after,
        "a new ssh process carries the connection"
    );

    // Same session id, same pid, and it answers.
    let sessions = client.list().await.expect("list");
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    assert_eq!(sessions[0].session, session);
    assert_eq!(sessions[0].pid, Some(pid));
    client
        .write(session, b"echo \"second-pid=$$\"\n")
        .await
        .expect("write after the reconnection");
    assert_eq!(pid_printed(&mut events, session, "second-pid=").await, pid);

    // A lot of output through the pipes of ssh, in frames of every length: the stream is binary
    // (no translation of line ends on the way) and nothing is lost, repeated or reordered.
    client
        .write(session, b"seq 1 20000; echo \"seq-$((1+1))\"\n")
        .await
        .expect("write");
    let mut text = String::new();
    until(&mut events, "the end of the numbers", |event| match event {
        LinkEvent::Output { session: id, data } if *id == session => {
            text.push_str(&String::from_utf8_lossy(data));
            text.contains("seq-2").then_some(())
        }
        _ => None,
    })
    .await;
    let numbers: Vec<u32> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()))
        .map(|line| line.parse().expect("a number"))
        .collect();
    assert_eq!(numbers, (1..=20000).collect::<Vec<u32>>());

    // And again, to see that it was not a lucky first time.
    kill_process(ssh_after);
    until(&mut events, "the link connected again", |e| {
        is_connected(e).then_some(())
    })
    .await;
    assert_ne!(client.transport_id(), Some(ssh_after));
    client
        .write(session, b"echo \"third-pid=$$\"\n")
        .await
        .expect("write after the second reconnection");
    assert_eq!(pid_printed(&mut events, session, "third-pid=").await, pid);

    // The shell outlives the client: a whole new client, a new ssh process and a new bridge find
    // it by its id, with what it printed.
    drop(client);
    drop(events);
    let (again, mut again_events) = ReconnectingClient::connect(fixture.target(), policy())
        .await
        .expect("a second client through ssh");
    let sessions = again.list().await.expect("list");
    assert_eq!(sessions.len(), 1, "{sessions:?}");
    assert_eq!(sessions[0].session, session);
    assert_eq!(sessions[0].pid, Some(pid));
    let attached = again.attach(session).await.expect("attach");
    assert!(
        String::from_utf8_lossy(&attached.replay).contains(&format!("third-pid={pid}")),
        "the second client got the buffer"
    );
    again
        .write(session, b"echo \"fourth-pid=$$\"\n")
        .await
        .expect("write");
    assert_eq!(
        pid_printed(&mut again_events, session, "fourth-pid=").await,
        pid
    );

    again.kill(session).await.expect("kill the session");
    assert!(again.list().await.expect("list").is_empty());
}

#[tokio::test]
#[ignore = "needs the container of `pnpm test:ssh`"]
async fn failures_that_trying_again_cannot_fix_are_told_apart_and_say_so() {
    let fixture = fixture();

    // A key the server does not know.
    let mut stranger = fixture.target();
    stranger.identity_file = Some(fixture.stranger_key.clone().into());
    let error = stranger.open().await.err().expect("the key is refused");
    assert_eq!(error.kind(), Some(SshFailure::Authentication), "{error}");
    assert!(error.is_permanent());
    assert!(error.to_string().contains("Permission denied"), "{error}");

    // A host key that is not the one the server has.
    let mut impostor = fixture.target();
    impostor.known_hosts_file = Some(fixture.wrong_known_hosts.clone().into());
    let error = impostor
        .open()
        .await
        .err()
        .expect("the host key is refused");
    assert_eq!(error.kind(), Some(SshFailure::HostKey), "{error}");
    assert!(error.is_permanent());

    // A host that is in no known hosts file: never accepted silently, never asked about.
    let mut unknown = fixture.target();
    unknown.known_hosts_file = Some(fixture.empty_known_hosts.clone().into());
    let error = unknown
        .open()
        .await
        .err()
        .expect("an unknown host is refused");
    assert_eq!(error.kind(), Some(SshFailure::HostKey), "{error}");

    // A machine where there is no norend under that name.
    let mut missing = fixture.target();
    missing.remote_program = "norend-that-is-not-installed".to_owned();
    let error = missing.open().await.err().expect("no such program");
    assert_eq!(error.kind(), Some(SshFailure::RemoteProgram), "{error}");
    assert!(error.is_permanent());

    // Nothing listens on that port of the machine: worth trying again.
    let mut closed = fixture.target();
    closed.port = Some(1);
    let error = closed.open().await.err().expect("nothing listens");
    assert_eq!(error.kind(), Some(SshFailure::Network), "{error}");
    assert!(!error.is_permanent());

    // The first connection of a client reports it as it is, without using up attempts.
    let started = std::time::Instant::now();
    let failure = match ReconnectingClient::connect(stranger, policy()).await {
        Ok(_) => panic!("a refused key must not connect"),
        Err(failure) => failure,
    };
    assert!(failure.permanent);
    assert!(started.elapsed() < Duration::from_secs(30));
}

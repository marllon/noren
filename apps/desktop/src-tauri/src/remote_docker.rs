//! A profile of kind `ssh` against a real OpenSSH server in a Docker container on this machine
//! (NOR-F14-04b), through the same calls the page makes.
//!
//! Ignored by default: `cargo test` (and so `pnpm verify`) needs neither Docker nor `ssh`. Run it
//! with `pnpm test:ssh`, which builds the image (an sshd and a `norend` compiled for Linux), starts
//! the container, makes the keys and the known hosts files, passes their paths in the
//! `NOREN_SSH_TEST_*` variables read below, runs this with `--ignored`, and removes everything
//! afterwards, whatever the result. The only address involved is the port the container published
//! on 127.0.0.1.
//!
//! What is under test is the path of a tab: the profile as the page hands it over
//! (`UserProfileDto`), `create_session` with the folder and the environment of this machine in the
//! call, the `ssh` of the system (on Windows the OpenSSH of `System32`, with no window), the
//! `norend` in the container, `session-link` events, and the output in the channel of the page.
//! The only thing added is the empty `ssh -F` file that keeps the test from reading the `~/.ssh/config`
//! of whoever runs it.

#![cfg(test)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use noren_core::daemon::{BackoffPolicy, Connector};
use noren_core::{Profile, ProfileSet, SessionId, SshProfile, UserProfile};
use tauri::Listener;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::bridge::{AppState, SESSION_LINK_EVENT, UserProfileDto, create_session};
use crate::daemon_link::{Host, Sessions};
use crate::remote::RemoteSessions;

/// What `pnpm test:ssh` tells this test about the container.
struct Fixture {
    host: String,
    port: u16,
    user: String,
    key: String,
    stranger_key: String,
    known_hosts: String,
    wrong_known_hosts: String,
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
        config: var("NOREN_SSH_TEST_CONFIG"),
    }
}

impl Fixture {
    /// The profile the page hands over, as the JSON it sends.
    fn profile(&self, id: &str, key: &str, known_hosts: &str) -> UserProfile {
        let dto: UserProfileDto = serde_json::from_value(serde_json::json!({
            "kind": "ssh",
            "id": id,
            "name": format!("Container {id}"),
            "host": self.host,
            "user": self.user,
            "port": self.port,
            "identityFile": key,
            "knownHostsFile": known_hosts,
        }))
        .expect("the profile the interface sends");
        UserProfile::try_from(dto).expect("an ssh profile")
    }

    /// An app state whose ssh tabs reach the container: the app's own way (`SshProfile::target`,
    /// the `ssh` of the system) with the empty configuration file the test adds.
    fn state(&self, policy: BackoffPolicy, profiles: &[UserProfile]) -> AppState {
        let config = self.config.clone();
        let remote = RemoteSessions::new(
            Arc::new(move |machine: &SshProfile| {
                let mut target = machine.target();
                target.config_file = Some(PathBuf::from(&config));
                Ok(Box::new(target) as Box<dyn Connector>)
            }),
            policy,
        );
        let local = Profile {
            id: "local".to_owned(),
            name: "A shell of this machine".to_owned(),
            program: "cmd".to_owned(),
            args: Vec::new(),
            cwd: None,
            inject_integration: false,
            remote: None,
        };
        let mut state = AppState::with_detected(ProfileSet {
            profiles: vec![local],
            default_id: Some("local".to_owned()),
        });
        state.sessions = Sessions::new(Host::InProcess).with_remote(remote);
        state.set_user_profiles(profiles).expect("valid profiles");
        state
    }
}

type Received = Arc<Mutex<Vec<u8>>>;

fn collecting() -> (Channel<InvokeResponseBody>, Received) {
    let received: Received = Arc::default();
    let sink = Arc::clone(&received);
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Raw(bytes) = body {
            sink.lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend_from_slice(&bytes);
        }
        Ok(())
    });
    (channel, received)
}

fn page_text(of: &Received) -> String {
    String::from_utf8_lossy(&of.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
}

/// Waits for what the page was handed to satisfy `check`, up to a minute.
fn wait_for_page<T>(of: &Received, what: &str, check: impl Fn(&str) -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let text = page_text(of);
        if let Some(found) = check(&text) {
            return found;
        }
        assert!(
            Instant::now() < deadline,
            "no {what} in the page within a minute; it has: {text:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The digits right after `prefix` in the output, once something follows them (the typed command
/// has `$$`, not digits, so digits mean the command ran).
fn number_after(text: &str, prefix: &str) -> Option<u32> {
    text.split(prefix).skip(1).find_map(|rest| {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        (!digits.is_empty() && rest.len() > digits.len())
            .then(|| digits.parse().ok())
            .flatten()
    })
}

/// What follows `prefix` up to the end of the line, once the line is complete.
fn line_after(text: &str, prefix: &str) -> Option<String> {
    text.split(prefix).skip(1).find_map(|rest| {
        let end = rest.find(['\r', '\n'])?;
        let line = &rest[..end];
        // The command typed has `$(`, `$0` and the like; the line it prints has none.
        (!line.contains('$')).then(|| line.to_owned())
    })
}

/// The next `session-link` event, as JSON.
fn next_link(links: &mpsc::Receiver<String>, what: &str) -> serde_json::Value {
    let text = links
        .recv_timeout(Duration::from_secs(90))
        .unwrap_or_else(|_| panic!("no session-link event for {what}"));
    serde_json::from_str(&text).expect("json")
}

/// Ends a process the way `kill -9` or the task manager does: the system does it, not this app.
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

#[test]
#[ignore = "needs the container of `pnpm test:ssh`"]
fn a_tab_of_an_ssh_profile_lives_in_the_container_gets_nothing_of_this_machine_and_survives_a_killed_ssh()
 {
    let fixture = fixture();
    // Five seconds before the first new attempt: longer than the line the shell prints below while
    // the connection is down, so that line is printed with nobody attached.
    let policy = BackoffPolicy {
        first_delay: Duration::from_secs(5),
        max_delay: Duration::from_secs(5),
        max_attempts: 10,
    };
    let state = fixture.state(
        policy,
        &[fixture.profile("container", &fixture.key, &fixture.known_hosts)],
    );
    let app = tauri::test::mock_app();
    let (links_tx, links) = mpsc::channel::<String>();
    app.listen(SESSION_LINK_EVENT, move |event| {
        let _ = links_tx.send(event.payload().to_owned());
    });
    let (page, in_page) = collecting();

    // The call the page makes: the folder of the space and the environment of the tab are both
    // from this machine, and neither may reach the shell in the container.
    let this_folder = std::env::current_dir().expect("a folder");
    let env = HashMap::from([
        (
            "USERPROFILE".to_owned(),
            "C:\\Users\\windows-user".to_owned(),
        ),
        (
            "WINDOWS_ONLY_VARIABLE".to_owned(),
            "marker-from-windows".to_owned(),
        ),
    ]);
    let (id, profile) = create_session(
        app.handle(),
        &state,
        Some("container"),
        this_folder.to_str(),
        Some(env),
        100,
        30,
        page,
    )
    .expect("the tab opens through ssh");
    assert_eq!(profile, "container");
    let id = SessionId(id);
    let ssh_before = state
        .sessions
        .remote_transport_id(id)
        .expect("the pid of the ssh process");

    // Where it runs and what it is: the home of the user there (no folder in the profile), the
    // login shell of that user, a Linux process, none of the environment of this machine.
    state
        .sessions
        .write(
            id,
            b"echo \"where=$(pwd) login=$(shopt -q login_shell && echo yes || echo no) sys=$(uname -s) first-pid=$$ first-marker-$((6*7))\"\n",
        )
        .expect("write");
    let first_pid = wait_for_page(&in_page, "the first answer", |text| {
        number_after(text, "first-pid=")
    });
    let text = page_text(&in_page);
    assert_eq!(
        line_after(&text, "where="),
        Some(format!(
            "/home/{} login=yes sys=Linux first-pid={first_pid} first-marker-42",
            fixture.user
        )),
        "the shell lives in the container, in the home of its user, as a login shell: {text:?}"
    );
    state
        .sessions
        .write(
            id,
            b"echo \"leak=$(printenv | grep -c -E 'WINDOWS_ONLY_VARIABLE|USERPROFILE|marker-from-windows')\"\n",
        )
        .expect("write");
    let leak = wait_for_page(&in_page, "the answer about the environment", |text| {
        number_after(text, "leak=")
    });
    assert_eq!(
        leak, 0,
        "nothing of the environment of this machine got there"
    );

    // A line printed three seconds from now, and the ssh process killed at once: the line is printed
    // while the connection is down (the first attempt to come back is five seconds away).
    state
        .sessions
        .write(id, b"(sleep 3; echo \"late-line-$((40+2))\") &\n")
        .expect("write");
    kill_process(ssh_before);

    let broke = next_link(&links, "the break");
    assert_eq!(broke["id"], id.0);
    assert_eq!(broke["state"], "reconnecting", "{broke}");
    assert_eq!(broke["attempt"], 1);
    assert_eq!(broke["maxAttempts"], 10);
    assert_eq!(broke["retryInMs"], 5000);
    assert!(broke["reason"].is_string(), "{broke}");

    // While it is down nothing can be typed, and the call says so.
    let typed = state.sessions.write(id, b"lost\n").expect_err("down");
    assert!(typed.to_string().contains(&fixture.host), "{typed}");

    // It comes back by itself.
    let back = loop {
        let link = next_link(&links, "the connection coming back");
        if link["state"] != "reconnecting" {
            break link;
        }
    };
    assert_eq!(back["state"], "connected", "{back}");
    assert_eq!(back["id"], id.0);
    assert_ne!(
        state.sessions.remote_transport_id(id),
        Some(ssh_before),
        "a new ssh process carries the connection"
    );

    // The line printed meanwhile is in the page, once, and nothing already shown came again
    //: the replay the daemon sent was cut down to what follows what the page had.
    wait_for_page(&in_page, "the line printed while down", |text| {
        text.contains("late-line-42").then_some(())
    });
    state
        .sessions
        .write(id, b"echo \"second-pid=$$ second-marker-$((6*7))\"\n")
        .expect("write after the reconnection");
    let second_pid = wait_for_page(&in_page, "the answer after the reconnection", |text| {
        number_after(text, "second-pid=")
    });
    assert_eq!(second_pid, first_pid, "the same shell process answers");
    let text = page_text(&in_page);
    for marker in ["first-marker-42", "late-line-42", "second-marker-42"] {
        assert_eq!(
            text.matches(marker).count(),
            1,
            "{marker} must be in the page once: {text:?}"
        );
    }
    assert!(
        !text.contains("\u{1b}c"),
        "the terminal was not reset: the replay held what the page had shown"
    );

    // Still just the one shell in the daemon over there.
    let machine = state
        .find_profile(Some("container"))
        .expect("listed")
        .remote
        .expect("remote");
    let listed = state.sessions.remote_sessions_of(&machine);
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].pid, Some(first_pid));

    // Closing the tab ends the shell there.
    state.sessions.kill(id).expect("close the tab");
    let (page, in_page) = collecting();
    let (second, _) = create_session(
        app.handle(),
        &state,
        Some("container"),
        None,
        None,
        100,
        30,
        page,
    )
    .expect("a second tab");
    let second = SessionId(second);
    state
        .sessions
        .write(
            second,
            format!(
                "if kill -0 {first_pid} 2>/dev/null; then echo \"shell-$((1+1))-alive\"; else echo \"shell-$((1+1))-gone\"; fi\n"
            )
            .as_bytes(),
        )
        .expect("write");
    wait_for_page(&in_page, "the answer about the first shell", |text| {
        if text.contains("shell-2-gone") {
            Some(())
        } else {
            assert!(
                !text.contains("shell-2-alive"),
                "the first shell is still there: {text:?}"
            );
            None
        }
    });
    state.sessions.kill(second).expect("close the second tab");
    assert_eq!(state.sessions.session_count(), 0);
}

#[test]
#[ignore = "needs the container of `pnpm test:ssh`"]
fn an_ssh_profile_that_cannot_log_in_says_why_and_leaves_nothing_behind() {
    let fixture = fixture();
    let policy = BackoffPolicy::default();
    let state = fixture.state(
        policy,
        &[
            fixture.profile("stranger", &fixture.stranger_key, &fixture.known_hosts),
            fixture.profile("impostor", &fixture.key, &fixture.wrong_known_hosts),
        ],
    );
    let app = tauri::test::mock_app();

    for (profile, words) in [
        ("stranger", "the server refused the key"),
        ("impostor", "the host key was refused"),
    ] {
        let (page, _) = collecting();
        let started = Instant::now();
        let error = create_session(
            app.handle(),
            &state,
            Some(profile),
            None,
            None,
            80,
            24,
            page,
        )
        .expect_err(profile);
        assert!(error.contains(&fixture.host), "{profile}: {error}");
        assert!(error.contains(words), "{profile}: {error}");
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "the first connection is not repeated"
        );
        assert_eq!(state.sessions.session_count(), 0);
    }
}

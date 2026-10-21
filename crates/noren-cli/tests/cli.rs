//! Integration tests of `noren-cli`: the real binary, run as a process, against a real
//! `ApiServer` on a real named pipe or Unix socket with a fake handler that records what it is
//! asked. The server runs on its own thread; each test has its own endpoint name and token folder
//! (process id and a counter), so they run in parallel without meeting each other or a Noren the
//! user has open. Nothing here opens a window, starts a shell or reaches the network.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use noren_core::api::{
    ApiCall, ApiConfig, ApiError, ApiFuture, ApiHandler, ApiServer, ApiToken, SplitDirection,
    api_endpoint, load_or_create_token, token_file_in,
};
use serde_json::{Value, json};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn unique() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

/// Answers like a small Noren and remembers every call.
struct FakeNoren {
    calls: Mutex<Vec<ApiCall>>,
}

impl FakeNoren {
    fn calls(&self) -> Vec<ApiCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl ApiHandler for FakeNoren {
    fn handle(&self, call: ApiCall) -> ApiFuture<'_> {
        self.calls.lock().unwrap().push(call.clone());
        Box::pin(async move {
            match call {
                ApiCall::SpacesList => Ok(json!({ "spaces": [
                    { "id": "s1", "name": "Work", "active": true, "items": [] },
                    { "id": "s2", "name": "Home", "active": false, "items": [] },
                    { "id": "s3", "name": "Twin", "active": false, "items": [] },
                    { "id": "s4", "name": "Twin", "active": false, "items": [] },
                ] })),
                ApiCall::ItemsCreate { space, .. } => {
                    Ok(json!({ "space": space, "item": "i9", "terminal": "t9", "session": "4" }))
                }
                ApiCall::SplitsCreate { item, .. } => {
                    Ok(json!({ "item": item, "terminal": "t10", "session": "5" }))
                }
                ApiCall::TerminalSend {
                    terminal,
                    text,
                    keys,
                } => Ok(json!({
                    "terminal": terminal,
                    "bytes": text.map_or(0, |t| t.len()) + keys.len(),
                })),
                ApiCall::TerminalRead { terminal, .. } => match terminal.as_str() {
                    "gone" => Err(ApiError::not_found("no terminal has the id gone")),
                    _ => Ok(
                        json!({ "terminal": terminal, "lines": ["$ ls", "a b"], "truncated": false }),
                    ),
                },
                ApiCall::Notify { terminal, .. } => {
                    Ok(json!({ "shown": false, "terminal": terminal }))
                }
                ApiCall::SpacesCreate { name } => Ok(json!({ "space": "s5", "name": name })),
            }
        })
    }
}

/// A running fake Noren, the name of its endpoint and its token file.
struct Fixture {
    server: Option<ApiServer>,
    noren: Arc<FakeNoren>,
    endpoint_name: String,
    dir: PathBuf,
    token_file: PathBuf,
}

impl Fixture {
    fn start() -> Self {
        let dir = std::env::temp_dir().join(format!("noren-cli-test-{}", unique()));
        fs::create_dir_all(&dir).unwrap();
        let token_file = dir.join("token");
        let (token, _) = load_or_create_token(&token_file).unwrap();
        let endpoint_name = format!("cli-test-{}", unique());
        let noren = Arc::new(FakeNoren {
            calls: Mutex::new(Vec::new()),
        });
        let server = ApiServer::start(
            api_endpoint(&endpoint_name).unwrap(),
            token,
            Arc::clone(&noren) as Arc<dyn ApiHandler>,
            ApiConfig::default(),
        )
        .expect("the API server starts");
        Self {
            server: Some(server),
            noren,
            endpoint_name,
            dir,
            token_file,
        }
    }

    /// The binary, told where this fake Noren is through the environment.
    fn command(&self) -> Command {
        let mut command = bare_command();
        command
            .env("NOREN_API_ENDPOINT", &self.endpoint_name)
            .env("NOREN_API_TOKEN_FILE", &self.token_file)
            .current_dir(&self.dir);
        command
    }

    fn run(&self, args: &[&str]) -> Run {
        Run::of(self.command().args(args).output().expect("run noren-cli"))
    }

    fn calls(&self) -> Vec<ApiCall> {
        self.noren.calls()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.server.take());
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The binary with nothing from the environment of the test that could point at a real Noren.
fn bare_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_noren-cli"));
    command
        .env_remove("NOREN_API_ENDPOINT")
        .env_remove("NOREN_API_TOKEN_FILE");
    command
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Run {
    fn of(output: Output) -> Self {
        Self {
            code: output.status.code().expect("exited by itself"),
            stdout: String::from_utf8(output.stdout).unwrap(),
            stderr: String::from_utf8(output.stderr).unwrap(),
        }
    }

    /// The JSON the command printed: exactly one line.
    fn json(&self) -> Value {
        assert_eq!(self.stdout.matches('\n').count(), 1, "{:?}", self.stdout);
        assert!(self.stdout.ends_with('\n'));
        serde_json::from_str(self.stdout.trim_end()).expect("a JSON line")
    }
}

fn same_folder(a: &str, b: &Path) -> bool {
    Path::new(a).canonicalize().unwrap() == b.canonicalize().unwrap()
}

#[test]
fn new_tab_by_space_id_creates_an_item_and_prints_the_result() {
    let fixture = Fixture::start();
    let run = fixture.run(&["new-tab", "--space", "s1", "--profile", "pwsh"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.json(),
        json!({ "space": "s1", "item": "i9", "terminal": "t9", "session": "4" })
    );
    assert_eq!(
        fixture.calls(),
        vec![
            ApiCall::SpacesList,
            ApiCall::ItemsCreate {
                space: "s1".into(),
                cwd: None,
                profile: Some("pwsh".into()),
            }
        ]
    );
}

#[test]
fn new_tab_finds_the_space_by_its_name() {
    let fixture = Fixture::start();
    let run = fixture.run(&["new-tab", "--space", "Home"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.json()["space"], "s2");
    assert_eq!(
        fixture.calls()[1],
        ApiCall::ItemsCreate {
            space: "s2".into(),
            cwd: None,
            profile: None
        }
    );
}

#[test]
fn new_tab_with_an_unknown_or_ambiguous_space_makes_nothing_and_fails() {
    let fixture = Fixture::start();
    let unknown = fixture.run(&["new-tab", "--space", "Nowhere"]);
    assert_eq!(unknown.code, 1);
    assert!(unknown.stderr.contains("Nowhere") && unknown.stderr.contains("Work"));
    assert!(unknown.stdout.is_empty());
    let twin = fixture.run(&["new-tab", "--space", "Twin"]);
    assert_eq!(twin.code, 1);
    assert!(
        twin.stderr.contains("s3") && twin.stderr.contains("s4"),
        "{}",
        twin.stderr
    );
    // Only the lists were asked for: nothing was created.
    assert_eq!(
        fixture.calls(),
        vec![ApiCall::SpacesList, ApiCall::SpacesList]
    );
}

#[test]
fn a_dot_cwd_is_the_absolute_folder_the_command_runs_in() {
    let fixture = Fixture::start();
    let run = fixture.run(&["new-tab", "--space", "s1", "--cwd", "."]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let ApiCall::ItemsCreate { cwd: Some(cwd), .. } = fixture.calls().pop().unwrap() else {
        panic!("items.create with a cwd");
    };
    assert!(Path::new(&cwd).is_absolute(), "{cwd}");
    assert!(same_folder(&cwd, &fixture.dir), "{cwd}");
}

#[test]
fn split_sends_the_item_the_direction_and_the_options() {
    let fixture = Fixture::start();
    let run = fixture.run(&[
        "split",
        "--item",
        "i3",
        "--direction",
        "down",
        "--profile",
        "bash",
    ]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.json(),
        json!({ "item": "i3", "terminal": "t10", "session": "5" })
    );
    assert_eq!(
        fixture.calls(),
        vec![ApiCall::SplitsCreate {
            item: "i3".into(),
            direction: SplitDirection::Down,
            cwd: None,
            profile: Some("bash".into()),
        }]
    );
    let right = fixture.run(&[
        "split",
        "--item",
        "i3",
        "--direction",
        "right",
        "--cwd",
        ".",
    ]);
    assert_eq!(right.code, 0, "{}", right.stderr);
    let ApiCall::SplitsCreate {
        direction,
        cwd: Some(cwd),
        ..
    } = fixture.calls().pop().unwrap()
    else {
        panic!("splits.create with a cwd");
    };
    assert_eq!(direction, SplitDirection::Right);
    assert!(same_folder(&cwd, &fixture.dir));
}

#[test]
fn send_types_exactly_the_text_and_never_adds_an_enter() {
    let fixture = Fixture::start();
    let run = fixture.run(&["send", "--terminal", "t1", "--text", "ls -la"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.json(), json!({ "terminal": "t1", "bytes": 6 }));
    assert_eq!(
        fixture.calls(),
        vec![ApiCall::TerminalSend {
            terminal: "t1".into(),
            text: Some("ls -la".into()),
            keys: vec![],
        }],
        "the text must reach the terminal as given: no line break, no Enter key"
    );
}

#[test]
fn send_sends_only_the_keys_it_was_given_in_order() {
    let fixture = Fixture::start();
    let run = fixture.run(&["send", "--terminal", "t1", "--key", "Ctrl+C", "--key", "Up"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        fixture.calls(),
        vec![ApiCall::TerminalSend {
            terminal: "t1".into(),
            text: None,
            keys: vec!["Ctrl+C".into(), "Up".into()],
        }]
    );
    // An Enter is sent only when it is asked for by name.
    let both = fixture.run(&[
        "send",
        "--terminal",
        "t1",
        "--text",
        "pwd",
        "--key",
        "Enter",
    ]);
    assert_eq!(both.code, 0, "{}", both.stderr);
    assert_eq!(
        fixture.calls().pop().unwrap(),
        ApiCall::TerminalSend {
            terminal: "t1".into(),
            text: Some("pwd".into()),
            keys: vec!["Enter".into()],
        }
    );
}

#[test]
fn read_asks_for_the_lines_and_prints_the_answer() {
    let fixture = Fixture::start();
    let run = fixture.run(&["read", "--terminal", "t1", "--lines", "25"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.json(),
        json!({ "terminal": "t1", "lines": ["$ ls", "a b"], "truncated": false })
    );
    let plain = fixture.run(&["read", "--terminal", "t2"]);
    assert_eq!(plain.code, 0, "{}", plain.stderr);
    assert_eq!(
        fixture.calls(),
        vec![
            ApiCall::TerminalRead {
                terminal: "t1".into(),
                lines: Some(25)
            },
            ApiCall::TerminalRead {
                terminal: "t2".into(),
                lines: None
            }
        ]
    );
}

#[test]
fn notify_sends_the_title_the_body_and_the_terminal() {
    let fixture = Fixture::start();
    let run = fixture.run(&[
        "notify",
        "--title",
        "Build done",
        "--body",
        "all green",
        "--terminal",
        "t1",
    ]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    // `shown: false` is an answer like any other, not a failure.
    assert_eq!(run.json(), json!({ "shown": false, "terminal": "t1" }));
    assert_eq!(
        fixture.calls(),
        vec![ApiCall::Notify {
            title: "Build done".into(),
            body: Some("all green".into()),
            terminal: Some("t1".into()),
        }]
    );
    let bare = fixture.run(&["notify", "--title", "Hi"]);
    assert_eq!(bare.code, 0, "{}", bare.stderr);
    assert_eq!(
        fixture.calls().pop().unwrap(),
        ApiCall::Notify {
            title: "Hi".into(),
            body: None,
            terminal: None
        }
    );
}

#[test]
fn an_error_of_noren_is_a_message_and_exit_1() {
    let fixture = Fixture::start();
    let run = fixture.run(&["read", "--terminal", "gone"]);
    assert_eq!(run.code, 1);
    assert!(run.stdout.is_empty(), "{}", run.stdout);
    assert!(
        run.stderr.contains("not_found") && run.stderr.contains("no terminal has the id gone"),
        "{}",
        run.stderr
    );
}

#[test]
fn parameters_noren_does_not_accept_come_back_as_exit_1() {
    let fixture = Fixture::start();
    let long_title = "x".repeat(200);
    let run = fixture.run(&["notify", "--title", &long_title]);
    assert_eq!(run.code, 1);
    assert!(run.stderr.contains("invalid_params"), "{}", run.stderr);
    assert!(fixture.calls().is_empty());
}

#[test]
fn a_wrong_token_is_refused_and_nothing_is_run() {
    let fixture = Fixture::start();
    let other = fixture.dir.join("other-token");
    fs::write(
        &other,
        format!("{}\n", ApiToken::generate().unwrap().to_hex()),
    )
    .unwrap();
    let run = fixture.run(&[
        "read",
        "--terminal",
        "t1",
        "--token-file",
        other.to_str().unwrap(),
    ]);
    assert_eq!(run.code, 3);
    assert!(run.stdout.is_empty());
    assert!(run.stderr.contains("refused the token"), "{}", run.stderr);
    assert!(
        fixture.calls().is_empty(),
        "the handler must not be reached"
    );
}

#[test]
fn a_missing_or_damaged_token_file_is_said_clearly_and_exit_3() {
    let fixture = Fixture::start();
    let missing = fixture.dir.join("no-such-token");
    let run = fixture.run(&[
        "read",
        "--terminal",
        "t1",
        "--token-file",
        missing.to_str().unwrap(),
    ]);
    assert_eq!(run.code, 3);
    assert!(run.stderr.contains("no API token"), "{}", run.stderr);
    assert!(
        run.stderr.contains("no-such-token"),
        "the message must say where it looked: {}",
        run.stderr
    );
    let damaged = fixture.dir.join("damaged-token");
    fs::write(&damaged, "not a token").unwrap();
    let run = fixture.run(&[
        "read",
        "--terminal",
        "t1",
        "--token-file",
        damaged.to_str().unwrap(),
    ]);
    assert_eq!(run.code, 3);
    assert!(run.stderr.contains("cannot be used"), "{}", run.stderr);
    assert!(fixture.calls().is_empty());
}

#[test]
fn the_token_is_read_again_at_every_run() {
    let fixture = Fixture::start();
    assert_eq!(fixture.run(&["read", "--terminal", "t1"]).code, 0);
    // Noren made a new token (a new data folder, a damaged file): the old one no longer opens it.
    fs::write(
        &fixture.token_file,
        format!("{}\n", ApiToken::generate().unwrap().to_hex()),
    )
    .unwrap();
    assert_eq!(fixture.run(&["read", "--terminal", "t1"]).code, 3);
}

#[test]
fn no_noren_running_is_said_so_and_exit_3() {
    let dir = std::env::temp_dir().join(format!("noren-cli-test-{}", unique()));
    fs::create_dir_all(&dir).unwrap();
    let token_file = dir.join("token");
    load_or_create_token(&token_file).unwrap();
    let output = bare_command()
        .env(
            "NOREN_API_ENDPOINT",
            format!("cli-test-absent-{}", unique()),
        )
        .env("NOREN_API_TOKEN_FILE", &token_file)
        .args(["read", "--terminal", "t1"])
        .output()
        .expect("run noren-cli");
    let run = Run::of(output);
    let _ = fs::remove_dir_all(&dir);
    assert_eq!(run.code, 3);
    assert!(run.stdout.is_empty());
    assert!(
        run.stderr.contains("Noren is not running"),
        "{}",
        run.stderr
    );
}

#[test]
fn a_wrong_command_line_is_exit_2_and_never_reaches_noren() {
    let fixture = Fixture::start();
    let lines: [&[&str]; 14] = [
        &[],
        &["fly"],
        &["new-tab"],
        &["new-tab", "--space"],
        &["new-tab", "--space", "s1", "--bogus", "1"],
        &["new-tab", "--space", "s1", "extra"],
        &["split", "--item", "i1", "--direction", "left"],
        &["split", "--item", "i1"],
        &["send", "--terminal", "t1"],
        &["send", "--terminal", "t1", "--text", ""],
        &["read", "--terminal", "t1", "--lines", "0"],
        &["read", "--terminal", "t1", "--lines", "many"],
        &["notify", "--body", "no title"],
        &["read", "--terminal", "t1", "--text", "not for read"],
    ];
    for line in lines {
        let run = fixture.run(line);
        assert_eq!(run.code, 2, "{line:?}: {}", run.stderr);
        assert!(run.stdout.is_empty(), "{line:?}");
        assert!(
            run.stderr.contains("noren-cli:"),
            "{line:?}: {}",
            run.stderr
        );
    }
    assert!(fixture.calls().is_empty(), "a bad line must not connect");
}

#[test]
fn help_and_version_print_and_exit_0_without_noren() {
    let help = Run::of(bare_command().arg("--help").output().unwrap());
    assert_eq!(help.code, 0);
    for word in ["new-tab", "split", "send", "read", "notify", "Enter"] {
        assert!(help.stdout.contains(word), "{word}");
    }
    let short = Run::of(bare_command().args(["send", "-h"]).output().unwrap());
    assert_eq!(short.code, 0);
    assert_eq!(short.stdout, help.stdout);
    let version = Run::of(bare_command().arg("--version").output().unwrap());
    assert_eq!(version.code, 0);
    assert!(
        version.stdout.starts_with("noren-cli "),
        "{}",
        version.stdout
    );
}

#[test]
fn the_options_win_over_the_environment() {
    let fixture = Fixture::start();
    // The environment points at nothing; the line points at the fake Noren.
    let output = bare_command()
        .env("NOREN_API_ENDPOINT", "cli-test-nothing-here")
        .env("NOREN_API_TOKEN_FILE", fixture.dir.join("nope"))
        .args([
            "read",
            "--terminal",
            "t1",
            "--endpoint",
            &fixture.endpoint_name,
            "--token-file",
            fixture.token_file.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let run = Run::of(output);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(fixture.calls().len(), 1);
}

#[test]
fn without_a_token_option_the_token_is_in_the_data_folder_of_noren() {
    let fixture = Fixture::start();
    // A data folder of the test, laid out like the one of the app, with the token in api/token.
    let data = fixture.dir.join("data");
    let in_app = token_file_in(&data.join(noren_core::api::APP_IDENTIFIER));
    fs::create_dir_all(in_app.parent().unwrap()).unwrap();
    fs::copy(&fixture.token_file, &in_app).unwrap();
    let mut command = bare_command();
    command
        .env("NOREN_API_ENDPOINT", &fixture.endpoint_name)
        .env("APPDATA", &data)
        .env("XDG_DATA_HOME", &data)
        .env("HOME", &fixture.dir)
        .env("USERPROFILE", &fixture.dir)
        .args(["read", "--terminal", "t1"]);
    if cfg!(target_os = "macos") {
        // `~/Library/Application Support/<identifier>`
        let support = fixture.dir.join("Library").join("Application Support");
        fs::create_dir_all(&support).unwrap();
        let target = token_file_in(&support.join(noren_core::api::APP_IDENTIFIER));
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::copy(&fixture.token_file, &target).unwrap();
    }
    let run = Run::of(command.output().unwrap());
    assert_eq!(run.code, 0, "{}", run.stderr);
}

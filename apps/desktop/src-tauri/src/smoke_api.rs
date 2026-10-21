//! A client of the local API against the real app (`noren --smoke-api`, NOR-F17-01d).
//!
//! The run starts the app like every smoke mode does (the main window hidden, a session daemon and an
//! API endpoint of its own, see `main.rs`), waits for the page to come up, and then plays a program
//! of the same user that wants something from Noren: it reads the token from the file the server
//! keeps it in, connects to the endpoint, authenticates and makes real calls, which go to the server,
//! across the bridge (`api_bridge.rs`) to the page of the main window, through the dispatcher of
//! `@noren/model` over the real workspace, and back. What it checks, in order:
//!
//! 1. the token file is the one the server made (reused, never created by the client) and the
//!    endpoint is one of this run;
//! 2. a wrong token is refused with `unauthorized` and the connection is closed;
//! 3. the right token is welcomed; `spaces.list` is answered by the page (a call that comes while the
//!    window is still starting is told so with `failed` and tried again, which is how a client is to
//!    behave and what the run counts);
//! 4. `spaces.create` makes a space, and a second `spaces.list` shows it, with its name;
//! 5. nothing was shown (the main window is hidden, no global shortcut, no tray icon) and the daemon
//!    of the run stops.
//!
//! No call types into a terminal, so no Enter is sent (D8), and no window is shown or clicked (D19).
//! The page saves the workspace it makes, so the run keeps the files of the app in a folder of its
//! own, removed when it ends. Every step prints a `SMOKE API ...` line; `scripts/smoke.mjs` requires
//! the ones that matter.

use std::path::PathBuf;
use std::process;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use noren_core::api::{API_PROTOCOL_VERSION, TokenOrigin, load_or_create_token, to_frame};
use noren_core::daemon::ipc::{self, ClientStream};
use noren_core::daemon::{Endpoint, read_frame, write_frame};
use serde_json::{Value, json};
use tauri::{AppHandle, Listener, Manager};

use crate::api_bridge::{ApiState, STARTING_MESSAGE};
use crate::bridge::AppState;
use crate::smoke::{
    Heard, Inbox, check_api_listening, check_daemon_stopped, check_no_global_shortcut,
    check_runs_in_daemon, check_window_hidden, fresh_dir, print_line,
};

pub const SMOKE_API_FLAG: &str = "--smoke-api";

/// The whole run, from the start of the program to the daemon stopped, has this long.
const TIMEOUT: Duration = Duration::from_secs(50);
/// Longest the client waits for one answer from the server.
const STEP: Duration = Duration::from_secs(20);
/// Pause before a call that was told the window is starting is made again.
const RETRY_PAUSE: Duration = Duration::from_millis(100);

/// Whether `--smoke-api` is among the arguments (the first one is the program).
pub fn has_flag(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == SMOKE_API_FLAG)
}

/// The folder the run keeps the files of the app in. The page of the main window saves the workspace
/// it makes (the run makes a space), and the files of the user must not be written by a run that is
/// not about them, so the run has a folder of its own, removed when it ends.
#[derive(Clone, Debug)]
pub struct ApiSandbox {
    pub state_dir: PathBuf,
}

impl ApiSandbox {
    pub fn new() -> Self {
        Self {
            state_dir: fresh_dir("noren-smoke-api-state"),
        }
    }

    /// Deletes the folder this run made (only that one).
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

impl Default for ApiSandbox {
    fn default() -> Self {
        Self::new()
    }
}

// ---- the client ---------------------------------------------------------------------------------

/// A connection to the API, as a program of the user would hold one.
struct Client {
    stream: ClientStream,
    next_id: u64,
}

impl Client {
    async fn connect(endpoint: &Endpoint) -> Result<Self, String> {
        let stream = tokio::time::timeout(STEP, ipc::connect(endpoint))
            .await
            .map_err(|_| "connecting to the API took too long".to_owned())?
            .map_err(|e| format!("could not connect to the API: {e}"))?;
        Ok(Self { stream, next_id: 1 })
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let frame = to_frame(message.to_string().as_bytes()).map_err(|e| e.to_string())?;
        write_frame(&mut self.stream, &frame)
            .await
            .map_err(|e| format!("could not send to the API: {e}"))
    }

    /// The next message of the server; an error when the connection is closed or says nothing.
    async fn recv(&mut self, deadline: Instant) -> Result<Value, String> {
        let wait = STEP.min(deadline.saturating_duration_since(Instant::now()));
        let payload = tokio::time::timeout(wait, read_frame(&mut self.stream))
            .await
            .map_err(|_| "the API did not answer in time".to_owned())?
            .map_err(|e| format!("the API closed the connection: {e}"))?;
        serde_json::from_slice(&payload)
            .map_err(|e| format!("the API sent something that is not JSON: {e}"))
    }

    /// Sends the first message and returns what the server answered to it.
    async fn authenticate(&mut self, token: &str, deadline: Instant) -> Result<Value, String> {
        self.send(&json!({ "type": "auth", "version": API_PROTOCOL_VERSION, "token": token }))
            .await?;
        self.recv(deadline).await
    }

    /// One request and its answer (`{ id, result }` or `{ id, error }`), with the id checked.
    async fn call(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "id": id, "method": method, "params": params }))
            .await?;
        let answer = self.recv(deadline).await?;
        if answer["id"] != json!(id) {
            return Err(format!(
                "{method} was answered with the id {}, not {id}",
                answer["id"]
            ));
        }
        Ok(answer)
    }

    /// Like [`Self::call`], and tried again for as long as the answer says the window is still
    /// starting. Returns the answer and how many calls it was told that.
    async fn call_when_ready(
        &mut self,
        method: &str,
        params: &Value,
        deadline: Instant,
    ) -> Result<(Value, u32), String> {
        let mut refused = 0;
        loop {
            let answer = self.call(method, params.clone(), deadline).await?;
            if !is_starting(&answer) {
                return Ok((answer, refused));
            }
            refused += 1;
            if Instant::now() >= deadline {
                return Err(format!(
                    "{method} was still told the window is starting after {refused} tries"
                ));
            }
            tokio::time::sleep(RETRY_PAUSE).await;
        }
    }
}

/// Whether an answer is the one the bridge gives while the page has not said it listens.
fn is_starting(answer: &Value) -> bool {
    answer["error"]["code"] == "failed" && answer["error"]["message"] == STARTING_MESSAGE
}

/// The `result` of an answer, or why it is an error.
fn result_of<'a>(method: &str, answer: &'a Value) -> Result<&'a Value, String> {
    match answer.get("result") {
        Some(result) => Ok(result),
        None => Err(format!(
            "{method} failed: {} ({})",
            answer["error"]["message"], answer["error"]["code"]
        )),
    }
}

/// The spaces a `spaces.list` answer holds, as `(id, name)`.
fn spaces_of(answer: &Value) -> Result<Vec<(String, String)>, String> {
    let list = result_of("spaces.list", answer)?["spaces"]
        .as_array()
        .ok_or_else(|| format!("spaces.list answered without a list of spaces: {answer}"))?;
    list.iter()
        .map(
            |space| match (space["id"].as_str(), space["name"].as_str()) {
                (Some(id), Some(name)) => Ok((id.to_owned(), name.to_owned())),
                _ => Err(format!("a space without an id and a name: {space}")),
            },
        )
        .collect()
}

/// The same token with its first character changed: a token of the right shape that is not the one.
fn wrong_token(token: &str) -> String {
    let first = if token.starts_with('0') { '1' } else { '0' };
    format!("{first}{}", token.chars().skip(1).collect::<String>())
}

/// A wrong token is refused with `unauthorized` and the connection is closed.
async fn check_wrong_token(
    endpoint: &Endpoint,
    token: &str,
    deadline: Instant,
) -> Result<(), String> {
    let mut client = Client::connect(endpoint).await?;
    let answer = client.authenticate(&wrong_token(token), deadline).await?;
    if answer["error"]["code"] != "unauthorized" {
        return Err(format!(
            "a wrong token was not refused with unauthorized: {answer}"
        ));
    }
    // The server closes the connection: the next read ends instead of giving a frame.
    if client.recv(deadline).await.is_ok() {
        return Err("the connection stayed open after a wrong token".to_owned());
    }
    print_line("SMOKE API a wrong token was refused (unauthorized), connection closed");
    Ok(())
}

/// The calls of the run, over a connection that authenticated with `token`.
async fn check_calls(endpoint: &Endpoint, token: &str, deadline: Instant) -> Result<(), String> {
    let mut client = Client::connect(endpoint).await?;
    let welcome = client.authenticate(token, deadline).await?;
    if welcome != json!({ "type": "welcome", "version": API_PROTOCOL_VERSION }) {
        return Err(format!("the right token was not welcomed: {welcome}"));
    }
    print_line(&format!(
        "SMOKE API authenticated with the token of the run, welcome version {API_PROTOCOL_VERSION}"
    ));

    let (answer, refused) = client
        .call_when_ready("spaces.list", &json!({}), deadline)
        .await?;
    let before = spaces_of(&answer)?;
    print_line(&format!(
        "SMOKE API spaces.list answered by the page: {} space(s) ({refused} call(s) told the window was starting before)",
        before.len()
    ));

    let name = format!("smoke-api-{}", process::id());
    let answer = client
        .call("spaces.create", json!({ "name": name }), deadline)
        .await?;
    let made = result_of("spaces.create", &answer)?;
    let id = made["space"]
        .as_str()
        .ok_or_else(|| format!("spaces.create answered without the id of the space: {answer}"))?
        .to_owned();
    if made["name"] != json!(name) {
        return Err(format!(
            "spaces.create made a space called {}, not {name:?}",
            made["name"]
        ));
    }
    print_line(&format!("SMOKE API spaces.create made {name:?} as {id}"));

    let answer = client.call("spaces.list", json!({}), deadline).await?;
    let after = spaces_of(&answer)?;
    if after.len() != before.len() + 1 {
        return Err(format!(
            "spaces.list shows {} spaces after the new one, expected {}",
            after.len(),
            before.len() + 1
        ));
    }
    if !after.contains(&(id.clone(), name.clone())) {
        return Err(format!(
            "spaces.list does not show the new space {id} called {name:?}"
        ));
    }
    if before.iter().any(|(old, _)| *old == id) {
        return Err(format!(
            "the new space {id} was in the list before it was made"
        ));
    }
    print_line(&format!("SMOKE API spaces.list shows the new space {id}"));
    Ok(())
}

// ---- the run ------------------------------------------------------------------------------------

/// The checks, in order. The page is up once it says `app-ready`.
fn run(app: &AppHandle, inbox: &mut Inbox, deadline: Instant) -> Result<(), String> {
    inbox.wait("app-ready", "app-ready", deadline, |_| Some(()))?;
    print_line("SMOKE app-ready received");

    check_api_listening(app)?;
    let state = app
        .try_state::<ApiState>()
        .ok_or_else(|| "the local API was never installed".to_owned())?;
    let target = state
        .target()
        .cloned()
        .ok_or_else(|| "the local API has no endpoint to connect to".to_owned())?;
    // A client only reads the token: the file is the one the server made.
    let (token, origin) = load_or_create_token(&target.token_file)
        .map_err(|e| format!("the token file could not be read: {e}"))?;
    if origin != TokenOrigin::Reused {
        return Err(format!(
            "the token file was {origin:?}, not the one the server made ({:?})",
            target.token_file
        ));
    }
    let token = token.to_hex();

    tauri::async_runtime::block_on(async {
        check_wrong_token(&target.endpoint, &token, deadline).await?;
        check_calls(&target.endpoint, &token, deadline).await
    })?;

    let app_state = app.state::<AppState>();
    check_no_global_shortcut(app)?;
    check_window_hidden(app)?;
    // The page started the shell of its first pane in the daemon of the run; it ends with it.
    let session = app_state
        .sessions
        .list()
        .map_err(|e| format!("the daemon of the run could not list its sessions: {e}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "the page started no shell in the daemon of the run".to_owned())?
        .session
        .0;
    check_runs_in_daemon(&app_state, session)?;
    check_daemon_stopped(&app_state)
}

/// Like `smoke::fail`, and removes the folder of the run, last: the page of the main window may
/// still save its state while the sessions end, and that would put the folder back.
fn fail_api(app: &AppHandle, sandbox: &ApiSandbox, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    app.state::<AppState>().sessions.shutdown();
    sandbox.remove();
    process::exit(1);
}

/// API smoke mode (`noren --smoke-api`): see the top of this file. Then `SMOKE API OK` and exit 0;
/// anything else within the time of the run ends with code 1. The window stays hidden.
pub fn arm(app: &tauri::App, sandbox: ApiSandbox) {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<Heard>();
    {
        let tx = tx.clone();
        app.listen("app-ready", move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            // The run is over once the receiver is gone; late events are of no interest.
            let _ = tx.send(("app-ready".to_owned(), payload));
        });
    }

    let handle = app.handle().clone();
    thread::spawn(move || {
        let mut inbox = Inbox {
            rx,
            kept: Vec::new(),
        };
        match run(&handle, &mut inbox, started + TIMEOUT) {
            Ok(()) => {
                print_line("SMOKE window hidden");
                print_line("SMOKE API OK");
                handle.exit(0);
            }
            Err(message) => fail_api(&handle, &sandbox, &message),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_flag_is_found_after_the_program_name_only() {
        assert!(has_flag(&args(&["noren", "--smoke-api"])));
        assert!(!has_flag(&args(&["--smoke-api"])));
        assert!(!has_flag(&args(&["noren", "--smoke"])));
        assert!(!has_flag(&args(&["noren", "--smoke-window"])));
    }

    #[test]
    fn the_folder_of_the_run_is_its_own_and_is_removed() {
        let first = ApiSandbox::new();
        let second = ApiSandbox::new();
        assert_ne!(first.state_dir, second.state_dir);
        std::fs::create_dir_all(&first.state_dir).expect("make the folder");
        first.remove();
        assert!(!first.state_dir.exists());
        assert!(first.state_dir.starts_with(std::env::temp_dir()));
    }

    #[test]
    fn a_wrong_token_has_the_shape_of_the_right_one_and_is_not_it() {
        for token in ["0123abcd", "f123abcd", "0000"] {
            let wrong = wrong_token(token);
            assert_ne!(wrong, token);
            assert_eq!(wrong.len(), token.len());
            assert_eq!(wrong[1..], token[1..]);
        }
    }

    #[test]
    fn only_the_answer_the_bridge_gives_while_starting_is_retried() {
        let starting =
            json!({ "id": 1, "error": { "code": "failed", "message": STARTING_MESSAGE } });
        assert!(is_starting(&starting));
        // Another failure, another code and a result are answers, not a reason to wait.
        let other_failure =
            json!({ "id": 1, "error": { "code": "failed", "message": "no main window" } });
        let timeout =
            json!({ "id": 1, "error": { "code": "timeout", "message": STARTING_MESSAGE } });
        let result = json!({ "id": 1, "result": { "spaces": [] } });
        for answer in [other_failure, timeout, result] {
            assert!(!is_starting(&answer), "{answer}");
        }
    }

    #[test]
    fn the_spaces_of_an_answer_are_read_as_id_and_name_and_anything_else_is_an_error() {
        let answer = json!({ "id": 1, "result": { "spaces": [
            { "id": "s1", "name": "Home", "active": true, "items": [] },
            { "id": "s2", "name": "Work", "active": false, "items": [] },
        ] } });
        assert_eq!(
            spaces_of(&answer).unwrap(),
            vec![
                ("s1".to_owned(), "Home".to_owned()),
                ("s2".to_owned(), "Work".to_owned())
            ]
        );
        assert_eq!(
            spaces_of(&json!({ "id": 1, "result": { "spaces": [] } })).unwrap(),
            vec![]
        );
        for bad in [
            json!({ "id": 1, "error": { "code": "failed", "message": "x" } }),
            json!({ "id": 1, "result": {} }),
            json!({ "id": 1, "result": { "spaces": [{ "id": "s1" }] } }),
            json!({ "id": 1, "result": { "spaces": [{ "id": 1, "name": "x" }] } }),
        ] {
            assert!(spaces_of(&bad).is_err(), "{bad}");
        }
    }
}

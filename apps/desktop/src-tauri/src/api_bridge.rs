//! The local API inside the app (NOR-F17-01c): the server of `noren-core` (`api`) is started with the
//! token in a file of the user, and every call it validates is handed to the page of the main window,
//! which runs it (`dispatchApiCall` of `@noren/model`) and answers through the `api_respond` command.
//!
//! - [`ApiBridge`] is the [`ApiHandler`]: it gives each call an id of its own, emits it to the window
//!   `main` and only to it, and waits for the answer with a deadline shorter than the one the server
//!   puts on a request, so the caller gets an error from here and not a bare `timeout` from there.
//!   An answer for an id nobody waits for (never given, already answered, already timed out) is
//!   dropped. What the page answers is checked too: anything but exactly `{ result }` or
//!   `{ error: { code, message } }` is an `internal` error.
//! - [`CallSink`] is the way out to the page, behind a trait so the logic runs in a test without a
//!   window ([`WindowSink`] is the real one).
//! - [`api_respond`] is the command the page answers with. Only the main window is granted it (a
//!   capability, checked by a test of `capabilities.rs`) and it refuses any other window itself.
//! - [`install`] starts the server. A server that cannot start (the endpoint is taken, the token file
//!   cannot be written) is a line in the log, never a reason to stop the app.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use noren_core::api::{
    ApiCall, ApiConfig, ApiError, ApiErrorCode, ApiFuture, ApiHandler, ApiServer, SplitDirection,
    api_endpoint, load_or_create_token,
};
use noren_core::daemon::Endpoint;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::oneshot;

use crate::lifecycle::{MAIN_LABEL, main_window};

/// The event that carries a call to the page: `{ id, method, params }`.
pub const CALL_EVENT: &str = "api-call";
/// The command the page answers with: `api_respond(id, outcome)`. Named here for the tests; the
/// handler list in `main.rs` and `build.rs` spell it out.
#[cfg(test)]
pub const RESPOND_COMMAND: &str = "api_respond";
/// The command the page says it listens with: `api_ready()`, after it registered the listener of
/// [`CALL_EVENT`].
#[cfg(test)]
pub const READY_COMMAND: &str = "api_ready";
/// The folder of the token file inside the data folder of the app.
pub const API_DIR_NAME: &str = "api";
/// The name of the token file.
pub const TOKEN_FILE_NAME: &str = "token";
/// How much sooner than the server's request limit the bridge gives up on the page.
const MARGIN: Duration = Duration::from_secs(5);
/// What a call gets while the page has not said it is listening. A client may try again.
pub const STARTING_MESSAGE: &str =
    "Noren is still starting: its window is not ready for API calls yet, try again in a moment";

/// How long the bridge waits for the page: the request limit of the server less [`MARGIN`] (never
/// more than the limit itself, and never nothing).
pub fn reply_timeout(config: &ApiConfig) -> Duration {
    config
        .request_timeout
        .saturating_sub(MARGIN)
        .max(Duration::from_millis(1))
}

/// Why a call could not be handed to the page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Undelivered {
    /// There is no main window (the app is closing, or has not made it yet).
    NoWindow,
    /// The window is there and the event could not be sent to it.
    Failed(String),
}

/// The way out to the page: gives it one call, as the payload of [`CALL_EVENT`].
pub trait CallSink: Send + Sync + 'static {
    fn send(&self, payload: Value) -> Result<(), Undelivered>;
}

/// The real sink: the event goes to the window `main` and to no other window or web view.
pub struct WindowSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> WindowSink<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> CallSink for WindowSink<R> {
    fn send(&self, payload: Value) -> Result<(), Undelivered> {
        if main_window(&self.app).is_none() {
            return Err(Undelivered::NoWindow);
        }
        self.app
            .emit_to(MAIN_LABEL, CALL_EVENT, payload)
            .map_err(|e| Undelivered::Failed(e.to_string()))
    }
}

/// The call as the page gets it: `{ id, method, params }`, the shape `parse_call` of the server reads
/// (an optional field that is not there is left out).
pub fn call_event(id: u64, call: &ApiCall) -> Value {
    let params = match call {
        ApiCall::SpacesList => json!({}),
        ApiCall::SpacesCreate { name } => json!({ "name": name }),
        ApiCall::ItemsCreate {
            space,
            cwd,
            profile,
        } => with_optional(json!({ "space": space }), cwd, profile),
        ApiCall::SplitsCreate {
            item,
            direction,
            cwd,
            profile,
        } => with_optional(
            json!({
                "item": item,
                "direction": match direction {
                    SplitDirection::Right => "right",
                    SplitDirection::Down => "down",
                },
            }),
            cwd,
            profile,
        ),
        ApiCall::TerminalSend {
            terminal,
            text,
            keys,
        } => {
            let mut params = json!({ "terminal": terminal });
            if let Some(text) = text {
                params["text"] = json!(text);
            }
            if !keys.is_empty() {
                params["keys"] = json!(keys);
            }
            params
        }
        ApiCall::TerminalRead { terminal, lines } => {
            let mut params = json!({ "terminal": terminal });
            if let Some(lines) = lines {
                params["lines"] = json!(lines);
            }
            params
        }
    };
    json!({ "id": id, "method": call.method().name(), "params": params })
}

fn with_optional(mut params: Value, cwd: &Option<String>, profile: &Option<String>) -> Value {
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    if let Some(profile) = profile {
        params["profile"] = json!(profile);
    }
    params
}

/// The error code a name stands for: the texts of `ApiErrorCode::as_str`.
fn error_code(name: &str) -> Option<ApiErrorCode> {
    Some(match name {
        "invalid_json" => ApiErrorCode::InvalidJson,
        "invalid_request" => ApiErrorCode::InvalidRequest,
        "unknown_method" => ApiErrorCode::UnknownMethod,
        "invalid_params" => ApiErrorCode::InvalidParams,
        "frame_too_large" => ApiErrorCode::FrameTooLarge,
        "unauthenticated" => ApiErrorCode::Unauthenticated,
        "unauthorized" => ApiErrorCode::Unauthorized,
        "unsupported_version" => ApiErrorCode::UnsupportedVersion,
        "timeout" => ApiErrorCode::Timeout,
        "shutting_down" => ApiErrorCode::ShuttingDown,
        "internal" => ApiErrorCode::Internal,
        "not_found" => ApiErrorCode::NotFound,
        "failed" => ApiErrorCode::Failed,
        _ => return None,
    })
}

fn malformed(what: &str) -> ApiError {
    ApiError::new(
        ApiErrorCode::Internal,
        format!("the window answered something that is not an answer ({what})"),
    )
}

/// What the page answered, as the handler returns it: `{ result }` is the result, `{ error: { code,
/// message } }` the error. Nothing else is accepted: a missing or extra field, both at once, a code
/// that is not one of the server's or a message that is not text is an `internal` error.
pub fn outcome_of(answer: Value) -> Result<Value, ApiError> {
    let Value::Object(mut fields) = answer else {
        return Err(malformed("not an object"));
    };
    match (fields.remove("result"), fields.remove("error")) {
        (Some(result), None) if fields.is_empty() => Ok(result),
        (None, Some(Value::Object(mut error))) if fields.is_empty() => {
            let code = error.remove("code");
            let message = error.remove("message");
            if !error.is_empty() {
                return Err(malformed("an error with an extra field"));
            }
            match (code, message) {
                (Some(Value::String(code)), Some(Value::String(message))) => {
                    match error_code(&code) {
                        Some(code) => Err(ApiError::new(code, message)),
                        None => Err(malformed("an error code the API does not have")),
                    }
                }
                _ => Err(malformed("an error needs a code and a message, both text")),
            }
        }
        (None, None) => Err(malformed("neither a result nor an error")),
        (Some(_), Some(_)) => Err(malformed("both a result and an error")),
        _ => Err(malformed("a field that is not part of an answer")),
    }
}

/// Removes a pending call when its wait ends however it ends (answered, timed out, or the server
/// dropped the call), so a late answer finds nothing.
struct Pending<'a> {
    bridge: &'a ApiBridge,
    id: u64,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.bridge.lock().remove(&self.id);
    }
}

/// The [`ApiHandler`] of the app: hands each call to the page and waits for its answer.
///
/// The page may not be listening yet (the window is up while the page still restores its shells and
/// its settings), and an event sent then is lost. So the bridge starts not ready: a call that comes
/// before the page said so with `api_ready` is answered `failed` at once, with a message that says
/// the window is starting, instead of waiting out the deadline (NOR-F17-01d).
pub struct ApiBridge {
    sink: Arc<dyn CallSink>,
    timeout: Duration,
    next_id: AtomicU64,
    ready: AtomicBool,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl ApiBridge {
    pub fn new(sink: Arc<dyn CallSink>, timeout: Duration) -> Self {
        Self {
            sink,
            timeout,
            next_id: AtomicU64::new(1),
            ready: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Whether the page said it hears calls.
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// The page hears calls (`true`), or it is being loaded again and does not (`false`).
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Value>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// How many calls wait for the page.
    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.lock().len()
    }

    /// The answer of the page to call `id`. Returns whether a call was waiting for it: an id nobody
    /// waits for (never given, answered already, timed out) is ignored, and so is every answer after
    /// the first.
    pub fn respond(&self, id: u64, answer: Value) -> bool {
        let Some(waiter) = self.lock().remove(&id) else {
            return false;
        };
        waiter.send(answer).is_ok()
    }

    async fn round_trip(&self, call: ApiCall) -> Result<Value, ApiError> {
        if !self.is_ready() {
            return Err(ApiError::failed(STARTING_MESSAGE));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (answer_tx, answer_rx) = oneshot::channel();
        self.lock().insert(id, answer_tx);
        let _pending = Pending { bridge: self, id };
        match self.sink.send(call_event(id, &call)) {
            Ok(()) => {}
            Err(Undelivered::NoWindow) => {
                return Err(ApiError::failed("Noren has no main window to run the call"));
            }
            Err(Undelivered::Failed(reason)) => {
                return Err(ApiError::failed(format!(
                    "the call could not reach the window: {reason}"
                )));
            }
        }
        match tokio::time::timeout(self.timeout, answer_rx).await {
            Err(_) => Err(ApiError::new(
                ApiErrorCode::Timeout,
                "the window did not answer in time",
            )),
            Ok(Err(_)) => Err(ApiError::new(
                ApiErrorCode::Internal,
                "the answer of the window was lost",
            )),
            Ok(Ok(answer)) => outcome_of(answer),
        }
    }
}

impl ApiHandler for ApiBridge {
    fn handle(&self, call: ApiCall) -> ApiFuture<'_> {
        Box::pin(self.round_trip(call))
    }
}

/// The bridge, for the command that the page answers with.
pub struct ApiBridgeState(pub Arc<ApiBridge>);

/// The answer of the page to a call it was sent by [`CALL_EVENT`]. Only the main window may give it;
/// an id nobody waits for is ignored without a word (the page learns nothing about the calls).
#[tauri::command]
pub fn api_respond<R: Runtime>(
    window: tauri::Window<R>,
    state: State<'_, ApiBridgeState>,
    id: u64,
    outcome: Value,
) -> Result<(), String> {
    crate::windows::require_owner(&window)?;
    state.0.respond(id, outcome);
    Ok(())
}

/// The page says it hears calls now (`api-call` has a listener). Only the main window may say it,
/// and it says it once its listener is registered, after which the bridge sends it calls.
#[tauri::command]
pub fn api_ready<R: Runtime>(
    window: tauri::Window<R>,
    state: State<'_, ApiBridgeState>,
) -> Result<(), String> {
    crate::windows::require_owner(&window)?;
    state.0.set_ready(true);
    Ok(())
}

/// The main page starts loading (the first time, or again): nothing of it is listening yet, so the
/// bridge stops sending it calls until it says `api_ready`.
pub fn page_loading<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<ApiBridgeState>() {
        state.0.set_ready(false);
    }
}

/// Where the server listens and where it keeps its token.
#[derive(Debug, Clone)]
pub struct ApiSettings {
    /// The name of the endpoint, `api-<name>` (see `noren_core::api::api_endpoint`).
    pub endpoint_name: String,
    /// The token file.
    pub token_file: PathBuf,
    /// A folder the run made and removes when it ends (a smoke run); `None` for a normal start.
    pub sandbox: Option<PathBuf>,
}

impl ApiSettings {
    /// The endpoint of a normal installation, with the token in the data folder of the app, which is
    /// in the profile of the user (`<data folder>/api/token`; the folder is made when missing).
    pub fn normal(data_dir: &Path) -> Self {
        Self {
            endpoint_name: noren_core::api::DEFAULT_API_NAME.to_owned(),
            token_file: data_dir.join(API_DIR_NAME).join(TOKEN_FILE_NAME),
            sandbox: None,
        }
    }

    /// A run of its own (a smoke mode): an endpoint named for the run and a token in a folder only the
    /// run uses, so it never meets the API of a Noren the user has open.
    pub fn for_run(endpoint_name: String, dir: PathBuf) -> Self {
        Self {
            endpoint_name,
            token_file: dir.join(API_DIR_NAME).join(TOKEN_FILE_NAME),
            sandbox: Some(dir),
        }
    }
}

/// What [`install`] came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiStatus {
    /// The server is listening on this endpoint.
    Listening { endpoint: String },
    /// The server did not start; the app runs without the API. The reason is in the log.
    Off { reason: String },
}

/// The running server and what became of the start, kept by the app until it ends.
pub struct ApiState {
    server: Mutex<Option<ApiServer>>,
    status: ApiStatus,
    sandbox: Option<PathBuf>,
    /// Where a client finds the server: the endpoint and the file with the token. `None` when the
    /// server did not start.
    target: Option<ClientTarget>,
}

/// What a client needs to reach the server: its endpoint and the file that holds the token.
#[derive(Debug, Clone)]
pub struct ClientTarget {
    pub endpoint: Endpoint,
    pub token_file: PathBuf,
}

impl ApiState {
    pub fn status(&self) -> &ApiStatus {
        &self.status
    }

    /// The endpoint and token file of the running server, for a client of the same user.
    pub fn target(&self) -> Option<&ClientTarget> {
        self.target.as_ref()
    }

    /// Stops the server (once; later calls do nothing) and removes the folder of a run that made one.
    pub fn stop(&self) {
        let server = self.server.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut server) = server {
            server.shutdown();
        }
        if let Some(dir) = &self.sandbox {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn start_server(
    settings: &ApiSettings,
    bridge: Arc<ApiBridge>,
    config: ApiConfig,
) -> Result<(ApiServer, ClientTarget), String> {
    let (token, _origin) = load_or_create_token(&settings.token_file)
        .map_err(|e| format!("the token file could not be used: {e}"))?;
    let endpoint = api_endpoint(&settings.endpoint_name)
        .map_err(|e| format!("the endpoint could not be named: {e}"))?;
    let server = ApiServer::start(endpoint.clone(), token, bridge, config)
        .map_err(|e| format!("the endpoint could not be opened: {e}"))?;
    Ok((
        server,
        ClientTarget {
            endpoint,
            token_file: settings.token_file.clone(),
        },
    ))
}

/// Makes the bridge and starts the server. Both are kept in the state of the app: the bridge is what
/// `api_respond` answers to (managed even when the server did not start, so the command is always
/// backed), the [`ApiState`] is what stops the server when the app ends. A failure is told on
/// stderr and leaves the app without the API; it is never passed up.
pub fn install<R: Runtime>(app: &AppHandle<R>, settings: Result<ApiSettings, String>) {
    let config = ApiConfig::default();
    let bridge = Arc::new(ApiBridge::new(
        Arc::new(WindowSink::new(app.clone())),
        reply_timeout(&config),
    ));
    app.manage(ApiBridgeState(Arc::clone(&bridge)));
    let (server, status, sandbox, target) = match settings {
        Err(reason) => (None, ApiStatus::Off { reason }, None, None),
        Ok(settings) => match start_server(&settings, bridge, config) {
            Ok((server, target)) => (
                Some(server),
                ApiStatus::Listening {
                    endpoint: target.endpoint.to_string(),
                },
                settings.sandbox,
                Some(target),
            ),
            Err(reason) => (None, ApiStatus::Off { reason }, settings.sandbox, None),
        },
    };
    if let ApiStatus::Off { reason } = &status {
        eprintln!("warning: the local API is off ({reason})");
    }
    app.manage(ApiState {
        server: Mutex::new(server),
        status,
        sandbox,
        target,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use noren_core::api::protocol::parse_call;
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context};
    use tauri::webview::InvokeRequest;
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

    /// Longest a test waits for something that must happen.
    const STEP: Duration = Duration::from_secs(10);

    /// A sink that hands the calls to the test, which plays the page.
    struct FakeSink {
        sent: UnboundedSender<Value>,
        refuse: Option<Undelivered>,
    }

    impl CallSink for FakeSink {
        fn send(&self, payload: Value) -> Result<(), Undelivered> {
            if let Some(refusal) = &self.refuse {
                return Err(refusal.clone());
            }
            self.sent.send(payload).expect("the test is listening");
            Ok(())
        }
    }

    fn bridge_with(timeout: Duration) -> (Arc<ApiBridge>, UnboundedReceiver<Value>) {
        let (sent, calls) = unbounded_channel();
        let sink = FakeSink { sent, refuse: None };
        (ready(ApiBridge::new(Arc::new(sink), timeout)), calls)
    }

    fn bridge_that_refuses(refusal: Undelivered) -> Arc<ApiBridge> {
        let (sent, _calls) = unbounded_channel();
        let sink = FakeSink {
            sent,
            refuse: Some(refusal),
        };
        ready(ApiBridge::new(Arc::new(sink), Duration::from_secs(5)))
    }

    /// A bridge the page has said is listening (the way every test but the readiness ones starts).
    fn ready(bridge: ApiBridge) -> Arc<ApiBridge> {
        bridge.set_ready(true);
        Arc::new(bridge)
    }

    fn read_call(terminal: &str) -> ApiCall {
        ApiCall::TerminalRead {
            terminal: terminal.to_owned(),
            lines: Some(5),
        }
    }

    async fn next_call(calls: &mut UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(STEP, calls.recv())
            .await
            .expect("a call reached the page")
            .expect("the sink is open")
    }

    fn id_of(call: &Value) -> u64 {
        call["id"].as_u64().expect("an id")
    }

    // ---- the call as the page gets it -------------------------------------------------------

    fn every_shape_of_call() -> Vec<ApiCall> {
        vec![
            ApiCall::SpacesList,
            ApiCall::SpacesCreate {
                name: "Work".into(),
            },
            ApiCall::ItemsCreate {
                space: "s1".into(),
                cwd: None,
                profile: None,
            },
            ApiCall::ItemsCreate {
                space: "s1".into(),
                cwd: Some("C:\\work".into()),
                profile: Some("pwsh".into()),
            },
            ApiCall::SplitsCreate {
                item: "i1".into(),
                direction: SplitDirection::Right,
                cwd: None,
                profile: None,
            },
            ApiCall::SplitsCreate {
                item: "i1".into(),
                direction: SplitDirection::Down,
                cwd: Some("/tmp".into()),
                profile: Some("bash".into()),
            },
            ApiCall::TerminalSend {
                terminal: "p1".into(),
                text: Some("ls".into()),
                keys: vec![],
            },
            ApiCall::TerminalSend {
                terminal: "p1".into(),
                text: None,
                keys: vec!["Ctrl+C".into(), "Up".into()],
            },
            ApiCall::TerminalSend {
                terminal: "p1".into(),
                text: Some("echo \u{e9}\n".into()),
                keys: vec!["Enter".into()],
            },
            ApiCall::TerminalRead {
                terminal: "p1".into(),
                lines: None,
            },
            ApiCall::TerminalRead {
                terminal: "p1".into(),
                lines: Some(10_000),
            },
        ]
    }

    #[test]
    fn the_event_of_a_call_reads_back_as_the_same_call_through_the_parser_of_the_server() {
        for call in every_shape_of_call() {
            let event = call_event(7, &call);
            assert_eq!(event["id"], 7);
            let method = noren_core::api::ApiMethod::from_name(
                event["method"].as_str().expect("a method name"),
            )
            .expect("a method of the API");
            assert_eq!(method, call.method());
            let parsed = parse_call(method, Some(event["params"].clone())).expect("valid params");
            assert_eq!(parsed, call, "{event}");
        }
    }

    #[test]
    fn a_field_that_is_not_there_is_left_out_of_the_event_and_never_null() {
        let event = call_event(
            1,
            &ApiCall::ItemsCreate {
                space: "s".into(),
                cwd: None,
                profile: None,
            },
        );
        assert_eq!(event["params"], json!({ "space": "s" }));
        let event = call_event(
            2,
            &ApiCall::TerminalSend {
                terminal: "t".into(),
                text: Some(String::new()),
                keys: vec![],
            },
        );
        assert_eq!(event["params"], json!({ "terminal": "t", "text": "" }));
    }

    // ---- the deadline -----------------------------------------------------------------------

    #[test]
    fn the_bridge_gives_up_before_the_server_does() {
        let config = ApiConfig::default();
        assert!(reply_timeout(&config) < config.request_timeout);
        assert!(reply_timeout(&config) > Duration::ZERO);
        let tight = ApiConfig {
            request_timeout: Duration::from_secs(2),
            ..ApiConfig::default()
        };
        assert!(reply_timeout(&tight) < tight.request_timeout);
        let zero = ApiConfig {
            request_timeout: Duration::ZERO,
            ..ApiConfig::default()
        };
        assert!(reply_timeout(&zero) > Duration::ZERO);
    }

    // ---- the round trip ---------------------------------------------------------------------

    #[tokio::test]
    async fn the_right_answer_reaches_the_caller() {
        let (bridge, mut calls) = bridge_with(STEP);
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("p1")).await })
        };
        let sent = next_call(&mut calls).await;
        assert_eq!(sent["method"], "terminal.read");
        assert_eq!(sent["params"], json!({ "terminal": "p1", "lines": 5 }));
        assert_eq!(bridge.waiting(), 1);
        assert!(bridge.respond(id_of(&sent), json!({ "result": { "lines": ["a", "b"] } })));
        let result = waiting.await.expect("the task").expect("an answer");
        assert_eq!(result, json!({ "lines": ["a", "b"] }));
        assert_eq!(bridge.waiting(), 0);
    }

    #[tokio::test]
    async fn an_error_of_the_page_reaches_the_caller_with_its_code_and_message() {
        let (bridge, mut calls) = bridge_with(STEP);
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("nope")).await })
        };
        let sent = next_call(&mut calls).await;
        let error = json!({ "error": { "code": "not_found", "message": "no such terminal" } });
        assert!(bridge.respond(id_of(&sent), error));
        let error = waiting.await.expect("the task").expect_err("an error");
        assert_eq!(error.code, ApiErrorCode::NotFound);
        assert_eq!(error.message, "no such terminal");
    }

    #[tokio::test]
    async fn every_code_of_the_server_is_a_code_the_page_may_answer_with() {
        for name in [
            "invalid_json",
            "invalid_request",
            "unknown_method",
            "invalid_params",
            "frame_too_large",
            "unauthenticated",
            "unauthorized",
            "unsupported_version",
            "timeout",
            "shutting_down",
            "internal",
            "not_found",
            "failed",
        ] {
            let code = error_code(name).unwrap_or_else(|| panic!("{name} is not known"));
            assert_eq!(code.as_str(), name);
        }
        assert_eq!(error_code("nope"), None);
        assert_eq!(error_code(""), None);
        assert_eq!(error_code("NOT_FOUND"), None);
    }

    // ---- readiness: a call waits for nobody while the page is not listening -----------------

    /// A bridge the page has not said anything to yet, and the calls its sink was given.
    fn bridge_not_ready() -> (Arc<ApiBridge>, UnboundedReceiver<Value>) {
        let (sent, calls) = unbounded_channel();
        let sink = FakeSink { sent, refuse: None };
        let bridge = Arc::new(ApiBridge::new(Arc::new(sink), STEP));
        (bridge, calls)
    }

    #[tokio::test]
    async fn a_call_before_the_page_says_it_listens_fails_at_once_and_reaches_nobody() {
        let (bridge, mut calls) = bridge_not_ready();
        assert!(!bridge.is_ready(), "a bridge starts not ready");
        let started = std::time::Instant::now();
        // Bounded by the test, so a bridge that waits for a page that is not there fails here
        // instead of holding the test for the whole deadline.
        let error = tokio::time::timeout(Duration::from_secs(2), bridge.handle(read_call("p1")))
            .await
            .expect("the call was answered at once, not left waiting")
            .expect_err("the page is not listening");
        assert_eq!(error.code, ApiErrorCode::Failed);
        assert_eq!(error.message, STARTING_MESSAGE);
        assert!(error.message.contains("starting"), "{}", error.message);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(
            calls.try_recv().is_err(),
            "an event went to a page that does not listen"
        );
        assert_eq!(bridge.waiting(), 0);
    }

    #[tokio::test]
    async fn every_method_fails_the_same_way_while_the_page_is_not_listening() {
        let (bridge, mut calls) = bridge_not_ready();
        for call in every_shape_of_call() {
            let error = tokio::time::timeout(Duration::from_secs(2), bridge.handle(call))
                .await
                .expect("answered at once")
                .expect_err("the page is not listening");
            assert_eq!(error.code, ApiErrorCode::Failed);
            assert_eq!(error.message, STARTING_MESSAGE);
        }
        assert!(calls.try_recv().is_err());
    }

    #[tokio::test]
    async fn after_the_page_says_it_listens_the_call_goes_through_the_page() {
        let (bridge, mut calls) = bridge_not_ready();
        // Before: refused. After: sent to the page and answered by it.
        let early = tokio::time::timeout(Duration::from_secs(2), bridge.handle(read_call("p1")))
            .await
            .expect("answered at once");
        assert_eq!(early.expect_err("not ready").code, ApiErrorCode::Failed);

        bridge.set_ready(true);
        assert!(bridge.is_ready());
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("p1")).await })
        };
        let sent = next_call(&mut calls).await;
        assert_eq!(sent["method"], "terminal.read");
        assert!(bridge.respond(id_of(&sent), json!({ "result": { "lines": [] } })));
        let result = tokio::time::timeout(STEP, waiting)
            .await
            .expect("the call finished")
            .expect("the task ran")
            .expect("the page answered");
        assert_eq!(result, json!({ "lines": [] }));
    }

    #[tokio::test]
    async fn a_page_that_stops_listening_is_failed_again_and_a_pending_call_is_not_lost() {
        let (bridge, mut calls) = bridge_not_ready();
        bridge.set_ready(true);
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("p1")).await })
        };
        let sent = next_call(&mut calls).await;
        // The page is loaded again: new calls fail at once, the one in flight can still be answered.
        bridge.set_ready(false);
        let error = tokio::time::timeout(Duration::from_secs(2), bridge.handle(read_call("p2")))
            .await
            .expect("answered at once")
            .expect_err("not ready again");
        assert_eq!(error.message, STARTING_MESSAGE);
        assert!(bridge.respond(id_of(&sent), json!({ "result": 1 })));
        let result = tokio::time::timeout(STEP, waiting)
            .await
            .expect("finished")
            .expect("ran")
            .expect("answered");
        assert_eq!(result, json!(1));
    }

    /// Calls the command `cmd` from the window `label` in the mock runtime.
    fn command_from(label: &str, cmd: &str, bridge: &Arc<ApiBridge>) -> Result<(), Value> {
        let app = mock_builder()
            .manage(ApiBridgeState(Arc::clone(bridge)))
            .invoke_handler(tauri::generate_handler![api_ready])
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .expect("build the mock window");
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: url.parse().expect("url"),
                body: tauri::ipc::InvokeBody::Json(json!({})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|_| ())
    }

    #[test]
    fn the_main_window_says_the_page_is_ready_through_the_command() {
        let (bridge, _calls) = bridge_not_ready();
        assert_eq!(command_from("main", READY_COMMAND, &bridge), Ok(()));
        assert!(bridge.is_ready());
        // Saying it again changes nothing.
        assert_eq!(command_from("main", READY_COMMAND, &bridge), Ok(()));
        assert!(bridge.is_ready());
    }

    #[test]
    fn a_window_besides_the_main_one_cannot_say_the_page_is_ready() {
        for label in ["window-1", "quick", "browser-p1"] {
            let (bridge, _calls) = bridge_not_ready();
            assert!(
                command_from(label, READY_COMMAND, &bridge).is_err(),
                "{label} was allowed to say the main page is ready"
            );
            assert!(!bridge.is_ready(), "{label} made the bridge ready");
        }
    }

    #[test]
    fn loading_the_main_page_again_makes_the_bridge_not_ready_until_it_says_so() {
        let (bridge, _calls) = bridge_not_ready();
        bridge.set_ready(true);
        let app = mock_builder()
            .manage(ApiBridgeState(Arc::clone(&bridge)))
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        page_loading(app.handle());
        assert!(!bridge.is_ready());
        // An app that has no bridge (it did not get to install the API) is left alone.
        let bare = mock_builder()
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        page_loading(bare.handle());
    }

    #[test]
    fn the_command_is_spelled_as_the_page_and_the_lists_spell_it() {
        assert_eq!(READY_COMMAND, "api_ready");
        let build = include_str!("../build.rs");
        let capability = include_str!("../capabilities/default.json");
        assert!(build.contains("\"api_ready\""), "build.rs");
        assert!(capability.contains("allow-api-ready"), "default.json");
        let window = include_str!("../capabilities/window.json");
        assert!(!window.contains("allow-api-ready"), "window.json");
    }

    #[tokio::test]
    async fn a_page_that_does_not_answer_in_time_is_a_timeout_and_a_late_answer_is_ignored() {
        let (bridge, mut calls) = bridge_with(Duration::from_millis(60));
        let started = std::time::Instant::now();
        // Bounded by the test, so a deadline that is ignored fails here and does not hang.
        let error = tokio::time::timeout(Duration::from_secs(3), bridge.handle(read_call("p1")))
            .await
            .expect("the bridge gave up on the page at its deadline")
            .expect_err("no answer came");
        assert_eq!(error.code, ApiErrorCode::Timeout);
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert!(started.elapsed() < Duration::from_secs(5));
        // The call was sent, but nobody waits for it any more.
        let sent = next_call(&mut calls).await;
        assert_eq!(bridge.waiting(), 0);
        assert!(!bridge.respond(id_of(&sent), json!({ "result": 1 })));
    }

    #[tokio::test]
    async fn an_answer_for_an_id_nobody_gave_is_ignored_and_the_call_goes_on_waiting() {
        let (bridge, mut calls) = bridge_with(Duration::from_millis(150));
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("p1")).await })
        };
        let sent = next_call(&mut calls).await;
        let real = id_of(&sent);
        for unknown in [0, real + 1, real + 1000, u64::MAX] {
            assert!(!bridge.respond(unknown, json!({ "result": "wrong" })));
        }
        assert_eq!(bridge.waiting(), 1);
        // The call was not answered by any of them.
        let error = tokio::time::timeout(Duration::from_secs(3), waiting)
            .await
            .expect("the bridge gave up on the page at its deadline")
            .expect("the task")
            .expect_err("still no answer");
        assert_eq!(error.code, ApiErrorCode::Timeout);
    }

    #[tokio::test]
    async fn a_second_answer_for_the_same_call_is_ignored() {
        let (bridge, mut calls) = bridge_with(STEP);
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("p1")).await })
        };
        let sent = next_call(&mut calls).await;
        let id = id_of(&sent);
        assert!(bridge.respond(id, json!({ "result": "first" })));
        assert!(!bridge.respond(id, json!({ "result": "second" })));
        assert!(!bridge.respond(id, json!({ "error": { "code": "failed", "message": "x" } })));
        assert_eq!(
            waiting.await.expect("the task").expect("an answer"),
            json!("first")
        );
    }

    #[tokio::test]
    async fn two_calls_at_once_get_two_ids_and_each_gets_its_own_answer() {
        let (bridge, mut calls) = bridge_with(STEP);
        let first = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("one")).await })
        };
        let second = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("two")).await })
        };
        let (a, b) = (next_call(&mut calls).await, next_call(&mut calls).await);
        assert_ne!(id_of(&a), id_of(&b));
        assert_eq!(bridge.waiting(), 2);
        // Answered in the other order, by terminal name.
        for sent in [&b, &a] {
            let terminal = sent["params"]["terminal"].as_str().expect("terminal");
            assert!(bridge.respond(id_of(sent), json!({ "result": terminal })));
        }
        assert_eq!(
            first.await.expect("task").expect("answer"),
            json!("one"),
            "the first caller got the answer of the other"
        );
        assert_eq!(second.await.expect("task").expect("answer"), json!("two"));
    }

    #[tokio::test]
    async fn without_a_main_window_the_call_fails_at_once_and_nothing_is_left_waiting() {
        let bridge = bridge_that_refuses(Undelivered::NoWindow);
        let error = bridge
            .handle(ApiCall::SpacesList)
            .await
            .expect_err("no window");
        assert_eq!(error.code, ApiErrorCode::Failed);
        assert!(error.message.contains("main window"), "{}", error.message);
        assert_eq!(bridge.waiting(), 0);

        let bridge = bridge_that_refuses(Undelivered::Failed("closed".into()));
        let error = bridge
            .handle(ApiCall::SpacesList)
            .await
            .expect_err("not sent");
        assert_eq!(error.code, ApiErrorCode::Failed);
        assert!(error.message.contains("closed"));
        assert_eq!(bridge.waiting(), 0);
    }

    #[tokio::test]
    async fn a_call_that_is_dropped_leaves_nothing_waiting() {
        // The server drops the future when its own limit runs out or when it shuts down.
        let (bridge, mut calls) = bridge_with(STEP);
        let waiting = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move { bridge.handle(read_call("p1")).await })
        };
        let sent = next_call(&mut calls).await;
        assert_eq!(bridge.waiting(), 1);
        waiting.abort();
        let _ = waiting.await;
        assert_eq!(bridge.waiting(), 0);
        assert!(!bridge.respond(id_of(&sent), json!({ "result": 1 })));
    }

    #[test]
    fn what_the_page_answers_is_checked_before_it_is_believed() {
        let bad = |answer: Value| {
            let error = outcome_of(answer.clone()).expect_err(&format!("{answer}"));
            assert_eq!(error.code, ApiErrorCode::Internal, "{answer}");
        };
        bad(json!(null));
        bad(json!("ok"));
        bad(json!([1]));
        bad(json!({}));
        bad(json!({ "result": 1, "error": { "code": "failed", "message": "x" } }));
        bad(json!({ "result": 1, "extra": true }));
        bad(json!({ "id": 3, "result": 1 }));
        bad(json!({ "error": "failed" }));
        bad(json!({ "error": { "code": "failed" } }));
        bad(json!({ "error": { "message": "x" } }));
        bad(json!({ "error": { "code": 3, "message": "x" } }));
        bad(json!({ "error": { "code": "failed", "message": 3 } }));
        bad(json!({ "error": { "code": "made_up", "message": "x" } }));
        bad(json!({ "error": { "code": "failed", "message": "x", "extra": 1 } }));
        bad(json!({ "error": { "code": "failed", "message": "x" }, "extra": 1 }));
        // A result may be anything JSON, null included.
        for result in [
            json!(null),
            json!(0),
            json!("text"),
            json!([1, 2]),
            json!({ "a": { "b": [] } }),
        ] {
            assert_eq!(outcome_of(json!({ "result": result.clone() })), Ok(result));
        }
    }

    // ---- the command and the window ---------------------------------------------------------

    /// Calls `api_respond` from the window `label`, in the mock runtime, with a bridge that has `id`
    /// waiting. Returns the answer of the command and what the waiting call got.
    fn respond_through_command(
        label: &str,
        id: u64,
        outcome: Value,
        wait_for: u64,
    ) -> (Result<(), Value>, Option<Value>) {
        let (sent, _calls) = unbounded_channel();
        let bridge = ready(ApiBridge::new(
            Arc::new(FakeSink { sent, refuse: None }),
            Duration::from_secs(5),
        ));
        let (tx, mut rx) = oneshot::channel();
        bridge.lock().insert(wait_for, tx);
        let app = mock_builder()
            .manage(ApiBridgeState(Arc::clone(&bridge)))
            .invoke_handler(tauri::generate_handler![api_respond])
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .expect("build the mock window");
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        let answer = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: RESPOND_COMMAND.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: url.parse().expect("url"),
                body: tauri::ipc::InvokeBody::Json(json!({ "id": id, "outcome": outcome })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        );
        (answer.map(|_| ()), rx.try_recv().ok())
    }

    #[test]
    fn the_main_window_answers_a_call_through_the_command() {
        let (answer, got) = respond_through_command("main", 5, json!({ "result": [1] }), 5);
        assert_eq!(answer, Ok(()));
        assert_eq!(got, Some(json!({ "result": [1] })));
    }

    #[test]
    fn the_command_ignores_an_id_nobody_waits_for_and_says_nothing_about_it() {
        let (answer, got) = respond_through_command("main", 6, json!({ "result": 1 }), 5);
        assert_eq!(answer, Ok(()));
        assert_eq!(
            got, None,
            "the call of id 5 was answered by an answer for 6"
        );
    }

    #[test]
    fn a_window_besides_the_main_one_cannot_answer_a_call() {
        for label in ["window-1", "quick", "browser-p1"] {
            let (answer, got) = respond_through_command(label, 5, json!({ "result": 1 }), 5);
            assert!(answer.is_err(), "{label} was allowed to answer");
            assert_eq!(got, None, "{label} answered the call");
        }
    }

    /// The mock app with the windows named, and the sink over it.
    fn app_with_windows(labels: &[&str]) -> tauri::App<MockRuntime> {
        let app = mock_builder()
            .build(mock_context(tauri::test::noop_assets()))
            .expect("build the mock app");
        for label in labels {
            tauri::WebviewWindowBuilder::new(&app, *label, Default::default())
                .build()
                .expect("build the mock window");
        }
        app
    }

    #[test]
    fn the_sink_has_nowhere_to_send_a_call_when_there_is_no_main_window() {
        let app = app_with_windows(&["window-1"]);
        let sink = WindowSink::new(app.handle().clone());
        assert_eq!(
            sink.send(json!({ "id": 1 })),
            Err(Undelivered::NoWindow),
            "a call went to a window that is not the main one"
        );
    }

    #[test]
    fn the_sink_sends_a_call_to_the_main_window_and_to_no_other() {
        use tauri::Listener;
        let app = app_with_windows(&["main", "window-1"]);
        let (main_tx, main_rx) = std::sync::mpsc::channel::<String>();
        let (other_tx, other_rx) = std::sync::mpsc::channel::<String>();
        let main = app.get_webview_window("main").expect("main");
        let other = app.get_webview_window("window-1").expect("other");
        main.listen(CALL_EVENT, move |event| {
            let _ = main_tx.send(event.payload().to_owned());
        });
        other.listen(CALL_EVENT, move |event| {
            let _ = other_tx.send(event.payload().to_owned());
        });
        let sink = WindowSink::new(app.handle().clone());
        sink.send(json!({ "id": 9, "method": "spaces.list", "params": {} }))
            .expect("sent");
        let heard = main_rx
            .recv_timeout(STEP)
            .expect("the main window heard it");
        let heard: Value = serde_json::from_str(&heard).expect("JSON");
        assert_eq!(heard["id"], 9);
        assert!(
            other_rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "another window heard the call"
        );
    }

    // ---- starting the server ----------------------------------------------------------------

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique() -> String {
        format!(
            "{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("noren-api-bridge-{}", unique()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_normal_start_keeps_the_token_in_the_data_folder_of_the_app() {
        let data = PathBuf::from("data-folder");
        let settings = ApiSettings::normal(&data);
        assert_eq!(settings.endpoint_name, "default");
        assert_eq!(
            settings.token_file,
            data.join("api").join("token"),
            "the token is not in the data folder of the app"
        );
        assert_eq!(settings.sandbox, None);
    }

    #[test]
    fn a_run_of_its_own_has_an_endpoint_and_a_token_folder_that_only_it_uses() {
        let dir = PathBuf::from("run-folder");
        let settings = ApiSettings::for_run("smoke-1-2".into(), dir.clone());
        assert_ne!(settings.endpoint_name, "default");
        assert!(settings.token_file.starts_with(&dir));
        assert_eq!(settings.sandbox, Some(dir));
    }

    #[test]
    fn the_server_starts_with_the_token_file_made_and_stops_with_the_folder_of_the_run_removed() {
        let dir = temp_dir();
        let app = app_with_windows(&["main"]);
        install(
            app.handle(),
            Ok(ApiSettings::for_run(
                format!("test-{}", unique()),
                dir.clone(),
            )),
        );
        let state = app.state::<ApiState>();
        let ApiStatus::Listening { endpoint } = state.status() else {
            panic!("the server did not start: {:?}", state.status());
        };
        assert!(endpoint.contains("api-test-"), "{endpoint}");
        let token = std::fs::read_to_string(dir.join("api").join("token")).expect("token file");
        assert_eq!(token.trim().len(), 64, "a token of 32 bytes in hexadecimal");
        // The bridge is there for the command whether or not the server started.
        assert!(app.try_state::<ApiBridgeState>().is_some());
        state.stop();
        assert!(!dir.exists(), "the folder of the run was left behind");
        state.stop();
    }

    #[test]
    fn a_server_that_cannot_start_leaves_the_app_running_without_the_api() {
        let dir = temp_dir();
        // A file where the folder of the token must be: the token cannot be written.
        std::fs::write(dir.join("api"), b"in the way").expect("file");
        let app = app_with_windows(&["main"]);
        install(
            app.handle(),
            Ok(ApiSettings::for_run(
                format!("test-{}", unique()),
                dir.clone(),
            )),
        );
        let state = app.state::<ApiState>();
        assert!(
            matches!(state.status(), ApiStatus::Off { .. }),
            "{:?}",
            state.status()
        );
        assert!(
            app.try_state::<ApiBridgeState>().is_some(),
            "the command would have no state to answer to"
        );
        state.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_app_whose_data_folder_is_unknown_runs_without_the_api() {
        let app = app_with_windows(&["main"]);
        install(app.handle(), Err("no data folder".into()));
        assert_eq!(
            app.state::<ApiState>().status(),
            &ApiStatus::Off {
                reason: "no data folder".into()
            }
        );
        assert!(app.try_state::<ApiBridgeState>().is_some());
        app.state::<ApiState>().stop();
    }

    #[test]
    fn an_endpoint_that_is_taken_leaves_the_app_running_without_the_api() {
        let name = format!("test-{}", unique());
        let first_dir = temp_dir();
        let second_dir = temp_dir();
        let app = app_with_windows(&["main"]);
        install(
            app.handle(),
            Ok(ApiSettings::for_run(name.clone(), first_dir.clone())),
        );
        assert!(matches!(
            app.state::<ApiState>().status(),
            ApiStatus::Listening { .. }
        ));
        let second = app_with_windows(&["main"]);
        install(
            second.handle(),
            Ok(ApiSettings::for_run(name, second_dir.clone())),
        );
        assert!(
            matches!(second.state::<ApiState>().status(), ApiStatus::Off { .. }),
            "a second server took an endpoint that was in use"
        );
        second.state::<ApiState>().stop();
        app.state::<ApiState>().stop();
        let _ = (
            std::fs::remove_dir_all(&first_dir),
            std::fs::remove_dir_all(&second_dir),
        );
    }

    // ---- the whole way: a client on the pipe, the server, the bridge, a page that answers ----

    #[tokio::test]
    async fn a_client_of_the_pipe_gets_the_answer_the_page_gave_and_a_page_that_is_silent_times_out()
     {
        use noren_core::api::to_frame;
        use noren_core::daemon::ipc;
        use noren_core::daemon::{read_frame, write_frame};
        use tokio::io::split;

        let dir = temp_dir();
        let token_file = dir.join("api").join("token");
        let (sent, mut calls) = unbounded_channel();
        let config = ApiConfig {
            request_timeout: Duration::from_secs(2),
            ..ApiConfig::default()
        };
        let bridge = ready(ApiBridge::new(
            Arc::new(FakeSink { sent, refuse: None }),
            Duration::from_millis(400),
        ));
        assert!(reply_timeout(&config) <= config.request_timeout);
        let (token, _) = load_or_create_token(&token_file).expect("token");
        let endpoint = api_endpoint(&format!("test-{}", unique())).expect("endpoint");
        let mut server =
            ApiServer::start(endpoint.clone(), token, Arc::clone(&bridge) as _, config)
                .expect("server");

        // The page, played by the test: answers the call whose terminal is "known", ignores the rest.
        let page = {
            let bridge = Arc::clone(&bridge);
            tokio::spawn(async move {
                while let Some(call) = calls.recv().await {
                    if call["params"]["terminal"] == "known" {
                        let id = call["id"].as_u64().expect("id");
                        bridge.respond(id, json!({ "result": { "lines": ["hello"] } }));
                    }
                }
            })
        };

        let stream = ipc::connect(&endpoint).await.expect("connect");
        let (mut reader, mut writer) = split(stream);
        let token_text = std::fs::read_to_string(&token_file).expect("token");
        let auth = json!({ "type": "auth", "version": 1, "token": token_text.trim() });
        write_frame(
            &mut writer,
            &to_frame(auth.to_string().as_bytes()).expect("frame"),
        )
        .await
        .expect("auth");
        let welcome = read_frame(&mut reader).await.expect("welcome");
        assert!(String::from_utf8_lossy(&welcome).contains("welcome"));

        let request = |id: u64, terminal: &str| json!({ "id": id, "method": "terminal.read", "params": { "terminal": terminal } });
        write_frame(
            &mut writer,
            &to_frame(request(1, "known").to_string().as_bytes()).expect("frame"),
        )
        .await
        .expect("request");
        let answer: Value =
            serde_json::from_slice(&read_frame(&mut reader).await.expect("answer")).expect("JSON");
        assert_eq!(answer, json!({ "id": 1, "result": { "lines": ["hello"] } }));

        write_frame(
            &mut writer,
            &to_frame(request(2, "silent").to_string().as_bytes()).expect("frame"),
        )
        .await
        .expect("request");
        let answer: Value =
            serde_json::from_slice(&read_frame(&mut reader).await.expect("answer")).expect("JSON");
        assert_eq!(answer["id"], 2);
        assert_eq!(answer["error"]["code"], "timeout");
        assert_eq!(
            answer["error"]["message"], "the window did not answer in time",
            "the bridge gave up before the limit of the server (\"the call took too long\")"
        );
        assert_eq!(bridge.waiting(), 0);

        page.abort();
        drop(reader);
        drop(writer);
        server.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

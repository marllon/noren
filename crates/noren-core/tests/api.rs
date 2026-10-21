//! Integration tests of the local API: a real `ApiServer` on a real named pipe or Unix socket,
//! real clients on the same machine, and a fake handler that records what it is asked. The server
//! runs on its own thread with its own runtime and the tests are its clients, so they cross the
//! same boundary a second process would; nothing here reaches the network, opens a window or
//! starts a shell. Every endpoint and token file has its own name (process id and a counter), so
//! the tests run in parallel without meeting each other.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use noren_core::api::{
    API_PROTOCOL_VERSION, AgentState, ApiCall, ApiConfig, ApiError, ApiEvent, ApiFuture,
    ApiHandler, ApiServer, ApiToken, EventPublisher, MAX_OUTPUT_CHUNK_BYTES, TokenOrigin,
    api_endpoint, load_or_create_token, to_frame,
};
use noren_core::daemon::ipc::{self, ClientStream};
use noren_core::daemon::protocol::MAX_FRAME_BYTES;
use noren_core::daemon::{Endpoint, FrameError, read_frame, write_frame};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Barrier, Notify};

/// Longest a whole test may take.
const TEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Longest one wait for the server may take.
const STEP: Duration = Duration::from_secs(10);

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn unique() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

fn endpoint() -> Endpoint {
    api_endpoint(&format!("test-{}", unique())).expect("a valid endpoint name")
}

/// A folder of its own for a token file; removed by the test that asked for it.
fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("noren-api-test-{}", unique()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

async fn within<T>(body: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(TEST_TIMEOUT, body)
        .await
        .expect("the test timed out")
}

/// What the fake handler does for the terminal a call names.
struct FakeHandler {
    calls: Mutex<Vec<ApiCall>>,
    /// Two calls for the terminal `meet` finish only when both are inside the handler.
    meeting: Barrier,
    /// A call for the terminal `gate` finishes when a test lets it.
    gate: Notify,
}

impl FakeHandler {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            meeting: Barrier::new(2),
            gate: Notify::new(),
        })
    }

    fn calls(&self) -> Vec<ApiCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl ApiHandler for FakeHandler {
    fn handle(&self, call: ApiCall) -> ApiFuture<'_> {
        self.calls.lock().unwrap().push(call.clone());
        Box::pin(async move {
            match call {
                ApiCall::SpacesList => Ok(json!({ "spaces": [] })),
                ApiCall::TerminalRead { terminal, .. } => match terminal.as_str() {
                    "meet" => {
                        self.meeting.wait().await;
                        Ok(json!({ "text": "met" }))
                    }
                    "gate" => {
                        self.gate.notified().await;
                        Ok(json!({ "text": "opened" }))
                    }
                    "slow" => {
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                        Ok(Value::Null)
                    }
                    "panic" => panic!("the fake handler panics on purpose"),
                    "big" => Ok(json!({ "text": "x".repeat(MAX_FRAME_BYTES + 10) })),
                    "missing" => Err(ApiError::not_found("no such terminal")),
                    _ => Ok(json!({ "text": "hello" })),
                },
                other => Ok(json!({ "echo": format!("{other:?}") })),
            }
        })
    }
}

struct Running {
    server: ApiServer,
    handler: Arc<FakeHandler>,
    token: String,
}

fn start_with(config: ApiConfig) -> Running {
    let handler = FakeHandler::new();
    let token = ApiToken::generate().unwrap();
    let hex = token.to_hex();
    let server = ApiServer::start(
        endpoint(),
        token,
        Arc::clone(&handler) as Arc<dyn ApiHandler>,
        config,
    )
    .expect("the API server starts");
    Running {
        server,
        handler,
        token: hex,
    }
}

fn start() -> Running {
    start_with(ApiConfig::default())
}

struct Client(ClientStream);

impl Client {
    async fn connect(endpoint: &Endpoint) -> Client {
        Client(ipc::connect(endpoint).await.expect("connect to the API"))
    }

    async fn send_raw(&mut self, bytes: &[u8]) {
        self.0.write_all(bytes).await.expect("write");
        self.0.flush().await.expect("flush");
    }

    async fn send_payload(&mut self, payload: &[u8]) {
        let frame = to_frame(payload).expect("a frame");
        write_frame(&mut self.0, &frame).await.expect("write");
    }

    async fn send(&mut self, message: Value) {
        self.send_payload(message.to_string().as_bytes()).await;
    }

    /// Writes a message and does not mind if the server has already closed the connection (it
    /// does so as soon as it has refused the authentication that came before).
    async fn send_if_open(&mut self, message: Value) {
        let frame = to_frame(message.to_string().as_bytes()).expect("a frame");
        let _ = write_frame(&mut self.0, &frame).await;
    }

    async fn try_recv(&mut self) -> Result<Value, FrameError> {
        let payload = tokio::time::timeout(STEP, read_frame(&mut self.0))
            .await
            .expect("the server answered in time")?;
        Ok(serde_json::from_slice(&payload).expect("the server speaks JSON"))
    }

    async fn recv(&mut self) -> Value {
        self.try_recv().await.expect("an answer")
    }

    /// Whether the server closed the connection: the next read ends instead of giving a frame.
    async fn is_closed(&mut self) -> bool {
        matches!(
            tokio::time::timeout(STEP, read_frame(&mut self.0)).await,
            Ok(Err(_))
        )
    }

    /// Reading ended with a timeout, so the connection is still open.
    async fn is_open_and_quiet(&mut self) -> bool {
        tokio::time::timeout(Duration::from_millis(300), read_frame(&mut self.0))
            .await
            .is_err()
    }

    async fn auth_with(&mut self, token: &str) {
        self.send(json!({ "type": "auth", "version": API_PROTOCOL_VERSION, "token": token }))
            .await;
    }

    /// Connects and authenticates with the right token.
    async fn open(running: &Running) -> Client {
        let mut client = Client::connect(running.server.endpoint()).await;
        client.auth_with(&running.token).await;
        let welcome = client.recv().await;
        assert_eq!(welcome, json!({ "type": "welcome", "version": 1 }));
        client
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({ "id": id, "method": method, "params": params }))
            .await;
        self.recv().await
    }
}

fn error_code(answer: &Value) -> &str {
    answer["error"]["code"].as_str().expect("an error answer")
}

#[tokio::test]
async fn the_right_token_is_welcomed_and_a_request_is_answered() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        let answer = client.call(1, "spaces.list", json!({})).await;
        assert_eq!(answer, json!({ "id": 1, "result": { "spaces": [] } }));
        // The id comes back as sent, and the validated call reached the handler.
        let answer = client
            .call(
                42,
                "terminal.send",
                json!({ "terminal": "t1", "text": "ls\r", "keys": ["Enter"] }),
            )
            .await;
        assert_eq!(answer["id"], 42);
        assert!(answer["result"]["echo"].is_string(), "{answer}");
        assert_eq!(
            running.handler.calls(),
            vec![
                ApiCall::SpacesList,
                ApiCall::TerminalSend {
                    terminal: "t1".into(),
                    text: Some("ls\r".into()),
                    keys: vec!["Enter".into()],
                }
            ]
        );
    })
    .await;
}

#[tokio::test]
async fn an_error_of_the_handler_is_an_error_answer_with_its_code() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        let answer = client
            .call(5, "terminal.read", json!({ "terminal": "missing" }))
            .await;
        assert_eq!(answer["id"], 5);
        assert_eq!(error_code(&answer), "not_found");
        assert_eq!(answer["error"]["message"], "no such terminal");
        // The connection goes on.
        let answer = client
            .call(6, "terminal.read", json!({ "terminal": "t" }))
            .await;
        assert_eq!(answer["result"]["text"], "hello");
    })
    .await;
}

#[tokio::test]
async fn a_wrong_token_is_refused_the_connection_closes_and_the_handler_is_not_called() {
    within(async {
        let running = start();
        // Another token, one character off at the end and at the start, a token that is one
        // character short or long, nothing at all and text that is not a token.
        let other = ApiToken::generate().unwrap().to_hex();
        let mut one_off = running.token.clone();
        one_off.replace_range(63..64, if one_off.ends_with('0') { "1" } else { "0" });
        let mut first_off = running.token.clone();
        first_off.replace_range(0..1, if first_off.starts_with('0') { "1" } else { "0" });
        let wrong = [
            other,
            one_off,
            first_off,
            running.token[..63].to_owned(),
            format!("{}0", running.token),
            String::new(),
            "not a token".to_owned(),
        ];
        for token in wrong {
            let mut client = Client::connect(running.server.endpoint()).await;
            client.auth_with(&token).await;
            let answer = client.recv().await;
            assert_eq!(error_code(&answer), "unauthorized", "{token:?}");
            assert_eq!(answer["id"], Value::Null);
            assert!(!answer.to_string().contains(&running.token));
            assert!(client.is_closed().await, "{token:?}");
        }
        assert_eq!(running.handler.calls(), vec![]);
    })
    .await;
}

#[tokio::test]
async fn an_auth_without_a_token_or_with_another_shape_is_refused_and_closes() {
    within(async {
        let running = start();
        let messages = [
            json!({ "type": "auth", "version": 1 }),
            json!({ "type": "auth", "version": 1, "token": 5 }),
            json!({ "type": "auth", "version": 1, "token": null }),
            json!({ "version": 1, "token": running.token }),
            json!({ "type": "auth", "version": 1, "token": running.token, "extra": 1 }),
            json!({ "type": "hello", "version": 1, "token": running.token }),
            json!([running.token]),
        ];
        for message in messages {
            let mut client = Client::connect(running.server.endpoint()).await;
            client.send(message.clone()).await;
            let answer = client.recv().await;
            assert_eq!(error_code(&answer), "invalid_request", "{message}");
            assert!(client.is_closed().await, "{message}");
        }
        // Not JSON at all.
        let mut client = Client::connect(running.server.endpoint()).await;
        client.send_payload(b"{\"type\":\"auth\"").await;
        assert_eq!(error_code(&client.recv().await), "invalid_json");
        assert!(client.is_closed().await);
        // Another version of the conversation.
        let mut client = Client::connect(running.server.endpoint()).await;
        client
            .send(json!({ "type": "auth", "version": 2, "token": running.token }))
            .await;
        assert_eq!(error_code(&client.recv().await), "unsupported_version");
        assert!(client.is_closed().await);
        assert_eq!(running.handler.calls(), vec![]);
    })
    .await;
}

#[tokio::test]
async fn a_connection_that_never_authenticates_is_closed_after_the_timeout() {
    within(async {
        let running = start_with(ApiConfig {
            handshake_timeout: Duration::from_millis(300),
            ..ApiConfig::default()
        });
        let mut silent = Client::connect(running.server.endpoint()).await;
        assert_eq!(error_code(&silent.recv().await), "timeout");
        assert!(silent.is_closed().await);
        // A client that stops in the middle of a frame is not waited for either.
        let mut cut = Client::connect(running.server.endpoint()).await;
        cut.send_raw(&[0, 0, 0, 50, b'{']).await;
        assert_eq!(error_code(&cut.recv().await), "timeout");
        assert!(cut.is_closed().await);
        assert_eq!(running.handler.calls(), vec![]);
    })
    .await;
}

#[tokio::test]
async fn a_request_before_the_authentication_is_refused_and_the_handler_is_not_called() {
    within(async {
        let running = start();
        let mut client = Client::connect(running.server.endpoint()).await;
        client
            .send(json!({ "id": 1, "method": "spaces.list", "params": {} }))
            .await;
        let answer = client.recv().await;
        assert_eq!(error_code(&answer), "unauthenticated");
        assert!(client.is_closed().await);
        // Not even by sending the request right behind a wrong auth.
        let mut client = Client::connect(running.server.endpoint()).await;
        client.auth_with(&"0".repeat(64)).await;
        client
            .send_if_open(json!({ "id": 2, "method": "terminal.send", "params": { "terminal": "t", "text": "rm -rf /" } }))
            .await;
        assert_eq!(error_code(&client.recv().await), "unauthorized");
        assert!(client.is_closed().await);
        assert_eq!(running.handler.calls(), vec![]);
    })
    .await;
}

#[tokio::test]
async fn invalid_json_is_an_error_answer_and_the_connection_goes_on() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        for payload in [
            &b"not json"[..],
            b"{\"id\":1",
            b"[1,2,3]",
            b"\"text\"",
            b"null",
            &[0xff, 0xfe, 0xfd],
            b"{\"id\":1}",
            b"{\"method\":\"spaces.list\"}",
            b"{\"id\":-3,\"method\":\"spaces.list\"}",
        ] {
            client.send_payload(payload).await;
            let answer = client.recv().await;
            assert!(
                matches!(error_code(&answer), "invalid_json" | "invalid_request"),
                "{payload:?}: {answer}"
            );
        }
        // A very deep list is an error and not a stack overflow.
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        client.send_payload(deep.as_bytes()).await;
        assert_eq!(error_code(&client.recv().await), "invalid_json");
        let answer = client.call(9, "spaces.list", json!({})).await;
        assert_eq!(answer["result"], json!({ "spaces": [] }));
        assert_eq!(running.handler.calls(), vec![ApiCall::SpacesList]);
    })
    .await;
}

#[tokio::test]
async fn an_unknown_method_an_extra_field_or_wrong_params_are_errors_with_the_id() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        let answer = client.call(1, "files.delete", json!({ "path": "/" })).await;
        assert_eq!(
            (answer["id"].as_u64(), error_code(&answer)),
            (Some(1), "unknown_method")
        );
        client
            .send(json!({ "id": 2, "method": "spaces.list", "extra": true }))
            .await;
        let answer = client.recv().await;
        assert_eq!(
            (answer["id"].as_u64(), error_code(&answer)),
            (Some(2), "invalid_request")
        );
        let wrong = [
            ("spaces.list", json!({ "x": 1 })),
            ("spaces.create", json!({})),
            ("spaces.create", json!({ "name": 7 })),
            ("items.create", json!({ "space": "s", "cwd": "" })),
            (
                "splits.create",
                json!({ "item": "i", "direction": "sideways" }),
            ),
            ("terminal.send", json!({ "terminal": "t" })),
            (
                "terminal.send",
                json!({ "terminal": "t", "text": "x", "extra": 1 }),
            ),
            ("terminal.read", json!({ "terminal": "t", "lines": 0 })),
            ("terminal.read", json!([])),
            ("notify", json!({})),
            ("notify", json!({ "title": "" })),
            ("notify", json!({ "title": "x".repeat(129) })),
            ("notify", json!({ "title": "ok", "body": "x".repeat(1025) })),
            ("notify", json!({ "title": "ok", "extra": 1 })),
        ];
        for (n, (method, params)) in (10u64..).zip(wrong) {
            let answer = client.call(n, method, params.clone()).await;
            assert_eq!(
                (answer["id"].as_u64(), error_code(&answer)),
                (Some(n), "invalid_params"),
                "{method} {params}"
            );
        }
        // The connection and the server are fine, and the handler never saw any of it.
        let answer = client.call(99, "spaces.list", json!({})).await;
        assert_eq!(answer["id"], 99);
        assert_eq!(running.handler.calls(), vec![ApiCall::SpacesList]);
    })
    .await;
}

#[tokio::test]
async fn notify_reaches_the_handler_with_its_checked_fields() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        let answer = client
            .call(
                1,
                "notify",
                json!({ "title": "Build done", "body": "all green", "terminal": "p1" }),
            )
            .await;
        assert_eq!(answer["id"], 1);
        assert!(answer.get("result").is_some(), "{answer}");
        let answer = client
            .call(2, "notify", json!({ "title": "Only a title" }))
            .await;
        assert!(answer.get("result").is_some(), "{answer}");
        assert_eq!(
            running.handler.calls(),
            vec![
                ApiCall::Notify {
                    title: "Build done".into(),
                    body: Some("all green".into()),
                    terminal: Some("p1".into()),
                },
                ApiCall::Notify {
                    title: "Only a title".into(),
                    body: None,
                    terminal: None,
                },
            ]
        );
    })
    .await;
}

#[tokio::test]
async fn a_frame_above_the_limit_is_refused_unread_and_closes_the_connection() {
    within(async {
        let running = start();
        // After the authentication.
        let mut client = Client::open(&running).await;
        let too_long = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
        client.send_raw(&too_long).await;
        let answer = client.recv().await;
        assert_eq!(error_code(&answer), "frame_too_large");
        assert!(client.is_closed().await);
        // Before it, and with the biggest length a header can hold.
        let mut client = Client::connect(running.server.endpoint()).await;
        client.send_raw(&u32::MAX.to_be_bytes()).await;
        assert_eq!(error_code(&client.recv().await), "frame_too_large");
        assert!(client.is_closed().await);
        // A zero length is not a frame either.
        let mut client = Client::open(&running).await;
        client.send_raw(&[0, 0, 0, 0]).await;
        assert_eq!(error_code(&client.recv().await), "invalid_request");
        assert!(client.is_closed().await);
        // The biggest frame is read (and, here, is not valid).
        let mut client = Client::open(&running).await;
        client.send_payload(&vec![b' '; MAX_FRAME_BYTES]).await;
        assert_eq!(error_code(&client.recv().await), "invalid_json");
        assert!(client.is_open_and_quiet().await);
        assert_eq!(running.handler.calls(), vec![]);
        // Another client is served as before.
        let mut client = Client::open(&running).await;
        let answer = client.call(1, "spaces.list", json!({})).await;
        assert_eq!(answer["id"], 1);
    })
    .await;
}

#[tokio::test]
async fn two_connections_are_served_at_the_same_time() {
    within(async {
        let running = start();
        let mut first = Client::open(&running).await;
        let mut second = Client::open(&running).await;
        // The handler lets the call of `meet` finish only when a second one is inside it, so
        // both answers come only if the two connections are served side by side.
        first
            .send(json!({ "id": 1, "method": "terminal.read", "params": { "terminal": "meet" } }))
            .await;
        second
            .send(json!({ "id": 2, "method": "terminal.read", "params": { "terminal": "meet" } }))
            .await;
        let (a, b) = tokio::join!(first.recv(), second.recv());
        assert_eq!(
            (a["id"].as_u64(), a["result"]["text"].as_str()),
            (Some(1), Some("met"))
        );
        assert_eq!(
            (b["id"].as_u64(), b["result"]["text"].as_str()),
            (Some(2), Some("met"))
        );
        // A connection that waits does not hold the others back.
        let mut third = Client::open(&running).await;
        let mut fourth = Client::open(&running).await;
        third
            .send(json!({ "id": 3, "method": "terminal.read", "params": { "terminal": "meet" } }))
            .await;
        let answer = fourth.call(4, "spaces.list", json!({})).await;
        assert_eq!(answer["id"], 4);
        fourth
            .send(json!({ "id": 5, "method": "terminal.read", "params": { "terminal": "meet" } }))
            .await;
        let (c, d) = tokio::join!(third.recv(), fourth.recv());
        assert_eq!((c["id"].as_u64(), d["id"].as_u64()), (Some(3), Some(5)));
    })
    .await;
}

#[tokio::test]
async fn a_handler_that_panics_or_is_slow_or_answers_too_much_fails_only_that_request() {
    within(async {
        let running = start_with(ApiConfig {
            request_timeout: Duration::from_millis(400),
            ..ApiConfig::default()
        });
        let mut client = Client::open(&running).await;
        let answer = client
            .call(1, "terminal.read", json!({ "terminal": "panic" }))
            .await;
        assert_eq!(
            (answer["id"].as_u64(), error_code(&answer)),
            (Some(1), "internal")
        );
        let answer = client
            .call(2, "terminal.read", json!({ "terminal": "slow" }))
            .await;
        assert_eq!(
            (answer["id"].as_u64(), error_code(&answer)),
            (Some(2), "timeout")
        );
        let answer = client
            .call(3, "terminal.read", json!({ "terminal": "big" }))
            .await;
        assert_eq!(
            (answer["id"].as_u64(), error_code(&answer)),
            (Some(3), "internal")
        );
        let answer = client.call(4, "spaces.list", json!({})).await;
        assert_eq!(answer["result"], json!({ "spaces": [] }));
    })
    .await;
}

#[tokio::test]
async fn a_client_that_leaves_in_the_middle_of_a_frame_does_not_hurt_the_server() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        client.send_raw(&[0, 0, 0, 100, b'{', b'"']).await;
        drop(client);
        let mut client = Client::connect(running.server.endpoint()).await;
        client.send_raw(&[0, 0]).await;
        drop(client);
        let mut client = Client::open(&running).await;
        assert_eq!(client.call(1, "spaces.list", json!({})).await["id"], 1);
    })
    .await;
}

#[tokio::test]
async fn connections_over_the_limit_are_closed_and_a_free_slot_is_used_again() {
    within(async {
        let running = start_with(ApiConfig {
            max_connections: 2,
            ..ApiConfig::default()
        });
        let first = Client::open(&running).await;
        let _second = Client::open(&running).await;
        let mut third = Client::connect(running.server.endpoint()).await;
        // Closed without a word, before any message of ours.
        assert!(third.is_closed().await);
        drop(first);
        // The server notices the leaver when it reads the end of the stream; try for a moment.
        let mut served = false;
        for _ in 0..50 {
            let mut client = Client::connect(running.server.endpoint()).await;
            // The write may find the connection already closed; then the read tells the same.
            let auth = json!({ "type": "auth", "version": 1, "token": running.token });
            let frame = to_frame(auth.to_string().as_bytes()).unwrap();
            let _ = write_frame(&mut client.0, &frame).await;
            if client
                .try_recv()
                .await
                .is_ok_and(|m| m["type"] == "welcome")
            {
                served = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(served, "a freed slot was never used");
    })
    .await;
}

#[tokio::test]
async fn shutdown_closes_the_connections_and_the_endpoint() {
    within(async {
        let mut running = start();
        let mut client = Client::open(&running).await;
        let endpoint = running.server.endpoint().clone();
        running.server.shutdown();
        assert!(client.is_closed().await);
        assert!(ipc::connect(&endpoint).await.is_err());
        // A second shutdown, and the drop that follows, do nothing.
        running.server.shutdown();
    })
    .await;
}

#[tokio::test]
async fn the_endpoint_is_not_the_one_of_the_session_daemon_and_cannot_be_bound_twice() {
    within(async {
        assert_ne!(
            api_endpoint("default").unwrap().address(),
            Endpoint::named("default").unwrap().address()
        );
        assert!(api_endpoint("a/b").is_err());
        let running = start();
        let second = ApiServer::start(
            running.server.endpoint().clone(),
            ApiToken::generate().unwrap(),
            FakeHandler::new(),
            ApiConfig::default(),
        );
        assert!(second.is_err(), "two servers on one endpoint");
        // The first one is still there.
        let mut client = Client::open(&running).await;
        assert_eq!(client.call(1, "spaces.list", json!({})).await["id"], 1);
    })
    .await;
}

#[tokio::test]
async fn the_token_file_is_created_reused_and_regenerated_when_it_is_corrupt() {
    within(async {
        let dir = temp_dir();
        let path = dir.join("nested").join("api-token");

        // Created: there was nothing, and a server started with it accepts that token.
        let (token, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Created);
        let written = fs::read_to_string(&path).unwrap();
        assert_eq!(written.trim(), token.to_hex());
        let first =
            ApiServer::start(endpoint(), token, FakeHandler::new(), ApiConfig::default()).unwrap();
        let mut client = Client::connect(first.endpoint()).await;
        client.auth_with(written.trim()).await;
        assert_eq!(client.recv().await["type"], "welcome");
        drop(first);

        // Reused: the same file gives the same token, so a client that read it earlier still
        // gets in after a restart.
        let (token, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Reused);
        assert_eq!(token.to_hex(), written.trim());

        // Regenerated: a file that holds no token is replaced, and the old token no longer
        // opens the server that runs with the new one.
        fs::write(&path, b"garbage").unwrap();
        let (new_token, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Regenerated);
        assert_ne!(new_token.to_hex(), written.trim());
        assert_eq!(
            fs::read_to_string(&path).unwrap().trim(),
            new_token.to_hex()
        );
        let second = ApiServer::start(
            endpoint(),
            new_token.clone(),
            FakeHandler::new(),
            ApiConfig::default(),
        )
        .unwrap();
        let mut old = Client::connect(second.endpoint()).await;
        old.auth_with(written.trim()).await;
        assert_eq!(error_code(&old.recv().await), "unauthorized");
        let mut new = Client::connect(second.endpoint()).await;
        new.auth_with(&new_token.to_hex()).await;
        assert_eq!(new.recv().await["type"], "welcome");
        drop(second);

        fs::remove_dir_all(&dir).unwrap();
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

fn output(session: &str, text: &str) -> ApiEvent {
    ApiEvent::TerminalOutput {
        session_id: session.into(),
        text: text.into(),
    }
}

fn agent(session: &str, state: AgentState) -> ApiEvent {
    ApiEvent::AgentState {
        session_id: session.into(),
        state,
    }
}

fn is_event(frame: &Value) -> bool {
    frame.get("event").is_some()
}

impl Client {
    async fn subscribe(&mut self, id: u64, params: Value) -> Value {
        self.call(id, "events.subscribe", params).await
    }

    /// The next frame, which must be an event (`{ event, data }`, with no `id`).
    async fn recv_event(&mut self) -> Value {
        let frame = self.recv().await;
        assert!(is_event(&frame), "an event was expected: {frame}");
        assert!(frame.get("id").is_none(), "an event has no id: {frame}");
        frame
    }

    /// Whether nothing at all comes for a moment.
    async fn nothing_comes(&mut self) -> bool {
        self.is_open_and_quiet().await
    }
}

fn event_frame(name: &str, data: Value) -> Value {
    json!({ "event": name, "data": data })
}

fn output_frame(session: &str, text: &str) -> Value {
    event_frame(
        "terminal.output",
        json!({ "sessionId": session, "text": text }),
    )
}

fn state_frame(session: &str, state: &str) -> Value {
    event_frame(
        "agent.state",
        json!({ "sessionId": session, "state": state }),
    )
}

#[tokio::test]
async fn a_subscriber_receives_the_events_that_are_published() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        let answer = client
            .subscribe(
                1,
                json!({ "types": ["terminal.output", "agent.state"], "sessionId": "s1" }),
            )
            .await;
        assert_eq!(
            answer,
            json!({
                "id": 1,
                "result": { "types": ["terminal.output", "agent.state"], "sessionId": "s1" }
            })
        );
        assert_eq!(publisher.subscribers(), 1);
        publisher.publish(output("s1", "hello\r\n\u{1b}[31mred\u{1b}[0m \"q\" é😀"));
        publisher.publish(agent("s1", AgentState::Working));
        publisher.publish(agent("s1", AgentState::Waiting));
        publisher.publish(agent("s1", AgentState::Idle));
        assert_eq!(
            client.recv_event().await,
            output_frame("s1", "hello\r\n\u{1b}[31mred\u{1b}[0m \"q\" é😀")
        );
        for state in ["working", "waiting", "idle"] {
            assert_eq!(client.recv_event().await, state_frame("s1", state));
        }
        // The handler never heard of the subscription, and the connection still answers.
        assert_eq!(running.handler.calls(), vec![]);
        let answer = client.call(2, "spaces.list", json!({})).await;
        assert_eq!(answer, json!({ "id": 2, "result": { "spaces": [] } }));
    })
    .await;
}

#[tokio::test]
async fn a_subscription_with_no_types_takes_both_kinds_and_every_session() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        let answer = client.subscribe(1, json!({})).await;
        assert_eq!(
            answer["result"],
            json!({ "types": ["terminal.output", "agent.state"], "sessionId": null })
        );
        publisher.publish(output("a", "1"));
        publisher.publish(agent("b", AgentState::Idle));
        assert_eq!(client.recv_event().await, output_frame("a", "1"));
        assert_eq!(client.recv_event().await, state_frame("b", "idle"));
    })
    .await;
}

#[tokio::test]
async fn a_connection_that_did_not_subscribe_or_did_not_authenticate_gets_no_event() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        // Connected, never authenticated: it holds a connection and waits for the first message.
        let mut silent = Client::connect(running.server.endpoint()).await;
        // Authenticated, never subscribed.
        let mut quiet = Client::open(&running).await;
        // Refused for its token: told so, closed, and nothing else.
        let mut refused = Client::connect(running.server.endpoint()).await;
        refused.auth_with(&"0".repeat(64)).await;
        assert_eq!(error_code(&refused.recv().await), "unauthorized");
        assert!(refused.is_closed().await);
        // A request for events before the authentication is refused, and the connection closes.
        let mut early = Client::connect(running.server.endpoint()).await;
        early
            .send(json!({ "id": 1, "method": "events.subscribe", "params": {} }))
            .await;
        assert_eq!(error_code(&early.recv().await), "unauthenticated");
        assert!(early.is_closed().await);
        assert_eq!(publisher.subscribers(), 0);

        publisher.publish(output("s", "secret"));
        publisher.publish(agent("s", AgentState::Working));
        assert!(silent.nothing_comes().await);
        assert!(quiet.nothing_comes().await);
        // The authenticated one is served as ever, and its next frame is the answer.
        let answer = quiet.call(1, "spaces.list", json!({})).await;
        assert_eq!(answer["id"], 1);
        assert!(quiet.nothing_comes().await);
        // The one that was silent can still authenticate and is not given what came before.
        silent.auth_with(&running.token).await;
        assert_eq!(silent.recv().await["type"], "welcome");
        assert!(silent.nothing_comes().await);
        assert_eq!(running.handler.calls(), vec![ApiCall::SpacesList]);
    })
    .await;
}

#[tokio::test]
async fn the_filter_takes_events_by_type_and_by_session() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut only_output = Client::open(&running).await;
        let mut only_state = Client::open(&running).await;
        let mut session_a = Client::open(&running).await;
        let mut output_of_b = Client::open(&running).await;
        only_output
            .subscribe(1, json!({ "types": ["terminal.output"] }))
            .await;
        only_state
            .subscribe(1, json!({ "types": ["agent.state"] }))
            .await;
        session_a.subscribe(1, json!({ "sessionId": "a" })).await;
        output_of_b
            .subscribe(1, json!({ "types": ["terminal.output"], "sessionId": "b" }))
            .await;

        publisher.publish(output("a", "a1"));
        publisher.publish(agent("a", AgentState::Working));
        publisher.publish(output("b", "b1"));
        publisher.publish(agent("b", AgentState::Waiting));
        publisher.publish(output("ab", "ab1"));
        publisher.publish(output("a", "a2"));

        for expected in [
            output_frame("a", "a1"),
            output_frame("b", "b1"),
            output_frame("ab", "ab1"),
            output_frame("a", "a2"),
        ] {
            assert_eq!(only_output.recv_event().await, expected);
        }
        assert!(only_output.nothing_comes().await);
        for expected in [state_frame("a", "working"), state_frame("b", "waiting")] {
            assert_eq!(only_state.recv_event().await, expected);
        }
        assert!(only_state.nothing_comes().await);
        for expected in [
            output_frame("a", "a1"),
            state_frame("a", "working"),
            output_frame("a", "a2"),
        ] {
            assert_eq!(session_a.recv_event().await, expected);
        }
        assert!(session_a.nothing_comes().await);
        assert_eq!(output_of_b.recv_event().await, output_frame("b", "b1"));
        assert!(output_of_b.nothing_comes().await);
    })
    .await;
}

#[tokio::test]
async fn a_filter_that_does_not_fit_is_invalid_params_and_changes_nothing() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        let bad = [
            json!({ "types": [] }),
            json!({ "types": ["terminal.input"] }),
            json!({ "types": ["agent.state", "nope"] }),
            json!({ "types": "agent.state" }),
            json!({ "types": [5] }),
            json!({ "sessionId": "" }),
            json!({ "sessionId": 5 }),
            json!({ "sessionId": "a\nb" }),
            json!({ "sessionId": "x".repeat(129) }),
            json!({ "extra": 1 }),
            json!({ "types": ["agent.state"], "session": "s" }),
            json!([]),
        ];
        for (n, params) in (1u64..).zip(bad) {
            let answer = client.subscribe(n, params.clone()).await;
            assert_eq!(
                (answer["id"].as_u64(), error_code(&answer)),
                (Some(n), "invalid_params"),
                "{params}"
            );
        }
        // Nothing was subscribed by any of them, and the connection is open.
        assert_eq!(publisher.subscribers(), 0);
        publisher.publish(output("s", "x"));
        assert!(client.nothing_comes().await);
        // The same goes for a request with an extra field, or a method that is not there.
        client
            .send(json!({ "id": 90, "method": "events.subscribe", "extra": true }))
            .await;
        assert_eq!(error_code(&client.recv().await), "invalid_request");
        let answer = client.call(91, "events.unsubscribe", json!({})).await;
        assert_eq!(error_code(&answer), "unknown_method");
        assert_eq!(publisher.subscribers(), 0);
        // A bad filter does not undo a good one.
        client
            .subscribe(100, json!({ "types": ["terminal.output"] }))
            .await;
        let answer = client.subscribe(101, json!({ "types": [] })).await;
        assert_eq!(error_code(&answer), "invalid_params");
        publisher.publish(output("s", "still"));
        assert_eq!(client.recv_event().await, output_frame("s", "still"));
        assert_eq!(running.handler.calls(), vec![]);
    })
    .await;
}

#[tokio::test]
async fn subscribing_again_replaces_the_filter() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        client
            .subscribe(1, json!({ "types": ["terminal.output"] }))
            .await;
        publisher.publish(output("s", "first"));
        assert_eq!(client.recv_event().await, output_frame("s", "first"));
        let answer = client
            .subscribe(2, json!({ "types": ["agent.state"], "sessionId": "t" }))
            .await;
        assert_eq!(
            answer["result"],
            json!({ "types": ["agent.state"], "sessionId": "t" })
        );
        assert_eq!(publisher.subscribers(), 1);
        publisher.publish(output("s", "no longer"));
        publisher.publish(agent("s", AgentState::Idle));
        publisher.publish(agent("t", AgentState::Waiting));
        assert_eq!(client.recv_event().await, state_frame("t", "waiting"));
        assert!(client.nothing_comes().await);
    })
    .await;
}

#[tokio::test]
async fn an_event_comes_between_requests_and_their_answers_keep_the_order_of_the_requests() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        client.subscribe(1, json!({})).await;

        // A call that waits in the handler: the event comes while it waits, before its answer.
        client
            .send(json!({ "id": 2, "method": "terminal.read", "params": { "terminal": "gate" } }))
            .await;
        publisher.publish(output("s", "while you wait"));
        assert_eq!(
            client.recv_event().await,
            output_frame("s", "while you wait")
        );
        running.handler.gate.notify_one();
        let answer = client.recv().await;
        assert_eq!(
            (answer["id"].as_u64(), answer["result"]["text"].as_str()),
            (Some(2), Some("opened"))
        );

        // Several requests one behind the other, with events published among them: the answers
        // come in the order of the requests, the events in the order they were published, and
        // none is lost or cut.
        for id in 3..=6u64 {
            client
                .send(json!({ "id": id, "method": "spaces.list", "params": {} }))
                .await;
            publisher.publish(output("s", &format!("e{id}")));
        }
        let mut answers = Vec::new();
        let mut events = Vec::new();
        while answers.len() < 4 || events.len() < 4 {
            let frame = client.recv().await;
            if is_event(&frame) {
                events.push(frame);
            } else {
                answers.push(frame["id"].as_u64().expect("an answer with an id"));
            }
        }
        assert_eq!(answers, vec![3, 4, 5, 6]);
        assert_eq!(
            events,
            (3..=6)
                .map(|id| output_frame("s", &format!("e{id}")))
                .collect::<Vec<_>>()
        );
        assert!(client.nothing_comes().await);
    })
    .await;
}

#[tokio::test]
async fn two_connections_with_their_own_filters_each_get_theirs() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut first = Client::open(&running).await;
        let mut second = Client::open(&running).await;
        first
            .subscribe(1, json!({ "types": ["terminal.output"], "sessionId": "a" }))
            .await;
        second
            .subscribe(1, json!({ "types": ["agent.state"] }))
            .await;
        assert_eq!(publisher.subscribers(), 2);
        publisher.publish(output("a", "x"));
        publisher.publish(agent("a", AgentState::Working));
        publisher.publish(agent("b", AgentState::Idle));
        publisher.publish(output("b", "y"));
        assert_eq!(first.recv_event().await, output_frame("a", "x"));
        assert!(first.nothing_comes().await);
        assert_eq!(second.recv_event().await, state_frame("a", "working"));
        assert_eq!(second.recv_event().await, state_frame("b", "idle"));
        assert!(second.nothing_comes().await);

        // A connection that leaves stops being a subscriber, and the other goes on.
        drop(first);
        for _ in 0..50 {
            if publisher.subscribers() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(publisher.subscribers(), 1);
        publisher.publish(agent("c", AgentState::Waiting));
        assert_eq!(second.recv_event().await, state_frame("c", "waiting"));
    })
    .await;
}

#[tokio::test]
async fn a_publisher_is_cloneable_and_works_from_other_threads() {
    within(async {
        let running = start();
        let mut client = Client::open(&running).await;
        client.subscribe(1, json!({})).await;
        let publisher: EventPublisher = running.server.publisher();
        let threads: Vec<_> = (0..4)
            .map(|n| {
                let publisher = publisher.clone();
                std::thread::spawn(move || publisher.publish(output(&format!("t{n}"), "x")))
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let mut sessions = Vec::new();
        for _ in 0..4 {
            let frame = client.recv_event().await;
            sessions.push(frame["data"]["sessionId"].as_str().unwrap().to_owned());
        }
        sessions.sort();
        assert_eq!(sessions, ["t0", "t1", "t2", "t3"]);
    })
    .await;
}

#[tokio::test]
async fn a_long_output_comes_in_frames_that_fit_and_make_the_text_again() {
    within(async {
        let running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        client
            .subscribe(1, json!({ "types": ["terminal.output"] }))
            .await;
        // Control characters take six characters each in JSON, and a text of this size has
        // more than a frame holds in any case.
        let text = format!(
            "{}é{}",
            "\u{1}".repeat(MAX_OUTPUT_CHUNK_BYTES + 5),
            "z".repeat(MAX_OUTPUT_CHUNK_BYTES)
        );
        publisher.publish(output("big", &text));
        let mut joined = String::new();
        while joined.len() < text.len() {
            let frame = client.recv_event().await;
            assert_eq!(frame["data"]["sessionId"], "big");
            let piece = frame["data"]["text"].as_str().unwrap();
            assert!(piece.len() <= MAX_OUTPUT_CHUNK_BYTES);
            joined.push_str(piece);
        }
        assert_eq!(joined, text);
        assert!(client.nothing_comes().await);
        // A text that fits goes whole.
        let whole = "w".repeat(MAX_OUTPUT_CHUNK_BYTES);
        publisher.publish(output("big", &whole));
        assert_eq!(client.recv_event().await, output_frame("big", &whole));
    })
    .await;
}

#[tokio::test]
async fn a_client_that_does_not_read_costs_the_others_nothing_and_is_told_what_it_missed() {
    within(async {
        let running = start_with(ApiConfig {
            event_queue: 4,
            ..ApiConfig::default()
        });
        let publisher = running.server.publisher();
        let mut slow = Client::open(&running).await;
        let mut fast = Client::open(&running).await;
        slow.subscribe(1, json!({ "sessionId": "slow" })).await;
        fast.subscribe(1, json!({ "sessionId": "fast" })).await;

        // Far more than the queue and the buffers of the pipe can hold, to a client that does
        // not read. The publisher must come back without waiting for it.
        const SENT: u64 = 400;
        let flood = publisher.clone();
        let text = "x".repeat(100 * 1024);
        let flooding = tokio::task::spawn_blocking(move || {
            for _ in 0..SENT {
                flood.publish(output("slow", &text));
            }
        });
        tokio::time::timeout(STEP, flooding)
            .await
            .expect("the publisher was held back by a client that does not read")
            .unwrap();

        // The other client hears at once, and its requests are answered.
        publisher.publish(output("fast", "quick"));
        assert_eq!(fast.recv_event().await, output_frame("fast", "quick"));
        assert_eq!(fast.call(2, "spaces.list", json!({})).await["id"], 2);
        // The server takes new connections too.
        let mut late = Client::open(&running).await;
        assert_eq!(late.call(1, "spaces.list", json!({})).await["id"], 1);

        // When the slow client reads at last it finds what fitted, in order, and a warning with
        // how many it missed; what it got and what it missed make what was published.
        let (mut got, mut missed, mut warnings) = (0u64, 0u64, 0u64);
        while got + missed < SENT {
            let frame = slow.recv().await;
            match frame["event"].as_str() {
                Some("terminal.output") => got += 1,
                Some("events.dropped") => {
                    let count = frame["data"]["count"].as_u64().unwrap();
                    assert!(count > 0);
                    missed += count;
                    warnings += 1;
                }
                _ => panic!("unexpected frame with {} bytes", frame.to_string().len()),
            }
        }
        assert_eq!(got + missed, SENT);
        assert!(missed > 0, "nothing was dropped");
        assert!(warnings > 0);
        assert!(got >= 1);
        // It is still connected and served.
        assert_eq!(slow.call(3, "spaces.list", json!({})).await["id"], 3);
    })
    .await;
}

#[tokio::test]
async fn the_events_stop_when_the_server_stops() {
    within(async {
        let mut running = start();
        let publisher = running.server.publisher();
        let mut client = Client::open(&running).await;
        client.subscribe(1, json!({})).await;
        running.server.shutdown();
        assert!(client.is_closed().await);
        // The publisher outlives the server and does nothing.
        publisher.publish(output("s", "x"));
        assert_eq!(publisher.subscribers(), 0);
    })
    .await;
}

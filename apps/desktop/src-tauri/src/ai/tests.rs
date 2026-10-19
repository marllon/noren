//! Tests of the AI commands: a fake vault and a fake provider on `127.0.0.1` at a port the system
//! picks. Nothing here touches the keychain of the person or a host outside the machine.

use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use noren_core::{MemoryVault, ProviderKind};

// ---- a fake provider on a local port --------------------------------------------------------

#[derive(Clone)]
struct Recorded {
    headers: Vec<(String, String)>,
    body: String,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

struct Signals {
    stop: AtomicBool,
    /// Set when a handler saw the client close the connection while it waited.
    client_closed: AtomicBool,
}

type Handler = Arc<dyn Fn(&Recorded, &mut TcpStream, &Signals) + Send + Sync>;

struct TestServer {
    url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    signals: Arc<Signals>,
}

impl TestServer {
    fn start(
        handler: impl Fn(&Recorded, &mut TcpStream, &Signals) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let url = format!("http://{}", listener.local_addr().expect("local address"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let signals = Arc::new(Signals {
            stop: AtomicBool::new(false),
            client_closed: AtomicBool::new(false),
        });
        let handler: Handler = Arc::new(handler);
        let (log, flags) = (requests.clone(), signals.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flags.stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let (handler, log, flags) = (handler.clone(), log.clone(), flags.clone());
                std::thread::spawn(move || serve(stream, &handler, &log, &flags));
            }
        });
        TestServer {
            url,
            requests,
            signals,
        }
    }

    fn request(&self, index: usize) -> Recorded {
        self.requests.lock().expect("log")[index].clone()
    }

    fn request_count(&self) -> usize {
        self.requests.lock().expect("log").len()
    }

    async fn wait_for_client_close(&self) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if self.signals.client_closed.load(Ordering::SeqCst) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.signals.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop so it sees the flag.
        let _ = TcpStream::connect(self.url.trim_start_matches("http://"));
    }
}

fn serve(stream: TcpStream, handler: &Handler, log: &Mutex<Vec<Recorded>>, signals: &Signals) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(reader_side) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader_side);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let recorded = Recorded {
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    let mut stream = stream;
    log.lock().expect("log").push(recorded.clone());
    handler(&recorded, &mut stream, signals);
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn start_event_stream(stream: &mut TcpStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.flush();
}

/// Says nothing more until the server stops or the client closes the connection.
fn stall(stream: &mut TcpStream, signals: &Signals) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(20)));
    let mut byte = [0u8; 1];
    while !signals.stop.load(Ordering::SeqCst) {
        match stream.peek(&mut byte) {
            Ok(0) => {
                signals.client_closed.store(true, Ordering::SeqCst);
                return;
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(20)),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => {
                signals.client_closed.store(true, Ordering::SeqCst);
                return;
            }
        }
    }
}

const OPENAI_STREAM: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n",
);

const ANTHROPIC_STREAM: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

/// One chunk of text, then silence until the client leaves.
const ONE_DELTA: &[u8] = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n";

fn stream_back(text: &'static str) -> impl Fn(&Recorded, &mut TcpStream, &Signals) + Send + Sync {
    move |_, stream, _| {
        start_event_stream(stream);
        let _ = stream.write_all(text.as_bytes());
        let _ = stream.flush();
    }
}

fn one_delta_then_silence(_: &Recorded, stream: &mut TcpStream, signals: &Signals) {
    start_event_stream(stream);
    let _ = stream.write_all(ONE_DELTA);
    let _ = stream.flush();
    stall(stream, signals);
}

// ---- the state under test -------------------------------------------------------------------

const KEY: &str = "sk-test-0123456789abcdef";

fn provider(id: &str, kind: ProviderKind, server: &TestServer) -> Provider {
    Provider {
        id: id.to_string(),
        kind,
        base_url: match kind {
            ProviderKind::OpenAiCompatible => format!("{}/v1", server.url),
            ProviderKind::Anthropic => server.url.clone(),
        },
        model: "fake-model".to_string(),
    }
}

/// A state with a short timeout whose providers point at `server`: `ollama` and `openai`
/// (openai-compatible) and `claude` (anthropic).
fn state_for(server: &TestServer, vault: Arc<MemoryVault>) -> AiState {
    let client = AiClient::new(Duration::from_millis(1500)).expect("client");
    AiState::new(
        vault,
        vec![
            provider("ollama", ProviderKind::OpenAiCompatible, server),
            provider("openai", ProviderKind::OpenAiCompatible, server),
            provider("claude", ProviderKind::Anthropic, server),
        ],
        client,
    )
}

fn hi() -> Vec<ChatMessageDto> {
    vec![
        ChatMessageDto {
            role: "system".to_string(),
            content: "Be brief.".to_string(),
        },
        ChatMessageDto {
            role: "user".to_string(),
            content: "hi".to_string(),
        },
    ]
}

async fn ask(
    state: &AiState,
    provider_id: &str,
    request_id: &str,
) -> (Result<(), String>, Vec<AiStreamEvent>) {
    let mut events = Vec::new();
    let result = state
        .chat_stream(provider_id, request_id, None, &hi(), |e| {
            events.push(e);
            true
        })
        .await;
    (result, events)
}

fn text_of(events: &[AiStreamEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            AiStreamEvent::Delta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

// ---- the key --------------------------------------------------------------------------------

#[test]
fn a_key_is_stored_read_replaced_and_removed_through_the_vault() {
    let server = TestServer::start(|_, _, _| {});
    let vault = Arc::new(MemoryVault::new());
    let state = state_for(&server, vault.clone());
    assert_eq!(vault.get("openai"), Ok(None));
    state.set_key("openai", KEY).expect("set");
    assert_eq!(vault.get("openai"), Ok(Some(KEY.to_string())));
    // Blanks around a pasted key are dropped.
    state.set_key("openai", "  sk-other \n").expect("replace");
    assert_eq!(vault.get("openai"), Ok(Some("sk-other".to_string())));
    // An empty (or blank) key removes it.
    state.set_key("openai", "").expect("remove");
    assert_eq!(vault.get("openai"), Ok(None));
    state.set_key("openai", KEY).expect("set again");
    state.set_key("openai", "   ").expect("remove with blanks");
    assert_eq!(vault.get("openai"), Ok(None));
    // Removing what is not there is fine.
    state.set_key("openai", "").expect("remove again");
}

#[test]
fn the_list_says_whether_a_key_exists_and_never_shows_it() {
    let server = TestServer::start(|_, _, _| {});
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    let flags = |state: &AiState| -> Vec<(String, bool)> {
        state
            .providers()
            .into_iter()
            .map(|p| (p.id, p.has_key))
            .collect()
    };
    let expected = |ollama, openai, claude| -> Vec<(String, bool)> {
        [("ollama", ollama), ("openai", openai), ("claude", claude)]
            .map(|(id, has)| (id.to_string(), has))
            .to_vec()
    };
    assert_eq!(flags(&state), expected(false, false, false));
    state.set_key("openai", KEY).expect("set");
    assert_eq!(flags(&state), expected(false, true, false));
    // What goes to the page: no key in the JSON, in the debug text or in the shape.
    let providers = state.providers();
    let json = serde_json::to_string(&providers).expect("json");
    assert!(!json.contains(KEY), "{json}");
    assert!(!format!("{providers:?}").contains(KEY));
    let value: serde_json::Value = serde_json::from_str(&json).expect("value");
    let openai = &value[1];
    assert_eq!(openai["id"], "openai");
    assert_eq!(openai["kind"], "openai-compatible");
    assert_eq!(openai["hasKey"], true);
    assert!(openai.get("key").is_none() && openai.get("apiKey").is_none());
    assert_eq!(value[2]["kind"], "anthropic");
    state.set_key("openai", "").expect("remove");
    assert_eq!(flags(&state), expected(false, false, false));
}

#[test]
fn a_normal_run_lists_only_the_predefined_ollama_without_a_key() {
    let state = AiState::with_vault(Arc::new(MemoryVault::new())).expect("state");
    let providers = state.providers();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].id, "ollama");
    assert_eq!(providers[0].kind, "openai-compatible");
    assert_eq!(providers[0].base_url, "http://localhost:11434/v1");
    assert!(!providers[0].has_key);
}

#[test]
fn a_bad_provider_id_is_refused_and_nothing_is_stored() {
    let server = TestServer::start(|_, _, _| {});
    let vault = Arc::new(MemoryVault::new());
    let state = state_for(&server, vault.clone());
    for bad in ["", "a/b", "../x", "a b", "-x", &"a".repeat(65)] {
        let error = state.set_key(bad, KEY).expect_err("refused");
        assert!(!error.contains(KEY), "{error}");
        // Removing a key under a bad id is refused too.
        assert!(state.set_key(bad, "").is_err(), "{bad:?}");
    }
    assert_eq!(vault.get("openai"), Ok(None));
}

#[test]
fn a_vault_that_fails_gives_a_readable_error_and_a_list_without_keys() {
    let server = TestServer::start(|_, _, _| {});
    let state = state_for(&server, Arc::new(MemoryVault::broken()));
    let error = state.set_key("openai", KEY).expect_err("broken");
    assert!(error.contains("keychain"), "{error}");
    assert!(!error.contains(KEY), "{error}");
    assert!(state.providers().iter().all(|p| !p.has_key));
}

// ---- the answer -----------------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn openai_compatible_streams_with_the_key_of_the_vault_in_the_header() {
    let server = TestServer::start(stream_back(OPENAI_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.set_key("openai", KEY).expect("set");
    let (result, events) = ask(&state, "openai", "req-1").await;
    assert_eq!(result, Ok(()));
    assert_eq!(text_of(&events), "Hello");
    assert_eq!(events.last(), Some(&AiStreamEvent::Done));
    assert_eq!(
        events
            .iter()
            .filter(|e| !matches!(e, AiStreamEvent::Delta { .. }))
            .count(),
        1,
        "exactly one end: {events:?}"
    );
    let request = server.request(0);
    assert_eq!(
        request.header("authorization"),
        Some(format!("Bearer {KEY}").as_str())
    );
    let body: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
    assert_eq!(body["model"], "fake-model");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][1]["content"], "hi");
    // The request is out of the map when it ends.
    assert_eq!(state.in_flight(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn anthropic_streams_with_the_key_of_the_vault_in_the_header() {
    let server = TestServer::start(stream_back(ANTHROPIC_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.set_key("claude", KEY).expect("set");
    let (result, events) = ask(&state, "claude", "req-2").await;
    assert_eq!(result, Ok(()));
    assert_eq!(text_of(&events), "Hello");
    assert_eq!(events.last(), Some(&AiStreamEvent::Done));
    let request = server.request(0);
    assert_eq!(request.header("x-api-key"), Some(KEY));
    assert!(request.header("anthropic-version").is_some());
    assert!(request.header("authorization").is_none());
    assert_eq!(state.in_flight(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn the_model_of_the_request_replaces_the_default_one() {
    let server = TestServer::start(stream_back(OPENAI_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    let mut events = Vec::new();
    state
        .chat_stream("ollama", "req-3", Some(" llama3.2 "), &hi(), |e| {
            events.push(e);
            true
        })
        .await
        .expect("started");
    assert_eq!(events.last(), Some(&AiStreamEvent::Done));
    let body: serde_json::Value = serde_json::from_str(&server.request(0).body).expect("body");
    assert_eq!(body["model"], "llama3.2");
    // Ollama has no key: no Authorization header goes out.
    assert!(server.request(0).header("authorization").is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn a_401_is_readable_and_the_message_does_not_carry_the_key() {
    // A provider that repeats the key it was given in the error text.
    let server = TestServer::start(|request, stream, _| {
        let auth = request.header("authorization").unwrap_or("").to_string();
        respond(
            stream,
            "401 Unauthorized",
            &format!("{{\"error\":{{\"message\":\"Incorrect API key provided: {auth}\"}}}}"),
        );
    });
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.set_key("openai", KEY).expect("set");
    let (result, events) = ask(&state, "openai", "req-4").await;
    assert_eq!(result, Ok(()), "the failure is the last event");
    let [AiStreamEvent::Error { kind, message }] = events.as_slice() else {
        panic!("expected one error event, got {events:?}");
    };
    assert_eq!(*kind, "auth");
    assert!(message.contains("401"), "{message}");
    assert!(message.contains("API key"), "{message}");
    assert!(!message.contains(KEY), "the key leaked: {message}");
    let json = serde_json::to_string(&events).expect("json");
    assert!(!json.contains(KEY), "{json}");
    assert_eq!(state.in_flight(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn a_provider_that_needs_a_key_says_so_when_there_is_none() {
    let server = TestServer::start(stream_back(ANTHROPIC_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    let (result, events) = ask(&state, "claude", "req-5").await;
    assert_eq!(result, Ok(()));
    let [AiStreamEvent::Error { kind, message }] = events.as_slice() else {
        panic!("expected one error event, got {events:?}");
    };
    assert_eq!(*kind, "invalid-request");
    assert!(message.contains("API key"), "{message}");
    assert_eq!(server.request_count(), 0, "no request without a key");
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_in_the_middle_ends_with_cancelled_and_closes_the_connection() {
    let server = TestServer::start(one_delta_then_silence);
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.set_key("openai", KEY).expect("set");
    let mut events = Vec::new();
    let seen_text = AtomicBool::new(false);
    let question = hi();
    let run = state.chat_stream("openai", "req-6", None, &question, |e| {
        if matches!(e, AiStreamEvent::Delta { .. }) {
            seen_text.store(true, Ordering::SeqCst);
        }
        events.push(e);
        true
    });
    let canceller = async {
        // Wait with the timer of the runtime: this test runs on one thread.
        let start = Instant::now();
        while !seen_text.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(3) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(state.in_flight(), 1, "the request is in the map");
        state.cancel("req-6")
    };
    let (result, found) = tokio::join!(run, canceller);
    assert_eq!(result, Ok(()));
    assert!(found, "ai_cancel found the request");
    assert_eq!(text_of(&events), "Hel");
    let [.., AiStreamEvent::Error { kind, message }] = events.as_slice() else {
        panic!("expected an error at the end, got {events:?}");
    };
    assert_eq!(*kind, "cancelled");
    assert_eq!(message, "cancelled");
    assert!(
        server.wait_for_client_close().await,
        "connection not closed"
    );
    assert_eq!(state.in_flight(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_an_unknown_or_finished_request_does_nothing() {
    let server = TestServer::start(stream_back(OPENAI_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    assert!(!state.cancel("never-started"));
    assert!(!state.cancel(""));
    assert!(!state.cancel("../x"));
    let (result, events) = ask(&state, "ollama", "req-7").await;
    assert_eq!(result, Ok(()));
    assert_eq!(events.last(), Some(&AiStreamEvent::Done));
    // It finished and left the map: cancelling it now is harmless and does not touch the next
    // request that reuses the id.
    assert!(!state.cancel("req-7"));
    let (_, again) = ask(&state, "ollama", "req-7").await;
    assert_eq!(again.last(), Some(&AiStreamEvent::Done));
}

#[tokio::test(flavor = "current_thread")]
async fn a_request_that_cannot_start_is_refused_before_any_event() {
    let server = TestServer::start(stream_back(OPENAI_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    for (provider_id, request_id) in [
        ("a/b", "req-8"),
        ("../x", "req-8"),
        ("", "req-8"),
        ("nobody", "req-8"),
        ("ollama", "a b"),
        ("ollama", ""),
    ] {
        let (result, events) = ask(&state, provider_id, request_id).await;
        assert!(result.is_err(), "{provider_id:?} {request_id:?}");
        assert!(events.is_empty(), "{events:?}");
    }
    let mut events = Vec::new();
    let bad_role = vec![ChatMessageDto {
        role: "tool".to_string(),
        content: "x".to_string(),
    }];
    let result = state
        .chat_stream("ollama", "req-8", None, &bad_role, |e| {
            events.push(e);
            true
        })
        .await;
    assert!(result.expect_err("bad role").contains("tool"));
    assert!(events.is_empty());
    assert_eq!(server.request_count(), 0);
    assert_eq!(state.in_flight(), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn a_request_id_that_is_running_cannot_be_used_again() {
    let server = TestServer::start(|_, stream, signals| {
        start_event_stream(stream);
        stall(stream, signals);
    });
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    let first = ask(&state, "ollama", "same");
    let second = async {
        let start = Instant::now();
        while state.in_flight() == 0 && start.elapsed() < Duration::from_secs(3) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let (result, events) = ask(&state, "ollama", "same").await;
        let found = state.cancel("same");
        (result, events, found)
    };
    let ((first_result, first_events), (result, events, found)) = tokio::join!(first, second);
    let error = result.expect_err("the id is in use");
    assert!(error.contains("already running"), "{error}");
    assert!(events.is_empty());
    assert!(found);
    // The first request was the one that got cancelled.
    assert_eq!(first_result, Ok(()));
    assert!(matches!(
        first_events.last(),
        Some(AiStreamEvent::Error {
            kind: "cancelled",
            ..
        })
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn a_broken_vault_stops_a_provider_with_a_key_but_not_ollama() {
    let server = TestServer::start(stream_back(OPENAI_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::broken()));
    let (result, events) = ask(&state, "openai", "req-9").await;
    assert!(result.expect_err("no keychain").contains("keychain"));
    assert!(events.is_empty());
    let (result, events) = ask(&state, "ollama", "req-10").await;
    assert_eq!(result, Ok(()));
    assert_eq!(events.last(), Some(&AiStreamEvent::Done));
}

#[tokio::test(flavor = "current_thread")]
async fn a_page_that_is_gone_cancels_the_request() {
    let server = TestServer::start(one_delta_then_silence);
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    let mut sent = 0;
    let result = state
        .chat_stream("ollama", "req-11", None, &hi(), |_| {
            sent += 1;
            false
        })
        .await;
    assert_eq!(result, Ok(()));
    // The first event told that nobody listens; the request stopped and closed the connection.
    assert!(server.wait_for_client_close().await);
    assert_eq!(state.in_flight(), 0);
    assert!(sent >= 1);
}

// ---- what the page receives -----------------------------------------------------------------

#[test]
fn the_events_have_the_shape_the_page_reads() {
    let json = |event: StreamEvent| serde_json::to_value(AiStreamEvent::from(event)).expect("json");
    assert_eq!(
        json(StreamEvent::Delta("hi".to_string())),
        serde_json::json!({ "type": "delta", "text": "hi" })
    );
    assert_eq!(
        json(StreamEvent::Done),
        serde_json::json!({ "type": "done" })
    );
    assert_eq!(
        json(StreamEvent::Error(AiError::Timeout)),
        serde_json::json!({
            "type": "error",
            "kind": "timeout",
            "message": "the provider did not answer in time"
        })
    );
    let kinds = [
        (AiError::InvalidRequest(String::new()), "invalid-request"),
        (
            AiError::Auth {
                status: 401,
                message: String::new(),
            },
            "auth",
        ),
        (
            AiError::Http {
                status: 500,
                message: String::new(),
            },
            "http",
        ),
        (AiError::Network(String::new()), "network"),
        (AiError::Cancelled, "cancelled"),
        (AiError::Provider(String::new()), "provider"),
        (AiError::Protocol(String::new()), "protocol"),
    ];
    for (error, kind) in kinds {
        assert_eq!(error_kind(&error), kind);
    }
}

// ---- the commands, called the way the page calls them ---------------------------------------

/// Calls `cmd` in the mock runtime of Tauri, with an `AiState` over a fake vault.
fn call_command(
    state: AiState,
    cmd: &str,
    args: serde_json::Value,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;

    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ai_providers,
            ai_set_key,
            ai_cancel
        ])
        .build(mock_context(noop_assets()))
        .expect("build the mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
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
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().expect("url"),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn json_of(answer: tauri::ipc::InvokeResponseBody) -> serde_json::Value {
    let tauri::ipc::InvokeResponseBody::Json(text) = answer else {
        panic!("a raw answer where JSON was expected");
    };
    serde_json::from_str(&text).expect("json")
}

#[test]
fn the_page_sets_a_key_and_lists_the_providers_through_the_commands() {
    let vault = Arc::new(MemoryVault::new());
    let make = || AiState::with_vault(vault.clone()).expect("state");
    let list = call_command(make(), "ai_providers", serde_json::json!({})).expect("list");
    let list = json_of(list);
    assert_eq!(list[0]["id"], "ollama");
    assert_eq!(list[0]["hasKey"], false);
    assert_eq!(list[0]["baseUrl"], "http://localhost:11434/v1");

    // The arguments are camelCase, as the page sends them.
    call_command(
        make(),
        "ai_set_key",
        serde_json::json!({ "providerId": "ollama", "key": KEY }),
    )
    .expect("set");
    assert_eq!(vault.get("ollama"), Ok(Some(KEY.to_string())));
    let list = call_command(make(), "ai_providers", serde_json::json!({})).expect("list");
    let list = json_of(list);
    assert_eq!(list[0]["hasKey"], true);
    assert!(!list.to_string().contains(KEY));

    let refused = call_command(
        make(),
        "ai_set_key",
        serde_json::json!({ "providerId": "a/b", "key": KEY }),
    )
    .expect_err("a bad id");
    assert!(!refused.to_string().contains(KEY), "{refused}");

    let cancelled = call_command(
        make(),
        "ai_cancel",
        serde_json::json!({ "requestId": "unknown" }),
    )
    .expect("cancel");
    assert_eq!(json_of(cancelled), serde_json::json!(false));

    call_command(
        make(),
        "ai_set_key",
        serde_json::json!({ "providerId": "ollama", "key": "" }),
    )
    .expect("remove");
    assert_eq!(vault.get("ollama"), Ok(None));
}

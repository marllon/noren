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
    /// `GET /v1/models HTTP/1.1`.
    request_line: String,
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
        request_line: request_line.trim_end().to_string(),
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

const OPENAI_STREAM_WITH_USAGE: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\n",
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
fn the_token_of_the_gist_sync_is_not_the_key_of_any_provider() {
    let server = TestServer::start(|_, _, _| {});
    let vault = Arc::new(MemoryVault::new());
    let state = state_for(&server, vault.clone());
    vault
        .set(noren_core::SYNC_GIST_TOKEN_ENTRY, "ghp_secret")
        .expect("the sync stores its token");
    // A provider cannot take the name of the entry, so none ever reads the token as its key...
    let entry = noren_core::SYNC_GIST_TOKEN_ENTRY;
    let provider = |id: &str| ProviderConfigDto {
        id: id.to_string(),
        kind: "openai-compatible".to_string(),
        base_url: "https://example.com/v1".to_string(),
        model: String::new(),
    };
    let error = state.configure(&[provider(entry)]).expect_err("refused");
    assert!(error.contains("not a provider id"), "{error}");
    assert!(state.providers().iter().all(|p| !p.has_key));
    // ...and the commands for the keys of providers can neither replace nor remove it.
    assert!(state.set_key(entry, "sk-other").is_err());
    assert!(state.set_key(entry, "").is_err());
    assert_eq!(vault.get(entry), Ok(Some("ghp_secret".to_string())));
    // A connection test or a chat to that name never reaches the vault.
    let report = tauri::async_runtime::block_on(state.test_connection(entry));
    assert!(report.is_err());
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
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
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
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
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
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
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
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
    // It finished and left the map: cancelling it now is harmless and does not touch the next
    // request that reuses the id.
    assert!(!state.cancel("req-7"));
    let (_, again) = ask(&state, "ollama", "req-7").await;
    assert_eq!(
        again.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
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
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_count_of_tokens_the_provider_reports_reaches_the_done_event() {
    let server = TestServer::start(stream_back(OPENAI_STREAM_WITH_USAGE));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.set_key("openai", KEY).expect("set");
    let (result, events) = ask(&state, "openai", "req-count").await;
    assert_eq!(result, Ok(()));
    assert_eq!(text_of(&events), "Hello");
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: Some(2)
        })
    );
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
        json(StreamEvent::Done {
            output_tokens: None
        }),
        serde_json::json!({ "type": "done" })
    );
    assert_eq!(
        json(StreamEvent::Done {
            output_tokens: Some(42)
        }),
        serde_json::json!({ "type": "done", "outputTokens": 42 })
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

type CommandAnswer = Result<tauri::ipc::InvokeResponseBody, serde_json::Value>;

/// Calls the commands `calls` one after the other, in the mock runtime of Tauri, on one
/// `AiState` over a fake vault.
fn call_commands(state: AiState, calls: Vec<(&str, serde_json::Value)>) -> Vec<CommandAnswer> {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;

    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            ai_providers,
            ai_configure,
            ai_ollama_models,
            ai_ollama_memory,
            ai_test_connection,
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
    calls
        .into_iter()
        .map(|(cmd, args)| {
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
        })
        .collect()
}

/// Calls `cmd` in the mock runtime of Tauri, with an `AiState` over a fake vault.
fn call_command(state: AiState, cmd: &str, args: serde_json::Value) -> CommandAnswer {
    call_commands(state, vec![(cmd, args)]).remove(0)
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

// ---- the providers of the settings ----------------------------------------------------------

fn dto(id: &str, kind: &str, base_url: &str, model: &str) -> ProviderConfigDto {
    ProviderConfigDto {
        id: id.to_string(),
        kind: kind.to_string(),
        base_url: base_url.to_string(),
        model: model.to_string(),
    }
}

/// An `openai-compatible` provider of the settings at the fake server.
fn work(server: &TestServer) -> ProviderConfigDto {
    dto(
        "work",
        "openai-compatible",
        &format!("{}/v1", server.url),
        " m1 ",
    )
}

fn ids(state: &AiState) -> Vec<String> {
    state.providers().into_iter().map(|p| p.id).collect()
}

/// A state of a normal run (only the pre-defined Ollama, at its real address, which these tests
/// never reach) over `vault`.
fn plain_state(vault: Arc<MemoryVault>) -> AiState {
    AiState::with_vault(vault).expect("state")
}

/// An address on which nothing listens: the port was just released.
fn closed_port_url() -> String {
    let port = TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port();
    format!("http://127.0.0.1:{port}")
}

/// A state whose only built-in provider is an Ollama at `url`, with this timeout.
fn state_with_ollama_at(url: &str, vault: Arc<MemoryVault>, timeout_ms: u64) -> AiState {
    let client = AiClient::new(Duration::from_millis(timeout_ms)).expect("client");
    let mut ollama = Provider::ollama("");
    ollama.base_url = format!("{url}/v1");
    AiState::new(vault, vec![ollama], client)
}

#[test]
fn the_providers_of_the_settings_follow_the_built_in_ones_and_are_replaced_as_a_whole() {
    let vault = Arc::new(MemoryVault::new());
    let state = plain_state(vault.clone());
    assert_eq!(ids(&state), ["ollama"]);

    state
        .configure(&[
            dto(
                "openai",
                "openai-compatible",
                " https://api.openai.com/v1 ",
                " gpt-4o-mini ",
            ),
            dto(
                "claude",
                "anthropic",
                "https://api.anthropic.com",
                "claude-x",
            ),
        ])
        .expect("a valid list");
    assert_eq!(ids(&state), ["ollama", "openai", "claude"]);
    let providers = state.providers();
    // What is stored is trimmed; the kind is the name the page uses.
    assert_eq!(providers[1].kind, "openai-compatible");
    assert_eq!(providers[1].base_url, "https://api.openai.com/v1");
    assert_eq!(providers[1].model, "gpt-4o-mini");
    assert_eq!(providers[2].kind, "anthropic");
    assert_eq!(providers[2].base_url, "https://api.anthropic.com");
    assert!(providers.iter().all(|p| !p.has_key));

    // A key lives in the vault under the id: it is told for the provider that has it.
    state.set_key("claude", KEY).expect("set");
    let flags: Vec<_> = state.providers().into_iter().map(|p| p.has_key).collect();
    assert_eq!(flags, [false, false, true]);

    // A second list replaces the first, it does not add to it.
    state
        .configure(&[dto(
            "local",
            "openai-compatible",
            "http://localhost:1234/v1",
            "",
        )])
        .expect("another list");
    assert_eq!(ids(&state), ["ollama", "local"]);
    assert_eq!(state.providers()[1].model, "");
    // The key of a provider that left the list stays in the vault, for when it comes back.
    assert_eq!(vault.get("claude"), Ok(Some(KEY.to_string())));
    state
        .configure(&[dto(
            "claude",
            "anthropic",
            "https://api.anthropic.com",
            "claude-y",
        )])
        .expect("it comes back");
    assert!(state.providers()[1].has_key);

    state.configure(&[]).expect("an empty list");
    assert_eq!(ids(&state), ["ollama"]);
    // The built-in provider is untouched by all of it.
    assert_eq!(state.providers()[0].base_url, "http://localhost:11434/v1");
}

#[test]
fn a_list_that_is_not_valid_is_refused_whole_and_the_old_one_stays() {
    let state = plain_state(Arc::new(MemoryVault::new()));
    let good = dto("work", "openai-compatible", "http://localhost:1234/v1", "m");
    state.configure(std::slice::from_ref(&good)).expect("good");

    let long_model = "m".repeat(MAX_MODEL_CHARS + 1);
    let too_many: Vec<_> = (0..=MAX_PROVIDERS)
        .map(|n| dto(&format!("p{n}"), "anthropic", "https://example.com", "m"))
        .collect();
    let url = "https://example.com/v1";
    let ok = |id: &str| dto(id, "openai-compatible", url, "m");
    let cases: Vec<(&str, Vec<ProviderConfigDto>, &str)> = vec![
        ("the id of Ollama", vec![ok("ollama")], "reserved"),
        (
            "the id of Ollama in capitals",
            vec![ok("Ollama")],
            "reserved",
        ),
        ("a repeated id", vec![ok("a"), ok("a")], "another provider"),
        (
            "a repeated id in other case",
            vec![ok("a"), ok("A")],
            "another provider",
        ),
        ("an empty id", vec![ok("")], "not a provider id"),
        ("a slash in the id", vec![ok("a/b")], "not a provider id"),
        ("a dot-dot id", vec![ok("../x")], "not a provider id"),
        ("a blank in the id", vec![ok("a b")], "not a provider id"),
        ("a leading hyphen", vec![ok("-x")], "not a provider id"),
        ("a long id", vec![ok(&"a".repeat(65))], "not a provider id"),
        (
            "an unknown kind",
            vec![dto("a", "gemini", url, "m")],
            "`openai-compatible` or `anthropic`",
        ),
        (
            "a kind in capitals",
            vec![dto("a", "OpenAI-Compatible", url, "m")],
            "`openai-compatible` or `anthropic`",
        ),
        (
            "no address",
            vec![dto("a", "anthropic", "", "m")],
            "http://",
        ),
        (
            "no scheme",
            vec![dto("a", "anthropic", "localhost:11434", "m")],
            "http://",
        ),
        (
            "a file address",
            vec![dto("a", "anthropic", "file:///etc/passwd", "m")],
            "http://",
        ),
        (
            "an ftp address",
            vec![dto("a", "anthropic", "ftp://example.com", "m")],
            "http://",
        ),
        (
            "no host",
            vec![dto("a", "anthropic", "https://", "m")],
            "http://",
        ),
        (
            "a password in the address",
            vec![dto("a", "anthropic", "https://me:secret@example.com", "m")],
            "no user name or password",
        ),
        (
            "a long model name",
            vec![dto("a", "anthropic", url, &long_model)],
            "model name",
        ),
        ("too many providers", too_many, "more than"),
    ];
    for (what, list, expected) in cases {
        let error = state.configure(&list).expect_err(what);
        assert!(error.contains(expected), "{what}: {error}");
        assert_eq!(
            ids(&state),
            ["ollama", "work"],
            "{what}: the old list stays"
        );
    }
    // The place of the bad one is told, so the person can find it in the file.
    let error = state
        .configure(&[ok("fine"), ok("ollama")])
        .expect_err("second is bad");
    assert!(error.starts_with("provider 2:"), "{error}");
    assert_eq!(state.providers()[1].base_url, "http://localhost:1234/v1");
}

#[test]
fn a_provider_of_the_settings_is_never_given_a_key() {
    // The page sends no key. If a bug made it send one, the list is refused instead of the key being
    // read, kept or repeated.
    let secret = serde_json::json!({
        "id": "work", "kind": "openai-compatible", "baseUrl": "https://example.com/v1",
        "model": "m", "apiKey": KEY
    });
    let error = serde_json::from_value::<ProviderConfigDto>(secret).expect_err("unknown field");
    assert!(error.to_string().contains("apiKey"), "{error}");
    assert!(!error.to_string().contains(KEY), "{error}");
    let missing =
        serde_json::json!({ "id": "work", "kind": "anthropic", "baseUrl": "https://e.com" });
    assert!(serde_json::from_value::<ProviderConfigDto>(missing).is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn a_provider_of_the_settings_answers_with_its_key_and_stops_when_it_leaves_the_list() {
    let server = TestServer::start(stream_back(OPENAI_STREAM));
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.configure(&[work(&server)]).expect("configure");
    state.set_key("work", KEY).expect("set");

    let (result, events) = ask(&state, "work", "req-20").await;
    assert_eq!(result, Ok(()));
    assert_eq!(text_of(&events), "Hello");
    assert_eq!(
        events.last(),
        Some(&AiStreamEvent::Done {
            output_tokens: None
        })
    );
    let request = server.request(0);
    assert_eq!(request.request_line, "POST /v1/chat/completions HTTP/1.1");
    assert_eq!(
        request.header("authorization"),
        Some(format!("Bearer {KEY}").as_str())
    );
    let body: serde_json::Value = serde_json::from_str(&request.body).expect("body");
    assert_eq!(body["model"], "m1", "the model of the settings, trimmed");

    state.configure(&[]).expect("the provider leaves");
    let (result, events) = ask(&state, "work", "req-21").await;
    assert!(result.expect_err("gone").contains("no provider"));
    assert!(events.is_empty());
    assert_eq!(server.request_count(), 1);
}

// ---- the models of Ollama -------------------------------------------------------------------

const TAGS: &str =
    r#"{"models":[{"name":"llama3.2:latest","size":1},{"name":"qwen2.5-coder:7b"}]}"#;

const PS: &str = r#"{"models":[{"name":"llama3.2:latest","model":"llama3.2:latest","size":2019393189,"size_vram":1500000000}]}"#;

/// An Ollama that lists two models, has `llama3.2` loaded, and a `/v1/models` that accepts anyone.
fn fake_ollama(request: &Recorded, stream: &mut TcpStream, _: &Signals) {
    if request.request_line.starts_with("GET /api/tags ") {
        respond(stream, "200 OK", TAGS);
    } else if request.request_line.starts_with("GET /api/ps ") {
        respond(stream, "200 OK", PS);
    } else if request.request_line.starts_with("GET /v1/models ") {
        respond(stream, "200 OK", r#"{"data":[]}"#);
    } else {
        respond(stream, "404 Not Found", "{}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn the_models_installed_in_ollama_are_listed() {
    let server = TestServer::start(fake_ollama);
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    let found = state.ollama_models().await;
    assert_eq!(
        found,
        OllamaModels {
            found: true,
            models: vec![
                "llama3.2:latest".to_string(),
                "qwen2.5-coder:7b".to_string()
            ],
        }
    );
    assert_eq!(server.request(0).request_line, "GET /api/tags HTTP/1.1");
    // The page reads it as `{ found, models }`.
    assert_eq!(
        serde_json::to_value(&found).expect("json"),
        serde_json::json!({ "found": true, "models": ["llama3.2:latest", "qwen2.5-coder:7b"] })
    );
}

#[tokio::test(flavor = "current_thread")]
async fn ollama_with_no_models_is_found_and_ollama_that_is_absent_is_not() {
    let none = OllamaModels {
        found: false,
        models: Vec::new(),
    };
    let empty = TestServer::start(|_, stream, _| respond(stream, "200 OK", r#"{"models":[]}"#));
    let state = state_with_ollama_at(&empty.url, Arc::new(MemoryVault::new()), 1500);
    assert_eq!(
        state.ollama_models().await,
        OllamaModels {
            found: true,
            models: Vec::new()
        }
    );

    // Something else answers on the port.
    let other = TestServer::start(|_, stream, _| respond(stream, "404 Not Found", "nope"));
    let state = state_with_ollama_at(&other.url, Arc::new(MemoryVault::new()), 1500);
    assert_eq!(state.ollama_models().await, none);

    // Nothing listens: not an error either.
    let state = state_with_ollama_at(&closed_port_url(), Arc::new(MemoryVault::new()), 1500);
    assert_eq!(state.ollama_models().await, none);

    // A state with no Ollama at all.
    let client = AiClient::new(Duration::from_millis(500)).expect("client");
    let state = AiState::new(Arc::new(MemoryVault::new()), Vec::new(), client);
    assert_eq!(state.ollama_models().await, none);
}

#[tokio::test(flavor = "current_thread")]
async fn the_memory_of_a_loaded_model_is_read_from_ollama_and_only_from_ollama() {
    let server = TestServer::start(fake_ollama);
    let state = state_with_ollama_at(&server.url, Arc::new(MemoryVault::new()), 1500);
    let memory = state.ollama_memory("llama3.2").await;
    assert_eq!(
        memory,
        Some(OllamaMemoryInfo {
            bytes: 2_019_393_189,
            vram_bytes: 1_500_000_000
        })
    );
    assert_eq!(server.request(0).request_line, "GET /api/ps HTTP/1.1");
    // The page reads it as `{ bytes, vramBytes }`.
    assert_eq!(
        serde_json::to_value(memory).expect("json"),
        serde_json::json!({ "bytes": 2_019_393_189_u64, "vramBytes": 1_500_000_000_u64 })
    );
    // A model that is not loaded.
    assert_eq!(state.ollama_memory("mistral").await, None);

    // A provider of the settings is never asked, whatever its address answers.
    let other = TestServer::start(fake_ollama);
    let state = state_with_ollama_at(&closed_port_url(), Arc::new(MemoryVault::new()), 1500);
    state
        .configure(&[dto(
            "work",
            "openai-compatible",
            &format!("{}/v1", other.url),
            "llama3.2",
        )])
        .expect("configured");
    assert_eq!(state.ollama_memory("llama3.2").await, None);
    assert_eq!(other.request_count(), 0);

    // Ollama that is absent, and a state with no Ollama at all.
    let client = AiClient::new(Duration::from_millis(500)).expect("client");
    let state = AiState::new(Arc::new(MemoryVault::new()), Vec::new(), client);
    assert_eq!(state.ollama_memory("llama3.2").await, None);
}

// ---- the connection test --------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn a_connection_test_sends_the_key_of_the_vault_and_reports_ok() {
    let server = TestServer::start(fake_ollama);
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    state.set_key("openai", KEY).expect("set");
    state.set_key("claude", KEY).expect("set");

    let report = state.test_connection("openai").await.expect("tested");
    assert_eq!(
        report,
        ConnectionReport {
            ok: true,
            kind: None,
            message: None
        }
    );
    let request = server.request(0);
    assert_eq!(request.request_line, "GET /v1/models HTTP/1.1");
    assert_eq!(
        request.header("authorization"),
        Some(format!("Bearer {KEY}").as_str())
    );

    assert!(state.test_connection("claude").await.expect("tested").ok);
    let request = server.request(1);
    assert_eq!(request.request_line, "GET /v1/models HTTP/1.1");
    assert_eq!(request.header("x-api-key"), Some(KEY));
    assert!(request.header("anthropic-version").is_some());

    // Ollama needs no key: none goes out.
    assert!(state.test_connection("ollama").await.expect("tested").ok);
    assert!(server.request(2).header("authorization").is_none());

    // A success is `{ ok: true }` for the page, without the fields of a failure.
    assert_eq!(
        serde_json::to_value(&report).expect("json"),
        serde_json::json!({ "ok": true })
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_rejected_key_gives_a_readable_report_that_does_not_carry_the_key() {
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
    let report = state.test_connection("openai").await.expect("tested");
    assert!(!report.ok);
    assert_eq!(report.kind, Some("auth"));
    let message = report.message.clone().expect("a message");
    assert!(message.contains("401"), "{message}");
    assert!(message.contains("API key"), "{message}");
    assert!(!message.contains(KEY), "the key leaked: {message}");
    let json = serde_json::to_string(&report).expect("json");
    assert!(!json.contains(KEY), "{json}");
    assert!(
        json.contains(r#""ok":false"#) && json.contains(r#""kind":"auth""#),
        "{json}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn other_failures_of_the_connection_test_are_reported_with_a_kind() {
    let kind_of = |report: &ConnectionReport| (report.ok, report.kind);

    // The provider answers, but not with a list: a server error.
    let broken = TestServer::start(|_, stream, _| respond(stream, "500 Server Error", "oops"));
    let state = state_for(&broken, Arc::new(MemoryVault::new()));
    let report = state.test_connection("openai").await.expect("tested");
    assert_eq!(kind_of(&report), (false, Some("http")));
    assert!(report.message.expect("message").contains("500"));

    // Anthropic cannot be asked anything without a key: no request is made.
    let quiet = TestServer::start(fake_ollama);
    let state = state_for(&quiet, Arc::new(MemoryVault::new()));
    let report = state.test_connection("claude").await.expect("tested");
    assert_eq!(kind_of(&report), (false, Some("invalid-request")));
    assert!(report.message.expect("message").contains("API key"));
    assert_eq!(quiet.request_count(), 0);

    // Nothing listens at the address of a provider of the settings. A refused connection takes
    // about 2 s to be reported on Windows: the timeout is longer.
    let state = state_with_ollama_at(&quiet.url, Arc::new(MemoryVault::new()), 8000);
    state
        .configure(&[dto("gone", "openai-compatible", &closed_port_url(), "m")])
        .expect("configure");
    let report = state.test_connection("gone").await.expect("tested");
    assert_eq!(kind_of(&report), (false, Some("network")));
    assert!(!report.message.expect("message").is_empty());

    // A provider that never answers.
    let silent = TestServer::start(|_, stream, signals| stall(stream, signals));
    let state = state_with_ollama_at(&silent.url, Arc::new(MemoryVault::new()), 300);
    let started = Instant::now();
    let report = state.test_connection("ollama").await.expect("tested");
    assert_eq!(kind_of(&report), (false, Some("timeout")));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test(flavor = "current_thread")]
async fn a_connection_test_that_cannot_start_is_an_error_and_no_request_goes_out() {
    let server = TestServer::start(fake_ollama);
    let state = state_for(&server, Arc::new(MemoryVault::new()));
    for bad in ["", "a/b", "../x", "a b", "-x", "nobody"] {
        let error = state.test_connection(bad).await.expect_err(bad);
        assert!(!error.contains(KEY), "{error}");
    }
    assert_eq!(server.request_count(), 0);

    // A keychain that cannot be read stops a provider that has a key, but not Ollama.
    let state = state_for(&server, Arc::new(MemoryVault::broken()));
    let error = state
        .test_connection("openai")
        .await
        .expect_err("no keychain");
    assert!(error.contains("keychain"), "{error}");
    assert_eq!(server.request_count(), 0);
    assert!(state.test_connection("ollama").await.expect("tested").ok);
}

// ---- the new commands, called the way the page calls them -----------------------------------

#[test]
fn the_page_hands_over_the_providers_and_asks_for_models_and_a_test_through_the_commands() {
    let server = TestServer::start(fake_ollama);
    let vault = Arc::new(MemoryVault::new());
    vault.set("work", KEY).expect("a key already stored");
    let state = state_for(&server, vault);
    let answers = call_commands(
        state,
        vec![
            (
                "ai_configure",
                serde_json::json!({ "providers": [{
                    "id": "work", "kind": "openai-compatible",
                    "baseUrl": format!("{}/v1", server.url), "model": "m1"
                }] }),
            ),
            ("ai_providers", serde_json::json!({})),
            ("ai_ollama_models", serde_json::json!({})),
            (
                "ai_ollama_memory",
                serde_json::json!({ "model": "llama3.2" }),
            ),
            ("ai_ollama_memory", serde_json::json!({ "model": "nobody" })),
            (
                "ai_test_connection",
                serde_json::json!({ "providerId": "work" }),
            ),
            (
                "ai_test_connection",
                serde_json::json!({ "providerId": "nobody" }),
            ),
            // A bad list, and one that tries to bring a key.
            (
                "ai_configure",
                serde_json::json!({ "providers": [{
                    "id": "ollama", "kind": "openai-compatible",
                    "baseUrl": "https://example.com/v1", "model": "m"
                }] }),
            ),
            (
                "ai_configure",
                serde_json::json!({ "providers": [{
                    "id": "other", "kind": "anthropic", "baseUrl": "https://example.com",
                    "model": "m", "key": KEY
                }] }),
            ),
            ("ai_providers", serde_json::json!({})),
        ],
    );
    let mut answers = answers.into_iter();
    answers.next().expect("configure").expect("accepted");

    let list = json_of(answers.next().expect("list").expect("list"));
    assert_eq!(list[3]["id"], "work");
    assert_eq!(list[3]["kind"], "openai-compatible");
    assert_eq!(list[3]["model"], "m1");
    assert_eq!(list[3]["hasKey"], true, "the key was already in the vault");
    assert!(!list.to_string().contains(KEY));

    let models = json_of(answers.next().expect("models").expect("models"));
    assert_eq!(
        models,
        serde_json::json!({ "found": true, "models": ["llama3.2:latest", "qwen2.5-coder:7b"] })
    );

    let memory = json_of(answers.next().expect("memory").expect("memory"));
    assert_eq!(
        memory,
        serde_json::json!({ "bytes": 2_019_393_189_u64, "vramBytes": 1_500_000_000_u64 })
    );
    let not_loaded = json_of(answers.next().expect("not loaded").expect("not loaded"));
    assert_eq!(not_loaded, serde_json::Value::Null);

    let tested = json_of(answers.next().expect("test").expect("test"));
    assert_eq!(tested, serde_json::json!({ "ok": true }));
    let refused = answers
        .next()
        .expect("unknown")
        .expect_err("no such provider");
    assert!(refused.to_string().contains("no provider"), "{refused}");

    let reserved = answers.next().expect("reserved").expect_err("reserved");
    assert!(reserved.to_string().contains("reserved"), "{reserved}");
    let with_key = answers
        .next()
        .expect("with a key")
        .expect_err("a key is not accepted");
    assert!(!with_key.to_string().contains(KEY), "{with_key}");

    // Both bad lists left the first one in place.
    let list = json_of(answers.next().expect("list").expect("list"));
    assert_eq!(list.as_array().map(Vec::len), Some(4));
    assert_eq!(list[3]["id"], "work");
}

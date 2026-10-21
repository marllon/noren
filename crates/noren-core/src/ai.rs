//! The AI client, without any Tauri dependency: the two kinds of provider (`openai-compatible`
//! and `anthropic`), the request of a chat with a streamed answer, and the detection of Ollama.
//!
//! Three layers, from the one with no I/O to the one that talks to the network:
//!
//! - [`SseDecoder`] turns the bytes of a `text/event-stream` body into messages (event name and
//!   data). The bytes arrive in pieces cut anywhere, even inside a line or inside a character, so
//!   it keeps what is left over until the line ends.
//! - [`StreamParser`] reads those messages in the format of the provider and produces
//!   [`StreamEvent`]s: text deltas, and exactly one end (`Done` or `Error`).
//! - [`AiClient`] sends the request (`chat_stream`), delivers the events to a callback, gives up
//!   after a timeout and stops at once when its [`CancellationToken`] is cancelled.
//!
//! The API key is a parameter of each call: this module never stores it, reads it from anywhere
//! or writes it anywhere (the system keychain belongs to the layer above). It goes in a header
//! and nowhere else; an error text that contains it has it replaced before it leaves the client.
//! Only the Rust side talks to a provider, and a redirect is never followed, so a header with the
//! key does not go to a host the user did not write.

use std::fmt;
use std::pin::pin;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// Where Ollama listens by default (`ollama serve`).
pub const OLLAMA_DEFAULT_URL: &str = "http://localhost:11434";

/// The longest wait for a connection, for the answer headers and between two pieces of the body.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// The longest the probe for Ollama waits, whatever the timeout of the client.
const OLLAMA_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// The longest the connection test waits for the answer, whatever the timeout of the client: a
/// person is looking at a button.
const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest piece of an error body read to explain it.
const MAX_ERROR_BODY_BYTES: usize = 8 * 1024;
/// Largest list of models accepted from Ollama.
const MAX_TAGS_BYTES: usize = 1024 * 1024;
/// The largest whole number a JavaScript number holds exactly (2^53 - 1).
const MAX_EXACT_JSON_INTEGER: u64 = (1 << 53) - 1;
/// Longest line the stream decoder keeps while waiting for its end.
const MAX_SSE_LINE_BYTES: usize = 1024 * 1024;
/// Longest reason shown for an error, in characters.
const MAX_REASON_CHARS: usize = 300;
/// What the key is replaced with in an error text.
const KEY_MASK: &str = "[key]";
/// Version header the Anthropic API asks for.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The Anthropic API requires an upper bound for the answer.
const ANTHROPIC_MAX_TOKENS: u32 = 4096;

/// The format a provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    /// `POST {base}/chat/completions`, `Authorization: Bearer`. Covers Ollama, LM Studio, vLLM,
    /// OpenRouter, OpenAI and Groq.
    OpenAiCompatible,
    /// `POST {base}/v1/messages`, `x-api-key` and `anthropic-version`.
    Anthropic,
}

impl ProviderKind {
    /// The name used in the settings and in the interface.
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::OpenAiCompatible => "openai-compatible",
            ProviderKind::Anthropic => "anthropic",
        }
    }

    /// The kind with that name, if there is one.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "openai-compatible" => Some(ProviderKind::OpenAiCompatible),
            "anthropic" => Some(ProviderKind::Anthropic),
            _ => None,
        }
    }
}

/// A provider the user set up. The key is not part of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
    pub id: String,
    pub kind: ProviderKind,
    /// The address up to the API root, such as `http://localhost:11434/v1` or
    /// `https://api.anthropic.com`.
    pub base_url: String,
    pub model: String,
}

impl Provider {
    /// The local Ollama, which needs no key, with a model.
    pub fn ollama(model: &str) -> Self {
        Provider {
            id: "ollama".to_string(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: format!("{OLLAMA_DEFAULT_URL}/v1"),
            model: model.to_string(),
        }
    }

    /// What a chat request needs: the id, a model and an address.
    fn validate(&self) -> Result<(), AiError> {
        self.check_id()?;
        if self.model.trim().is_empty() {
            return Err(AiError::InvalidRequest(
                "the provider has no model".to_string(),
            ));
        }
        self.check_address()
    }

    /// What reaching the provider needs, without a model: the id and an address.
    fn validate_endpoint(&self) -> Result<(), AiError> {
        self.check_id()?;
        self.check_address()
    }

    fn check_id(&self) -> Result<(), AiError> {
        if self.id.trim().is_empty() {
            return Err(AiError::InvalidRequest(
                "the provider has no id".to_string(),
            ));
        }
        Ok(())
    }

    fn check_address(&self) -> Result<(), AiError> {
        if !is_http_address(&self.base_url) {
            return Err(AiError::InvalidRequest(
                "the address of the provider must start with http:// or https:// and name a host"
                    .to_string(),
            ));
        }
        Ok(())
    }

    /// The address a chat request goes to.
    pub fn chat_url(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        match self.kind {
            ProviderKind::OpenAiCompatible => format!("{base}/chat/completions"),
            ProviderKind::Anthropic if base.ends_with("/v1") => format!("{base}/messages"),
            ProviderKind::Anthropic => format!("{base}/v1/messages"),
        }
    }

    /// The address of the list of models, which both kinds have and which needs the key but costs
    /// nothing to read: what the connection test asks.
    pub fn models_url(&self) -> String {
        let base = self.base_url.trim().trim_end_matches('/');
        match self.kind {
            ProviderKind::OpenAiCompatible => format!("{base}/models"),
            ProviderKind::Anthropic if base.ends_with("/v1") => format!("{base}/models"),
            ProviderKind::Anthropic => format!("{base}/v1/models"),
        }
    }
}

/// Whether `address` starts with `http://` or `https://` and names a host after it. The only
/// schemes a provider may use: anything else (`file:`, `ftp:`) is refused. An address with blanks
/// or control characters, or with a user name or password in it (`http://user:pass@host`, which
/// would keep a secret outside the keychain), is refused too.
pub fn is_http_address(address: &str) -> bool {
    let address = address.trim();
    let rest = address
        .strip_prefix("http://")
        .or_else(|| address.strip_prefix("https://"))
        .unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    !authority.is_empty()
        && !authority.contains('@')
        && !address.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// A message of the conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

impl ChatMessage {
    pub fn new(role: Role, content: &str) -> Self {
        ChatMessage {
            role,
            content: content.to_string(),
        }
    }
}

/// Why a request ended without an answer. The text of each one is meant to be shown to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiError {
    /// The request cannot be made as it is (no model, a bad address, no messages, no key).
    InvalidRequest(String),
    /// HTTP 401 or 403.
    Auth { status: u16, message: String },
    /// Any other HTTP status that is not a success.
    Http { status: u16, message: String },
    /// The provider could not be reached.
    Network(String),
    /// Nothing came within the timeout.
    Timeout,
    /// The caller cancelled.
    Cancelled,
    /// The provider sent an error inside the stream.
    Provider(String),
    /// The stream is not in the format of the provider.
    Protocol(String),
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn with(f: &mut fmt::Formatter<'_>, head: &str, message: &str) -> fmt::Result {
            if message.is_empty() {
                f.write_str(head)
            } else {
                write!(f, "{head}: {message}")
            }
        }
        match self {
            AiError::InvalidRequest(reason) => f.write_str(reason),
            AiError::Auth { status, message } => with(
                f,
                &format!("the provider rejected the API key (HTTP {status})"),
                message,
            ),
            AiError::Http { status, message } => {
                with(f, &format!("the provider answered HTTP {status}"), message)
            }
            AiError::Network(reason) => with(f, "could not reach the provider", reason),
            AiError::Timeout => f.write_str("the provider did not answer in time"),
            AiError::Cancelled => f.write_str("cancelled"),
            AiError::Provider(message) => with(f, "the provider reported an error", message),
            AiError::Protocol(reason) => with(f, "unexpected answer from the provider", reason),
        }
    }
}

impl std::error::Error for AiError {}

impl AiError {
    /// The same error with `key` taken out of every text it carries.
    fn without_key(self, key: &str) -> AiError {
        if key.is_empty() {
            return self;
        }
        let clean = |text: String| text.replace(key, KEY_MASK);
        match self {
            AiError::InvalidRequest(text) => AiError::InvalidRequest(clean(text)),
            AiError::Auth { status, message } => AiError::Auth {
                status,
                message: clean(message),
            },
            AiError::Http { status, message } => AiError::Http {
                status,
                message: clean(message),
            },
            AiError::Network(text) => AiError::Network(clean(text)),
            AiError::Provider(text) => AiError::Provider(clean(text)),
            AiError::Protocol(text) => AiError::Protocol(clean(text)),
            other @ (AiError::Timeout | AiError::Cancelled) => other,
        }
    }
}

/// What a chat request delivers. Zero or more `Delta`, then exactly one `Done` or `Error`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// A piece of the answer text.
    Delta(String),
    /// The answer is complete. `output_tokens` is the number of tokens of the answer when the
    /// provider reported it in the stream (`usage`), and `None` when it did not or sent something
    /// that is not a whole non-negative number.
    Done { output_tokens: Option<u64> },
    /// The answer stopped, and why.
    Error(AiError),
}

/// One message of an event stream: the `event:` name, if any, and the `data:` lines joined by
/// line feeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseMessage {
    pub event: Option<String>,
    pub data: String,
}

/// Turns the bytes of an event stream into messages, whatever the size of the pieces they come in.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
    event: Option<String>,
    data: Option<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the next piece of the body and returns the messages it completed.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseMessage> {
        self.buf.extend_from_slice(bytes);
        self.drain(false)
    }

    /// The body ended: a message whose blank line never came is delivered all the same.
    pub fn finish(&mut self) -> Vec<SseMessage> {
        let mut out = self.drain(true);
        if !self.buf.is_empty() {
            let line = String::from_utf8_lossy(&self.buf).into_owned();
            self.buf.clear();
            self.line(&line, &mut out);
        }
        out.extend(self.dispatch());
        out
    }

    /// Bytes held while waiting for the end of a line.
    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    fn drain(&mut self, last: bool) -> Vec<SseMessage> {
        let mut out = Vec::new();
        let mut start = 0;
        loop {
            let rest = &self.buf[start..];
            let Some(pos) = rest.iter().position(|b| *b == b'\n' || *b == b'\r') else {
                break;
            };
            let mut end = 1;
            if rest[pos] == b'\r' {
                match rest.get(pos + 1) {
                    Some(b'\n') => end = 2,
                    // A `\r` at the very end may be the first half of `\r\n`: wait for more.
                    None if !last => break,
                    _ => {}
                }
            }
            // The line ends at an ASCII byte, which never occurs inside a character, so decoding
            // whole lines never cuts one.
            let line = String::from_utf8_lossy(&rest[..pos]).into_owned();
            start += pos + end;
            self.line(&line, &mut out);
        }
        self.buf.drain(..start);
        out
    }

    fn line(&mut self, line: &str, out: &mut Vec<SseMessage>) {
        if line.is_empty() {
            out.extend(self.dispatch());
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_string()),
            },
            _ => {}
        }
    }

    fn dispatch(&mut self) -> Option<SseMessage> {
        let event = self.event.take();
        let data = self.data.take()?;
        Some(SseMessage { event, data })
    }
}

/// Reads the stream of one provider: bytes in, [`StreamEvent`]s out. After the end (`Done` or
/// `Error`) it ignores whatever comes.
#[derive(Debug)]
pub struct StreamParser {
    kind: ProviderKind,
    sse: SseDecoder,
    /// The provider said the answer is complete but the stream is still open (the finish reason
    /// of a chunk of the chat completions format).
    complete: bool,
    /// The count of tokens of the answer the provider reported, if it did (the last valid one).
    output_tokens: Option<u64>,
    ended: bool,
}

impl StreamParser {
    pub fn new(kind: ProviderKind) -> Self {
        StreamParser {
            kind,
            sse: SseDecoder::new(),
            complete: false,
            output_tokens: None,
            ended: false,
        }
    }

    /// Whether the end has been produced.
    pub fn is_ended(&self) -> bool {
        self.ended
    }

    /// Adds the next piece of the body.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<StreamEvent> {
        if self.ended {
            return Vec::new();
        }
        let messages = self.sse.push(bytes);
        let mut events = self.read(messages);
        if !self.ended && self.sse.pending_bytes() > MAX_SSE_LINE_BYTES {
            self.ended = true;
            events.push(StreamEvent::Error(AiError::Protocol(
                "an event is larger than the limit".to_string(),
            )));
        }
        events
    }

    /// The body ended. A stream that stopped before the provider said it was complete is an error.
    pub fn finish(&mut self) -> Vec<StreamEvent> {
        if self.ended {
            return Vec::new();
        }
        let messages = self.sse.finish();
        let mut events = self.read(messages);
        if !self.ended {
            self.ended = true;
            events.push(if self.complete {
                self.done()
            } else {
                StreamEvent::Error(AiError::Protocol(
                    "the stream ended before the answer was complete".to_string(),
                ))
            });
        }
        events
    }

    fn read(&mut self, messages: Vec<SseMessage>) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        for message in messages {
            if self.ended {
                break;
            }
            match self.kind {
                ProviderKind::OpenAiCompatible => self.read_openai(&message, &mut events),
                ProviderKind::Anthropic => self.read_anthropic(&message, &mut events),
            }
        }
        events
    }

    fn done(&self) -> StreamEvent {
        StreamEvent::Done {
            output_tokens: self.output_tokens,
        }
    }

    /// Keeps the count in `counter` when it is a whole number of tokens; anything else (absent,
    /// negative, fractional, text) is ignored, never an error.
    fn note_tokens(&mut self, counter: Option<&Value>) {
        if let Some(count) = counter.and_then(Value::as_u64) {
            self.output_tokens = Some(count);
        }
    }

    fn end(&mut self, events: &mut Vec<StreamEvent>, event: StreamEvent) {
        self.ended = true;
        events.push(event);
    }

    /// Chunks of `chat/completions`: `{"choices":[{"delta":{"content":"..."},"finish_reason":null}]}`
    /// and a last `data: [DONE]`.
    fn read_openai(&mut self, message: &SseMessage, events: &mut Vec<StreamEvent>) {
        let data = message.data.trim();
        if data.is_empty() {
            return;
        }
        if data == "[DONE]" {
            let done = self.done();
            self.end(events, done);
            return;
        }
        let value: Value = match serde_json::from_str(data) {
            Ok(value) => value,
            Err(_) => {
                let error = AiError::Protocol("an event is not valid JSON".to_string());
                self.end(events, StreamEvent::Error(error));
                return;
            }
        };
        if let Some(error) = value.get("error") {
            let error = AiError::Provider(error_reason(error));
            self.end(events, StreamEvent::Error(error));
            return;
        }
        // With `stream_options.include_usage` the last chunk has no choices and carries the count.
        self.note_tokens(value.pointer("/usage/completion_tokens"));
        let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
            return;
        };
        if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str)
            && !text.is_empty()
        {
            events.push(StreamEvent::Delta(text.to_string()));
        }
        if choice
            .get("finish_reason")
            .is_some_and(|reason| !reason.is_null())
        {
            self.complete = true;
        }
    }

    /// Events of `messages`: `message_start` and `message_delta` (the count of output tokens in
    /// `usage`), `content_block_delta` (`delta.text`), `message_stop` and `error`; the others
    /// (`ping`, `content_block_start`, ...) say nothing about the text.
    fn read_anthropic(&mut self, message: &SseMessage, events: &mut Vec<StreamEvent>) {
        let data = message.data.trim();
        if data.is_empty() {
            return;
        }
        let value: Value = match serde_json::from_str(data) {
            Ok(value) => value,
            Err(_) => {
                let error = AiError::Protocol("an event is not valid JSON".to_string());
                self.end(events, StreamEvent::Error(error));
                return;
            }
        };
        let name = value
            .get("type")
            .and_then(Value::as_str)
            .or(message.event.as_deref())
            .unwrap_or("");
        match name {
            "content_block_delta" => {
                if let Some(text) = value.pointer("/delta/text").and_then(Value::as_str)
                    && !text.is_empty()
                {
                    events.push(StreamEvent::Delta(text.to_string()));
                }
            }
            "message_start" => self.note_tokens(value.pointer("/message/usage/output_tokens")),
            "message_delta" => self.note_tokens(value.pointer("/usage/output_tokens")),
            "message_stop" => {
                let done = self.done();
                self.end(events, done);
            }
            "error" => {
                let reason = value.get("error").map(error_reason).unwrap_or_default();
                self.end(events, StreamEvent::Error(AiError::Provider(reason)));
            }
            _ => {}
        }
    }
}

/// The readable reason inside an `error` value: its `message`, or the value itself if it is text.
fn error_reason(error: &Value) -> String {
    let text = error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("");
    clean_reason(text)
}

/// Text meant for a person: control characters out, a limit on its length.
fn clean_reason(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > MAX_REASON_CHARS {
        let cut: String = flat.chars().take(MAX_REASON_CHARS).collect();
        format!("{cut}...")
    } else {
        flat
    }
}

/// The reason in the body of an HTTP error: the `message` of an `error` object, or the text.
fn body_reason(body: &[u8]) -> String {
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        let candidates = [value.get("error"), value.get("message"), Some(&value)];
        for candidate in candidates.into_iter().flatten() {
            let reason = error_reason(candidate);
            if !reason.is_empty() {
                return reason;
            }
        }
        return String::new();
    }
    clean_reason(&String::from_utf8_lossy(body))
}

/// The body of the request, in the format of the provider.
fn request_body(provider: &Provider, messages: &[ChatMessage]) -> Result<Value, AiError> {
    if messages.iter().all(|m| m.role == Role::System) {
        return Err(AiError::InvalidRequest(
            "there is no message to send".to_string(),
        ));
    }
    Ok(match provider.kind {
        ProviderKind::OpenAiCompatible => json!({
            "model": provider.model,
            "stream": true,
            // Asks for the count of tokens in a last chunk of the stream.
            "stream_options": { "include_usage": true },
            "messages": messages
                .iter()
                .map(|m| json!({ "role": m.role.as_str(), "content": m.content }))
                .collect::<Vec<_>>(),
        }),
        ProviderKind::Anthropic => {
            // The format keeps the system prompt out of the list of messages.
            let system = messages
                .iter()
                .filter(|m| m.role == Role::System)
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let mut body = json!({
                "model": provider.model,
                "max_tokens": ANTHROPIC_MAX_TOKENS,
                "stream": true,
                "messages": messages
                    .iter()
                    .filter(|m| m.role != Role::System)
                    .map(|m| json!({ "role": m.role.as_str(), "content": m.content }))
                    .collect::<Vec<_>>(),
            });
            if !system.is_empty() {
                body["system"] = Value::String(system);
            }
            body
        }
    })
}

/// What a probe for Ollama found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OllamaProbe {
    /// Ollama answered; these are the models installed (possibly none).
    Found(Vec<String>),
    /// Nothing that looks like Ollama answered. Not an error: most machines do not have it.
    NotFound,
}

/// What Ollama says a loaded model takes: the whole model and the part of it held in video memory,
/// both in bytes (`size` and `size_vram` of `/api/ps`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OllamaMemory {
    pub bytes: u64,
    pub vram_bytes: u64,
}

/// The client of the providers. Cheap to clone.
#[derive(Debug, Clone)]
pub struct AiClient {
    http: reqwest::Client,
    timeout: Duration,
}

impl AiClient {
    /// A client whose `timeout` bounds the connection, the wait for the answer headers and the
    /// silence between two pieces of the body. It does not bound the whole answer: a long answer
    /// that keeps coming is fine.
    pub fn new(timeout: Duration) -> Result<Self, AiError> {
        let http = reqwest::Client::builder()
            .connect_timeout(timeout)
            // A redirect would carry the `x-api-key` header to another host.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("noren/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| AiError::Network(describe(&e)))?;
        Ok(AiClient { http, timeout })
    }

    /// Sends the conversation and delivers the answer to `on_event` as it arrives: zero or more
    /// `Delta`, then exactly one `Done` or `Error`. The return value repeats that last event
    /// (`Ok` for `Done`). `api_key` is `None` for a provider that needs none, such as Ollama.
    /// Cancelling `cancel` ends the request with `Cancelled` and closes the connection.
    pub async fn chat_stream<F: FnMut(StreamEvent) + Send>(
        &self,
        provider: &Provider,
        api_key: Option<&str>,
        messages: &[ChatMessage],
        cancel: &CancellationToken,
        mut on_event: F,
    ) -> Result<(), AiError> {
        match self
            .drive(provider, api_key, messages, cancel, &mut on_event)
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                let error = error.without_key(api_key.unwrap_or(""));
                on_event(StreamEvent::Error(error.clone()));
                Err(error)
            }
        }
    }

    /// Delivers the deltas and the `Done`; returns the error without delivering it.
    async fn drive(
        &self,
        provider: &Provider,
        api_key: Option<&str>,
        messages: &[ChatMessage],
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> Result<(), AiError> {
        provider.validate()?;
        let body = request_body(provider, messages)?;
        let request = authorize(
            self.http
                .post(provider.chat_url())
                .header("content-type", "application/json")
                .header("accept", "text/event-stream"),
            provider.kind,
            api_key,
        )?
        .body(body.to_string());

        let sent = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(AiError::Cancelled),
            sent = tokio::time::timeout(self.timeout, request.send()) => sent,
        };
        let response = sent
            .map_err(|_| AiError::Timeout)?
            .map_err(|e| from_reqwest(&e))?;

        let status = response.status();
        let mut stream = pin!(response.bytes_stream());
        if !status.is_success() {
            let bytes = self
                .read_limited(&mut stream, MAX_ERROR_BODY_BYTES, cancel)
                .await?;
            let message = body_reason(&bytes);
            let status = status.as_u16();
            return Err(if status == 401 || status == 403 {
                AiError::Auth { status, message }
            } else {
                AiError::Http { status, message }
            });
        }

        let mut parser = StreamParser::new(provider.kind);
        loop {
            let next = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(AiError::Cancelled),
                next = tokio::time::timeout(self.timeout, stream.next()) => next,
            };
            let events = match next.map_err(|_| AiError::Timeout)? {
                None => parser.finish(),
                Some(Err(e)) => return Err(from_reqwest(&e)),
                Some(Ok(bytes)) => parser.push(&bytes),
            };
            let finished = parser.is_ended();
            deliver(events, on_event)?;
            if finished {
                return Ok(());
            }
        }
    }

    /// Checks that the provider answers and accepts the key, by reading its list of models
    /// (`Provider::models_url`): a request that costs nothing, unlike a chat, and needs no model.
    /// Any success status is `Ok`. Otherwise the error says what to fix, in the words of `AiError`,
    /// with the key taken out of every text: a rejected key (401/403), another HTTP status, a
    /// provider that cannot be reached, no answer in time, a missing key (`anthropic` needs one).
    /// The wait is at most `CONNECTION_TEST_TIMEOUT`, whatever the timeout of the client.
    pub async fn check_connection(
        &self,
        provider: &Provider,
        api_key: Option<&str>,
    ) -> Result<(), AiError> {
        self.probe(provider, api_key)
            .await
            .map_err(|error| error.without_key(api_key.map(str::trim).unwrap_or("")))
    }

    async fn probe(&self, provider: &Provider, api_key: Option<&str>) -> Result<(), AiError> {
        provider.validate_endpoint()?;
        let request = authorize(
            self.http
                .get(provider.models_url())
                .header("accept", "application/json"),
            provider.kind,
            api_key,
        )?;
        let limit = self.timeout.min(CONNECTION_TEST_TIMEOUT);
        let response = tokio::time::timeout(limit, request.send())
            .await
            .map_err(|_| AiError::Timeout)?
            .map_err(|e| from_reqwest(&e))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        // The body only explains the status: one that stalls or breaks loses the explanation.
        let mut stream = pin!(response.bytes_stream());
        let bytes = tokio::time::timeout(
            limit,
            self.read_limited(&mut stream, MAX_ERROR_BODY_BYTES, &CancellationToken::new()),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
        let message = body_reason(&bytes);
        let status = status.as_u16();
        Err(if status == 401 || status == 403 {
            AiError::Auth { status, message }
        } else {
            AiError::Http { status, message }
        })
    }

    /// Reads at most `limit` bytes of a body, under the timeout and the cancellation.
    async fn read_limited<S, B>(
        &self,
        stream: &mut S,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, AiError>
    where
        S: futures_util::Stream<Item = Result<B, reqwest::Error>> + Unpin,
        B: AsRef<[u8]>,
    {
        let mut out = Vec::new();
        while out.len() < limit {
            let next = tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(AiError::Cancelled),
                next = tokio::time::timeout(self.timeout, stream.next()) => next,
            };
            match next {
                // A body that stalls or breaks only loses the explanation: the status stands.
                Err(_) | Ok(None) | Ok(Some(Err(_))) => break,
                Ok(Some(Ok(bytes))) => out.extend_from_slice(bytes.as_ref()),
            }
        }
        out.truncate(limit);
        Ok(out)
    }

    /// Looks for Ollama at `base_url` (the root, or the `/v1` address of a provider) with
    /// `GET /api/tags`. A port that does not answer, an answer that is not Ollama's and a timeout
    /// are all `NotFound`, never an error.
    pub async fn detect_ollama(&self, base_url: &str) -> OllamaProbe {
        let root = base_url.trim().trim_end_matches('/');
        let root = root.strip_suffix("/v1").unwrap_or(root);
        if !(root.starts_with("http://") || root.starts_with("https://")) {
            return OllamaProbe::NotFound;
        }
        let probe = async {
            let response = self
                .http
                .get(format!("{root}/api/tags"))
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let mut stream = pin!(response.bytes_stream());
            let bytes = self
                .read_limited(&mut stream, MAX_TAGS_BYTES, &CancellationToken::new())
                .await
                .ok()?;
            let value: Value = serde_json::from_slice(&bytes).ok()?;
            let models = value.get("models")?.as_array()?;
            Some(
                models
                    .iter()
                    .filter_map(|m| m.get("name").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>(),
            )
        };
        // A local server answers at once; a long wait here would only delay the settings screen.
        match tokio::time::timeout(self.timeout.min(OLLAMA_PROBE_TIMEOUT), probe).await {
            Ok(Some(models)) => OllamaProbe::Found(models),
            _ => OllamaProbe::NotFound,
        }
    }

    /// The memory Ollama holds for `model`, read from `GET /api/ps` at `base_url` (the root, or
    /// the `/v1` address of a provider). `None` when Ollama does not answer, answers something
    /// else, does not have the model loaded or reports a number that is not a whole number of 0
    /// or more: a measurement that is missing, never an error. The wait is as short as the
    /// probe's.
    pub async fn ollama_memory(&self, base_url: &str, model: &str) -> Option<OllamaMemory> {
        let root = base_url.trim().trim_end_matches('/');
        let root = root.strip_suffix("/v1").unwrap_or(root);
        if !(root.starts_with("http://") || root.starts_with("https://")) {
            return None;
        }
        let read = async {
            let response = self.http.get(format!("{root}/api/ps")).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let mut stream = pin!(response.bytes_stream());
            let bytes = self
                .read_limited(&mut stream, MAX_TAGS_BYTES, &CancellationToken::new())
                .await
                .ok()?;
            memory_of(&bytes, model)
        };
        tokio::time::timeout(self.timeout.min(OLLAMA_PROBE_TIMEOUT), read)
            .await
            .ok()
            .flatten()
    }
}

/// Ollama names a model with a tag and calls the one with no tag `latest`: `llama3` and
/// `llama3:latest` are the same model. A colon only starts a tag after the last slash (the
/// address of a registry can hold a port).
fn with_default_tag(name: &str) -> String {
    let name = name.trim();
    let after_path = name.rsplit('/').next().unwrap_or(name);
    if after_path.contains(':') {
        name.to_string()
    } else {
        format!("{name}:latest")
    }
}

/// Finds `model` in the body of `GET /api/ps` and reads its memory. `None` when the body is not
/// what Ollama sends, when the model is not among the loaded ones or when its `size` or
/// `size_vram` is not a whole number of 0 or more.
fn memory_of(body: &[u8], model: &str) -> Option<OllamaMemory> {
    let wanted = with_default_tag(model);
    if wanted == ":latest" {
        return None;
    }
    let value: Value = serde_json::from_slice(body).ok()?;
    let entry = value.get("models")?.as_array()?.iter().find(|entry| {
        ["name", "model"].iter().any(|key| {
            entry
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|name| with_default_tag(name) == wanted)
        })
    })?;
    // `as_u64` refuses a negative number, a fraction and a text; the page reads the numbers as
    // JavaScript numbers, so one it cannot hold exactly is no measurement either.
    let whole = |key: &str| {
        entry
            .get(key)?
            .as_u64()
            .filter(|n| *n <= MAX_EXACT_JSON_INTEGER)
    };
    Some(OllamaMemory {
        bytes: whole("size")?,
        vram_bytes: whole("size_vram")?,
    })
}

/// Puts the key in the header its kind of provider reads. A key that is blank counts as none:
/// `openai-compatible` goes without a header (Ollama and others need no key) and `anthropic` is
/// refused, as it cannot be asked anything without one.
fn authorize(
    request: reqwest::RequestBuilder,
    kind: ProviderKind,
    api_key: Option<&str>,
) -> Result<reqwest::RequestBuilder, AiError> {
    let key = api_key.map(str::trim).filter(|key| !key.is_empty());
    match (kind, key) {
        (ProviderKind::OpenAiCompatible, Some(key)) => Ok(request.bearer_auth(key)),
        (ProviderKind::OpenAiCompatible, None) => Ok(request),
        (ProviderKind::Anthropic, Some(key)) => Ok(request
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)),
        (ProviderKind::Anthropic, None) => Err(AiError::InvalidRequest(
            "this provider needs an API key and none is set".to_string(),
        )),
    }
}

/// Hands events to the callback. An error is returned instead of delivered: the caller delivers
/// it once, after taking the key out of its text.
fn deliver(
    events: Vec<StreamEvent>,
    on_event: &mut (dyn FnMut(StreamEvent) + Send),
) -> Result<(), AiError> {
    for event in events {
        match event {
            StreamEvent::Error(error) => return Err(error),
            other => on_event(other),
        }
    }
    Ok(())
}

fn from_reqwest(error: &reqwest::Error) -> AiError {
    if error.is_timeout() {
        AiError::Timeout
    } else {
        AiError::Network(describe(error))
    }
}

/// The text of a request error with its causes, without the address.
fn describe(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    // The address is repeated in some of the texts of the chain; the user already knows it.
    let text = parts.join(": ");
    clean_reason(&match error.url() {
        Some(url) => text.replace(url.as_str(), "the address"),
        None => text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    // ---- the pure parts ----------------------------------------------------------------------

    fn openai_stream() -> String {
        [
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo w\\u00f6rld \\ud83d\\ude00\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        ]
        .concat()
    }

    fn anthropic_stream() -> String {
        [
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"role\":\"assistant\",\"content\":[]}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: ping\ndata: {\"type\":\"ping\"}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo w\\u00f6rld \\ud83d\\ude00\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ]
        .concat()
    }

    fn deltas_and_end(events: &[StreamEvent]) -> (String, Vec<StreamEvent>) {
        let mut text = String::new();
        let mut ends = Vec::new();
        for event in events {
            match event {
                StreamEvent::Delta(piece) => text.push_str(piece),
                other => ends.push(other.clone()),
            }
        }
        (text, ends)
    }

    fn parse_in_pieces(kind: ProviderKind, body: &[u8], size: usize) -> Vec<StreamEvent> {
        let mut parser = StreamParser::new(kind);
        let mut events = Vec::new();
        for piece in body.chunks(size) {
            events.extend(parser.push(piece));
        }
        events.extend(parser.finish());
        events
    }

    #[test]
    fn sse_decoder_reads_lines_split_anywhere() {
        let body = "event: a\ndata: one\ndata: two\n\n: comment\ndata: three\n\n";
        let whole = SseDecoder::new().push(body.as_bytes());
        assert_eq!(
            whole,
            vec![
                SseMessage {
                    event: Some("a".to_string()),
                    data: "one\ntwo".to_string()
                },
                SseMessage {
                    event: None,
                    data: "three".to_string()
                },
            ]
        );
        for size in 1..body.len() {
            let mut decoder = SseDecoder::new();
            let mut messages = Vec::new();
            for piece in body.as_bytes().chunks(size) {
                messages.extend(decoder.push(piece));
            }
            messages.extend(decoder.finish());
            assert_eq!(messages, whole, "pieces of {size} bytes");
        }
    }

    #[test]
    fn sse_decoder_handles_all_line_endings_and_the_missing_last_blank_line() {
        let mut decoder = SseDecoder::new();
        let mut crlf = decoder.push(b"data: x\r\n\r\ndata: y\r\r");
        // The last `\r` waits for a possible `\n`; the end of the body settles it.
        assert_eq!(crlf.len(), 1);
        crlf.extend(decoder.finish());
        assert_eq!(
            crlf.iter().map(|m| m.data.as_str()).collect::<Vec<_>>(),
            vec!["x", "y"]
        );
        // A `\r` at the end of a piece waits for the `\n` that may follow.
        let mut decoder = SseDecoder::new();
        let mut messages = decoder.push(b"data: x\r");
        messages.extend(decoder.push(b"\n\r\n"));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].data, "x");
        // No blank line before the end of the body.
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b"data: [DONE]").is_empty());
        let rest = decoder.finish();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].data, "[DONE]");
    }

    #[test]
    fn openai_stream_in_any_piece_size_gives_the_same_events() {
        let body = openai_stream();
        let expected = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), body.len());
        let (text, ends) = deltas_and_end(&expected);
        assert_eq!(text, "Hello w\u{f6}rld \u{1F600}");
        assert_eq!(
            ends,
            vec![StreamEvent::Done {
                output_tokens: None
            }]
        );
        for size in 1..=13 {
            let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), size);
            assert_eq!(
                deltas_and_end(&events),
                (text.clone(), ends.clone()),
                "{size}"
            );
        }
    }

    #[test]
    fn a_piece_that_cuts_a_line_and_a_character_is_joined() {
        // "ö" is two bytes and the emoji four: cut right in the middle of each.
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"a\u{f6}\u{1F600}b\"}}]}\n\n";
        let bytes = line.as_bytes();
        let cut_o = bytes
            .iter()
            .position(|b| *b == 0xC3)
            .expect("first byte of o with umlaut")
            + 1;
        let cut_emoji = bytes
            .iter()
            .position(|b| *b == 0xF0)
            .expect("first byte of the emoji")
            + 2;
        let mut parser = StreamParser::new(ProviderKind::OpenAiCompatible);
        let mut events = parser.push(&bytes[..cut_o]);
        events.extend(parser.push(&bytes[cut_o..cut_emoji]));
        events.extend(parser.push(&bytes[cut_emoji..bytes.len() - 5]));
        assert!(events.is_empty(), "no line finished yet: {events:?}");
        events.extend(parser.push(&bytes[bytes.len() - 5..]));
        assert_eq!(
            events,
            vec![StreamEvent::Delta("a\u{f6}\u{1F600}b".to_string())]
        );
    }

    #[test]
    fn openai_without_done_but_with_a_finish_reason_ends_when_the_body_does() {
        let body =
            "data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}]}\n\n";
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 1000);
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta("x".to_string()),
                StreamEvent::Done {
                    output_tokens: None
                }
            ]
        );
    }

    #[test]
    fn a_stream_that_stops_early_is_an_error() {
        let body =
            "data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":null}]}\n\n";
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 1000);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[1],
            StreamEvent::Error(AiError::Protocol(_))
        ));
        let cut = anthropic_stream();
        let cut = &cut[..cut.find("event: message_stop").expect("stop event")];
        let events = parse_in_pieces(ProviderKind::Anthropic, cut.as_bytes(), 1000);
        assert!(matches!(
            events.last(),
            Some(StreamEvent::Error(AiError::Protocol(_)))
        ));
    }

    #[test]
    fn anthropic_stream_in_any_piece_size_gives_the_same_events() {
        let body = anthropic_stream();
        for size in [1, 2, 3, 7, 50, body.len()] {
            let events = parse_in_pieces(ProviderKind::Anthropic, body.as_bytes(), size);
            let (text, ends) = deltas_and_end(&events);
            assert_eq!(text, "Hello w\u{f6}rld \u{1F600}", "{size}");
            assert_eq!(
                ends,
                vec![StreamEvent::Done {
                    output_tokens: None
                }],
                "{size}"
            );
        }
    }

    /// A stream of the chat completions format whose last chunk, after the finish reason, has no
    /// choices and carries `usage` (what `stream_options.include_usage` asks for).
    fn openai_stream_with_usage(usage: &str) -> String {
        [
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"},\"finish_reason\":null}],\"usage\":null}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":null}],\"usage\":null}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":null}\n\n",
            &format!("data: {{\"choices\":[],\"usage\":{usage}}}\n\n"),
            "data: [DONE]\n\n",
        ]
        .concat()
    }

    #[test]
    fn the_count_in_the_last_chunk_reaches_done_in_any_piece_size() {
        let body = openai_stream_with_usage(
            "{\"prompt_tokens\":12,\"completion_tokens\":37,\"total_tokens\":49}",
        );
        let expected = vec![
            StreamEvent::Delta("Hel".to_string()),
            StreamEvent::Delta("lo".to_string()),
            StreamEvent::Done {
                output_tokens: Some(37),
            },
        ];
        for size in (1..=17).chain([64, 200, body.len()]) {
            let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), size);
            // The chunk with no choices is neither an error nor a piece of text.
            assert_eq!(events, expected, "{size}");
        }
    }

    #[test]
    fn the_count_is_kept_when_the_body_ends_without_done() {
        let body = openai_stream_with_usage("{\"completion_tokens\":5}");
        let body = body.replace("data: [DONE]\n\n", "");
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 9);
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Done {
                output_tokens: Some(5)
            })
        );
    }

    #[test]
    fn the_count_may_come_in_a_chunk_that_also_has_a_choice() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}],\"usage\":{\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 5);
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta("x".to_string()),
                StreamEvent::Done {
                    output_tokens: Some(1)
                }
            ]
        );
    }

    #[test]
    fn a_stream_without_a_count_is_done_without_one() {
        for body in [
            openai_stream(),
            // No completion_tokens in the usage, or no usage at all.
            openai_stream_with_usage("{\"prompt_tokens\":3}"),
            openai_stream_with_usage("null"),
        ] {
            let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 6);
            assert_eq!(
                events.last(),
                Some(&StreamEvent::Done {
                    output_tokens: None
                })
            );
        }
    }

    #[test]
    fn a_count_that_is_not_a_whole_number_is_none_and_never_an_error() {
        for bad in [
            "-3",
            "2.5",
            "7.0",
            "1e3",
            "\"12\"",
            "null",
            "true",
            "[4]",
            "{}",
            "18446744073709551616",
        ] {
            let body = openai_stream_with_usage(&format!("{{\"completion_tokens\":{bad}}}"));
            let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 8);
            let (text, ends) = deltas_and_end(&events);
            assert_eq!(text, "Hello", "{bad}");
            assert_eq!(
                ends,
                vec![StreamEvent::Done {
                    output_tokens: None
                }],
                "{bad}"
            );
        }
        // A bad count after a good one does not erase the good one.
        let body = [
            "data: {\"choices\":[],\"usage\":{\"completion_tokens\":9}}\n\n",
            "data: {\"choices\":[],\"usage\":{\"completion_tokens\":-1}}\n\n",
            "data: [DONE]\n\n",
        ]
        .concat();
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 4);
        assert_eq!(
            events,
            vec![StreamEvent::Done {
                output_tokens: Some(9)
            }]
        );
        // Zero is a whole number.
        let body = "data: {\"choices\":[],\"usage\":{\"completion_tokens\":0}}\n\ndata: [DONE]\n\n";
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, body.as_bytes(), 1000);
        assert_eq!(
            events,
            vec![StreamEvent::Done {
                output_tokens: Some(0)
            }]
        );
    }

    #[test]
    fn anthropic_count_comes_from_message_delta_and_the_last_one_wins() {
        let body = anthropic_stream()
            .replace(
                "\"content\":[]}}",
                "\"content\":[],\"usage\":{\"input_tokens\":25,\"output_tokens\":1}}}",
            )
            .replace(
                "\"delta\":{\"stop_reason\":\"end_turn\"}}",
                "\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":15}}",
            );
        assert!(body.contains("\"output_tokens\":15"));
        for size in [1, 2, 5, 33, body.len()] {
            let events = parse_in_pieces(ProviderKind::Anthropic, body.as_bytes(), size);
            let (text, ends) = deltas_and_end(&events);
            assert_eq!(text, "Hello w\u{f6}rld \u{1F600}", "{size}");
            assert_eq!(
                ends,
                vec![StreamEvent::Done {
                    output_tokens: Some(15)
                }],
                "{size}"
            );
        }
        // Only the start event has a count: it is the one reported.
        let only_start = anthropic_stream().replace(
            "\"content\":[]}}",
            "\"content\":[],\"usage\":{\"output_tokens\":2}}}",
        );
        let events = parse_in_pieces(ProviderKind::Anthropic, only_start.as_bytes(), 1000);
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Done {
                output_tokens: Some(2)
            })
        );
        // A count that is not a whole number is none, and the text still arrives.
        let bad = anthropic_stream().replace(
            "\"delta\":{\"stop_reason\":\"end_turn\"}}",
            "\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":-4}}",
        );
        let events = parse_in_pieces(ProviderKind::Anthropic, bad.as_bytes(), 1000);
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Done {
                output_tokens: None
            })
        );
    }

    #[test]
    fn errors_inside_the_stream_carry_the_reason() {
        let anthropic = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let events = parse_in_pieces(ProviderKind::Anthropic, anthropic.as_bytes(), 9);
        assert_eq!(
            events,
            vec![StreamEvent::Error(AiError::Provider(
                "Overloaded".to_string()
            ))]
        );
        let openai = "data: {\"error\":{\"message\":\"The model is loading\",\"type\":\"server_error\"}}\n\n";
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, openai.as_bytes(), 9);
        assert_eq!(
            events,
            vec![StreamEvent::Error(AiError::Provider(
                "The model is loading".to_string()
            ))]
        );
        let events = parse_in_pieces(ProviderKind::OpenAiCompatible, b"data: {oops\n\n", 4);
        assert!(matches!(
            events[..],
            [StreamEvent::Error(AiError::Protocol(_))]
        ));
    }

    #[test]
    fn after_the_end_nothing_more_is_read() {
        let mut parser = StreamParser::new(ProviderKind::OpenAiCompatible);
        let events = parser
            .push(b"data: [DONE]\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n");
        assert_eq!(
            events,
            vec![StreamEvent::Done {
                output_tokens: None
            }]
        );
        assert!(parser.is_ended());
        assert!(parser.push(b"data: more\n\n").is_empty());
        assert!(parser.finish().is_empty());
    }

    #[test]
    fn a_line_without_end_has_a_limit() {
        let mut parser = StreamParser::new(ProviderKind::OpenAiCompatible);
        let big = vec![b'a'; MAX_SSE_LINE_BYTES + 1];
        let events = parser.push(&big);
        assert!(matches!(
            events[..],
            [StreamEvent::Error(AiError::Protocol(_))]
        ));
    }

    #[test]
    fn chat_url_follows_the_kind_and_the_base() {
        let mut provider = Provider::ollama("m");
        assert_eq!(
            provider.chat_url(),
            "http://localhost:11434/v1/chat/completions"
        );
        provider.base_url = "https://api.example.com/v1/".to_string();
        assert_eq!(
            provider.chat_url(),
            "https://api.example.com/v1/chat/completions"
        );
        provider.kind = ProviderKind::Anthropic;
        assert_eq!(provider.chat_url(), "https://api.example.com/v1/messages");
        provider.base_url = "https://api.anthropic.com".to_string();
        assert_eq!(provider.chat_url(), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn provider_kind_names_round_trip() {
        for kind in [ProviderKind::OpenAiCompatible, ProviderKind::Anthropic] {
            assert_eq!(ProviderKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(ProviderKind::parse("gemini"), None);
    }

    #[test]
    fn request_bodies_follow_each_format() {
        let messages = [
            ChatMessage::new(Role::System, "Be brief."),
            ChatMessage::new(Role::User, "hi"),
            ChatMessage::new(Role::Assistant, "hello"),
            ChatMessage::new(Role::User, "and?"),
        ];
        let openai = request_body(&Provider::ollama("llama3"), &messages).expect("body");
        assert_eq!(openai["model"], "llama3");
        assert_eq!(openai["stream"], true);
        assert_eq!(openai["messages"].as_array().map(Vec::len), Some(4));
        assert_eq!(openai["messages"][0]["role"], "system");
        // The count of tokens of the answer comes in a last chunk only when it is asked for.
        assert_eq!(openai["stream_options"], json!({ "include_usage": true }));

        let mut provider = Provider::ollama("claude-test");
        provider.kind = ProviderKind::Anthropic;
        let anthropic = request_body(&provider, &messages).expect("body");
        assert_eq!(anthropic["system"], "Be brief.");
        assert_eq!(anthropic["stream"], true);
        assert!(anthropic.get("stream_options").is_none());
        assert!(anthropic["max_tokens"].as_u64().is_some_and(|n| n > 0));
        assert_eq!(anthropic["messages"].as_array().map(Vec::len), Some(3));
        assert_eq!(anthropic["messages"][0]["role"], "user");

        let only_system = [ChatMessage::new(Role::System, "x")];
        assert!(matches!(
            request_body(&provider, &only_system),
            Err(AiError::InvalidRequest(_))
        ));
    }

    #[test]
    fn error_texts_are_readable_and_bounded() {
        assert_eq!(
            body_reason(br#"{"error":{"message":"Bad key","type":"auth"}}"#),
            "Bad key"
        );
        assert_eq!(body_reason(br#"{"error":"plain text"}"#), "plain text");
        assert_eq!(
            body_reason(br#"{"message":"from message"}"#),
            "from message"
        );
        assert_eq!(body_reason(b"  Not\n Found\t"), "Not Found");
        assert_eq!(body_reason(b""), "");
        assert!(body_reason(&vec![b'x'; 5000]).chars().count() <= MAX_REASON_CHARS + 3);
        let shown = AiError::Auth {
            status: 401,
            message: "Bad key".to_string(),
        }
        .to_string();
        assert_eq!(
            shown,
            "the provider rejected the API key (HTTP 401): Bad key"
        );
        assert_eq!(
            AiError::Timeout.to_string(),
            "the provider did not answer in time"
        );
    }

    #[test]
    fn the_key_is_taken_out_of_every_text() {
        let key = "sk-live-SECRET";
        let errors = [
            AiError::Auth {
                status: 401,
                message: format!("bad key {key}"),
            },
            AiError::Http {
                status: 500,
                message: key.to_string(),
            },
            AiError::Network(format!("x {key} y")),
            AiError::Provider(format!("{key}{key}")),
            AiError::Protocol(key.to_string()),
            AiError::InvalidRequest(key.to_string()),
        ];
        for error in errors {
            let clean = error.without_key(key);
            assert!(!format!("{clean} {clean:?}").contains(key), "{clean:?}");
        }
        assert_eq!(AiError::Timeout.without_key(key), AiError::Timeout);
    }

    // ---- a fake provider on a local port ----------------------------------------------------

    #[derive(Clone)]
    struct Recorded {
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

    type Handler = Arc<dyn Fn(&Recorded, &mut TcpStream, &Signals) + Send + Sync>;

    /// What the handlers of a server share with the test.
    struct Signals {
        stop: AtomicBool,
        /// Set when a handler saw the client close the connection while it waited.
        client_closed: AtomicBool,
    }

    struct TestServer {
        url: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
        signals: Arc<Signals>,
    }

    impl TestServer {
        /// A server on `127.0.0.1` at a port the system picks.
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
            let log = self.requests.lock().expect("log");
            let r = &log[index];
            Recorded {
                request_line: r.request_line.clone(),
                headers: r.headers.clone(),
                body: r.body.clone(),
            }
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

    fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
    }

    fn start_event_stream(stream: &mut TcpStream) {
        let head =
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.flush();
    }

    /// Sends `body` in pieces cut at `at` (byte offsets), with a pause between them so each
    /// goes out on its own.
    fn send_in_pieces(stream: &mut TcpStream, body: &str, at: &[usize]) {
        let mut from = 0;
        for end in at.iter().copied().chain([body.len()]) {
            let _ = stream.write_all(&body.as_bytes()[from..end]);
            let _ = stream.flush();
            std::thread::sleep(Duration::from_millis(15));
            from = end;
        }
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

    fn provider_at(server: &TestServer, kind: ProviderKind) -> Provider {
        Provider {
            id: "fake".to_string(),
            kind,
            base_url: match kind {
                ProviderKind::OpenAiCompatible => format!("{}/v1", server.url),
                ProviderKind::Anthropic => server.url.clone(),
            },
            model: "fake-model".to_string(),
        }
    }

    fn question() -> Vec<ChatMessage> {
        vec![
            ChatMessage::new(Role::System, "Be brief."),
            ChatMessage::new(Role::User, "hi"),
        ]
    }

    fn client(timeout_ms: u64) -> AiClient {
        AiClient::new(Duration::from_millis(timeout_ms)).expect("client")
    }

    async fn run(
        client: &AiClient,
        provider: &Provider,
        key: Option<&str>,
        cancel: &CancellationToken,
    ) -> (Result<(), AiError>, Vec<StreamEvent>) {
        let mut events = Vec::new();
        let result = client
            .chat_stream(provider, key, &question(), cancel, |e| events.push(e))
            .await;
        (result, events)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn openai_compatible_streams_deltas_with_bearer_auth() {
        let body = openai_stream();
        let server = TestServer::start(move |_, stream, _| {
            start_event_stream(stream);
            // Cuts inside a line, inside the JSON and inside the second `\n` of a blank line.
            send_in_pieces(
                stream,
                &body,
                &[10, 90, 185, body.len() - 9, body.len() - 1],
            );
        });
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let (result, events) = run(
            &client(3000),
            &provider,
            Some("sk-test-123"),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(result, Ok(()));
        let (text, ends) = deltas_and_end(&events);
        assert_eq!(text, "Hello w\u{f6}rld \u{1F600}");
        assert_eq!(
            ends,
            vec![StreamEvent::Done {
                output_tokens: None
            }]
        );

        let request = server.request(0);
        assert_eq!(request.request_line, "POST /v1/chat/completions HTTP/1.1");
        assert_eq!(request.header("authorization"), Some("Bearer sk-test-123"));
        assert_eq!(request.header("x-api-key"), None);
        let sent: Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(sent["model"], "fake-model");
        assert_eq!(sent["stream"], true);
        assert_eq!(sent["messages"][1]["content"], "hi");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_provider_without_a_key_sends_no_authorization() {
        let body = openai_stream();
        let server = TestServer::start(move |_, stream, _| {
            start_event_stream(stream);
            send_in_pieces(stream, &body, &[]);
        });
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let (result, _) = run(&client(3000), &provider, None, &CancellationToken::new()).await;
        assert_eq!(result, Ok(()));
        assert_eq!(server.request(0).header("authorization"), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn openai_compatible_asks_for_the_usage_and_delivers_the_count() {
        let body = openai_stream_with_usage("{\"completion_tokens\":21}");
        let server = TestServer::start(move |_, stream, _| {
            start_event_stream(stream);
            // Cuts inside the chunk that has the count.
            send_in_pieces(stream, &body, &[40, body.len() - 40, body.len() - 14]);
        });
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let (result, events) = run(&client(3000), &provider, None, &CancellationToken::new()).await;
        assert_eq!(result, Ok(()));
        let (text, ends) = deltas_and_end(&events);
        assert_eq!(text, "Hello");
        assert_eq!(
            ends,
            vec![StreamEvent::Done {
                output_tokens: Some(21)
            }]
        );
        let sent: Value = serde_json::from_str(&server.request(0).body).expect("json body");
        assert_eq!(sent["stream_options"]["include_usage"], true);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn anthropic_delivers_the_count_and_sends_no_stream_options() {
        let body = anthropic_stream().replace(
            "\"delta\":{\"stop_reason\":\"end_turn\"}}",
            "\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":8}}",
        );
        let server = TestServer::start(move |_, stream, _| {
            start_event_stream(stream);
            send_in_pieces(stream, &body, &[]);
        });
        let provider = provider_at(&server, ProviderKind::Anthropic);
        let key = Some("sk-ant-test");
        let (result, events) = run(&client(3000), &provider, key, &CancellationToken::new()).await;
        assert_eq!(result, Ok(()));
        assert_eq!(
            events.last(),
            Some(&StreamEvent::Done {
                output_tokens: Some(8)
            })
        );
        let sent: Value = serde_json::from_str(&server.request(0).body).expect("json body");
        assert!(sent.get("stream_options").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn anthropic_streams_deltas_with_key_and_version_headers() {
        let body = anthropic_stream();
        let server = TestServer::start(move |_, stream, _| {
            start_event_stream(stream);
            send_in_pieces(stream, &body, &[7, 120, 400, body.len() - 3]);
        });
        let provider = provider_at(&server, ProviderKind::Anthropic);
        let (result, events) = run(
            &client(3000),
            &provider,
            Some("sk-ant-test"),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(result, Ok(()));
        let (text, ends) = deltas_and_end(&events);
        assert_eq!(text, "Hello w\u{f6}rld \u{1F600}");
        assert_eq!(
            ends,
            vec![StreamEvent::Done {
                output_tokens: None
            }]
        );

        let request = server.request(0);
        assert_eq!(request.request_line, "POST /v1/messages HTTP/1.1");
        assert_eq!(request.header("x-api-key"), Some("sk-ant-test"));
        assert_eq!(request.header("anthropic-version"), Some(ANTHROPIC_VERSION));
        assert_eq!(request.header("authorization"), None);
        let sent: Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(sent["system"], "Be brief.");
        assert_eq!(sent["messages"].as_array().map(Vec::len), Some(1));
        assert_eq!(sent["stream"], true);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn anthropic_without_a_key_is_refused_before_any_request() {
        let server = TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/plain", ""));
        let provider = provider_at(&server, ProviderKind::Anthropic);
        let (result, events) = run(&client(1000), &provider, None, &CancellationToken::new()).await;
        assert!(matches!(result, Err(AiError::InvalidRequest(_))));
        assert_eq!(events.len(), 1);
        assert_eq!(server.request_count(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_error_inside_the_stream_ends_it_with_the_reason() {
        let server = TestServer::start(|_, stream, _| {
            start_event_stream(stream);
            send_in_pieces(
                stream,
                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Par\"}}\n\n\
                 event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
                &[],
            );
        });
        let provider = provider_at(&server, ProviderKind::Anthropic);
        let (result, events) = run(
            &client(3000),
            &provider,
            Some("k"),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(result, Err(AiError::Provider("Overloaded".to_string())));
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta("Par".to_string()),
                StreamEvent::Error(AiError::Provider("Overloaded".to_string())),
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_401_gives_a_readable_reason_without_the_key() {
        let key = "sk-test-SECRET-123456";
        for kind in [ProviderKind::OpenAiCompatible, ProviderKind::Anthropic] {
            let body = format!(
                "{{\"error\":{{\"message\":\"Incorrect API key provided: {key}. Check it in your account.\",\"type\":\"invalid_request_error\"}}}}"
            );
            let server = TestServer::start(move |_, stream, _| {
                respond(stream, "401 Unauthorized", "application/json", &body);
            });
            let provider = provider_at(&server, kind);
            let (result, events) = run(
                &client(3000),
                &provider,
                Some(key),
                &CancellationToken::new(),
            )
            .await;
            let error = result.expect_err("401 is an error");
            assert!(
                matches!(error, AiError::Auth { status: 401, .. }),
                "{error:?}"
            );
            let shown = error.to_string();
            assert!(shown.contains("HTTP 401"), "{shown}");
            assert!(shown.contains("Incorrect API key provided"), "{shown}");
            assert!(!shown.contains(key), "the text leaks the key: {shown}");
            assert_eq!(events, vec![StreamEvent::Error(error.clone())]);
            assert!(!format!("{events:?}").contains(key), "{events:?}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn other_statuses_are_http_errors_and_a_redirect_is_not_followed() {
        let server = TestServer::start(|request, stream, _| {
            if request.request_line.contains("/v1/chat/completions") {
                respond(stream, "429 Too Many Requests", "text/plain", "slow down");
            } else {
                respond(stream, "200 OK", "text/plain", "");
            }
        });
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let (result, _) = run(
            &client(3000),
            &provider,
            Some("k"),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(
            result,
            Err(AiError::Http {
                status: 429,
                message: "slow down".to_string()
            })
        );

        let target = TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/plain", ""));
        let location = format!("{}/stolen", target.url);
        let redirecting = TestServer::start(move |_, stream, _| {
            let head = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes());
        });
        let provider = provider_at(&redirecting, ProviderKind::Anthropic);
        let (result, _) = run(
            &client(3000),
            &provider,
            Some("sk-ant-test"),
            &CancellationToken::new(),
        )
        .await;
        assert!(
            matches!(result, Err(AiError::Http { status: 307, .. })),
            "{result:?}"
        );
        assert_eq!(
            target.request_count(),
            0,
            "the key must not follow a redirect"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn silence_before_the_answer_times_out() {
        let server = TestServer::start(|_, stream, signals| stall(stream, signals));
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let started = Instant::now();
        let (result, events) = run(&client(250), &provider, None, &CancellationToken::new()).await;
        assert_eq!(result, Err(AiError::Timeout));
        assert_eq!(events, vec![StreamEvent::Error(AiError::Timeout)]);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn silence_in_the_middle_of_the_stream_times_out_after_the_deltas() {
        let server = TestServer::start(|_, stream, signals| {
            start_event_stream(stream);
            send_in_pieces(
                stream,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
                &[],
            );
            stall(stream, signals);
        });
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let (result, events) = run(&client(300), &provider, None, &CancellationToken::new()).await;
        assert_eq!(result, Err(AiError::Timeout));
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta("Hel".to_string()),
                StreamEvent::Error(AiError::Timeout)
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_in_the_middle_of_the_stream_stops_it_and_closes_the_connection() {
        let server = TestServer::start(|_, stream, signals| {
            start_event_stream(stream);
            send_in_pieces(
                stream,
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
                &[],
            );
            stall(stream, signals);
        });
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let cancel = CancellationToken::new();
        let mut events = Vec::new();
        let started = Instant::now();
        // The timeout is long: only the cancellation can end this in time.
        let result = client(30_000)
            .chat_stream(&provider, None, &question(), &cancel, |event| {
                if matches!(event, StreamEvent::Delta(_)) {
                    cancel.cancel();
                }
                events.push(event);
            })
            .await;
        assert_eq!(result, Err(AiError::Cancelled));
        assert_eq!(
            events,
            vec![
                StreamEvent::Delta("Hel".to_string()),
                StreamEvent::Error(AiError::Cancelled)
            ]
        );
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            server.wait_for_client_close().await,
            "the connection stayed open"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_from_another_thread_wakes_a_wait_for_the_answer() {
        let server = TestServer::start(|_, stream, signals| stall(stream, signals));
        let provider = provider_at(&server, ProviderKind::Anthropic);
        let cancel = CancellationToken::new();
        let other = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            other.cancel();
        });
        let started = Instant::now();
        let (result, _) = run(&client(30_000), &provider, Some("k"), &cancel).await;
        assert_eq!(result, Err(AiError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(server.wait_for_client_close().await);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_already_cancelled_request_sends_nothing_useful() {
        let server = TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/plain", ""));
        let provider = provider_at(&server, ProviderKind::OpenAiCompatible);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (result, events) = run(&client(1000), &provider, None, &cancel).await;
        assert_eq!(result, Err(AiError::Cancelled));
        assert_eq!(events, vec![StreamEvent::Error(AiError::Cancelled)]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_closed_port_is_a_network_error_with_a_reason() {
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let provider = Provider {
            id: "gone".to_string(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: format!("http://127.0.0.1:{port}/v1"),
            model: "m".to_string(),
        };
        // A refused connection takes about 2 s to be reported on Windows: the timeout is longer.
        let (result, _) = run(
            &client(8000),
            &provider,
            Some("k"),
            &CancellationToken::new(),
        )
        .await;
        match result {
            Err(AiError::Network(reason)) => assert!(!reason.is_empty()),
            other => panic!("expected a network error, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_provider_that_is_not_valid_is_refused() {
        let mut provider = Provider::ollama("m");
        provider.base_url = "file:///etc/passwd".to_string();
        let (result, _) = run(&client(500), &provider, None, &CancellationToken::new()).await;
        assert!(matches!(result, Err(AiError::InvalidRequest(_))));
        provider.base_url = "http://".to_string();
        let (result, _) = run(&client(500), &provider, None, &CancellationToken::new()).await;
        assert!(matches!(result, Err(AiError::InvalidRequest(_))));
        provider.base_url = "http://localhost:1/v1".to_string();
        provider.model = " ".to_string();
        let (result, _) = run(&client(500), &provider, None, &CancellationToken::new()).await;
        assert!(matches!(result, Err(AiError::InvalidRequest(_))));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ollama_is_found_with_its_models() {
        let server = TestServer::start(|request, stream, _| {
            if request.request_line.starts_with("GET /api/tags ") {
                respond(
                    stream,
                    "200 OK",
                    "application/json",
                    r#"{"models":[{"name":"llama3:latest","size":1},{"name":"qwen2.5-coder:7b"}]}"#,
                );
            } else {
                respond(stream, "404 Not Found", "text/plain", "");
            }
        });
        // The address of the provider (with `/v1`) and the root both work.
        for base in [format!("{}/v1", server.url), server.url.clone()] {
            assert_eq!(
                client(2000).detect_ollama(&base).await,
                OllamaProbe::Found(vec![
                    "llama3:latest".to_string(),
                    "qwen2.5-coder:7b".to_string()
                ])
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ollama_with_no_model_is_found_and_empty() {
        let server = TestServer::start(|_, stream, _| {
            respond(stream, "200 OK", "application/json", r#"{"models":[]}"#);
        });
        assert_eq!(
            client(2000).detect_ollama(&server.url).await,
            OllamaProbe::Found(Vec::new())
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ollama_absent_is_not_found_without_an_error() {
        // Nothing listens: the port was just released.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        assert_eq!(
            client(1000)
                .detect_ollama(&format!("http://127.0.0.1:{port}"))
                .await,
            OllamaProbe::NotFound
        );
        // Something else answers: not Ollama.
        let other =
            TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/html", "<html>"));
        assert_eq!(
            client(1000).detect_ollama(&other.url).await,
            OllamaProbe::NotFound
        );
        let other =
            TestServer::start(|_, stream, _| respond(stream, "404 Not Found", "text/plain", ""));
        assert_eq!(
            client(1000).detect_ollama(&other.url).await,
            OllamaProbe::NotFound
        );
        // An answer that never comes.
        let silent = TestServer::start(|_, stream, signals| stall(stream, signals));
        let started = Instant::now();
        assert_eq!(
            client(250).detect_ollama(&silent.url).await,
            OllamaProbe::NotFound
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        // Not an address at all.
        assert_eq!(
            client(250).detect_ollama("localhost:11434").await,
            OllamaProbe::NotFound
        );
    }

    const PS_BODY: &str = r#"{"models":[
        {"name":"llama3:latest","model":"llama3:latest","size":5137025024,"size_vram":4000000000},
        {"name":"qwen2.5-coder:7b","model":"qwen2.5-coder:7b","size":4683087332,"size_vram":0}
    ]}"#;

    /// An Ollama whose `/api/ps` answers `body` with `status`; any other path is a 404.
    fn ollama_ps(status: &'static str, body: &'static str) -> TestServer {
        TestServer::start(move |request, stream, _| {
            if request.request_line.starts_with("GET /api/ps ") {
                respond(stream, status, "application/json", body);
            } else {
                respond(stream, "404 Not Found", "text/plain", "");
            }
        })
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_memory_of_a_loaded_model_is_found_by_its_name() {
        let server = ollama_ps("200 OK", PS_BODY);
        // The address of the provider (with `/v1`) and the root both work.
        for base in [format!("{}/v1", server.url), server.url.clone()] {
            assert_eq!(
                client(2000).ollama_memory(&base, "qwen2.5-coder:7b").await,
                Some(OllamaMemory {
                    bytes: 4_683_087_332,
                    vram_bytes: 0
                })
            );
            // A model with no tag is the `latest` one, and the other way round.
            let llama = Some(OllamaMemory {
                bytes: 5_137_025_024,
                vram_bytes: 4_000_000_000,
            });
            assert_eq!(client(2000).ollama_memory(&base, "llama3").await, llama);
            assert_eq!(
                client(2000).ollama_memory(&base, "llama3:latest").await,
                llama
            );
        }
        assert_eq!(server.request(0).request_line, "GET /api/ps HTTP/1.1");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_memory_is_found_by_the_model_field_and_by_a_name_with_no_tag() {
        // Only `model` names the first, and the name of the second has no tag.
        let server = ollama_ps(
            "200 OK",
            r#"{"models":[{"model":"phi3:latest","size":10,"size_vram":4},{"name":"gemma2","size":7,"size_vram":7}]}"#,
        );
        let ask = |model: &'static str| {
            let url = server.url.clone();
            async move { client(2000).ollama_memory(&url, model).await }
        };
        assert_eq!(
            ask("phi3").await,
            Some(OllamaMemory {
                bytes: 10,
                vram_bytes: 4
            })
        );
        assert_eq!(
            ask("gemma2:latest").await,
            Some(OllamaMemory {
                bytes: 7,
                vram_bytes: 7
            })
        );
        // A different tag is a different model.
        assert_eq!(ask("phi3:mini").await, None);
        assert_eq!(ask("gemma2:2b").await, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_model_that_is_not_loaded_has_no_memory() {
        let server = ollama_ps("200 OK", PS_BODY);
        for model in [
            "mistral",
            "llama3:8b",
            "llama",
            "coder:7b",
            "",
            "  ",
            ":latest",
        ] {
            assert_eq!(
                client(2000).ollama_memory(&server.url, model).await,
                None,
                "{model:?}"
            );
        }
        let empty = ollama_ps("200 OK", r#"{"models":[]}"#);
        assert_eq!(client(2000).ollama_memory(&empty.url, "llama3").await, None);
    }

    #[test]
    fn a_number_that_is_not_a_whole_number_of_zero_or_more_is_no_memory() {
        let valid = r#"{"name":"m:latest","size":100,"size_vram":50}"#;
        let bad = [
            r#"{"name":"m:latest","size":-1,"size_vram":50}"#,
            r#"{"name":"m:latest","size":100,"size_vram":-5}"#,
            r#"{"name":"m:latest","size":100.5,"size_vram":50}"#,
            r#"{"name":"m:latest","size":100,"size_vram":0.5}"#,
            r#"{"name":"m:latest","size":"100","size_vram":50}"#,
            r#"{"name":"m:latest","size":100,"size_vram":"lots"}"#,
            r#"{"name":"m:latest","size":null,"size_vram":50}"#,
            r#"{"name":"m:latest","size":100}"#,
            r#"{"name":"m:latest","size_vram":50}"#,
            r#"{"name":"m:latest","size":1e3,"size_vram":50}"#,
            r#"{"name":"m:latest","size":100,"size_vram":9007199254740992}"#,
            r#"{"name":"m:latest","size":18446744073709551616,"size_vram":50}"#,
        ];
        assert_eq!(
            memory_of(format!(r#"{{"models":[{valid}]}}"#).as_bytes(), "m"),
            Some(OllamaMemory {
                bytes: 100,
                vram_bytes: 50
            })
        );
        for entry in bad {
            let body = format!(r#"{{"models":[{entry}]}}"#);
            assert_eq!(memory_of(body.as_bytes(), "m"), None, "{entry}");
        }
        // The largest number a page holds exactly is accepted.
        assert_eq!(
            memory_of(
                br#"{"models":[{"name":"m","size":9007199254740991,"size_vram":0}]}"#,
                "m"
            ),
            Some(OllamaMemory {
                bytes: 9_007_199_254_740_991,
                vram_bytes: 0
            })
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_numbers_over_http_are_no_memory_and_the_valid_ones_stay() {
        let server = ollama_ps(
            "200 OK",
            r#"{"models":[{"name":"bad:latest","size":-3,"size_vram":1},{"name":"good:latest","size":9,"size_vram":2}]}"#,
        );
        assert_eq!(client(2000).ollama_memory(&server.url, "bad").await, None);
        assert_eq!(
            client(2000).ollama_memory(&server.url, "good").await,
            Some(OllamaMemory {
                bytes: 9,
                vram_bytes: 2
            })
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn memory_is_none_when_ollama_fails_or_is_not_ollama() {
        let ask = |server: &TestServer| {
            let url = server.url.clone();
            async move { client(1000).ollama_memory(&url, "llama3").await }
        };
        // A status that is not a success, with a good body.
        let failed = ollama_ps("500 Internal Server Error", PS_BODY);
        assert_eq!(ask(&failed).await, None);
        let missing = ollama_ps("404 Not Found", PS_BODY);
        assert_eq!(ask(&missing).await, None);
        // Not what Ollama sends.
        for body in [
            "<html>hello</html>",
            "",
            "[]",
            r#"{"models":"llama3"}"#,
            r#"{"data":[]}"#,
            r#"{"models":[1,"llama3",null]}"#,
        ] {
            assert_eq!(ask(&ollama_ps("200 OK", body)).await, None, "{body:?}");
        }
        // A server that answers every path with a page, as one that is not Ollama would.
        let other =
            TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/html", "<html>"));
        assert_eq!(ask(&other).await, None);
        // Nothing listens: the port was just released.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        assert_eq!(
            client(1000)
                .ollama_memory(&format!("http://127.0.0.1:{port}"), "llama3")
                .await,
            None
        );
        // An answer that never comes ends at the short timeout.
        let silent = TestServer::start(|_, stream, signals| stall(stream, signals));
        let started = Instant::now();
        assert_eq!(client(250).ollama_memory(&silent.url, "llama3").await, None);
        assert!(started.elapsed() < Duration::from_secs(3));
        // Not an address at all.
        assert_eq!(
            client(250).ollama_memory("localhost:11434", "llama3").await,
            None
        );
    }

    #[test]
    fn a_default_tag_is_added_only_after_the_last_slash() {
        assert_eq!(with_default_tag("llama3"), "llama3:latest");
        assert_eq!(with_default_tag(" llama3:8b "), "llama3:8b");
        assert_eq!(
            with_default_tag("localhost:5000/team/llama3"),
            "localhost:5000/team/llama3:latest"
        );
        assert_eq!(
            with_default_tag("localhost:5000/team/llama3:8b"),
            "localhost:5000/team/llama3:8b"
        );
    }

    // ---- the connection test ----------------------------------------------------------------

    #[test]
    fn models_url_follows_the_kind_and_the_base() {
        let mut provider = Provider::ollama("");
        assert_eq!(provider.models_url(), "http://localhost:11434/v1/models");
        provider.base_url = "https://api.example.com/v1/".to_string();
        assert_eq!(provider.models_url(), "https://api.example.com/v1/models");
        provider.kind = ProviderKind::Anthropic;
        assert_eq!(provider.models_url(), "https://api.example.com/v1/models");
        provider.base_url = "https://api.anthropic.com".to_string();
        assert_eq!(provider.models_url(), "https://api.anthropic.com/v1/models");
    }

    #[test]
    fn only_http_and_https_addresses_with_a_host_and_no_secret_are_accepted() {
        for good in [
            "http://localhost:11434/v1",
            "https://api.openai.com/v1",
            " https://api.anthropic.com ",
            "http://127.0.0.1:8080",
            "http://[::1]:11434/v1",
            "https://openrouter.ai/api/v1?x=1#y",
        ] {
            assert!(is_http_address(good), "{good:?}");
        }
        for bad in [
            "",
            "   ",
            "localhost:11434",
            "ftp://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://",
            "https:///path",
            "http://user:pass@example.com/v1",
            "https://token@example.com",
            "http://exa mple.com",
            "http://example.com/\nx",
            "HTTP://example.com",
        ] {
            assert!(!is_http_address(bad), "{bad:?}");
        }
    }

    /// A provider whose model is blank: the connection test does not need one.
    fn no_model(server: &TestServer, kind: ProviderKind) -> Provider {
        Provider {
            model: String::new(),
            ..provider_at(server, kind)
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_connection_test_reads_the_models_with_the_key_in_the_header_of_each_kind() {
        let server = TestServer::start(|_, stream, _| {
            respond(stream, "200 OK", "application/json", r#"{"data":[]}"#);
        });
        let openai = no_model(&server, ProviderKind::OpenAiCompatible);
        assert_eq!(
            client(3000)
                .check_connection(&openai, Some("sk-open"))
                .await,
            Ok(())
        );
        let request = server.request(0);
        assert_eq!(request.request_line, "GET /v1/models HTTP/1.1");
        assert_eq!(request.header("authorization"), Some("Bearer sk-open"));
        assert_eq!(request.header("x-api-key"), None);
        assert_eq!(request.body, "");

        let anthropic = no_model(&server, ProviderKind::Anthropic);
        assert_eq!(
            client(3000)
                .check_connection(&anthropic, Some(" sk-ant "))
                .await,
            Ok(())
        );
        let request = server.request(1);
        assert_eq!(request.request_line, "GET /v1/models HTTP/1.1");
        assert_eq!(request.header("x-api-key"), Some("sk-ant"));
        assert!(request.header("anthropic-version").is_some());
        assert_eq!(request.header("authorization"), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_provider_that_needs_no_key_is_tested_without_a_header() {
        let server = TestServer::start(|_, stream, _| {
            respond(stream, "200 OK", "application/json", r#"{"data":[]}"#);
        });
        let provider = no_model(&server, ProviderKind::OpenAiCompatible);
        for key in [None, Some(""), Some("  ")] {
            assert_eq!(client(3000).check_connection(&provider, key).await, Ok(()));
        }
        assert_eq!(server.request_count(), 3);
        for index in 0..3 {
            assert_eq!(server.request(index).header("authorization"), None);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_connection_test_of_anthropic_without_a_key_is_refused_before_any_request() {
        let server = TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/plain", ""));
        let provider = no_model(&server, ProviderKind::Anthropic);
        for key in [None, Some(" ")] {
            let error = client(3000)
                .check_connection(&provider, key)
                .await
                .expect_err("no key");
            assert!(matches!(error, AiError::InvalidRequest(_)), "{error:?}");
            assert!(error.to_string().contains("API key"), "{error}");
        }
        assert_eq!(server.request_count(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_rejected_key_in_the_connection_test_is_readable_and_the_text_hides_the_key() {
        let key = "sk-test-SECRET-123456";
        for kind in [ProviderKind::OpenAiCompatible, ProviderKind::Anthropic] {
            let body = format!(
                "{{\"error\":{{\"message\":\"Incorrect API key provided: {key}. Check it in your account.\"}}}}"
            );
            let server = TestServer::start(move |_, stream, _| {
                respond(stream, "401 Unauthorized", "application/json", &body);
            });
            let provider = no_model(&server, kind);
            let error = client(3000)
                .check_connection(&provider, Some(key))
                .await
                .expect_err("401 is an error");
            assert!(
                matches!(error, AiError::Auth { status: 401, .. }),
                "{error:?}"
            );
            let shown = error.to_string();
            assert!(shown.contains("rejected the API key"), "{shown}");
            assert!(shown.contains("Incorrect API key provided"), "{shown}");
            assert!(shown.contains("[key]"), "{shown}");
            assert!(!shown.contains(key), "the text leaks the key: {shown}");
            assert!(!format!("{error:?}").contains(key), "{error:?}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn other_answers_to_the_connection_test_are_errors_and_a_redirect_is_not_followed() {
        let server = TestServer::start(|_, stream, _| {
            respond(stream, "404 Not Found", "text/plain", "no such page");
        });
        let provider = no_model(&server, ProviderKind::OpenAiCompatible);
        assert_eq!(
            client(3000).check_connection(&provider, None).await,
            Err(AiError::Http {
                status: 404,
                message: "no such page".to_string()
            })
        );

        let target = TestServer::start(|_, stream, _| respond(stream, "200 OK", "text/plain", ""));
        let location = format!("{}/stolen", target.url);
        let redirecting = TestServer::start(move |_, stream, _| {
            let head = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(head.as_bytes());
        });
        let provider = no_model(&redirecting, ProviderKind::Anthropic);
        let error = client(3000)
            .check_connection(&provider, Some("sk-ant"))
            .await
            .expect_err("a redirect is not a success");
        assert!(
            matches!(error, AiError::Http { status: 307, .. }),
            "{error:?}"
        );
        assert_eq!(target.request_count(), 0, "the key went to another host");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_connection_test_tells_unreachable_silent_and_invalid_providers_apart() {
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let gone = Provider {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            ..Provider::ollama("")
        };
        // A refused connection takes about 2 s to be reported on Windows: the timeout is longer.
        match client(8000).check_connection(&gone, None).await {
            Err(AiError::Network(reason)) => assert!(!reason.is_empty()),
            other => panic!("expected a network error, got {other:?}"),
        }

        let silent = TestServer::start(|_, stream, signals| stall(stream, signals));
        let provider = no_model(&silent, ProviderKind::OpenAiCompatible);
        let started = Instant::now();
        assert_eq!(
            client(250).check_connection(&provider, None).await,
            Err(AiError::Timeout)
        );
        assert!(started.elapsed() < Duration::from_secs(3));

        for address in ["file:///etc/passwd", "http://", "http://u:p@host/v1", ""] {
            let invalid = Provider {
                base_url: address.to_string(),
                ..Provider::ollama("")
            };
            let result = client(500).check_connection(&invalid, None).await;
            assert!(
                matches!(result, Err(AiError::InvalidRequest(_))),
                "{address:?}: {result:?}"
            );
        }
    }
}

//! The wire format of the local API (version 1): pure, no I/O.
//!
//! Every message is one frame of the daemon framing (a 4-byte big-endian length, then the
//! payload) whose payload is one JSON object in UTF-8. A frame over
//! [`MAX_FRAME_BYTES`](crate::daemon::protocol::MAX_FRAME_BYTES) is refused unread.
//!
//! ```text
//! client  {"type":"auth","version":1,"token":"<64 hex characters>"}      first message, always
//! server  {"type":"welcome","version":1}                                 or an error, then close
//! client  {"id":7,"method":"spaces.list","params":{}}                    any number, one at a time
//! server  {"id":7,"result":{...}}                                        or
//! server  {"id":7,"error":{"code":"invalid_params","message":"..."}}
//! ```
//!
//! A message that has an unknown field, a field of the wrong type or a value out of range is an
//! error and never a panic; the fields of a request are `id` (a whole number from 0 up), `method`
//! (one of [`ApiMethod`]) and `params` (an object, absent meaning `{}`).

use std::fmt;

use serde_json::{Map, Value, json};

use super::events::{EventFilter, EventKind};
use crate::daemon::protocol::{FRAME_HEADER_BYTES, MAX_FRAME_BYTES, ProtocolError};

/// The version of the conversation described above.
pub const API_PROTOCOL_VERSION: u32 = 1;
/// Longest first message the server accepts (an authentication is about a hundred bytes).
pub const MAX_AUTH_BYTES: usize = 1024;
/// Longest id of a space, an item, a split or a terminal, in characters.
pub const MAX_ID_CHARS: usize = 128;
/// Longest name of a space, in characters.
pub const MAX_NAME_CHARS: usize = 120;
/// Longest folder or profile text, in characters.
pub const MAX_PATH_CHARS: usize = 4096;
/// Longest text one `terminal.send` writes, in bytes.
pub const MAX_SEND_TEXT_BYTES: usize = 64 * 1024;
/// Most keys one `terminal.send` presses.
pub const MAX_SEND_KEYS: usize = 64;
/// Longest key name, in characters.
pub const MAX_KEY_CHARS: usize = 32;
/// Most lines one `terminal.read` asks for.
pub const MAX_READ_LINES: u32 = 10_000;
/// Longest title of a `notify`, in characters.
pub const MAX_NOTIFY_TITLE_CHARS: usize = 128;
/// Longest body of a `notify`, in characters.
pub const MAX_NOTIFY_BODY_CHARS: usize = 1024;
/// Most entries `types` of `events.subscribe` may hold (there are fewer kinds; this bounds the
/// work on a hostile list).
pub const MAX_EVENT_TYPES: usize = 16;

/// The methods a client may call. The list is closed: anything else is `unknown_method`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ApiMethod {
    SpacesList,
    SpacesCreate,
    ItemsCreate,
    SplitsCreate,
    TerminalSend,
    TerminalRead,
    Notify,
}

impl ApiMethod {
    pub const ALL: [ApiMethod; 7] = [
        Self::SpacesList,
        Self::SpacesCreate,
        Self::ItemsCreate,
        Self::SplitsCreate,
        Self::TerminalSend,
        Self::TerminalRead,
        Self::Notify,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::SpacesList => "spaces.list",
            Self::SpacesCreate => "spaces.create",
            Self::ItemsCreate => "items.create",
            Self::SplitsCreate => "splits.create",
            Self::TerminalSend => "terminal.send",
            Self::TerminalRead => "terminal.read",
            Self::Notify => "notify",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|method| method.name() == name)
    }
}

/// Which side of a split the new pane opens on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitDirection {
    Right,
    Down,
}

/// A request that passed validation: the method and its checked parameters. This is what an
/// [`ApiHandler`](super::ApiHandler) receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiCall {
    /// `spaces.list`: no parameters.
    SpacesList,
    /// `spaces.create`: `{ name }`.
    SpacesCreate { name: String },
    /// `items.create`: `{ space?, cwd?, profile? }`. Without a `space` the app picks it: the one a
    /// routing rule names for the tab, else the active one.
    ItemsCreate {
        space: Option<String>,
        cwd: Option<String>,
        profile: Option<String>,
    },
    /// `splits.create`: `{ item, direction: "right" | "down", cwd?, profile? }`.
    SplitsCreate {
        item: String,
        direction: SplitDirection,
        cwd: Option<String>,
        profile: Option<String>,
    },
    /// `terminal.send`: `{ terminal, text?, keys? }`, at least one of the two. The text goes to
    /// the terminal as typed (no line break is added); each key is a name such as `Enter`,
    /// `Ctrl+C` or `Up`.
    TerminalSend {
        terminal: String,
        text: Option<String>,
        keys: Vec<String>,
    },
    /// `terminal.read`: `{ terminal, lines? }`.
    TerminalRead {
        terminal: String,
        lines: Option<u32>,
    },
    /// `notify`: `{ title, body?, terminal? }`. Asks the app to show a notification of the system
    /// (when the user's settings allow it); `terminal` names the pane it is about.
    Notify {
        title: String,
        body: Option<String>,
        terminal: Option<String>,
    },
}

impl ApiCall {
    pub fn method(&self) -> ApiMethod {
        match self {
            Self::SpacesList => ApiMethod::SpacesList,
            Self::SpacesCreate { .. } => ApiMethod::SpacesCreate,
            Self::ItemsCreate { .. } => ApiMethod::ItemsCreate,
            Self::SplitsCreate { .. } => ApiMethod::SplitsCreate,
            Self::TerminalSend { .. } => ApiMethod::TerminalSend,
            Self::TerminalRead { .. } => ApiMethod::TerminalRead,
            Self::Notify { .. } => ApiMethod::Notify,
        }
    }
}

/// The reason of an error answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiErrorCode {
    /// The payload is not JSON (or not UTF-8).
    InvalidJson,
    /// JSON, but not a message: not an object, a missing or extra field, a bad `id`.
    InvalidRequest,
    /// The method is not one of [`ApiMethod`].
    UnknownMethod,
    /// The parameters do not fit the method.
    InvalidParams,
    /// The frame is longer than the limit; the connection is closed.
    FrameTooLarge,
    /// A request came before the authentication; the connection is closed.
    Unauthenticated,
    /// The token is wrong; the connection is closed.
    Unauthorized,
    /// The client speaks another version of the conversation; the connection is closed.
    UnsupportedVersion,
    /// The handler did not answer in time.
    Timeout,
    /// The server is stopping.
    ShuttingDown,
    /// Something broke on the server (a handler that panicked, an answer too big to send).
    Internal,
    /// For the handler: what the call names (a space, a terminal...) does not exist.
    NotFound,
    /// For the handler: the call was well formed and could not be done.
    Failed,
}

impl ApiErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidJson => "invalid_json",
            Self::InvalidRequest => "invalid_request",
            Self::UnknownMethod => "unknown_method",
            Self::InvalidParams => "invalid_params",
            Self::FrameTooLarge => "frame_too_large",
            Self::Unauthenticated => "unauthenticated",
            Self::Unauthorized => "unauthorized",
            Self::UnsupportedVersion => "unsupported_version",
            Self::Timeout => "timeout",
            Self::ShuttingDown => "shutting_down",
            Self::Internal => "internal",
            Self::NotFound => "not_found",
            Self::Failed => "failed",
        }
    }
}

/// An error answer: a code and a sentence for a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::NotFound, message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::Failed, message)
    }

    fn params(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::InvalidParams, message)
    }

    fn request(message: impl Into<String>) -> Self {
        Self::new(ApiErrorCode::InvalidRequest, message)
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ApiError {}

/// The first message of a connection, checked for its shape (not yet for its token).
#[derive(Debug, Clone)]
pub struct AuthMessage {
    pub version: u32,
    pub token: String,
}

/// Wraps a payload in a frame. Fails when it is longer than the frame limit.
pub fn to_frame(payload: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            len: payload.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// The payload of the `welcome` message.
pub fn welcome_payload() -> Vec<u8> {
    json!({ "type": "welcome", "version": API_PROTOCOL_VERSION })
        .to_string()
        .into_bytes()
}

/// The payload of an error that belongs to no request (a refused connection): `id` is null.
pub fn error_payload(id: Option<u64>, error: &ApiError) -> Vec<u8> {
    json!({
        "id": id,
        "error": { "code": error.code.as_str(), "message": error.message },
    })
    .to_string()
    .into_bytes()
}

/// The payload of a successful answer.
pub fn result_payload(id: u64, result: &Value) -> Vec<u8> {
    json!({ "id": id, "result": result })
        .to_string()
        .into_bytes()
}

fn parse_json_object(payload: &[u8]) -> Result<Map<String, Value>, ApiError> {
    let text = std::str::from_utf8(payload)
        .map_err(|_| ApiError::new(ApiErrorCode::InvalidJson, "the message is not UTF-8 text"))?;
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(ApiError::request("the message must be a JSON object")),
        Err(e) => Err(ApiError::new(
            ApiErrorCode::InvalidJson,
            format!("the message is not valid JSON: {e}"),
        )),
    }
}

/// Reads the first message of a connection. Anything but a well formed `auth` is an error, and
/// the caller closes the connection: a request here is `unauthenticated`.
pub fn parse_auth(payload: &[u8]) -> Result<AuthMessage, ApiError> {
    if payload.len() > MAX_AUTH_BYTES {
        return Err(ApiError::new(
            ApiErrorCode::Unauthenticated,
            "the first message must be an auth message",
        ));
    }
    let mut map = parse_json_object(payload)?;
    if map.contains_key("method") || map.contains_key("id") {
        return Err(ApiError::new(
            ApiErrorCode::Unauthenticated,
            "authenticate first: the first message must be {\"type\":\"auth\",\"version\":1,\"token\":...}",
        ));
    }
    let bad = |what: &str| ApiError::request(format!("bad auth message: {what}"));
    match map.remove("type") {
        Some(Value::String(kind)) if kind == "auth" => {}
        _ => return Err(bad("\"type\" must be \"auth\"")),
    }
    let version = match map.remove("version").as_ref().and_then(Value::as_u64) {
        Some(version) => u32::try_from(version).unwrap_or(u32::MAX),
        None => return Err(bad("\"version\" must be a whole number")),
    };
    let token = match map.remove("token") {
        Some(Value::String(token)) => token,
        _ => return Err(bad("\"token\" must be text")),
    };
    if let Some(extra) = map.keys().next() {
        return Err(bad(&format!("unknown field {}", shorten(extra))));
    }
    Ok(AuthMessage { version, token })
}

/// What a client may ask after the authentication: a call for the handler, or a subscription to
/// events, which the server answers itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientRequest {
    Call(ApiCall),
    Subscribe(EventFilter),
}

/// The name of the request that subscribes to events. It is not an [`ApiMethod`]: the handler
/// never sees it.
pub const SUBSCRIBE_METHOD: &str = "events.subscribe";

/// A request that failed: the id when it could be read, and the error.
type Failure = (Option<u64>, ApiError);

/// Reads the three fields every request has, and nothing else: `id`, `method` and `params`.
fn parse_envelope(payload: &[u8]) -> Result<(u64, String, Option<Value>), Failure> {
    let mut map = parse_json_object(payload).map_err(|e| (None, e))?;
    let id = map.get("id").and_then(Value::as_u64);
    let Some(id_value) = id else {
        return Err((
            None,
            ApiError::request("\"id\" must be a whole number from 0 up"),
        ));
    };
    let fail = |e: ApiError| (Some(id_value), e);
    map.remove("id");
    let method = match map.remove("method") {
        Some(Value::String(name)) => name,
        _ => return Err(fail(ApiError::request("\"method\" must be text"))),
    };
    let params = map.remove("params");
    if let Some(extra) = map.keys().next() {
        return Err(fail(ApiError::request(format!(
            "unknown field {}",
            shorten(extra)
        ))));
    }
    Ok((id_value, method, params))
}

fn unknown_method(method: &str) -> ApiError {
    ApiError::new(
        ApiErrorCode::UnknownMethod,
        format!("unknown method {}", shorten(method)),
    )
}

/// Reads a request for the handler. On an error the id is returned when it could be read, so the
/// answer can carry it. `events.subscribe` is not here: see [`parse_client_request`].
pub fn parse_request(payload: &[u8]) -> Result<(u64, ApiCall), (Option<u64>, ApiError)> {
    let (id, method, params) = parse_envelope(payload)?;
    let fail = |e: ApiError| (Some(id), e);
    let Some(method) = ApiMethod::from_name(&method) else {
        return Err(fail(unknown_method(&method)));
    };
    parse_call(method, params)
        .map(|call| (id, call))
        .map_err(fail)
}

/// Reads a request of an authenticated connection: a call of [`ApiMethod`] or `events.subscribe`.
pub fn parse_client_request(
    payload: &[u8],
) -> Result<(u64, ClientRequest), (Option<u64>, ApiError)> {
    let (id, method, params) = parse_envelope(payload)?;
    let fail = |e: ApiError| (Some(id), e);
    if method == SUBSCRIBE_METHOD {
        return parse_subscribe(params)
            .map(|filter| (id, ClientRequest::Subscribe(filter)))
            .map_err(fail);
    }
    let Some(method) = ApiMethod::from_name(&method) else {
        return Err(fail(unknown_method(&method)));
    };
    parse_call(method, params)
        .map(|call| (id, ClientRequest::Call(call)))
        .map_err(fail)
}

/// Checks the parameters of `events.subscribe`: `types` (a list of the kinds of event, each a
/// name of [`EventKind`], not empty; absent means all of them) and `sessionId` (text, not empty;
/// absent means every session). A repeated kind counts once.
pub fn parse_subscribe(params: Option<Value>) -> Result<EventFilter, ApiError> {
    let mut fields = Fields::new(params)?;
    let kinds = match fields.0.remove("types") {
        None | Some(Value::Null) => EventKind::ALL.to_vec(),
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return Err(ApiError::params("\"types\" must not be empty"));
            }
            if items.len() > MAX_EVENT_TYPES {
                return Err(ApiError::params(format!(
                    "\"types\" has more than {MAX_EVENT_TYPES} entries"
                )));
            }
            let mut kinds = Vec::new();
            for item in items {
                let kind = item
                    .as_str()
                    .and_then(EventKind::from_name)
                    .ok_or_else(|| {
                        let known: Vec<_> = EventKind::ALL.iter().map(|k| k.name()).collect();
                        ApiError::params(format!("\"types\" holds only {}", known.join(" or ")))
                    })?;
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
            kinds
        }
        Some(_) => return Err(ApiError::params("\"types\" must be a list")),
    };
    let session_id = fields.optional_text("sessionId", MAX_ID_CHARS, TextRule::Line)?;
    fields.finish()?;
    Ok(EventFilter { kinds, session_id })
}

/// Checks the parameters of `method`.
pub fn parse_call(method: ApiMethod, params: Option<Value>) -> Result<ApiCall, ApiError> {
    let mut fields = Fields::new(params)?;
    let call = match method {
        ApiMethod::SpacesList => ApiCall::SpacesList,
        ApiMethod::SpacesCreate => {
            let name = fields.required_text("name", MAX_NAME_CHARS, TextRule::Line)?;
            if name.trim().is_empty() {
                return Err(ApiError::params("\"name\" must not be blank"));
            }
            ApiCall::SpacesCreate { name }
        }
        ApiMethod::ItemsCreate => ApiCall::ItemsCreate {
            space: fields.optional_text("space", MAX_ID_CHARS, TextRule::Line)?,
            cwd: fields.optional_text("cwd", MAX_PATH_CHARS, TextRule::Line)?,
            profile: fields.optional_text("profile", MAX_ID_CHARS, TextRule::Line)?,
        },
        ApiMethod::SplitsCreate => {
            let item = fields.required_text("item", MAX_ID_CHARS, TextRule::Line)?;
            let direction = match fields
                .required_text("direction", 8, TextRule::Line)?
                .as_str()
            {
                "right" => SplitDirection::Right,
                "down" => SplitDirection::Down,
                _ => {
                    return Err(ApiError::params(
                        "\"direction\" must be \"right\" or \"down\"",
                    ));
                }
            };
            ApiCall::SplitsCreate {
                item,
                direction,
                cwd: fields.optional_text("cwd", MAX_PATH_CHARS, TextRule::Line)?,
                profile: fields.optional_text("profile", MAX_ID_CHARS, TextRule::Line)?,
            }
        }
        ApiMethod::TerminalSend => {
            let terminal = fields.required_text("terminal", MAX_ID_CHARS, TextRule::Line)?;
            let text = fields.optional_text("text", MAX_SEND_TEXT_BYTES, TextRule::Any)?;
            let keys = fields.key_list("keys")?;
            if text.as_deref().is_none_or(str::is_empty) && keys.is_empty() {
                return Err(ApiError::params("send \"text\", \"keys\" or both"));
            }
            ApiCall::TerminalSend {
                terminal,
                text,
                keys,
            }
        }
        ApiMethod::TerminalRead => ApiCall::TerminalRead {
            terminal: fields.required_text("terminal", MAX_ID_CHARS, TextRule::Line)?,
            lines: fields.optional_count("lines", 1, MAX_READ_LINES)?,
        },
        ApiMethod::Notify => {
            let title = fields.required_text("title", MAX_NOTIFY_TITLE_CHARS, TextRule::Line)?;
            if title.trim().is_empty() {
                return Err(ApiError::params("\"title\" must not be blank"));
            }
            ApiCall::Notify {
                title,
                body: fields.optional_text("body", MAX_NOTIFY_BODY_CHARS, TextRule::Line)?,
                terminal: fields.optional_text("terminal", MAX_ID_CHARS, TextRule::Line)?,
            }
        }
    };
    fields.finish()?;
    Ok(call)
}

/// Cuts a text the client sent before it goes back in a message.
fn shorten(text: &str) -> String {
    const LIMIT: usize = 40;
    let mut out: String = text
        .chars()
        .take(LIMIT)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect();
    if text.chars().count() > LIMIT {
        out.push_str("...");
    }
    format!("\"{out}\"")
}

#[derive(Clone, Copy)]
enum TextRule {
    /// One line: no control character.
    Line,
    /// Anything, line breaks and control characters included (what a terminal is typed).
    Any,
}

/// The parameters of a call, taken out one by one so `finish` can tell what is left over.
struct Fields(Map<String, Value>);

impl Fields {
    fn new(params: Option<Value>) -> Result<Self, ApiError> {
        match params {
            None | Some(Value::Null) => Ok(Self(Map::new())),
            Some(Value::Object(map)) => Ok(Self(map)),
            Some(_) => Err(ApiError::params("\"params\" must be an object")),
        }
    }

    /// For [`TextRule::Any`] the limit counts bytes; for [`TextRule::Line`] it counts characters.
    fn optional_text(
        &mut self,
        key: &str,
        max: usize,
        rule: TextRule,
    ) -> Result<Option<String>, ApiError> {
        let text = match self.0.remove(key) {
            None | Some(Value::Null) => return Ok(None),
            Some(Value::String(text)) => text,
            Some(_) => return Err(ApiError::params(format!("\"{key}\" must be text"))),
        };
        match rule {
            TextRule::Line => {
                if text.is_empty() {
                    return Err(ApiError::params(format!("\"{key}\" must not be empty")));
                }
                if text.chars().count() > max {
                    return Err(ApiError::params(format!(
                        "\"{key}\" is longer than {max} characters"
                    )));
                }
                if text.chars().any(char::is_control) {
                    return Err(ApiError::params(format!(
                        "\"{key}\" must not have control characters"
                    )));
                }
            }
            TextRule::Any => {
                if text.len() > max {
                    return Err(ApiError::params(format!(
                        "\"{key}\" is longer than {max} bytes"
                    )));
                }
            }
        }
        Ok(Some(text))
    }

    fn required_text(&mut self, key: &str, max: usize, rule: TextRule) -> Result<String, ApiError> {
        self.optional_text(key, max, rule)?
            .ok_or_else(|| ApiError::params(format!("\"{key}\" is required")))
    }

    fn optional_count(&mut self, key: &str, min: u32, max: u32) -> Result<Option<u32>, ApiError> {
        match self.0.remove(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => match value.as_u64().and_then(|n| u32::try_from(n).ok()) {
                Some(n) if (min..=max).contains(&n) => Ok(Some(n)),
                _ => Err(ApiError::params(format!(
                    "\"{key}\" must be a whole number from {min} to {max}"
                ))),
            },
        }
    }

    fn key_list(&mut self, key: &str) -> Result<Vec<String>, ApiError> {
        let items = match self.0.remove(key) {
            None | Some(Value::Null) => return Ok(Vec::new()),
            Some(Value::Array(items)) => items,
            Some(_) => return Err(ApiError::params(format!("\"{key}\" must be a list"))),
        };
        if items.len() > MAX_SEND_KEYS {
            return Err(ApiError::params(format!(
                "\"{key}\" has more than {MAX_SEND_KEYS} keys"
            )));
        }
        items
            .into_iter()
            .map(|item| match item {
                Value::String(name) if is_key_name(&name) => Ok(name),
                _ => Err(ApiError::params(format!(
                    "\"{key}\" holds key names of up to {MAX_KEY_CHARS} letters, digits, '+', '-' or '_'"
                ))),
            })
            .collect()
    }

    /// Whatever is left was not asked for.
    fn finish(self) -> Result<(), ApiError> {
        match self.0.keys().next() {
            Some(extra) => Err(ApiError::params(format!(
                "unknown parameter {}",
                shorten(extra)
            ))),
            None => Ok(()),
        }
    }
}

fn is_key_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_KEY_CHARS
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(text: &str) -> Result<(u64, ApiCall), (Option<u64>, ApiError)> {
        parse_request(text.as_bytes())
    }

    fn code_of(result: Result<(u64, ApiCall), (Option<u64>, ApiError)>) -> ApiErrorCode {
        result.expect_err("an error").1.code
    }

    #[test]
    fn every_method_name_round_trips_and_nothing_else_is_a_method() {
        for method in ApiMethod::ALL {
            assert_eq!(ApiMethod::from_name(method.name()), Some(method));
        }
        for name in ["", "spaces", "Spaces.List", "spaces.list ", "terminal.kill"] {
            assert_eq!(ApiMethod::from_name(name), None, "{name:?}");
        }
    }

    #[test]
    fn a_request_for_each_method_is_read() {
        let cases = [
            (r#"{"id":1,"method":"spaces.list"}"#, ApiCall::SpacesList),
            (
                r#"{"id":2,"method":"spaces.list","params":{}}"#,
                ApiCall::SpacesList,
            ),
            (
                r#"{"id":3,"method":"spaces.create","params":{"name":"Work"}}"#,
                ApiCall::SpacesCreate {
                    name: "Work".into(),
                },
            ),
            (
                r#"{"id":4,"method":"items.create","params":{"space":"s1","cwd":"/tmp"}}"#,
                ApiCall::ItemsCreate {
                    space: Some("s1".into()),
                    cwd: Some("/tmp".into()),
                    profile: None,
                },
            ),
            (
                r#"{"id":41,"method":"items.create","params":{"profile":"pwsh"}}"#,
                ApiCall::ItemsCreate {
                    space: None,
                    cwd: None,
                    profile: Some("pwsh".into()),
                },
            ),
            (
                r#"{"id":42,"method":"items.create"}"#,
                ApiCall::ItemsCreate {
                    space: None,
                    cwd: None,
                    profile: None,
                },
            ),
            (
                r#"{"id":43,"method":"items.create","params":{"space":null}}"#,
                ApiCall::ItemsCreate {
                    space: None,
                    cwd: None,
                    profile: None,
                },
            ),
            (
                r#"{"id":5,"method":"splits.create","params":{"item":"i1","direction":"down"}}"#,
                ApiCall::SplitsCreate {
                    item: "i1".into(),
                    direction: SplitDirection::Down,
                    cwd: None,
                    profile: None,
                },
            ),
            (
                r#"{"id":6,"method":"terminal.send","params":{"terminal":"t1","text":"ls\r","keys":["Ctrl+C","Enter"]}}"#,
                ApiCall::TerminalSend {
                    terminal: "t1".into(),
                    text: Some("ls\r".into()),
                    keys: vec!["Ctrl+C".into(), "Enter".into()],
                },
            ),
            (
                r#"{"id":7,"method":"terminal.read","params":{"terminal":"t1","lines":50}}"#,
                ApiCall::TerminalRead {
                    terminal: "t1".into(),
                    lines: Some(50),
                },
            ),
            (
                r#"{"id":8,"method":"notify","params":{"title":"Build done"}}"#,
                ApiCall::Notify {
                    title: "Build done".into(),
                    body: None,
                    terminal: None,
                },
            ),
            (
                r#"{"id":9,"method":"notify","params":{"title":"Build done","body":"all green","terminal":"p1"}}"#,
                ApiCall::Notify {
                    title: "Build done".into(),
                    body: Some("all green".into()),
                    terminal: Some("p1".into()),
                },
            ),
        ];
        for (text, expected) in cases {
            let (_, call) = request(text).unwrap_or_else(|e| panic!("{text}: {e:?}"));
            assert_eq!(call, expected, "{text}");
            assert_eq!(
                ApiMethod::from_name(call.method().name()),
                Some(call.method())
            );
        }
    }

    #[test]
    fn a_request_that_is_not_json_or_not_an_object_is_an_error() {
        for text in ["", "{", "not json", "nul", "{\"id\":1,}"] {
            assert_eq!(code_of(request(text)), ApiErrorCode::InvalidJson, "{text}");
        }
        for text in ["[]", "1", "\"x\"", "null", "true"] {
            assert_eq!(
                code_of(request(text)),
                ApiErrorCode::InvalidRequest,
                "{text}"
            );
        }
        assert_eq!(
            parse_request(&[0xff, 0xfe, b'{']).unwrap_err().1.code,
            ApiErrorCode::InvalidJson
        );
    }

    #[test]
    fn a_bad_id_or_method_or_an_extra_field_is_an_error_with_the_id_when_it_is_known() {
        for text in [
            r#"{"method":"spaces.list"}"#,
            r#"{"id":-1,"method":"spaces.list"}"#,
            r#"{"id":1.5,"method":"spaces.list"}"#,
            r#"{"id":"7","method":"spaces.list"}"#,
            r#"{"id":null,"method":"spaces.list"}"#,
        ] {
            let (id, e) = request(text).unwrap_err();
            assert_eq!((id, e.code), (None, ApiErrorCode::InvalidRequest), "{text}");
        }
        for text in [
            r#"{"id":9}"#,
            r#"{"id":9,"method":5}"#,
            r#"{"id":9,"method":"spaces.list","extra":1}"#,
        ] {
            let (id, e) = request(text).unwrap_err();
            assert_eq!(
                (id, e.code),
                (Some(9), ApiErrorCode::InvalidRequest),
                "{text}"
            );
        }
        let (id, e) = request(r#"{"id":9,"method":"files.delete"}"#).unwrap_err();
        assert_eq!((id, e.code), (Some(9), ApiErrorCode::UnknownMethod));
        assert!(e.message.contains("files.delete"));
    }

    #[test]
    fn params_that_do_not_fit_the_method_are_an_error() {
        let long_name = "x".repeat(MAX_NAME_CHARS + 1);
        let long_text = "x".repeat(MAX_SEND_TEXT_BYTES + 1);
        let many_keys = vec!["a"; MAX_SEND_KEYS + 1];
        let bad: Vec<(&str, Value)> = vec![
            ("spaces.list", json!({ "x": 1 })),
            ("spaces.list", json!([])),
            ("spaces.list", json!("x")),
            ("spaces.create", json!({})),
            ("spaces.create", json!({ "name": "" })),
            ("spaces.create", json!({ "name": "   " })),
            ("spaces.create", json!({ "name": 5 })),
            ("spaces.create", json!({ "name": "a\nb" })),
            ("spaces.create", json!({ "name": long_name })),
            ("spaces.create", json!({ "name": "ok", "color": "red" })),
            ("items.create", json!({ "space": "" })),
            (
                "items.create",
                json!({ "space": "a
b" }),
            ),
            ("items.create", json!({ "space": 7 })),
            ("items.create", json!({ "cwd": "" })),
            ("items.create", json!({ "space": "s", "cwd": "" })),
            ("items.create", json!({ "space": "s", "cwd": "a\0b" })),
            ("splits.create", json!({ "item": "i" })),
            ("splits.create", json!({ "item": "i", "direction": "left" })),
            ("splits.create", json!({ "item": "i", "direction": 1 })),
            ("terminal.send", json!({ "terminal": "t" })),
            ("terminal.send", json!({ "terminal": "t", "text": "" })),
            (
                "terminal.send",
                json!({ "terminal": "t", "text": long_text }),
            ),
            ("terminal.send", json!({ "terminal": "t", "keys": [] })),
            ("terminal.send", json!({ "terminal": "t", "keys": "Enter" })),
            ("terminal.send", json!({ "terminal": "t", "keys": [1] })),
            ("terminal.send", json!({ "terminal": "t", "keys": ["a b"] })),
            (
                "terminal.send",
                json!({ "terminal": "t", "keys": ["x".repeat(MAX_KEY_CHARS + 1)] }),
            ),
            (
                "terminal.send",
                json!({ "terminal": "t", "keys": many_keys }),
            ),
            ("terminal.read", json!({})),
            ("terminal.read", json!({ "terminal": "t", "lines": 0 })),
            (
                "terminal.read",
                json!({ "terminal": "t", "lines": MAX_READ_LINES + 1 }),
            ),
            ("terminal.read", json!({ "terminal": "t", "lines": -1 })),
            ("terminal.read", json!({ "terminal": "t", "lines": 1.5 })),
            ("terminal.read", json!({ "terminal": "t", "lines": "5" })),
            ("terminal.read", json!({ "terminal": "t", "to": 5 })),
            ("notify", json!({})),
            ("notify", json!({ "body": "no title" })),
            ("notify", json!({ "title": "" })),
            ("notify", json!({ "title": "   " })),
            ("notify", json!({ "title": 5 })),
            ("notify", json!({ "title": "a\nb" })),
            (
                "notify",
                json!({ "title": "x".repeat(MAX_NOTIFY_TITLE_CHARS + 1) }),
            ),
            ("notify", json!({ "title": "ok", "body": "" })),
            ("notify", json!({ "title": "ok", "body": 1 })),
            ("notify", json!({ "title": "ok", "body": "a\u{7}b" })),
            (
                "notify",
                json!({ "title": "ok", "body": "x".repeat(MAX_NOTIFY_BODY_CHARS + 1) }),
            ),
            ("notify", json!({ "title": "ok", "terminal": "" })),
            (
                "notify",
                json!({ "title": "ok", "terminal": "x".repeat(MAX_ID_CHARS + 1) }),
            ),
            ("notify", json!({ "title": "ok", "sound": true })),
            ("notify", json!(["ok"])),
        ];
        for (method, params) in bad {
            let text = json!({ "id": 1, "method": method, "params": params }).to_string();
            let (id, e) = request(&text).unwrap_err();
            assert_eq!(
                (id, e.code),
                (Some(1), ApiErrorCode::InvalidParams),
                "{method} {}",
                &text[..text.len().min(120)]
            );
        }
    }

    #[test]
    fn the_text_of_a_send_may_hold_line_breaks_and_the_limits_are_inclusive() {
        let text = "a\r\nb\u{1b}[A\t";
        let call = parse_call(
            ApiMethod::TerminalSend,
            Some(json!({ "terminal": "t", "text": text })),
        )
        .unwrap();
        assert!(matches!(call, ApiCall::TerminalSend { text: Some(t), .. } if t == text));
        let name = "x".repeat(MAX_NAME_CHARS);
        assert!(parse_call(ApiMethod::SpacesCreate, Some(json!({ "name": name }))).is_ok());
        let exact = "x".repeat(MAX_SEND_TEXT_BYTES);
        assert!(
            parse_call(
                ApiMethod::TerminalSend,
                Some(json!({ "terminal": "t", "text": exact }))
            )
            .is_ok()
        );
        assert!(
            parse_call(
                ApiMethod::TerminalRead,
                Some(json!({ "terminal": "t", "lines": MAX_READ_LINES }))
            )
            .is_ok()
        );
    }

    #[test]
    fn the_limits_of_a_notification_are_inclusive_and_count_characters() {
        // 128 and 1024 characters, each of two bytes: the limit is in characters, not bytes.
        let title = "\u{e9}".repeat(MAX_NOTIFY_TITLE_CHARS);
        let body = "\u{e9}".repeat(MAX_NOTIFY_BODY_CHARS);
        let call = parse_call(
            ApiMethod::Notify,
            Some(json!({ "title": title, "body": body, "terminal": "x".repeat(MAX_ID_CHARS) })),
        )
        .unwrap();
        assert!(matches!(
            call,
            ApiCall::Notify { title: t, body: Some(b), terminal: Some(_) }
                if t.chars().count() == MAX_NOTIFY_TITLE_CHARS
                    && b.chars().count() == MAX_NOTIFY_BODY_CHARS
        ));
        // A null stands for an absent optional field, as for every other method.
        let call = parse_call(
            ApiMethod::Notify,
            Some(json!({ "title": "t", "body": null, "terminal": null })),
        )
        .unwrap();
        assert_eq!(
            call,
            ApiCall::Notify {
                title: "t".into(),
                body: None,
                terminal: None
            }
        );
    }

    #[test]
    fn the_first_message_must_be_a_well_formed_auth() {
        let hex = "0".repeat(64);
        let ok = format!(r#"{{"type":"auth","version":1,"token":"{hex}"}}"#);
        let auth = parse_auth(ok.as_bytes()).unwrap();
        assert_eq!((auth.version, auth.token.as_str()), (1, hex.as_str()));

        let request_first = r#"{"id":1,"method":"spaces.list"}"#;
        assert_eq!(
            parse_auth(request_first.as_bytes()).unwrap_err().code,
            ApiErrorCode::Unauthenticated
        );
        assert_eq!(
            parse_auth(b"{").unwrap_err().code,
            ApiErrorCode::InvalidJson
        );
        for text in [
            r#"{"type":"auth","version":1}"#,
            r#"{"type":"auth","token":"x"}"#,
            r#"{"version":1,"token":"x"}"#,
            r#"{"type":"hello","version":1,"token":"x"}"#,
            r#"{"type":"auth","version":"1","token":"x"}"#,
            r#"{"type":"auth","version":1,"token":5}"#,
            r#"{"type":"auth","version":1,"token":"x","extra":true}"#,
            "[]",
        ] {
            assert_eq!(
                parse_auth(text.as_bytes()).unwrap_err().code,
                ApiErrorCode::InvalidRequest,
                "{text}"
            );
        }
        let big = vec![b' '; MAX_AUTH_BYTES + 1];
        assert_eq!(
            parse_auth(&big).unwrap_err().code,
            ApiErrorCode::Unauthenticated
        );
    }

    #[test]
    fn an_answer_has_the_id_and_either_a_result_or_an_error() {
        let ok: Value =
            serde_json::from_slice(&result_payload(3, &json!({ "spaces": [] }))).unwrap();
        assert_eq!(ok, json!({ "id": 3, "result": { "spaces": [] } }));
        let error = ApiError::new(ApiErrorCode::NotFound, "no such space");
        let err: Value = serde_json::from_slice(&error_payload(Some(3), &error)).unwrap();
        assert_eq!(
            err,
            json!({ "id": 3, "error": { "code": "not_found", "message": "no such space" } })
        );
        let err: Value = serde_json::from_slice(&error_payload(None, &error)).unwrap();
        assert_eq!(err["id"], Value::Null);
        let welcome: Value = serde_json::from_slice(&welcome_payload()).unwrap();
        assert_eq!(welcome, json!({ "type": "welcome", "version": 1 }));
    }

    #[test]
    fn a_frame_has_a_length_prefix_and_a_payload_over_the_limit_is_refused() {
        let frame = to_frame(b"{}").unwrap();
        assert_eq!(frame, vec![0, 0, 0, 2, b'{', b'}']);
        let huge = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            to_frame(&huge),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
        assert!(to_frame(&huge[..MAX_FRAME_BYTES]).is_ok());
    }

    #[test]
    fn echoed_text_is_short_and_has_no_control_characters() {
        let shown = shorten(&format!("a\nb{}", "z".repeat(100)));
        assert!(shown.len() < 60, "{shown}");
        assert!(!shown.contains('\n'));
        assert!(shown.ends_with("...\""));
    }

    fn subscribe(params: Value) -> Result<EventFilter, ApiError> {
        parse_subscribe(Some(params))
    }

    #[test]
    fn a_subscription_names_its_kinds_and_maybe_one_session() {
        assert_eq!(
            subscribe(json!({})).unwrap(),
            EventFilter {
                kinds: EventKind::ALL.to_vec(),
                session_id: None
            }
        );
        assert_eq!(
            parse_subscribe(None).unwrap().kinds,
            EventKind::ALL.to_vec()
        );
        let filter = subscribe(json!({ "types": ["agent.state"], "sessionId": "s1" })).unwrap();
        assert_eq!(filter.kinds, vec![EventKind::AgentState]);
        assert_eq!(filter.session_id.as_deref(), Some("s1"));
        // A repeated kind counts once, in the order given.
        let filter = subscribe(json!({
            "types": ["agent.state", "terminal.output", "agent.state"]
        }))
        .unwrap();
        assert_eq!(
            filter.kinds,
            vec![EventKind::AgentState, EventKind::TerminalOutput]
        );
        assert_eq!(
            filter.result(),
            json!({ "types": ["agent.state", "terminal.output"], "sessionId": null })
        );
    }

    #[test]
    fn a_subscription_that_does_not_fit_is_invalid_params() {
        let many: Vec<_> = (0..=MAX_EVENT_TYPES).map(|_| "agent.state").collect();
        let bad = [
            json!({ "types": [] }),
            json!({ "types": ["terminal.input"] }),
            json!({ "types": ["agent.state", "events.dropped"] }),
            json!({ "types": ["Terminal.Output"] }),
            json!({ "types": [1] }),
            json!({ "types": [null] }),
            json!({ "types": "agent.state" }),
            json!({ "types": many }),
            json!({ "sessionId": "" }),
            json!({ "sessionId": 3 }),
            json!({ "sessionId": "a
b" }),
            json!({ "sessionId": "x".repeat(MAX_ID_CHARS + 1) }),
            json!({ "extra": true }),
            json!({ "types": ["agent.state"], "session": "s" }),
        ];
        for params in bad {
            let error = subscribe(params.clone()).expect_err(&params.to_string());
            assert_eq!(error.code, ApiErrorCode::InvalidParams, "{params}");
        }
        assert_eq!(
            parse_subscribe(Some(json!([]))).unwrap_err().code,
            ApiErrorCode::InvalidParams
        );
        assert!(subscribe(json!({ "sessionId": "x".repeat(MAX_ID_CHARS) })).is_ok());
    }

    #[test]
    fn a_client_request_is_a_call_or_a_subscription_and_nothing_else() {
        let (id, parsed) = parse_client_request(
            br#"{"id":4,"method":"events.subscribe","params":{"types":["terminal.output"]}}"#,
        )
        .unwrap();
        assert_eq!(id, 4);
        assert!(matches!(parsed, ClientRequest::Subscribe(_)));
        let (_, parsed) = parse_client_request(br#"{"id":5,"method":"spaces.list"}"#).unwrap();
        assert_eq!(parsed, ClientRequest::Call(ApiCall::SpacesList));
        // The subscription is not a call of the handler.
        assert_eq!(SUBSCRIBE_METHOD, "events.subscribe");
        assert_eq!(ApiMethod::from_name(SUBSCRIBE_METHOD), None);
        assert_eq!(
            code_of(request(r#"{"id":6,"method":"events.subscribe"}"#)),
            ApiErrorCode::UnknownMethod
        );
        // The errors carry the id as for a call.
        for (text, code) in [
            (
                r#"{"id":7,"method":"events.subscribe","params":{"types":[]}}"#,
                ApiErrorCode::InvalidParams,
            ),
            (
                r#"{"id":7,"method":"events.unsubscribe"}"#,
                ApiErrorCode::UnknownMethod,
            ),
            (
                r#"{"id":7,"method":"events.subscribe","extra":1}"#,
                ApiErrorCode::InvalidRequest,
            ),
        ] {
            let (id, error) = parse_client_request(text.as_bytes()).unwrap_err();
            assert_eq!((id, error.code), (Some(7), code), "{text}");
        }
        assert_eq!(
            parse_client_request(b"nope").unwrap_err().1.code,
            ApiErrorCode::InvalidJson
        );
    }
}

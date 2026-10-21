//! What the app publishes on the event stream of the local API (NOR-F17-01f).
//!
//! - [`OutputEvents`] turns the bytes a session prints into `terminal.output` events for the
//!   [`EventPublisher`] of the server. It sits where the bytes go to the channel of the page
//!   (`bridge::route_session`, shared by local sessions, sessions in the daemon and sessions on
//!   another machine), so each chunk is published once, as it is shown. The text is UTF-8: a
//!   character that arrives cut between two chunks is held back until its last byte comes, so it
//!   leaves whole; a byte that cannot be part of any character becomes U+FFFD. The id of the
//!   session is its number as text, the same string the page keeps in `pane.sessionId`.
//! - [`api_agent_state`] is the command the page tells the state of an agent with
//!   (`waiting`, `working`, `idle`); it becomes an `agent.state` event. Only the main window is
//!   granted it (a capability, checked by a test of `capabilities.rs`) and it refuses any other
//!   window itself.
//!
//! Publishing never waits: the publisher puts the event in the queue of each subscriber and
//! returns, and with nobody subscribed it does nothing, so the output of a session reaches the page
//! at the same speed with or without a client. An app whose server did not start has no publisher,
//! and then none of this runs.

use std::sync::{Arc, Mutex};

use noren_core::api::{AgentState, ApiEvent, EventPublisher};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::api_bridge::ApiState;

/// Longest id of a session the server takes in a filter (`MAX_ID_CHARS` of the protocol).
const MAX_SESSION_ID_CHARS: usize = 128;
/// How much text is kept for a session whose number is not known yet (see [`OutputEvents::bind`]).
const MAX_HELD_BYTES: usize = 256 * 1024;

/// The bytes of `carry` followed by `bytes` as text. The bytes at the end that start a character
/// and do not finish it are left in `carry` for the next call; a byte that cannot belong to a
/// character becomes U+FFFD, as `String::from_utf8_lossy` does.
pub fn decode_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    let mut data = std::mem::take(carry);
    data.extend_from_slice(bytes);
    let mut text = String::with_capacity(data.len());
    let mut rest = data.as_slice();
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                text.push_str(valid);
                return text;
            }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                text.push_str(&String::from_utf8_lossy(valid));
                match error.error_len() {
                    Some(bad) => {
                        text.push('\u{FFFD}');
                        rest = &after[bad..];
                    }
                    None => {
                        // The end of the chunk is the start of a character: wait for the rest.
                        *carry = after.to_vec();
                        return text;
                    }
                }
            }
        }
    }
}

struct Inner {
    /// The number of the session as text; `None` until [`OutputEvents::bind`].
    session: Option<String>,
    /// The start of a character the last chunk ended in the middle of.
    carry: Vec<u8>,
    /// What the session printed before its number was known.
    held: String,
}

/// Publishes the output of one session as `terminal.output` events.
pub struct OutputEvents {
    publisher: EventPublisher,
    inner: Mutex<Inner>,
}

impl OutputEvents {
    pub fn new(publisher: EventPublisher) -> Self {
        Self {
            publisher,
            inner: Mutex::new(Inner {
                session: None,
                carry: Vec::new(),
                held: String::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A chunk of the output of the session. Returns at once.
    pub fn push(&self, bytes: &[u8]) {
        let mut inner = self.lock();
        if self.publisher.subscribers() == 0 {
            // Nobody listens: keep nothing, so a client that subscribes later starts clean.
            inner.carry.clear();
            inner.held.clear();
            return;
        }
        let text = decode_utf8(&mut inner.carry, bytes);
        if text.is_empty() {
            return;
        }
        match &inner.session {
            Some(session) => self.publisher.publish(ApiEvent::TerminalOutput {
                session_id: session.clone(),
                text,
            }),
            None => {
                if inner.held.len() < MAX_HELD_BYTES {
                    inner.held.push_str(&text);
                }
            }
        }
    }

    /// The number of the session is known now (it exists only after the session started, and the
    /// first output may come before): what it printed meanwhile goes out first, then everything
    /// after.
    pub fn bind(&self, session: u64) {
        let mut inner = self.lock();
        let session = session.to_string();
        let held = std::mem::take(&mut inner.held);
        inner.session = Some(session.clone());
        if !held.is_empty() && self.publisher.subscribers() > 0 {
            self.publisher.publish(ApiEvent::TerminalOutput {
                session_id: session,
                text: held,
            });
        }
    }
}

/// The publisher of the output of a new session: `None` when the local API is off, and then the
/// output of the session is not looked at.
pub fn output_events<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<OutputEvents>> {
    let api = app.try_state::<ApiState>()?;
    api.publisher()
        .cloned()
        .map(|publisher| Arc::new(OutputEvents::new(publisher)))
}

/// The state an agent is in, from the word the page uses.
pub fn parse_agent_state(name: &str) -> Option<AgentState> {
    match name {
        "waiting" => Some(AgentState::Waiting),
        "working" => Some(AgentState::Working),
        "idle" => Some(AgentState::Idle),
        _ => None,
    }
}

/// Checks what the page said and publishes it. Nothing is published, and the page is told why, for
/// an id that is empty, too long or has a control character, or a state that is not one of the three.
pub fn publish_agent_state(
    publisher: Option<&EventPublisher>,
    session_id: &str,
    state: &str,
) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.chars().count() > MAX_SESSION_ID_CHARS
        || session_id.chars().any(char::is_control)
    {
        return Err("the session id must be a line of text of 1 to 128 characters".to_owned());
    }
    let Some(state) = parse_agent_state(state) else {
        return Err("the state of an agent is waiting, working or idle".to_owned());
    };
    if let Some(publisher) = publisher {
        publisher.publish(ApiEvent::AgentState {
            session_id: session_id.to_owned(),
            state,
        });
    }
    Ok(())
}

/// The page tells what the agent of a session is doing now. Only the main window may say it; with
/// the local API off (the server did not start) it is accepted and goes nowhere.
#[tauri::command(rename_all = "camelCase")]
pub fn api_agent_state<R: Runtime>(
    window: tauri::Window<R>,
    api: State<'_, ApiState>,
    session_id: String,
    state: String,
) -> Result<(), String> {
    crate::windows::require_owner(&window)?;
    publish_agent_state(api.publisher(), &session_id, &state)
}

#[cfg(test)]
pub mod test_support {
    //! A client of the real server on a real pipe or socket, for the tests of the publishers.

    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use noren_core::api::{API_PROTOCOL_VERSION, to_frame};
    use noren_core::daemon::ipc::{self, ClientStream};
    use noren_core::daemon::{read_frame, write_frame};
    use serde_json::{Value, json};
    use tauri::test::{MockRuntime, mock_builder, mock_context};
    use tauri::{App, Manager};

    use crate::api_bridge::{ApiSettings, ApiState, install};

    /// Longest a test waits for something that must happen.
    pub const STEP: Duration = Duration::from_secs(10);

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A mock app whose local API really listens on an endpoint of its own.
    pub struct TestApi {
        pub app: App<MockRuntime>,
        dir: PathBuf,
    }

    impl TestApi {
        pub fn start() -> Self {
            let unique = format!(
                "{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            );
            let dir = std::env::temp_dir().join(format!("noren-api-events-{unique}"));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let app = mock_builder()
                .invoke_handler(tauri::generate_handler![crate::api_events::api_agent_state])
                .build(mock_context(tauri::test::noop_assets()))
                .expect("build the mock app");
            install(
                app.handle(),
                Ok(ApiSettings::for_run(
                    format!("events-{unique}"),
                    dir.clone(),
                )),
            );
            Self { app, dir }
        }

        pub fn state(&self) -> tauri::State<'_, ApiState> {
            self.app.state::<ApiState>()
        }

        /// A client that authenticated and subscribed to `types` (all sessions).
        pub async fn subscriber(&self, types: &[&str]) -> Subscriber {
            let target = self.state().target().cloned().expect("the server listens");
            let token = std::fs::read_to_string(&target.token_file).expect("token file");
            let stream = ipc::connect(&target.endpoint).await.expect("connect");
            let mut client = Subscriber { stream };
            client
                .send(&json!({ "type": "auth", "version": API_PROTOCOL_VERSION, "token": token.trim() }))
                .await;
            let welcome = client.recv().await;
            assert_eq!(welcome["type"], "welcome", "{welcome}");
            client
                .send(
                    &json!({ "id": 1, "method": "events.subscribe", "params": { "types": types } }),
                )
                .await;
            let answer = client.recv().await;
            assert_eq!(answer["id"], 1, "{answer}");
            assert!(answer.get("result").is_some(), "{answer}");
            client
        }
    }

    impl Drop for TestApi {
        fn drop(&mut self) {
            self.app.state::<ApiState>().stop();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub struct Subscriber {
        stream: ClientStream,
    }

    impl Subscriber {
        async fn send(&mut self, message: &Value) {
            let frame = to_frame(message.to_string().as_bytes()).expect("frame");
            write_frame(&mut self.stream, &frame).await.expect("send");
        }

        /// The next message; fails the test when none comes within [`STEP`].
        pub async fn recv(&mut self) -> Value {
            let payload = tokio::time::timeout(STEP, read_frame(&mut self.stream))
                .await
                .expect("a message within the time")
                .expect("the connection is open");
            serde_json::from_slice(&payload).expect("JSON")
        }

        /// Whether a message comes within `wait`.
        pub async fn quiet_for(&mut self, wait: Duration) -> bool {
            tokio::time::timeout(wait, read_frame(&mut self.stream))
                .await
                .is_err()
        }

        /// Events until the text of `terminal.output` of `session` adds up to `len` bytes; returns
        /// that text.
        pub async fn output_of(&mut self, session: &str, len: usize) -> String {
            let mut text = String::new();
            while text.len() < len {
                let message = self.recv().await;
                assert_eq!(message["event"], "terminal.output", "{message}");
                assert_eq!(message["data"]["sessionId"], session, "{message}");
                text.push_str(message["data"]["text"].as_str().expect("text"));
            }
            text
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{STEP, TestApi};
    use super::*;
    use serde_json::json;
    use std::time::Duration;
    use tauri::Manager;
    use tauri::test::{INVOKE_KEY, get_ipc_response};
    use tauri::webview::InvokeRequest;

    fn decode_all(chunks: &[&[u8]]) -> (String, Vec<u8>) {
        let mut carry = Vec::new();
        let mut text = String::new();
        for chunk in chunks {
            text.push_str(&decode_utf8(&mut carry, chunk));
        }
        (text, carry)
    }

    #[test]
    fn a_character_cut_between_two_chunks_comes_out_whole() {
        // 2, 3 and 4 bytes long, cut at every point inside them.
        for sample in ["é", "€", "😀", "日本語", "a😀b"] {
            let bytes = sample.as_bytes();
            for cut in 0..=bytes.len() {
                let (text, carry) = decode_all(&[&bytes[..cut], &bytes[cut..]]);
                assert_eq!(text, sample, "{sample} cut at {cut}");
                assert!(carry.is_empty());
            }
        }
    }

    #[test]
    fn a_character_cut_in_three_pieces_comes_out_whole() {
        let bytes = "😀".as_bytes();
        let (text, carry) = decode_all(&[&bytes[..1], &bytes[1..3], &bytes[3..]]);
        assert_eq!(text, "😀");
        assert!(carry.is_empty());
    }

    #[test]
    fn the_start_of_a_character_is_held_back_and_not_shown_as_a_broken_one() {
        let bytes = "é".as_bytes();
        let mut carry = Vec::new();
        assert_eq!(decode_utf8(&mut carry, &[b'a', bytes[0]]), "a");
        assert_eq!(carry, vec![bytes[0]]);
        assert_eq!(decode_utf8(&mut carry, &bytes[1..]), "é");
        assert!(carry.is_empty());
    }

    #[test]
    fn a_byte_that_belongs_to_no_character_becomes_the_replacement_and_holds_nothing_back() {
        let (text, carry) = decode_all(&[b"a\xFFb", b"\xC3(", b"\x80"]);
        assert_eq!(text, "a\u{FFFD}b\u{FFFD}(\u{FFFD}");
        assert!(carry.is_empty());
        // The same as the standard lossy conversion for a whole text.
        let whole = b"x\xE2\x82y\xF0\x9F\x98z";
        let (text, _) = decode_all(&[whole]);
        assert_eq!(text, String::from_utf8_lossy(whole));
    }

    #[test]
    fn the_agent_states_are_the_three_words_of_the_interface_and_nothing_else() {
        for (name, state) in [
            ("waiting", AgentState::Waiting),
            ("working", AgentState::Working),
            ("idle", AgentState::Idle),
        ] {
            assert_eq!(parse_agent_state(name), Some(state));
            assert_eq!(state.name(), name);
        }
        for bad in ["", "Working", "WAITING", " idle", "busy", "done", "idle\n"] {
            assert_eq!(parse_agent_state(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_state_or_an_id_that_is_not_valid_is_refused_with_the_reason_and_nothing_is_published() {
        for (session, state) in [
            ("7", "busy"),
            ("7", ""),
            ("", "working"),
            ("a\nb", "working"),
            ("a\u{7}b", "working"),
            (&"x".repeat(129), "working"),
        ] {
            assert!(
                publish_agent_state(None, session, state).is_err(),
                "{session:?} {state:?}"
            );
        }
        // At the limit it is fine; with no publisher it goes nowhere and is not an error.
        assert_eq!(publish_agent_state(None, &"x".repeat(128), "idle"), Ok(()));
    }

    // ---- through the real server --------------------------------------------------------------

    #[tokio::test]
    async fn the_output_is_published_with_the_id_of_its_session() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned().expect("a publisher");
        let mut client = api.subscriber(&["terminal.output"]).await;
        let events = OutputEvents::new(publisher);
        events.bind(42);
        events.push(b"hello\r\n");
        let message = client.recv().await;
        assert_eq!(
            message,
            json!({ "event": "terminal.output", "data": { "sessionId": "42", "text": "hello\r\n" } })
        );
    }

    #[tokio::test]
    async fn the_output_of_two_sessions_keeps_each_id() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned().expect("a publisher");
        let mut client = api.subscriber(&["terminal.output"]).await;
        let (a, b) = (
            OutputEvents::new(publisher.clone()),
            OutputEvents::new(publisher),
        );
        a.bind(1);
        b.bind(2);
        a.push(b"from one");
        b.push(b"from two");
        let first = client.recv().await;
        let second = client.recv().await;
        assert_eq!(
            first["data"],
            json!({ "sessionId": "1", "text": "from one" })
        );
        assert_eq!(
            second["data"],
            json!({ "sessionId": "2", "text": "from two" })
        );
    }

    #[tokio::test]
    async fn a_character_cut_between_two_chunks_is_published_whole() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned().expect("a publisher");
        let mut client = api.subscriber(&["terminal.output"]).await;
        let events = OutputEvents::new(publisher);
        events.bind(5);
        let text = "price: 5€ and 😀 and é\r\n";
        let bytes = text.as_bytes();
        // One byte at a time: every character is cut at every point.
        for byte in bytes {
            events.push(std::slice::from_ref(byte));
        }
        let heard = client.output_of("5", text.len()).await;
        assert_eq!(heard, text);
        assert!(!heard.contains('\u{FFFD}'));
    }

    #[tokio::test]
    async fn what_a_session_printed_before_its_number_was_known_comes_first() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned().expect("a publisher");
        let mut client = api.subscriber(&["terminal.output"]).await;
        let events = OutputEvents::new(publisher);
        events.push(b"prompt> ");
        events.push(b"more");
        events.bind(9);
        events.push(b" after");
        let heard = client.output_of("9", "prompt> more after".len()).await;
        assert_eq!(heard, "prompt> more after");
    }

    #[tokio::test]
    async fn with_nobody_subscribed_the_output_goes_nowhere_and_nothing_breaks() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned().expect("a publisher");
        let events = OutputEvents::new(publisher);
        events.push(b"before the id \xE2\x82");
        events.bind(3);
        events.push(b"\xACno one listens");
        // A client that comes later hears only what is printed from then on, with no half character.
        let mut client = api.subscriber(&["terminal.output"]).await;
        events.push(b"now");
        let message = client.recv().await;
        assert_eq!(message["data"], json!({ "sessionId": "3", "text": "now" }));
    }

    #[tokio::test]
    async fn an_agent_state_is_published_once_for_each_call_to_the_command() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned();
        let mut client = api.subscriber(&["agent.state"]).await;
        publish_agent_state(publisher.as_ref(), "42", "working").expect("working");
        publish_agent_state(publisher.as_ref(), "42", "waiting").expect("waiting");
        publish_agent_state(publisher.as_ref(), "7", "idle").expect("idle");
        for (session, state) in [("42", "working"), ("42", "waiting"), ("7", "idle")] {
            let message = client.recv().await;
            assert_eq!(
                message,
                json!({ "event": "agent.state", "data": { "sessionId": session, "state": state } })
            );
        }
        assert!(client.quiet_for(Duration::from_millis(200)).await);
    }

    #[tokio::test]
    async fn publishing_does_not_wait_for_a_client_that_does_not_read() {
        let api = TestApi::start();
        let publisher = api.state().publisher().cloned().expect("a publisher");
        // Subscribed and never read: its queue fills up.
        let _silent = api.subscriber(&["terminal.output"]).await;
        let events = OutputEvents::new(publisher);
        events.bind(1);
        let work = tokio::task::spawn_blocking(move || {
            let chunk = vec![b'x'; 64 * 1024];
            for _ in 0..2000 {
                events.push(&chunk);
            }
        });
        tokio::time::timeout(STEP * 3, work)
            .await
            .expect("publishing finished without waiting for the client")
            .expect("the thread ran");
    }

    // ---- the command ---------------------------------------------------------------------------

    /// Calls `api_agent_state` from the window `label` of the app of `api`.
    fn tell(
        label: &str,
        session_id: &str,
        state: &str,
        api: &TestApi,
    ) -> Result<(), serde_json::Value> {
        let webview = api.app.get_webview_window(label).unwrap_or_else(|| {
            tauri::WebviewWindowBuilder::new(&api.app, label, Default::default())
                .build()
                .expect("build the mock window")
        });
        let url = if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        };
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "api_agent_state".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: url.parse().expect("url"),
                body: tauri::ipc::InvokeBody::Json(
                    json!({ "sessionId": session_id, "state": state }),
                ),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|_| ())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_main_window_tells_the_state_and_it_is_published() {
        let api = TestApi::start();
        let mut client = api.subscriber(&["agent.state"]).await;
        assert_eq!(tell("main", "42", "waiting", &api), Ok(()));
        let message = client.recv().await;
        assert_eq!(
            message["data"],
            json!({ "sessionId": "42", "state": "waiting" })
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_window_besides_the_main_one_cannot_tell_a_state() {
        let api = TestApi::start();
        let mut client = api.subscriber(&["agent.state"]).await;
        for label in ["window-1", "quick", "browser-p1"] {
            assert!(
                tell(label, "42", "working", &api).is_err(),
                "{label} was allowed to tell a state"
            );
        }
        assert!(client.quiet_for(Duration::from_millis(300)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_command_refuses_a_state_that_is_not_valid() {
        let api = TestApi::start();
        let mut client = api.subscriber(&["agent.state"]).await;
        assert!(tell("main", "42", "busy", &api).is_err());
        assert!(tell("main", "", "working", &api).is_err());
        assert!(client.quiet_for(Duration::from_millis(300)).await);
    }

    #[test]
    fn the_command_is_spelled_as_the_page_and_the_lists_spell_it() {
        let build = include_str!("../build.rs");
        let capability = include_str!("../capabilities/default.json");
        assert!(build.contains("\"api_agent_state\""), "build.rs");
        assert!(capability.contains("allow-api-agent-state"), "default.json");
        let window = include_str!("../capabilities/window.json");
        assert!(!window.contains("allow-api-agent-state"), "window.json");
        let quick = include_str!("../capabilities/quick.json");
        assert!(!quick.contains("allow-api-agent-state"), "quick.json");
        let page = include_str!("../../src/agent-state-report.ts");
        assert!(
            page.contains("\"api_agent_state\""),
            "agent-state-report.ts"
        );
    }
}

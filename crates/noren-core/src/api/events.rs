//! Events the server pushes to clients that asked for them: the output of a terminal session and
//! the state of an agent. Nothing here knows Tauri or a terminal; whoever owns the sessions holds
//! an [`EventPublisher`] and calls [`EventPublisher::publish`].
//!
//! ```text
//! client  {"id":3,"method":"events.subscribe","params":{"types":["terminal.output"],"sessionId":"s1"}}
//! server  {"id":3,"result":{"types":["terminal.output"],"sessionId":"s1"}}
//! server  {"event":"terminal.output","data":{"sessionId":"s1","text":"hello\r\n"}}      no id
//! server  {"event":"agent.state","data":{"sessionId":"s1","state":"working"}}
//! server  {"event":"events.dropped","data":{"count":12}}
//! ```
//!
//! - A connection gets events only after it authenticated **and** subscribed. Subscribing again
//!   replaces the filter (and drops whatever the old filter had queued), so the last
//!   `events.subscribe` is the one that counts.
//! - Each subscribed connection has a queue of its own of [`ApiConfig::event_queue`] events
//!   (`super::ApiConfig`). The publisher never waits: when the queue of a slow client is full the
//!   new event is dropped for that client only, the others are not touched, and once the queue has
//!   emptied the client is told in its own stream with `events.dropped` and the number of events
//!   it missed. The connection stays open.
//! - A text of `terminal.output` is what the publisher gave, whole. The only cut is the frame: a
//!   text longer than [`MAX_OUTPUT_CHUNK_BYTES`] goes out as several `terminal.output` events, in
//!   order, each cut at a character boundary.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Longest text one `terminal.output` event carries, in bytes. JSON can write a control byte in
/// six characters, so a chunk of this size always fits the 2 MiB frame.
pub const MAX_OUTPUT_CHUNK_BYTES: usize = 256 * 1024;
/// The name of the event that tells a client it missed events.
pub const DROPPED_EVENT: &str = "events.dropped";

/// What a client can subscribe to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventKind {
    TerminalOutput,
    AgentState,
}

impl EventKind {
    pub const ALL: [EventKind; 2] = [Self::TerminalOutput, Self::AgentState];

    pub fn name(self) -> &'static str {
        match self {
            Self::TerminalOutput => "terminal.output",
            Self::AgentState => "agent.state",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }
}

/// The state of an agent, the same three words as the list of agents in the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    Waiting,
    Working,
    Idle,
}

impl AgentState {
    pub fn name(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Working => "working",
            Self::Idle => "idle",
        }
    }
}

/// Something that happened in a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiEvent {
    /// Text a terminal printed.
    TerminalOutput { session_id: String, text: String },
    /// An agent in a session changed state.
    AgentState {
        session_id: String,
        state: AgentState,
    },
}

impl ApiEvent {
    pub fn kind(&self) -> EventKind {
        match self {
            Self::TerminalOutput { .. } => EventKind::TerminalOutput,
            Self::AgentState { .. } => EventKind::AgentState,
        }
    }

    pub fn session_id(&self) -> &str {
        match self {
            Self::TerminalOutput { session_id, .. } | Self::AgentState { session_id, .. } => {
                session_id
            }
        }
    }

    /// The message that goes to a client: `{ event, data }`, with no `id`.
    pub fn payload(&self) -> Vec<u8> {
        let data = match self {
            Self::TerminalOutput { session_id, text } => {
                json!({ "sessionId": session_id, "text": text })
            }
            Self::AgentState { session_id, state } => {
                json!({ "sessionId": session_id, "state": state.name() })
            }
        };
        json!({ "event": self.kind().name(), "data": data })
            .to_string()
            .into_bytes()
    }
}

/// The payload of the warning that `count` events were left out of a stream.
pub fn dropped_payload(count: u64) -> Vec<u8> {
    json!({ "event": DROPPED_EVENT, "data": { "count": count } })
        .to_string()
        .into_bytes()
}

/// What `events.subscribe` asks for: the kinds, and one session or all of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventFilter {
    /// In the order the client gave them, each once. Never empty.
    pub kinds: Vec<EventKind>,
    pub session_id: Option<String>,
}

impl EventFilter {
    pub fn matches(&self, event: &ApiEvent) -> bool {
        self.kinds.contains(&event.kind())
            && self
                .session_id
                .as_deref()
                .is_none_or(|wanted| wanted == event.session_id())
    }

    /// The `result` of `events.subscribe`: the filter as it is now.
    pub fn result(&self) -> Value {
        json!({
            "types": self.kinds.iter().map(|k| k.name()).collect::<Vec<_>>(),
            "sessionId": self.session_id,
        })
    }
}

/// The queue the writer of one connection reads, and what it needs to tell the client about
/// events that did not fit.
pub(super) struct Feed {
    pub(super) events: mpsc::Receiver<ApiEvent>,
    dropped: Arc<AtomicU64>,
}

impl Feed {
    /// How many events were left out since the last time this was asked.
    pub(super) fn take_dropped(&self) -> u64 {
        self.dropped.swap(0, Ordering::AcqRel)
    }

    /// Counts an event that was taken from the queue and could not be sent.
    pub(super) fn note_missed(&self) {
        self.dropped.fetch_add(1, Ordering::AcqRel);
    }
}

struct Subscriber {
    filter: EventFilter,
    queue: mpsc::Sender<ApiEvent>,
    dropped: Arc<AtomicU64>,
}

/// Who is subscribed. Shared by the connections and the publishers.
pub(super) struct Hub {
    subscribers: Mutex<HashMap<u64, Subscriber>>,
    next_connection: AtomicU64,
    queue_len: usize,
}

impl Hub {
    pub(super) fn new(queue_len: usize) -> Arc<Self> {
        Arc::new(Self {
            subscribers: Mutex::new(HashMap::new()),
            next_connection: AtomicU64::new(0),
            queue_len: queue_len.max(1),
        })
    }

    pub(super) fn next_connection_id(&self) -> u64 {
        self.next_connection.fetch_add(1, Ordering::Relaxed)
    }

    /// Makes `filter` the filter of `connection`, with a new empty queue (the old one is dropped
    /// with whatever it held). From here on the publisher fills the queue of the [`Feed`].
    pub(super) fn subscribe(&self, connection: u64, filter: EventFilter) -> Feed {
        let (queue, events) = mpsc::channel(self.queue_len);
        let dropped = Arc::new(AtomicU64::new(0));
        self.lock().insert(
            connection,
            Subscriber {
                filter,
                queue,
                dropped: Arc::clone(&dropped),
            },
        );
        Feed { events, dropped }
    }

    pub(super) fn unsubscribe(&self, connection: u64) {
        self.lock().remove(&connection);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Subscriber>> {
        self.subscribers
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn deliver(&self, event: &ApiEvent) {
        for subscriber in self.lock().values() {
            if subscriber.filter.matches(event) && subscriber.queue.try_send(event.clone()).is_err()
            {
                // Full (a slow client) or gone (the connection is ending): either way this
                // event is not coming, and the client is told when its queue has emptied.
                subscriber.dropped.fetch_add(1, Ordering::AcqRel);
            }
        }
    }

    fn subscribers(&self) -> usize {
        self.lock().len()
    }
}

/// Hands events to the server. Cheap to clone, sendable to any thread, and with no dependency on
/// Tauri; it never waits for a client.
#[derive(Clone)]
pub struct EventPublisher {
    hub: Arc<Hub>,
}

impl EventPublisher {
    pub(super) fn new(hub: Arc<Hub>) -> Self {
        Self { hub }
    }

    /// Queues `event` for every connection whose filter takes it. A `terminal.output` with more
    /// than [`MAX_OUTPUT_CHUNK_BYTES`] of text goes out in pieces, in order. Returns at once
    /// whatever the clients are doing; with nobody subscribed it does nothing.
    pub fn publish(&self, event: ApiEvent) {
        if self.hub.subscribers() == 0 {
            return;
        }
        match event {
            ApiEvent::TerminalOutput { session_id, text }
                if text.len() > MAX_OUTPUT_CHUNK_BYTES =>
            {
                for chunk in chunks(&text, MAX_OUTPUT_CHUNK_BYTES) {
                    self.hub.deliver(&ApiEvent::TerminalOutput {
                        session_id: session_id.clone(),
                        text: chunk.to_owned(),
                    });
                }
            }
            other => self.hub.deliver(&other),
        }
    }

    /// How many connections are subscribed right now.
    pub fn subscribers(&self) -> usize {
        self.hub.subscribers()
    }
}

/// `text` in pieces of at most `max` bytes, each ending at a character boundary (`max` of at
/// least 4 always makes progress).
fn chunks(text: &str, max: usize) -> impl Iterator<Item = &str> {
    let mut rest = text;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let mut end = max.min(rest.len());
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (piece, tail) = rest.split_at(end);
        rest = tail;
        Some(piece)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(session: &str, text: &str) -> ApiEvent {
        ApiEvent::TerminalOutput {
            session_id: session.into(),
            text: text.into(),
        }
    }

    fn state(session: &str, state: AgentState) -> ApiEvent {
        ApiEvent::AgentState {
            session_id: session.into(),
            state,
        }
    }

    fn filter(kinds: &[EventKind], session: Option<&str>) -> EventFilter {
        EventFilter {
            kinds: kinds.to_vec(),
            session_id: session.map(str::to_owned),
        }
    }

    #[test]
    fn the_kinds_and_states_have_the_names_the_clients_use() {
        assert_eq!(EventKind::TerminalOutput.name(), "terminal.output");
        assert_eq!(EventKind::AgentState.name(), "agent.state");
        for kind in EventKind::ALL {
            assert_eq!(EventKind::from_name(kind.name()), Some(kind));
        }
        assert_eq!(EventKind::from_name("terminal.Output"), None);
        assert_eq!(EventKind::from_name(DROPPED_EVENT), None);
        let names: Vec<_> = [AgentState::Waiting, AgentState::Working, AgentState::Idle]
            .map(AgentState::name)
            .into();
        assert_eq!(names, ["waiting", "working", "idle"]);
    }

    #[test]
    fn an_event_is_an_event_and_data_with_no_id() {
        let value: Value = serde_json::from_slice(&output("s1", "hi\r\n\"x\"").payload()).unwrap();
        assert_eq!(
            value,
            json!({ "event": "terminal.output", "data": { "sessionId": "s1", "text": "hi\r\n\"x\"" } })
        );
        let value: Value =
            serde_json::from_slice(&state("s2", AgentState::Waiting).payload()).unwrap();
        assert_eq!(
            value,
            json!({ "event": "agent.state", "data": { "sessionId": "s2", "state": "waiting" } })
        );
        let value: Value = serde_json::from_slice(&dropped_payload(3)).unwrap();
        assert_eq!(
            value,
            json!({ "event": "events.dropped", "data": { "count": 3 } })
        );
    }

    #[test]
    fn a_filter_takes_its_kinds_and_its_session_only() {
        let both = filter(&EventKind::ALL, None);
        assert!(both.matches(&output("a", "x")));
        assert!(both.matches(&state("b", AgentState::Idle)));
        let only_output = filter(&[EventKind::TerminalOutput], None);
        assert!(only_output.matches(&output("a", "x")));
        assert!(!only_output.matches(&state("a", AgentState::Idle)));
        let one_session = filter(&EventKind::ALL, Some("a"));
        assert!(one_session.matches(&output("a", "x")));
        assert!(one_session.matches(&state("a", AgentState::Working)));
        assert!(!one_session.matches(&output("b", "x")));
        assert!(!one_session.matches(&output("aa", "x")));
        assert!(!one_session.matches(&output("", "x")));
    }

    #[test]
    fn chunks_keep_every_byte_and_never_cut_a_character() {
        let text = "aé€😀".repeat(1000);
        for max in [4usize, 5, 7, 64, 1000] {
            let pieces: Vec<_> = chunks(&text, max).collect();
            assert!(pieces.iter().all(|p| !p.is_empty() && p.len() <= max));
            assert_eq!(pieces.concat(), text, "max {max}");
        }
        assert_eq!(chunks("", 8).count(), 0);
        assert_eq!(chunks("abc", 8).collect::<Vec<_>>(), ["abc"]);
    }

    #[test]
    fn the_publisher_fills_only_the_queues_that_match_and_counts_what_does_not_fit() {
        let hub = Hub::new(2);
        let publisher = EventPublisher::new(Arc::clone(&hub));
        let mut a = hub.subscribe(1, filter(&[EventKind::TerminalOutput], Some("a")));
        let mut b = hub.subscribe(2, filter(&EventKind::ALL, None));
        assert_eq!(publisher.subscribers(), 2);
        publisher.publish(output("a", "1"));
        publisher.publish(output("b", "2"));
        publisher.publish(output("a", "3"));
        // `a` holds two and misses the third; `b` takes the two that fit and misses one.
        assert_eq!(a.events.try_recv(), Ok(output("a", "1")));
        assert_eq!(a.events.try_recv(), Ok(output("a", "3")));
        assert!(a.events.try_recv().is_err());
        assert_eq!(a.take_dropped(), 0);
        assert_eq!(b.events.try_recv(), Ok(output("a", "1")));
        assert_eq!(b.events.try_recv(), Ok(output("b", "2")));
        assert_eq!(b.take_dropped(), 1);
        assert_eq!(b.take_dropped(), 0);
        hub.unsubscribe(1);
        hub.unsubscribe(2);
        assert_eq!(publisher.subscribers(), 0);
        publisher.publish(output("a", "4"));
    }

    #[test]
    fn a_long_output_goes_out_in_pieces_that_make_the_text_again() {
        let hub = Hub::new(16);
        let publisher = EventPublisher::new(Arc::clone(&hub));
        let mut feed = hub.subscribe(1, filter(&[EventKind::TerminalOutput], None));
        let text = "é".repeat(MAX_OUTPUT_CHUNK_BYTES);
        publisher.publish(output("s", &text));
        let mut joined = String::new();
        let mut pieces = 0;
        while let Ok(ApiEvent::TerminalOutput { text, .. }) = feed.events.try_recv() {
            assert!(text.len() <= MAX_OUTPUT_CHUNK_BYTES);
            joined.push_str(&text);
            pieces += 1;
        }
        assert_eq!(pieces, 2);
        assert_eq!(joined.len(), 2 * MAX_OUTPUT_CHUNK_BYTES);
        assert_eq!(joined, text);
    }

    #[test]
    fn subscribing_again_replaces_the_filter_and_the_queue() {
        let hub = Hub::new(4);
        let publisher = EventPublisher::new(Arc::clone(&hub));
        let mut first = hub.subscribe(7, filter(&[EventKind::TerminalOutput], None));
        publisher.publish(output("a", "old"));
        let mut second = hub.subscribe(7, filter(&[EventKind::AgentState], None));
        assert_eq!(publisher.subscribers(), 1);
        publisher.publish(output("a", "new"));
        publisher.publish(state("a", AgentState::Idle));
        assert_eq!(second.events.try_recv(), Ok(state("a", AgentState::Idle)));
        assert!(second.events.try_recv().is_err());
        // The old queue still holds what it took and gets nothing more.
        assert_eq!(first.events.try_recv(), Ok(output("a", "old")));
        assert!(first.events.try_recv().is_err());
    }
}

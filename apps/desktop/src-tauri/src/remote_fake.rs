//! A `norend` for the tests of the sessions on other machines: a daemon that speaks the real
//! protocol over in-memory streams, keeps what the sessions printed, and can lose its connections
//! and take them again. It runs no process, so a test says exactly what a session printed and when,
//! and checks the bytes the app sent (`Create`, `Write`, `Resize`, `Kill`).
//!
//! What stands in for the `ssh` process is a task that serves one connection; breaking it
//! ([`FakeDaemon::cut_all`]) is what killing `ssh` does to the connection: both ends see it end,
//! and the sessions stay in the daemon. [`FakeDaemon::connector`] is the way the app reaches it.

#![cfg(test)]

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use noren_core::daemon::protocol::MAX_BUFFER_BYTES;
use noren_core::daemon::{
    ClientMessage, ConnectFailure, Connector, DaemonClient, ErrorBody, ErrorCode, Established,
    PROTOCOL_VERSION, Request, Response, ServerMessage, SessionInfo, Transport, read_frame,
    write_frame,
};
use noren_core::{ExitInfo, SessionEvent, SessionId, SpawnSpec};
use tokio::io::DuplexStream;
use tokio::sync::{mpsc, watch};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A session of the fake daemon.
struct FakeSession {
    pid: u32,
    /// The output kept, oldest first, at most `ring_bytes`.
    ring: Vec<u8>,
    exit: Option<ExitInfo>,
    attached: HashSet<u64>,
    cols: u16,
    rows: u16,
}

/// One connection being served.
struct Connection {
    events: mpsc::UnboundedSender<ServerMessage>,
    cut: watch::Sender<bool>,
}

struct State {
    sessions: BTreeMap<u64, FakeSession>,
    next_session: u64,
    next_connection: u64,
    connections: HashMap<u64, Connection>,
    ring_bytes: usize,
    /// Every `Create` the daemon got, as the client sent it.
    creates: Vec<SpawnSpec>,
    writes: Vec<(u64, Vec<u8>)>,
    resizes: Vec<(u64, u16, u16)>,
    kills: Vec<u64>,
    /// Sessions that end the moment they are created (a program that is not there).
    exit_at_once: Option<u32>,
    /// While set, `Create` is refused with this sentence.
    create_error: Option<String>,
}

struct Shared {
    state: Mutex<State>,
    /// While set, the connector fails every attempt (the network is down).
    down: AtomicBool,
    /// How long a connection takes to be made, in milliseconds (a login over a slow network).
    connect_delay_ms: AtomicU32,
    /// While set, the connector fails every attempt for good (a refused key).
    refusal: Mutex<Option<String>>,
    /// How many times the connector was asked to connect, and how many handshakes succeeded.
    attempts: AtomicU32,
    handshakes: AtomicU32,
}

/// The fake daemon. Cloning it shares it.
#[derive(Clone)]
pub struct FakeDaemon {
    shared: Arc<Shared>,
}

impl Default for FakeDaemon {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeDaemon {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    sessions: BTreeMap::new(),
                    next_session: 1,
                    next_connection: 1,
                    connections: HashMap::new(),
                    ring_bytes: MAX_BUFFER_BYTES,
                    creates: Vec::new(),
                    writes: Vec::new(),
                    resizes: Vec::new(),
                    kills: Vec::new(),
                    exit_at_once: None,
                    create_error: None,
                }),
                down: AtomicBool::new(false),
                connect_delay_ms: AtomicU32::new(0),
                refusal: Mutex::new(None),
                attempts: AtomicU32::new(0),
                handshakes: AtomicU32::new(0),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.shared.state)
    }

    // ----- what a test can do to the daemon -----

    /// Prints `data` in the session, as its process would: it is kept, and sent to every
    /// connection attached to it.
    pub fn print(&self, session: u64, data: &[u8]) {
        let mut state = self.state();
        let cap = state.ring_bytes;
        let Some(entry) = state.sessions.get_mut(&session) else {
            panic!("no session {session} to print in");
        };
        entry.ring.extend_from_slice(data);
        if entry.ring.len() > cap {
            let excess = entry.ring.len() - cap;
            entry.ring.drain(..excess);
        }
        let attached: Vec<u64> = entry.attached.iter().copied().collect();
        for connection in attached {
            if let Some(connection) = state.connections.get(&connection) {
                let _ = connection.events.send(ServerMessage::Output {
                    session: SessionId(session),
                    data: data.to_vec(),
                });
            }
        }
    }

    /// The process of the session ends.
    pub fn end(&self, session: u64, code: u32) {
        let mut state = self.state();
        let Some(entry) = state.sessions.get_mut(&session) else {
            panic!("no session {session} to end");
        };
        let info = ExitInfo { code, signal: None };
        entry.exit = Some(info.clone());
        let attached: Vec<u64> = entry.attached.iter().copied().collect();
        for connection in attached {
            if let Some(connection) = state.connections.get(&connection) {
                let _ = connection.events.send(ServerMessage::Exit {
                    session: SessionId(session),
                    info: info.clone(),
                });
            }
        }
    }

    /// The daemon forgets a session (it was restarted, or the session was killed from elsewhere).
    pub fn forget(&self, session: u64) {
        self.state().sessions.remove(&session);
    }

    /// Breaks every connection, as killing `ssh` does. The sessions stay.
    pub fn cut_all(&self) {
        for connection in self.state().connections.values() {
            let _ = connection.cut.send(true);
        }
    }

    /// While `down`, the connector cannot connect (a network that is gone).
    pub fn set_down(&self, down: bool) {
        self.shared.down.store(down, Ordering::SeqCst);
    }

    /// Makes every connection take this long to be made (a login over a slow network).
    pub fn set_connect_delay(&self, delay: Duration) {
        self.shared.connect_delay_ms.store(
            u32::try_from(delay.as_millis()).unwrap_or(u32::MAX),
            Ordering::SeqCst,
        );
    }

    /// While set, the connector fails for good with this text (a key the server does not accept),
    /// which a reconnection does not repeat.
    pub fn refuse(&self, reason: Option<&str>) {
        *lock(&self.shared.refusal) = reason.map(str::to_owned);
    }

    /// How many bytes of output each session keeps (the real daemon: 1 MiB).
    pub fn set_ring_bytes(&self, bytes: usize) {
        self.state().ring_bytes = bytes;
    }

    /// While set, the daemon refuses to start a process (`Create` answers with this sentence).
    pub fn fail_creates(&self, why: Option<&str>) {
        self.state().create_error = why.map(str::to_owned);
    }

    /// Makes every session created from now on end at once with `code`.
    pub fn exit_at_once(&self, code: Option<u32>) {
        self.state().exit_at_once = code;
    }

    // ----- what a test can see -----

    pub fn creates(&self) -> Vec<SpawnSpec> {
        self.state().creates.clone()
    }

    pub fn written_text(&self, session: u64) -> String {
        let bytes: Vec<u8> = self
            .state()
            .writes
            .iter()
            .filter(|(id, _)| *id == session)
            .flat_map(|(_, data)| data.clone())
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    pub fn resizes(&self) -> Vec<(u64, u16, u16)> {
        self.state().resizes.clone()
    }

    pub fn kills(&self) -> Vec<u64> {
        self.state().kills.clone()
    }

    pub fn session_ids(&self) -> Vec<u64> {
        self.state().sessions.keys().copied().collect()
    }

    /// Connections being served now.
    pub fn connections(&self) -> usize {
        self.state().connections.len()
    }

    /// How many connection attempts the connector was asked for, and how many were welcomed.
    pub fn attempts(&self) -> u32 {
        self.shared.attempts.load(Ordering::SeqCst)
    }

    pub fn handshakes(&self) -> u32 {
        self.shared.handshakes.load(Ordering::SeqCst)
    }

    /// The way the app reaches this daemon.
    pub fn connector(&self) -> FakeConnector {
        FakeConnector {
            daemon: self.clone(),
        }
    }

    // ----- serving a connection -----

    fn answer(&self, connection: u64, request: Request) -> Response {
        let mut state = self.state();
        match request {
            Request::Create(spec) => {
                if let Some(why) = state.create_error.clone() {
                    return Response::Error(ErrorBody::new(ErrorCode::Spawn, why));
                }
                let session = state.next_session;
                state.next_session += 1;
                let exit = state
                    .exit_at_once
                    .map(|code| ExitInfo { code, signal: None });
                state.creates.push(spec.clone());
                state.sessions.insert(
                    session,
                    FakeSession {
                        pid: 1000 + u32::try_from(session).unwrap_or(0),
                        ring: Vec::new(),
                        exit,
                        attached: HashSet::new(),
                        cols: spec.cols,
                        rows: spec.rows,
                    },
                );
                Response::Created {
                    session: SessionId(session),
                    pid: Some(1000 + u32::try_from(session).unwrap_or(0)),
                }
            }
            Request::Write { session, data } => match state.sessions.get(&session.0) {
                Some(_) => {
                    state.writes.push((session.0, data));
                    Response::Ok
                }
                None => unknown(session),
            },
            Request::Resize {
                session,
                cols,
                rows,
            } => match state.sessions.get_mut(&session.0) {
                Some(entry) => {
                    entry.cols = cols;
                    entry.rows = rows;
                    state.resizes.push((session.0, cols, rows));
                    Response::Ok
                }
                None => unknown(session),
            },
            Request::Attach { session } => match state.sessions.get_mut(&session.0) {
                Some(entry) => {
                    entry.attached.insert(connection);
                    Response::Attached {
                        replay: entry.ring.clone(),
                        exit: entry.exit.clone(),
                    }
                }
                None => unknown(session),
            },
            Request::Detach { session } => {
                if let Some(entry) = state.sessions.get_mut(&session.0) {
                    entry.attached.remove(&connection);
                }
                Response::Ok
            }
            Request::Kill { session } => match state.sessions.remove(&session.0) {
                Some(entry) => {
                    state.kills.push(session.0);
                    // A process that is killed ends: whoever is attached hears it.
                    if entry.exit.is_none() {
                        for attached in entry.attached {
                            if let Some(connection) = state.connections.get(&attached) {
                                let _ = connection.events.send(ServerMessage::Exit {
                                    session,
                                    info: ExitInfo {
                                        code: 137,
                                        signal: Some("SIGKILL".to_owned()),
                                    },
                                });
                            }
                        }
                    }
                    Response::Ok
                }
                None => unknown(session),
            },
            Request::List => Response::Sessions(
                state
                    .sessions
                    .iter()
                    .map(|(id, entry)| SessionInfo {
                        session: SessionId(*id),
                        pid: Some(entry.pid),
                        cols: entry.cols,
                        rows: entry.rows,
                        attached: u32::try_from(entry.attached.len()).unwrap_or(u32::MAX),
                        buffered: u32::try_from(entry.ring.len()).unwrap_or(u32::MAX),
                        exit: entry.exit.clone(),
                    })
                    .collect(),
            ),
            Request::Shutdown => Response::Ok,
        }
    }

    /// Serves one connection until it is cut or the other end goes away.
    async fn serve(
        self,
        stream: DuplexStream,
        id: u64,
        mut events: mpsc::UnboundedReceiver<ServerMessage>,
        mut cut: watch::Receiver<bool>,
    ) {
        let (mut reader, mut writer) = tokio::io::split(stream);
        let Ok(hello) = read_frame(&mut reader).await else {
            return;
        };
        match ClientMessage::decode(&hello) {
            Ok(ClientMessage::Hello { version }) if version == PROTOCOL_VERSION => {}
            _ => return,
        }
        let welcome = ServerMessage::Welcome {
            version: PROTOCOL_VERSION,
        };
        let Ok(frame) = welcome.to_frame() else {
            return;
        };
        if write_frame(&mut writer, &frame).await.is_err() {
            return;
        }
        self.shared.handshakes.fetch_add(1, Ordering::SeqCst);
        loop {
            tokio::select! {
                frame = read_frame(&mut reader) => {
                    let Ok(payload) = frame else { break };
                    let Ok(ClientMessage::Request { id: request, request: what }) =
                        ClientMessage::decode(&payload) else { break };
                    let response = self.answer(id, what);
                    let message = ServerMessage::Response { id: request, response };
                    let Ok(frame) = message.to_frame() else { break };
                    if write_frame(&mut writer, &frame).await.is_err() { break }
                }
                message = events.recv() => {
                    let Some(message) = message else { break };
                    let Ok(frame) = message.to_frame() else { break };
                    if write_frame(&mut writer, &frame).await.is_err() { break }
                }
                changed = cut.changed() => {
                    if changed.is_err() || *cut.borrow() { break }
                }
            }
        }
        let mut state = self.state();
        state.connections.remove(&id);
        for entry in state.sessions.values_mut() {
            entry.attached.remove(&id);
        }
    }
}

fn unknown(session: SessionId) -> Response {
    Response::Error(ErrorBody::new(
        ErrorCode::UnknownSession,
        format!("no session {}", session.0),
    ))
}

/// The connector of the app in the tests: a fresh in-memory connection to the fake daemon each
/// time, unless the daemon is `down` or refuses.
pub struct FakeConnector {
    daemon: FakeDaemon,
}

struct FakeTransport {
    daemon: FakeDaemon,
    connection: u64,
}

impl Transport for FakeTransport {
    fn id(&self) -> Option<u32> {
        Some(u32::try_from(self.connection).unwrap_or(u32::MAX))
    }

    fn cut(&mut self) {
        if let Some(connection) = self.daemon.state().connections.get(&self.connection) {
            let _ = connection.cut.send(true);
        }
    }
}

impl Drop for FakeTransport {
    fn drop(&mut self) {
        // Dropping the `ssh` process ends the connection.
        self.cut();
    }
}

impl Connector for FakeConnector {
    fn connect(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Established, ConnectFailure>> + Send + '_>> {
        Box::pin(async move {
            let daemon = self.daemon.clone();
            daemon.shared.attempts.fetch_add(1, Ordering::SeqCst);
            if let Some(reason) = lock(&daemon.shared.refusal).clone() {
                return Err(ConnectFailure {
                    message: reason,
                    permanent: true,
                });
            }
            let delay = daemon.shared.connect_delay_ms.load(Ordering::SeqCst);
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(u64::from(delay))).await;
            }
            if daemon.shared.down.load(Ordering::SeqCst) {
                return Err(ConnectFailure {
                    message: "Network is unreachable".to_owned(),
                    permanent: false,
                });
            }
            let (near, far) = tokio::io::duplex(256 * 1024);
            let connection = {
                let mut state = daemon.state();
                let id = state.next_connection;
                state.next_connection += 1;
                id
            };
            let (cut_tx, cut_rx) = watch::channel(false);
            let (events_tx, events_rx) = mpsc::unbounded_channel();
            // Registered at once, so a cut made while the handshake runs reaches it.
            daemon.state().connections.insert(
                connection,
                Connection {
                    events: events_tx,
                    cut: cut_tx,
                },
            );
            tokio::spawn(daemon.clone().serve(far, connection, events_rx, cut_rx));
            let (client, events) =
                DaemonClient::connect_stream(near)
                    .await
                    .map_err(|e| ConnectFailure {
                        message: e.to_string(),
                        permanent: false,
                    })?;
            Ok(Established {
                client,
                events,
                transport: Box::new(FakeTransport { daemon, connection }),
            })
        })
    }
}

// ---------------------------------------------------------------------------------------------
// What the app handed to its callbacks
// ---------------------------------------------------------------------------------------------

/// Records what a session's callbacks were given.
#[derive(Clone, Default)]
pub struct Recorder {
    inner: Arc<Mutex<Recorded>>,
}

#[derive(Default)]
struct Recorded {
    /// The output, in order, chunk by chunk.
    chunks: Vec<Vec<u8>>,
    exits: Vec<ExitInfo>,
    links: Vec<(SessionId, noren_core::daemon::LinkState)>,
}

impl Recorder {
    pub fn sink(&self) -> crate::daemon_link::Sink {
        let inner = Arc::clone(&self.inner);
        Box::new(move |event| match event {
            SessionEvent::Output(bytes) => lock(&inner).chunks.push(bytes.to_vec()),
            SessionEvent::Exit(info) => lock(&inner).exits.push(info),
        })
    }

    pub fn link_sink(&self) -> crate::remote::LinkSink {
        let inner = Arc::clone(&self.inner);
        Box::new(move |id, state| lock(&inner).links.push((id, state.clone())))
    }

    /// Everything the terminal was handed, as bytes.
    pub fn bytes(&self) -> Vec<u8> {
        lock(&self.inner).chunks.concat()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes()).into_owned()
    }

    /// What a terminal would hold: the output after the last full reset.
    pub fn since_last_reset(&self) -> Vec<u8> {
        let all = self.bytes();
        let reset = noren_core::daemon::replay::RESET_TERMINAL;
        match all.windows(reset.len()).rposition(|w| w == reset) {
            Some(at) => all[at + reset.len()..].to_vec(),
            None => all,
        }
    }

    pub fn resets(&self) -> usize {
        let all = self.bytes();
        let reset = noren_core::daemon::replay::RESET_TERMINAL;
        all.windows(reset.len()).filter(|w| *w == reset).count()
    }

    pub fn exits(&self) -> Vec<ExitInfo> {
        lock(&self.inner).exits.clone()
    }

    pub fn links(&self) -> Vec<noren_core::daemon::LinkState> {
        lock(&self.inner)
            .links
            .iter()
            .map(|(_, state)| state.clone())
            .collect()
    }

    pub fn link_ids(&self) -> Vec<SessionId> {
        lock(&self.inner).links.iter().map(|(id, _)| *id).collect()
    }
}

/// Waits until `check` holds, up to 30 s, or fails the test saying what it waited for.
pub fn wait_for(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A policy that retries fast, for tests.
pub fn fast(attempts: u32) -> noren_core::daemon::BackoffPolicy {
    noren_core::daemon::BackoffPolicy {
        first_delay: Duration::from_millis(10),
        max_delay: Duration::from_millis(40),
        max_attempts: attempts,
    }
}

/// `VecDeque` is only used by tests of the connector that script failures.
#[allow(dead_code)]
type Scripted = VecDeque<ConnectFailure>;

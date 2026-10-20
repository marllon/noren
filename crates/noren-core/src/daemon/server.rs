//! The daemon: terminal sessions that live in one process while clients come and go.
//!
//! ## Threads
//!
//! [`Daemon::start`] spawns one thread (`noren-daemon`) that runs a current-thread tokio runtime:
//! the accept loop and one task per connection. Everything that can block on a PTY (starting a
//! process, writing to it, ending it) goes to the blocking pool, so a slow shell never stops the
//! other connections. The sessions are the ones of [`SessionManager`], with their own three
//! threads each; their output callback runs on the pump thread of the session and does only
//! short, non-blocking work.
//!
//! ## What a session keeps
//!
//! Each session has a ring of its latest output ([`ServerConfig::buffer_bytes`], never above
//! [`MAX_BUFFER_BYTES`]) and the list of the connections attached to it. The callback appends to
//! the ring and queues the same bytes for every attached connection under one lock, and an attach
//! takes a copy of the ring and joins the list under that same lock, so a client sees the buffer
//! and then everything after it, with no gap and no repetition.
//!
//! ## A client that does not read
//!
//! Each connection has a bounded queue of frames to write. When the callback finds that queue full
//! it does not wait (that would stop the shell and every other client): it closes that connection.
//! The sessions go on, and the client gets the same buffer back by connecting again and
//! attaching.
//!
//! ## Shutting down
//!
//! [`Daemon::shutdown`] stops accepting, closes every connection, kills every session and joins
//! every session thread and the daemon thread; the socket file is removed.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use super::frame::{FrameError, read_frame, write_frame};
use super::ipc::{Endpoint, Listener};
use super::lock;
use super::protocol::{
    ClientMessage, ErrorBody, ErrorCode, MAX_BUFFER_BYTES, PROTOCOL_VERSION, Request, Response,
    ServerMessage, SessionInfo,
};
use super::ring::ByteRing;
use crate::pty::{ExitInfo, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec};

/// The default for [`ServerConfig::buffer_bytes`].
pub const DEFAULT_BUFFER_BYTES: usize = MAX_BUFFER_BYTES;
/// The default for [`ServerConfig::max_sessions`].
pub const DEFAULT_MAX_SESSIONS: usize = 256;
/// The default for [`ServerConfig::handshake_timeout`].
pub const DEFAULT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// The default for [`ServerConfig::client_queue_frames`].
pub const DEFAULT_CLIENT_QUEUE_FRAMES: usize = 128;

/// Pause after a failed accept, so a persistent failure does not spin.
const ACCEPT_RETRY: Duration = Duration::from_millis(100);
/// How long a connection that was refused is given to deliver the reason before it is cut.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

/// What the daemon allows.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// Bytes of output each session keeps for a client that attaches later; the oldest bytes go
    /// first. Capped at [`MAX_BUFFER_BYTES`]; zero keeps nothing.
    pub buffer_bytes: usize,
    /// Sessions the daemon holds at once, counting the ones whose process ended and that nobody
    /// has killed (released) yet.
    pub max_sessions: usize,
    /// How long a new connection may take to send its `Hello` before it is closed.
    pub handshake_timeout: Duration,
    /// Frames queued for one client. A client that falls this far behind is disconnected. At
    /// least 2 (the answer to an attach and the first output).
    pub client_queue_frames: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            buffer_bytes: DEFAULT_BUFFER_BYTES,
            max_sessions: DEFAULT_MAX_SESSIONS,
            handshake_timeout: DEFAULT_HANDSHAKE_TIMEOUT,
            client_queue_frames: DEFAULT_CLIENT_QUEUE_FRAMES,
        }
    }
}

impl ServerConfig {
    fn sanitized(mut self) -> Self {
        self.buffer_bytes = self.buffer_bytes.min(MAX_BUFFER_BYTES);
        self.client_queue_frames = self.client_queue_frames.max(2);
        self
    }
}

/// A running daemon. Dropping it shuts it down.
pub struct Daemon {
    endpoint: Endpoint,
    state: Arc<ServerState>,
    shutdown: CancellationToken,
    thread: Option<JoinHandle<()>>,
}

impl Daemon {
    /// Binds `endpoint` and starts serving. Returns once the endpoint is ready for clients, or
    /// with the reason it could not be bound (a name in use, a folder that is not private...).
    /// Safe to call from async code: it waits on a plain thread, not on a runtime.
    pub fn start(endpoint: Endpoint, config: ServerConfig) -> io::Result<Self> {
        let state = Arc::new(ServerState::new(config.sanitized()));
        let shutdown = CancellationToken::new();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<io::Result<()>>();
        let thread = thread::Builder::new().name("noren-daemon".into()).spawn({
            let endpoint = endpoint.clone();
            let state = Arc::clone(&state);
            let shutdown = shutdown.clone();
            move || run(&endpoint, &state, shutdown, &ready_tx)
        })?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                endpoint,
                state,
                shutdown,
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(io::Error::other(
                    "the daemon thread ended before it was ready",
                ))
            }
        }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Sessions the daemon holds now.
    pub fn session_count(&self) -> usize {
        lock(&self.state.sessions).len()
    }

    /// Session threads (reader, pump, waiter) still running. Zero once no session is left.
    pub fn live_threads(&self) -> usize {
        self.state.manager.live_threads()
    }

    /// Stops accepting, closes the connections, kills every session and waits for all the
    /// threads. Does nothing the second time.
    pub fn shutdown(&mut self) {
        self.state.closing.store(true, Ordering::SeqCst);
        self.shutdown.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The body of the daemon thread.
fn run(
    endpoint: &Endpoint,
    state: &Arc<ServerState>,
    shutdown: CancellationToken,
    ready: &std::sync::mpsc::Sender<io::Result<()>>,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let bound = {
        let _in_runtime = runtime.enter();
        Listener::bind(endpoint)
    };
    let listener = match bound {
        Ok(listener) => listener,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    runtime.block_on(serve(listener, Arc::clone(state), shutdown));

    // Sessions first, so a task that is blocked writing to a shell is released; then the runtime,
    // which waits for the blocking tasks; then once more for a session one of them just made.
    state.closing.store(true, Ordering::SeqCst);
    state.manager.shutdown();
    drop(runtime);
    state.manager.shutdown();
    lock(&state.sessions).clear();
}

async fn serve(mut listener: Listener, state: Arc<ServerState>, shutdown: CancellationToken) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok(stream) => {
                    connections.spawn(handle_connection(stream, Arc::clone(&state)));
                }
                Err(_) => tokio::time::sleep(ACCEPT_RETRY).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    listener.cleanup();
}

/// Everything the connection tasks share.
struct ServerState {
    config: ServerConfig,
    manager: SessionManager,
    sessions: Mutex<HashMap<SessionId, Arc<DaemonSession>>>,
    /// Sessions being started, counted against `max_sessions` before they are in the map.
    pending_creates: AtomicUsize,
    next_session: AtomicU64,
    next_connection: AtomicU64,
    closing: AtomicBool,
}

struct DaemonSession {
    /// The id the `SessionManager` gave it (the one clients see is the key in the map).
    manager_id: SessionId,
    pid: Option<u32>,
    shared: Arc<SessionShared>,
}

impl ServerState {
    fn new(config: ServerConfig) -> Self {
        Self {
            config,
            manager: SessionManager::new(),
            sessions: Mutex::new(HashMap::new()),
            pending_creates: AtomicUsize::new(0),
            next_session: AtomicU64::new(1),
            next_connection: AtomicU64::new(1),
            closing: AtomicBool::new(false),
        }
    }

    fn session(&self, id: SessionId) -> Result<Arc<DaemonSession>, ErrorBody> {
        lock(&self.sessions)
            .get(&id)
            .cloned()
            .ok_or_else(|| unknown_session(id))
    }

    /// Starts a process in a new session. Runs on the blocking pool.
    fn create(&self, spec: SpawnSpec) -> Result<(SessionId, Option<u32>), ErrorBody> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(ErrorBody::new(
                ErrorCode::ShuttingDown,
                "the daemon is shutting down",
            ));
        }
        let _slot = {
            let sessions = lock(&self.sessions);
            let taken = sessions.len() + self.pending_creates.load(Ordering::SeqCst);
            if taken >= self.config.max_sessions {
                return Err(ErrorBody::new(
                    ErrorCode::TooManySessions,
                    format!(
                        "the daemon already holds {} sessions; kill one first",
                        self.config.max_sessions
                    ),
                ));
            }
            PendingCreate::new(&self.pending_creates)
        };

        let id = SessionId(self.next_session.fetch_add(1, Ordering::SeqCst));
        let shared = Arc::new(SessionShared::new(
            id,
            spec.cols,
            spec.rows,
            self.config.buffer_bytes,
        ));
        let on_event = {
            let shared = Arc::clone(&shared);
            move |event: SessionEvent<'_>| match event {
                SessionEvent::Output(bytes) => shared.on_output(bytes),
                SessionEvent::Exit(info) => shared.on_exit(info),
            }
        };
        let manager_id = self
            .manager
            .spawn(spec, on_event)
            .map_err(|e| pty_error(id, &e))?;
        let pid = self.manager.process_id(manager_id);
        lock(&self.sessions).insert(
            id,
            Arc::new(DaemonSession {
                manager_id,
                pid,
                shared,
            }),
        );
        Ok((id, pid))
    }

    /// Runs on the blocking pool: a full terminal input blocks the write.
    fn write(&self, id: SessionId, data: &[u8]) -> Result<(), ErrorBody> {
        let session = self.session(id)?;
        self.manager
            .write(session.manager_id, data)
            .map_err(|e| pty_error(id, &e))
    }

    fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), ErrorBody> {
        let session = self.session(id)?;
        self.manager
            .resize(session.manager_id, cols, rows)
            .map_err(|e| pty_error(id, &e))?;
        let mut state = lock(&session.shared.state);
        state.cols = cols;
        state.rows = rows;
        Ok(())
    }

    /// Ends the process, waits for the session threads (so every attached client has had the
    /// exit event queued) and forgets the session. Runs on the blocking pool.
    fn kill(&self, id: SessionId) -> Result<(), ErrorBody> {
        let session = self.session(id)?;
        self.manager
            .kill(session.manager_id)
            .map_err(|e| pty_error(id, &e))?;
        lock(&self.sessions).remove(&id);
        Ok(())
    }

    fn attach(
        &self,
        connection: &Arc<Connection>,
        request_id: u32,
        id: SessionId,
    ) -> Result<(), ErrorBody> {
        self.session(id)?.shared.attach(connection, request_id)
    }

    fn detach(&self, connection: &Connection, id: SessionId) -> Result<(), ErrorBody> {
        self.session(id)?.shared.detach(connection.id);
        Ok(())
    }

    /// Drops the connection from every session it was attached to.
    fn detach_everywhere(&self, connection_id: u64) {
        let sessions: Vec<Arc<DaemonSession>> = lock(&self.sessions).values().cloned().collect();
        for session in sessions {
            session.shared.detach(connection_id);
        }
    }

    fn list(&self) -> Vec<SessionInfo> {
        let mut sessions: Vec<Arc<DaemonSession>> =
            lock(&self.sessions).values().cloned().collect();
        sessions.sort_by_key(|session| session.shared.id);
        sessions
            .iter()
            .map(|session| session.shared.info(session.pid))
            .collect()
    }
}

/// Counts a session that is being started; the count goes down when this is dropped.
struct PendingCreate<'a>(&'a AtomicUsize);

impl<'a> PendingCreate<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for PendingCreate<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn unknown_session(id: SessionId) -> ErrorBody {
    ErrorBody::new(ErrorCode::UnknownSession, format!("unknown session {id}"))
}

/// The error a client is told about. The ids inside the messages of the `SessionManager` are its
/// own, not the ones clients use, so those two are worded here.
fn pty_error(id: SessionId, error: &PtyError) -> ErrorBody {
    match error {
        PtyError::InvalidSize { .. } => ErrorBody::new(ErrorCode::InvalidSize, error.to_string()),
        PtyError::Open(_) | PtyError::Spawn(_) => {
            ErrorBody::new(ErrorCode::Spawn, error.to_string())
        }
        PtyError::UnknownSession(_) => unknown_session(id),
        PtyError::SessionClosed(_) => ErrorBody::new(
            ErrorCode::SessionClosed,
            format!("session {id} is closed: its process ended"),
        ),
        PtyError::Resize(_) | PtyError::Io(_) => ErrorBody::new(ErrorCode::Io, error.to_string()),
    }
}

/// What the writer task of a connection is told to do.
enum Outgoing {
    Frame(Vec<u8>),
    /// Write what is queued, then close.
    Close,
}

/// One client, as the sessions see it: a queue to put frames on and a way to close it.
struct Connection {
    id: u64,
    queue: mpsc::Sender<Outgoing>,
    /// Cancelled when the connection must end: the client left, a write failed, or the queue
    /// overflowed.
    closed: CancellationToken,
}

impl Connection {
    /// Queues a frame without waiting. A full queue closes the connection (see the module
    /// documentation) and returns `false`, as does a connection that is already gone.
    fn try_send(&self, frame: Vec<u8>) -> bool {
        match self.queue.try_send(Outgoing::Frame(frame)) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.closed.cancel();
                false
            }
            Err(TrySendError::Closed(_)) => false,
        }
    }

    /// Queues a frame, waiting for room. `false` when the connection ended meanwhile.
    async fn send(&self, outgoing: Outgoing) -> bool {
        tokio::select! {
            sent = self.queue.send(outgoing) => sent.is_ok(),
            () = self.closed.cancelled() => false,
        }
    }

    async fn respond(&self, id: u32, response: Response) -> bool {
        let frame = ServerMessage::Response { id, response }
            .to_frame()
            .or_else(|e| {
                ServerMessage::Response {
                    id,
                    response: Response::Error(ErrorBody::new(ErrorCode::Internal, e.to_string())),
                }
                .to_frame()
            });
        match frame {
            Ok(frame) => self.send(Outgoing::Frame(frame)).await,
            Err(_) => false,
        }
    }

    /// Tells the client why the conversation ends and closes the connection after the message.
    async fn refuse(&self, code: ErrorCode, message: String) {
        if let Ok(frame) = ServerMessage::Error(ErrorBody::new(code, message)).to_frame() {
            self.send(Outgoing::Frame(frame)).await;
        }
        self.send(Outgoing::Close).await;
    }
}

/// A session as the connections share it. The output callback of the `SessionManager` holds one.
struct SessionShared {
    id: SessionId,
    state: Mutex<SessionState>,
}

struct SessionState {
    ring: ByteRing,
    attached: Vec<Arc<Connection>>,
    exit: Option<ExitInfo>,
    cols: u16,
    rows: u16,
}

impl SessionShared {
    fn new(id: SessionId, cols: u16, rows: u16, buffer_bytes: usize) -> Self {
        Self {
            id,
            state: Mutex::new(SessionState {
                ring: ByteRing::new(buffer_bytes),
                attached: Vec::new(),
                exit: None,
                cols,
                rows,
            }),
        }
    }

    /// Output from the pump thread: keep it, and queue it for everyone attached.
    fn on_output(&self, bytes: &[u8]) {
        let mut state = lock(&self.state);
        state.ring.push(bytes);
        if state.attached.is_empty() {
            return;
        }
        let frame = ServerMessage::Output {
            session: self.id,
            data: bytes.to_vec(),
        }
        .to_frame();
        if let Ok(frame) = frame {
            state
                .attached
                .retain(|connection| connection.try_send(frame.clone()));
        }
    }

    /// The process ended: the last event of the session.
    fn on_exit(&self, info: ExitInfo) {
        let mut state = lock(&self.state);
        state.exit = Some(info.clone());
        let frame = ServerMessage::Exit {
            session: self.id,
            info,
        }
        .to_frame();
        if let Ok(frame) = frame {
            for connection in &state.attached {
                connection.try_send(frame.clone());
            }
        }
        // Nothing more will be said to them.
        state.attached.clear();
    }

    /// Answers an attach and joins the list, as one step: the answer holds the ring as it is, and
    /// every byte the callback adds after it is queued behind the answer.
    fn attach(&self, connection: &Arc<Connection>, request_id: u32) -> Result<(), ErrorBody> {
        let mut state = lock(&self.state);
        let answer = ServerMessage::Response {
            id: request_id,
            response: Response::Attached {
                replay: state.ring.snapshot(),
                exit: state.exit.clone(),
            },
        }
        .to_frame()
        .map_err(|e| ErrorBody::new(ErrorCode::Internal, e.to_string()))?;
        if !connection.try_send(answer) {
            return Err(ErrorBody::new(
                ErrorCode::Io,
                "the connection is closed or cannot keep up",
            ));
        }
        // An ended session has nothing more to send, and attaching twice is one attachment.
        if state.exit.is_none() && !state.attached.iter().any(|c| c.id == connection.id) {
            state.attached.push(Arc::clone(connection));
        }
        Ok(())
    }

    fn detach(&self, connection_id: u64) {
        lock(&self.state)
            .attached
            .retain(|connection| connection.id != connection_id);
    }

    fn info(&self, pid: Option<u32>) -> SessionInfo {
        let state = lock(&self.state);
        SessionInfo {
            session: self.id,
            pid,
            cols: state.cols,
            rows: state.rows,
            attached: u32::try_from(state.attached.len()).unwrap_or(u32::MAX),
            buffered: u32::try_from(state.ring.len()).unwrap_or(u32::MAX),
            exit: state.exit.clone(),
        }
    }
}

/// Runs a blocking call on the blocking pool.
async fn blocking<T, F>(work: F) -> Result<T, ErrorBody>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ErrorBody> + Send + 'static,
{
    tokio::task::spawn_blocking(work).await.unwrap_or_else(|_| {
        Err(ErrorBody::new(
            ErrorCode::Internal,
            "a worker thread of the daemon failed",
        ))
    })
}

/// Drops a connection from its sessions when its task ends, however it ends (including being
/// cancelled when the daemon shuts down).
struct DetachOnDrop {
    state: Arc<ServerState>,
    connection_id: u64,
}

impl Drop for DetachOnDrop {
    fn drop(&mut self) {
        self.state.detach_everywhere(self.connection_id);
    }
}

async fn handle_connection<S>(stream: S, state: Arc<ServerState>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    if !handshake(&mut reader, &mut writer, state.config.handshake_timeout).await {
        let _ = writer.shutdown().await;
        return;
    }

    let (queue, frames) = mpsc::channel(state.config.client_queue_frames);
    let connection = Arc::new(Connection {
        id: state.next_connection.fetch_add(1, Ordering::SeqCst),
        queue,
        closed: CancellationToken::new(),
    });
    let _detach = DetachOnDrop {
        state: Arc::clone(&state),
        connection_id: connection.id,
    };
    let mut writer_task = tokio::spawn(write_loop(writer, frames, connection.closed.clone()));

    // `true` when the client was told why the conversation ended: the writer must send that
    // before the connection closes.
    let refused = loop {
        let frame = tokio::select! {
            () = connection.closed.cancelled() => break false,
            frame = read_frame(&mut reader) => frame,
        };
        let payload = match frame {
            Ok(payload) => payload,
            Err(FrameError::Closed | FrameError::Io(_)) => break false,
            Err(FrameError::Protocol(e)) => {
                connection.refuse(ErrorCode::Protocol, e.to_string()).await;
                break true;
            }
        };
        match ClientMessage::decode(&payload) {
            Ok(ClientMessage::Request { id, request }) => {
                if !handle_request(&state, &connection, id, request).await {
                    break false;
                }
            }
            Ok(ClientMessage::Hello { .. }) => {
                connection
                    .refuse(
                        ErrorCode::Protocol,
                        "Hello was already received on this connection".into(),
                    )
                    .await;
                break true;
            }
            Err(e) => {
                connection.refuse(ErrorCode::Protocol, e.to_string()).await;
                break true;
            }
        }
    };

    if !refused {
        connection.closed.cancel();
    }
    if tokio::time::timeout(CLOSE_GRACE, &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
    connection.closed.cancel();
}

/// The conversation after the handshake: `false` when the connection is gone.
async fn handle_request(
    state: &Arc<ServerState>,
    connection: &Arc<Connection>,
    id: u32,
    request: Request,
) -> bool {
    let response = match request {
        Request::Create(spec) => {
            let state = Arc::clone(state);
            match blocking(move || state.create(spec)).await {
                Ok((session, pid)) => Response::Created { session, pid },
                Err(e) => Response::Error(e),
            }
        }
        Request::Write { session, data } => {
            let state = Arc::clone(state);
            unit(blocking(move || state.write(session, &data)).await)
        }
        Request::Resize {
            session,
            cols,
            rows,
        } => {
            let state = Arc::clone(state);
            unit(blocking(move || state.resize(session, cols, rows)).await)
        }
        // The answer is queued by `attach` itself, inside the lock that orders it before the
        // output that follows.
        Request::Attach { session } => match state.attach(connection, id, session) {
            Ok(()) => return true,
            Err(e) => Response::Error(e),
        },
        Request::Detach { session } => unit(state.detach(connection, session)),
        Request::Kill { session } => {
            let state = Arc::clone(state);
            unit(blocking(move || state.kill(session)).await)
        }
        Request::List => Response::Sessions(state.list()),
    };
    connection.respond(id, response).await
}

fn unit(result: Result<(), ErrorBody>) -> Response {
    match result {
        Ok(()) => Response::Ok,
        Err(e) => Response::Error(e),
    }
}

/// The first frame must be a `Hello` with the version this daemon speaks. Anything else is
/// answered with an error that says what was wrong, then the connection is closed.
async fn handshake<R, W>(reader: &mut R, writer: &mut W, timeout: Duration) -> bool
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let refusal = match tokio::time::timeout(timeout, read_frame(reader)).await {
        // Silence, or a client that left before it said anything.
        Err(_) | Ok(Err(FrameError::Closed | FrameError::Io(_))) => return false,
        Ok(Err(FrameError::Protocol(e))) => {
            Some(ErrorBody::new(ErrorCode::Protocol, e.to_string()))
        }
        Ok(Ok(payload)) => match ClientMessage::decode(&payload) {
            Ok(ClientMessage::Hello { version }) if version == PROTOCOL_VERSION => None,
            Ok(ClientMessage::Hello { version }) => Some(ErrorBody::new(
                ErrorCode::VersionMismatch,
                format!(
                    "the client speaks protocol version {version} and this daemon speaks \
                     version {PROTOCOL_VERSION}; use a client built for the same version"
                ),
            )),
            Ok(ClientMessage::Request { .. }) => Some(ErrorBody::new(
                ErrorCode::Protocol,
                "the first message of a connection must be Hello",
            )),
            Err(e) => Some(ErrorBody::new(ErrorCode::Protocol, e.to_string())),
        },
    };
    let accepted = refusal.is_none();
    let answer = match refusal {
        None => ServerMessage::Welcome {
            version: PROTOCOL_VERSION,
        },
        Some(body) => ServerMessage::Error(body),
    };
    match answer.to_frame() {
        Ok(frame) => write_frame(writer, &frame).await.is_ok() && accepted,
        Err(_) => false,
    }
}

async fn write_loop<W>(
    mut writer: W,
    mut frames: mpsc::Receiver<Outgoing>,
    closed: CancellationToken,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        let next = tokio::select! {
            () = closed.cancelled() => break,
            next = frames.recv() => next,
        };
        match next {
            Some(Outgoing::Frame(frame)) => {
                if write_frame(&mut writer, &frame).await.is_err() {
                    break;
                }
            }
            Some(Outgoing::Close) | None => break,
        }
    }
    let _ = writer.shutdown().await;
    closed.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(id: u64, capacity: usize) -> (Arc<Connection>, mpsc::Receiver<Outgoing>) {
        let (queue, frames) = mpsc::channel(capacity);
        let connection = Arc::new(Connection {
            id,
            queue,
            closed: CancellationToken::new(),
        });
        (connection, frames)
    }

    /// Everything queued for a connection so far, decoded.
    fn queued(frames: &mut mpsc::Receiver<Outgoing>) -> Vec<ServerMessage> {
        let mut messages = Vec::new();
        while let Ok(outgoing) = frames.try_recv() {
            match outgoing {
                Outgoing::Frame(frame) => {
                    messages.push(ServerMessage::decode(&frame[4..]).unwrap());
                }
                Outgoing::Close => {}
            }
        }
        messages
    }

    fn output(session: u64, text: &str) -> ServerMessage {
        ServerMessage::Output {
            session: SessionId(session),
            data: text.as_bytes().to_vec(),
        }
    }

    fn attached(id: u32, replay: &str, exit: Option<ExitInfo>) -> ServerMessage {
        ServerMessage::Response {
            id,
            response: Response::Attached {
                replay: replay.as_bytes().to_vec(),
                exit,
            },
        }
    }

    #[test]
    fn an_attach_gets_the_buffer_and_then_everything_after_it_once() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 1024);
        shared.on_output(b"before ");
        let (client, mut frames) = connection(1, 8);
        shared.attach(&client, 5).unwrap();
        shared.on_output(b"after");
        shared.on_output(b" more");
        assert_eq!(
            queued(&mut frames),
            vec![
                attached(5, "before ", None),
                output(1, "after"),
                output(1, " more")
            ]
        );
    }

    #[test]
    fn output_while_nobody_is_attached_is_kept_for_the_next_attach() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 1024);
        let (client, mut frames) = connection(1, 8);
        shared.attach(&client, 1).unwrap();
        shared.on_output(b"one ");
        shared.detach(1);
        shared.on_output(b"two ");
        shared.attach(&client, 2).unwrap();
        shared.on_output(b"three");
        assert_eq!(
            queued(&mut frames),
            vec![
                attached(1, "", None),
                output(1, "one "),
                attached(2, "one two ", None),
                output(1, "three"),
            ]
        );
    }

    #[test]
    fn attaching_twice_from_one_connection_is_one_attachment() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 1024);
        let (client, mut frames) = connection(1, 8);
        shared.attach(&client, 1).unwrap();
        shared.attach(&client, 2).unwrap();
        assert_eq!(shared.info(None).attached, 1);
        shared.on_output(b"x");
        let messages = queued(&mut frames);
        assert_eq!(messages.len(), 3, "two answers and one copy of the output");
        assert_eq!(messages[2], output(1, "x"));
    }

    #[test]
    fn two_connections_each_get_their_own_copy_and_one_can_leave() {
        let shared = SessionShared::new(SessionId(7), 80, 24, 1024);
        let (first, mut first_frames) = connection(1, 8);
        let (second, mut second_frames) = connection(2, 8);
        shared.attach(&first, 1).unwrap();
        shared.attach(&second, 1).unwrap();
        assert_eq!(shared.info(None).attached, 2);
        shared.on_output(b"both");
        shared.detach(2);
        shared.on_output(b"first only");
        assert_eq!(
            queued(&mut first_frames),
            vec![
                attached(1, "", None),
                output(7, "both"),
                output(7, "first only")
            ]
        );
        assert_eq!(
            queued(&mut second_frames),
            vec![attached(1, "", None), output(7, "both")]
        );
    }

    #[test]
    fn a_client_that_falls_behind_is_cut_and_the_session_keeps_everything() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 1024);
        let (slow, mut slow_frames) = connection(1, 2);
        let (quick, mut quick_frames) = connection(2, 16);
        shared.attach(&slow, 1).unwrap();
        shared.attach(&quick, 1).unwrap();
        shared.on_output(b"a"); // fills the slow queue: the answer and this
        assert!(!slow.closed.is_cancelled());
        shared.on_output(b"b"); // no room: the slow client is cut, the quick one is not
        assert!(slow.closed.is_cancelled(), "the slow connection is closed");
        assert!(!quick.closed.is_cancelled());
        shared.on_output(b"c");

        assert_eq!(
            shared.info(None).attached,
            1,
            "only the quick client is left"
        );
        assert_eq!(shared.info(None).buffered, 3, "the session lost nothing");
        assert_eq!(
            queued(&mut slow_frames).len(),
            2,
            "the slow queue was not grown"
        );
        assert_eq!(
            queued(&mut quick_frames),
            vec![
                attached(1, "", None),
                output(1, "a"),
                output(1, "b"),
                output(1, "c")
            ]
        );
    }

    #[test]
    fn a_connection_that_is_gone_is_dropped_from_the_session() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 1024);
        let (client, frames) = connection(1, 8);
        shared.attach(&client, 1).unwrap();
        drop(frames);
        shared.on_output(b"x");
        assert_eq!(shared.info(None).attached, 0);
    }

    #[test]
    fn the_buffer_is_capped_by_the_configuration() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 8);
        shared.on_output(b"0123456789abc");
        let (client, mut frames) = connection(1, 8);
        shared.attach(&client, 1).unwrap();
        assert_eq!(queued(&mut frames), vec![attached(1, "56789abc", None)]);
        assert_eq!(shared.info(None).buffered, 8);
    }

    #[test]
    fn the_exit_is_the_last_event_and_a_later_attach_sees_it_in_the_answer() {
        let shared = SessionShared::new(SessionId(1), 80, 24, 1024);
        let (client, mut frames) = connection(1, 8);
        shared.attach(&client, 1).unwrap();
        shared.on_output(b"bye");
        let info = ExitInfo {
            code: 3,
            signal: None,
        };
        shared.on_exit(info.clone());
        assert_eq!(shared.info(None).exit, Some(info.clone()));
        assert_eq!(shared.info(None).attached, 0, "nothing more will be sent");

        let (late, mut late_frames) = connection(2, 8);
        shared.attach(&late, 9).unwrap();
        assert_eq!(
            shared.info(None).attached,
            0,
            "an ended session takes no attachment"
        );
        assert_eq!(
            queued(&mut late_frames),
            vec![attached(9, "bye", Some(info.clone()))]
        );
        assert_eq!(
            queued(&mut frames),
            vec![
                attached(1, "", None),
                output(1, "bye"),
                ServerMessage::Exit {
                    session: SessionId(1),
                    info
                }
            ]
        );
    }

    #[test]
    fn the_configuration_is_kept_inside_its_limits() {
        let config = ServerConfig {
            buffer_bytes: usize::MAX,
            client_queue_frames: 0,
            ..ServerConfig::default()
        }
        .sanitized();
        assert_eq!(config.buffer_bytes, MAX_BUFFER_BYTES);
        assert_eq!(config.client_queue_frames, 2);
        assert_eq!(
            ServerConfig::default().sanitized().buffer_bytes,
            DEFAULT_BUFFER_BYTES
        );
    }

    #[test]
    fn errors_of_the_pty_layer_say_the_id_the_client_knows() {
        let id = SessionId(42);
        let closed = pty_error(id, &PtyError::SessionClosed(SessionId(1)));
        assert_eq!(closed.code, ErrorCode::SessionClosed);
        assert!(closed.message.contains("42"), "{}", closed.message);
        let unknown = pty_error(id, &PtyError::UnknownSession(SessionId(1)));
        assert_eq!(unknown.code, ErrorCode::UnknownSession);
        assert_eq!(unknown.message, "unknown session 42");
        let size = pty_error(id, &PtyError::InvalidSize { cols: 0, rows: 9 });
        assert_eq!(size.code, ErrorCode::InvalidSize);
        assert!(size.message.contains("0x9"), "{}", size.message);
        let spawn = pty_error(id, &PtyError::Spawn("no such file".into()));
        assert_eq!(spawn.code, ErrorCode::Spawn);
    }
}

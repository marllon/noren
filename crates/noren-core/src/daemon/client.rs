//! The client of the daemon: connects, says hello, and then creates, writes to, resizes,
//! attaches to, detaches from, lists and kills sessions, and hands out their output as events.
//!
//! One connection serves any number of concurrent calls: each request carries an id, a task
//! reads the connection, and the answer goes to whoever asked. Output and exit events of the
//! sessions this connection is attached to come out of [`ClientEvents`], in order.
//!
//! Dropping the client closes the connection. The sessions stay in the daemon: that is what the
//! daemon is for.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::task::JoinHandle;

use super::frame::{FrameError, read_frame, write_frame};
use super::ipc::{Endpoint, connect};
use super::lock;
use super::protocol::{
    ClientMessage, ErrorBody, MAX_WRITE_BYTES, PROTOCOL_VERSION, ProtocolError, Request, Response,
    ServerMessage, SessionInfo,
};
use crate::pty::{ExitInfo, SessionId, SpawnSpec};

/// How long the daemon has to answer the `Hello`.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The write side of a connection, whatever carries it (a pipe, a socket, the pipes of an `ssh`
/// process).
type BoxedWriter = Box<dyn AsyncWrite + Send + Unpin>;

/// Why a call to the daemon failed.
#[derive(Debug)]
pub enum ClientError {
    /// The daemon could not be reached: nothing listens at the endpoint, or the system refused.
    Connect(io::Error),
    /// The connection failed while talking.
    Io(io::Error),
    /// The daemon sent something this client cannot read.
    Protocol(ProtocolError),
    /// The daemon said no: a version it does not speak, an unknown session, a size it refuses...
    Server(ErrorBody),
    /// The connection ended (the daemon went away, or closed this client).
    Closed,
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(e) => write!(f, "could not reach the daemon: {e}"),
            Self::Io(e) => write!(f, "i/o error talking to the daemon: {e}"),
            Self::Protocol(e) => write!(f, "the daemon sent something unreadable: {e}"),
            Self::Server(body) => write!(f, "the daemon refused: {body}"),
            Self::Closed => write!(f, "the connection to the daemon ended"),
        }
    }
}

impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Connect(e) | Self::Io(e) => Some(e),
            Self::Protocol(e) => Some(e),
            Self::Server(_) | Self::Closed => None,
        }
    }
}

impl From<FrameError> for ClientError {
    fn from(error: FrameError) -> Self {
        match error {
            FrameError::Closed => Self::Closed,
            FrameError::Protocol(e) => Self::Protocol(e),
            FrameError::Io(e) => Self::Io(e),
        }
    }
}

/// A session just made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub session: SessionId,
    /// The pid of its process, when the system gave one.
    pub pid: Option<u32>,
}

/// What an attach returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attached {
    /// The latest output of the session (at most the daemon's buffer size). Everything after it
    /// arrives as [`ClientEvent::Output`], with nothing missing and nothing repeated.
    pub replay: Vec<u8>,
    /// How the process ended, if it already has; no events follow then.
    pub exit: Option<ExitInfo>,
}

/// Something a session this client is attached to did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientEvent {
    Output {
        session: SessionId,
        data: Vec<u8>,
    },
    /// The process ended. The last event of that session; kill the session to release it.
    Exit {
        session: SessionId,
        info: ExitInfo,
    },
}

/// The events of one connection. The queue is not bounded: keep taking from it. A client that
/// does not will grow in memory, and the daemon, which does bound its own queue, closes the
/// connection if this side stops reading the socket.
pub struct ClientEvents {
    receiver: mpsc::UnboundedReceiver<ClientEvent>,
}

impl ClientEvents {
    /// The next event; `None` once the connection has ended and the queue is empty.
    pub async fn recv(&mut self) -> Option<ClientEvent> {
        self.receiver.recv().await
    }

    /// An event that is already queued, without waiting.
    pub fn try_recv(&mut self) -> Option<ClientEvent> {
        self.receiver.try_recv().ok()
    }
}

struct Shared {
    writer: AsyncMutex<BoxedWriter>,
    pending: Mutex<HashMap<u32, oneshot::Sender<Response>>>,
    next_id: AtomicU32,
    /// Set once the reading side has ended; no answer will come after that.
    closed: AtomicBool,
    /// An error the daemon sent that ends the conversation, kept to explain the close.
    fatal: Mutex<Option<ErrorBody>>,
}

impl Shared {
    fn closed_error(&self) -> ClientError {
        match lock(&self.fatal).clone() {
            Some(body) => ClientError::Server(body),
            None => ClientError::Closed,
        }
    }
}

/// A connection to the daemon.
///
/// The calls are not cancel safe once they started writing: a future dropped half way (by a
/// timeout, say) may leave a partial request on the wire, so drop the client after that.
pub struct DaemonClient {
    shared: Arc<Shared>,
    reader: JoinHandle<()>,
}

impl DaemonClient {
    /// Connects to the daemon at `endpoint` and checks that it speaks this protocol version.
    /// A daemon of another version is refused with [`ClientError::Server`] and a message that
    /// says which versions are involved.
    pub async fn connect(endpoint: &Endpoint) -> Result<(Self, ClientEvents), ClientError> {
        let stream = connect(endpoint).await.map_err(ClientError::Connect)?;
        Self::connect_stream(stream).await
    }

    /// The same client over a stream the caller already has: the handshake is the one of
    /// [`DaemonClient::connect`], and everything after it too. This is how a daemon is reached
    /// when it is not on a local endpoint, for instance through the pipes of an `ssh` process
    /// (see [`SshTarget`](super::SshTarget)) or an in-memory stream in a test. The stream must be
    /// the whole conversation: the first byte it carries is the `Hello` frame, and nothing else
    /// may be written to or read from it by anyone else. Dropping the client drops the stream.
    pub async fn connect_stream<S>(stream: S) -> Result<(Self, ClientEvents), ClientError>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        Self::connect_stream_within(stream, HANDSHAKE_TIMEOUT).await
    }

    /// [`DaemonClient::connect_stream`] with its own time for the daemon to answer the `Hello`
    /// (a stream that first has to be opened, like a login on another machine, needs more than
    /// the 10 seconds a local pipe is given).
    pub async fn connect_stream_within<S>(
        stream: S,
        handshake_timeout: Duration,
    ) -> Result<(Self, ClientEvents), ClientError>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (mut reader, mut writer) = tokio::io::split(stream);

        let hello = ClientMessage::Hello {
            version: PROTOCOL_VERSION,
        }
        .to_frame()
        .map_err(ClientError::Protocol)?;
        let answer = tokio::time::timeout(handshake_timeout, async {
            write_frame(&mut writer, &hello)
                .await
                .map_err(ClientError::Io)?;
            Ok::<_, ClientError>(read_frame(&mut reader).await?)
        })
        .await
        .map_err(|_| {
            ClientError::Io(io::Error::new(
                io::ErrorKind::TimedOut,
                "the daemon did not answer the greeting",
            ))
        })??;
        match ServerMessage::decode(&answer).map_err(ClientError::Protocol)? {
            ServerMessage::Welcome { version } if version == PROTOCOL_VERSION => {}
            ServerMessage::Welcome { .. } => {
                return Err(ClientError::Protocol(ProtocolError::Unexpected(
                    "the daemon welcomed another protocol version",
                )));
            }
            ServerMessage::Error(body) => return Err(ClientError::Server(body)),
            _ => {
                return Err(ClientError::Protocol(ProtocolError::Unexpected(
                    "expected Welcome",
                )));
            }
        }

        let shared = Arc::new(Shared {
            writer: AsyncMutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            closed: AtomicBool::new(false),
            fatal: Mutex::new(None),
        });
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let reader = tokio::spawn(read_loop(reader, Arc::clone(&shared), events_tx));
        Ok((
            Self { shared, reader },
            ClientEvents {
                receiver: events_rx,
            },
        ))
    }

    /// Starts a process in a new session in the daemon. The session lives until it is killed.
    pub async fn create(&self, spec: &SpawnSpec) -> Result<Created, ClientError> {
        match self.request(Request::Create(spec.clone())).await? {
            Response::Created { session, pid } => Ok(Created { session, pid }),
            _ => Err(unexpected()),
        }
    }

    /// Sends bytes to the terminal input of a session (a long write goes in several requests).
    /// The connection need not be attached to the session.
    pub async fn write(&self, session: SessionId, data: &[u8]) -> Result<(), ClientError> {
        for chunk in data.chunks(MAX_WRITE_BYTES) {
            let request = Request::Write {
                session,
                data: chunk.to_vec(),
            };
            self.request(request).await?.into_ok()?;
        }
        Ok(())
    }

    pub async fn resize(
        &self,
        session: SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<(), ClientError> {
        self.request(Request::Resize {
            session,
            cols,
            rows,
        })
        .await?
        .into_ok()
    }

    /// Starts receiving the output of a session, and returns what it kept.
    pub async fn attach(&self, session: SessionId) -> Result<Attached, ClientError> {
        match self.request(Request::Attach { session }).await? {
            Response::Attached { replay, exit } => Ok(Attached { replay, exit }),
            _ => Err(unexpected()),
        }
    }

    /// Stops receiving the output of a session. The session goes on.
    pub async fn detach(&self, session: SessionId) -> Result<(), ClientError> {
        self.request(Request::Detach { session }).await?.into_ok()
    }

    /// Ends the process of a session if it still runs, and releases the session.
    pub async fn kill(&self, session: SessionId) -> Result<(), ClientError> {
        self.request(Request::Kill { session }).await?.into_ok()
    }

    /// The sessions in the daemon, oldest first.
    pub async fn list(&self) -> Result<Vec<SessionInfo>, ClientError> {
        match self.request(Request::List).await? {
            Response::Sessions(sessions) => Ok(sessions),
            _ => Err(unexpected()),
        }
    }

    /// Asks the daemon to stop. It answers first, then ends every session and exits, so this
    /// client sees `Ok` and then the end of its connection (and so does every other client).
    pub async fn shutdown(&self) -> Result<(), ClientError> {
        self.request(Request::Shutdown).await?.into_ok()
    }

    /// Sends a request and waits for the answer with the same id. An answer that is an error is
    /// turned into [`ClientError::Server`].
    async fn request(&self, request: Request) -> Result<Response, ClientError> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let frame = ClientMessage::Request { id, request }
            .to_frame()
            .map_err(ClientError::Protocol)?;

        let (answer_tx, answer_rx) = oneshot::channel();
        lock(&self.shared.pending).insert(id, answer_tx);
        // The reading side sets `closed` and then empties `pending`. Registering first and
        // looking after, a request is either seen by that sweep or sees the flag.
        if self.shared.closed.load(Ordering::SeqCst) {
            lock(&self.shared.pending).remove(&id);
            return Err(self.shared.closed_error());
        }
        let written = {
            let mut writer = self.shared.writer.lock().await;
            write_frame(&mut *writer, &frame).await
        };
        if let Err(e) = written {
            lock(&self.shared.pending).remove(&id);
            // A write to a connection the daemon already closed is the same news as the reading
            // side ending, only earlier.
            return Err(match e.kind() {
                io::ErrorKind::BrokenPipe
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted => self.shared.closed_error(),
                _ => ClientError::Io(e),
            });
        }

        match answer_rx.await {
            Ok(Response::Error(body)) => Err(ClientError::Server(body)),
            Ok(response) => Ok(response),
            Err(_) => Err(self.shared.closed_error()),
        }
    }
}

impl Drop for DaemonClient {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

fn unexpected() -> ClientError {
    ClientError::Protocol(ProtocolError::Unexpected(
        "an answer that does not belong to the request",
    ))
}

impl Response {
    fn into_ok(self) -> Result<(), ClientError> {
        match self {
            Self::Ok => Ok(()),
            _ => Err(unexpected()),
        }
    }
}

/// Reads the connection until it ends: answers go to their callers, output and exit events go
/// to the event queue.
async fn read_loop<R>(
    mut reader: R,
    shared: Arc<Shared>,
    events: mpsc::UnboundedSender<ClientEvent>,
) where
    R: AsyncRead + Unpin,
{
    loop {
        let Ok(payload) = read_frame(&mut reader).await else {
            break;
        };
        match ServerMessage::decode(&payload) {
            Ok(ServerMessage::Response { id, response }) => {
                if let Some(waiting) = lock(&shared.pending).remove(&id) {
                    let _ = waiting.send(response);
                }
            }
            Ok(ServerMessage::Output { session, data }) => {
                let _ = events.send(ClientEvent::Output { session, data });
            }
            Ok(ServerMessage::Exit { session, info }) => {
                let _ = events.send(ClientEvent::Exit { session, info });
            }
            Ok(ServerMessage::Error(body)) => {
                *lock(&shared.fatal) = Some(body);
                break;
            }
            Ok(ServerMessage::Welcome { .. }) | Err(_) => break,
        }
    }
    shared.closed.store(true, Ordering::SeqCst);
    // Dropping the senders wakes every caller that is still waiting.
    lock(&shared.pending).clear();
}

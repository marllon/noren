//! The local API: a server that lets a program on this machine, running as the current user, ask
//! Noren to do what a person does in the window (list and create spaces, open items and splits,
//! type into a terminal, read its buffer). This module is the transport and the rules of the
//! conversation; what a request does is the job of an [`ApiHandler`], which the app supplies.
//!
//! - [`protocol`]: the versioned messages (pure, no I/O) and the check of every parameter.
//! - [`token`]: the secret the first message of a connection must carry, kept in a file of the
//!   user.
//! - [`events`]: what the server pushes to a client that subscribed (terminal output, the state
//!   of an agent) and the [`EventPublisher`] whoever owns the sessions uses.
//! - [`ApiServer`]: listens on its own endpoint, authenticates every connection, calls the
//!   handler.
//!
//! ## Who can talk to it
//!
//! The endpoint is the one of [`daemon::ipc`](crate::daemon::ipc) under another name (`api-…`,
//! never the daemon's): on Windows a named pipe with a security descriptor that grants the SID
//! of the current user and nobody else, and remote clients rejected; on Unix a socket (mode 0600)
//! in a folder that belongs to the user (mode 0700), with every accepted connection checked
//! against the user id. On top of that the first message of each connection must carry the token
//! in the file passed to [`ApiServer::start`]; until it does, the handler is never called.
//!
//! ## Limits
//!
//! | What | Limit |
//! | --- | --- |
//! | One frame | [`MAX_FRAME_BYTES`](crate::daemon::protocol::MAX_FRAME_BYTES) (2 MiB); a bigger length is answered with `frame_too_large` and the connection is closed, unread |
//! | The first message | [`protocol::MAX_AUTH_BYTES`] |
//! | Time to authenticate | [`ApiConfig::handshake_timeout`], 5 s by default |
//! | Time for one request | [`ApiConfig::request_timeout`], 30 s by default |
//! | Connections at once | [`ApiConfig::max_connections`], 32 by default; one more is closed unanswered |
//! | Events waiting for one client | [`ApiConfig::event_queue`], 64 by default; past it new events are dropped for that client and it is told with `events.dropped` |
//!
//! A connection serves one request at a time, in order; connections run side by side. A request
//! that is invalid (bad JSON, unknown method, wrong parameters) gets an error and the connection
//! stays open; an authentication that fails, a request before the authentication and a frame
//! that cannot be read get an error and the connection is closed.
//!
//! ## Events
//!
//! After the authentication a client may send `events.subscribe` (the server answers it itself;
//! the handler never sees it). From then on the server writes `{ event, data }` frames in the
//! same stream as the answers: an event can come between a request and its answer, never in the
//! middle of a frame, and the answers keep the order of the requests. A connection that did not
//! subscribe, or did not authenticate, gets none. The details are in [`events`].

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, split};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::daemon::frame::{FrameError, read_frame, write_frame};
use crate::daemon::ipc::{Endpoint, Listener};
use crate::daemon::protocol::{MAX_FRAME_BYTES, ProtocolError};

use events::{Feed, Hub};

pub mod events;
pub mod protocol;
mod token;

pub use events::{
    AgentState, ApiEvent, DROPPED_EVENT, EventFilter, EventKind, EventPublisher,
    MAX_OUTPUT_CHUNK_BYTES,
};
pub use protocol::{
    API_PROTOCOL_VERSION, ApiCall, ApiError, ApiErrorCode, ApiMethod, ClientRequest,
    SUBSCRIBE_METHOD, SplitDirection, to_frame,
};
pub use token::{ApiToken, TOKEN_BYTES, TOKEN_HEX_CHARS, TokenOrigin, load_or_create_token};

/// The name of the endpoint a normal installation uses.
pub const DEFAULT_API_NAME: &str = "default";

/// Pause after a failed accept, so a persistent failure does not spin.
const ACCEPT_RETRY: Duration = Duration::from_millis(200);

/// Longest a closing connection waits to write what it still owes a client that does not read.
const CLOSE_DRAIN: Duration = Duration::from_secs(2);

/// The endpoint of the API called `name` for the current user. It is `api-<name>` among the
/// endpoints of [`Endpoint::named`], so it is never the daemon's.
pub fn api_endpoint(name: &str) -> io::Result<Endpoint> {
    Endpoint::named(&format!("api-{name}"))
}

/// What an [`ApiHandler`] answers: the `result` of the call, or an error.
pub type ApiFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, ApiError>> + Send + 'a>>;

/// Does what a validated call asks. Called only for connections that authenticated, with
/// parameters that already passed [`protocol::parse_call`], so it never sees a malformed call.
/// It may be called from several connections at once.
pub trait ApiHandler: Send + Sync + 'static {
    fn handle(&self, call: ApiCall) -> ApiFuture<'_>;
}

/// Timings and limits of an [`ApiServer`].
#[derive(Debug, Clone)]
pub struct ApiConfig {
    pub handshake_timeout: Duration,
    pub request_timeout: Duration,
    pub max_connections: usize,
    /// How many events may wait for one subscribed client; at least 1.
    pub event_queue: usize,
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            max_connections: 32,
            event_queue: 64,
        }
    }
}

/// A running API server. Dropping it shuts it down.
pub struct ApiServer {
    endpoint: Endpoint,
    shutdown: CancellationToken,
    thread: Option<JoinHandle<()>>,
    publisher: EventPublisher,
}

impl ApiServer {
    /// Binds `endpoint` and starts serving on a thread of its own. Returns once the endpoint is
    /// ready, or with the reason it could not be bound (a name in use, a folder that is not
    /// private...). `token` is the secret clients must present; see [`load_or_create_token`].
    pub fn start(
        endpoint: Endpoint,
        token: ApiToken,
        handler: Arc<dyn ApiHandler>,
        config: ApiConfig,
    ) -> io::Result<Self> {
        let shutdown = CancellationToken::new();
        let hub = Hub::new(config.event_queue);
        let publisher = EventPublisher::new(Arc::clone(&hub));
        let context = Arc::new(Context {
            token,
            handler,
            config,
            hub,
        });
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<io::Result<()>>();
        let thread = thread::Builder::new().name("noren-api".into()).spawn({
            let endpoint = endpoint.clone();
            let shutdown = shutdown.clone();
            move || run(&endpoint, context, shutdown, &ready_tx)
        })?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                endpoint,
                shutdown,
                thread: Some(thread),
                publisher,
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(io::Error::other("the API thread ended before it was ready"))
            }
        }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// The way to push events to the clients that subscribed. Clone it and give it to whatever
    /// owns the sessions; it keeps working (and does nothing) after the server stops.
    pub fn publisher(&self) -> EventPublisher {
        self.publisher.clone()
    }

    /// Stops accepting, closes every connection and waits for the thread. Does nothing the
    /// second time.
    pub fn shutdown(&mut self) {
        self.shutdown.cancel();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for ApiServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Everything the connection tasks share.
struct Context {
    token: ApiToken,
    handler: Arc<dyn ApiHandler>,
    config: ApiConfig,
    hub: Arc<Hub>,
}

fn run(
    endpoint: &Endpoint,
    context: Arc<Context>,
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
    runtime.block_on(serve(listener, context, shutdown));
}

async fn serve(mut listener: Listener, context: Arc<Context>, shutdown: CancellationToken) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok(stream) => {
                    if connections.len() >= context.config.max_connections {
                        drop(stream);
                    } else {
                        connections.spawn(serve_connection(
                            stream,
                            Arc::clone(&context),
                            shutdown.clone(),
                        ));
                    }
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

/// What the writer of a connection is asked to send.
enum Outgoing {
    /// An answer or an error.
    Payload(Vec<u8>),
    /// The answer to `events.subscribe`, then the events that were queued for the new filter.
    Subscribed { payload: Vec<u8>, feed: Feed },
}

/// Takes the connection out of the list of subscribers when its task ends, however it ends.
struct Registration {
    hub: Arc<Hub>,
    connection: u64,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.hub.unsubscribe(self.connection);
    }
}

/// One connection, from the first message to the close. Never panics on what a client sends.
///
/// After the authentication two things run side by side: one reads requests and runs them one at
/// a time, and one writes to the client everything that is due (the answers in the order they
/// were made, and the events of the subscription). Only the second touches the stream for
/// writing, so a frame is never cut by another, and a client that does not read stops only its
/// own connection.
async fn serve_connection<S>(stream: S, context: Arc<Context>, shutdown: CancellationToken)
where
    S: AsyncRead + AsyncWrite + Send + Unpin,
{
    let (mut reader, mut writer) = split(stream);
    if authenticate(&mut reader, &mut writer, &context)
        .await
        .is_none()
    {
        let _ = writer.shutdown().await;
        return;
    }
    let registration = Registration {
        hub: Arc::clone(&context.hub),
        connection: context.hub.next_connection_id(),
    };
    {
        let (out, queue) = mpsc::channel(4);
        let requests = read_requests(
            &mut reader,
            out,
            &context,
            &shutdown,
            registration.connection,
        );
        let writing = write_outgoing(&mut writer, queue);
        tokio::pin!(requests, writing);
        tokio::select! {
            () = &mut requests => {
                // The sender is gone: let the writer finish what is already queued.
                let _ = tokio::time::timeout(CLOSE_DRAIN, &mut writing).await;
            }
            _ = &mut writing => {}
        }
    }
    drop(registration);
    let _ = writer.shutdown().await;
}

/// Reads the requests of an authenticated connection until it ends, answering through `out`.
async fn read_requests<R>(
    reader: &mut R,
    out: mpsc::Sender<Outgoing>,
    context: &Arc<Context>,
    shutdown: &CancellationToken,
    connection: u64,
) where
    R: AsyncRead + Unpin,
{
    loop {
        let payload = tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            frame = read_frame(reader) => match frame {
                Ok(payload) => payload,
                Err(e) => {
                    if let Some(error) = frame_error(&e) {
                        let _ = out
                            .send(Outgoing::Payload(protocol::error_payload(None, &error)))
                            .await;
                    }
                    break;
                }
            },
        };
        let outgoing = match protocol::parse_client_request(&payload) {
            Err((id, error)) => Outgoing::Payload(protocol::error_payload(id, &error)),
            Ok((id, ClientRequest::Call(call))) => {
                Outgoing::Payload(dispatch(context, id, call).await)
            }
            Ok((id, ClientRequest::Subscribe(filter))) => {
                // Registered before the answer is sent, so an event published once the client
                // has the answer is never missed; the events wait behind the answer.
                let payload = protocol::result_payload(id, &filter.result());
                let feed = context.hub.subscribe(connection, filter);
                Outgoing::Subscribed { payload, feed }
            }
        };
        if out.send(outgoing).await.is_err() {
            break;
        }
    }
}

/// Writes answers and events to the client until the answers are over (the reading side ended)
/// or a write fails.
async fn write_outgoing<W>(writer: &mut W, mut queue: mpsc::Receiver<Outgoing>) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut feed: Option<Feed> = None;
    loop {
        tokio::select! {
            // Answers first, so they keep their order against a stream of events.
            biased;
            outgoing = queue.recv() => match outgoing {
                None => return Ok(()),
                Some(Outgoing::Payload(payload)) => send_payload(writer, &payload).await?,
                Some(Outgoing::Subscribed { payload, feed: new }) => {
                    send_payload(writer, &payload).await?;
                    feed = Some(new);
                }
            },
            event = next_event(&mut feed) => match event {
                // The queue of an old subscription ended: a new one is on its way, or the
                // connection is closing.
                None => feed = None,
                Some(event) => {
                    if let Some(feed) = &feed {
                        send_event(writer, feed, &event).await?;
                    }
                }
            },
        }
    }
}

/// The next queued event, or never when there is no subscription.
async fn next_event(feed: &mut Option<Feed>) -> Option<ApiEvent> {
    match feed {
        Some(feed) => feed.events.recv().await,
        None => std::future::pending().await,
    }
}

/// Sends one event, then, if the queue has emptied and events were left out, says how many.
async fn send_event<W>(writer: &mut W, feed: &Feed, event: &ApiEvent) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let payload = event.payload();
    if payload.len() > MAX_FRAME_BYTES {
        // Only a session id past all reason makes an event that big (the text is cut before).
        feed.note_missed();
    } else {
        send_payload(writer, &payload).await?;
    }
    if feed.events.is_empty() {
        let missed = feed.take_dropped();
        if missed > 0 {
            send_payload(writer, &events::dropped_payload(missed)).await?;
        }
    }
    Ok(())
}

/// The first message: `Some(())` when the client may go on. Every other outcome has sent its
/// error already, and the handler was not called.
async fn authenticate<R, W>(reader: &mut R, writer: &mut W, context: &Context) -> Option<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let first = tokio::time::timeout(context.config.handshake_timeout, read_frame(reader)).await;
    let payload = match first {
        Err(_) => {
            let error = ApiError::new(ApiErrorCode::Timeout, "no authentication arrived in time");
            let _ = send_error(writer, None, &error).await;
            return None;
        }
        Ok(Ok(payload)) => payload,
        Ok(Err(e)) => {
            if let Some(error) = frame_error(&e) {
                let _ = send_error(writer, None, &error).await;
            }
            return None;
        }
    };
    let auth = match protocol::parse_auth(&payload) {
        Ok(auth) => auth,
        Err(error) => {
            let _ = send_error(writer, None, &error).await;
            return None;
        }
    };
    if auth.version != API_PROTOCOL_VERSION {
        let error = ApiError::new(
            ApiErrorCode::UnsupportedVersion,
            format!("this server speaks version {API_PROTOCOL_VERSION}"),
        );
        let _ = send_error(writer, None, &error).await;
        return None;
    }
    if !context.token.matches_hex(&auth.token) {
        let error = ApiError::new(ApiErrorCode::Unauthorized, "the token is not right");
        let _ = send_error(writer, None, &error).await;
        return None;
    }
    send_payload(writer, &protocol::welcome_payload())
        .await
        .ok()
}

/// Runs one call on the handler, in a task of its own so a handler that panics fails that
/// request and not the connection, and under the time limit.
async fn dispatch(context: &Arc<Context>, id: u64, call: ApiCall) -> Vec<u8> {
    let handler = Arc::clone(&context.handler);
    let mut task = tokio::spawn(async move { handler.handle(call).await });
    let outcome = match tokio::time::timeout(context.config.request_timeout, &mut task).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err(ApiError::new(
            ApiErrorCode::Internal,
            "the handler failed while it ran the call",
        )),
        Err(_) => {
            task.abort();
            Err(ApiError::new(
                ApiErrorCode::Timeout,
                "the call took too long",
            ))
        }
    };
    let answer = match &outcome {
        Ok(result) => protocol::result_payload(id, result),
        Err(error) => protocol::error_payload(Some(id), error),
    };
    if answer.len() > MAX_FRAME_BYTES {
        let error = ApiError::new(ApiErrorCode::Internal, "the answer is too big to send");
        return protocol::error_payload(Some(id), &error);
    }
    answer
}

/// The error to send for a frame that could not be read, or `None` when there is nobody to tell
/// (the other side left or the stream broke).
fn frame_error(error: &FrameError) -> Option<ApiError> {
    match error {
        FrameError::Closed | FrameError::Io(_) => None,
        FrameError::Protocol(ProtocolError::FrameTooLarge { max, .. }) => Some(ApiError::new(
            ApiErrorCode::FrameTooLarge,
            format!("a message may have at most {max} bytes"),
        )),
        FrameError::Protocol(e) => Some(ApiError::new(
            ApiErrorCode::InvalidRequest,
            format!("the message is not a frame: {e}"),
        )),
    }
}

async fn send_error<W>(writer: &mut W, id: Option<u64>, error: &ApiError) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    send_payload(writer, &protocol::error_payload(id, error)).await
}

async fn send_payload<W>(writer: &mut W, payload: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let frame = to_frame(payload).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_frame(writer, &frame).await
}

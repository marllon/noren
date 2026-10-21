//! The local API: a server that lets a program on this machine, running as the current user, ask
//! Noren to do what a person does in the window (list and create spaces, open items and splits,
//! type into a terminal, read its buffer). This module is the transport and the rules of the
//! conversation; what a request does is the job of an [`ApiHandler`], which the app supplies.
//!
//! - [`protocol`]: the versioned messages (pure, no I/O) and the check of every parameter.
//! - [`token`]: the secret the first message of a connection must carry, kept in a file of the
//!   user.
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
//!
//! A connection serves one request at a time, in order; connections run side by side. A request
//! that is invalid (bad JSON, unknown method, wrong parameters) gets an error and the connection
//! stays open; an authentication that fails, a request before the authentication and a frame
//! that cannot be read get an error and the connection is closed.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, split};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::daemon::frame::{FrameError, read_frame, write_frame};
use crate::daemon::ipc::{Endpoint, Listener};
use crate::daemon::protocol::{MAX_FRAME_BYTES, ProtocolError};

pub mod protocol;
mod token;

pub use protocol::{
    API_PROTOCOL_VERSION, ApiCall, ApiError, ApiErrorCode, ApiMethod, SplitDirection, to_frame,
};
pub use token::{ApiToken, TOKEN_BYTES, TOKEN_HEX_CHARS, TokenOrigin, load_or_create_token};

/// The name of the endpoint a normal installation uses.
pub const DEFAULT_API_NAME: &str = "default";

/// Pause after a failed accept, so a persistent failure does not spin.
const ACCEPT_RETRY: Duration = Duration::from_millis(200);

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
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            handshake_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(30),
            max_connections: 32,
        }
    }
}

/// A running API server. Dropping it shuts it down.
pub struct ApiServer {
    endpoint: Endpoint,
    shutdown: CancellationToken,
    thread: Option<JoinHandle<()>>,
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
        let context = Arc::new(Context {
            token,
            handler,
            config,
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

/// One connection, from the first message to the close. Never panics on what a client sends.
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
    loop {
        let payload = tokio::select! {
            biased;
            () = shutdown.cancelled() => break,
            frame = read_frame(&mut reader) => match frame {
                Ok(payload) => payload,
                Err(e) => {
                    if let Some(error) = frame_error(&e) {
                        let _ = send_error(&mut writer, None, &error).await;
                    }
                    break;
                }
            },
        };
        let answer = match protocol::parse_request(&payload) {
            Err((id, error)) => protocol::error_payload(id, &error),
            Ok((id, call)) => dispatch(&context, id, call).await,
        };
        if send_payload(&mut writer, &answer).await.is_err() {
            break;
        }
    }
    let _ = writer.shutdown().await;
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

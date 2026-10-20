//! A server that holds terminal sessions and a client that comes and goes: the base of sessions
//! that outlive the window.
//!
//! The sessions are [`SessionManager`](crate::pty::SessionManager) sessions, living in the
//! process of the [`Daemon`]. A [`DaemonClient`] reaches it over local IPC (a named pipe on
//! Windows, a Unix domain socket elsewhere; both closed to every user but the current one, see
//! [`ipc`]) and can create a session, write to it, resize it, attach to it to receive its output,
//! detach, attach again later (possibly from another process, after the first one is gone) and
//! get back the output the session kept meanwhile, and kill it. Two clients may be attached to
//! the same session.
//!
//! - [`protocol`]: the versioned wire format (pure, no I/O).
//! - [`frame`]: reads and writes its frames on an async stream.
//! - [`ipc`]: where the daemon listens and how a client connects.
//! - [`Daemon`] and [`ServerConfig`]: the server.
//! - [`DaemonClient`]: the client, over the local endpoint or over any async stream.
//! - [`SshTarget`]: a daemon on another machine, reached through the `ssh` of the system running
//!   `norend --bridge`.
//! - [`ReconnectingClient`]: a client whose connection may break and come back, with the sessions
//!   attached again by their ids.
//!
//! ## Limits
//!
//! | What | Limit |
//! | --- | --- |
//! | One frame | [`protocol::MAX_FRAME_BYTES`] (2 MiB); a bigger length is refused unread |
//! | Output kept per session | [`ServerConfig::buffer_bytes`], 1 MiB by default and never more than [`protocol::MAX_BUFFER_BYTES`] |
//! | Sessions | [`ServerConfig::max_sessions`], 256 by default |
//! | Frames queued for one client | [`ServerConfig::client_queue_frames`], 128 by default; a client that falls behind is disconnected |
//! | Time to say `Hello` | [`ServerConfig::handshake_timeout`], 5 s by default |
//!
//! ## What is not here
//!
//! The daemon does not start itself; the executable that runs it is the `norend` crate, which the
//! app starts when none answers (see `docs/DAEMON.md`). A session buffer is bytes, not the state of a terminal: after it
//! wrapped, a replay can begin in the middle of an escape sequence, and a program on the
//! alternate screen is not redrawn by it. The client does not check who owns the pipe it opens on
//! Windows (the name carries the user's SID and the daemon creates the first instance, so another
//! user would have to take the name before the daemon starts).

use std::sync::{Mutex, MutexGuard};

mod client;
pub mod frame;
pub mod ipc;
pub mod protocol;
mod reconnect;
mod ring;
mod server;
mod ssh;

pub use client::{
    Attached, ClientError, ClientEvent, ClientEvents, Created, DaemonClient, HANDSHAKE_TIMEOUT,
};
pub use frame::{FrameError, read_frame, write_frame};
pub use ipc::Endpoint;
pub use protocol::{
    ClientMessage, ErrorBody, ErrorCode, PROTOCOL_VERSION, ProtocolError, Request, Response,
    ServerMessage, SessionInfo,
};
pub use reconnect::{
    BackoffPolicy, ConnectFailure, Connector, Established, LinkEvent, LinkEvents, LinkState,
    ReconnectingClient, Transport,
};
pub use ring::ByteRing;
pub use server::{
    DEFAULT_BUFFER_BYTES, DEFAULT_CLIENT_QUEUE_FRAMES, DEFAULT_HANDSHAKE_TIMEOUT,
    DEFAULT_MAX_SESSIONS, Daemon, ServerConfig, ShutdownRequested,
};
pub use ssh::{
    DEFAULT_CONNECT_TIMEOUT, DEFAULT_REMOTE_PROGRAM, DEFAULT_SSH_HANDSHAKE_TIMEOUT, SshError,
    SshFailure, SshLink, SshTarget, default_ssh_program,
};

/// Locks a mutex, taking the data back from a thread that panicked while holding it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

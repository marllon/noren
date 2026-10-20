//! The wire protocol of the session daemon: frames, messages and their binary encoding. Pure (no
//! I/O, no runtime), so everything here is tested with plain byte slices.
//!
//! ## Frames
//!
//! Everything on the wire is a frame: a 4-byte big-endian length, then that many bytes of
//! payload. The length counts the payload only, is never zero and never above
//! [`MAX_FRAME_BYTES`]; a reader refuses a bigger length before it reads (or allocates) anything
//! else. The first byte of a payload is a tag that names the message, and the fields follow in
//! the order the type declares them: integers big-endian, a byte string or a text as a 4-byte
//! length and the bytes (a text is UTF-8), an optional value as a 0 or 1 byte and then the value,
//! a list as a 4-byte count and the items. A message must use its whole payload: bytes left over
//! are an error, and so is a payload that ends early.
//!
//! ## Conversation
//!
//! The client opens with [`ClientMessage::Hello`] carrying the protocol version it speaks. The
//! daemon answers [`ServerMessage::Welcome`] when the versions are the same, or
//! [`ServerMessage::Error`] with [`ErrorCode::VersionMismatch`] and closes the connection. The
//! `Hello` frame is the one layout that never changes, whatever the version: the tag and the
//! version first, and a reader ignores anything after them, so a future version can add fields to
//! it and an old daemon still refuses it with a message that says which version it speaks.
//!
//! After the handshake the client sends [`Request`]s, each with an id of its choosing, and the
//! daemon answers each with a [`ServerMessage::Response`] carrying the same id. Output and exit
//! events of the sessions a client is attached to arrive between the responses, tagged with the
//! session. Any frame the daemon cannot read ends the conversation with a
//! [`ServerMessage::Error`] (code [`ErrorCode::Protocol`]) and a closed connection.
//!
//! ## Changing it
//!
//! Adding, removing or changing a message, a field or a tag changes the protocol: raise
//! [`PROTOCOL_VERSION`]. The daemon and the client of one version accept only that version.

use std::fmt;
use std::path::PathBuf;

use crate::pty::{ExitInfo, SessionId, SpawnSpec};

/// The version of this protocol. The daemon refuses a client that speaks another one.
pub const PROTOCOL_VERSION: u32 = 1;

/// Largest payload of one frame. A reader refuses a frame that announces more, and a writer
/// refuses to build one.
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

/// Largest buffer of output a session may keep for a client that attaches later. It is a
/// ceiling on the daemon's configuration, and it is what makes the whole buffer fit in the one
/// frame that answers an attach.
pub const MAX_BUFFER_BYTES: usize = 1024 * 1024;

/// Largest piece of input the client library sends in one request; a longer write is split.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;

/// The length prefix of a frame.
pub const FRAME_HEADER_BYTES: usize = 4;

const _: () = assert!(MAX_BUFFER_BYTES + 4096 <= MAX_FRAME_BYTES);
const _: () = assert!(MAX_WRITE_BYTES + 4096 <= MAX_FRAME_BYTES);

mod tag {
    pub const HELLO: u8 = 0x01;
    pub const CREATE: u8 = 0x10;
    pub const WRITE: u8 = 0x11;
    pub const RESIZE: u8 = 0x12;
    pub const ATTACH: u8 = 0x13;
    pub const DETACH: u8 = 0x14;
    pub const KILL: u8 = 0x15;
    pub const LIST: u8 = 0x16;

    pub const WELCOME: u8 = 0x81;
    pub const CONNECTION_ERROR: u8 = 0x82;
    pub const OK: u8 = 0x90;
    pub const CREATED: u8 = 0x91;
    pub const ATTACHED: u8 = 0x92;
    pub const SESSIONS: u8 = 0x93;
    pub const REQUEST_ERROR: u8 = 0x94;
    pub const OUTPUT: u8 = 0xA0;
    pub const EXIT: u8 = 0xA1;
}

/// Why a frame or a message could not be built or read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    /// A frame with a length of zero.
    EmptyFrame,
    /// A frame longer than [`MAX_FRAME_BYTES`] (announced by a reader, or about to be built).
    FrameTooLarge { len: usize, max: usize },
    /// The bytes ended before the frame or the message did.
    Truncated,
    /// The message ended before the payload did.
    TrailingBytes,
    /// A tag that names no message.
    UnknownTag(u8),
    /// An error code that names no error.
    UnknownCode(u8),
    /// A text that is not UTF-8.
    InvalidUtf8,
    /// A flag byte that is neither 0 nor 1.
    InvalidFlag(u8),
    /// A list that announces more items than the bytes left could hold.
    TooMany { count: usize },
    /// A working directory that is not valid UTF-8, so it cannot be sent as text.
    NonUtf8Path,
    /// A message that is valid but not what the conversation expects at this point.
    Unexpected(&'static str),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => write!(f, "empty frame"),
            Self::FrameTooLarge { len, max } => {
                write!(f, "frame of {len} bytes is over the limit of {max}")
            }
            Self::Truncated => write!(f, "truncated frame"),
            Self::TrailingBytes => write!(f, "bytes left over after the message"),
            Self::UnknownTag(tag) => write!(f, "unknown message tag {tag:#04x}"),
            Self::UnknownCode(code) => write!(f, "unknown error code {code}"),
            Self::InvalidUtf8 => write!(f, "text that is not UTF-8"),
            Self::InvalidFlag(flag) => write!(f, "invalid flag byte {flag}"),
            Self::TooMany { count } => write!(f, "a list of {count} items does not fit the frame"),
            Self::NonUtf8Path => write!(f, "the folder is not valid UTF-8"),
            Self::Unexpected(what) => write!(f, "unexpected message: {what}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// What went wrong, as a code that is stable across the versions of the protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ErrorCode {
    /// A frame or a message that could not be read, or one sent out of turn.
    Protocol = 1,
    /// The client speaks another protocol version.
    VersionMismatch = 2,
    /// No session has this id (never created, or already killed).
    UnknownSession = 3,
    /// The session's process already ended, so there is nothing to write to.
    SessionClosed = 4,
    /// A terminal size with a zero side.
    InvalidSize = 5,
    /// The pseudo terminal or the process could not be started.
    Spawn = 6,
    /// Writing, resizing or killing failed in the system.
    Io = 7,
    /// The daemon holds as many sessions as it allows.
    TooManySessions = 8,
    /// The daemon is going down.
    ShuttingDown = 9,
    /// A bug or a failure of the daemon itself.
    Internal = 10,
}

impl ErrorCode {
    fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            1 => Self::Protocol,
            2 => Self::VersionMismatch,
            3 => Self::UnknownSession,
            4 => Self::SessionClosed,
            5 => Self::InvalidSize,
            6 => Self::Spawn,
            7 => Self::Io,
            8 => Self::TooManySessions,
            9 => Self::ShuttingDown,
            10 => Self::Internal,
            _ => return None,
        })
    }

    /// A short name for logs and messages.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Protocol => "protocol error",
            Self::VersionMismatch => "version mismatch",
            Self::UnknownSession => "unknown session",
            Self::SessionClosed => "session closed",
            Self::InvalidSize => "invalid size",
            Self::Spawn => "could not start",
            Self::Io => "i/o error",
            Self::TooManySessions => "too many sessions",
            Self::ShuttingDown => "shutting down",
            Self::Internal => "internal error",
        }
    }
}

/// An error as the daemon reports it: a code and a sentence a person can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

impl ErrorBody {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ErrorBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

/// What a client may ask of the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// Start a process in a new session. Answered with [`Response::Created`]. The session lives
    /// in the daemon until it is killed, whether anyone is attached or not.
    Create(SpawnSpec),
    /// Send bytes to the terminal input of a session. A connection need not be attached.
    Write { session: SessionId, data: Vec<u8> },
    /// Change the terminal size of a session.
    Resize {
        session: SessionId,
        cols: u16,
        rows: u16,
    },
    /// Start receiving the output of a session. The answer carries the buffer the session kept,
    /// and every output after it arrives as an event; nothing is lost or repeated in between.
    Attach { session: SessionId },
    /// Stop receiving the output of a session. The session goes on and keeps its buffer. A
    /// connection that was not attached gets `Ok` too: the wish is already true.
    Detach { session: SessionId },
    /// End the process of a session if it still runs and release the session.
    Kill { session: SessionId },
    /// The sessions the daemon holds.
    List,
}

/// What the client says: the greeting, then requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    Hello { version: u32 },
    Request { id: u32, request: Request },
}

/// A session as `List` describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub session: SessionId,
    /// The pid of the process of the session, when the system gave one.
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    /// How many connections are attached to it now.
    pub attached: u32,
    /// How many bytes of output the daemon holds for it.
    pub buffered: u32,
    /// How the process ended; `None` while it runs.
    pub exit: Option<ExitInfo>,
}

/// The answer to a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    Ok,
    Created {
        session: SessionId,
        pid: Option<u32>,
    },
    Attached {
        /// The output the session kept (its latest bytes, at most the buffer size).
        replay: Vec<u8>,
        /// How the process ended, when it already has.
        exit: Option<ExitInfo>,
    },
    Sessions(Vec<SessionInfo>),
    Error(ErrorBody),
}

/// What the daemon says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerMessage {
    /// The handshake succeeded.
    Welcome {
        version: u32,
    },
    /// The conversation cannot go on (a version the daemon does not speak, a frame it cannot
    /// read). The daemon closes the connection after it.
    Error(ErrorBody),
    Response {
        id: u32,
        response: Response,
    },
    /// Output of a session the connection is attached to.
    Output {
        session: SessionId,
        data: Vec<u8>,
    },
    /// The process of a session the connection is attached to ended. Last event of that session.
    Exit {
        session: SessionId,
        info: ExitInfo,
    },
}

/// Reads the length prefix of a frame. A length of zero or above [`MAX_FRAME_BYTES`] is an
/// error, so the caller never reads (or allocates) a payload it will not accept.
pub fn parse_frame_len(header: [u8; FRAME_HEADER_BYTES]) -> Result<usize, ProtocolError> {
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 {
        Err(ProtocolError::EmptyFrame)
    } else if len > MAX_FRAME_BYTES {
        Err(ProtocolError::FrameTooLarge {
            len,
            max: MAX_FRAME_BYTES,
        })
    } else {
        Ok(len)
    }
}

impl ClientMessage {
    /// The whole frame (length prefix and payload).
    pub fn to_frame(&self) -> Result<Vec<u8>, ProtocolError> {
        match self {
            Self::Hello { version } => {
                let mut w = Writer::new(tag::HELLO);
                w.u32(*version);
                w.finish()
            }
            Self::Request { id, request } => match request {
                Request::Create(spec) => {
                    let mut w = Writer::new(tag::CREATE);
                    w.u32(*id);
                    w.text(&spec.program);
                    w.count(spec.args.len());
                    for arg in &spec.args {
                        w.text(arg);
                    }
                    match &spec.cwd {
                        Some(cwd) => {
                            w.u8(1);
                            w.text(cwd.to_str().ok_or(ProtocolError::NonUtf8Path)?);
                        }
                        None => w.u8(0),
                    }
                    w.count(spec.env.len());
                    for (key, value) in &spec.env {
                        w.text(key);
                        w.text(value);
                    }
                    w.u16(spec.cols);
                    w.u16(spec.rows);
                    w.finish()
                }
                Request::Write { session, data } => {
                    let mut w = Writer::new(tag::WRITE);
                    w.u32(*id);
                    w.u64(session.0);
                    w.bytes(data);
                    w.finish()
                }
                Request::Resize {
                    session,
                    cols,
                    rows,
                } => {
                    let mut w = Writer::new(tag::RESIZE);
                    w.u32(*id);
                    w.u64(session.0);
                    w.u16(*cols);
                    w.u16(*rows);
                    w.finish()
                }
                Request::Attach { session } => session_request(tag::ATTACH, *id, *session),
                Request::Detach { session } => session_request(tag::DETACH, *id, *session),
                Request::Kill { session } => session_request(tag::KILL, *id, *session),
                Request::List => {
                    let mut w = Writer::new(tag::LIST);
                    w.u32(*id);
                    w.finish()
                }
            },
        }
    }

    /// Reads a payload (without the length prefix).
    pub fn decode(payload: &[u8]) -> Result<Self, ProtocolError> {
        let mut r = Reader::new(payload);
        let message = match r.u8()? {
            // The one frame that is read leniently: see the module documentation.
            tag::HELLO => return Ok(Self::Hello { version: r.u32()? }),
            tag::CREATE => request(&mut r, |r| {
                let program = r.text()?;
                let mut args = Vec::new();
                for _ in 0..r.count(4)? {
                    args.push(r.text()?);
                }
                let cwd = if r.flag()? {
                    Some(PathBuf::from(r.text()?))
                } else {
                    None
                };
                let mut env = Vec::new();
                for _ in 0..r.count(8)? {
                    env.push((r.text()?, r.text()?));
                }
                let cols = r.u16()?;
                let rows = r.u16()?;
                Ok(Request::Create(SpawnSpec {
                    program,
                    args,
                    cwd,
                    env,
                    cols,
                    rows,
                }))
            })?,
            tag::WRITE => request(&mut r, |r| {
                Ok(Request::Write {
                    session: r.session()?,
                    data: r.bytes()?.to_vec(),
                })
            })?,
            tag::RESIZE => request(&mut r, |r| {
                Ok(Request::Resize {
                    session: r.session()?,
                    cols: r.u16()?,
                    rows: r.u16()?,
                })
            })?,
            tag::ATTACH => request(&mut r, |r| {
                Ok(Request::Attach {
                    session: r.session()?,
                })
            })?,
            tag::DETACH => request(&mut r, |r| {
                Ok(Request::Detach {
                    session: r.session()?,
                })
            })?,
            tag::KILL => request(&mut r, |r| {
                Ok(Request::Kill {
                    session: r.session()?,
                })
            })?,
            tag::LIST => request(&mut r, |_| Ok(Request::List))?,
            other => return Err(ProtocolError::UnknownTag(other)),
        };
        r.finish()?;
        Ok(message)
    }
}

fn session_request(tag: u8, id: u32, session: SessionId) -> Result<Vec<u8>, ProtocolError> {
    let mut w = Writer::new(tag);
    w.u32(id);
    w.u64(session.0);
    w.finish()
}

fn request(
    r: &mut Reader<'_>,
    read: impl FnOnce(&mut Reader<'_>) -> Result<Request, ProtocolError>,
) -> Result<ClientMessage, ProtocolError> {
    let id = r.u32()?;
    Ok(ClientMessage::Request {
        id,
        request: read(r)?,
    })
}

impl ServerMessage {
    /// The whole frame (length prefix and payload).
    pub fn to_frame(&self) -> Result<Vec<u8>, ProtocolError> {
        match self {
            Self::Welcome { version } => {
                let mut w = Writer::new(tag::WELCOME);
                w.u32(*version);
                w.finish()
            }
            Self::Error(body) => {
                let mut w = Writer::new(tag::CONNECTION_ERROR);
                w.error(body);
                w.finish()
            }
            Self::Response { id, response } => match response {
                Response::Ok => {
                    let mut w = Writer::new(tag::OK);
                    w.u32(*id);
                    w.finish()
                }
                Response::Created { session, pid } => {
                    let mut w = Writer::new(tag::CREATED);
                    w.u32(*id);
                    w.u64(session.0);
                    w.option_u32(*pid);
                    w.finish()
                }
                Response::Attached { replay, exit } => {
                    let mut w = Writer::new(tag::ATTACHED);
                    w.u32(*id);
                    w.bytes(replay);
                    w.exit_option(exit.as_ref());
                    w.finish()
                }
                Response::Sessions(sessions) => {
                    let mut w = Writer::new(tag::SESSIONS);
                    w.u32(*id);
                    w.count(sessions.len());
                    for info in sessions {
                        w.u64(info.session.0);
                        w.option_u32(info.pid);
                        w.u16(info.cols);
                        w.u16(info.rows);
                        w.u32(info.attached);
                        w.u32(info.buffered);
                        w.exit_option(info.exit.as_ref());
                    }
                    w.finish()
                }
                Response::Error(body) => {
                    let mut w = Writer::new(tag::REQUEST_ERROR);
                    w.u32(*id);
                    w.error(body);
                    w.finish()
                }
            },
            Self::Output { session, data } => {
                let mut w = Writer::new(tag::OUTPUT);
                w.u64(session.0);
                w.bytes(data);
                w.finish()
            }
            Self::Exit { session, info } => {
                let mut w = Writer::new(tag::EXIT);
                w.u64(session.0);
                w.exit(info);
                w.finish()
            }
        }
    }

    /// Reads a payload (without the length prefix).
    pub fn decode(payload: &[u8]) -> Result<Self, ProtocolError> {
        let mut r = Reader::new(payload);
        let message = match r.u8()? {
            tag::WELCOME => Self::Welcome { version: r.u32()? },
            tag::CONNECTION_ERROR => Self::Error(r.error()?),
            tag::OK => response(&mut r, |_| Ok(Response::Ok))?,
            tag::CREATED => response(&mut r, |r| {
                Ok(Response::Created {
                    session: r.session()?,
                    pid: r.option_u32()?,
                })
            })?,
            tag::ATTACHED => response(&mut r, |r| {
                Ok(Response::Attached {
                    replay: r.bytes()?.to_vec(),
                    exit: r.exit_option()?,
                })
            })?,
            tag::SESSIONS => response(&mut r, |r| {
                let mut sessions = Vec::new();
                // One item is at least 8 + 1 + 2 + 2 + 4 + 4 + 1 bytes.
                for _ in 0..r.count(22)? {
                    sessions.push(SessionInfo {
                        session: r.session()?,
                        pid: r.option_u32()?,
                        cols: r.u16()?,
                        rows: r.u16()?,
                        attached: r.u32()?,
                        buffered: r.u32()?,
                        exit: r.exit_option()?,
                    });
                }
                Ok(Response::Sessions(sessions))
            })?,
            tag::REQUEST_ERROR => response(&mut r, |r| Ok(Response::Error(r.error()?)))?,
            tag::OUTPUT => Self::Output {
                session: r.session()?,
                data: r.bytes()?.to_vec(),
            },
            tag::EXIT => Self::Exit {
                session: r.session()?,
                info: r.exit()?,
            },
            other => return Err(ProtocolError::UnknownTag(other)),
        };
        r.finish()?;
        Ok(message)
    }
}

fn response(
    r: &mut Reader<'_>,
    read: impl FnOnce(&mut Reader<'_>) -> Result<Response, ProtocolError>,
) -> Result<ServerMessage, ProtocolError> {
    let id = r.u32()?;
    Ok(ServerMessage::Response {
        id,
        response: read(r)?,
    })
}

/// Builds a frame: the length is filled in by `finish`.
struct Writer {
    /// The 4 bytes of the length prefix (still zero), then the payload.
    buf: Vec<u8>,
    /// The size the payload would have had, once it went over the limit.
    too_large: Option<usize>,
}

impl Writer {
    fn new(tag: u8) -> Self {
        let mut buf = vec![0u8; FRAME_HEADER_BYTES];
        buf.push(tag);
        Self {
            buf,
            too_large: None,
        }
    }

    fn payload_len(&self) -> usize {
        self.buf.len() - FRAME_HEADER_BYTES
    }

    fn u8(&mut self, value: u8) {
        self.buf.push(value);
    }

    fn u16(&mut self, value: u16) {
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    fn count(&mut self, count: usize) {
        self.u32(u32::try_from(count).unwrap_or(u32::MAX));
    }

    /// A byte string. Once the payload would pass the limit nothing more is written, so the
    /// buffer never grows past it and `finish` reports the size that was asked for.
    fn bytes(&mut self, data: &[u8]) {
        let wanted = self.payload_len() + 4 + data.len();
        if self.too_large.is_some() || wanted > MAX_FRAME_BYTES {
            self.too_large.get_or_insert(wanted);
            return;
        }
        self.count(data.len());
        self.buf.extend_from_slice(data);
    }

    fn text(&mut self, text: &str) {
        self.bytes(text.as_bytes());
    }

    fn option_u32(&mut self, value: Option<u32>) {
        match value {
            Some(value) => {
                self.u8(1);
                self.u32(value);
            }
            None => self.u8(0),
        }
    }

    fn exit(&mut self, info: &ExitInfo) {
        self.u32(info.code);
        match &info.signal {
            Some(signal) => {
                self.u8(1);
                self.text(signal);
            }
            None => self.u8(0),
        }
    }

    fn exit_option(&mut self, info: Option<&ExitInfo>) {
        match info {
            Some(info) => {
                self.u8(1);
                self.exit(info);
            }
            None => self.u8(0),
        }
    }

    fn error(&mut self, body: &ErrorBody) {
        self.u8(body.code as u8);
        self.text(&body.message);
    }

    fn finish(mut self) -> Result<Vec<u8>, ProtocolError> {
        let len = self.too_large.unwrap_or_else(|| self.payload_len());
        if len > MAX_FRAME_BYTES {
            return Err(ProtocolError::FrameTooLarge {
                len,
                max: MAX_FRAME_BYTES,
            });
        }
        let prefix = u32::try_from(len).unwrap_or(u32::MAX).to_be_bytes();
        self.buf[..FRAME_HEADER_BYTES].copy_from_slice(&prefix);
        Ok(self.buf)
    }
}

/// Reads fields from a payload; every read fails with `Truncated` when the bytes are short.
struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(payload: &'a [u8]) -> Self {
        Self { rest: payload }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], ProtocolError> {
        if self.rest.len() < len {
            return Err(ProtocolError::Truncated);
        }
        let (head, tail) = self.rest.split_at(len);
        self.rest = tail;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, ProtocolError> {
        let mut raw = [0u8; 2];
        raw.copy_from_slice(self.take(2)?);
        Ok(u16::from_be_bytes(raw))
    }

    fn u32(&mut self) -> Result<u32, ProtocolError> {
        let mut raw = [0u8; 4];
        raw.copy_from_slice(self.take(4)?);
        Ok(u32::from_be_bytes(raw))
    }

    fn u64(&mut self) -> Result<u64, ProtocolError> {
        let mut raw = [0u8; 8];
        raw.copy_from_slice(self.take(8)?);
        Ok(u64::from_be_bytes(raw))
    }

    fn session(&mut self) -> Result<SessionId, ProtocolError> {
        Ok(SessionId(self.u64()?))
    }

    fn bytes(&mut self) -> Result<&'a [u8], ProtocolError> {
        let len = self.u32()? as usize;
        self.take(len)
    }

    fn text(&mut self) -> Result<String, ProtocolError> {
        std::str::from_utf8(self.bytes()?)
            .map(str::to_owned)
            .map_err(|_| ProtocolError::InvalidUtf8)
    }

    fn flag(&mut self) -> Result<bool, ProtocolError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(ProtocolError::InvalidFlag(other)),
        }
    }

    /// The number of items of a list whose items take at least `min_item_bytes` each. A count the
    /// bytes left cannot hold is refused here, before anything is allocated for it.
    fn count(&mut self, min_item_bytes: usize) -> Result<usize, ProtocolError> {
        let count = self.u32()? as usize;
        if count > self.rest.len() / min_item_bytes {
            return Err(ProtocolError::TooMany { count });
        }
        Ok(count)
    }

    fn option_u32(&mut self) -> Result<Option<u32>, ProtocolError> {
        if self.flag()? {
            Ok(Some(self.u32()?))
        } else {
            Ok(None)
        }
    }

    fn exit(&mut self) -> Result<ExitInfo, ProtocolError> {
        let code = self.u32()?;
        let signal = if self.flag()? {
            Some(self.text()?)
        } else {
            None
        };
        Ok(ExitInfo { code, signal })
    }

    fn exit_option(&mut self) -> Result<Option<ExitInfo>, ProtocolError> {
        if self.flag()? {
            Ok(Some(self.exit()?))
        } else {
            Ok(None)
        }
    }

    fn error(&mut self) -> Result<ErrorBody, ProtocolError> {
        let raw = self.u8()?;
        let code = ErrorCode::from_u8(raw).ok_or(ProtocolError::UnknownCode(raw))?;
        Ok(ErrorBody {
            code,
            message: self.text()?,
        })
    }

    fn finish(self) -> Result<(), ProtocolError> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(ProtocolError::TrailingBytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SpawnSpec {
        SpawnSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "echo ünï".into()],
            cwd: Some(PathBuf::from("a folder/ünï")),
            env: vec![
                ("KEY".into(), "value".into()),
                (String::new(), String::new()),
            ],
            cols: 120,
            rows: 40,
        }
    }

    fn exit() -> ExitInfo {
        ExitInfo {
            code: 137,
            signal: Some("Killed".into()),
        }
    }

    fn client_samples() -> Vec<ClientMessage> {
        let session = SessionId(u64::MAX);
        let request = |request| ClientMessage::Request { id: 7, request };
        vec![
            ClientMessage::Hello {
                version: PROTOCOL_VERSION,
            },
            request(Request::Create(spec())),
            request(Request::Create(SpawnSpec {
                program: "x".into(),
                args: vec![],
                cwd: None,
                env: vec![],
                cols: 1,
                rows: 1,
            })),
            request(Request::Write {
                session,
                data: vec![0, 1, 2, 255],
            }),
            request(Request::Write {
                session,
                data: vec![],
            }),
            request(Request::Resize {
                session,
                cols: 80,
                rows: 24,
            }),
            request(Request::Attach { session }),
            request(Request::Detach { session }),
            request(Request::Kill { session }),
            request(Request::List),
        ]
    }

    fn server_samples() -> Vec<ServerMessage> {
        let session = SessionId(3);
        let response = |response| ServerMessage::Response { id: 9, response };
        vec![
            ServerMessage::Welcome {
                version: PROTOCOL_VERSION,
            },
            ServerMessage::Error(ErrorBody::new(ErrorCode::VersionMismatch, "version 2 only")),
            response(Response::Ok),
            response(Response::Created {
                session,
                pid: Some(4242),
            }),
            response(Response::Created { session, pid: None }),
            response(Response::Attached {
                replay: b"\x1b[1mhello\x1b[0m".to_vec(),
                exit: Some(exit()),
            }),
            response(Response::Attached {
                replay: vec![],
                exit: None,
            }),
            response(Response::Sessions(vec![])),
            response(Response::Sessions(vec![
                SessionInfo {
                    session,
                    pid: Some(1),
                    cols: 80,
                    rows: 24,
                    attached: 2,
                    buffered: 1000,
                    exit: None,
                },
                SessionInfo {
                    session: SessionId(4),
                    pid: None,
                    cols: 1,
                    rows: 1,
                    attached: 0,
                    buffered: 0,
                    exit: Some(ExitInfo {
                        code: 0,
                        signal: None,
                    }),
                },
            ])),
            response(Response::Error(ErrorBody::new(
                ErrorCode::UnknownSession,
                "unknown session 3",
            ))),
            ServerMessage::Output {
                session,
                data: vec![b'x'; 1000],
            },
            ServerMessage::Exit {
                session,
                info: exit(),
            },
        ]
    }

    fn payload_of(frame: &[u8]) -> &[u8] {
        let header: [u8; 4] = frame[..4].try_into().unwrap();
        let len = parse_frame_len(header).unwrap();
        assert_eq!(frame.len(), FRAME_HEADER_BYTES + len, "length prefix");
        &frame[FRAME_HEADER_BYTES..]
    }

    #[test]
    fn every_client_message_survives_the_round_trip() {
        for message in client_samples() {
            let frame = message.to_frame().unwrap();
            assert_eq!(ClientMessage::decode(payload_of(&frame)).unwrap(), message);
        }
    }

    #[test]
    fn every_server_message_survives_the_round_trip() {
        for message in server_samples() {
            let frame = message.to_frame().unwrap();
            assert_eq!(ServerMessage::decode(payload_of(&frame)).unwrap(), message);
        }
    }

    #[test]
    fn a_truncated_payload_is_an_error_at_every_cut() {
        for message in client_samples() {
            let frame = message.to_frame().unwrap();
            let payload = payload_of(&frame);
            for cut in 0..payload.len() {
                assert!(
                    ClientMessage::decode(&payload[..cut]).is_err(),
                    "{message:?} cut at {cut}"
                );
            }
        }
        for message in server_samples() {
            let frame = message.to_frame().unwrap();
            let payload = payload_of(&frame);
            for cut in 0..payload.len() {
                assert!(
                    ServerMessage::decode(&payload[..cut]).is_err(),
                    "{message:?} cut at {cut}"
                );
            }
        }
        assert_eq!(ClientMessage::decode(&[]), Err(ProtocolError::Truncated));
    }

    #[test]
    fn bytes_left_after_a_message_are_an_error() {
        for message in client_samples() {
            if matches!(message, ClientMessage::Hello { .. }) {
                continue;
            }
            let mut payload = payload_of(&message.to_frame().unwrap()).to_vec();
            payload.push(0);
            assert_eq!(
                ClientMessage::decode(&payload),
                Err(ProtocolError::TrailingBytes),
                "{message:?}"
            );
        }
        for message in server_samples() {
            let mut payload = payload_of(&message.to_frame().unwrap()).to_vec();
            payload.push(0);
            assert_eq!(
                ServerMessage::decode(&payload),
                Err(ProtocolError::TrailingBytes),
                "{message:?}"
            );
        }
    }

    #[test]
    fn the_hello_frame_is_read_whatever_follows_the_version() {
        // A client of a future version may add fields to the greeting; an old daemon must still
        // read the version so it can refuse the client by name.
        let mut payload = vec![tag::HELLO];
        payload.extend_from_slice(&99u32.to_be_bytes());
        payload.extend_from_slice(b"fields of a later version");
        assert_eq!(
            ClientMessage::decode(&payload),
            Ok(ClientMessage::Hello { version: 99 })
        );
    }

    #[test]
    fn the_length_prefix_has_a_floor_and_a_ceiling() {
        assert_eq!(
            parse_frame_len(0u32.to_be_bytes()),
            Err(ProtocolError::EmptyFrame)
        );
        assert_eq!(parse_frame_len(1u32.to_be_bytes()), Ok(1));
        let max = u32::try_from(MAX_FRAME_BYTES).unwrap();
        assert_eq!(parse_frame_len(max.to_be_bytes()), Ok(MAX_FRAME_BYTES));
        assert_eq!(
            parse_frame_len((max + 1).to_be_bytes()),
            Err(ProtocolError::FrameTooLarge {
                len: MAX_FRAME_BYTES + 1,
                max: MAX_FRAME_BYTES
            })
        );
        assert!(matches!(
            parse_frame_len(u32::MAX.to_be_bytes()),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
    }

    #[test]
    fn a_message_over_the_frame_limit_is_not_built() {
        let session = SessionId(1);
        let too_big = ClientMessage::Request {
            id: 1,
            request: Request::Write {
                session,
                data: vec![0; MAX_FRAME_BYTES],
            },
        };
        assert!(matches!(
            too_big.to_frame(),
            Err(ProtocolError::FrameTooLarge { .. })
        ));
        // The biggest write the client sends fits with room to spare.
        let biggest = ClientMessage::Request {
            id: 1,
            request: Request::Write {
                session,
                data: vec![0; MAX_WRITE_BYTES],
            },
        };
        assert!(biggest.to_frame().is_ok());
        // So does a full buffer in the answer to an attach.
        let attached = ServerMessage::Response {
            id: 1,
            response: Response::Attached {
                replay: vec![0; MAX_BUFFER_BYTES],
                exit: Some(exit()),
            },
        };
        assert!(attached.to_frame().is_ok());
    }

    #[test]
    fn an_unknown_tag_is_refused_before_anything_else_is_read() {
        assert_eq!(
            ClientMessage::decode(&[0x7f]),
            Err(ProtocolError::UnknownTag(0x7f))
        );
        assert_eq!(
            ServerMessage::decode(&[tag::CREATE, 0, 0, 0, 1]),
            Err(ProtocolError::UnknownTag(tag::CREATE))
        );
    }

    #[test]
    fn a_bad_text_flag_or_code_is_refused() {
        // Write { id, session, data } is fine; a Create whose program is not UTF-8 is not.
        let mut payload = vec![tag::CREATE, 0, 0, 0, 1, 0, 0, 0, 2, 0xff, 0xfe];
        assert_eq!(
            ClientMessage::decode(&payload),
            Err(ProtocolError::InvalidUtf8)
        );
        // program "x", no args, then a cwd flag of 7.
        payload = vec![tag::CREATE, 0, 0, 0, 1, 0, 0, 0, 1, b'x', 0, 0, 0, 0, 7];
        assert_eq!(
            ClientMessage::decode(&payload),
            Err(ProtocolError::InvalidFlag(7))
        );
        // A connection error with a code that does not exist.
        assert_eq!(
            ServerMessage::decode(&[tag::CONNECTION_ERROR, 200, 0, 0, 0, 0]),
            Err(ProtocolError::UnknownCode(200))
        );
    }

    #[test]
    fn a_list_that_cannot_fit_is_refused_without_allocating_it() {
        // A Create that claims four billion arguments in a dozen bytes.
        let mut payload = vec![tag::CREATE, 0, 0, 0, 1, 0, 0, 0, 1, b'x'];
        payload.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(matches!(
            ClientMessage::decode(&payload),
            Err(ProtocolError::TooMany { count }) if count == u32::MAX as usize
        ));
        // The same for the list of sessions.
        let mut payload = vec![tag::SESSIONS, 0, 0, 0, 1];
        payload.extend_from_slice(&1_000_000u32.to_be_bytes());
        assert!(matches!(
            ServerMessage::decode(&payload),
            Err(ProtocolError::TooMany { .. })
        ));
        // And a byte string that claims more than the payload holds.
        let mut payload = vec![tag::OUTPUT, 0, 0, 0, 0, 0, 0, 0, 1];
        payload.extend_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            ServerMessage::decode(&payload),
            Err(ProtocolError::Truncated)
        );
    }

    #[test]
    fn a_folder_that_is_not_text_cannot_be_sent() {
        #[cfg(unix)]
        let cwd = {
            use std::os::unix::ffi::OsStringExt;
            PathBuf::from(std::ffi::OsString::from_vec(vec![b'/', 0xff, 0xfe]))
        };
        #[cfg(windows)]
        let cwd = {
            use std::os::windows::ffi::OsStringExt;
            PathBuf::from(std::ffi::OsString::from_wide(&[u16::from(b'C'), 0xd800]))
        };
        let message = ClientMessage::Request {
            id: 1,
            request: Request::Create(SpawnSpec {
                cwd: Some(cwd),
                ..spec()
            }),
        };
        assert_eq!(message.to_frame(), Err(ProtocolError::NonUtf8Path));
    }

    /// Whatever bytes arrive, reading them returns a value or an error and never panics.
    #[test]
    fn arbitrary_and_mutated_bytes_never_panic() {
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let valid: Vec<Vec<u8>> = client_samples()
            .iter()
            .map(|m| payload_of(&m.to_frame().unwrap()).to_vec())
            .chain(
                server_samples()
                    .iter()
                    .map(|m| payload_of(&m.to_frame().unwrap()).to_vec()),
            )
            .collect();
        for round in 0..20_000 {
            let payload: Vec<u8> = if round % 2 == 0 {
                let len = (next() % 64) as usize;
                (0..len).map(|_| next() as u8).collect()
            } else {
                let mut payload = valid[(next() as usize) % valid.len()].clone();
                for _ in 0..=(next() % 3) {
                    let at = (next() as usize) % payload.len();
                    payload[at] = next() as u8;
                }
                payload
            };
            let _ = ClientMessage::decode(&payload);
            let _ = ServerMessage::decode(&payload);
        }
    }
}

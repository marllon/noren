//! PTY sessions on top of `portable-pty`, without any Tauri dependency.
//!
//! Each session owns three threads:
//!
//! - a **reader** that blocks on the PTY and forwards raw chunks over a bounded channel;
//! - a **pump** that batches those chunks (up to [`BATCH_MAX_BYTES`] or [`BATCH_MAX_DELAY`]
//!   after the first pending byte) and hands each batch to the session callback;
//! - a **waiter** that waits for the child, closes the PTY so the reader sees EOF (ConPTY does
//!   not report EOF while the master is alive), joins the other two threads and finally
//!   delivers [`SessionEvent::Exit`].
//!
//! The exit event is therefore always the last event of a session, after every output batch.

use std::collections::HashMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

/// Largest number of bytes delivered to the callback in one output batch.
pub const BATCH_MAX_BYTES: usize = 64 * 1024;
/// Longest time a byte waits before its batch is delivered.
pub const BATCH_MAX_DELAY: Duration = Duration::from_millis(8);

/// How long `kill` waits for the child to end after the OS reported a kill error.
const KILL_GRACE: Duration = Duration::from_secs(2);
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_REPORT: &[u8] = b"\x1b[1;1R";
/// The ConPTY startup query is expected within this many first output bytes.
const STARTUP_PROBE_BYTES: usize = 4096;
const READ_CHUNK_BYTES: usize = 32 * 1024;
/// Chunks in flight between reader and pump; bounds memory when the callback is slow.
const CHANNEL_CAPACITY: usize = 64;

/// Identifier of a session, unique within one [`SessionManager`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionId(pub u64);

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// What to run and how to size its terminal.
#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    /// Working directory; the current directory of the process when `None`.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables, applied on top of the inherited environment.
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// How a child ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    /// Exit code (`1` when the code could not be read).
    pub code: u32,
    /// Terminating signal name, when the child was killed by a signal (Unix).
    pub signal: Option<String>,
}

/// Events delivered to the session callback, always from a session thread.
#[derive(Debug)]
pub enum SessionEvent<'a> {
    /// A batch of terminal output (raw bytes, escape sequences included).
    Output(&'a [u8]),
    /// The child ended and all its output was delivered. Last event of a session.
    Exit(ExitInfo),
}

/// Errors returned by [`SessionManager`].
#[derive(Debug)]
pub enum PtyError {
    /// `cols` or `rows` was zero.
    InvalidSize { cols: u16, rows: u16 },
    /// The pseudo terminal could not be opened.
    Open(String),
    /// The child process could not be started.
    Spawn(String),
    /// No session has this id (never created, or already killed).
    UnknownSession(SessionId),
    /// The child already ended, so the PTY is closed.
    SessionClosed(SessionId),
    /// The PTY refused a resize.
    Resize(String),
    /// Writing to the PTY or killing the child failed.
    Io(std::io::Error),
}

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSize { cols, rows } => {
                write!(f, "invalid terminal size {cols}x{rows}")
            }
            Self::Open(e) => write!(f, "could not open a pseudo terminal: {e}"),
            Self::Spawn(e) => write!(f, "could not start the process: {e}"),
            Self::UnknownSession(id) => write!(f, "unknown session {id}"),
            Self::SessionClosed(id) => write!(f, "session {id} is closed"),
            Self::Resize(e) => write!(f, "could not resize the terminal: {e}"),
            Self::Io(e) => write!(f, "i/o error: {e}"),
        }
    }
}

impl std::error::Error for PtyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Counts live session threads: incremented when created, decremented when dropped.
struct ThreadGuard(Arc<AtomicUsize>);

impl ThreadGuard {
    fn new(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(counter))
    }
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Session {
    /// `None` once the child ended and the PTY was closed.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exited: AtomicBool,
    waiter: Mutex<Option<JoinHandle<()>>>,
}

/// Owns PTY sessions. Every session thread is joined before [`SessionManager::kill`] or
/// [`SessionManager::shutdown`] returns, and when the manager is dropped.
///
/// The session callback must not call `kill` or `shutdown` itself: they join the thread the
/// callback runs on.
pub struct SessionManager {
    sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
    next_id: AtomicU64,
    live_threads: Arc<AtomicUsize>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            live_threads: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Number of session threads (reader, pump, waiter) still running.
    pub fn live_threads(&self) -> usize {
        self.live_threads.load(Ordering::SeqCst)
    }

    /// Number of sessions not yet removed by [`kill`](Self::kill) or [`shutdown`](Self::shutdown).
    pub fn session_count(&self) -> usize {
        lock(&self.sessions).len()
    }

    /// Starts `spec` in a new PTY. `on_event` receives output batches, then one exit event.
    pub fn spawn<F>(&self, spec: SpawnSpec, on_event: F) -> Result<SessionId, PtyError>
    where
        F: FnMut(SessionEvent<'_>) + Send + 'static,
    {
        if spec.cols == 0 || spec.rows == 0 {
            return Err(PtyError::InvalidSize {
                cols: spec.cols,
                rows: spec.rows,
            });
        }

        let pair = native_pty_system()
            .openpty(pty_size(spec.cols, spec.rows))
            .map_err(|e| PtyError::Open(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&spec.program);
        cmd.args(&spec.args);
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;
        // The slave must not outlive the spawn: on Unix an open slave keeps the master from
        // seeing EOF, and on Windows it shares the pseudo console with the master.
        drop(pair.slave);

        let streams = pair
            .master
            .try_clone_reader()
            .and_then(|reader| pair.master.take_writer().map(|writer| (reader, writer)));
        let (reader, writer) = match streams {
            Ok(streams) => streams,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PtyError::Open(e.to_string()));
            }
        };

        let session = Arc::new(Session {
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(child.clone_killer()),
            exited: AtomicBool::new(false),
            waiter: Mutex::new(None),
        });

        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(CHANNEL_CAPACITY);
        let reader_guard = ThreadGuard::new(&self.live_threads);
        let pump_guard = ThreadGuard::new(&self.live_threads);
        let waiter_guard = ThreadGuard::new(&self.live_threads);

        let reader_session = Arc::clone(&session);
        let reader_thread = thread::Builder::new()
            .name("noren-pty-reader".into())
            .spawn(move || {
                let _guard = reader_guard;
                read_loop(reader, &tx, &reader_session);
            });
        let reader_thread = match reader_thread {
            Ok(handle) => handle,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(PtyError::Spawn(e.to_string()));
            }
        };

        let mut on_event = on_event;
        let pump_thread = thread::Builder::new()
            .name("noren-pty-pump".into())
            .spawn(move || {
                let _guard = pump_guard;
                batch_loop(&rx, |bytes| on_event(SessionEvent::Output(bytes)));
                on_event
            });
        let pump_thread = match pump_thread {
            Ok(handle) => handle,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                // Closing the PTY ends the reader; its sender drop already unblocks nothing else.
                lock(&session.master).take();
                lock(&session.writer).take();
                let _ = reader_thread.join();
                return Err(PtyError::Spawn(e.to_string()));
            }
        };

        let waiter_session = Arc::clone(&session);
        let waiter_thread = thread::Builder::new()
            .name("noren-pty-waiter".into())
            .spawn(move || {
                let _guard = waiter_guard;
                let status = child.wait();
                waiter_session.exited.store(true, Ordering::SeqCst);
                // Close the PTY so the reader sees EOF even where the OS would not report it.
                lock(&waiter_session.writer).take();
                lock(&waiter_session.master).take();
                let _ = reader_thread.join();
                if let Ok(mut on_event) = pump_thread.join() {
                    let info = match status {
                        Ok(status) => ExitInfo {
                            code: status.exit_code(),
                            signal: status.signal().map(str::to_owned),
                        },
                        Err(_) => ExitInfo {
                            code: 1,
                            signal: None,
                        },
                    };
                    on_event(SessionEvent::Exit(info));
                }
            });
        let waiter_thread = match waiter_thread {
            Ok(handle) => handle,
            Err(e) => {
                // The child was moved into the failed closure; kill it through the killer.
                let _ = lock(&session.killer).kill();
                lock(&session.writer).take();
                lock(&session.master).take();
                return Err(PtyError::Spawn(e.to_string()));
            }
        };
        *lock(&session.waiter) = Some(waiter_thread);

        let id = SessionId(self.next_id.fetch_add(1, Ordering::SeqCst));
        lock(&self.sessions).insert(id, session);
        Ok(id)
    }

    /// Sends bytes to the child's terminal input.
    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<(), PtyError> {
        let session = self.session(id)?;
        let mut writer = lock(&session.writer);
        let writer = writer.as_mut().ok_or(PtyError::SessionClosed(id))?;
        writer.write_all(data).map_err(PtyError::Io)?;
        writer.flush().map_err(PtyError::Io)
    }

    /// Changes the terminal size of a live session.
    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), PtyError> {
        if cols == 0 || rows == 0 {
            return Err(PtyError::InvalidSize { cols, rows });
        }
        let session = self.session(id)?;
        let master = lock(&session.master);
        let master = master.as_ref().ok_or(PtyError::SessionClosed(id))?;
        master
            .resize(pty_size(cols, rows))
            .map_err(|e| PtyError::Resize(e.to_string()))
    }

    /// Ends the child (if still running), waits until all session threads finished and removes
    /// the session. The exit event was delivered before this returns. Also the way to release a
    /// session whose child ended on its own.
    pub fn kill(&self, id: SessionId) -> Result<(), PtyError> {
        let session = self.session(id)?;
        if !session.exited.load(Ordering::SeqCst)
            && let Err(e) = lock(&session.killer).kill()
        {
            // The child may have ended between the check and the kill. On Windows
            // portable-pty 0.9 also reports an error when TerminateProcess succeeds, so an
            // error only counts when the child is still alive after a grace period.
            if !wait_exited(&session, KILL_GRACE) {
                return Err(PtyError::Io(e));
            }
        }
        let waiter = lock(&session.waiter).take();
        if let Some(waiter) = waiter {
            let _ = waiter.join();
        }
        lock(&self.sessions).remove(&id);
        Ok(())
    }

    /// Kills every session and joins all their threads.
    pub fn shutdown(&self) {
        let ids: Vec<SessionId> = lock(&self.sessions).keys().copied().collect();
        for id in ids {
            let _ = self.kill(id);
        }
    }

    fn session(&self, id: SessionId) -> Result<Arc<Session>, PtyError> {
        lock(&self.sessions)
            .get(&id)
            .cloned()
            .ok_or(PtyError::UnknownSession(id))
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Polls until the waiter marked the session as ended; `false` if `timeout` passes first.
fn wait_exited(session: &Session, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !session.exited.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(2));
    }
    true
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Forwards raw PTY bytes until EOF, a read error (the normal end on Unix) or a closed channel.
///
/// On Windows, ConPTY opens with a cursor position query (`ESC [ 6 n`) and holds the child back
/// until it is answered. The query is answered here and removed from the stream, so the session
/// works without a terminal emulator attached and the emulator does not answer a second time.
fn read_loop(mut reader: Box<dyn Read + Send>, tx: &SyncSender<Vec<u8>>, session: &Session) {
    let mut buf = vec![0u8; READ_CHUNK_BYTES];
    let mut probe_budget = if cfg!(windows) {
        STARTUP_PROBE_BYTES
    } else {
        0
    };
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let mut chunk = buf[..n].to_vec();
                if probe_budget > 0 {
                    probe_budget = probe_budget.saturating_sub(n);
                    if strip_cursor_query(&mut chunk) {
                        probe_budget = 0;
                        if let Some(writer) = lock(&session.writer).as_mut() {
                            let _ = writer
                                .write_all(CURSOR_REPORT)
                                .and_then(|()| writer.flush());
                        }
                    }
                }
                if !chunk.is_empty() && tx.send(chunk).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
}

/// Removes the first cursor position query from `chunk`; returns whether one was found.
fn strip_cursor_query(chunk: &mut Vec<u8>) -> bool {
    match chunk
        .windows(CURSOR_QUERY.len())
        .position(|w| w == CURSOR_QUERY)
    {
        Some(at) => {
            chunk.drain(at..at + CURSOR_QUERY.len());
            true
        }
        None => false,
    }
}

/// Joins chunks into batches of at most `BATCH_MAX_BYTES`, delivering a batch once it is full or
/// `BATCH_MAX_DELAY` passed since its first byte. Delivers the remainder when the sender closes.
fn batch_loop(rx: &mpsc::Receiver<Vec<u8>>, mut emit: impl FnMut(&[u8])) {
    let mut pending: Vec<u8> = Vec::with_capacity(BATCH_MAX_BYTES);
    let mut deadline = Instant::now();
    loop {
        let received = if pending.is_empty() {
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        };
        match received {
            Ok(chunk) => {
                if pending.is_empty() {
                    deadline = Instant::now() + BATCH_MAX_DELAY;
                }
                pending.extend_from_slice(&chunk);
                while pending.len() >= BATCH_MAX_BYTES {
                    emit(&pending[..BATCH_MAX_BYTES]);
                    pending.drain(..BATCH_MAX_BYTES);
                    deadline = Instant::now() + BATCH_MAX_DELAY;
                }
                if !pending.is_empty() && Instant::now() >= deadline {
                    emit(&pending);
                    pending.clear();
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                emit(&pending);
                pending.clear();
            }
            Err(RecvTimeoutError::Disconnected) => {
                if !pending.is_empty() {
                    emit(&pending);
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_batches(chunks: Vec<Vec<u8>>, gap: Duration) -> Vec<usize> {
        let (tx, rx) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let feeder = thread::spawn(move || {
            for chunk in chunks {
                tx.send(chunk).unwrap();
                if !gap.is_zero() {
                    thread::sleep(gap);
                }
            }
        });
        let mut sizes = Vec::new();
        batch_loop(&rx, |bytes| sizes.push(bytes.len()));
        feeder.join().unwrap();
        sizes
    }

    #[test]
    fn full_batches_are_capped_and_remainder_is_delivered() {
        let sizes = run_batches(
            vec![vec![b'x'; 100_000], vec![b'y'; 50_000]],
            Duration::ZERO,
        );
        assert_eq!(sizes.iter().sum::<usize>(), 150_000);
        assert!(sizes.iter().all(|&n| n <= BATCH_MAX_BYTES));
        assert_eq!(sizes[0], BATCH_MAX_BYTES);
    }

    #[test]
    fn slow_chunks_are_flushed_by_the_deadline() {
        let gap = BATCH_MAX_DELAY * 4;
        let sizes = run_batches(vec![vec![b'a'; 10], vec![b'b'; 10], vec![b'c'; 10]], gap);
        assert_eq!(sizes, vec![10, 10, 10]);
    }

    #[test]
    fn cursor_query_is_removed_once() {
        let mut chunk = b"a\x1b[?1004h\x1b[6nb\x1b[6n".to_vec();
        assert!(strip_cursor_query(&mut chunk));
        assert_eq!(chunk, b"a\x1b[?1004hb\x1b[6n");
        let mut other = b"plain".to_vec();
        assert!(!strip_cursor_query(&mut other));
    }

    #[test]
    fn rejects_zero_size() {
        let manager = SessionManager::new();
        let spec = SpawnSpec {
            program: "irrelevant".into(),
            args: vec![],
            cwd: None,
            env: vec![],
            cols: 0,
            rows: 24,
        };
        assert!(matches!(
            manager.spawn(spec, |_| {}),
            Err(PtyError::InvalidSize { cols: 0, rows: 24 })
        ));
    }
}

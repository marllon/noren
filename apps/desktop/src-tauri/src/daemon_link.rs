//! The sessions of the app: in the session daemon (`norend`) when there is one, in this process
//! when there is not (NOR-F14-02a).
//!
//! [`Sessions`] has the calls of the `SessionManager` that the rest of the app already used
//! (`spawn`, `write`, `resize`, `kill`, `session_count`, `shutdown`) and sends them to one of two
//! places, chosen once, in the background, from the start of the program (so the first session never
//! waits for a daemon that was started long before it asked):
//!
//! - **The daemon.** The app looks for a `norend` on its endpoint (`DaemonSettings::endpoint`, the
//!   name `default` in a normal run). If none answers it starts the `norend` that sits next to its
//!   own executable, without a window and as a program of its own (a new process group, no console
//!   of the app's, no pipe to it), so the daemon can outlive the app, and waits for it to listen. A
//!   session is then a `Create` followed by an `Attach` on one connection that stays open, and the
//!   output and the end of each session come back as events of that connection.
//! - **This process.** When there is no `norend` to start, it exits before it listens, never
//!   listens, or the daemon on the endpoint speaks another protocol version, the app logs one
//!   warning and runs the sessions in a `SessionManager` inside the app, as it did before the
//!   daemon existed. That choice lasts for the run.
//!
//! Output and the end of a session reach the app through the callback given to [`Sessions::spawn`]
//! in both places, so the code above this module (routes, `session-exit`, the shell started ahead)
//! does not know which one it has. The callback is always called from a thread of this module, never
//! from the thread that called `spawn`: the caller may hold a lock the callback needs.
//!
//! What a session of the daemon inherits is the environment of `norend`, not of the app, and its
//! folder is the folder of `norend`, so the app sends its own environment and its current folder with
//! every `Create` (`prepare_spec`): a shell opens the way it would have inside the app.
//!
//! When the connection to the daemon ends (it was stopped, it died) every session of the app is
//! reported as ended, the calls on them fail, and the next `spawn` looks for the daemon again
//! (and starts one) instead of failing for the rest of the run; a daemon that cannot be reached is
//! not retried for [`RETRY_AFTER`].
//!
//! Nothing in this file knows about Tauri, so its tests run anywhere the core does.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::daemon::{
    ClientError, ClientEvent, ClientEvents, DaemonClient, Endpoint, ErrorCode, SessionInfo,
};
use noren_core::{
    ExitInfo, ProcessSource, PtyError, SessionEvent, SessionId, SessionManager, SpawnSpec,
    SystemProcesses,
};
use tokio::runtime::{Builder, Handle, Runtime};
use tokio::sync::{mpsc as async_mpsc, oneshot};

/// The daemon a normal run talks to (`norend --endpoint default`).
pub const DEFAULT_ENDPOINT_NAME: &str = "default";
/// The exit code `norend` gives when another `norend` already listens on its endpoint.
const NOREND_ALREADY_RUNNING: i32 = 3;
/// How long a launched `norend` has to listen before the app gives up on it.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Pause between two looks at whether a launched `norend` listens yet.
const LAUNCH_POLL: Duration = Duration::from_millis(20);
/// After a failed attempt to reach the daemon again, `spawn` fails at once for this long instead of
/// trying (and waiting) again for every tab.
const RETRY_AFTER: Duration = Duration::from_secs(3);
/// The longest the app waits for the daemon to take its `Shutdown` and its sessions down.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// The longest the app waits to end its sessions when it quits.
const END_SESSIONS_TIMEOUT: Duration = Duration::from_secs(10);

/// How the app reaches the daemon.
#[derive(Debug, Clone)]
pub struct DaemonSettings {
    /// The daemon to use, by name (`Endpoint::named`): two names are two daemons.
    pub endpoint: String,
    /// The `norend` to start when none answers. `None` is the one next to the executable of the app.
    pub program: Option<PathBuf>,
    /// How long a `norend` that was started has to listen.
    pub launch_timeout: Duration,
    /// Whether ending the sessions of the app (`Sessions::shutdown`) also stops the daemon. A normal
    /// run leaves it running, since it is meant to outlive the app; a smoke run owns its daemon,
    /// which must not outlive the run.
    pub stop_on_shutdown: bool,
}

impl DaemonSettings {
    /// A normal run: the daemon of the user, left running when the app quits.
    pub fn normal() -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT_NAME.to_owned(),
            program: None,
            launch_timeout: LAUNCH_TIMEOUT,
            stop_on_shutdown: false,
        }
    }

    /// A run that has a daemon of its own on `endpoint` and stops it when it ends (the smoke runs).
    pub fn for_run(endpoint: String) -> Self {
        Self {
            endpoint,
            stop_on_shutdown: true,
            ..Self::normal()
        }
    }
}

/// Where the sessions of a run live.
#[derive(Debug, Clone)]
pub enum Host {
    /// Inside the app, in a `SessionManager`, without looking for a daemon.
    InProcess,
    /// In a daemon, with the app's own `SessionManager` as the way out when there is none.
    Daemon(DaemonSettings),
}

/// Where the sessions of a run ended up living.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placement {
    /// In this process. `reason` is why there is no daemon (`None` when none was asked for).
    Process { reason: Option<String> },
    /// In a daemon. `norend_pid` is the pid of the `norend` this run started, `None` when it found
    /// one already running.
    Daemon {
        endpoint: String,
        norend_pid: Option<u32>,
    },
}

/// Why a call on a session failed. The text is for a person; it is what the page shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionError(String);

impl SessionError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SessionError {}

impl From<PtyError> for SessionError {
    fn from(error: PtyError) -> Self {
        Self(error.to_string())
    }
}

impl From<ClientError> for SessionError {
    fn from(error: ClientError) -> Self {
        match error {
            // The daemon words these the way the session manager does; its code is not for a person.
            ClientError::Server(body) => Self(body.message),
            other => Self(other.to_string()),
        }
    }
}

/// What came of stopping a daemon (see [`Sessions::stop_daemon`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stopped {
    /// The `norend` this run started, when it did.
    pub norend_pid: Option<u32>,
    /// Its exit code, when it was waited for and ended with one.
    pub exit_code: Option<i32>,
}

/// The callback of a session: output, then the end.
type Sink = Box<dyn FnMut(SessionEvent<'_>) + Send>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Taken by a test that creates and ends shells, for as long as it runs. On Windows, closing a
/// pseudo console can stall for a long time when another session was created a few milliseconds
/// before (finding 168), so the tests that run shells take turns, as the tests of the daemon do.
#[cfg(test)]
pub(crate) static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------------------------

enum Backend {
    Process {
        manager: SessionManager,
        reason: Option<String>,
    },
    Daemon(Box<Link>),
}

impl Backend {
    fn in_process(reason: Option<String>) -> Self {
        Self::Process {
            manager: SessionManager::new(),
            reason,
        }
    }
}

type BackendInit = Box<dyn FnOnce() -> Backend + Send + Sync>;

/// Every session of the app. See the module documentation.
pub struct Sessions {
    /// Decided in the background from the start of the program; the first call waits for it.
    backend: LazyLock<Backend, BackendInit>,
    /// Whether the backend is a daemon, published by the thread that decided it the moment it did,
    /// so a caller that must not wait (the handler of a window event) can ask without forcing
    /// `backend`. Empty until then.
    in_daemon_known: Arc<OnceLock<bool>>,
}

impl Sessions {
    pub fn new(host: Host) -> Self {
        match host {
            Host::InProcess => Self::from_backend(Backend::in_process(None)),
            Host::Daemon(settings) => {
                let known = Arc::new(OnceLock::new());
                let publish = Arc::clone(&known);
                let resolving = thread::Builder::new()
                    .name("noren-daemon-find".to_owned())
                    .spawn(move || {
                        let backend = resolve(settings);
                        let _ = publish.set(matches!(backend, Backend::Daemon(_)));
                        backend
                    });
                let waiting = Mutex::new(resolving.ok());
                let on_failure = Arc::clone(&known);
                Self {
                    backend: LazyLock::new(Box::new(move || {
                        let handle = lock(&waiting).take();
                        handle
                            .and_then(|handle| handle.join().ok())
                            .unwrap_or_else(|| {
                                let _ = on_failure.set(false);
                                Backend::in_process(Some(
                                    "the search for the session daemon failed".to_owned(),
                                ))
                            })
                    })),
                    in_daemon_known: known,
                }
            }
        }
    }

    fn from_backend(backend: Backend) -> Self {
        let known = OnceLock::new();
        let _ = known.set(matches!(backend, Backend::Daemon(_)));
        Self {
            backend: LazyLock::new(Box::new(move || backend)),
            in_daemon_known: Arc::new(known),
        }
    }

    /// Where the sessions live. Waits for the daemon to be found or started, the first time.
    pub fn placement(&self) -> Placement {
        match &*self.backend {
            Backend::Process { reason, .. } => Placement::Process {
                reason: reason.clone(),
            },
            Backend::Daemon(link) => Placement::Daemon {
                endpoint: link.settings.endpoint.clone(),
                norend_pid: link.norend_pid(),
            },
        }
    }

    /// Starts `spec` in a new session. `on_event` receives the output in order and then, once, the
    /// end of the session, from a thread of the session (or of the link to the daemon), never from
    /// the caller's. It must not call back into `Sessions` (`kill`, `shutdown`...): in the session
    /// manager that would join its own thread, and in the daemon it would wait for the thread it
    /// runs on.
    pub fn spawn<F>(&self, spec: SpawnSpec, on_event: F) -> Result<SessionId, SessionError>
    where
        F: FnMut(SessionEvent<'_>) + Send + 'static,
    {
        match &*self.backend {
            Backend::Process { manager, .. } => Ok(manager.spawn(spec, on_event)?),
            Backend::Daemon(link) => link.spawn(spec, Box::new(on_event)),
        }
    }

    /// Sends bytes to the terminal input of a session.
    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<(), SessionError> {
        match &*self.backend {
            Backend::Process { manager, .. } => Ok(manager.write(id, data)?),
            Backend::Daemon(link) => link.write(id, data),
        }
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), SessionError> {
        match &*self.backend {
            Backend::Process { manager, .. } => Ok(manager.resize(id, cols, rows)?),
            Backend::Daemon(link) => link.resize(id, cols, rows),
        }
    }

    /// Ends the process of a session, if it still runs, and releases the session.
    pub fn kill(&self, id: SessionId) -> Result<(), SessionError> {
        match &*self.backend {
            Backend::Process { manager, .. } => Ok(manager.kill(id)?),
            Backend::Daemon(link) => link.kill(id),
        }
    }

    /// The pid of the process of each session that is alive, `None` for one that is not or is
    /// unknown. The daemon gives them in one `List`, as `SessionInfo`.
    pub fn process_ids(&self, ids: &[SessionId]) -> Vec<(SessionId, Option<u32>)> {
        match &*self.backend {
            Backend::Process { manager, .. } => ids
                .iter()
                .map(|id| (*id, manager.process_id(*id)))
                .collect(),
            Backend::Daemon(link) => link.process_ids(ids),
        }
    }

    /// Whether the sessions live in the daemon, and so can outlive the app.
    pub fn in_daemon(&self) -> bool {
        matches!(&*self.backend, Backend::Daemon(_))
    }

    /// [`Self::in_daemon`] without waiting: `None` while the search for the daemon is still going
    /// on. For the handler of a window event, which runs on the thread of the event loop and must
    /// not stand still for the seconds a daemon can take to start.
    pub fn in_daemon_now(&self) -> Option<bool> {
        self.in_daemon_known.get().copied()
    }

    /// Every session the daemon holds, whoever started it: the ones this run started, the ones an
    /// earlier run left, and the ones that ended and were not released yet. Empty when the sessions
    /// live in this process.
    pub fn list(&self) -> Result<Vec<SessionInfo>, SessionError> {
        match &*self.backend {
            Backend::Process { .. } => Ok(Vec::new()),
            Backend::Daemon(link) => link.list(),
        }
    }

    /// Whether this run started or took over the session and has not killed it.
    pub fn owns(&self, id: SessionId) -> bool {
        match &*self.backend {
            Backend::Process { manager, .. } => manager.process_id(id).is_some(),
            Backend::Daemon(link) => lock(&link.owned).contains(&id.0),
        }
    }

    /// Takes over a session of the daemon that an earlier run started and that is still there: its
    /// buffer (what it printed meanwhile) goes to `on_event` first, then everything it prints, then
    /// its end, exactly as for a session of [`Self::spawn`], and it counts as this run's from here on
    /// (`kill` ends it, `session_count` counts it). The same rules apply to `on_event`.
    pub fn reattach<F>(&self, id: SessionId, on_event: F) -> Result<(), SessionError>
    where
        F: FnMut(SessionEvent<'_>) + Send + 'static,
    {
        match &*self.backend {
            Backend::Process { .. } => Err(SessionError::new(
                "the sessions do not run in a daemon, so none outlives the app",
            )),
            Backend::Daemon(link) => link.reattach(id, Box::new(on_event)),
        }
    }

    /// Sessions of this app that were started and not yet killed (an ended one counts until it is).
    pub fn session_count(&self) -> usize {
        match &*self.backend {
            Backend::Process { manager, .. } => manager.session_count(),
            Backend::Daemon(link) => lock(&link.owned).len(),
        }
    }

    /// Threads this process runs for its sessions. A session of the daemon has none here.
    pub fn live_threads(&self) -> usize {
        match &*self.backend {
            Backend::Process { manager, .. } => manager.live_threads(),
            Backend::Daemon(_) => 0,
        }
    }

    /// Ends the sessions of the app, so none outlives it. When the run owns its daemon
    /// ([`DaemonSettings::stop_on_shutdown`]) the daemon is stopped too.
    pub fn shutdown(&self) {
        match &*self.backend {
            Backend::Process { manager, .. } => manager.shutdown(),
            Backend::Daemon(link) => link.shutdown(),
        }
    }

    /// Ends the sessions of the app that are not in `keep` and lets go of the ones that are, which go
    /// on running in the daemon for a later run to take over ([`Self::reattach`]). This is what the
    /// app does on its way out when the shells of its panes are to outlive it. Sessions that live in
    /// this process cannot outlive it, so there it ends them all; and a run that owns its daemon
    /// ([`DaemonSettings::stop_on_shutdown`]) stops it, as [`Self::shutdown`] does.
    pub fn detach(&self, keep: &[SessionId]) {
        match &*self.backend {
            Backend::Process { manager, .. } => manager.shutdown(),
            Backend::Daemon(link) => link.detach(keep),
        }
    }

    /// Asks the daemon to stop: it ends every session, answers, and exits. When this run started it,
    /// waits for the process to be gone. An error when there is no daemon, or it would not stop.
    pub fn stop_daemon(&self) -> Result<Stopped, SessionError> {
        match &*self.backend {
            Backend::Process { .. } => {
                Err(SessionError::new("the sessions do not run in a daemon"))
            }
            Backend::Daemon(link) => link.stop_daemon(),
        }
    }

    /// Quitting for real (the tray icon's "Quit"): every session ends, the daemon on the endpoint
    /// stops (whoever started it, and even when the connection of this run was lost: it is found
    /// again, never started) and the call returns when the endpoint is free. When the daemon is
    /// already gone there is nothing to stop and that is a success. The sessions in this process
    /// end with the app, as they always did. An error when the daemon would not stop; the sessions
    /// of this run are ended then as far as they can be (the caller falls back to
    /// [`Self::shutdown`]).
    pub fn quit_for_good(&self) -> Result<Stopped, SessionError> {
        match &*self.backend {
            Backend::Process { manager, .. } => {
                manager.shutdown();
                Ok(Stopped {
                    norend_pid: None,
                    exit_code: None,
                })
            }
            Backend::Daemon(link) => link.quit_for_good(),
        }
    }

    /// Whether anything still listens on the endpoint of the daemon (a stopped daemon leaves none).
    pub fn daemon_listens(&self) -> bool {
        match &*self.backend {
            Backend::Process { .. } => false,
            Backend::Daemon(link) => link.listens(),
        }
    }
}

/// Finds or starts the daemon, or settles for this process with a warning in the log.
fn resolve(settings: DaemonSettings) -> Backend {
    match Link::start(settings) {
        Ok(link) => Backend::Daemon(Box::new(link)),
        Err(reason) => {
            eprintln!(
                "warning: the session daemon is not available ({reason}); the sessions of this \
                 run live inside the app and end with it"
            );
            Backend::in_process(Some(reason))
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The link to the daemon
// ---------------------------------------------------------------------------------------------

/// The app's side of the daemon: a small runtime of its own for the async client, the connection,
/// and what is known about the `norend` it started.
struct Link {
    /// Dropped without waiting (see `Drop`).
    runtime: Option<Runtime>,
    handle: Handle,
    settings: DaemonSettings,
    endpoint: Endpoint,
    conn: Mutex<Option<Arc<Conn>>>,
    /// One attempt to reach the daemon again at a time.
    reconnecting: Mutex<()>,
    /// When the last attempt to reach the daemon again failed, and why.
    failed: Mutex<Option<(Instant, SessionError)>>,
    launched: Mutex<Option<Arc<Launched>>>,
    /// The sessions this app started and has not killed.
    owned: Mutex<HashSet<u64>>,
}

/// The two connections of the app to the daemon. The daemon answers the requests of one connection
/// in turn, and creating or ending a session can take a while (the system tears a pseudo console
/// down at its own pace), so what is typed and the size of a terminal go on a connection of their
/// own and never wait behind that.
struct Conn {
    /// Creates, attaches, kills, lists, stops; it is the one that carries the events.
    client: Arc<DaemonClient>,
    /// Writes and resizes. Attached to nothing, so no event ever comes back on it.
    input: DaemonClient,
    attaches: async_mpsc::UnboundedSender<Attach>,
    /// Set by the reader when the connection ended; nothing works on it after that.
    lost: Arc<AtomicBool>,
}

/// A request to the reader task: attach to a session and send what it prints to `sink`.
struct Attach {
    session: SessionId,
    sink: Sink,
    done: oneshot::Sender<Result<(), ClientError>>,
}

impl Link {
    fn start(settings: DaemonSettings) -> Result<Self, String> {
        let endpoint = Endpoint::named(&settings.endpoint).map_err(|e| e.to_string())?;
        let runtime = Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("noren-daemon-link")
            .enable_all()
            .build()
            .map_err(|e| format!("could not start the runtime of the link: {e}"))?;
        let link = Self {
            handle: runtime.handle().clone(),
            runtime: Some(runtime),
            settings,
            endpoint,
            conn: Mutex::new(None),
            reconnecting: Mutex::new(()),
            failed: Mutex::new(None),
            launched: Mutex::new(None),
            owned: Mutex::new(HashSet::new()),
        };
        let conn = link.connect_or_launch()?;
        *lock(&link.conn) = Some(conn);
        Ok(link)
    }

    /// Runs `future` on the runtime of the link and waits for its answer. Plain threads wait here,
    /// whatever thread they are: a tokio runtime refuses to block inside another.
    fn call<T: Send + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, SessionError> {
        let (tx, rx) = mpsc::channel();
        self.handle.spawn(async move {
            let _ = tx.send(future.await);
        });
        rx.recv()
            .map_err(|_| SessionError::new("the link to the session daemon stopped"))
    }

    /// Like [`Self::call`], and gives up after `limit`.
    fn call_within<T: Send + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
        limit: Duration,
    ) -> Result<T, SessionError> {
        let (tx, rx) = mpsc::channel();
        self.handle.spawn(async move {
            let _ = tx.send(future.await);
        });
        rx.recv_timeout(limit).map_err(|_| {
            SessionError::new(format!(
                "the session daemon did not answer within {} s",
                limit.as_secs()
            ))
        })
    }

    fn norend_pid(&self) -> Option<u32> {
        lock(&self.launched).as_ref().map(|launched| launched.pid)
    }

    /// The connection, if it is open.
    fn live_connection(&self) -> Result<Arc<Conn>, SessionError> {
        match lock(&self.conn).as_ref() {
            Some(conn) if !conn.lost.load(Ordering::SeqCst) => Ok(Arc::clone(conn)),
            _ => Err(SessionError::new(
                "the session daemon is not running, so its sessions ended",
            )),
        }
    }

    /// The connection, found again (and the daemon started again) when it was lost.
    fn connection(&self) -> Result<Arc<Conn>, SessionError> {
        if let Ok(conn) = self.live_connection() {
            return Ok(conn);
        }
        let _one_at_a_time = lock(&self.reconnecting);
        if let Ok(conn) = self.live_connection() {
            return Ok(conn);
        }
        if let Some((at, why)) = lock(&self.failed).as_ref()
            && at.elapsed() < RETRY_AFTER
        {
            return Err(why.clone());
        }
        match self.connect_or_launch() {
            Ok(conn) => {
                *lock(&self.failed) = None;
                *lock(&self.conn) = Some(Arc::clone(&conn));
                Ok(conn)
            }
            Err(reason) => {
                let why = SessionError::new(format!(
                    "the session daemon went away and could not be reached again: {reason}"
                ));
                *lock(&self.failed) = Some((Instant::now(), why.clone()));
                Err(why)
            }
        }
    }

    /// Opens a connection to the daemon on the endpoint; if nothing listens there, starts `norend`
    /// and waits for it to.
    fn connect_or_launch(&self) -> Result<Arc<Conn>, String> {
        match self.open() {
            Ok(conn) => return Ok(conn),
            Err(OpenError::Absent) => {}
            Err(OpenError::Other(why)) => return Err(why),
        }
        let program = self
            .settings
            .program
            .clone()
            .or_else(default_program)
            .ok_or_else(|| {
                "the app cannot tell where it is, so it cannot look for norend".to_owned()
            })?;
        if !program.is_file() {
            return Err(format!("norend was not found at {}", program.display()));
        }
        let mut child = Some(
            launch_norend(&program, &self.settings.endpoint)
                .map_err(|e| format!("could not start {}: {e}", program.display()))?,
        );
        let deadline = Instant::now() + self.settings.launch_timeout;
        loop {
            match self.open() {
                Ok(conn) => {
                    *lock(&self.launched) = child.map(adopt);
                    return Ok(conn);
                }
                Err(OpenError::Absent) => {}
                Err(OpenError::Other(why)) => {
                    end(child);
                    return Err(why);
                }
            }
            if let Some(started) = child.as_mut() {
                match started.try_wait() {
                    Ok(None) => {}
                    // Another norend took the endpoint first: the next look finds it.
                    Ok(Some(status)) if status.code() == Some(NOREND_ALREADY_RUNNING) => {
                        child = None;
                    }
                    Ok(Some(status)) => {
                        return Err(format!(
                            "{} ended with {status} before it listened",
                            program.display()
                        ));
                    }
                    Err(e) => {
                        end(child);
                        return Err(format!("could not watch norend: {e}"));
                    }
                }
            }
            if Instant::now() >= deadline {
                end(child);
                return Err(format!(
                    "norend did not listen on {} within {:.1} s",
                    self.endpoint,
                    self.settings.launch_timeout.as_secs_f32()
                ));
            }
            thread::sleep(LAUNCH_POLL);
        }
    }

    /// One try at the daemon on the endpoint.
    fn open(&self) -> Result<Arc<Conn>, OpenError> {
        let endpoint = self.endpoint.clone();
        let opened = self
            .call(async move { open_connection(&endpoint).await })
            .map_err(|e| OpenError::Other(e.to_string()))?;
        opened
            .map(Arc::new)
            .map_err(|e| classify(e, &self.endpoint))
    }

    /// Whether anything answers on the endpoint now.
    fn listens(&self) -> bool {
        matches!(self.open(), Ok(_) | Err(OpenError::Other(_)))
    }

    fn spawn(&self, spec: SpawnSpec, sink: Sink) -> Result<SessionId, SessionError> {
        let conn = self.connection()?;
        let spec = prepare_spec(spec, std::env::vars_os(), std::env::current_dir().ok());
        let session = self.call(async move {
            let created = conn.client.create(&spec).await?;
            let (done, attached) = oneshot::channel();
            let sent = conn.attaches.send(Attach {
                session: created.session,
                sink,
                done,
            });
            let attached = match sent {
                Ok(()) => attached.await.unwrap_or(Err(ClientError::Closed)),
                Err(_) => Err(ClientError::Closed),
            };
            match attached {
                Ok(()) => Ok(created.session),
                Err(error) => {
                    // A session nobody can hear is of no use; do not leave it behind.
                    let _ = conn.client.kill(created.session).await;
                    Err(error)
                }
            }
        })??;
        lock(&self.owned).insert(session.0);
        Ok(session)
    }

    fn write(&self, id: SessionId, data: &[u8]) -> Result<(), SessionError> {
        let conn = self.live_connection()?;
        let data = data.to_vec();
        Ok(self.call(async move { conn.input.write(id, &data).await })??)
    }

    fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), SessionError> {
        let conn = self.live_connection()?;
        Ok(self.call(async move { conn.input.resize(id, cols, rows).await })??)
    }

    fn kill(&self, id: SessionId) -> Result<(), SessionError> {
        let conn = self.live_connection()?;
        let killed = self.call(async move { conn.client.kill(id).await })?;
        // Gone is gone, whether this call ended it or the daemon never knew it.
        if killed.is_ok() || is_unknown_session(&killed) {
            lock(&self.owned).remove(&id.0);
        }
        Ok(killed?)
    }

    fn process_ids(&self, ids: &[SessionId]) -> Vec<(SessionId, Option<u32>)> {
        let none = || ids.iter().map(|id| (*id, None)).collect();
        let Ok(conn) = self.live_connection() else {
            return none();
        };
        let Ok(Ok(listed)) = self.call(async move { conn.client.list().await }) else {
            return none();
        };
        ids.iter()
            .map(|id| {
                let pid = listed
                    .iter()
                    .find(|info| info.session == *id && info.exit.is_none())
                    .and_then(|info| info.pid);
                (*id, pid)
            })
            .collect()
    }

    fn list(&self) -> Result<Vec<SessionInfo>, SessionError> {
        let conn = self.live_connection()?;
        Ok(self.call(async move { conn.client.list().await })??)
    }

    /// Attaches to a session of the daemon this run did not start: the task that reads the events
    /// does the attach (as for a new session), so the buffer reaches the sink before anything after
    /// it.
    fn reattach(&self, id: SessionId, sink: Sink) -> Result<(), SessionError> {
        let conn = self.live_connection()?;
        self.call(async move {
            let (done, attached) = oneshot::channel();
            let sent = conn.attaches.send(Attach {
                session: id,
                sink,
                done,
            });
            match sent {
                Ok(()) => attached.await.unwrap_or(Err(ClientError::Closed)),
                Err(_) => Err(ClientError::Closed),
            }
        })??;
        lock(&self.owned).insert(id.0);
        Ok(())
    }

    fn shutdown(&self) {
        if self.live_connection().is_err() {
            return;
        }
        if self.settings.stop_on_shutdown {
            if let Err(error) = self.stop_daemon() {
                eprintln!("warning: could not stop the session daemon: {error}");
            }
            return;
        }
        self.end_owned(&HashSet::new());
    }

    fn detach(&self, keep: &[SessionId]) {
        if self.live_connection().is_err() {
            return;
        }
        if self.settings.stop_on_shutdown {
            // The daemon of this run goes with it: nothing is left for a later run to take over.
            self.shutdown();
            return;
        }
        let keep: HashSet<u64> = keep.iter().map(|id| id.0).collect();
        self.end_owned(&keep);
    }

    /// Kills the sessions of this run that are not in `keep`, and forgets all of them.
    fn end_owned(&self, keep: &HashSet<u64>) {
        let Ok(conn) = self.live_connection() else {
            return;
        };
        let ids: Vec<u64> = lock(&self.owned)
            .iter()
            .copied()
            .filter(|id| !keep.contains(id))
            .collect();
        let ended = self.call_within(
            async move {
                for id in ids {
                    let _ = conn.client.kill(SessionId(id)).await;
                }
            },
            END_SESSIONS_TIMEOUT,
        );
        if let Err(error) = ended {
            eprintln!("warning: could not end every session: {error}");
        }
        lock(&self.owned).clear();
    }

    /// See [`Sessions::quit_for_good`].
    fn quit_for_good(&self) -> Result<Stopped, SessionError> {
        let conn = match self.live_connection() {
            Ok(conn) => conn,
            // The connection of this run was cut (the daemon may be fine): look for the daemon
            // itself on the endpoint, and do not start one just to stop it.
            Err(_) => match self.open() {
                Ok(conn) => conn,
                Err(OpenError::Absent) => {
                    lock(&self.owned).clear();
                    return Ok(Stopped {
                        norend_pid: None,
                        exit_code: None,
                    });
                }
                Err(OpenError::Other(why)) => return Err(SessionError::new(why)),
            },
        };
        let deadline = Instant::now() + STOP_TIMEOUT;
        // The shells it holds, taken before it is asked (afterwards there is nobody to ask).
        let shells = self.running_shells(&conn);
        let stopped = self.stop_through(conn)?;
        self.wait_until_free(deadline)?;
        // A daemon this run started has a process to wait for (done by `stop_through`, which covers its
        // shells). One it found has none that this run can see, and it frees its endpoint before it
        // ends the sessions: its shells being gone is what says the sessions ended.
        if stopped.norend_pid.is_none() {
            wait_until_processes_gone(&shells, deadline)?;
        }
        Ok(stopped)
    }

    /// The pids of the shells of the daemon that still run (best effort: none when it cannot say).
    fn running_shells(&self, conn: &Arc<Conn>) -> Vec<u32> {
        let conn = Arc::clone(conn);
        let listed = self.call_within(
            async move { conn.client.list().await },
            END_SESSIONS_TIMEOUT,
        );
        match listed {
            Ok(Ok(listed)) => listed
                .iter()
                .filter(|info| info.exit.is_none())
                .filter_map(|info| info.pid)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Waits until nothing listens on the endpoint: the daemon answers its `Shutdown` first and
    /// ends the sessions and leaves the endpoint after it, so the endpoint is the one sign that is
    /// true whoever started the daemon.
    fn wait_until_free(&self, deadline: Instant) -> Result<(), SessionError> {
        while self.listens() {
            if Instant::now() >= deadline {
                return Err(SessionError::new(format!(
                    "the session daemon was asked to stop and still listened on {} when the time was up",
                    self.endpoint
                )));
            }
            thread::sleep(LAUNCH_POLL);
        }
        Ok(())
    }

    fn stop_daemon(&self) -> Result<Stopped, SessionError> {
        let conn = self.live_connection()?;
        self.stop_through(conn)
    }

    /// Sends `Shutdown` on `conn`; when this run started the daemon, waits for its process to end.
    fn stop_through(&self, conn: Arc<Conn>) -> Result<Stopped, SessionError> {
        self.call_within(async move { conn.client.shutdown().await }, STOP_TIMEOUT)??;
        lock(&self.owned).clear();
        let launched = lock(&self.launched).clone();
        let Some(launched) = launched else {
            return Ok(Stopped {
                norend_pid: None,
                exit_code: None,
            });
        };
        match launched.wait_exit(STOP_TIMEOUT) {
            Some(status) => Ok(Stopped {
                norend_pid: Some(launched.pid),
                exit_code: status.code(),
            }),
            None => Err(SessionError::new(format!(
                "norend {} was asked to stop and was still running {} s later",
                launched.pid,
                STOP_TIMEOUT.as_secs()
            ))),
        }
    }
}

/// Waits until none of `pids` is a process any more, up to `deadline`.
fn wait_until_processes_gone(pids: &[u32], deadline: Instant) -> Result<(), SessionError> {
    if pids.is_empty() {
        return Ok(());
    }
    let processes = SystemProcesses::new();
    loop {
        let alive: Vec<u32> = processes
            .snapshot()
            .iter()
            .map(|process| process.pid)
            .filter(|pid| pids.contains(pid))
            .collect();
        if alive.is_empty() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(SessionError::new(format!(
                "the session daemon was asked to stop, and its shells {alive:?} were still running when the time was up"
            )));
        }
        thread::sleep(LAUNCH_POLL);
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        // The connection closes with the runtime; the sessions stay in the daemon, which is its job.
        // A runtime cannot be dropped from inside another one, but it can be let go of.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

fn is_unknown_session(result: &Result<(), ClientError>) -> bool {
    matches!(result, Err(ClientError::Server(body)) if body.code == ErrorCode::UnknownSession)
}

/// Why one try at the daemon failed.
#[derive(Debug, PartialEq, Eq)]
enum OpenError {
    /// Nothing listens on the endpoint: the case for starting `norend`.
    Absent,
    /// Something does, or the endpoint cannot be used, and starting another would not help.
    Other(String),
}

/// Sorts a failed connection into "nobody home" and "somebody home, but not for us".
fn classify(error: ClientError, endpoint: &Endpoint) -> OpenError {
    match error {
        ClientError::Connect(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            OpenError::Absent
        }
        ClientError::Server(body) if body.code == ErrorCode::VersionMismatch => {
            OpenError::Other(format!(
                "the daemon on {endpoint} speaks another protocol version: {}",
                body.message
            ))
        }
        other => OpenError::Other(format!("the daemon on {endpoint}: {other}")),
    }
}

/// Connects, and starts the task that reads the connection and hands the events to the sessions.
async fn open_connection(endpoint: &Endpoint) -> Result<Conn, ClientError> {
    let (client, events) = DaemonClient::connect(endpoint).await?;
    // The events of this one are dropped on purpose: nothing is attached through it.
    let (input, _no_events) = DaemonClient::connect(endpoint).await?;
    let client = Arc::new(client);
    let lost = Arc::new(AtomicBool::new(false));
    let (attaches, requests) = async_mpsc::unbounded_channel();
    tokio::spawn(read_events(
        Arc::clone(&client),
        events,
        requests,
        Arc::clone(&lost),
    ));
    Ok(Conn {
        client,
        input,
        attaches,
        lost,
    })
}

/// The one task that talks to the sinks of a connection. It also does every attach, so the replay
/// a session answers with is handed over before any event that follows it (the events of the
/// connection wait in their queue while the attach is being answered), and so a sink is only ever
/// called from here.
async fn read_events(
    client: Arc<DaemonClient>,
    mut events: ClientEvents,
    mut requests: async_mpsc::UnboundedReceiver<Attach>,
    lost: Arc<AtomicBool>,
) {
    let mut sinks: HashMap<SessionId, Sink> = HashMap::new();
    loop {
        tokio::select! {
            request = requests.recv() => match request {
                Some(request) => attach(&client, &mut sinks, request).await,
                // The app let go of the connection.
                None => break,
            },
            event = events.recv() => match event {
                Some(ClientEvent::Output { session, data }) => {
                    if let Some(sink) = sinks.get_mut(&session)
                        && !call_sink(sink, SessionEvent::Output(&data))
                    {
                        sinks.remove(&session);
                    }
                }
                Some(ClientEvent::Exit { session, info }) => {
                    if let Some(mut sink) = sinks.remove(&session) {
                        call_sink(&mut sink, SessionEvent::Exit(info));
                    }
                }
                None => break,
            },
        }
    }
    lost.store(true, Ordering::SeqCst);
    // Whatever was still running is gone with the connection: say so, once each.
    for (_, mut sink) in sinks {
        let gone = ExitInfo {
            code: 1,
            signal: None,
        };
        call_sink(&mut sink, SessionEvent::Exit(gone));
    }
}

async fn attach(client: &DaemonClient, sinks: &mut HashMap<SessionId, Sink>, request: Attach) {
    let Attach {
        session,
        mut sink,
        done,
    } = request;
    match client.attach(session).await {
        Ok(attached) => {
            // The caller is released first: it holds locks the sink may need (the exit callback of
            // a session waits for the id the caller is about to return).
            let _ = done.send(Ok(()));
            if !attached.replay.is_empty()
                && !call_sink(&mut sink, SessionEvent::Output(&attached.replay))
            {
                return;
            }
            match attached.exit {
                Some(info) => {
                    call_sink(&mut sink, SessionEvent::Exit(info));
                }
                None => {
                    sinks.insert(session, sink);
                }
            }
        }
        Err(error) => {
            let _ = done.send(Err(error));
        }
    }
}

/// Calls a sink; `false` when it panicked, which ends that session's output but not the others'.
fn call_sink(sink: &mut Sink, event: SessionEvent<'_>) -> bool {
    let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(event)));
    if called.is_err() {
        eprintln!("warning: the handler of a session panicked; its output is dropped");
    }
    called.is_ok()
}

// ---------------------------------------------------------------------------------------------
// What a daemon session needs from the app
// ---------------------------------------------------------------------------------------------

/// The spec sent to the daemon. A process of the daemon starts with the environment and the folder
/// of `norend`, which may be days older than this run, so the environment of the app goes along
/// (the entries of the spec itself last, so they win) and the folder of the app stands in for a
/// spec without one.
fn prepare_spec(
    mut spec: SpawnSpec,
    app_env: impl Iterator<Item = (OsString, OsString)>,
    app_cwd: Option<PathBuf>,
) -> SpawnSpec {
    if spec.cwd.is_none() {
        spec.cwd = app_cwd;
    }
    let mut env: Vec<(String, String)> = app_env
        .filter_map(|(name, value)| {
            let (name, value) = (name.into_string().ok()?, value.into_string().ok()?);
            // The hidden variables of Windows (`=C:`) and anything the daemon would refuse.
            let sendable = !name.is_empty() && !name.contains(['=', '\0']) && !value.contains('\0');
            sendable.then_some((name, value))
        })
        .collect();
    env.append(&mut spec.env);
    spec.env = env;
    spec
}

// ---------------------------------------------------------------------------------------------
// Starting norend
// ---------------------------------------------------------------------------------------------

/// The `norend` next to the executable of the app.
pub fn default_program() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "norend.exe"
    } else {
        "norend"
    };
    Some(exe.parent()?.join(name))
}

/// Starts `norend` as a program of its own: no window, no console of the app's, no pipe to the
/// app, its own process group, and a folder that no one needs to delete. Nothing here makes it die
/// with the app.
fn launch_norend(program: &Path, endpoint: &str) -> io::Result<Child> {
    let mut command = Command::new(program);
    command
        .arg("--endpoint")
        .arg(endpoint)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command.spawn()
}

/// `CREATE_NO_WINDOW`: a console program started by a program with a window opens a console window
/// unless it is told not to. `CREATE_NEW_PROCESS_GROUP`: a Ctrl+C or Ctrl+Break aimed at the app's
/// console does not reach it.
#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

/// A process group of its own, so the signals of the terminal the app was started from (Ctrl+C,
/// the hang-up when it closes) are not sent to the daemon.
#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(any(windows, unix)))]
fn detach(_command: &mut Command) {}

/// Ends a `norend` the app started and could not use.
fn end(child: Option<Child>) {
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// A `norend` that this run started and that answered: its pid, and a way to wait for its end.
struct Launched {
    pid: u32,
    exit: Arc<ExitSlot>,
}

#[derive(Default)]
struct ExitSlot {
    status: Mutex<Option<ExitStatus>>,
    changed: Condvar,
}

/// Hands the process to a thread that waits for it, so that a `norend` that ends while the app
/// runs is collected (on Unix it would stay a zombie) and the app can wait for its end.
fn adopt(mut child: Child) -> Arc<Launched> {
    let pid = child.id();
    let exit = Arc::new(ExitSlot::default());
    let waiting = Arc::clone(&exit);
    let spawned = thread::Builder::new()
        .name("noren-norend-wait".to_owned())
        .spawn(move || {
            if let Ok(status) = child.wait() {
                *lock(&waiting.status) = Some(status);
                waiting.changed.notify_all();
            }
        });
    if let Err(e) = spawned {
        eprintln!("warning: could not watch norend {pid}: {e}");
    }
    Arc::new(Launched { pid, exit })
}

impl Launched {
    /// Waits for the process to end, up to `limit`.
    fn wait_exit(&self, limit: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + limit;
        let mut status = lock(&self.exit.status);
        loop {
            if let Some(done) = *status {
                return Some(done);
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            status = self
                .exit
                .changed
                .wait_timeout(status, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

/// The `norend` Cargo builds for the tests of the workspace, next to the test executable's
/// profile folder. Builds it when only this package was asked for.
#[cfg(test)]
pub(crate) fn norend_binary() -> PathBuf {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            if let Some(path) = std::env::var_os("NOREND_BIN") {
                return PathBuf::from(path);
            }
            let name = if cfg!(windows) {
                "norend.exe"
            } else {
                "norend"
            };
            let exe = std::env::current_exe().expect("test executable");
            // target/<profile>/deps/<test> -> target/<profile>/norend
            let profile = exe.parent().and_then(Path::parent).expect("profile folder");
            let path = profile.join(name);
            if !path.is_file() {
                let mut build = Command::new(env!("CARGO"));
                build.args(["build", "-p", "norend"]);
                if !cfg!(debug_assertions) {
                    build.arg("--release");
                }
                let status = build.status().expect("run cargo to build norend");
                assert!(status.success(), "cargo build -p norend failed");
            }
            assert!(path.is_file(), "no norend at {}", path.display());
            path
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use noren_core::daemon::{Daemon, ServerConfig};

    use super::{ONE_AT_A_TIME, norend_binary};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A daemon name no other test or run uses.
    fn unique_endpoint() -> String {
        format!(
            "link-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        )
    }

    fn settings(endpoint: &str, program: Option<PathBuf>) -> DaemonSettings {
        DaemonSettings {
            endpoint: endpoint.to_owned(),
            program,
            launch_timeout: Duration::from_secs(30),
            stop_on_shutdown: false,
        }
    }

    fn sessions(settings: DaemonSettings) -> Sessions {
        Sessions::new(Host::Daemon(settings))
    }

    fn start_daemon(endpoint: &str) -> Daemon {
        Daemon::start(
            Endpoint::named(endpoint).expect("endpoint"),
            ServerConfig::default(),
        )
        .expect("start the daemon")
    }

    fn missing_program() -> PathBuf {
        std::env::temp_dir().join("noren-no-such-norend-4f2a91")
    }

    /// A shell that stays up and echoes what it is told.
    #[cfg(windows)]
    fn shell_spec() -> SpawnSpec {
        SpawnSpec {
            program: "cmd.exe".to_owned(),
            args: vec!["/Q".to_owned()],
            cwd: None,
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }
    #[cfg(not(windows))]
    fn shell_spec() -> SpawnSpec {
        SpawnSpec {
            program: "sh".to_owned(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }

    /// A command that prints `first`, waits a moment and prints `second`, then ends.
    #[cfg(windows)]
    fn two_lines_spec(first: &str, second: &str) -> SpawnSpec {
        SpawnSpec {
            program: "cmd.exe".to_owned(),
            args: vec![
                "/C".to_owned(),
                format!("echo {first} & ping -n 2 127.0.0.1 > nul & echo {second}"),
            ],
            ..shell_spec()
        }
    }
    #[cfg(not(windows))]
    fn two_lines_spec(first: &str, second: &str) -> SpawnSpec {
        SpawnSpec {
            program: "sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                format!("echo {first}; sleep 1; echo {second}"),
            ],
            ..shell_spec()
        }
    }

    /// A command that ends at once with exit code 3.
    #[cfg(windows)]
    fn exit_three_spec() -> SpawnSpec {
        SpawnSpec {
            program: "cmd.exe".to_owned(),
            args: vec!["/C".to_owned(), "exit 3".to_owned()],
            ..shell_spec()
        }
    }
    #[cfg(not(windows))]
    fn exit_three_spec() -> SpawnSpec {
        SpawnSpec {
            program: "sh".to_owned(),
            args: vec!["-c".to_owned(), "exit 3".to_owned()],
            ..shell_spec()
        }
    }

    /// The command that makes the shell print the folder it is in.
    #[cfg(windows)]
    const CWD_COMMAND: &[u8] = b"cd\r";
    #[cfg(not(windows))]
    const CWD_COMMAND: &[u8] = b"pwd\n";

    #[cfg(windows)]
    fn echo_command(text: &str) -> Vec<u8> {
        format!("echo {text}\r").into_bytes()
    }
    #[cfg(not(windows))]
    fn echo_command(text: &str) -> Vec<u8> {
        format!("echo {text}\n").into_bytes()
    }

    /// What one session printed and how it ended, as the sink of `spawn` saw it.
    #[derive(Clone, Default)]
    struct Recorder {
        output: Arc<Mutex<Vec<u8>>>,
        exit: Arc<Mutex<Option<ExitInfo>>>,
        /// Output that arrived after the end, which must never happen.
        after_exit: Arc<AtomicBool>,
    }

    impl Recorder {
        fn sink(&self) -> impl FnMut(SessionEvent<'_>) + Send + 'static {
            let recorder = self.clone();
            move |event| match event {
                SessionEvent::Output(bytes) => {
                    if lock(&recorder.exit).is_some() {
                        recorder.after_exit.store(true, Ordering::SeqCst);
                    }
                    lock(&recorder.output).extend_from_slice(bytes);
                }
                SessionEvent::Exit(info) => *lock(&recorder.exit) = Some(info),
            }
        }

        fn text(&self) -> String {
            visible(&String::from_utf8_lossy(&lock(&self.output)))
        }

        /// Waits until a line of the output is exactly `line`.
        fn wait_for_line(&self, line: &str) {
            let deadline = Instant::now() + Duration::from_secs(40);
            loop {
                if self.text().split(['\r', '\n']).any(|l| l.trim() == line) {
                    return;
                }
                assert!(
                    Instant::now() < deadline,
                    "no line {line:?} in the output; it printed {:?}",
                    self.text()
                );
                thread::sleep(Duration::from_millis(30));
            }
        }

        /// Waits for any output at all (the first one: see `ONE_AT_A_TIME`).
        fn wait_for_output(&self) {
            let deadline = Instant::now() + Duration::from_secs(40);
            while lock(&self.output).is_empty() {
                assert!(Instant::now() < deadline, "the session printed nothing");
                thread::sleep(Duration::from_millis(20));
            }
        }

        fn wait_for_exit(&self) -> ExitInfo {
            let deadline = Instant::now() + Duration::from_secs(40);
            loop {
                if let Some(info) = lock(&self.exit).clone() {
                    return info;
                }
                assert!(
                    Instant::now() < deadline,
                    "the session did not end; it printed {:?}",
                    self.text()
                );
                thread::sleep(Duration::from_millis(30));
            }
        }
    }

    /// The text of terminal output without its escape sequences.
    fn visible(text: &str) -> String {
        let mut out = String::new();
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            if c != '\x1b' {
                out.push(c);
                continue;
            }
            match chars.next() {
                // CSI: up to a byte in 0x40..=0x7e. A pseudo console moves the cursor to another row
                // where a line break would be, so that makes a line break here.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&c) {
                            if matches!(c, 'H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'd') {
                                out.push('\n');
                            }
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ESC \.
                Some(']') => {
                    let mut escaped = false;
                    for c in chars.by_ref() {
                        if c == '\x07' {
                            break;
                        }
                        if escaped {
                            break;
                        }
                        escaped = c == '\x1b';
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// Starts the shell and waits for its first output, so nothing is closed too soon after it.
    fn start_shell(sessions: &Sessions) -> (SessionId, Recorder) {
        let recorder = Recorder::default();
        let id = sessions
            .spawn(shell_spec(), recorder.sink())
            .expect("start a shell");
        recorder.wait_for_output();
        (id, recorder)
    }

    fn process_exists(pid: u32) -> bool {
        SystemProcesses::new()
            .snapshot()
            .iter()
            .any(|process| process.pid == pid)
    }

    fn wait_until_gone(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while process_exists(pid) {
            assert!(Instant::now() < deadline, "process {pid} did not end");
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// An async client of the daemon, for the checks that look at the daemon from outside.
    fn list_daemon(endpoint: &str) -> Vec<noren_core::daemon::SessionInfo> {
        let endpoint = Endpoint::named(endpoint).expect("endpoint");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let (client, _events) = DaemonClient::connect(&endpoint).await.expect("connect");
            client.list().await.expect("list")
        })
    }

    // ---- the pure parts ----

    fn os(pairs: &[(&str, &str)]) -> impl Iterator<Item = (OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn the_environment_of_the_app_goes_first_and_the_spec_has_the_last_word() {
        let mut spec = shell_spec();
        spec.env = vec![("PATH".to_owned(), "from-the-spec".to_owned())];
        let sent = prepare_spec(
            spec,
            os(&[("PATH", "from-the-app"), ("HOME", "/home/me")]),
            None,
        );
        assert_eq!(
            sent.env,
            vec![
                ("PATH".to_owned(), "from-the-app".to_owned()),
                ("HOME".to_owned(), "/home/me".to_owned()),
                ("PATH".to_owned(), "from-the-spec".to_owned()),
            ],
            "the daemon applies them in order, so the spec's PATH is the one that stays"
        );
    }

    #[test]
    fn what_the_daemon_would_refuse_is_not_sent() {
        let sent = prepare_spec(
            shell_spec(),
            os(&[
                ("=C:", "C:\\work"),
                ("", "empty name"),
                ("A=B", "x"),
                ("OK", "fine"),
                ("NUL", "a\0b"),
            ]),
            None,
        );
        assert_eq!(sent.env, vec![("OK".to_owned(), "fine".to_owned())]);
    }

    #[test]
    fn the_folder_of_the_app_stands_in_for_a_missing_one_and_never_replaces_one() {
        let app = Some(PathBuf::from("app-folder"));
        let without = prepare_spec(shell_spec(), os(&[]), app.clone());
        assert_eq!(without.cwd, app);
        let mut with = shell_spec();
        with.cwd = Some(PathBuf::from("tab-folder"));
        let kept = prepare_spec(with, os(&[]), app);
        assert_eq!(kept.cwd, Some(PathBuf::from("tab-folder")));
        assert_eq!(prepare_spec(shell_spec(), os(&[]), None).cwd, None);
    }

    #[test]
    fn nobody_home_is_told_from_somebody_home_but_not_for_us() {
        let endpoint = Endpoint::named("classify").unwrap();
        for kind in [io::ErrorKind::NotFound, io::ErrorKind::ConnectionRefused] {
            let absent = classify(ClientError::Connect(io::Error::from(kind)), &endpoint);
            assert_eq!(absent, OpenError::Absent, "{kind:?}");
        }
        let denied = classify(
            ClientError::Connect(io::Error::from(io::ErrorKind::PermissionDenied)),
            &endpoint,
        );
        assert!(matches!(denied, OpenError::Other(_)), "{denied:?}");

        let mismatch = classify(
            ClientError::Server(noren_core::daemon::ErrorBody::new(
                ErrorCode::VersionMismatch,
                "the client speaks protocol version 9 and this daemon speaks version 2",
            )),
            &endpoint,
        );
        let OpenError::Other(text) = mismatch else {
            panic!("a daemon of another version is not an absent one");
        };
        assert!(text.contains("another protocol version"), "{text}");
        assert!(
            text.contains("version 9") && text.contains("classify"),
            "{text}"
        );
    }

    #[test]
    fn an_error_of_the_daemon_reads_like_one_of_the_session_manager() {
        let unknown = SessionError::from(ClientError::Server(noren_core::daemon::ErrorBody::new(
            ErrorCode::UnknownSession,
            "unknown session 7",
        )));
        assert_eq!(unknown.to_string(), "unknown session 7");
        let closed = SessionError::from(ClientError::Closed);
        assert!(closed.to_string().contains("ended"), "{closed}");
    }

    #[test]
    fn the_default_program_sits_next_to_the_executable() {
        let program = default_program().expect("the test knows where it is");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(program.parent(), exe.parent());
        let name = program.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            name,
            if cfg!(windows) {
                "norend.exe"
            } else {
                "norend"
            }
        );
    }

    // ---- a daemon that is already running ----

    #[test]
    fn a_daemon_that_is_running_is_used_without_starting_another() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let daemon = start_daemon(&endpoint);
        // A path with nothing at it: if the app tried to launch norend, it would say so.
        let sessions = sessions(settings(&endpoint, Some(missing_program())));

        assert_eq!(
            sessions.placement(),
            Placement::Daemon {
                endpoint: endpoint.clone(),
                norend_pid: None
            },
            "found, not started"
        );
        let (id, shell) = start_shell(&sessions);
        assert_eq!(daemon.session_count(), 1, "the shell lives in the daemon");
        assert_eq!(sessions.session_count(), 1);
        assert_eq!(sessions.live_threads(), 0, "no thread of ours runs it");

        sessions
            .write(id, &echo_command("link-hello"))
            .expect("write");
        shell.wait_for_line("link-hello");

        // The pid comes from the list of the daemon (SessionInfo).
        let listed = list_daemon(&endpoint);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].pid.is_some());
        assert_eq!(sessions.process_ids(&[id]), vec![(id, listed[0].pid)]);
        assert_eq!(
            sessions.process_ids(&[SessionId(9999)]),
            vec![(SessionId(9999), None)],
            "a session nobody knows has no pid"
        );

        sessions.resize(id, 100, 30).expect("resize");
        let listed = list_daemon(&endpoint);
        assert_eq!((listed[0].cols, listed[0].rows), (100, 30));

        sessions.kill(id).expect("kill");
        assert_eq!(daemon.session_count(), 0, "killing releases the session");
        assert_eq!(sessions.session_count(), 0);
        shell.wait_for_exit();
        assert!(sessions.kill(id).is_err(), "it is gone");
        assert!(!shell.after_exit.load(Ordering::SeqCst));
    }

    #[test]
    fn the_output_comes_in_order_once_and_the_end_comes_last_with_its_code() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let _daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));

        // The first line is printed while the session is being attached, the second after.
        let printer = Recorder::default();
        let id = sessions
            .spawn(two_lines_spec("link-first", "link-second"), printer.sink())
            .expect("start");
        printer.wait_for_line("link-second");
        let text = printer.text();
        let lines: Vec<&str> = text.split(['\r', '\n']).map(str::trim).collect();
        let at = |wanted: &str| lines.iter().position(|line| *line == wanted);
        let (first, second) = (at("link-first"), at("link-second"));
        assert!(first.is_some() && first < second, "in order: {text:?}");
        assert_eq!(
            lines.iter().filter(|line| **line == "link-first").count(),
            1,
            "nothing repeated: {text:?}"
        );
        let info = printer.wait_for_exit();
        assert_eq!(info.code, 0);
        assert!(!printer.after_exit.load(Ordering::SeqCst));
        // An ended session stays until it is killed, as it does in the session manager.
        assert_eq!(sessions.session_count(), 1);
        assert!(sessions.write(id, b"x").is_err(), "nothing to write to");
        assert_eq!(sessions.process_ids(&[id]), vec![(id, None)]);
        sessions.kill(id).expect("release it");
        assert_eq!(sessions.session_count(), 0);

        let failing = Recorder::default();
        let id = sessions
            .spawn(exit_three_spec(), failing.sink())
            .expect("start");
        assert_eq!(failing.wait_for_exit().code, 3);
        sessions.kill(id).expect("release it");
    }

    #[test]
    fn a_session_that_cannot_start_is_an_error_not_a_hang() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let _daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let mut spec = shell_spec();
        spec.program = "noren-no-such-program-91c3".to_owned();
        let error = sessions
            .spawn(spec, |_event| {})
            .expect_err("no such program");
        assert!(!error.to_string().is_empty());
        let mut zero = shell_spec();
        zero.cols = 0;
        assert!(sessions.spawn(zero, |_event| {}).is_err());
        assert_eq!(sessions.session_count(), 0);
    }

    #[test]
    fn the_app_ending_its_sessions_leaves_the_daemon_running() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let (_id, shell) = start_shell(&sessions);
        assert_eq!(daemon.session_count(), 1);

        sessions.shutdown();
        assert_eq!(daemon.session_count(), 0, "no session outlives the app");
        shell.wait_for_exit();
        assert_eq!(sessions.session_count(), 0);
        // The daemon itself is still there for the next client.
        assert!(sessions.daemon_listens());
        assert!(list_daemon(&endpoint).is_empty());
    }

    // ---- leaving shells in the daemon and taking them over (NOR-F14-02b) ----

    #[test]
    fn leaving_keeps_the_sessions_asked_for_running_and_ends_the_others() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let (stays, stays_output) = start_shell(&sessions);
        let (_goes, goes_output) = start_shell(&sessions);
        let pid = sessions.process_ids(&[stays])[0]
            .1
            .expect("a live shell has a pid");
        assert_eq!(daemon.session_count(), 2);

        sessions.detach(&[stays]);

        goes_output.wait_for_exit();
        let listed = list_daemon(&endpoint);
        assert_eq!(listed.len(), 1, "only the one asked for is left");
        assert_eq!(listed[0].session, stays);
        assert_eq!(listed[0].pid, Some(pid), "the same process");
        assert!(listed[0].exit.is_none(), "still running");
        assert!(process_exists(pid));
        assert!(
            lock(&stays_output.exit).is_none(),
            "the one left was not told it ended"
        );
        assert_eq!(sessions.session_count(), 0, "this run no longer holds it");

        // Clean up after the check: the session is the daemon's now, and killing it works from here.
        sessions.kill(stays).expect("release it");
        wait_until_gone(pid);
    }

    #[test]
    fn a_later_run_takes_over_a_session_an_earlier_one_left_with_what_it_printed() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let daemon = start_daemon(&endpoint);

        let first = sessions(settings(&endpoint, Some(missing_program())));
        let (id, output) = start_shell(&first);
        first
            .write(id, &echo_command("noren-left-behind"))
            .expect("write");
        output.wait_for_line("noren-left-behind");
        let pid = first.process_ids(&[id])[0].1.expect("pid");
        first.detach(&[id]);
        // The first run is gone; its connection closes with it.
        drop(first);

        let second = sessions(settings(&endpoint, Some(missing_program())));
        let listed = second.list().expect("the daemon lists what it holds");
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].session, listed[0].pid), (id, Some(pid)));
        assert!(!second.owns(id), "not this run's until it takes it over");
        assert_eq!(second.session_count(), 0);

        let taken = Recorder::default();
        second.reattach(id, taken.sink()).expect("take it over");
        assert!(second.owns(id));
        assert_eq!(second.session_count(), 1);
        // What it printed while no app was attached comes first ...
        taken.wait_for_line("noren-left-behind");
        // ... and it is the same shell, answering.
        second
            .write(id, &echo_command("noren-answers-again"))
            .expect("write");
        taken.wait_for_line("noren-answers-again");
        assert_eq!(second.process_ids(&[id])[0].1, Some(pid));
        assert_eq!(daemon.session_count(), 1, "nothing was started");

        // From here on it is an ordinary session of this run: its end is reported, once.
        second.kill(id).expect("kill");
        taken.wait_for_exit();
        assert!(!taken.after_exit.load(Ordering::SeqCst));
        assert_eq!(second.session_count(), 0);
        assert_eq!(daemon.session_count(), 0);
    }

    #[test]
    fn a_session_that_is_not_in_the_daemon_cannot_be_taken_over() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let _daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let refusal = sessions
            .reattach(SessionId(987_654), |_| {})
            .expect_err("no such session");
        assert!(!refusal.to_string().is_empty());
        assert!(!sessions.owns(SessionId(987_654)));
        assert_eq!(sessions.session_count(), 0);
    }

    #[test]
    fn sessions_in_this_process_hold_nothing_for_a_later_run() {
        let _turn = lock(&ONE_AT_A_TIME);
        let sessions = Sessions::new(Host::InProcess);
        assert!(!sessions.in_daemon());
        assert_eq!(sessions.list().expect("list"), Vec::new());
        let refusal = sessions
            .reattach(SessionId(1), |_| {})
            .expect_err("nothing outlives this process");
        assert!(
            refusal.to_string().contains("do not run in a daemon"),
            "{refusal}"
        );

        let (id, output) = start_shell(&sessions);
        assert!(sessions.owns(id));
        // There is no daemon to leave it in: leaving ends every session.
        sessions.detach(&[id]);
        output.wait_for_exit();
        assert!(!sessions.owns(id));
    }

    #[test]
    fn a_run_that_owns_its_daemon_stops_it_when_it_leaves() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut own = settings(&endpoint, Some(norend_binary()));
        own.stop_on_shutdown = true;
        let sessions = sessions(own);
        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = sessions.placement()
        else {
            panic!("expected a norend this run started");
        };
        let (id, output) = start_shell(&sessions);
        let pid = sessions.process_ids(&[id])[0].1.expect("pid");

        // Leaving is a way out, but the smoke runs own their daemon: nothing is left behind for them.
        sessions.detach(&[id]);
        output.wait_for_exit();
        wait_until_gone(norend);
        wait_until_gone(pid);
        assert!(
            !sessions.daemon_listens(),
            "the daemon of the run was stopped"
        );
    }

    #[test]
    fn a_shell_left_in_a_norend_the_app_started_is_there_for_the_next_run() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let first = sessions(settings(&endpoint, Some(norend_binary())));
        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = first.placement()
        else {
            panic!("expected a norend this run started");
        };
        let (id, output) = start_shell(&first);
        first
            .write(id, &echo_command("noren-survives-the-app"))
            .expect("write");
        output.wait_for_line("noren-survives-the-app");
        let pid = first.process_ids(&[id])[0].1.expect("pid");

        first.detach(&[id]);
        drop(first);

        // The app that started both is gone, and both go on.
        assert!(process_exists(norend), "norend outlives the app");
        assert!(process_exists(pid), "and so does the shell");

        // The next run finds that daemon (it would not start one: there is no norend for it to try).
        let second = sessions(settings(&endpoint, Some(missing_program())));
        assert!(matches!(
            second.placement(),
            Placement::Daemon {
                norend_pid: None,
                ..
            }
        ));
        let taken = Recorder::default();
        second.reattach(id, taken.sink()).expect("take it over");
        taken.wait_for_line("noren-survives-the-app");
        assert_eq!(second.process_ids(&[id])[0].1, Some(pid), "the same shell");

        second.stop_daemon().expect("stop the daemon");
        wait_until_gone(norend);
        wait_until_gone(pid);
        assert!(!second.daemon_listens());
    }

    // ---- quitting for good (NOR-F14-02c) ----

    /// Whether anything accepts a connection on `endpoint`, asked from outside the app's link.
    fn endpoint_answers(endpoint: &str) -> bool {
        let endpoint = Endpoint::named(endpoint).expect("endpoint");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async { DaemonClient::connect(&endpoint).await.is_ok() })
    }

    /// Waits until `child` ends and returns how.
    fn wait_for_child(child: &mut Child) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(40);
        loop {
            if let Some(status) = child.try_wait().expect("ask the child") {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "the process {} did not end",
                child.id()
            );
            thread::sleep(Duration::from_millis(30));
        }
    }

    /// A `norend` somebody else started: killed on drop, so a failing test leaves nothing running.
    struct OtherNorend(Child);

    impl OtherNorend {
        /// Starts it the way the app does and waits until it answers.
        fn start(endpoint: &str) -> Self {
            let child = launch_norend(&norend_binary(), endpoint).expect("start norend");
            let norend = Self(child);
            let deadline = Instant::now() + Duration::from_secs(40);
            while !endpoint_answers(endpoint) {
                assert!(Instant::now() < deadline, "the norend never listened");
                thread::sleep(Duration::from_millis(30));
            }
            norend
        }
    }

    impl Drop for OtherNorend {
        fn drop(&mut self) {
            if matches!(self.0.try_wait(), Ok(None)) {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }

    #[test]
    fn quitting_for_good_ends_the_sessions_stops_the_daemon_the_app_started_and_frees_the_endpoint()
    {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        // A normal run: the daemon outlives the app, unless the person quits for good.
        let sessions = sessions(settings(&endpoint, Some(norend_binary())));
        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = sessions.placement()
        else {
            panic!("expected a norend this run started");
        };
        let (first, first_output) = start_shell(&sessions);
        let (second, second_output) = start_shell(&sessions);
        let pids = [first, second].map(|id| sessions.process_ids(&[id])[0].1.expect("pid"));
        assert!(process_exists(norend) && pids.iter().all(|pid| process_exists(*pid)));
        assert!(sessions.daemon_listens());

        let stopped = sessions.quit_for_good().expect("quit for good");

        assert_eq!(
            stopped,
            Stopped {
                norend_pid: Some(norend),
                exit_code: Some(0)
            },
            "norend ended on its own, cleanly"
        );
        assert!(!process_exists(norend), "the daemon is gone");
        first_output.wait_for_exit();
        second_output.wait_for_exit();
        for pid in pids {
            wait_until_gone(pid);
        }
        assert!(!sessions.daemon_listens(), "the endpoint is free");
        assert!(!endpoint_answers(&endpoint));
        assert_eq!(sessions.session_count(), 0, "and the app holds no session");
    }

    #[test]
    fn quitting_for_good_also_stops_a_daemon_that_somebody_else_started() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut other = OtherNorend::start(&endpoint);
        // This run finds the daemon (it could not start one), as after a close with the shells kept.
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        assert_eq!(
            sessions.placement(),
            Placement::Daemon {
                endpoint: endpoint.clone(),
                norend_pid: None
            }
        );
        let (id, output) = start_shell(&sessions);
        let pid = sessions.process_ids(&[id])[0].1.expect("pid");

        let stopped = sessions.quit_for_good().expect("quit for good");

        assert_eq!(
            stopped,
            Stopped {
                norend_pid: None,
                exit_code: None
            },
            "this run did not start it, so it has no process to wait for"
        );
        // It did not return before the sessions had ended and the endpoint was free: that is checked
        // first, with nothing in between (this run has no process to wait for, so the shell is the
        // sign), and only then that the daemon itself ended well.
        assert!(
            !process_exists(pid),
            "the shell was still running when it returned"
        );
        assert!(!endpoint_answers(&endpoint));
        assert!(!sessions.daemon_listens());
        assert_eq!(wait_for_child(&mut other.0).code(), Some(0));
        output.wait_for_exit();
    }

    #[test]
    fn quitting_for_good_ends_the_sessions_nobody_of_this_run_started_too() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut other = OtherNorend::start(&endpoint);
        // A shell a run before this one left in the daemon, which this run never took over.
        let before = sessions(settings(&endpoint, Some(missing_program())));
        let (left, left_output) = start_shell(&before);
        let left_pid = before.process_ids(&[left])[0].1.expect("pid");
        before.detach(&[left]);
        drop(before);

        let now = sessions(settings(&endpoint, Some(missing_program())));
        assert_eq!(now.session_count(), 0, "this run owns nothing");
        now.quit_for_good().expect("quit for good");

        assert!(
            !process_exists(left_pid),
            "the shell nobody took over was still running"
        );
        assert!(!endpoint_answers(&endpoint));
        assert_eq!(wait_for_child(&mut other.0).code(), Some(0));
        drop(left_output);
    }

    #[test]
    fn quitting_for_good_finds_the_daemon_again_when_the_connection_of_the_run_was_cut() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut other = OtherNorend::start(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let (id, output) = start_shell(&sessions);
        let pid = sessions.process_ids(&[id])[0].1.expect("pid");
        // The daemon is fine but this run's connection is not (the daemon cuts a client that does
        // not read): every call fails, and the daemon is still there to stop.
        let Backend::Daemon(link) = &*sessions.backend else {
            panic!("expected a daemon");
        };
        lock(&link.conn)
            .as_ref()
            .expect("a connection")
            .lost
            .store(true, Ordering::SeqCst);
        assert!(sessions.write(id, b"x").is_err());

        sessions.quit_for_good().expect("quit for good");

        assert!(
            !process_exists(pid),
            "the shell was still running when it returned"
        );
        assert!(!endpoint_answers(&endpoint));
        assert_eq!(wait_for_child(&mut other.0).code(), Some(0));
        drop(output);
    }

    #[test]
    fn quitting_for_good_when_the_daemon_is_already_gone_is_not_an_error() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let (_id, output) = start_shell(&sessions);
        daemon.shutdown();
        output.wait_for_exit();
        // The link learns that the connection ended a moment after the shell is reported gone.
        let Backend::Daemon(link) = &*sessions.backend else {
            panic!("expected a daemon");
        };
        let deadline = Instant::now() + Duration::from_secs(40);
        while link.live_connection().is_ok() {
            assert!(Instant::now() < deadline, "the link never noticed");
            thread::sleep(Duration::from_millis(20));
        }

        // It must not start a daemon just to stop it.
        assert_eq!(
            sessions.quit_for_good(),
            Ok(Stopped {
                norend_pid: None,
                exit_code: None
            })
        );
        assert!(!endpoint_answers(&endpoint));
        assert_eq!(sessions.session_count(), 0);
    }

    #[test]
    fn waiting_for_processes_to_be_gone_ends_with_them_and_names_the_ones_that_stay() {
        // A real process that stays up until it is killed.
        #[cfg(windows)]
        let mut child = Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .spawn()
            .expect("start ping");
        #[cfg(unix)]
        let mut child = Command::new("sleep")
            .arg("60")
            .spawn()
            .expect("start sleep");
        let pid = child.id();

        // Nothing to wait for is done at once.
        assert!(wait_until_processes_gone(&[], Instant::now()).is_ok());
        // A pid that is running when the time is up is an error that names it.
        let error = wait_until_processes_gone(&[pid], Instant::now() + Duration::from_millis(300))
            .expect_err("it still runs");
        assert!(error.to_string().contains(&pid.to_string()), "{error}");

        // Gone, it is a success: waiting while another thread ends it.
        let ender = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            let _ = child.kill();
            let _ = child.wait();
        });
        let waited = Instant::now();
        wait_until_processes_gone(&[pid], Instant::now() + Duration::from_secs(30))
            .expect("it ended");
        assert!(
            waited.elapsed() >= Duration::from_millis(200),
            "it did wait"
        );
        ender.join().unwrap();
    }

    #[test]
    fn quitting_for_good_with_the_sessions_in_this_process_just_ends_them() {
        let _turn = lock(&ONE_AT_A_TIME);
        let sessions = Sessions::new(Host::InProcess);
        let (id, output) = start_shell(&sessions);

        assert_eq!(
            sessions.quit_for_good(),
            Ok(Stopped {
                norend_pid: None,
                exit_code: None
            })
        );

        output.wait_for_exit();
        assert!(!sessions.owns(id));
        assert_eq!(sessions.session_count(), 0);
    }

    #[test]
    fn whether_the_sessions_are_in_a_daemon_can_be_asked_without_waiting_for_the_search() {
        let dir = std::env::temp_dir().join(format!("noren-slow-norend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Stays up and listens on nothing, so the search takes as long as the launch timeout.
        #[cfg(windows)]
        let slow = {
            let path = dir.join("slow-norend.cmd");
            std::fs::write(&path, "@ping -n 6 127.0.0.1 > nul\r\n").unwrap();
            path
        };
        #[cfg(unix)]
        let slow = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("slow-norend");
            std::fs::write(&path, "#!/bin/sh\nsleep 5\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let mut own = settings(&unique_endpoint(), Some(slow));
        own.launch_timeout = Duration::from_millis(800);
        let sessions = sessions(own);

        // Still looking: the answer is "not known yet", at once.
        let asked = Instant::now();
        assert_eq!(sessions.in_daemon_now(), None);
        assert!(asked.elapsed() < Duration::from_millis(300));

        // The search gave up: known, and not in a daemon.
        assert!(!sessions.in_daemon());
        assert_eq!(sessions.in_daemon_now(), Some(false));
        let _ = std::fs::remove_dir_all(&dir);

        // A search that finds a daemon, and the plain in-process host, are known too.
        assert_eq!(
            Sessions::new(Host::InProcess).in_daemon_now(),
            Some(false),
            "no daemon was asked for"
        );
        let endpoint = unique_endpoint();
        let _daemon = start_daemon(&endpoint);
        let found = sessions_for(&endpoint);
        assert!(found.in_daemon());
        assert_eq!(found.in_daemon_now(), Some(true));
    }

    /// Sessions that find the daemon already on `endpoint`.
    fn sessions_for(endpoint: &str) -> Sessions {
        sessions(settings(endpoint, Some(missing_program())))
    }

    // ---- a daemon that has to be started ----

    #[test]
    fn norend_is_started_when_none_answers_and_the_session_runs_in_it() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut own = settings(&endpoint, Some(norend_binary()));
        own.stop_on_shutdown = true;
        let sessions = sessions(own);

        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = sessions.placement()
        else {
            panic!(
                "expected a daemon this run started: {:?}",
                sessions.placement()
            );
        };
        assert_ne!(norend, std::process::id(), "another process");

        let (id, shell) = start_shell(&sessions);
        let shell_pid = sessions.process_ids(&[id])[0]
            .1
            .expect("the pid of the shell");
        let processes = SystemProcesses::new().snapshot();
        let parent = processes
            .iter()
            .find(|process| process.pid == shell_pid)
            .and_then(|process| process.parent);
        assert_eq!(
            parent,
            Some(norend),
            "the shell is a child of norend, not of the app"
        );

        // It starts where the app is, not where norend is (the temporary folder).
        sessions.write(id, CWD_COMMAND).expect("write");
        let here = std::env::current_dir().unwrap();
        let name = here.file_name().unwrap().to_string_lossy().into_owned();
        let deadline = Instant::now() + Duration::from_secs(40);
        while !shell.text().contains(&name) {
            assert!(
                Instant::now() < deadline,
                "the shell is not in {}: {:?}",
                here.display(),
                shell.text()
            );
            thread::sleep(Duration::from_millis(30));
        }

        let stopped = sessions.stop_daemon().expect("stop");
        assert_eq!(
            stopped,
            Stopped {
                norend_pid: Some(norend),
                exit_code: Some(0)
            }
        );
        assert!(!process_exists(norend));
        assert!(!sessions.daemon_listens(), "nothing listens any more");
        shell.wait_for_exit();
        // A stopped daemon has no sessions to call.
        assert!(sessions.write(id, b"x").is_err());
    }

    #[test]
    fn the_daemon_the_app_started_outlives_the_app_and_the_next_run_finds_it() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let first = sessions(settings(&endpoint, Some(norend_binary())));
        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = first.placement()
        else {
            panic!(
                "expected a daemon this run started: {:?}",
                first.placement()
            );
        };
        let (_id, shell) = start_shell(&first);

        // The app quits: its sessions end, it lets go of the daemon.
        first.shutdown();
        shell.wait_for_exit();
        drop(first);
        thread::sleep(Duration::from_millis(300));
        assert!(process_exists(norend), "the daemon is a program of its own");

        // The next run finds it on the endpoint instead of starting another.
        let mut next = settings(&endpoint, Some(missing_program()));
        next.stop_on_shutdown = true;
        let second = sessions(next);
        assert_eq!(
            second.placement(),
            Placement::Daemon {
                endpoint: endpoint.clone(),
                norend_pid: None
            }
        );
        let (_id, shell) = start_shell(&second);
        assert_eq!(list_daemon(&endpoint).len(), 1, "same daemon, one session");
        second.shutdown();
        shell.wait_for_exit();
        wait_until_gone(norend);
        assert!(!second.daemon_listens());
    }

    #[test]
    fn two_apps_starting_at_once_end_up_on_one_daemon() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let norend = norend_binary();
        let a = sessions(settings(&endpoint, Some(norend.clone())));
        let b = sessions(settings(&endpoint, Some(norend)));
        let (pid_a, pid_b) = (a.placement(), b.placement());
        let started = [&pid_a, &pid_b]
            .iter()
            .filter(|p| {
                matches!(
                    p,
                    Placement::Daemon {
                        norend_pid: Some(_),
                        ..
                    }
                )
            })
            .count();
        assert!(
            matches!(pid_a, Placement::Daemon { .. }) && matches!(pid_b, Placement::Daemon { .. }),
            "{pid_a:?} {pid_b:?}"
        );
        assert!(started >= 1, "somebody started it");
        let (_ida, shell_a) = start_shell(&a);
        let (_idb, shell_b) = start_shell(&b);
        assert_eq!(
            list_daemon(&endpoint).len(),
            2,
            "both sessions in the same daemon"
        );
        a.shutdown();
        b.shutdown();
        shell_a.wait_for_exit();
        shell_b.wait_for_exit();
        // Stop it for good: ask through whoever started it, or a client of our own.
        let endpoint_value = Endpoint::named(&endpoint).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (client, _events) = DaemonClient::connect(&endpoint_value).await.unwrap();
            client.shutdown().await.unwrap();
        });
        for placement in [pid_a, pid_b] {
            if let Placement::Daemon {
                norend_pid: Some(pid),
                ..
            } = placement
            {
                wait_until_gone(pid);
            }
        }
    }

    // ---- the daemon answers a connection in turn ----

    /// A daemon that speaks the protocol and nothing else: it answers every `Write` with `Ok`, and
    /// a connection that sends a `Create` is never answered again (the daemon serves the requests
    /// of one connection in turn, so a session that takes long to start holds that connection). It
    /// stops when the returned sender is dropped or sent to.
    fn fake_daemon_that_never_finishes_a_create(
        endpoint: &str,
    ) -> tokio::sync::oneshot::Sender<()> {
        use noren_core::daemon::ipc::Listener;
        use noren_core::daemon::{
            ClientMessage, PROTOCOL_VERSION, Request, Response, ServerMessage, read_frame,
            write_frame,
        };

        let endpoint = Endpoint::named(endpoint).expect("endpoint");
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let (ready_tx, ready) = mpsc::channel();
        thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let mut listener = Listener::bind(&endpoint).expect("bind");
                ready_tx.send(()).expect("tell the test");
                let serving = async {
                    loop {
                        let Ok(stream) = listener.accept().await else {
                            continue;
                        };
                        tokio::spawn(async move {
                            let (mut reader, mut writer) = tokio::io::split(stream);
                            while let Ok(payload) = read_frame(&mut reader).await {
                                let answer = match ClientMessage::decode(&payload) {
                                    Ok(ClientMessage::Hello { .. }) => ServerMessage::Welcome {
                                        version: PROTOCOL_VERSION,
                                    },
                                    Ok(ClientMessage::Request {
                                        request: Request::Create(_),
                                        ..
                                    }) => {
                                        // Never answered, and nothing after it is read.
                                        std::future::pending::<()>().await;
                                        return;
                                    }
                                    Ok(ClientMessage::Request { id, .. }) => {
                                        ServerMessage::Response {
                                            id,
                                            response: Response::Ok,
                                        }
                                    }
                                    Err(_) => return,
                                };
                                let frame = answer.to_frame().expect("frame");
                                if write_frame(&mut writer, &frame).await.is_err() {
                                    return;
                                }
                            }
                        });
                    }
                };
                tokio::select! {
                    () = serving => {},
                    _ = stopped => {},
                }
            });
        });
        ready.recv().expect("the fake daemon is listening");
        stop
    }

    #[test]
    fn typing_is_not_held_up_by_a_session_that_takes_long_to_start() {
        let endpoint = unique_endpoint();
        let _stop = fake_daemon_that_never_finishes_a_create(&endpoint);
        let sessions = Arc::new(sessions(settings(&endpoint, Some(missing_program()))));
        assert!(matches!(sessions.placement(), Placement::Daemon { .. }));

        // A session that never finishes starting holds the connection that creates sessions.
        let creating = Arc::clone(&sessions);
        thread::spawn(move || {
            let _ = creating.spawn(shell_spec(), |_event| {});
        });
        thread::sleep(Duration::from_millis(300));

        // What is typed and the size of a terminal go on their own connection, and are answered.
        let (done, answered) = mpsc::channel();
        let typing = Arc::clone(&sessions);
        thread::spawn(move || {
            let _ = done.send((
                typing.write(SessionId(1), b"ls\r"),
                typing.resize(SessionId(1), 100, 30),
            ));
        });
        let (written, resized) = answered
            .recv_timeout(Duration::from_secs(10))
            .expect("typing waited behind the session that is starting");
        assert_eq!(written, Ok(()));
        assert_eq!(resized, Ok(()));
    }

    // ---- no daemon: back to the session manager ----

    #[test]
    fn without_norend_the_sessions_run_in_this_process() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let sessions = sessions(settings(&endpoint, Some(missing_program())));

        let Placement::Process {
            reason: Some(reason),
        } = sessions.placement()
        else {
            panic!("expected the fallback: {:?}", sessions.placement());
        };
        assert!(reason.contains("norend was not found"), "{reason}");
        assert!(reason.contains("noren-no-such-norend"), "{reason}");

        // It works all the same, through the session manager of the app.
        let (id, shell) = start_shell(&sessions);
        assert_eq!(sessions.session_count(), 1);
        sessions
            .write(id, &echo_command("link-local"))
            .expect("write");
        shell.wait_for_line("link-local");
        let pid = sessions.process_ids(&[id])[0]
            .1
            .expect("a live shell has a pid");
        let processes = SystemProcesses::new().snapshot();
        let parent = processes
            .iter()
            .find(|process| process.pid == pid)
            .and_then(|process| process.parent);
        assert_eq!(
            parent,
            Some(std::process::id()),
            "a child of this very process"
        );
        assert!(sessions.live_threads() > 0, "the threads are ours");
        sessions.resize(id, 90, 20).expect("resize");
        sessions.kill(id).expect("kill");
        shell.wait_for_exit();
        assert_eq!(sessions.session_count(), 0);
        assert!(
            sessions.stop_daemon().is_err(),
            "there is no daemon to stop"
        );
        assert!(!sessions.daemon_listens());
    }

    #[test]
    fn a_name_that_cannot_be_an_endpoint_falls_back_with_the_reason() {
        let sessions = sessions(settings("not a name", Some(norend_binary())));
        let Placement::Process {
            reason: Some(reason),
        } = sessions.placement()
        else {
            panic!("expected the fallback");
        };
        assert!(reason.contains("not a valid daemon name"), "{reason}");
    }

    #[test]
    fn a_program_that_ends_before_it_listens_falls_back_with_its_exit_code() {
        let dir = std::env::temp_dir().join(format!("noren-fake-norend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(windows)]
        let fake = {
            let path = dir.join("fake-norend.cmd");
            std::fs::write(&path, "@exit /b 7\r\n").unwrap();
            path
        };
        #[cfg(unix)]
        let fake = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-norend");
            std::fs::write(&path, "#!/bin/sh\nexit 7\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let sessions = sessions(settings(&unique_endpoint(), Some(fake)));
        let Placement::Process {
            reason: Some(reason),
        } = sessions.placement()
        else {
            panic!("expected the fallback: {:?}", sessions.placement());
        };
        assert!(reason.contains("before it listened"), "{reason}");
        assert!(reason.contains('7'), "{reason}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_program_that_never_listens_is_given_up_on_and_ended() {
        let dir = std::env::temp_dir().join(format!("noren-idle-norend-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Stays up and listens on nothing.
        #[cfg(windows)]
        let idle = {
            let path = dir.join("idle-norend.cmd");
            std::fs::write(&path, "@ping -n 6 127.0.0.1 > nul\r\n").unwrap();
            path
        };
        #[cfg(unix)]
        let idle = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("idle-norend");
            std::fs::write(&path, "#!/bin/sh\nsleep 5\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let mut own = settings(&unique_endpoint(), Some(idle));
        own.launch_timeout = Duration::from_millis(600);
        let started = Instant::now();
        let sessions = sessions(own);
        let Placement::Process {
            reason: Some(reason),
        } = sessions.placement()
        else {
            panic!("expected the fallback");
        };
        assert!(reason.contains("did not listen"), "{reason}");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "it gave up in time"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- a daemon that goes away ----

    #[test]
    fn a_daemon_that_goes_away_ends_the_sessions_and_the_next_one_finds_it_again() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut daemon = start_daemon(&endpoint);
        let sessions = sessions(settings(&endpoint, Some(missing_program())));
        let (id, shell) = start_shell(&sessions);

        daemon.shutdown();
        let info = shell.wait_for_exit();
        assert_ne!(
            info.code, 0,
            "a session lost with its daemon did not end well"
        );
        assert!(sessions.write(id, b"x").is_err());
        assert!(sessions.resize(id, 80, 24).is_err());
        assert!(sessions.process_ids(&[id])[0].1.is_none());
        assert!(!sessions.daemon_listens());

        // Nothing to find: the next session fails fast with the reason, once, then soon again.
        let error = sessions
            .spawn(shell_spec(), |_event| {})
            .expect_err("no daemon, no norend");
        assert!(
            error.to_string().contains("could not be reached again"),
            "{error}"
        );
        let again = Instant::now();
        assert!(sessions.spawn(shell_spec(), |_event| {}).is_err());
        assert!(
            again.elapsed() < Duration::from_secs(1),
            "it does not wait twice"
        );

        // A daemon is back on the endpoint: the next session uses it, after the pause.
        let _daemon = start_daemon(&endpoint);
        thread::sleep(RETRY_AFTER + Duration::from_millis(200));
        let (_id, shell) = start_shell(&sessions);
        assert_eq!(list_daemon(&endpoint).len(), 1);
        drop(shell);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_norend_has_a_process_group_of_its_own() {
        let _turn = lock(&ONE_AT_A_TIME);
        let endpoint = unique_endpoint();
        let mut own = settings(&endpoint, Some(norend_binary()));
        own.stop_on_shutdown = true;
        let sessions = sessions(own);
        let Placement::Daemon {
            norend_pid: Some(norend),
            ..
        } = sessions.placement()
        else {
            panic!("expected a daemon this run started");
        };
        // Field 5 of /proc/<pid>/stat is the process group; the name (field 2) may hold spaces, so
        // the fields are counted from the closing parenthesis.
        let group = |pid: &str| -> i64 {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("stat");
            let after = &stat[stat.rfind(')').expect("name") + 2..];
            after
                .split(' ')
                .nth(2)
                .expect("pgrp")
                .parse()
                .expect("number")
        };
        assert_ne!(group(&norend.to_string()), group("self"));
        assert_eq!(
            group(&norend.to_string()),
            i64::from(norend),
            "a leader of its own group"
        );
        sessions.stop_daemon().expect("stop");
    }
}

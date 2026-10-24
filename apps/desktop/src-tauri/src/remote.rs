//! Sessions in a `norend` on another machine, for the profiles of kind `ssh` (NOR-F14-04b).
//!
//! A tab of such a profile is a shell that lives in the daemon of another machine, reached through
//! the `ssh` of the system (`noren_core::daemon::SshTarget`, which runs `norend --bridge` there)
//! and kept up by a [`ReconnectingClient`]: when the connection breaks it is made again with a
//! bounded backoff and the sessions are attached again by their ids, so the shell never notices.
//! This module is the app's side of that, the way `daemon_link` is for the daemon on this machine.
//! Nothing here knows about Tauri, so its tests run anywhere the core does.
//!
//! - **One connection per machine.** The tabs of the same profile (host, user, port and files) share
//!   one `ssh` process and one client. The link is made when the first tab needs it and let go
//!   when the last session is gone, which ends the `ssh` (the shells stay in the daemon there).
//! - **Ids.** The daemon there numbers its sessions from 1, as the one here does, so a session of
//!   the page has an id of its own, from [`REMOTE_ID_BASE`] up, and this module keeps which session
//!   of which link it is. [`is_remote`] tells which side an id belongs to.
//! - **What a remote `Create` carries** is what the profile says and nothing else (see
//!   `Profile::remote_spec`): the caller builds the spec, and this module sends it as it is. No
//!   environment of this machine is added, as `daemon_link` does for the local daemon, and no
//!   folder.
//! - **Output after a reconnection**. The daemon answers an attach with everything it
//!   kept, which includes what the tab already shows. Each session remembers the latest bytes it
//!   handed over ([`DeliveredTail`]) and hands over only what follows them, or, when the daemon no
//!   longer reaches back that far, resets the terminal and hands over the whole replay (see
//!   `noren_core::daemon::replay`).
//! - **The state of the link** (`connected`, `reconnecting`, `failed`) goes to a callback of each
//!   session whenever it changes, and [`RemoteSessions::retry`] stops the wait between attempts or
//!   starts them over after a failure.
//! - **Calls while the connection is down** fail at once (nothing waits for it): what was typed is
//!   not kept. The exception is ending a session: the shell is released as soon as the connection
//!   is back.
//! - **The callbacks** are called from a task of the runtime of this module, never from the thread
//!   that called [`RemoteSessions::spawn`]: that thread may hold a lock the callback needs.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, mpsc as std_mpsc};
use std::time::Duration;

use noren_core::daemon::replay::{DeliveredTail, RESET_TERMINAL, ReplayPlan, plan_replay};
use noren_core::daemon::{
    BackoffPolicy, ClientError, ConnectFailure, Connector, ErrorCode, Established, LinkEvent,
    LinkEvents, LinkState, ReconnectingClient,
};
use noren_core::{ExitInfo, SessionEvent, SessionId, SpawnSpec, SshProfile};
use tokio::runtime::{Builder, Handle, Runtime};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};

use crate::daemon_link::{SessionError, Sink};

/// The first id of a session in the daemon of another machine. The page sees one list of session
/// ids, and the daemon of this machine and the one there both count from 1, so these start far above
/// anything the local one will reach.
pub const REMOTE_ID_BASE: u64 = 1 << 40;

// The page holds ids as JavaScript numbers, which are exact only up to 2^53.
const _: () = assert!(REMOTE_ID_BASE < (1 << 53));

/// Whether `id` is a session of a daemon on another machine (see [`REMOTE_ID_BASE`]).
pub fn is_remote(id: SessionId) -> bool {
    id.0 >= REMOTE_ID_BASE
}

/// The callback of a session for the state of its connection: the id of the session, and the state
/// it changed to.
pub type LinkSink = Box<dyn FnMut(SessionId, &LinkState) + Send>;

/// How a connection to a machine is made. The app's own is the `ssh` of the system
/// ([`ssh_connector`]); a test gives one that reaches a daemon it holds.
pub type ConnectorFor =
    Arc<dyn Fn(&SshProfile) -> Result<Box<dyn Connector>, SessionError> + Send + Sync>;

/// The connection the app makes: this machine's `ssh`, keys only, no prompt (`SshProfile::target`).
pub fn ssh_connector() -> ConnectorFor {
    Arc::new(|machine: &SshProfile| Ok(Box::new(machine.target()) as Box<dyn Connector>))
}

/// A boxed connector is a connector (the client takes one by value).
struct Boxed(Box<dyn Connector>);

impl Connector for Boxed {
    fn connect(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Established, ConnectFailure>> + Send + '_>> {
        self.0.connect()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Calls a callback; `false` when it panicked, which ends the output of that session but not of
/// the others.
fn guarded(call: impl FnOnce()) -> bool {
    let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(call));
    if called.is_err() {
        eprintln!("warning: the handler of a remote session panicked; its output is dropped");
    }
    called.is_ok()
}

// ---------------------------------------------------------------------------------------------
// The sessions of the app on other machines
// ---------------------------------------------------------------------------------------------

/// Every session of the app that lives in a daemon on another machine.
pub struct RemoteSessions {
    inner: Arc<Inner>,
}

struct Inner {
    /// Built when the first remote session is asked for, so an app with no SSH profile never starts
    /// a thread for this.
    runtime: OnceLock<Runtime>,
    connector_for: ConnectorFor,
    policy: BackoffPolicy,
    next_id: AtomicU64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The connection to each machine, with how many sessions (and sessions being made) hold it.
    links: HashMap<SshProfile, LinkEntry>,
    /// The sessions the page holds, by their id.
    sessions: HashMap<u64, Held>,
    /// One at a time per machine makes its connection, so tabs opened together (a workspace being
    /// restored) wait for the first one's `ssh` instead of each starting its own.
    connecting: HashMap<SshProfile, Arc<tokio::sync::Mutex<()>>>,
}

struct LinkEntry {
    link: Arc<Link>,
    /// Sessions held, plus sessions being started, plus ends waiting for the connection.
    users: usize,
}

/// A session the page holds.
struct Held {
    machine: SshProfile,
    link: Arc<Link>,
    /// Its id in the daemon there.
    remote: SessionId,
}

/// The connection to one machine and the task that turns what it reports into callbacks.
struct Link {
    client: Arc<ReconnectingClient>,
    commands: mpsc::UnboundedSender<Command>,
    pump: JoinHandle<()>,
}

impl Drop for Link {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

/// What the task of a link is asked to do.
enum Command {
    /// Attach to a session and hand its output and its end to `sink`.
    Add {
        remote: SessionId,
        app: SessionId,
        sink: Sink,
        status: LinkSink,
        /// Told once the session is attached (or why not).
        done: oneshot::Sender<Result<(), ClientError>>,
        /// Fires when the caller has the session in hand. What the session printed before that,
        /// and its end if it already came, are handed over only then: the callbacks of the page
        /// wait for the id the caller is about to return, and a callback that waits on a worker
        /// of this runtime for a caller that waits on the same runtime would never end.
        ready: oneshot::Receiver<()>,
    },
    /// The session was ended on purpose (the page closed its tab): if its end was not heard yet it
    /// is reported now, so every session ends exactly once for whoever listens. Answered when done.
    Ended {
        remote: SessionId,
        done: oneshot::Sender<()>,
    },
}

impl Default for RemoteSessions {
    fn default() -> Self {
        Self::new(ssh_connector(), BackoffPolicy::default())
    }
}

impl RemoteSessions {
    /// Sessions that reach their machines through `connector_for`, reconnecting by `policy`.
    pub fn new(connector_for: ConnectorFor, policy: BackoffPolicy) -> Self {
        Self {
            inner: Arc::new(Inner {
                runtime: OnceLock::new(),
                connector_for,
                policy,
                next_id: AtomicU64::new(REMOTE_ID_BASE),
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Starts `spec` in a new session in the daemon of `machine` (connecting first when no tab uses
    /// that machine yet) and attaches to it. `spec` is sent as given. `on_event` receives the output
    /// in order and then, once, the end of the session; `on_link` the state of the connection each
    /// time it changes (a session starts with the connection up). Both are called from a task of
    /// this module, never from the thread of the caller, and must not call back into this type.
    ///
    /// Fails, without starting anything, when the machine cannot be reached (the first connection
    /// is not repeated: a refused key or an unknown host says so at once), when the connection to it
    /// is down or reconnecting, or when the daemon refuses.
    pub fn spawn(
        &self,
        machine: &SshProfile,
        spec: SpawnSpec,
        on_event: Sink,
        on_link: LinkSink,
    ) -> Result<SessionId, SessionError> {
        let app = SessionId(self.inner.next_id.fetch_add(1, Ordering::SeqCst));
        let inner = Arc::clone(&self.inner);
        let machine = machine.clone();
        self.call(async move { start(inner, machine, spec, app, on_event, on_link).await })?
    }

    /// Sends bytes to the terminal input of a session.
    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<(), SessionError> {
        let held = self.held(id)?;
        let data = data.to_vec();
        let client = Arc::clone(&held.link.client);
        let remote = held.remote;
        self.call(async move { client.write(remote, &data).await })?
            .map_err(|e| failure(&held, e))
    }

    /// Changes the terminal size of a session.
    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), SessionError> {
        let held = self.held(id)?;
        let client = Arc::clone(&held.link.client);
        let remote = held.remote;
        self.call(async move { client.resize(remote, cols, rows).await })?
            .map_err(|e| failure(&held, e))
    }

    /// Ends the process of a session if it still runs and lets go of it. When the connection is
    /// down the shell is ended as soon as it is back, and this returns `Ok` (the page cannot do
    /// anything else with the tab).
    pub fn kill(&self, id: SessionId) -> Result<(), SessionError> {
        let held = lock(&self.inner.state)
            .sessions
            .remove(&id.0)
            .ok_or_else(|| SessionError::new(format!("unknown session {}", id.0)))?;
        let link = Arc::clone(&held.link);
        let remote = held.remote;
        let ended = self.call_within(
            async move { end_session(&link, remote).await },
            Duration::from_secs(15),
        );
        match ended {
            Ok(Ok(())) => {
                self.inner.release(&held.machine);
                Ok(())
            }
            Ok(Err(ClientError::Server(body))) if body.code == ErrorCode::UnknownSession => {
                self.inner.release(&held.machine);
                Ok(())
            }
            Ok(Err(ClientError::Closed)) => {
                // The connection is down: the shell is ended when it is back. The link stays until
                // then (the session still counts as a user of it).
                let inner = Arc::clone(&self.inner);
                if let Ok(handle) = self.handle() {
                    handle.spawn(end_when_back(inner, held));
                }
                Ok(())
            }
            Ok(Err(other)) => {
                let error = failure(&held, other);
                self.inner.release(&held.machine);
                Err(error)
            }
            Err(error) => {
                self.inner.release(&held.machine);
                Err(error)
            }
        }
    }

    /// Asks the connection of the session to try again now: it stops waiting between two attempts,
    /// or, after it gave up, starts the attempts over. Nothing happens when it is up.
    pub fn retry(&self, id: SessionId) -> Result<(), SessionError> {
        let held = self.held(id)?;
        held.link.client.retry_now();
        Ok(())
    }

    /// The state of the connection of a session, `None` for an id this module does not hold.
    #[cfg(test)]
    pub fn link_state(&self, id: SessionId) -> Option<LinkState> {
        let held = self.held(id).ok()?;
        Some(held.link.client.state())
    }

    /// The process id of the `ssh` that carries the connection of a session.
    #[cfg(test)]
    pub fn transport_id(&self, id: SessionId) -> Option<u32> {
        self.held(id).ok()?.link.client.transport_id()
    }

    /// The sessions the daemon on `machine` holds, as it lists them (for a test to check what is
    /// really there). Empty when no connection to that machine is open.
    #[cfg(test)]
    pub fn sessions_of(&self, machine: &SshProfile) -> Vec<noren_core::daemon::SessionInfo> {
        let link = lock(&self.inner.state)
            .links
            .get(machine)
            .map(|entry| Arc::clone(&entry.link));
        let Some(link) = link else {
            return Vec::new();
        };
        self.call(async move { link.client.list().await })
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default()
    }

    /// Sessions held, an ended one counting until it is killed.
    pub fn session_count(&self) -> usize {
        lock(&self.inner.state).sessions.len()
    }

    /// The connections that are open (one per machine in use).
    #[cfg(test)]
    pub fn link_count(&self) -> usize {
        lock(&self.inner.state).links.len()
    }

    /// Ends every session (up to `limit` for all of them) and lets go of every connection, so
    /// nothing of the app is left on the other machines or in `ssh` processes. A session whose
    /// connection is down at that moment cannot be ended, and goes on there.
    pub fn end_all(&self, limit: Duration) {
        let held: Vec<Held> = lock(&self.inner.state)
            .sessions
            .drain()
            .map(|(_, held)| held)
            .collect();
        if !held.is_empty() && self.inner.runtime.get().is_some() {
            let kills = async move {
                let mut ended = JoinSet::new();
                for session in held {
                    ended.spawn(async move {
                        let client = Arc::clone(&session.link.client);
                        // Drop the clone of the link only after the call: the connection must
                        // live until the daemon there has answered.
                        let outcome = client.kill(session.remote).await;
                        drop(session);
                        outcome
                    });
                }
                while ended.join_next().await.is_some() {}
            };
            if self.call_within(kills, limit).is_err() {
                eprintln!("warning: not every remote session could be ended in time");
            }
        }
        let links = std::mem::take(&mut lock(&self.inner.state).links);
        drop(links);
    }

    fn held(&self, id: SessionId) -> Result<Held, SessionError> {
        let state = lock(&self.inner.state);
        let held = state
            .sessions
            .get(&id.0)
            .ok_or_else(|| SessionError::new(format!("unknown session {}", id.0)))?;
        Ok(Held {
            machine: held.machine.clone(),
            link: Arc::clone(&held.link),
            remote: held.remote,
        })
    }

    fn handle(&self) -> Result<Handle, SessionError> {
        if let Some(runtime) = self.inner.runtime.get() {
            return Ok(runtime.handle().clone());
        }
        let built = Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("noren-remote-link")
            .enable_all()
            .build()
            .map_err(|e| {
                SessionError::new(format!(
                    "could not start the runtime of the remote link: {e}"
                ))
            })?;
        // Another thread may have been first; then this one is dropped, unused.
        let _ = self.inner.runtime.set(built);
        self.inner
            .runtime
            .get()
            .map(|runtime| runtime.handle().clone())
            .ok_or_else(|| SessionError::new("the runtime of the remote link is not there"))
    }

    /// Runs `future` on the runtime of this module and waits for it. Plain threads wait here,
    /// whatever thread they are: a tokio runtime refuses to block inside another.
    fn call<T: Send + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
    ) -> Result<T, SessionError> {
        let handle = self.handle()?;
        let (tx, rx) = std_mpsc::channel();
        handle.spawn(async move {
            let _ = tx.send(future.await);
        });
        rx.recv()
            .map_err(|_| SessionError::new("the link to the remote machine stopped"))
    }

    fn call_within<T: Send + 'static>(
        &self,
        future: impl Future<Output = T> + Send + 'static,
        limit: Duration,
    ) -> Result<T, SessionError> {
        let handle = self.handle()?;
        let (tx, rx) = std_mpsc::channel();
        handle.spawn(async move {
            let _ = tx.send(future.await);
        });
        rx.recv_timeout(limit).map_err(|_| {
            SessionError::new(format!(
                "the remote machine did not answer within {} s",
                limit.as_secs()
            ))
        })
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // A runtime cannot be dropped from inside another one, but it can be let go of.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

impl Inner {
    /// One user of the connection to `machine` is gone; the connection goes with the last one.
    fn release(&self, machine: &SshProfile) {
        let ended = {
            let mut state = lock(&self.state);
            let Some(entry) = state.links.get_mut(machine) else {
                return;
            };
            entry.users = entry.users.saturating_sub(1);
            if entry.users == 0 {
                state.links.remove(machine)
            } else {
                None
            }
        };
        // Dropped out of the lock: ending the connection is not something to do while holding it.
        drop(ended);
    }
}

/// Why a call on a held session failed, in a sentence that names the machine.
fn failure(held: &Held, error: ClientError) -> SessionError {
    match error {
        ClientError::Closed => SessionError::new(format!(
            "the connection to {} is down ({})",
            held.machine.host,
            held.link.client.state()
        )),
        other => SessionError::from(other),
    }
}

/// Finds or makes the connection to `machine` and counts the caller as one of its users.
async fn acquire(inner: &Arc<Inner>, machine: &SshProfile) -> Result<Arc<Link>, SessionError> {
    {
        let mut state = lock(&inner.state);
        if let Some(entry) = state.links.get_mut(machine) {
            entry.users += 1;
            return Ok(Arc::clone(&entry.link));
        }
    }
    let turn = Arc::clone(
        lock(&inner.state)
            .connecting
            .entry(machine.clone())
            .or_default(),
    );
    let _one_at_a_time = turn.lock().await;
    {
        // The tab that held the turn before this one may have made the connection.
        let mut state = lock(&inner.state);
        if let Some(entry) = state.links.get_mut(machine) {
            entry.users += 1;
            return Ok(Arc::clone(&entry.link));
        }
    }
    let connector = (inner.connector_for)(machine)?;
    let (client, events) = ReconnectingClient::connect(Boxed(connector), inner.policy)
        .await
        .map_err(|failure| {
            SessionError::new(format!("could not reach {}: {}", machine.host, failure))
        })?;
    let client = Arc::new(client);
    let (commands, receiver) = mpsc::unbounded_channel();
    let pump = tokio::spawn(pump(
        Arc::clone(&client),
        events,
        receiver,
        machine.host.clone(),
    ));
    let link = Arc::new(Link {
        client,
        commands,
        pump,
    });
    lock(&inner.state).links.insert(
        machine.clone(),
        LinkEntry {
            link: Arc::clone(&link),
            users: 1,
        },
    );
    Ok(link)
}

/// The whole of [`RemoteSessions::spawn`], on the runtime.
async fn start(
    inner: Arc<Inner>,
    machine: SshProfile,
    spec: SpawnSpec,
    app: SessionId,
    sink: Sink,
    status: LinkSink,
) -> Result<SessionId, SessionError> {
    let link = acquire(&inner, &machine).await?;
    // From here every way out must release the link.
    let (ready_tx, ready_rx) = oneshot::channel();
    let attempt = async {
        let state = link.client.state();
        if !matches!(state, LinkState::Connected) {
            return Err(SessionError::new(format!(
                "the connection to {} is not up ({state}); use the retry of a tab that is open on it, or try again in a moment",
                machine.host
            )));
        }
        let created = link.client.create(&spec).await?;
        let (done, attached) = oneshot::channel();
        let sent = link.commands.send(Command::Add {
            remote: created.session,
            app,
            sink,
            status,
            done,
            ready: ready_rx,
        });
        let attached = match sent {
            Ok(()) => attached.await.unwrap_or(Err(ClientError::Closed)),
            Err(_) => Err(ClientError::Closed),
        };
        if let Err(error) = attached {
            // A session nobody can hear is of no use; do not leave it behind.
            let _ = link.client.kill(created.session).await;
            return Err(SessionError::from(error));
        }
        Ok(created.session)
    };
    match attempt.await {
        Ok(remote) => {
            lock(&inner.state).sessions.insert(
                app.0,
                Held {
                    machine,
                    link,
                    remote,
                },
            );
            // Whoever waits for the first output of the session may go on now.
            let _ = ready_tx.send(());
            Ok(app)
        }
        Err(error) => {
            drop(link);
            inner.release(&machine);
            Err(error)
        }
    }
}

/// Ends the session in the daemon and, once it is gone, makes sure its end was reported.
async fn end_session(link: &Link, remote: SessionId) -> Result<(), ClientError> {
    let result = link.client.kill(remote).await;
    let gone = match &result {
        Ok(()) => true,
        Err(ClientError::Server(body)) => body.code == ErrorCode::UnknownSession,
        Err(_) => false,
    };
    if gone {
        let (done, reported) = oneshot::channel();
        if link.commands.send(Command::Ended { remote, done }).is_ok() {
            let _ = reported.await;
        }
    }
    result
}

/// Ends a shell whose connection was down when the page let go of it, once the connection is back.
/// Gives up when the connection does (it failed for good, or the client is gone).
async fn end_when_back(inner: Arc<Inner>, held: Held) {
    let mut state = held.link.client.subscribe();
    loop {
        match end_session(&held.link, held.remote).await {
            Ok(()) => break,
            Err(ClientError::Closed) => {
                if matches!(*state.borrow(), LinkState::Failed { .. }) {
                    eprintln!(
                        "warning: the shell of a closed tab on {} was left running: the connection failed",
                        held.machine.host
                    );
                    break;
                }
                // Wait for the state to change, then try again.
                if state.changed().await.is_err() {
                    break;
                }
            }
            // The daemon no longer has it, or refuses: nothing more to do.
            Err(_) => break,
        }
    }
    inner.release(&held.machine);
}

// ---------------------------------------------------------------------------------------------
// The task of a link: what the connection reports, as callbacks
// ---------------------------------------------------------------------------------------------

/// A session of the link: where its output and its connection state go, and what it already
/// handed over.
struct Cell {
    app: SessionId,
    sink: Sink,
    status: LinkSink,
    delivered: DeliveredTail,
    host: String,
}

impl Cell {
    /// Hands over output of the session and remembers it as shown.
    fn output(&mut self, data: &[u8]) -> bool {
        if data.is_empty() {
            return true;
        }
        self.delivered.push(data);
        guarded(|| (self.sink)(SessionEvent::Output(data)))
    }

    /// Hands over a line of the app's own, which is not part of the session's output and so is not
    /// counted as shown.
    fn notice(&mut self, text: &str) {
        let line = format!("\r\n\x1b[31m{text}\x1b[0m\r\n");
        guarded(|| (self.sink)(SessionEvent::Output(line.as_bytes())));
    }

    fn exit(&mut self, info: ExitInfo) {
        guarded(|| (self.sink)(SessionEvent::Exit(info)));
    }

    fn state(&mut self, state: &LinkState) {
        let app = self.app;
        guarded(|| (self.status)(app, state));
    }

    /// The session was attached again after the connection came back: shows what is new in the
    /// replay.
    fn reattached(&mut self, replay: &[u8]) {
        match plan_replay(self.delivered.as_slice(), replay) {
            ReplayPlan::Continue(new) => {
                self.output(new);
            }
            ReplayPlan::Replace(all) => {
                // One piece, so the terminal never shows the state between the reset and the replay.
                let mut whole = Vec::with_capacity(RESET_TERMINAL.len() + all.len());
                whole.extend_from_slice(RESET_TERMINAL);
                whole.extend_from_slice(all);
                self.delivered.clear();
                self.delivered.push(all);
                guarded(|| (self.sink)(SessionEvent::Output(&whole)));
            }
        }
    }
}

/// The one task that talks to the callbacks of a link. It does every attach too, so the replay a
/// session answers with reaches its sink before any output that follows (the events of the
/// connection wait in their queue while the attach is being answered).
async fn pump(
    client: Arc<ReconnectingClient>,
    mut events: LinkEvents,
    mut commands: mpsc::UnboundedReceiver<Command>,
    host: String,
) {
    let mut cells: HashMap<SessionId, Cell> = HashMap::new();
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Add { remote, app, sink, status, done, ready }) => {
                    match client.attach(remote).await {
                        Ok(attached) => {
                            // The caller is released first: it holds locks the callbacks may need
                            // (the exit callback of a session waits for the id it is about to
                            // return). The events behind this one wait in their queue.
                            let _ = done.send(Ok(()));
                            let _ = ready.await;
                            let mut cell = Cell {
                                app,
                                sink,
                                status,
                                delivered: DeliveredTail::new(),
                                host: host.clone(),
                            };
                            cell.output(&attached.replay);
                            match attached.exit {
                                Some(info) => cell.exit(info),
                                None => {
                                    cells.insert(remote, cell);
                                }
                            }
                        }
                        Err(error) => {
                            let _ = done.send(Err(error));
                        }
                    }
                }
                Some(Command::Ended { remote, done }) => {
                    if let Some(mut cell) = cells.remove(&remote) {
                        cell.exit(ExitInfo {
                            code: 137,
                            signal: Some("SIGKILL".to_owned()),
                        });
                    }
                    let _ = done.send(());
                }
                // The link was let go of.
                None => break,
            },
            event = events.recv() => match event {
                Some(LinkEvent::Output { session, data }) => {
                    if let Some(cell) = cells.get_mut(&session)
                        && !cell.output(&data)
                    {
                        cells.remove(&session);
                    }
                }
                Some(LinkEvent::Exit { session, info }) => {
                    if let Some(mut cell) = cells.remove(&session) {
                        cell.exit(info);
                    }
                }
                Some(LinkEvent::State(state)) => {
                    for cell in cells.values_mut() {
                        cell.state(&state);
                    }
                }
                Some(LinkEvent::Reattached { session, replay, exit }) => {
                    if let Some(cell) = cells.get_mut(&session) {
                        cell.reattached(&replay);
                        if let Some(info) = exit
                            && let Some(mut cell) = cells.remove(&session)
                        {
                            cell.exit(info);
                        }
                    }
                }
                Some(LinkEvent::SessionLost { session }) => {
                    if let Some(mut cell) = cells.remove(&session) {
                        let text = format!(
                            "The shell on {} is gone: its daemon no longer has the session.",
                            cell.host
                        );
                        cell.notice(&text);
                        cell.exit(ExitInfo { code: 1, signal: None });
                    }
                }
                None => break,
            },
        }
    }
    // Whatever was still running here is no longer heard: say so, once each.
    for (_, mut cell) in cells {
        cell.exit(ExitInfo {
            code: 1,
            signal: None,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_fake::{FakeDaemon, Recorder, fast, wait_for};
    use std::time::Instant;

    /// A machine the tests reach; two profiles that differ in anything are two machines.
    fn machine(user: &str) -> SshProfile {
        SshProfile {
            host: "build.example.org".to_owned(),
            user: Some(user.to_owned()),
            port: Some(2222),
            identity_file: Some("/keys/id".to_owned()),
            known_hosts_file: None,
        }
    }

    /// Sessions that reach every machine through the fake daemon.
    fn sessions(daemon: &FakeDaemon, attempts: u32) -> RemoteSessions {
        let daemon = daemon.clone();
        RemoteSessions::new(
            Arc::new(move |_| Ok(Box::new(daemon.connector()) as Box<dyn Connector>)),
            fast(attempts),
        )
    }

    /// What a profile of kind `ssh` sends: a program and what the profile says, no environment.
    fn spec() -> SpawnSpec {
        SpawnSpec {
            program: "bash".to_owned(),
            args: vec!["-l".to_owned()],
            cwd: None,
            env: Vec::new(),
            cols: 100,
            rows: 30,
        }
    }

    fn start(
        remote: &RemoteSessions,
        who: &SshProfile,
        log: &Recorder,
    ) -> Result<SessionId, SessionError> {
        remote.spawn(who, spec(), log.sink(), log.link_sink())
    }

    /// The id the daemon gave the one session of a test.
    fn only_session(daemon: &FakeDaemon) -> u64 {
        let ids = daemon.session_ids();
        assert_eq!(ids.len(), 1, "one session in the daemon: {ids:?}");
        ids[0]
    }

    fn is_connected(log: &Recorder) -> bool {
        matches!(log.links().last(), Some(LinkState::Connected))
    }

    #[test]
    fn the_ids_of_a_remote_session_never_meet_a_local_one() {
        assert!(!is_remote(SessionId(1)));
        assert!(!is_remote(SessionId(REMOTE_ID_BASE - 1)));
        assert!(is_remote(SessionId(REMOTE_ID_BASE)));

        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        assert!(is_remote(id));
        assert_eq!(remote.session_count(), 1);
        // The daemon numbered it from 1; the page sees another number.
        assert_eq!(only_session(&daemon), 1);
        assert_ne!(id.0, 1);
    }

    #[test]
    fn a_remote_session_is_created_with_the_spec_it_was_given_and_nothing_of_this_machine() {
        // The daemon on the other machine gets the program, the arguments and the
        // size, and no environment and no folder, whatever this process has.
        assert!(
            std::env::vars_os().count() > 0 && std::env::current_dir().is_ok(),
            "this process has an environment and a folder, which must stay here"
        );
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        start(&remote, &machine("me"), &log).expect("start");

        let created = daemon.creates();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].program, "bash");
        assert_eq!(created[0].args, ["-l"]);
        assert!(
            created[0].env.is_empty(),
            "no environment: {:?}",
            created[0].env
        );
        assert_eq!(
            created[0].cwd, None,
            "no folder: the home of the user there"
        );
        assert_eq!((created[0].cols, created[0].rows), (100, 30));
    }

    #[test]
    fn output_comes_in_order_and_what_is_typed_and_the_size_reach_the_shell() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);

        daemon.print(session, b"one\r\n");
        daemon.print(session, b"two\r\n");
        daemon.print(session, b"three\r\n");
        wait_for("the output", || log.text() == "one\r\ntwo\r\nthree\r\n");

        remote.write(id, b"ls\r").expect("write");
        remote.resize(id, 132, 43).expect("resize");
        assert_eq!(daemon.written_text(session), "ls\r");
        assert_eq!(daemon.resizes(), vec![(session, 132, 43)]);
        assert_eq!(remote.link_state(id), Some(LinkState::Connected));
    }

    #[test]
    fn the_shell_that_ends_is_reported_once_with_its_code() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        daemon.print(session, b"bye\r\n");
        daemon.end(session, 3);
        wait_for("the exit", || !log.exits().is_empty());
        assert_eq!(
            log.exits(),
            vec![ExitInfo {
                code: 3,
                signal: None
            }]
        );
        assert_eq!(log.text(), "bye\r\n");
        // It stays held until it is killed, as a session of the local daemon does.
        assert_eq!(remote.session_count(), 1);
        remote.kill(id).expect("release it");
        assert_eq!(remote.session_count(), 0);
        assert_eq!(log.exits().len(), 1);
    }

    #[test]
    fn a_session_that_ends_at_once_does_not_leave_the_caller_waiting_for_its_own_callback() {
        // The page's callback for the end of a session waits for the id this call is about to
        // return (it holds a lock until then); a callback run before the call returned would wait
        // for a caller that waits for it.
        let daemon = FakeDaemon::new();
        daemon.exit_at_once(Some(127));
        let remote = Arc::new(sessions(&daemon, 5));
        let gate = Arc::new(Mutex::new(()));
        let log = Recorder::default();
        let held = lock(&gate);
        let waiting = Arc::clone(&gate);
        let recorded = log.sink();
        let (done_tx, done_rx) = std_mpsc::channel();
        let who = machine("me");
        let again = Arc::clone(&remote);
        let link_sink = log.link_sink();
        std::thread::spawn(move || {
            let mut recorded = recorded;
            let sink: Sink = Box::new(move |event| {
                if matches!(event, SessionEvent::Exit(_)) {
                    let _after_the_caller = lock(&waiting);
                }
                recorded(event);
            });
            let _ = done_tx.send(again.spawn(&who, spec(), sink, link_sink));
        });
        let started = done_rx.recv_timeout(Duration::from_secs(20));
        assert!(
            started.is_ok(),
            "the call returned while the callback waited"
        );
        drop(held);
        wait_for("the exit", || !log.exits().is_empty());
        assert_eq!(
            log.exits(),
            vec![ExitInfo {
                code: 127,
                signal: None
            }]
        );
    }

    // ----- the connection that drops and comes back -----

    #[test]
    fn a_dropped_connection_comes_back_and_the_same_session_goes_on() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        daemon.print(session, b"before\r\n");
        wait_for("the first output", || log.text() == "before\r\n");

        daemon.cut_all();
        wait_for("the connection to be back", || {
            is_connected(&log) && log.links().len() >= 2
        });

        // The states the page was told, in order, each for the session it asked for.
        let links = log.links();
        assert!(
            matches!(
                links.first(),
                Some(LinkState::Reconnecting { attempt: 1, .. })
            ),
            "{links:?}"
        );
        assert_eq!(links.last(), Some(&LinkState::Connected));
        assert!(log.link_ids().iter().all(|seen| *seen == id));
        // The same session answers: same id in the daemon, same process, no new session.
        assert_eq!(daemon.session_ids(), vec![session]);
        assert_eq!(daemon.creates().len(), 1);
        assert_eq!(daemon.handshakes(), 2, "one connection, then one more");
        daemon.print(session, b"after\r\n");
        wait_for("the output after", || log.text().ends_with("after\r\n"));
        remote
            .write(id, b"echo hi\r")
            .expect("write after the reconnection");
        assert_eq!(daemon.written_text(session), "echo hi\r");
    }

    #[test]
    fn what_was_shown_before_the_break_is_not_shown_again_and_what_came_meanwhile_is() {
        // The daemon answers the new attach with everything it kept, which includes
        // what the tab already shows: only what follows it may reach the terminal.
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);

        // A screenful the tab shows, in many pieces (a tail longer than a short prompt).
        let mut shown = String::new();
        for line in 0..400 {
            let text = format!("line {line:04}\r\n");
            daemon.print(session, text.as_bytes());
            shown.push_str(&text);
        }
        wait_for("the first output", || log.text() == shown);

        // The connection goes down, and the program prints while it is.
        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());
        let meanwhile = "printed while the connection was down\r\n";
        daemon.print(session, meanwhile.as_bytes());
        daemon.set_down(false);
        wait_for("the connection to be back", || is_connected(&log));

        // The tab got the new line once and nothing else.
        wait_for("the new line", || log.text().ends_with(meanwhile));
        assert_eq!(log.text(), format!("{shown}{meanwhile}"));
        assert_eq!(log.resets(), 0, "the terminal was not reset");
        // And output after that goes on from there.
        daemon.print(session, b"and now\r\n");
        wait_for("output after", || log.text().ends_with("and now\r\n"));
        assert_eq!(log.text(), format!("{shown}{meanwhile}and now\r\n"));
    }

    #[test]
    fn a_short_session_is_continued_too() {
        // Nothing but a prompt shown: the tail is all the session ever printed.
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        daemon.print(session, b"user@box:~$ ");
        wait_for("the prompt", || log.text() == "user@box:~$ ");

        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());
        daemon.print(session, b"ls\r\nfile\r\nuser@box:~$ ");
        daemon.set_down(false);
        wait_for("the connection to be back", || is_connected(&log));
        wait_for("the rest", || log.text().ends_with("user@box:~$ "));
        assert_eq!(log.text(), "user@box:~$ ls\r\nfile\r\nuser@box:~$ ");
        assert_eq!(log.resets(), 0);
    }

    #[test]
    fn when_more_was_printed_than_the_daemon_keeps_the_terminal_is_reset_and_shows_the_replay() {
        // The daemon keeps 2000 bytes; the connection is down while 9000 are printed: the replay
        // does not reach back to what the tab showed, so the screen is replaced.
        let daemon = FakeDaemon::new();
        daemon.set_ring_bytes(2000);
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        let mut shown = String::new();
        for line in 0..100 {
            let text = format!("old {line:04}\r\n");
            daemon.print(session, text.as_bytes());
            shown.push_str(&text);
        }
        wait_for("the first output", || log.text() == shown);

        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());
        let mut kept = Vec::new();
        for line in 0..600 {
            let text = format!("new {line:04}\r\n");
            daemon.print(session, text.as_bytes());
            kept.extend_from_slice(text.as_bytes());
        }
        // What the daemon holds now: the last 2000 bytes of what was printed.
        let ring = kept[kept.len() - 2000..].to_vec();
        daemon.set_down(false);
        wait_for("the connection to be back", || is_connected(&log));
        wait_for("the replacement", || log.resets() == 1);
        wait_for("the whole replay", || log.since_last_reset() == ring);
        assert_eq!(log.resets(), 1);
        // The reset and the replay arrived as one piece: the terminal never shows the gap.
        let bytes = log.bytes();
        let at = bytes.len() - 2000 - 2;
        assert_eq!(&bytes[at..at + 2], b"\x1bc");
    }

    #[test]
    fn a_connection_that_breaks_twice_is_made_again_twice_without_repeating_anything() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        let mut shown = String::new();
        for round in 0..2 {
            let text = format!("round {round}\r\n");
            daemon.print(session, text.as_bytes());
            shown.push_str(&text);
            wait_for("the output", || log.text() == shown);
            let seen = log.links().len();
            daemon.cut_all();
            wait_for("the connection to be back", || {
                log.links().len() > seen && is_connected(&log)
            });
        }
        daemon.print(session, b"last\r\n");
        wait_for("the last output", || log.text().ends_with("last\r\n"));
        assert_eq!(log.text(), format!("{shown}last\r\n"));
        assert_eq!(daemon.handshakes(), 3);
        assert!(remote.write(id, b"x").is_ok());
    }

    #[test]
    fn calls_while_the_connection_is_down_fail_at_once_and_name_the_machine() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());

        let before = Instant::now();
        let written = remote.write(id, b"lost").expect_err("down");
        assert!(
            written.to_string().contains("build.example.org"),
            "{written}"
        );
        assert!(written.to_string().contains("down"), "{written}");
        assert!(remote.resize(id, 90, 30).is_err());
        assert!(before.elapsed() < Duration::from_secs(2), "it did not wait");
        // The typed text is not kept.
        assert_eq!(daemon.written_text(only_session(&daemon)), "");
        assert!(matches!(
            remote.link_state(id),
            Some(LinkState::Reconnecting { .. })
        ));
    }

    #[test]
    fn a_failure_that_trying_again_cannot_fix_is_told_and_retry_starts_over() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        daemon.print(session, b"shown\r\n");
        wait_for("the output", || log.text() == "shown\r\n");

        // The key is refused after the break: no attempt can help.
        daemon.refuse(Some("Permission denied (publickey)"));
        daemon.cut_all();
        wait_for("the failure", || {
            matches!(log.links().last(), Some(LinkState::Failed { .. }))
        });
        let Some(LinkState::Failed { reason }) = log.links().last().cloned() else {
            unreachable!()
        };
        assert!(reason.contains("Permission denied"), "{reason}");
        let attempts = daemon.attempts();

        // Nothing happens by itself...
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(daemon.attempts(), attempts);
        assert!(remote.write(id, b"x").is_err());

        // ...until the person asks: the key is fine now and the same session answers.
        daemon.refuse(None);
        daemon.print(session, b"meanwhile\r\n");
        remote.retry(id).expect("retry");
        wait_for("the connection to be back", || is_connected(&log));
        wait_for("the output", || log.text() == "shown\r\nmeanwhile\r\n");
        assert_eq!(daemon.creates().len(), 1);
        remote.write(id, b"ok\r").expect("write again");
        assert_eq!(daemon.written_text(session), "ok\r");
    }

    #[test]
    fn retrying_a_connection_that_is_up_does_nothing_and_an_unknown_session_is_an_error() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        remote.retry(id).expect("nothing to do");
        std::thread::sleep(Duration::from_millis(100));
        assert!(log.links().is_empty());
        assert_eq!(daemon.handshakes(), 1);
        assert!(remote.retry(SessionId(REMOTE_ID_BASE + 999)).is_err());
        assert!(remote.write(SessionId(REMOTE_ID_BASE + 999), b"x").is_err());
    }

    #[test]
    fn the_attempts_running_out_are_a_failure_the_page_is_told() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 3);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the failure", || {
            matches!(log.links().last(), Some(LinkState::Failed { .. }))
        });
        let links = log.links();
        let mut attempts: Vec<u32> = links
            .iter()
            .filter_map(|state| match state {
                LinkState::Reconnecting { attempt, .. } => Some(*attempt),
                _ => None,
            })
            .collect();
        attempts.dedup();
        assert_eq!(attempts, vec![1, 2, 3], "{links:?}");
    }

    // ----- a session the daemon no longer has, or that ended meanwhile -----

    #[test]
    fn a_shell_that_ended_while_the_connection_was_down_is_reported_once_after_its_last_output() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        daemon.print(session, b"working\r\n");
        wait_for("the output", || log.text() == "working\r\n");

        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());
        daemon.print(session, b"done\r\n");
        daemon.end(session, 5);
        daemon.set_down(false);
        wait_for("the exit", || !log.exits().is_empty());
        assert_eq!(log.text(), "working\r\ndone\r\n");
        assert_eq!(
            log.exits(),
            vec![ExitInfo {
                code: 5,
                signal: None
            }]
        );
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(log.exits().len(), 1, "once");
    }

    #[test]
    fn a_session_the_daemon_forgot_ends_with_a_word_about_it() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        daemon.print(session, b"alive\r\n");
        wait_for("the output", || log.text() == "alive\r\n");

        // The machine restarted: its daemon has no session any more.
        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());
        daemon.forget(session);
        daemon.set_down(false);
        wait_for("the exit", || !log.exits().is_empty());
        assert_eq!(
            log.exits(),
            vec![ExitInfo {
                code: 1,
                signal: None
            }]
        );
        assert!(log.text().starts_with("alive\r\n"));
        assert!(
            log.text().contains("build.example.org is gone"),
            "{}",
            log.text()
        );
    }

    // ----- ending sessions, and sharing a connection -----

    #[test]
    fn killing_a_session_ends_it_in_the_daemon_and_forgets_it_and_the_last_one_closes_the_connection()
     {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);
        assert_eq!(daemon.connections(), 1);
        assert_eq!(remote.link_count(), 1);

        remote.kill(id).expect("kill");
        assert_eq!(daemon.kills(), vec![session]);
        assert_eq!(remote.session_count(), 0);
        wait_for("the exit of the killed shell", || !log.exits().is_empty());
        // Nobody uses the connection any more: it is let go of.
        assert_eq!(remote.link_count(), 0);
        wait_for("the connection to close", || daemon.connections() == 0);
        assert!(remote.kill(id).is_err(), "a second kill finds nothing");
        assert!(remote.write(id, b"x").is_err());
    }

    #[test]
    fn two_tabs_of_a_machine_share_one_connection_and_a_third_machine_has_its_own() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let (one, two, other) = (
            Recorder::default(),
            Recorder::default(),
            Recorder::default(),
        );
        let a = start(&remote, &machine("me"), &one).expect("first");
        let b = start(&remote, &machine("me"), &two).expect("second");
        assert_ne!(a, b);
        assert_eq!(daemon.handshakes(), 1, "one connection for both tabs");
        assert_eq!(remote.link_count(), 1);

        let c = start(&remote, &machine("someone-else"), &other).expect("another login");
        assert_eq!(daemon.handshakes(), 2);
        assert_eq!(remote.link_count(), 2);

        // A break reaches the tabs that use the connection, each told for itself.
        daemon.cut_all();
        wait_for("both tabs to be told", || {
            is_connected(&one) && is_connected(&two) && is_connected(&other)
        });
        assert!(one.link_ids().iter().all(|id| *id == a));
        assert!(two.link_ids().iter().all(|id| *id == b));
        assert!(other.link_ids().iter().all(|id| *id == c));

        // One tab closing leaves the connection to the other; the last one closes it.
        remote.kill(a).expect("kill a");
        assert_eq!(remote.link_count(), 2);
        remote.kill(b).expect("kill b");
        assert_eq!(remote.link_count(), 1);
        remote.kill(c).expect("kill c");
        assert_eq!(remote.link_count(), 0);
    }

    #[test]
    fn tabs_opened_together_on_one_machine_wait_for_one_connection_instead_of_each_making_its_own()
    {
        // A workspace being restored opens its tabs at once; each used to log in by itself.
        let daemon = FakeDaemon::new();
        daemon.set_connect_delay(Duration::from_millis(300));
        let remote = Arc::new(sessions(&daemon, 5));
        let (done_tx, done_rx) = std_mpsc::channel();
        for _ in 0..4 {
            let remote = Arc::clone(&remote);
            let done = done_tx.clone();
            std::thread::spawn(move || {
                let log = Recorder::default();
                let _ = done.send(start(&remote, &machine("me"), &log));
            });
        }
        let ids: Vec<SessionId> = (0..4)
            .map(|_| {
                done_rx
                    .recv_timeout(Duration::from_secs(30))
                    .expect("a tab opens")
                    .expect("started")
            })
            .collect();
        assert_eq!(ids.len(), 4);
        assert_eq!(daemon.attempts(), 1, "one login for the four tabs");
        assert_eq!(daemon.handshakes(), 1);
        assert_eq!(remote.link_count(), 1);
        assert_eq!(remote.session_count(), 4);
        assert_eq!(daemon.session_ids().len(), 4);
        for id in ids {
            remote.kill(id).expect("kill");
        }
        assert_eq!(remote.link_count(), 0);
    }

    #[test]
    fn closing_a_tab_while_the_connection_is_down_ends_its_shell_when_it_is_back() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let id = start(&remote, &machine("me"), &log).expect("start");
        let session = only_session(&daemon);

        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());
        remote.kill(id).expect("the page's call goes through");
        assert_eq!(remote.session_count(), 0, "the page let go of it");
        assert_eq!(
            daemon.kills(),
            Vec::<u64>::new(),
            "nothing could reach it yet"
        );
        assert_eq!(
            remote.link_count(),
            1,
            "the connection stays until it is done"
        );

        daemon.set_down(false);
        wait_for("the shell to be ended", || daemon.kills() == vec![session]);
        wait_for("the connection to be let go of", || {
            remote.link_count() == 0
        });
    }

    #[test]
    fn ending_everything_kills_every_session_and_closes_every_connection() {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 5);
        let (one, two) = (Recorder::default(), Recorder::default());
        start(&remote, &machine("me"), &one).expect("first");
        start(&remote, &machine("someone-else"), &two).expect("second");
        assert_eq!(daemon.session_ids().len(), 2);

        remote.end_all(Duration::from_secs(10));
        assert_eq!(daemon.session_ids(), Vec::<u64>::new());
        assert_eq!(remote.session_count(), 0);
        assert_eq!(remote.link_count(), 0);
        wait_for("the connections to close", || daemon.connections() == 0);
        // Nothing to end is not an error, and nothing starts a thread.
        let idle = sessions(&daemon, 5);
        idle.end_all(Duration::from_secs(1));
        assert!(idle.inner.runtime.get().is_none());
    }

    // ----- the first connection -----

    #[test]
    fn a_machine_that_cannot_be_reached_is_an_error_at_once_with_nothing_left_behind() {
        let daemon = FakeDaemon::new();
        daemon.refuse(Some("Permission denied (publickey)"));
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let error = start(&remote, &machine("me"), &log).expect_err("refused");
        assert!(error.to_string().contains("build.example.org"), "{error}");
        assert!(error.to_string().contains("Permission denied"), "{error}");
        assert_eq!(daemon.attempts(), 1, "the first connection is not repeated");
        assert_eq!(remote.link_count(), 0);
        assert_eq!(remote.session_count(), 0);
        assert!(daemon.creates().is_empty());
    }

    #[test]
    fn a_new_tab_on_a_machine_whose_connection_is_down_is_refused_with_the_state_and_leaves_no_trace()
     {
        let daemon = FakeDaemon::new();
        let remote = sessions(&daemon, 50);
        let log = Recorder::default();
        let _ = start(&remote, &machine("me"), &log).expect("start");
        daemon.set_down(true);
        daemon.cut_all();
        wait_for("the break", || !log.links().is_empty());

        let again = Recorder::default();
        let error = start(&remote, &machine("me"), &again).expect_err("down");
        assert!(error.to_string().contains("is not up"), "{error}");
        assert!(error.to_string().contains("reconnecting"), "{error}");
        assert_eq!(remote.session_count(), 1, "only the first tab");
        assert_eq!(daemon.creates().len(), 1);
        // And the first tab still has its connection: the failed attempt did not take it away.
        assert_eq!(remote.link_count(), 1);
        daemon.set_down(false);
        wait_for("the connection to be back", || is_connected(&log));
    }

    #[test]
    fn a_session_the_daemon_refuses_is_an_error_with_its_words_and_lets_the_connection_go() {
        let daemon = FakeDaemon::new();
        daemon.fail_creates(Some("could not start 'nope': No such file or directory"));
        let remote = sessions(&daemon, 5);
        let log = Recorder::default();
        let error = start(&remote, &machine("me"), &log).expect_err("refused");
        assert!(
            error.to_string().contains("No such file or directory"),
            "{error}"
        );
        assert_eq!(remote.session_count(), 0);
        assert_eq!(
            remote.link_count(),
            0,
            "the connection made for it is let go of"
        );
        wait_for("the connection to close", || daemon.connections() == 0);
        // And the machine is as good as before: the next tab works.
        daemon.fail_creates(None);
        start(&remote, &machine("me"), &log).expect("the next one");
        assert_eq!(remote.session_count(), 1);
    }
}

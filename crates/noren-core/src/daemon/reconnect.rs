//! A connection to a daemon that comes back.
//!
//! A [`DaemonClient`] lives as long as its connection. When the connection is a local pipe that
//! is the life of the daemon; when it is the pipes of an `ssh` process (see
//! [`SshTarget`](super::SshTarget)) it is also the life of a network path, which breaks far more
//! often, while the daemon and its sessions stay where they are. [`ReconnectingClient`] is the
//! client that treats a break as an interruption: it connects again, with a bounded backoff, and
//! attaches the sessions it was attached to by their ids, so the shells go on where they were.
//!
//! What the person of the client sees:
//!
//! - [`LinkState`]: `Connected`, `Reconnecting` (which attempt, in how long, why) and `Failed`
//!   (the attempts ran out, or the reason cannot be fixed by trying again: a refused key, a
//!   changed host key, no `norend` there). `Failed` waits for [`ReconnectingClient::retry_now`].
//! - [`LinkEvents`]: the output and exit events of the attached sessions, as on one connection,
//!   and between them what changed: the state, a session attached again with what the daemon
//!   kept of it ([`LinkEvent::Reattached`]), a session the daemon no longer has
//!   ([`LinkEvent::SessionLost`]).
//! - Calls made while the link is down fail at once with [`ClientError::Closed`]; none waits for
//!   the link to come back, and none is repeated by the client (a write that was in flight when
//!   the connection broke may or may not have reached the shell: that cannot be known).
//!
//! The backoff is [`BackoffPolicy`]: the wait before attempt `n` is `first_delay * 2^(n-1)`,
//! never more than `max_delay`, for at most `max_attempts` attempts. It has no randomness, so it
//! can be tested to the millisecond; the clients of one daemon are few.

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::client::{Attached, ClientError, ClientEvent, ClientEvents, Created, DaemonClient};
use super::lock;
use super::protocol::{ErrorCode, SessionInfo};
use crate::pty::{ExitInfo, SessionId, SpawnSpec};

/// What carries a connection: a process, a socket, a task. Dropping it ends the carrier.
pub trait Transport: Send {
    /// The process id of the carrier, when it is a process (the `ssh` of an
    /// [`SshLink`](super::SshLink)).
    fn id(&self) -> Option<u32> {
        None
    }

    /// Ends the carrier now, which breaks the connection (the daemon and its sessions stay).
    fn cut(&mut self);
}

/// A connection just made: the client, its events and what carries it.
pub struct Established {
    pub client: DaemonClient,
    pub events: ClientEvents,
    pub transport: Box<dyn Transport>,
}

/// Why one attempt to connect failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectFailure {
    /// A sentence for the person at the screen.
    pub message: String,
    /// Trying again cannot help (a refused key, a changed host key, a daemon of another
    /// version): the reconnection gives up at once instead of using its attempts.
    pub permanent: bool,
}

impl fmt::Display for ConnectFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl Error for ConnectFailure {}

/// Something that can make a connection to a daemon, as many times as asked.
pub trait Connector: Send + Sync + 'static {
    /// One attempt. It may take a while (a login on another machine), and it is dropped, with
    /// whatever it started, when the client is.
    fn connect(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Established, ConnectFailure>> + Send + '_>>;
}

/// How long to wait between attempts, and how many to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackoffPolicy {
    /// The wait before the first attempt after a break.
    pub first_delay: Duration,
    /// The wait never grows past this.
    pub max_delay: Duration,
    /// How many attempts in a row before the link is reported as failed. Zero means none: the
    /// first break is a failure.
    pub max_attempts: u32,
}

impl Default for BackoffPolicy {
    /// 0.5 s, 1 s, 2 s, 4 s, 8 s and then 10 s, twenty attempts: about three minutes in all.
    fn default() -> Self {
        Self {
            first_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(10),
            max_attempts: 20,
        }
    }
}

impl BackoffPolicy {
    /// The wait before attempt number `attempt` (counted from 1), or `None` when there is no such
    /// attempt (`attempt` is 0, or past `max_attempts`).
    pub fn delay(&self, attempt: u32) -> Option<Duration> {
        if attempt == 0 || attempt > self.max_attempts {
            return None;
        }
        // 2^(attempt - 1), kept from overflowing: past 31 doublings any first delay is above any
        // cap that fits a `Duration` worth waiting for, and `saturating_mul` does the rest.
        let doublings = (attempt - 1).min(31);
        let factor = 1u32 << doublings;
        Some(self.first_delay.saturating_mul(factor).min(self.max_delay))
    }

    /// The time all the waits add up to: how long the link tries before it says it failed (the
    /// attempts themselves, which take as long as a connection takes, come on top).
    pub fn total_delay(&self) -> Duration {
        (1..=self.max_attempts)
            .filter_map(|attempt| self.delay(attempt))
            .fold(Duration::ZERO, Duration::saturating_add)
    }
}

/// Where the link to the daemon stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    /// The daemon answers.
    Connected,
    /// The connection broke; the attempt number `attempt` (of `max_attempts`) starts in
    /// `retry_in`. `reason` says why the connection broke or why the last attempt failed.
    Reconnecting {
        attempt: u32,
        max_attempts: u32,
        retry_in: Duration,
        reason: String,
    },
    /// No more attempts: they ran out or the failure is permanent. Nothing happens until
    /// [`ReconnectingClient::retry_now`].
    Failed { reason: String },
}

impl fmt::Display for LinkState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connected => write!(f, "connected"),
            Self::Reconnecting {
                attempt,
                max_attempts,
                retry_in,
                reason,
            } => write!(
                f,
                "reconnecting (attempt {attempt} of {max_attempts} in {:.1}s): {reason}",
                retry_in.as_secs_f32()
            ),
            Self::Failed { reason } => write!(f, "failed: {reason}"),
        }
    }
}

/// Something that happened on the link, in the order it happened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkEvent {
    /// Output of an attached session.
    Output { session: SessionId, data: Vec<u8> },
    /// The process of an attached session ended. The last event of that session.
    Exit { session: SessionId, info: ExitInfo },
    /// The state of the link changed.
    State(LinkState),
    /// A session was attached again after the link came back. `replay` is everything the daemon
    /// kept of its output, which includes what this client had already received before the
    /// break: whoever shows the output should replace what it shows with the replay, not append
    /// to it. `exit` is set when the process ended meanwhile (no more events follow).
    Reattached {
        session: SessionId,
        replay: Vec<u8>,
        exit: Option<ExitInfo>,
    },
    /// The daemon has no session with this id any more (it was killed from somewhere else, or
    /// the machine and its daemon were restarted), so it was dropped from the ones to attach.
    SessionLost { session: SessionId },
}

/// The events of a [`ReconnectingClient`]. The queue is not bounded: keep taking from it.
pub struct LinkEvents {
    receiver: mpsc::UnboundedReceiver<LinkEvent>,
}

impl LinkEvents {
    /// The next event; `None` once the client is gone and the queue is empty.
    pub async fn recv(&mut self) -> Option<LinkEvent> {
        self.receiver.recv().await
    }

    /// An event that is already queued, without waiting.
    pub fn try_recv(&mut self) -> Option<LinkEvent> {
        self.receiver.try_recv().ok()
    }
}

/// The connection that is up now.
struct Live {
    client: Arc<DaemonClient>,
    transport_id: Option<u32>,
}

struct Shared {
    current: Mutex<Option<Live>>,
    /// The sessions to attach again after a break.
    tracked: Mutex<BTreeSet<SessionId>>,
    state: watch::Sender<LinkState>,
}

enum Command {
    /// Break the connection now.
    Cut,
    /// Do not wait: try now, or start over after a failure.
    RetryNow,
}

/// What the supervisor holds of the connection that is up.
struct Connection {
    events: ClientEvents,
    transport: Box<dyn Transport>,
}

/// A client of a daemon whose connection may break and come back. See the
/// [module](self) for what a person of it sees.
///
/// Dropping the client ends the link and the carrier of the connection (the `ssh` process), not
/// the sessions in the daemon.
pub struct ReconnectingClient {
    shared: Arc<Shared>,
    commands: mpsc::UnboundedSender<Command>,
    supervisor: JoinHandle<()>,
}

impl ReconnectingClient {
    /// Makes the first connection and, if it works, keeps it up. The first attempt is not
    /// repeated: a failure is returned as it is, so the person sees a wrong key or an unknown
    /// host at once instead of after the attempts; only a connection that was up and broke is
    /// retried.
    ///
    /// Needs a tokio runtime (the supervisor runs as a task of it).
    pub async fn connect(
        connector: impl Connector,
        policy: BackoffPolicy,
    ) -> Result<(Self, LinkEvents), ConnectFailure> {
        let connector: Arc<dyn Connector> = Arc::new(connector);
        let Established {
            client,
            events,
            transport,
        } = connector.connect().await?;
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (state_tx, _) = watch::channel(LinkState::Connected);
        let shared = Arc::new(Shared {
            current: Mutex::new(None),
            tracked: Mutex::new(BTreeSet::new()),
            state: state_tx,
        });
        if !go_live(&shared, &events_tx, client, transport.id()).await {
            return Err(ConnectFailure {
                message: "the connection broke as soon as it was made".to_owned(),
                permanent: false,
            });
        }
        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let supervisor = tokio::spawn(supervise(
            Arc::clone(&shared),
            connector,
            policy,
            commands_rx,
            events_tx,
            Connection { events, transport },
        ));
        Ok((
            Self {
                shared,
                commands: commands_tx,
                supervisor,
            },
            LinkEvents {
                receiver: events_rx,
            },
        ))
    }

    /// Where the link stands now.
    pub fn state(&self) -> LinkState {
        self.shared.state.borrow().clone()
    }

    /// Follows the state of the link; the receiver always holds the latest.
    pub fn subscribe(&self) -> watch::Receiver<LinkState> {
        self.shared.state.subscribe()
    }

    /// The process id of what carries the connection that is up (the `ssh` process), `None`
    /// while the link is down or when the carrier is not a process.
    pub fn transport_id(&self) -> Option<u32> {
        lock(&self.shared.current)
            .as_ref()
            .and_then(|live| live.transport_id)
    }

    /// Breaks the connection that is up, as if the network had failed: the carrier is ended and
    /// the link starts to reconnect. Nothing happens when the link is down already.
    pub fn cut(&self) {
        let _ = self.commands.send(Command::Cut);
    }

    /// Stops waiting between attempts and tries now; after a failure, starts the attempts over.
    /// Nothing happens when the link is up.
    pub fn retry_now(&self) {
        let _ = self.commands.send(Command::RetryNow);
    }

    fn live(&self) -> Result<Arc<DaemonClient>, ClientError> {
        lock(&self.shared.current)
            .as_ref()
            .map(|live| Arc::clone(&live.client))
            .ok_or(ClientError::Closed)
    }

    /// Starts a process in a new session in the daemon. The session is not attached: call
    /// [`ReconnectingClient::attach`] to receive its output and have it attached again after a
    /// break. (If the link breaks before the answer arrives, the session may exist without the
    /// caller knowing its id; [`ReconnectingClient::list`] shows it.)
    pub async fn create(&self, spec: &SpawnSpec) -> Result<Created, ClientError> {
        self.live()?.create(spec).await
    }

    /// Sends bytes to the terminal input of a session.
    pub async fn write(&self, session: SessionId, data: &[u8]) -> Result<(), ClientError> {
        self.live()?.write(session, data).await
    }

    pub async fn resize(
        &self,
        session: SessionId,
        cols: u16,
        rows: u16,
    ) -> Result<(), ClientError> {
        self.live()?.resize(session, cols, rows).await
    }

    /// Starts receiving the output of a session and returns what the daemon kept of it. From now
    /// on the session is attached again after every break (a [`LinkEvent::Reattached`] each
    /// time), until it is detached, killed, ended or lost. A call that fails because the link is
    /// down leaves the session on that list: it is attached when the link is back.
    pub async fn attach(&self, session: SessionId) -> Result<Attached, ClientError> {
        lock(&self.shared.tracked).insert(session);
        let result = match self.live() {
            Ok(client) => client.attach(session).await,
            Err(e) => Err(e),
        };
        match &result {
            // The daemon said no (it does not know the session) or the process already ended:
            // there is nothing to attach again.
            Err(ClientError::Server(_)) => {
                lock(&self.shared.tracked).remove(&session);
            }
            Ok(attached) if attached.exit.is_some() => {
                lock(&self.shared.tracked).remove(&session);
            }
            _ => {}
        }
        result
    }

    /// Stops receiving the output of a session. The session goes on, and is not attached
    /// again. A call that fails changes nothing: the session is still one to attach again.
    pub async fn detach(&self, session: SessionId) -> Result<(), ClientError> {
        let result = self.live()?.detach(session).await;
        self.forget_if_done(session, &result);
        result
    }

    /// Ends the process of a session if it still runs, and releases the session. A call that
    /// fails changes nothing: the session is still one to attach again.
    pub async fn kill(&self, session: SessionId) -> Result<(), ClientError> {
        let result = self.live()?.kill(session).await;
        self.forget_if_done(session, &result);
        result
    }

    /// Drops a session from the ones to attach again once the daemon has done what was asked
    /// (or says it has no such session).
    fn forget_if_done(&self, session: SessionId, result: &Result<(), ClientError>) {
        let done = match result {
            Ok(()) => true,
            Err(ClientError::Server(body)) => body.code == ErrorCode::UnknownSession,
            Err(_) => false,
        };
        if done {
            lock(&self.shared.tracked).remove(&session);
        }
    }

    /// The sessions in the daemon, oldest first.
    pub async fn list(&self) -> Result<Vec<SessionInfo>, ClientError> {
        self.live()?.list().await
    }
}

impl Drop for ReconnectingClient {
    fn drop(&mut self) {
        self.supervisor.abort();
    }
}

fn set_state(shared: &Shared, events: &mpsc::UnboundedSender<LinkEvent>, state: LinkState) {
    shared.state.send_replace(state.clone());
    let _ = events.send(LinkEvent::State(state));
}

/// Makes `client` the connection of the link: attaches the sessions to attach and then, in one
/// step with checking that no session was added meanwhile, publishes it so the calls use it.
/// `false` when the connection broke while it was being done.
async fn go_live(
    shared: &Shared,
    events: &mpsc::UnboundedSender<LinkEvent>,
    client: DaemonClient,
    transport_id: Option<u32>,
) -> bool {
    let client = Arc::new(client);
    let mut attached = BTreeSet::new();
    loop {
        let todo: Vec<SessionId> = lock(&shared.tracked)
            .difference(&attached)
            .copied()
            .collect();
        if todo.is_empty() {
            // A session added from now on finds the connection, and one added a moment ago is
            // seen by this check, which is made with the list locked.
            let tracked = lock(&shared.tracked);
            if tracked.is_subset(&attached) {
                *lock(&shared.current) = Some(Live {
                    client,
                    transport_id,
                });
                return true;
            }
            continue;
        }
        for session in todo {
            attached.insert(session);
            match client.attach(session).await {
                Ok(Attached { replay, exit }) => {
                    if exit.is_some() {
                        lock(&shared.tracked).remove(&session);
                    }
                    let _ = events.send(LinkEvent::Reattached {
                        session,
                        replay,
                        exit,
                    });
                }
                Err(ClientError::Server(body)) if body.code == ErrorCode::UnknownSession => {
                    lock(&shared.tracked).remove(&session);
                    let _ = events.send(LinkEvent::SessionLost { session });
                }
                Err(_) => return false,
            }
        }
    }
}

/// Runs the link: passes the events of the connection on, and when it ends makes another.
async fn supervise(
    shared: Arc<Shared>,
    connector: Arc<dyn Connector>,
    policy: BackoffPolicy,
    mut commands: mpsc::UnboundedReceiver<Command>,
    events_tx: mpsc::UnboundedSender<LinkEvent>,
    mut connection: Connection,
) {
    loop {
        loop {
            tokio::select! {
                event = connection.events.recv() => match event {
                    Some(ClientEvent::Output { session, data }) => {
                        let _ = events_tx.send(LinkEvent::Output { session, data });
                    }
                    Some(ClientEvent::Exit { session, info }) => {
                        lock(&shared.tracked).remove(&session);
                        let _ = events_tx.send(LinkEvent::Exit { session, info });
                    }
                    None => break,
                },
                command = commands.recv() => match command {
                    Some(Command::Cut) => connection.transport.cut(),
                    Some(Command::RetryNow) => {}
                    None => return,
                },
            }
        }
        // The connection ended. Whatever carried it goes too, so a carrier that outlived the
        // connection cannot be mistaken for a second one.
        *lock(&shared.current) = None;
        connection.transport.cut();
        let reason = "the connection to the daemon ended".to_owned();
        match reconnect(
            &shared,
            &*connector,
            policy,
            &mut commands,
            &events_tx,
            reason,
        )
        .await
        {
            Some(next) => connection = next,
            None => return,
        }
    }
}

/// Makes attempts until one works (`Some`) or the client is dropped (`None`). Reports the state
/// as it goes; after the last attempt, or a permanent failure, waits for [`Command::RetryNow`]
/// and starts over.
async fn reconnect(
    shared: &Shared,
    connector: &dyn Connector,
    policy: BackoffPolicy,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    events: &mpsc::UnboundedSender<LinkEvent>,
    mut reason: String,
) -> Option<Connection> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let Some(delay) = policy.delay(attempt) else {
            set_state(
                shared,
                events,
                LinkState::Failed {
                    reason: reason.clone(),
                },
            );
            wait_for_retry(commands).await?;
            attempt = 0;
            continue;
        };
        set_state(
            shared,
            events,
            LinkState::Reconnecting {
                attempt,
                max_attempts: policy.max_attempts,
                retry_in: delay,
                reason: reason.clone(),
            },
        );
        let wait = tokio::time::sleep(delay);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                () = &mut wait => break,
                command = commands.recv() => match command {
                    None => return None,
                    Some(Command::RetryNow) => break,
                    Some(Command::Cut) => {}
                },
            }
        }
        match connector.connect().await {
            Ok(Established {
                client,
                events: client_events,
                transport,
            }) => {
                if go_live(shared, events, client, transport.id()).await {
                    set_state(shared, events, LinkState::Connected);
                    return Some(Connection {
                        events: client_events,
                        transport,
                    });
                }
                "the connection broke while the sessions were being attached again"
                    .clone_into(&mut reason);
            }
            Err(failure) if failure.permanent => {
                set_state(
                    shared,
                    events,
                    LinkState::Failed {
                        reason: failure.message.clone(),
                    },
                );
                reason = failure.message;
                wait_for_retry(commands).await?;
                attempt = 0;
            }
            Err(failure) => reason = failure.message,
        }
    }
}

/// Waits for the person to ask for a retry; `None` when the client is dropped instead.
async fn wait_for_retry(commands: &mut mpsc::UnboundedReceiver<Command>) -> Option<()> {
    loop {
        match commands.recv().await? {
            Command::RetryNow => return Some(()),
            Command::Cut => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(first_ms: u64, max_ms: u64, attempts: u32) -> BackoffPolicy {
        BackoffPolicy {
            first_delay: Duration::from_millis(first_ms),
            max_delay: Duration::from_millis(max_ms),
            max_attempts: attempts,
        }
    }

    fn waits(policy: BackoffPolicy) -> Vec<u64> {
        (1..)
            .map_while(|attempt| policy.delay(attempt))
            .map(|d| d.as_millis() as u64)
            .collect()
    }

    #[test]
    fn the_wait_doubles_up_to_the_cap() {
        assert_eq!(
            waits(policy(500, 10_000, 8)),
            [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]
        );
    }

    #[test]
    fn there_are_exactly_max_attempts_attempts() {
        let p = policy(100, 1000, 3);
        assert_eq!(p.delay(0), None, "attempts count from 1");
        assert_eq!(p.delay(1), Some(Duration::from_millis(100)));
        assert_eq!(p.delay(3), Some(Duration::from_millis(400)));
        assert_eq!(p.delay(4), None);
        assert_eq!(
            policy(100, 1000, 0).delay(1),
            None,
            "zero attempts means none"
        );
    }

    #[test]
    fn a_cap_below_the_first_wait_wins() {
        assert_eq!(waits(policy(5000, 1000, 3)), [1000, 1000, 1000]);
        assert_eq!(waits(policy(0, 1000, 3)), [0, 0, 0]);
    }

    #[test]
    fn the_wait_never_overflows() {
        let p = BackoffPolicy {
            first_delay: Duration::from_secs(u64::MAX / 4),
            max_delay: Duration::MAX,
            max_attempts: u32::MAX,
        };
        assert_eq!(
            p.delay(u32::MAX),
            Some(Duration::MAX),
            "saturates instead of panicking"
        );
        let sane = BackoffPolicy {
            first_delay: Duration::from_millis(1),
            max_delay: Duration::from_secs(10),
            max_attempts: u32::MAX,
        };
        assert_eq!(sane.delay(u32::MAX), Some(Duration::from_secs(10)));
        assert_eq!(sane.delay(32), Some(Duration::from_secs(10)));
    }

    #[test]
    fn the_total_is_the_sum_of_the_waits_and_the_default_is_about_three_minutes() {
        assert_eq!(
            policy(500, 10_000, 8).total_delay(),
            Duration::from_millis(500 + 1000 + 2000 + 4000 + 8000 + 3 * 10_000)
        );
        assert_eq!(policy(500, 10_000, 0).total_delay(), Duration::ZERO);
        let total = BackoffPolicy::default().total_delay();
        assert!(
            (Duration::from_secs(150)..=Duration::from_secs(210)).contains(&total),
            "{total:?}"
        );
    }

    #[test]
    fn the_states_read_as_sentences() {
        assert_eq!(LinkState::Connected.to_string(), "connected");
        let waiting = LinkState::Reconnecting {
            attempt: 2,
            max_attempts: 5,
            retry_in: Duration::from_millis(1500),
            reason: "ssh failed".into(),
        };
        assert_eq!(
            waiting.to_string(),
            "reconnecting (attempt 2 of 5 in 1.5s): ssh failed"
        );
        assert_eq!(
            LinkState::Failed {
                reason: "no key".into()
            }
            .to_string(),
            "failed: no key"
        );
    }
}

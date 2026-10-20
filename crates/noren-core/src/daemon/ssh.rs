//! The daemon on another machine, reached through the `ssh` of the system.
//!
//! [`SshTarget`] describes a machine (host, user, port, key, known hosts) and runs the `ssh`
//! program with `norend --bridge` as the remote command. The bridge connects to the daemon of the
//! remote user (starting one if none answers) and relays one connection over its standard input
//! and output, which `ssh` carries to this side; [`DaemonClient::connect_stream_within`] then
//! speaks the ordinary protocol over those pipes, handshake included. Nothing is installed on the
//! local side, no port is opened on either side, and a drop of the connection ends the `ssh`
//! process and the bridge but not the daemon, so [`ReconnectingClient`](super::ReconnectingClient)
//! can connect again and attach the sessions by their ids.
//!
//! What this module promises about the `ssh` process:
//!
//! - It is the `ssh` of the system, never a library: on Windows the OpenSSH client of
//!   `System32\OpenSSH` (not whichever `ssh.exe` comes first in `PATH`), elsewhere `ssh` from
//!   `PATH`. It is started with `CREATE_NO_WINDOW` on Windows and with all three standard streams
//!   piped, so no console and no window appear.
//! - The arguments are a list, never a string for a shell. The few values that reach the remote
//!   shell (the program and the endpoint name of the remote daemon) are checked against a short
//!   alphabet first, and a host or a user cannot start with `-` (the `--` before the destination
//!   would stop it being an option anyway).
//! - It never asks anything: `BatchMode=yes`, public keys only (no password, no keyboard
//!   interaction), host keys checked strictly against the known hosts file, no agent, X11 or port
//!   forwarding, and `SSH_ASKPASS` removed from its environment so no program with a window can
//!   be started to ask. A key that needs a passphrase, a host that is not in the known hosts file
//!   and a password-only account are failures with a sentence, not a prompt.
//! - Nothing is stored: the target holds paths and names, never a password or a passphrase.

use std::ffi::OsString;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr, Command};
use tokio::task::JoinHandle;

use super::client::{ClientError, ClientEvents, DaemonClient};
use super::ipc::check_name;
use super::lock;
use super::protocol::{ErrorCode, ProtocolError};
use super::reconnect::{ConnectFailure, Connector, Established, Transport};

/// What `ssh` is run for on the other machine.
pub const DEFAULT_REMOTE_PROGRAM: &str = "norend";

/// How long `ssh` may take to open the connection (`ConnectTimeout`).
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the daemon has to say `Welcome`. The `Hello` waits in the pipe of `ssh` while it
/// connects, logs in and starts the bridge (which may start a daemon first), so a local pipe's
/// 10 seconds is too little.
pub const DEFAULT_SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(40);

/// How often `ssh` asks the other side whether it is there (`ServerAliveInterval`), and how many
/// answers in a row it may miss (`ServerAliveCountMax`) before it gives the connection up. A
/// connection that died without a goodbye (a laptop that slept, a router that rebooted) is found
/// out after about 45 seconds instead of never, and that is what starts the reconnection.
const ALIVE_INTERVAL_SECONDS: u32 = 15;
const ALIVE_COUNT_MAX: u32 = 3;

/// How much of what `ssh` printed on its error stream is kept to explain a failure.
const STDERR_TAIL_BYTES: usize = 2048;

/// How long to wait for `ssh` to end, and for its last words, once the handshake failed.
const EXPLAIN_WAIT: Duration = Duration::from_secs(2);

/// A machine whose `norend` this client reaches through `ssh`. Fill in the fields you need;
/// everything but `host` is optional.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    /// A host name or an address (letters, digits, `.`, `-`, `_` and `:`; not starting with `-`).
    pub host: String,
    /// The user to log in as; `ssh` decides (its configuration, then the local user) when `None`.
    pub user: Option<String>,
    /// The port of the ssh server; 22 (or the configuration) when `None`.
    pub port: Option<u16>,
    /// The private key to log in with (`-i`, with `IdentitiesOnly=yes`, so no other key is
    /// offered). Without it `ssh` tries the keys of its configuration and of the agent.
    pub identity_file: Option<PathBuf>,
    /// The file of known hosts to check the host key against (`UserKnownHostsFile`); the
    /// `~/.ssh/known_hosts` of the user when `None`. A host that is not in it is refused.
    pub known_hosts_file: Option<PathBuf>,
    /// A configuration file to use instead of the user's own (`-F`).
    pub config_file: Option<PathBuf>,
    /// The `norend` to run on the other machine: a name found by the `PATH` of its login shell or
    /// a path. Letters, digits, `.`, `_`, `/`, `+`, `~` and `-` only, not starting with `-`.
    pub remote_program: String,
    /// The name of the remote daemon (`norend --endpoint <name>`); the default one when `None`.
    pub remote_endpoint: Option<String>,
    /// The `ssh` to run; the one of the system (see [`default_ssh_program`]) when `None`.
    pub ssh_program: Option<PathBuf>,
    /// How long `ssh` may take to connect (`ConnectTimeout`, whole seconds, at least one).
    pub connect_timeout: Duration,
    /// How long the daemon has to answer the `Hello`, counted from the start of `ssh`.
    pub handshake_timeout: Duration,
}

impl SshTarget {
    /// A target with only the host set: the default user, port, keys and known hosts of `ssh`.
    pub fn new(host: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            user: None,
            port: None,
            identity_file: None,
            known_hosts_file: None,
            config_file: None,
            remote_program: DEFAULT_REMOTE_PROGRAM.to_owned(),
            remote_endpoint: None,
            ssh_program: None,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            handshake_timeout: DEFAULT_SSH_HANDSHAKE_TIMEOUT,
        }
    }

    /// Checks every field that ends up on a command line.
    pub fn validate(&self) -> Result<(), SshError> {
        check_destination_part("host", &self.host, true)?;
        if let Some(user) = &self.user {
            check_destination_part("user", user, false)?;
        }
        if self.port == Some(0) {
            return Err(invalid("the port cannot be 0"));
        }
        check_remote_program(&self.remote_program)?;
        if let Some(name) = &self.remote_endpoint {
            check_name(name).map_err(|e| invalid(format!("the remote daemon name: {e}")))?;
        }
        if let Some(path) = &self.known_hosts_file {
            quote_for_option("known hosts file", path)?;
        }
        for (what, path) in [
            ("identity file", &self.identity_file),
            ("configuration file", &self.config_file),
        ] {
            if let Some(path) = path {
                check_path(what, path)?;
            }
        }
        if self.connect_timeout.is_zero() {
            return Err(invalid("the connect timeout cannot be zero"));
        }
        Ok(())
    }

    /// The arguments of `ssh`, one element each, in the order they are given. This is the whole
    /// command line after the program: the options, `--`, the destination and the remote command
    /// (`norend --bridge [--endpoint <name>]`).
    pub fn args(&self) -> Result<Vec<OsString>, SshError> {
        self.validate()?;
        let mut args: Vec<OsString> = ["-T", "-a", "-x"].map(OsString::from).into();
        let seconds = self.connect_timeout.as_secs().max(1);
        for option in [
            "BatchMode=yes".to_owned(),
            "PasswordAuthentication=no".to_owned(),
            "KbdInteractiveAuthentication=no".to_owned(),
            "PreferredAuthentications=publickey".to_owned(),
            "StrictHostKeyChecking=yes".to_owned(),
            "ClearAllForwardings=yes".to_owned(),
            // INFO, the default, spelled out so a `LogLevel QUIET` in the configuration of the user cannot hide
            // the last words of a failure: with ERROR the OpenSSH of Windows says nothing at all when
            // the connection is refused.
            "LogLevel=INFO".to_owned(),
            format!("ConnectTimeout={seconds}"),
            format!("ServerAliveInterval={ALIVE_INTERVAL_SECONDS}"),
            format!("ServerAliveCountMax={ALIVE_COUNT_MAX}"),
        ] {
            args.push("-o".into());
            args.push(option.into());
        }
        if let Some(config) = &self.config_file {
            args.push("-F".into());
            args.push(config.clone().into_os_string());
        }
        if let Some(port) = self.port {
            args.push("-p".into());
            args.push(port.to_string().into());
        }
        if let Some(identity) = &self.identity_file {
            args.push("-i".into());
            args.push(identity.clone().into_os_string());
            args.push("-o".into());
            args.push("IdentitiesOnly=yes".into());
        }
        if let Some(known_hosts) = &self.known_hosts_file {
            args.push("-o".into());
            args.push(
                format!(
                    "UserKnownHostsFile={}",
                    quote_for_option("known hosts file", known_hosts)?
                )
                .into(),
            );
        }
        args.push("--".into());
        args.push(
            match &self.user {
                Some(user) => format!("{user}@{}", self.host),
                None => self.host.clone(),
            }
            .into(),
        );
        args.push(self.remote_program.clone().into());
        args.push("--bridge".into());
        if let Some(name) = &self.remote_endpoint {
            args.push("--endpoint".into());
            args.push(name.clone().into());
        }
        Ok(args)
    }

    /// The `ssh` that will be run.
    pub fn program(&self) -> PathBuf {
        self.ssh_program.clone().unwrap_or_else(default_ssh_program)
    }

    /// The command, ready to spawn: the streams piped, the process ended when the handle is
    /// dropped, no window on Windows, and nothing that could ask a person for anything.
    pub fn command(&self) -> Result<Command, SshError> {
        let mut command = Command::new(self.program());
        command
            .args(self.args()?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            // `ssh` runs this program to ask for a passphrase when it has no terminal and the
            // variables point to one, and such a program has a window.
            .env_remove("SSH_ASKPASS")
            .env_remove("SSH_ASKPASS_REQUIRE");
        #[cfg(windows)]
        {
            /// `CREATE_NO_WINDOW`: `ssh.exe` is a console program, and one started by a program
            /// with a window would open a console window unless told not to.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        Ok(command)
    }

    /// Starts `ssh`, waits for the daemon on the other side to welcome this client and returns the
    /// client, its events and the handle of the `ssh` process. The process lives as long as the
    /// [`SshLink`] does.
    ///
    /// Needs a tokio runtime with the time and process drivers.
    pub async fn open(&self) -> Result<(DaemonClient, ClientEvents, SshLink), SshError> {
        let program = self.program();
        let mut child = self.command()?.spawn().map_err(|source| SshError::Spawn {
            program: program.clone(),
            source,
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(SshError::Spawn {
                program,
                source: io::Error::other("the standard streams of ssh were not piped"),
            });
        };
        let tail = Arc::new(Mutex::new(Tail::new(STDERR_TAIL_BYTES)));
        let drain = tokio::spawn(drain(stderr, Arc::clone(&tail)));
        let mut link = SshLink {
            child,
            tail,
            drain: Some(drain),
        };
        let stream = tokio::io::join(stdout, stdin);
        match DaemonClient::connect_stream_within(stream, self.handshake_timeout).await {
            Ok((client, events)) => Ok((client, events, link)),
            Err(error) => Err(link.explain(error).await),
        }
    }
}

impl Connector for SshTarget {
    fn connect(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Established, ConnectFailure>> + Send + '_>> {
        Box::pin(async move {
            match self.open().await {
                Ok((client, events, link)) => Ok(Established {
                    client,
                    events,
                    transport: Box::new(link),
                }),
                Err(error) => Err(ConnectFailure {
                    permanent: error.is_permanent(),
                    message: error.to_string(),
                }),
            }
        })
    }
}

/// The `ssh` process that carries a connection. Dropping it ends the process.
pub struct SshLink {
    child: Child,
    tail: Arc<Mutex<Tail>>,
    drain: Option<JoinHandle<()>>,
}

impl SshLink {
    /// The process id of `ssh`, while it runs.
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// Ends the `ssh` process now (the connection drops, the daemon and its sessions stay).
    pub fn kill(&mut self) {
        let _ = self.child.start_kill();
    }

    /// The last things `ssh` printed on its error stream.
    pub fn stderr_tail(&self) -> String {
        lock(&self.tail).text()
    }

    /// Why the handshake failed, from what `ssh` did and said.
    async fn explain(&mut self, error: ClientError) -> SshError {
        let status = tokio::time::timeout(EXPLAIN_WAIT, self.child.wait())
            .await
            .ok()
            .and_then(Result::ok);
        if status.is_none() {
            // Still running: it is the one that did not answer, or the answer was not a daemon's.
            let _ = self.child.start_kill();
        }
        if let Some(drain) = self.drain.take() {
            let _ = tokio::time::timeout(EXPLAIN_WAIT, drain).await;
        }
        let stderr = self.stderr_tail();
        let ssh_failed = status.is_some_and(|s| !s.success());
        let exit = status.and_then(|s| s.code());
        explain_failure(error, ssh_failed, exit, stderr)
    }
}

impl Transport for SshLink {
    fn id(&self) -> Option<u32> {
        self.pid()
    }

    fn cut(&mut self) {
        self.kill();
    }
}

impl fmt::Debug for SshLink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshLink").field("pid", &self.pid()).finish()
    }
}

/// What kind of failure `ssh` reported, from its exit code and what it printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshFailure {
    /// The server did not accept the key (`Permission denied (publickey)`).
    Authentication,
    /// The host key is not the one in the known hosts file, or not in it at all.
    HostKey,
    /// `ssh` connected, but the remote program could not be run (not found, not executable).
    RemoteProgram,
    /// The program that answered is not a `norend`, or something was printed before it spoke
    /// (a banner, a line of a shell startup file).
    NotNorend,
    /// The machine could not be reached, or the connection broke while it was being made.
    Network,
    /// Nothing answered in time.
    Timeout,
    /// Anything else.
    Other,
}

impl SshFailure {
    /// A failure that trying again cannot fix.
    pub fn is_permanent(self) -> bool {
        matches!(
            self,
            Self::Authentication | Self::HostKey | Self::RemoteProgram | Self::NotNorend
        )
    }
}

/// Why a connection through `ssh` could not be made.
#[derive(Debug)]
pub enum SshError {
    /// A field of the target cannot be put on a command line.
    Invalid(String),
    /// The `ssh` program could not be started.
    Spawn { program: PathBuf, source: io::Error },
    /// `ssh` ended or stayed silent before a daemon welcomed this client.
    Failed {
        kind: SshFailure,
        /// The exit code of `ssh` when it ended.
        exit: Option<i32>,
        /// What it printed on its error stream, or what went wrong on this side.
        detail: String,
    },
    /// A `norend` answered and refused (another protocol version).
    Daemon(ClientError),
}

impl SshError {
    /// An error that trying again cannot fix: a wrong field, no `ssh`, a refused key, a changed
    /// host key, no `norend` on the other machine, a daemon of another version.
    pub fn is_permanent(&self) -> bool {
        match self {
            Self::Invalid(_) | Self::Spawn { .. } => true,
            Self::Failed { kind, .. } => kind.is_permanent(),
            Self::Daemon(_) => true,
        }
    }

    /// The kind of failure, when `ssh` was involved.
    pub fn kind(&self) -> Option<SshFailure> {
        match self {
            Self::Failed { kind, .. } => Some(*kind),
            _ => None,
        }
    }
}

impl fmt::Display for SshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(why) => write!(f, "{why}"),
            Self::Spawn { program, source } => write!(
                f,
                "could not start ssh ({}): {source}. Install the OpenSSH client and try again",
                program.display()
            ),
            Self::Failed { kind, exit, detail } => {
                let what = match kind {
                    SshFailure::Authentication => "the server refused the key",
                    SshFailure::HostKey => "the host key was refused",
                    SshFailure::RemoteProgram => "the remote norend could not be run",
                    SshFailure::NotNorend => "what answered is not a norend",
                    SshFailure::Network => "the machine could not be reached",
                    SshFailure::Timeout => "nothing answered in time",
                    SshFailure::Other => "ssh failed",
                };
                write!(f, "{what}")?;
                if let Some(code) = exit {
                    write!(f, " (ssh exited with {code})")?;
                }
                if !detail.is_empty() {
                    write!(f, ": {detail}")?;
                }
                Ok(())
            }
            Self::Daemon(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SshError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn { source, .. } => Some(source),
            Self::Daemon(error) => Some(error),
            _ => None,
        }
    }
}

/// The `ssh` this machine uses by default. On Windows it is the OpenSSH client that Windows ships
/// (`%SystemRoot%\System32\OpenSSH\ssh.exe`), because the first `ssh.exe` in `PATH` is often the
/// one of another program (a Git install, say) with other rules about keys and agents; when it is
/// not there, `ssh.exe` from `PATH`. Elsewhere it is `ssh` from `PATH`.
pub fn default_ssh_program() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let system = Path::new(&root)
                .join("System32")
                .join("OpenSSH")
                .join("ssh.exe");
            if system.is_file() {
                return system;
            }
        }
        PathBuf::from("ssh.exe")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("ssh")
    }
}

// ---------------------------------------------------------------------------------------------
// Checking what reaches a command line
// ---------------------------------------------------------------------------------------------

fn invalid(why: impl Into<String>) -> SshError {
    SshError::Invalid(why.into())
}

/// A host or a user: a short word that cannot be taken for an option or split into two.
fn check_destination_part(what: &str, text: &str, host: bool) -> Result<(), SshError> {
    let allowed =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') || (host && c == ':');
    if text.is_empty() {
        return Err(invalid(format!("the {what} is empty")));
    }
    if text.len() > 255 {
        return Err(invalid(format!("the {what} is longer than 255 characters")));
    }
    if text.starts_with('-') {
        return Err(invalid(format!("the {what} cannot start with '-'")));
    }
    if let Some(bad) = text.chars().find(|c| !allowed(*c)) {
        return Err(invalid(format!(
            "the {what} {text:?} has a character that is not allowed ({bad:?}); use letters, \
             digits, '.', '-', '_'{}",
            if host { " and ':'" } else { "" }
        )));
    }
    Ok(())
}

/// The program that runs on the other machine is written into a command line that the remote
/// shell reads, so it is held to a short alphabet.
fn check_remote_program(program: &str) -> Result<(), SshError> {
    if program.is_empty() || program.len() > 255 {
        return Err(invalid("the remote program must have 1 to 255 characters"));
    }
    if program.starts_with('-') {
        return Err(invalid("the remote program cannot start with '-'"));
    }
    if let Some(bad) = program
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '+' | '~' | '-')))
    {
        return Err(invalid(format!(
            "the remote program {program:?} has a character that is not allowed ({bad:?}); use \
             letters, digits, '.', '_', '/', '+', '~' and '-'"
        )));
    }
    Ok(())
}

fn check_path(what: &str, path: &Path) -> Result<(), SshError> {
    if path.as_os_str().is_empty() {
        return Err(invalid(format!("the {what} is empty")));
    }
    if path.to_string_lossy().chars().any(char::is_control) {
        return Err(invalid(format!("the {what} has a control character")));
    }
    Ok(())
}

/// A path as the value of an `-o` option, which `ssh` reads like a line of its configuration
/// file: in double quotes, with `\` and `"` escaped (a Windows path has backslashes).
fn quote_for_option(what: &str, path: &Path) -> Result<String, SshError> {
    check_path(what, path)?;
    let text = path
        .to_str()
        .ok_or_else(|| invalid(format!("the {what} is not valid UTF-8")))?;
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for c in text.chars() {
        if matches!(c, '\\' | '"') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    Ok(quoted)
}

// ---------------------------------------------------------------------------------------------
// Explaining a failure
// ---------------------------------------------------------------------------------------------

/// Turns a failed handshake into the error to show. `ssh_failed` says that the process ended
/// with a failure (and `exit` is its code), which is what `stderr` then explains.
fn explain_failure(
    error: ClientError,
    ssh_failed: bool,
    exit: Option<i32>,
    stderr: String,
) -> SshError {
    let stderr = stderr.trim().to_owned();
    if ssh_failed {
        return SshError::Failed {
            kind: classify(exit, &stderr),
            exit,
            detail: stderr,
        };
    }
    match error {
        ClientError::Server(body) if body.code == ErrorCode::VersionMismatch => {
            SshError::Daemon(ClientError::Server(body))
        }
        ClientError::Protocol(ProtocolError::Truncated) | ClientError::Closed => SshError::Failed {
            kind: classify(exit, &stderr),
            exit,
            detail: if stderr.is_empty() {
                "the connection ended before the daemon answered".to_owned()
            } else {
                stderr
            },
        },
        ClientError::Protocol(protocol) => SshError::Failed {
            kind: SshFailure::NotNorend,
            exit,
            detail: format!(
                "{protocol}; the remote command printed something that is not the protocol of \
                 norend (a banner, or a line in a shell startup file?), or it is not norend{}",
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!(". ssh said: {stderr}")
                }
            ),
        },
        ClientError::Io(e) if e.kind() == io::ErrorKind::TimedOut => SshError::Failed {
            kind: SshFailure::Timeout,
            exit,
            detail: if stderr.is_empty() {
                e.to_string()
            } else {
                stderr
            },
        },
        other => SshError::Failed {
            kind: classify(exit, &stderr),
            exit,
            detail: if stderr.is_empty() {
                other.to_string()
            } else {
                stderr
            },
        },
    }
}

/// What the last words of `ssh` say about why it failed.
fn classify(exit: Option<i32>, stderr: &str) -> SshFailure {
    let text = stderr.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    if has(&["permission denied", "too many authentication failures"]) {
        SshFailure::Authentication
    } else if has(&[
        "host key verification failed",
        "remote host identification has changed",
        "no matching host key type",
    ]) {
        SshFailure::HostKey
    } else if matches!(exit, Some(126 | 127)) || has(&["command not found", ": not found"]) {
        SshFailure::RemoteProgram
    } else if has(&[
        "could not resolve",
        "connection refused",
        "timed out",
        "no route to host",
        "network is unreachable",
        "connection reset",
        "connection closed",
        "broken pipe",
    ]) {
        SshFailure::Network
    } else {
        SshFailure::Other
    }
}

/// The latest bytes of a stream, up to a limit.
struct Tail {
    bytes: Vec<u8>,
    limit: usize,
}

impl Tail {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
        }
    }

    fn push(&mut self, data: &[u8]) {
        self.bytes.extend_from_slice(data);
        if self.bytes.len() > self.limit {
            let cut = self.bytes.len() - self.limit;
            self.bytes.drain(..cut);
        }
    }

    /// The text, line ends normalised, without the blank edges.
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes)
            .replace("\r\n", "\n")
            .trim()
            .to_owned()
    }
}

/// Reads the error stream of `ssh` until it ends, keeping the tail. It has to be read: a process
/// whose error stream nobody empties blocks when the pipe is full.
async fn drain(mut stderr: ChildStderr, tail: Arc<Mutex<Tail>>) {
    let mut buffer = [0u8; 1024];
    while let Ok(n) = stderr.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        lock(&tail).push(&buffer[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// The options every connection carries, whatever the target says.
    const FIXED: [&str; 23] = [
        "-T",
        "-a",
        "-x",
        "-o",
        "BatchMode=yes",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "PreferredAuthentications=publickey",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "LogLevel=INFO",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
    ];

    #[test]
    fn the_smallest_target_is_a_host_and_the_bridge() {
        let args = SshTarget::new("build.example.org").args().unwrap();
        let mut expected: Vec<String> = FIXED.iter().map(|s| (*s).to_owned()).collect();
        expected.extend(["--", "build.example.org", "norend", "--bridge"].map(str::to_owned));
        assert_eq!(strings(&args), expected);
    }

    #[test]
    fn every_option_of_the_target_has_its_place() {
        let mut target = SshTarget::new("10.0.0.7");
        target.user = Some("deploy".into());
        target.port = Some(2222);
        target.identity_file = Some(PathBuf::from("/keys/id ed25519"));
        target.known_hosts_file = Some(PathBuf::from("/tmp/known hosts"));
        target.config_file = Some(PathBuf::from("/etc/noren/ssh_config"));
        target.remote_program = "/opt/noren/bin/norend".into();
        target.remote_endpoint = Some("work".into());
        target.connect_timeout = Duration::from_secs(7);
        let args = strings(&target.args().unwrap());

        // The fixed part comes first (with the timeout this target chose)...
        assert_eq!(&args[..3], ["-T", "-a", "-x"]);
        assert!(args.contains(&"ConnectTimeout=7".to_owned()));
        // ...then the optional ones, each value in the element after its flag, never joined...
        let tail = &args[FIXED.len()..];
        assert_eq!(
            tail,
            [
                "-F",
                "/etc/noren/ssh_config",
                "-p",
                "2222",
                "-i",
                "/keys/id ed25519",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "UserKnownHostsFile=\"/tmp/known hosts\"",
                "--",
                "deploy@10.0.0.7",
                "/opt/noren/bin/norend",
                "--bridge",
                "--endpoint",
                "work",
            ]
        );
    }

    #[test]
    fn nothing_that_asks_a_person_is_ever_left_on() {
        let args = strings(&SshTarget::new("h").args().unwrap());
        for needle in [
            "BatchMode=yes",
            "PasswordAuthentication=no",
            "KbdInteractiveAuthentication=no",
            "PreferredAuthentications=publickey",
            "StrictHostKeyChecking=yes",
            "ClearAllForwardings=yes",
        ] {
            assert!(args.contains(&needle.to_owned()), "{needle}");
        }
        assert_eq!(&args[..3], ["-T", "-a", "-x"]);
        // No option that opens something or runs something on this side.
        for forbidden in [
            "ProxyCommand",
            "LocalCommand",
            "PermitLocalCommand",
            "-L",
            "-R",
            "-D",
        ] {
            assert!(
                !args.iter().any(|a| a.contains(forbidden)),
                "{forbidden} must not appear"
            );
        }
    }

    #[test]
    fn the_destination_cannot_be_taken_for_an_option() {
        for host in [
            "-oProxyCommand=calc",
            "-h",
            "",
            "a b",
            "a;b",
            "a$b",
            "a/b",
            "a@b",
            "a\nb",
        ] {
            let error = SshTarget::new(host).args().expect_err(host);
            assert!(matches!(error, SshError::Invalid(_)), "{host}: {error}");
        }
        for host in ["h", "build.example.org", "10.0.0.7", "fe80::1", "my_host-2"] {
            assert!(SshTarget::new(host).args().is_ok(), "{host}");
        }
        let mut target = SshTarget::new("h");
        for user in ["-l", "", "a b", "a@b", "a;b", "$(id)"] {
            target.user = Some(user.into());
            assert!(target.args().is_err(), "user {user:?}");
        }
        target.user = Some("deploy.bot-1".into());
        assert!(target.args().is_ok());
        // Whatever the host is, `--` comes before it.
        let args = strings(&SshTarget::new("h").args().unwrap());
        let dashes = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dashes + 1], "h");
    }

    #[test]
    fn what_reaches_the_remote_shell_has_a_short_alphabet() {
        let mut target = SshTarget::new("h");
        for program in [
            "norend; rm -rf /",
            "norend --x",
            "$(id)",
            "`id`",
            "a|b",
            "-norend",
            "",
            "a'b",
            "a\"b",
            "a&b",
        ] {
            target.remote_program = program.into();
            assert!(target.args().is_err(), "program {program:?}");
        }
        for program in [
            "norend",
            "/usr/local/bin/norend",
            "~/bin/norend",
            "norend-2.1+x",
        ] {
            target.remote_program = program.into();
            assert!(target.args().is_ok(), "program {program:?}");
        }
        target.remote_program = "norend".into();
        for name in ["a b", "x;y", "../x", ".hidden", "", "$(id)"] {
            target.remote_endpoint = Some(name.into());
            assert!(target.args().is_err(), "endpoint {name:?}");
        }
        target.remote_endpoint = Some("work-1".into());
        assert!(target.args().is_ok());
    }

    #[test]
    fn a_port_of_zero_and_a_zero_timeout_are_refused() {
        let mut target = SshTarget::new("h");
        target.port = Some(0);
        assert!(target.args().is_err());
        target.port = Some(1);
        assert!(target.args().is_ok());
        target.connect_timeout = Duration::ZERO;
        assert!(target.args().is_err());
        // A sub-second timeout still gives ssh a whole second.
        target.connect_timeout = Duration::from_millis(300);
        assert!(strings(&target.args().unwrap()).contains(&"ConnectTimeout=1".to_owned()));
    }

    #[test]
    fn a_known_hosts_path_is_quoted_for_the_configuration_parser() {
        let mut target = SshTarget::new("h");
        target.known_hosts_file = Some(PathBuf::from(r"C:\Users\Ana Maria\AppData\Local\Temp\kh"));
        let args = strings(&target.args().unwrap());
        let option = args
            .iter()
            .find(|a| a.starts_with("UserKnownHostsFile="))
            .unwrap();
        // Spaces survive inside the quotes, and every backslash is doubled so it reads back as one.
        assert_eq!(
            option,
            r#"UserKnownHostsFile="C:\\Users\\Ana Maria\\AppData\\Local\\Temp\\kh""#
        );
        target.known_hosts_file = Some(PathBuf::from("/tmp/a\"b"));
        assert!(
            strings(&target.args().unwrap())
                .contains(&r#"UserKnownHostsFile="/tmp/a\"b""#.to_owned())
        );
        target.known_hosts_file = Some(PathBuf::from("/tmp/a\nb"));
        assert!(target.args().is_err());
        target.known_hosts_file = Some(PathBuf::new());
        assert!(target.args().is_err());
    }

    #[test]
    fn the_command_runs_the_program_asked_for_with_those_arguments() {
        let mut target = SshTarget::new("h");
        target.ssh_program = Some(PathBuf::from("/opt/fake/ssh"));
        assert_eq!(target.program(), PathBuf::from("/opt/fake/ssh"));
        let command = target.command().unwrap();
        let std = command.as_std();
        assert_eq!(std.get_program(), "/opt/fake/ssh");
        let given: Vec<String> = std
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(given, strings(&target.args().unwrap()));
        // The askpass variables are removed from the environment of the child.
        let removed: Vec<_> = std
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert!(removed.contains(&"SSH_ASKPASS".to_owned()), "{removed:?}");
        assert!(
            removed.contains(&"SSH_ASKPASS_REQUIRE".to_owned()),
            "{removed:?}"
        );
    }

    #[test]
    fn the_default_program_is_the_ssh_of_the_system() {
        let program = default_ssh_program();
        if cfg!(windows) {
            let name = program
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_lowercase();
            assert_eq!(name, "ssh.exe");
            // When Windows has its own OpenSSH client, that one is chosen, not a bare name.
            let system = std::env::var_os("SystemRoot").map(|root| {
                Path::new(&root)
                    .join("System32")
                    .join("OpenSSH")
                    .join("ssh.exe")
            });
            if let Some(system) = system.filter(|p| p.is_file()) {
                assert_eq!(program, system);
            }
        } else {
            assert_eq!(program, PathBuf::from("ssh"));
        }
    }

    #[test]
    fn failures_are_told_apart_by_what_ssh_said() {
        let cases = [
            (
                Some(255),
                "deploy@h: Permission denied (publickey).",
                SshFailure::Authentication,
            ),
            (
                Some(255),
                "Host key verification failed.",
                SshFailure::HostKey,
            ),
            (
                Some(255),
                "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.",
                SshFailure::HostKey,
            ),
            (Some(127), "", SshFailure::RemoteProgram),
            (
                Some(127),
                "bash: norend: command not found",
                SshFailure::RemoteProgram,
            ),
            (
                Some(255),
                "ssh: connect to host h port 22: Connection refused",
                SshFailure::Network,
            ),
            (
                Some(255),
                "ssh: Could not resolve hostname h: no such host",
                SshFailure::Network,
            ),
            (
                Some(255),
                "Connection timed out during banner exchange",
                SshFailure::Network,
            ),
            (Some(255), "something nobody has seen", SshFailure::Other),
            (None, "", SshFailure::Other),
        ];
        for (exit, stderr, expected) in cases {
            assert_eq!(classify(exit, stderr), expected, "{exit:?} {stderr:?}");
        }
        for permanent in [
            SshFailure::Authentication,
            SshFailure::HostKey,
            SshFailure::RemoteProgram,
            SshFailure::NotNorend,
        ] {
            assert!(permanent.is_permanent(), "{permanent:?}");
        }
        for transient in [SshFailure::Network, SshFailure::Timeout, SshFailure::Other] {
            assert!(!transient.is_permanent(), "{transient:?}");
        }
    }

    #[test]
    fn a_handshake_that_failed_is_explained_by_the_process_when_it_ended_badly() {
        let error = explain_failure(
            ClientError::Closed,
            true,
            Some(255),
            "  deploy@h: Permission denied (publickey).\r\n".into(),
        );
        assert_eq!(error.kind(), Some(SshFailure::Authentication));
        assert!(error.is_permanent());
        let text = error.to_string();
        assert!(text.contains("refused the key"), "{text}");
        assert!(text.contains("exited with 255"), "{text}");
        assert!(text.contains("Permission denied (publickey)."), "{text}");
    }

    #[test]
    fn a_handshake_that_failed_without_ssh_failing_is_the_daemon_or_the_remote_shell() {
        use super::super::protocol::ErrorBody;

        // A daemon of another version is permanent and keeps its own sentence.
        let refused = explain_failure(
            ClientError::Server(ErrorBody::new(
                ErrorCode::VersionMismatch,
                "versions differ",
            )),
            false,
            None,
            String::new(),
        );
        assert!(matches!(refused, SshError::Daemon(_)));
        assert!(refused.is_permanent());
        assert!(refused.to_string().contains("versions differ"));

        // Bytes that are not a frame: something else spoke first.
        let junk = explain_failure(
            ClientError::Protocol(ProtocolError::FrameTooLarge { len: 1, max: 0 }),
            false,
            None,
            String::new(),
        );
        assert_eq!(junk.kind(), Some(SshFailure::NotNorend));
        assert!(junk.is_permanent());
        assert!(junk.to_string().contains("banner"), "{junk}");

        // A connection that simply ended is not permanent unless ssh says why.
        let ended = explain_failure(ClientError::Closed, false, Some(0), String::new());
        assert_eq!(ended.kind(), Some(SshFailure::Other));
        assert!(!ended.is_permanent());
        let truncated = explain_failure(
            ClientError::Protocol(ProtocolError::Truncated),
            false,
            None,
            "Connection reset by peer".into(),
        );
        assert_eq!(truncated.kind(), Some(SshFailure::Network));

        // Silence is a timeout.
        let slow = explain_failure(
            ClientError::Io(io::Error::new(io::ErrorKind::TimedOut, "no answer")),
            false,
            None,
            String::new(),
        );
        assert_eq!(slow.kind(), Some(SshFailure::Timeout));
        assert!(!slow.is_permanent());
    }

    #[test]
    fn invalid_targets_and_missing_programs_are_permanent() {
        assert!(SshError::Invalid("x".into()).is_permanent());
        assert!(
            SshError::Spawn {
                program: PathBuf::from("ssh"),
                source: io::Error::from(io::ErrorKind::NotFound)
            }
            .is_permanent()
        );
    }

    #[test]
    fn the_tail_keeps_the_latest_bytes_only() {
        let mut tail = Tail::new(10);
        tail.push(b"0123456789");
        assert_eq!(tail.text(), "0123456789");
        tail.push(b"abc");
        assert_eq!(tail.text(), "3456789abc");
        tail.push(&[b'x'; 100]);
        assert_eq!(tail.text(), "xxxxxxxxxx");
        let mut lines = Tail::new(100);
        lines.push(b"  one\r\ntwo\r\n\r\n");
        assert_eq!(lines.text(), "one\ntwo");
    }
}

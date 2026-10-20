//! `norend --bridge`: one connection to the daemon of this user, over standard input and output.
//!
//! This is the program a client on another machine runs through `ssh`: `ssh host norend
//! --bridge`. The bytes that come in on standard input go to the daemon, byte for byte, and the
//! bytes the daemon sends go out on standard output, so the pipes of `ssh` are one connection of
//! the ordinary protocol (the client's `Hello` and the daemon's `Welcome` included: the bridge
//! reads none of it). Standard output carries nothing else, ever: not a banner, not a log line;
//! what the bridge has to say goes to standard error.
//!
//! The bridge connects to the daemon on the endpoint (`default` unless `--endpoint` says
//! otherwise) and, when nothing listens there, starts one as a program of its own (detached, no
//! standard streams, a process group of its own, so it survives the `ssh` session that started
//! it) and waits for it, as the app does. It ends when either side closes: standard input at its
//! end (the `ssh` connection went away, or its client let go) or the daemon closing the
//! connection. The daemon and its sessions stay; a later bridge, from a new `ssh`, reaches them.

use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use noren_core::daemon::Endpoint;
use noren_core::daemon::ipc::{ClientStream, connect};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::cli::BridgeOptions;
use crate::{EXIT_FAILED, EXIT_IN_USE, EXIT_OK, EXIT_USAGE};

/// How long a daemon that was just started has to listen. The app waits as long.
pub const START_TIMEOUT: Duration = Duration::from_secs(8);
/// Pause between two looks at the endpoint while a daemon starts.
const POLL: Duration = Duration::from_millis(20);
/// How much is moved at once.
const CHUNK: usize = 16 * 1024;

/// Which side ended the conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closed {
    /// Standard input ended: whoever ran the bridge let go.
    Client,
    /// The daemon closed the connection (it stopped, or cut a client that did not read).
    Daemon,
}

/// `norend --bridge`: returns the exit code.
pub fn run(options: &BridgeOptions) -> u8 {
    let endpoint = match Endpoint::named(&options.endpoint) {
        Ok(endpoint) => endpoint,
        Err(e) => {
            eprintln!("norend: {e}");
            return EXIT_USAGE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("norend: could not start the runtime: {e}");
            return EXIT_FAILED;
        }
    };
    let code = runtime.block_on(async {
        let stream = match connect_or_start(&options.endpoint, &endpoint).await {
            Ok(stream) => stream,
            Err(message) => {
                eprintln!("norend: bridge: {message}");
                return EXIT_FAILED;
            }
        };
        match relay(tokio::io::stdin(), tokio::io::stdout(), stream).await {
            Ok(_) => EXIT_OK,
            Err(e) => {
                eprintln!("norend: bridge: {e}");
                EXIT_FAILED
            }
        }
    });
    // Standard input is read by a thread of the runtime that cannot be interrupted; when the
    // daemon was the side that closed, that thread is still waiting for a byte that may never
    // come, and the end of the runtime would wait for it. The process ends right after this.
    runtime.shutdown_background();
    code
}

/// Passes bytes between standard input and output (`input`, `output`) and the daemon until one
/// side closes. Everything read is written and flushed before the next read, so nothing waits in
/// a buffer while the other side waits for it.
pub async fn relay<I, O, S>(mut input: I, mut output: O, daemon: S) -> io::Result<Closed>
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (mut from_daemon, mut to_daemon) = tokio::io::split(daemon);
    tokio::select! {
        done = pump(&mut input, &mut to_daemon) => done.map(|()| Closed::Client),
        done = pump(&mut from_daemon, &mut output) => done.map(|()| Closed::Daemon),
    }
}

/// Copies `reader` to `writer` until the reader ends or either end goes away, then closes the
/// writer so the other side sees the end too.
async fn pump<R, W>(reader: &mut R, writer: &mut W) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(e) if gone(e.kind()) => break,
            Err(e) => return Err(e),
        };
        let written = async {
            writer.write_all(&buffer[..read]).await?;
            writer.flush().await
        }
        .await;
        match written {
            Ok(()) => {}
            Err(e) if gone(e.kind()) => break,
            Err(e) => return Err(e),
        }
    }
    let _ = writer.shutdown().await;
    Ok(())
}

/// The other end went away: how every kind of stream reports an ordinary close.
fn gone(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::UnexpectedEof
    )
}

/// "Nothing is there": no pipe or socket of that name, or a socket file nobody listens on.
fn nothing_listens(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}

/// Connects to the daemon, starting one when none answers.
async fn connect_or_start(name: &str, endpoint: &Endpoint) -> Result<ClientStream, String> {
    match connect(endpoint).await {
        Ok(stream) => return Ok(stream),
        Err(e) if nothing_listens(e.kind()) => {}
        Err(e) => return Err(format!("cannot open {endpoint}: {e}")),
    }
    let mut child = start_daemon(name).map_err(|e| {
        format!("no norend listens on {endpoint} and one could not be started: {e}")
    })?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        tokio::time::sleep(POLL).await;
        match connect(endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(e) if nothing_listens(e.kind()) => {}
            Err(e) => return Err(format!("cannot open {endpoint}: {e}")),
        }
        // A daemon that ended before it listened is a reason to stop waiting, except when another
        // bridge started one at the same moment and won the endpoint (exit code 3): that one is
        // the daemon to wait for.
        if let Ok(Some(status)) = child.try_wait()
            && status.code() != Some(i32::from(EXIT_IN_USE))
        {
            return Err(format!(
                "the norend that was started for {endpoint} ended before it listened ({status})"
            ));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err(format!(
                "the norend that was started for {endpoint} did not listen within {} seconds",
                START_TIMEOUT.as_secs()
            ));
        }
    }
}

/// Starts this program as a daemon of its own: no standard streams (a pipe the bridge holds would
/// keep the `ssh` session open and die with it), the temporary folder as its folder, no console
/// window on Windows, and a process group of its own.
fn start_daemon(name: &str) -> io::Result<Child> {
    let program: PathBuf = std::env::current_exe()?;
    let mut command = Command::new(program);
    command
        .arg("--endpoint")
        .arg(name)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut command);
    command.spawn()
}

/// `CREATE_NO_WINDOW` and `CREATE_NEW_PROCESS_GROUP`, as the app starts it.
#[cfg(windows)]
fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
}

/// A process group of its own, so a signal aimed at the group of the bridge does not reach it.
#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A relay between three in-memory streams: what the test writes to `client_in` is what
    /// standard input would hold, `client_out` is standard output, and `daemon_end` is the daemon.
    struct Wires {
        client_in: tokio::io::DuplexStream,
        client_out: tokio::io::DuplexStream,
        daemon_end: tokio::io::DuplexStream,
        relay: tokio::task::JoinHandle<io::Result<Closed>>,
    }

    fn wires(capacity: usize) -> Wires {
        let (client_in, relay_in) = tokio::io::duplex(capacity);
        let (relay_out, client_out) = tokio::io::duplex(capacity);
        let (relay_daemon, daemon_end) = tokio::io::duplex(capacity);
        let relay = tokio::spawn(relay(relay_in, relay_out, relay_daemon));
        Wires {
            client_in,
            client_out,
            daemon_end,
            relay,
        }
    }

    async fn finished(relay: tokio::task::JoinHandle<io::Result<Closed>>) -> Closed {
        tokio::time::timeout(Duration::from_secs(10), relay)
            .await
            .expect("the relay ends")
            .expect("the relay does not panic")
            .expect("the relay does not fail")
    }

    #[tokio::test]
    async fn bytes_go_both_ways_untouched_and_in_order() {
        let mut w = wires(1024);
        let up: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let down: Vec<u8> = (0..200_000u32).map(|i| (i % 241) as u8).collect();

        let sender = {
            let up = up.clone();
            let mut client_in = w.client_in;
            tokio::spawn(async move {
                client_in.write_all(&up).await.unwrap();
                client_in
            })
        };
        let answerer = {
            let down = down.clone();
            let mut daemon_end = w.daemon_end;
            let want = up.len();
            tokio::spawn(async move {
                let mut got = vec![0u8; want];
                daemon_end.read_exact(&mut got).await.unwrap();
                daemon_end.write_all(&down).await.unwrap();
                (daemon_end, got)
            })
        };
        let mut came_back = vec![0u8; down.len()];
        w.client_out.read_exact(&mut came_back).await.unwrap();
        let (_daemon_end, reached) = answerer.await.unwrap();
        assert!(
            reached == up,
            "what the daemon received differs from what was sent"
        );
        assert!(
            came_back == down,
            "what came back differs from what the daemon sent"
        );
        let _client_in = sender.await.unwrap();
        w.relay.abort();
    }

    #[tokio::test]
    async fn the_end_of_standard_input_ends_the_bridge_and_closes_the_daemon_side() {
        let mut w = wires(1024);
        w.client_in.write_all(b"last words").await.unwrap();
        drop(w.client_in);
        assert_eq!(finished(w.relay).await, Closed::Client);
        // The daemon got everything, and then the end of the connection.
        let mut seen = Vec::new();
        w.daemon_end.read_to_end(&mut seen).await.unwrap();
        assert_eq!(seen, b"last words");
    }

    #[tokio::test]
    async fn the_daemon_closing_ends_the_bridge_and_standard_output() {
        let mut w = wires(1024);
        w.daemon_end.write_all(b"goodbye").await.unwrap();
        drop(w.daemon_end);
        assert_eq!(finished(w.relay).await, Closed::Daemon);
        let mut seen = Vec::new();
        w.client_out.read_to_end(&mut seen).await.unwrap();
        assert_eq!(seen, b"goodbye");
        drop(w.client_in);
    }

    #[tokio::test]
    async fn a_reader_that_went_away_is_a_close_and_not_a_failure() {
        let w = wires(1024);
        // Standard output is a pipe whose reader (ssh) died: writes fail with a broken pipe.
        drop(w.client_out);
        let mut daemon_end = w.daemon_end;
        daemon_end.write_all(b"nobody listens").await.unwrap();
        assert_eq!(finished(w.relay).await, Closed::Daemon);
        drop(w.client_in);
    }

    #[test]
    fn only_a_missing_endpoint_is_a_reason_to_start_a_daemon() {
        for kind in [io::ErrorKind::NotFound, io::ErrorKind::ConnectionRefused] {
            assert!(nothing_listens(kind), "{kind:?}");
        }
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::TimedOut,
            io::ErrorKind::InvalidInput,
            io::ErrorKind::Other,
        ] {
            assert!(!nothing_listens(kind), "{kind:?}");
        }
    }
}

//! `norend`: the Noren session daemon as a program. It starts the server of `noren-core`
//! (`noren_core::daemon`) on the endpoint of the current user and runs until it is told to stop.
//! See `docs/DAEMON.md`.

mod bridge;
mod cli;
mod stop;

use std::io::{self, Write};
use std::process::ExitCode;

use noren_core::daemon::protocol::PROTOCOL_VERSION;
use noren_core::daemon::{Daemon, Endpoint, ServerConfig, ShutdownRequested};

use cli::{Command, RunOptions, StopOptions};

/// Stopped cleanly.
const EXIT_OK: u8 = 0;
/// Could not run (the endpoint cannot be bound, the signals cannot be watched...).
const EXIT_FAILED: u8 = 1;
/// The command line is wrong.
const EXIT_USAGE: u8 = 2;
/// Another daemon already listens on the endpoint.
const EXIT_IN_USE: u8 = 3;

fn main() -> ExitCode {
    match cli::parse(std::env::args().skip(1)) {
        Ok(Command::Help) => {
            print!("{}", cli::USAGE);
            ExitCode::from(EXIT_OK)
        }
        Ok(Command::Version) => {
            println!(
                "norend {} (protocol version {PROTOCOL_VERSION})",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::from(EXIT_OK)
        }
        Ok(Command::Run(options)) => ExitCode::from(run(&options)),
        Ok(Command::Stop(options)) => ExitCode::from(stop_daemon(&options)),
        Ok(Command::Bridge(options)) => ExitCode::from(bridge::run(&options)),
        Err(message) => {
            eprintln!("norend: {message}\nTry 'norend --help'.");
            ExitCode::from(EXIT_USAGE)
        }
    }
}

/// `norend --stop`: stops the daemon of the endpoint, or finds there is none.
fn stop_daemon(options: &StopOptions) -> u8 {
    let endpoint = match Endpoint::named(&options.endpoint) {
        Ok(endpoint) => endpoint,
        Err(e) => {
            eprintln!("norend: {e}");
            return EXIT_USAGE;
        }
    };
    match stop::stop(&options.endpoint, &endpoint, stop::STOP_TIMEOUT) {
        Ok(stop::Stopped::NothingRunning) => {
            println!("norend: no norend listens on {endpoint}; nothing to stop");
            EXIT_OK
        }
        Ok(stop::Stopped::Stopped { gone }) if gone.is_empty() => {
            println!(
                "norend: stopped the norend on {endpoint}; the endpoint is free (the system would \
                 not say which process it was, so its end was not waited for)"
            );
            EXIT_OK
        }
        Ok(stop::Stopped::Stopped { gone }) => {
            let pids: Vec<String> = gone.iter().map(u32::to_string).collect();
            println!(
                "norend: stopped the norend on {endpoint}; process {} is gone and the endpoint is free",
                pids.join(", ")
            );
            EXIT_OK
        }
        Err(message) => {
            eprintln!("norend: {message}");
            EXIT_FAILED
        }
    }
}

fn run(options: &RunOptions) -> u8 {
    let endpoint = match Endpoint::named(&options.endpoint) {
        Ok(endpoint) => endpoint,
        Err(e) => {
            eprintln!("norend: {e}");
            return EXIT_USAGE;
        }
    };
    let mut config = ServerConfig::default();
    if let Some(bytes) = options.buffer_bytes {
        config.buffer_bytes = bytes;
    }

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
    // The signals are watched before the endpoint opens, so a Ctrl+C that arrives right after the
    // "listening" line is already a clean stop and not a kill.
    let started = runtime.block_on(async {
        let signals = Signals::watch()?;
        let daemon = Daemon::start(endpoint.clone(), config)?;
        println!(
            "norend {} listening on {endpoint} (protocol version {PROTOCOL_VERSION}); \
             stop it with Ctrl+C",
            env!("CARGO_PKG_VERSION")
        );
        // The line is how a program that started us knows we are ready: do not leave it in a
        // buffer when stdout is a pipe.
        io::stdout().flush()?;
        let reason = signals.wait(daemon.shutdown_requested()).await;
        Ok::<_, io::Error>((daemon, reason))
    });
    let (mut daemon, reason) = match started {
        Ok(started) => started,
        Err(e) if e.kind() == io::ErrorKind::AddrInUse => {
            eprintln!(
                "norend: another norend already listens on {endpoint}; \
                 stop it first, or pick another name with --endpoint ({e})"
            );
            return EXIT_IN_USE;
        }
        Err(e) => {
            eprintln!("norend: could not run on {endpoint}: {e}");
            return EXIT_FAILED;
        }
    };

    println!("norend: stopping ({reason}); ending the sessions");
    // Ends every session, joins their threads and the thread of the daemon, and removes the
    // socket file; the endpoint is free again when this returns.
    daemon.shutdown();
    println!("norend: stopped");
    EXIT_OK
}

/// The ways a person or the system can ask the process to stop.
struct Signals {
    #[cfg(unix)]
    interrupt: tokio::signal::unix::Signal,
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
    #[cfg(windows)]
    ctrl_c: tokio::signal::windows::CtrlC,
    #[cfg(windows)]
    ctrl_break: tokio::signal::windows::CtrlBreak,
    #[cfg(windows)]
    ctrl_close: tokio::signal::windows::CtrlClose,
}

impl Signals {
    /// Starts watching. Must run inside the runtime.
    fn watch() -> io::Result<Self> {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            Ok(Self {
                interrupt: signal(SignalKind::interrupt())?,
                terminate: signal(SignalKind::terminate())?,
            })
        }
        #[cfg(windows)]
        {
            use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close};
            Ok(Self {
                ctrl_c: ctrl_c()?,
                ctrl_break: ctrl_break()?,
                ctrl_close: ctrl_close()?,
            })
        }
    }

    /// Completes when something asks for a stop; says what.
    async fn wait(mut self, requested: ShutdownRequested) -> &'static str {
        #[cfg(unix)]
        let system = async {
            tokio::select! {
                _ = self.interrupt.recv() => "Ctrl+C",
                _ = self.terminate.recv() => "SIGTERM",
            }
        };
        #[cfg(windows)]
        let system = async {
            tokio::select! {
                _ = self.ctrl_c.recv() => "Ctrl+C",
                _ = self.ctrl_break.recv() => "Ctrl+Break",
                _ = self.ctrl_close.recv() => "the console closed",
            }
        };
        tokio::select! {
            reason = system => reason,
            () = requested.wait() => "a client asked for it",
        }
    }
}

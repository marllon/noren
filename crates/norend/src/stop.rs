//! `norend --stop`: asks the daemon on an endpoint to stop and waits until it is gone.
//!
//! It is a client of the daemon like any other (`Shutdown`, protocol version 2): the daemon answers,
//! frees its endpoint, ends every session and exits, in that order. This is what an installer runs
//! before it replaces `norend.exe` (Windows keeps a running program's file open), so it must not
//! return while the process is still there: the endpoint being free only says the daemon stopped
//! listening, and ending the sessions can take a while after that. The daemon's own process is
//! found by its command line (`norend --endpoint <name>`) before it is asked, and waited for.
//! "Nothing is running there" is a success: there is nothing to wait for.

use std::io;
use std::time::{Duration, Instant};

use noren_core::daemon::{ClientError, DaemonClient, Endpoint};
use noren_core::{ProcessInfo, ProcessSource, SystemProcesses};

/// The longest `--stop` waits for the daemon to take its sessions down and leave.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// Pause between two looks at whether the endpoint is free, or the process gone.
const POLL: Duration = Duration::from_millis(50);

/// What `--stop` found and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stopped {
    /// Nothing listened on the endpoint.
    NothingRunning,
    /// A daemon answered, was asked to stop, and it is gone: the endpoint is free and its process
    /// has ended. `gone` are the processes that were waited for (empty when the system would not
    /// say which process the daemon is, which leaves only the endpoint to wait for).
    Stopped { gone: Vec<u32> },
}

/// Stops the daemon called `name` on `endpoint` and waits up to `timeout` for it to leave. The
/// error is a sentence for the person at the terminal (or for the log of an installer).
pub fn stop(name: &str, endpoint: &Endpoint, timeout: Duration) -> Result<Stopped, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("could not start the runtime: {e}"))?;
    let deadline = Instant::now() + timeout;
    let processes = Fresh;
    runtime.block_on(async {
        let (client, _events) = match DaemonClient::connect(endpoint).await {
            Ok(pair) => pair,
            Err(e) if is_absent(&e) => return Ok(Stopped::NothingRunning),
            Err(ClientError::Server(body)) => {
                return Err(format!(
                    "the daemon on {endpoint} would not talk to this norend ({}); stop it with \
                     the task manager or 'kill'",
                    body.message
                ));
            }
            Err(e) => return Err(format!("could not reach the daemon on {endpoint}: {e}")),
        };
        // Its process, found while it still listens (the command line says which daemon it is).
        let daemons = daemons_of(name, &processes.snapshot(), std::process::id());
        client
            .shutdown()
            .await
            .map_err(|e| format!("the daemon on {endpoint} did not take the request: {e}"))?;
        drop(client);
        wait_until_free(endpoint, deadline).await?;
        let gone = wait_until_gone(name, daemons, &processes, deadline).await?;
        Ok(Stopped::Stopped { gone })
    })
}

/// The processes of this machine, read afresh at every look. A `SystemProcesses` keeps what it
/// learned (the command line of a process is read once), which is what the agent scan wants and
/// what hides the end of a process here: on Unix a process that ended and was not collected yet is
/// still listed, and only a new reading shows it has no command line any more.
struct Fresh;

impl ProcessSource for Fresh {
    fn snapshot(&self) -> Vec<ProcessInfo> {
        SystemProcesses::new().snapshot()
    }
}

/// Nothing is there: the pipe does not exist, or a socket file is left behind by a dead daemon.
fn is_absent(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::Connect(e)
            if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused)
    )
}

async fn wait_until_free(endpoint: &Endpoint, deadline: Instant) -> Result<(), String> {
    loop {
        match DaemonClient::connect(endpoint).await {
            Err(e) if is_absent(&e) => return Ok(()),
            // Still there, or going down (it may accept a connection and then refuse it): look again.
            Ok(_) | Err(_) => {}
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the daemon on {endpoint} was asked to stop and still listened when the time was up"
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Waits until none of `pids` is the daemon called `name` any more; returns them. "Is the daemon"
/// is asked the way it was found (program and command line), not by the pid alone: a pid the
/// system gave to something else, and an ended process nobody has collected yet (a zombie on Unix,
/// whose command line is gone), are not the daemon.
async fn wait_until_gone(
    name: &str,
    pids: Vec<u32>,
    processes: &impl ProcessSource,
    deadline: Instant,
) -> Result<Vec<u32>, String> {
    if pids.is_empty() {
        return Ok(pids);
    }
    loop {
        let alive: Vec<u32> = daemons_of(name, &processes.snapshot(), std::process::id())
            .into_iter()
            .filter(|pid| pids.contains(pid))
            .collect();
        if alive.is_empty() {
            return Ok(pids);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the daemon was asked to stop, its endpoint is free, and its process {alive:?} \
                 was still running when the time was up"
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// The `norend` processes that run the daemon called `name`: not `except` (this process), not
/// another `--stop`, and only those whose command line says which daemon they are (a process the
/// system would not tell the command line of is left alone).
fn daemons_of(name: &str, processes: &[ProcessInfo], except: u32) -> Vec<u32> {
    processes
        .iter()
        .filter(|process| process.pid != except && is_norend(&process.name))
        .filter(|process| !process.cmdline.iter().any(|arg| arg == "--stop"))
        .filter(|process| endpoint_of(&process.cmdline).as_deref() == Some(name))
        .map(|process| process.pid)
        .collect()
}

/// `norend` or `norend.exe`, in any case.
fn is_norend(process_name: &str) -> bool {
    let lower = process_name.to_ascii_lowercase();
    lower == "norend" || lower == "norend.exe"
}

/// The name of the daemon a `norend` command line runs: the value of `--endpoint` (either
/// spelling), `default` when the option is not there, and `None` when the system gave no command
/// line at all.
fn endpoint_of(cmdline: &[String]) -> Option<String> {
    if cmdline.is_empty() {
        return None;
    }
    let mut args = cmdline.iter().skip(1);
    while let Some(arg) = args.next() {
        if let Some(value) = arg.strip_prefix("--endpoint=") {
            return Some(value.to_owned());
        }
        if arg == "--endpoint" {
            return args.next().cloned();
        }
    }
    Some(crate::cli::DEFAULT_ENDPOINT.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, name: &str, args: &[&str]) -> ProcessInfo {
        ProcessInfo {
            pid,
            parent: None,
            name: name.to_owned(),
            cmdline: args.iter().map(|a| (*a).to_owned()).collect(),
        }
    }

    /// A process list that shrinks: each look at it drops the next group of pids.
    struct Fading(std::sync::Mutex<Vec<Vec<u32>>>);

    impl ProcessSource for Fading {
        fn snapshot(&self) -> Vec<ProcessInfo> {
            let mut looks = self.0.lock().unwrap();
            let alive = if looks.len() > 1 {
                looks.remove(0)
            } else {
                looks.first().cloned().unwrap_or_default()
            };
            alive
                .into_iter()
                .map(|pid| process(pid, "norend.exe", &["norend.exe", "--endpoint", "x"]))
                .collect()
        }
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn the_wait_goes_on_while_a_process_of_the_daemon_is_there_and_ends_when_it_is_gone() {
        // Looks: both alive, one alive, none (the third look and after).
        let source = Fading(std::sync::Mutex::new(vec![
            vec![5, 6, 99],
            vec![6, 99],
            vec![99],
        ]));
        let deadline = Instant::now() + Duration::from_secs(20);
        let gone = run(wait_until_gone("x", vec![5, 6], &source, deadline)).expect("they ended");
        assert_eq!(gone, vec![5, 6]);
        // Nothing to wait for is done at once, without a look.
        let never = Fading(std::sync::Mutex::new(vec![vec![1]]));
        assert_eq!(
            run(wait_until_gone("x", Vec::new(), &never, deadline)),
            Ok(Vec::new())
        );
    }

    #[test]
    fn an_ended_process_nobody_collected_and_a_reused_pid_are_not_the_daemon() {
        // pid 8 is a zombie (no command line left), pid 9 is now another program, pid 10 is another
        // daemon: none of them keeps the wait for the daemon "x" going.
        struct Leftovers;
        impl ProcessSource for Leftovers {
            fn snapshot(&self) -> Vec<ProcessInfo> {
                vec![
                    process(8, "norend", &[]),
                    process(9, "bash", &["bash", "-c", "sleep 1"]),
                    process(10, "norend", &["norend", "--endpoint", "other"]),
                ]
            }
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        let gone = run(wait_until_gone("x", vec![8, 9, 10], &Leftovers, deadline))
            .expect("none of them is the daemon");
        assert_eq!(gone, vec![8, 9, 10]);
    }

    #[test]
    fn a_process_that_stays_is_an_error_that_names_it_when_the_time_is_up() {
        let source = Fading(std::sync::Mutex::new(vec![vec![7]]));
        let deadline = Instant::now() + Duration::from_millis(200);
        let error = run(wait_until_gone("x", vec![7], &source, deadline)).expect_err("it stays");
        assert!(
            error.contains("[7]") && error.contains("still running"),
            "{error}"
        );
    }

    #[test]
    fn only_a_missing_endpoint_counts_as_nothing_running() {
        let missing = |kind| ClientError::Connect(io::Error::new(kind, "x"));
        assert!(is_absent(&missing(io::ErrorKind::NotFound)));
        assert!(is_absent(&missing(io::ErrorKind::ConnectionRefused)));
        assert!(!is_absent(&missing(io::ErrorKind::PermissionDenied)));
        assert!(!is_absent(&ClientError::Closed));
        assert!(!is_absent(&ClientError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            "x"
        ))));
    }

    #[test]
    fn the_endpoint_a_command_line_runs_is_read_in_both_spellings() {
        let line =
            |args: &[&str]| -> Vec<String> { args.iter().map(|a| (*a).to_owned()).collect() };
        assert_eq!(
            endpoint_of(&line(&["norend.exe", "--endpoint", "work"])),
            Some("work".into())
        );
        assert_eq!(
            endpoint_of(&line(&[
                "norend.exe",
                "--endpoint=work",
                "--buffer-bytes",
                "9"
            ])),
            Some("work".into())
        );
        // No option: the default daemon.
        assert_eq!(endpoint_of(&line(&["norend.exe"])), Some("default".into()));
        assert_eq!(
            endpoint_of(&line(&["norend.exe", "--buffer-bytes", "9"])),
            Some("default".into())
        );
        // The system would not say, or the value is missing: unknown.
        assert_eq!(endpoint_of(&[]), None);
        assert_eq!(endpoint_of(&line(&["norend.exe", "--endpoint"])), None);
    }

    #[test]
    fn the_daemons_of_a_name_are_found_by_program_and_endpoint_and_nothing_else() {
        let all = vec![
            process(
                10,
                "norend.exe",
                &["C:\\App\\norend.exe", "--endpoint", "default"],
            ),
            process(11, "NOREND.EXE", &["norend.exe"]),
            process(12, "norend", &["/usr/bin/norend", "--endpoint=default"]),
            // Another daemon, another endpoint.
            process(13, "norend.exe", &["norend.exe", "--endpoint", "work"]),
            // Another program with a name that has norend in it.
            process(
                14,
                "norend-helper.exe",
                &["norend-helper.exe", "--endpoint", "default"],
            ),
            // A `--stop`, which is this program or one like it, not a daemon.
            process(15, "norend.exe", &["norend.exe", "--stop"]),
            // This very process.
            process(16, "norend.exe", &["norend.exe", "--endpoint", "default"]),
            // The system would not say what it runs.
            process(17, "norend.exe", &[]),
            // A shell that mentions it.
            process(
                18,
                "cmd.exe",
                &["cmd.exe", "/k", "norend.exe", "--endpoint", "default"],
            ),
        ];
        assert_eq!(daemons_of("default", &all, 16), vec![10, 11, 12]);
        assert_eq!(daemons_of("work", &all, 16), vec![13]);
        assert_eq!(daemons_of("elsewhere", &all, 16), Vec::<u32>::new());
    }
}

//! The running containers of the machine, for the live group of containers. No Tauri dependency.
//!
//! [`parse_container_names`] is a pure function over what `docker ps --format {{.Names}}` prints;
//! [`DockerCli`] runs the program and hands its output to it. A name is kept only when it is safe to
//! type into a shell as `docker exec -it <name> sh` ([`is_safe_container_name`]): the characters
//! Docker itself allows in a name (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`), at most 255 of them. Empty lines
//! and repeated names are left out.
//!
//! The program is run the way `nvidia-smi` is in `hardware.rs`: no input, no console window on
//! Windows, a limit on how much of its output is read and a deadline after which it is killed. The
//! program can be swapped ([`DockerCli::with_program`]) so a test points it at a name that does not
//! exist; the tests never run the real `docker`. Three problems are told apart ([`DockerError`]): the
//! program is not there, it ended with a failure (with a short form of what it printed on its error
//! output), and it did not answer in time.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The longest container name kept.
pub const MAX_CONTAINER_NAME_CHARS: usize = 255;

/// How long `docker ps` may take before it is killed. A daemon that is down answers with an error
/// at once; one that hangs must not hang the group that asked.
pub const DOCKER_TIMEOUT: Duration = Duration::from_secs(5);

/// Most bytes read from the standard output of the program (a name is at most 255 bytes).
pub const MAX_DOCKER_OUTPUT_BYTES: u64 = 1024 * 1024;

/// Most bytes read from the error output, and most characters of it put in the error sentence.
const MAX_STDERR_BYTES: u64 = 4096;
const MAX_STDERR_SUMMARY_CHARS: usize = 200;

/// Why the containers could not be listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DockerError {
    /// The program is not there (Docker is not installed, or not on the `PATH`).
    NotFound,
    /// The program could not be started for another reason, or it ended with a failure; carries a
    /// short form of what it said.
    Failed(String),
    /// The program did not end within the deadline and was killed.
    TimedOut,
}

impl fmt::Display for DockerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DockerError::NotFound => write!(f, "docker not found"),
            DockerError::Failed(reason) if reason.is_empty() => write!(f, "docker ps failed"),
            DockerError::Failed(reason) => write!(f, "docker ps failed: {reason}"),
            DockerError::TimedOut => write!(f, "docker ps took too long"),
        }
    }
}

impl std::error::Error for DockerError {}

/// Whether `name` may be typed into a shell as the argument of `docker exec -it`: it starts with a
/// letter or a digit and goes on with letters, digits, `_`, `.` and `-`; not empty, at most
/// [`MAX_CONTAINER_NAME_CHARS`] characters.
pub fn is_safe_container_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().count() <= MAX_CONTAINER_NAME_CHARS
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// The container names in what `docker ps --format {{.Names}}` printed: one per line, in order, each
/// once. Empty lines, names that are not safe to type ([`is_safe_container_name`]) and repeated names
/// are left out.
pub fn parse_container_names(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for line in text.lines() {
        let name = line.trim();
        if is_safe_container_name(name) && !names.iter().any(|known| known == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// A short form of what a program printed on its error output: the first line that has something
/// in it, trimmed, cut to [`MAX_STDERR_SUMMARY_CHARS`] characters.
fn summarize_stderr(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    line.chars().take(MAX_STDERR_SUMMARY_CHARS).collect()
}

/// What `docker` is run as.
#[derive(Debug, Clone)]
pub struct DockerCli {
    program: OsString,
    timeout: Duration,
}

impl Default for DockerCli {
    fn default() -> Self {
        Self::system()
    }
}

impl DockerCli {
    /// The `docker` found on the `PATH`.
    pub fn system() -> Self {
        Self::with_program("docker")
    }

    /// Another program in place of `docker` (a test points it at a name that does not exist).
    pub fn with_program(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            timeout: DOCKER_TIMEOUT,
        }
    }

    /// Another deadline in place of [`DOCKER_TIMEOUT`].
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The names of the running containers, in the order `docker ps` gives them.
    pub fn running_containers(&self) -> Result<Vec<String>, DockerError> {
        let output = run_capped(
            &self.program,
            &["ps", "--format", "{{.Names}}"],
            self.timeout,
        )?;
        Ok(parse_container_names(&output))
    }
}

/// The names of the running containers, with the `docker` of the system.
pub fn list_running_containers() -> Result<Vec<String>, DockerError> {
    DockerCli::system().running_containers()
}

/// Reads up to `limit` bytes of `reader` on a thread of its own, so a program that fills the pipe
/// and waits cannot hold the caller: the deadline kills it either way. The text is cut at its last
/// whole line when the limit was reached.
fn read_capped<R: Read + Send + 'static>(reader: R, limit: u64) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.take(limit + 1).read_to_end(&mut bytes);
        if bytes.len() as u64 > limit {
            bytes.truncate(limit as usize);
            match bytes.iter().rposition(|&b| b == b'\n') {
                Some(end) => bytes.truncate(end + 1),
                None => bytes.clear(),
            }
        }
        let _ = sender.send(bytes);
    });
    receiver
}

/// Runs `program` with `args` and returns what it printed on its standard output, as text, when it
/// ended with success within `timeout`.
///
/// The program gets no input. On Windows it starts with no console window. At most
/// [`MAX_DOCKER_OUTPUT_BYTES`] of the output are read.
fn run_capped(program: &OsStr, args: &[&str], timeout: Duration) -> Result<String, DockerError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW`: `docker.exe` is a console program, and one started by a program
        /// with a window would open a console window unless told not to.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            DockerError::NotFound
        } else {
            DockerError::Failed(summarize_stderr(&e.to_string()))
        }
    })?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(DockerError::Failed(String::new()));
    };
    let out = read_capped(stdout, MAX_DOCKER_OUTPUT_BYTES);
    let err = read_capped(stderr, MAX_STDERR_BYTES);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(DockerError::TimedOut);
    };
    let left = deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(100));
    if !status.success() {
        let said = err.recv_timeout(left).unwrap_or_default();
        return Err(DockerError::Failed(summarize_stderr(
            &String::from_utf8_lossy(&said),
        )));
    }
    let bytes = out.recv_timeout(left).map_err(|_| DockerError::TimedOut)?;
    String::from_utf8(bytes).map_err(|_| DockerError::Failed("output is not text".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_name_per_line() {
        assert_eq!(
            parse_container_names("web\ndb-1\nredis_cache\napi.v2\n"),
            ["web", "db-1", "redis_cache", "api.v2"]
        );
    }

    #[test]
    fn reads_windows_line_ends() {
        assert_eq!(parse_container_names("web\r\ndb\r\n"), ["web", "db"]);
    }

    #[test]
    fn no_container_is_an_empty_list() {
        assert!(parse_container_names("").is_empty());
        assert!(parse_container_names("\n\n  \n").is_empty());
    }

    #[test]
    fn leaves_out_empty_lines_and_repeated_names() {
        assert_eq!(
            parse_container_names("a\n\nb\na\n  \nb\nc\n"),
            ["a", "b", "c"]
        );
    }

    #[test]
    fn leaves_out_names_that_are_not_safe_to_type() {
        let text =
            "ok\na;rm -rf x\n$(id)\nweb *\n-oProxyCommand=x\n_hidden\n.dot\nq'q\n`x`\nfine-2\n";
        assert_eq!(parse_container_names(text), ["ok", "fine-2"]);
    }

    #[test]
    fn a_name_starts_with_a_letter_or_a_digit() {
        assert!(is_safe_container_name("a"));
        assert!(is_safe_container_name("7up"));
        assert!(is_safe_container_name("A_b.c-d"));
        assert!(!is_safe_container_name(""));
        assert!(!is_safe_container_name("-v"));
        assert!(!is_safe_container_name("_x"));
        assert!(!is_safe_container_name(".x"));
        assert!(!is_safe_container_name("a b"));
        assert!(!is_safe_container_name("a/b"));
        assert!(!is_safe_container_name("a:b"));
        assert!(!is_safe_container_name("caf\u{e9}"));
    }

    #[test]
    fn a_name_has_at_most_255_characters() {
        assert!(is_safe_container_name(&"a".repeat(255)));
        assert!(!is_safe_container_name(&"a".repeat(256)));
    }

    #[test]
    fn a_missing_program_is_docker_not_found() {
        let cli = DockerCli::with_program("noren-no-such-docker-program");
        let error = cli.running_containers().unwrap_err();
        assert_eq!(error, DockerError::NotFound);
        assert_eq!(error.to_string(), "docker not found");
    }

    #[test]
    fn the_error_sentences_tell_the_problems_apart() {
        assert_eq!(
            DockerError::Failed("Cannot connect to the Docker daemon".into()).to_string(),
            "docker ps failed: Cannot connect to the Docker daemon"
        );
        assert_eq!(
            DockerError::Failed(String::new()).to_string(),
            "docker ps failed"
        );
        assert_eq!(DockerError::TimedOut.to_string(), "docker ps took too long");
    }

    #[test]
    fn the_error_text_is_the_first_line_and_short() {
        assert_eq!(summarize_stderr("\n  boom  \nsecond\n"), "boom");
        assert_eq!(summarize_stderr(""), "");
        assert_eq!(summarize_stderr(&"x".repeat(500)).chars().count(), 200);
    }

    /// The test program itself in place of `docker`: given `ps --format {{.Names}}` it refuses the
    /// arguments, ends with a failure and says why on its error output. It is never the real docker.
    fn the_test_program() -> DockerCli {
        DockerCli::with_program(std::env::current_exe().expect("the test program has a path"))
    }

    #[test]
    fn a_program_that_fails_is_an_error_with_what_it_said() {
        let error = the_test_program().running_containers().unwrap_err();
        let DockerError::Failed(reason) = &error else {
            panic!("expected a failure, got {error:?}");
        };
        assert!(!reason.is_empty(), "the reason carries the error output");
        assert!(reason.chars().count() <= 200);
        assert!(!reason.contains('\n'));
        assert!(error.to_string().starts_with("docker ps failed: "));
    }

    #[test]
    fn a_program_that_is_too_slow_is_killed_and_reported() {
        let error = the_test_program()
            .with_timeout(Duration::ZERO)
            .running_containers()
            .unwrap_err();
        assert_eq!(error, DockerError::TimedOut);
    }
}

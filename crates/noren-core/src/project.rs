//! The real side of project actions, without any Tauri dependency: reading the
//! `.noren/actions.json` of a folder and running a command in a short process with no terminal.
//!
//! The file is read as text and never parsed here: the interface owns the schema. The short
//! process runs through the system shell (`cmd /S /C` on Windows, `sh -c` elsewhere) with its
//! standard streams closed, and is killed, with the processes it started, when it outlives the
//! timeout.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Where the actions file lives, relative to a project folder.
pub const ACTIONS_FILE_PATH: &str = ".noren/actions.json";

/// How often a running short process is checked for its end.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Reads `folder/.noren/actions.json` as text. `None` when the file (or the folder, or the
/// `.noren` folder) does not exist; any other failure (a folder where the file should be, no
/// permission) is an error. Bytes that are not valid UTF-8 are replaced, so the interface still
/// gets text and reports the file as invalid instead of failing the read.
pub fn read_project_file(folder: &Path) -> io::Result<Option<String>> {
    match fs::read(folder.join(ACTIONS_FILE_PATH)) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Errors returned by [`run_short`].
#[derive(Debug)]
pub enum ShortRunError {
    /// The working directory is not an existing folder.
    BadCwd(PathBuf),
    /// The command is empty or holds a NUL character.
    BadCommand,
    /// The shell could not be started.
    Spawn(io::Error),
    /// The process outlived the timeout and was killed.
    TimedOut(Duration),
}

impl fmt::Display for ShortRunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadCwd(path) => write!(
                f,
                "working directory '{}' does not exist or is not a folder",
                path.display()
            ),
            Self::BadCommand => write!(f, "the command is empty or holds a NUL character"),
            Self::Spawn(error) => write!(f, "could not start the command: {error}"),
            Self::TimedOut(timeout) => write!(
                f,
                "the command did not end in {} seconds and was stopped",
                timeout.as_secs()
            ),
        }
    }
}

impl std::error::Error for ShortRunError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Spawn(error) => Some(error),
            _ => None,
        }
    }
}

/// Runs `command` through the system shell in `cwd` and waits for it, up to `timeout`.
///
/// Returns the exit code (`-1` when the process was ended by a signal and has none). Nothing is
/// read from the process and nothing is shown: stdin, stdout and stderr go to the null device and
/// no window opens on Windows. On timeout the process and everything it started are killed.
pub fn run_short(cwd: &Path, command: &str, timeout: Duration) -> Result<i32, ShortRunError> {
    if command.trim().is_empty() || command.contains('\0') {
        return Err(ShortRunError::BadCommand);
    }
    if !cwd.is_dir() {
        return Err(ShortRunError::BadCwd(cwd.to_owned()));
    }
    let mut child = shell_command(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(ShortRunError::Spawn)?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(-1)),
            Ok(None) if Instant::now() >= deadline => {
                kill_tree(&mut child);
                return Err(ShortRunError::TimedOut(timeout));
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(error) => {
                kill_tree(&mut child);
                return Err(ShortRunError::Spawn(error));
            }
        }
    }
}

#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut shell = Command::new("cmd");
    // `/S` makes cmd strip exactly the outer quotes, so quotes inside `command` survive, and
    // `raw_arg` keeps Rust from escaping them a second time.
    shell
        .raw_arg("/S")
        .raw_arg("/C")
        .raw_arg(format!("\"{command}\""))
        .creation_flags(CREATE_NO_WINDOW);
    shell
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    use std::os::unix::process::CommandExt;

    let mut shell = Command::new("sh");
    // Its own process group, so a timeout can end the shell and what it started together.
    shell.arg("-c").arg(command).process_group(0);
    shell
}

#[cfg(windows)]
fn kill_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `taskkill /T` walks the children of the shell, which `Child::kill` does not.
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(windows))]
fn kill_tree(child: &mut Child) {
    // A negative pid addresses the whole process group created in `shell_command`.
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A fresh folder in the temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("noren-project-test-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const SECONDS_10: Duration = Duration::from_secs(10);

    #[test]
    fn reads_the_file_of_the_folder() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.path().join(".noren")).unwrap();
        fs::write(dir.path().join(ACTIONS_FILE_PATH), "{\"actions\": []}\n").unwrap();
        let text = read_project_file(dir.path()).expect("readable");
        assert_eq!(text.as_deref(), Some("{\"actions\": []}\n"));
    }

    #[test]
    fn keeps_a_byte_order_mark_and_replaces_invalid_utf8() {
        let dir = TempDir::new();
        fs::create_dir_all(dir.path().join(".noren")).unwrap();
        fs::write(dir.path().join(ACTIONS_FILE_PATH), b"\xef\xbb\xbf{\xff}").unwrap();
        let text = read_project_file(dir.path()).unwrap().expect("file exists");
        assert_eq!(text, "\u{feff}{\u{fffd}}");
    }

    #[test]
    fn a_missing_file_is_none() {
        let dir = TempDir::new();
        assert_eq!(read_project_file(dir.path()).unwrap(), None);
        fs::create_dir_all(dir.path().join(".noren")).unwrap();
        assert_eq!(read_project_file(dir.path()).unwrap(), None);
    }

    #[test]
    fn a_missing_folder_is_none() {
        let dir = TempDir::new();
        let missing = dir.path().join("no-such-folder");
        assert_eq!(read_project_file(&missing).unwrap(), None);
    }

    #[test]
    fn an_unreadable_path_is_an_error() {
        // A folder where the file should be cannot be read as a file, on every platform.
        let dir = TempDir::new();
        fs::create_dir_all(dir.path().join(ACTIONS_FILE_PATH)).unwrap();
        assert!(read_project_file(dir.path()).is_err());
    }

    #[test]
    fn exit_zero_is_code_zero() {
        let dir = TempDir::new();
        assert_eq!(run_short(dir.path(), "exit 0", SECONDS_10).unwrap(), 0);
    }

    #[test]
    fn a_nonzero_code_is_returned() {
        let dir = TempDir::new();
        assert_eq!(run_short(dir.path(), "exit 3", SECONDS_10).unwrap(), 3);
    }

    #[test]
    fn a_missing_program_is_a_nonzero_code() {
        let dir = TempDir::new();
        let code = run_short(dir.path(), "noren-no-such-program-4c1d", SECONDS_10).unwrap();
        assert_ne!(code, 0);
    }

    #[test]
    fn the_command_runs_in_the_given_folder() {
        let dir = TempDir::new();
        let code = run_short(dir.path(), "echo here > marker.txt", SECONDS_10).unwrap();
        assert_eq!(code, 0);
        assert!(dir.path().join("marker.txt").is_file());
    }

    #[test]
    fn quotes_inside_the_command_survive() {
        let dir = TempDir::new();
        let code = run_short(dir.path(), "echo \"a b\" > \"two words.txt\"", SECONDS_10).unwrap();
        assert_eq!(code, 0);
        assert!(dir.path().join("two words.txt").is_file());
    }

    #[test]
    fn a_command_that_outlives_the_timeout_is_killed() {
        let dir = TempDir::new();
        let long = if cfg!(windows) {
            "ping -n 60 127.0.0.1 > nul"
        } else {
            "sleep 60"
        };
        let started = Instant::now();
        let error = run_short(dir.path(), long, Duration::from_millis(300)).expect_err("timeout");
        assert!(matches!(error, ShortRunError::TimedOut(_)), "{error}");
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn a_missing_folder_is_refused_before_starting() {
        let dir = TempDir::new();
        let missing = dir.path().join("no-such-folder");
        let error = run_short(&missing, "exit 0", SECONDS_10).expect_err("bad cwd");
        assert!(matches!(error, ShortRunError::BadCwd(_)), "{error}");
        assert!(error.to_string().contains("no-such-folder"));
    }

    #[test]
    fn an_empty_command_is_refused() {
        let dir = TempDir::new();
        for command in ["", "   ", "a\0b"] {
            let error = run_short(dir.path(), command, SECONDS_10).expect_err("bad command");
            assert!(matches!(error, ShortRunError::BadCommand), "{command:?}");
        }
    }
}

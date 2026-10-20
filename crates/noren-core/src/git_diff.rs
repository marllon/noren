//! The git diff of a folder for a diff pane, through the `git` of the system, without any Tauri
//! dependency: what the working tree and the index hold against `HEAD`, as the text `git diff`
//! prints (the interface reads it with `parseGitDiff` of `@noren/model`), or the reason there is
//! none.
//!
//! The pane runs this on a folder it restored from `state.json` and on a repository nobody
//! looked at, so the command is held to what a read needs:
//!
//! - **The folder.** It must be a full local path of a folder that exists (the same rules as the
//!   path of a preview: [`path_refusal`]). Git is started in it with separate arguments, never
//!   through a shell.
//! - **Only reads.** The pane never writes `.git/index`: the commands are `rev-parse`,
//!   `hash-object` and `diff`, none of which refresh the index on disk (`git status` does), and
//!   `GIT_OPTIONAL_LOCKS=0` keeps git from taking the optional lock a refresh would need.
//! - **Nothing from the repository runs.** `--no-ext-diff` and `--no-textconv` keep the programs a
//!   repository's attributes and settings name from running, and `core.fsmonitor=false` keeps its
//!   file-system monitor hook from running. A cloned repository is not trusted with that.
//! - **The same text everywhere.** `--no-color`, `core.quotePath=false` (names come as UTF-8, not
//!   as octal), `-M` (renames are found whatever `diff.renames` says), and `--src-prefix=a/
//!   --dst-prefix=b/` (whatever `diff.noprefix` or `diff.mnemonicPrefix` say) give the parser one
//!   shape to read. `LC_ALL=C` makes what git says about a refusal English.
//! - **A repository with no commit** is diffed against the empty tree, so what is staged shows as
//!   added.
//! - **A cap.** At most [`MAX_GIT_DIFF_BYTES`] are read: one byte more and git is stopped.
//!
//! A refusal is an answer, not an error: the pane tells the person why.

use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;

use crate::preview::{PreviewRefusal, path_refusal};
use crate::worktree::GitCli;

/// The most diff text read (2 MiB).
pub const MAX_GIT_DIFF_BYTES: usize = 2 * 1024 * 1024;

/// The longest message of git kept for a refusal.
const MAX_DETAIL_CHARS: usize = 500;

/// The most of the error stream of git that is kept (the rest is read and dropped).
const MAX_STDERR_BYTES: u64 = 64 * 1024;

/// The most a short question to git (is this a repository? is there a commit?) may answer.
const MAX_ANSWER_BYTES: usize = 64 * 1024;

/// The empty tree of a SHA-1 repository, for the unlikely day `git hash-object` cannot say it.
const SHA1_EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Why a diff is not shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitDiffRefusal {
    /// The folder is not a full path of this computer.
    Relative,
    /// The folder is a network or device path.
    Network,
    /// The folder is empty, too long or has a control character.
    InvalidPath,
    /// Nothing is at the folder, or it is not a folder.
    Missing,
    /// The folder is in no git repository.
    NotARepository,
    /// `git` could not be started: it is not installed or not on the `PATH` (what the system said).
    GitMissing(String),
    /// The diff is longer than [`MAX_GIT_DIFF_BYTES`].
    TooLarge,
    /// Git ran and refused, or the read failed: what it said.
    Failed(String),
}

impl GitDiffRefusal {
    /// The word the interface uses for the reason (`GIT_DIFF_REFUSALS` of `@noren/model`).
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Relative => "relative",
            Self::Network => "network",
            Self::InvalidPath => "invalid",
            Self::Missing => "missing",
            Self::NotARepository => "not-a-repository",
            Self::GitMissing(_) => "git-missing",
            Self::TooLarge => "too-large",
            Self::Failed(_) => "failed",
        }
    }
}

/// What reading the diff of a folder gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitDiff {
    /// The text of `git diff`, empty when nothing changed.
    Text(String),
    /// The diff is not shown.
    Refused(GitDiffRefusal),
}

impl GitDiff {
    /// The answer as the page reads it (`decodeGitDiff` of `@noren/model`): `{"kind":"diff",
    /// "text":...}`, or `{"kind":"refused","reason":...}` with `"detail"` for a refusal that has
    /// something to say.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Text(text) => serde_json::json!({ "kind": "diff", "text": text }),
            Self::Refused(refusal) => {
                let mut answer =
                    serde_json::json!({ "kind": "refused", "reason": refusal.reason() });
                if let GitDiffRefusal::GitMissing(detail) | GitDiffRefusal::Failed(detail) = refusal
                {
                    answer["detail"] = detail
                        .chars()
                        .take(MAX_DETAIL_CHARS)
                        .collect::<String>()
                        .into();
                }
                answer
            }
        }
    }
}

fn refuse(refusal: GitDiffRefusal) -> GitDiff {
    GitDiff::Refused(refusal)
}

/// What a command that ran to the end printed.
struct Finished {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: String,
}

/// How a command that read at most `cap` bytes of output ended.
enum Capped {
    Finished(Finished),
    /// The output went past the cap and the command was stopped.
    TooLarge,
}

/// Why a command did not end with an output to look at.
enum RunError {
    /// The program could not be started.
    Spawn(io::Error),
    /// It started, and reading it or waiting for it failed.
    Read(io::Error),
}

impl RunError {
    fn into_refusal(self) -> GitDiffRefusal {
        match self {
            Self::Spawn(error) => GitDiffRefusal::GitMissing(error.to_string()),
            Self::Read(error) => GitDiffRefusal::Failed(error.to_string()),
        }
    }
}

/// Runs `command` and reads at most `cap` bytes of its output; one byte more and it is killed.
/// The error stream is read on a thread (so a full pipe never stops the command) and kept to
/// [`MAX_STDERR_BYTES`].
fn run_capped(mut command: Command, cap: usize) -> Result<Capped, RunError> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunError::Spawn)?;
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(RunError::Read(io::Error::other(
            "the output of git could not be read",
        )));
    };
    let errors = thread::spawn(move || {
        let mut kept = Vec::new();
        let _ = (&mut stderr).take(MAX_STDERR_BYTES).read_to_end(&mut kept);
        let _ = io::copy(&mut stderr, &mut io::sink());
        String::from_utf8_lossy(&kept).into_owned()
    });
    let mut out = Vec::new();
    let read = (&mut stdout).take(cap as u64 + 1).read_to_end(&mut out);
    if read.is_err() || out.len() > cap {
        let _ = child.kill();
        let _ = child.wait();
        drop(stdout);
        let _ = errors.join();
        return match read {
            Err(error) => Err(RunError::Read(error)),
            Ok(_) => Ok(Capped::TooLarge),
        };
    }
    let status = child.wait().map_err(RunError::Read)?;
    let stderr = errors.join().unwrap_or_default();
    Ok(Capped::Finished(Finished {
        status,
        stdout: out,
        stderr,
    }))
}

/// What git printed to say why it refused: the error stream, else the output, else the exit code.
fn failure_text(finished: &Finished) -> String {
    let stderr = finished.stderr.trim();
    let stdout = String::from_utf8_lossy(&finished.stdout);
    let text = if stderr.is_empty() {
        stdout.trim()
    } else {
        stderr
    };
    if text.is_empty() {
        format!("git exited with {}", finished.status)
    } else {
        text.to_owned()
    }
}

impl GitCli {
    /// A command of the diff: the settings and the environment that make it a read of one shape.
    fn diff_command<I, S>(&self, folder: &Path, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut command = self.command(folder, args);
        command.env("GIT_OPTIONAL_LOCKS", "0").env("LC_ALL", "C");
        command
    }

    /// Runs a short git command (a question with a short answer) and returns what it printed.
    fn ask<I, S>(&self, folder: &Path, args: I) -> Result<Finished, GitDiffRefusal>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        match run_capped(self.diff_command(folder, args), MAX_ANSWER_BYTES) {
            Ok(Capped::Finished(finished)) => Ok(finished),
            Ok(Capped::TooLarge) => Err(GitDiffRefusal::Failed(
                "git printed more than a question needs".to_owned(),
            )),
            Err(error) => Err(error.into_refusal()),
        }
    }

    /// The tree to diff against: `HEAD`, or the empty tree of the repository when `HEAD` has no
    /// commit yet.
    fn diff_base(&self, folder: &Path) -> Result<String, GitDiffRefusal> {
        let head = self.ask(
            folder,
            ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        )?;
        if head.status.success() {
            return Ok("HEAD".to_owned());
        }
        // The empty tree has another name in a repository that hashes with SHA-256: ask git.
        let empty = self.ask(folder, ["hash-object", "-t", "tree", "--stdin"])?;
        let name = String::from_utf8_lossy(&empty.stdout).trim().to_owned();
        if empty.status.success() && !name.is_empty() {
            Ok(name)
        } else {
            Ok(SHA1_EMPTY_TREE.to_owned())
        }
    }

    /// The diff of the working tree and the index of the repository `folder` is in against `HEAD`
    /// (against the empty tree when the repository has no commit). See the top of this file for
    /// what is read, what is refused and what git is kept from doing.
    pub fn diff(&self, folder: &str) -> GitDiff {
        if let Some(refusal) = path_refusal(folder) {
            return refuse(match refusal {
                PreviewRefusal::Relative => GitDiffRefusal::Relative,
                PreviewRefusal::Network => GitDiffRefusal::Network,
                _ => GitDiffRefusal::InvalidPath,
            });
        }
        let dir = Path::new(folder);
        match fs::metadata(dir) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return refuse(GitDiffRefusal::Missing),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                return refuse(GitDiffRefusal::Missing);
            }
            Err(error) => return refuse(GitDiffRefusal::Failed(error.to_string())),
        }
        match self.read_diff(dir) {
            Ok(text) => GitDiff::Text(text),
            Err(refusal) => refuse(refusal),
        }
    }

    fn read_diff(&self, dir: &Path) -> Result<String, GitDiffRefusal> {
        let inside = self.ask(dir, ["rev-parse", "--is-inside-work-tree"])?;
        if !inside.status.success() {
            let text = failure_text(&inside);
            // A repository owned by someone else is a repository git will not work in.
            return Err(if text.contains("dubious ownership") {
                GitDiffRefusal::Failed(text)
            } else {
                GitDiffRefusal::NotARepository
            });
        }
        if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
            return Err(GitDiffRefusal::Failed(
                "this folder is inside the .git folder or is a bare repository, so it has no working tree"
                    .to_owned(),
            ));
        }
        let base = self.diff_base(dir)?;
        let command = self.diff_command(
            dir,
            [
                "-c",
                "core.quotePath=false",
                "-c",
                "core.fsmonitor=false",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "-M",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                &base,
                "--",
            ],
        );
        match run_capped(command, MAX_GIT_DIFF_BYTES) {
            Ok(Capped::TooLarge) => Err(GitDiffRefusal::TooLarge),
            Ok(Capped::Finished(finished)) if finished.status.success() => {
                Ok(String::from_utf8_lossy(&finished.stdout).into_owned())
            }
            Ok(Capped::Finished(finished)) => Err(GitDiffRefusal::Failed(failure_text(&finished))),
            Err(error) => Err(error.into_refusal()),
        }
    }
}

/// The diff of the repository the folder `folder` is in, with the `git` of the system.
pub fn read_git_diff(folder: &str) -> GitDiff {
    GitCli::system().diff(folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason_of(diff: &GitDiff) -> &'static str {
        match diff {
            GitDiff::Refused(refusal) => refusal.reason(),
            GitDiff::Text(_) => "text",
        }
    }

    #[test]
    fn a_folder_that_is_not_a_full_local_path_is_refused_before_git_is_started() {
        // A program that does not exist: any refusal other than these would be `git-missing`.
        let cli = GitCli::with_program("noren-no-such-git-program");
        for (folder, reason) in [
            ("repo", "relative"),
            ("./repo", "relative"),
            ("C:repo", "relative"),
            ("\\\\server\\share\\repo", "network"),
            ("//server/share/repo", "network"),
            ("", "invalid"),
            ("   ", "invalid"),
            ("/tmp/a\u{0}b", "invalid"),
        ] {
            assert_eq!(reason_of(&cli.diff(folder)), reason, "{folder:?}");
        }
        let long = format!("/{}", "a".repeat(5000));
        assert_eq!(reason_of(&cli.diff(&long)), "invalid");
    }

    #[test]
    fn a_folder_that_is_not_there_is_missing_before_git_is_started() {
        let cli = GitCli::with_program("noren-no-such-git-program");
        let nowhere = std::env::temp_dir().join(format!("noren-diff-none-{}", std::process::id()));
        assert_eq!(
            cli.diff(&nowhere.display().to_string()),
            GitDiff::Refused(GitDiffRefusal::Missing)
        );
        // A file is not a folder.
        let file = std::env::temp_dir().join(format!("noren-diff-file-{}", std::process::id()));
        fs::write(&file, "x").expect("write a file");
        let answer = cli.diff(&file.display().to_string());
        let _ = fs::remove_file(&file);
        assert_eq!(answer, GitDiff::Refused(GitDiffRefusal::Missing));
    }

    #[test]
    fn without_git_the_answer_says_so() {
        let cli = GitCli::with_program("noren-no-such-git-program");
        let answer = cli.diff(&std::env::temp_dir().display().to_string());
        assert_eq!(reason_of(&answer), "git-missing");
        assert_eq!(answer.to_json()["reason"], "git-missing");
        assert!(answer.to_json()["detail"].is_string());
    }

    #[test]
    fn the_answer_is_json_the_page_can_read() {
        assert_eq!(
            GitDiff::Text("diff --git a/x b/x\n".to_owned()).to_json(),
            serde_json::json!({ "kind": "diff", "text": "diff --git a/x b/x\n" })
        );
        assert_eq!(
            GitDiff::Refused(GitDiffRefusal::NotARepository).to_json(),
            serde_json::json!({ "kind": "refused", "reason": "not-a-repository" })
        );
        let failed = GitDiff::Refused(GitDiffRefusal::Failed("x".repeat(900))).to_json();
        assert_eq!(failed["reason"], "failed");
        assert_eq!(
            failed["detail"].as_str().map(|d| d.chars().count()),
            Some(500)
        );
        for refusal in [
            GitDiffRefusal::Relative,
            GitDiffRefusal::Network,
            GitDiffRefusal::InvalidPath,
            GitDiffRefusal::Missing,
            GitDiffRefusal::TooLarge,
        ] {
            assert!(
                GitDiff::Refused(refusal).to_json().get("detail").is_none(),
                "only a refusal with something to say has a detail"
            );
        }
    }
}

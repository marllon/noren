//! Git worktrees through the `git` of the system: list the worktrees of a repository, add one next
//! to it on a branch, and remove one. No Tauri dependency.
//!
//! `git` is started with [`std::process::Command`] and separate arguments, never through a shell,
//! so a branch name is one argument whatever characters it holds. The branch is checked before any
//! command that changes something ([`validate_branch_name`] and then `git check-ref-format
//! --branch`). A removal never forces: a worktree with changes is refused with the words of git,
//! the branch is kept, and the main worktree cannot be removed. A missing `git` and a folder that
//! is in no repository give a sentence a person can read.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// One worktree of a repository, as `git worktree list --porcelain` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    /// The folder of the worktree, in the form git prints it (`/` as separator, also on Windows).
    pub path: String,
    /// The commit `HEAD` points at; `None` for a bare repository.
    pub head: Option<String>,
    /// The branch checked out, without `refs/heads/`; `None` when `HEAD` is detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    /// The folder is gone (git can clean the record with `worktree prune`).
    pub prunable: bool,
}

/// Parses the output of `git worktree list --porcelain`: blocks separated by a blank line, each
/// one starting with `worktree <path>` and followed by `HEAD <commit>`, `branch refs/heads/<name>`
/// or `detached`, `bare`, `locked [reason]` and `prunable [reason]`. A block without a `worktree`
/// line is ignored, and so is a line git may add in a later version.
pub fn parse_worktree_list(text: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut current: Option<Worktree> = None;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            list.extend(current.take());
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key == "worktree" {
            list.extend(current.take());
            current = Some(Worktree {
                path: value.to_owned(),
                head: None,
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" if !value.is_empty() => entry.head = Some(value.to_owned()),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_owned(),
                );
            }
            "detached" => entry.detached = true,
            "bare" => entry.bare = true,
            "locked" => entry.locked = true,
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    list.extend(current);
    list
}

/// Why a worktree could not be listed, added or removed.
#[derive(Debug)]
pub enum WorktreeError {
    /// `git` could not be started: it is not installed or not on the `PATH`.
    GitMissing(io::Error),
    /// The folder does not exist or is not a folder.
    NotAFolder(PathBuf),
    /// The folder is in no git repository.
    NotARepository(PathBuf),
    /// The branch name is empty.
    BranchEmpty,
    /// The branch name starts with `-`, which git would read as an option.
    BranchStartsWithDash,
    /// The branch name is not one git accepts (the reason is the sentence of git, or ours).
    BranchInvalid(String),
    /// The folder the worktree would be created in already exists.
    FolderExists(PathBuf),
    /// The path is not a worktree of the repository.
    NotAWorktree(String),
    /// The path is the main worktree, which is the repository itself and is never removed here.
    MainWorktree(String),
    /// `git` ran and refused; the message is what it printed.
    Git(String),
}

impl fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GitMissing(error) => write!(
                f,
                "git could not be started ({error}). Install git and make sure it is on the PATH."
            ),
            Self::NotAFolder(path) => {
                write!(f, "'{}' does not exist or is not a folder", path.display())
            }
            Self::NotARepository(path) => {
                write!(f, "'{}' is not inside a git repository", path.display())
            }
            Self::BranchEmpty => write!(f, "the branch name is empty"),
            Self::BranchStartsWithDash => {
                write!(f, "a branch name cannot start with '-'")
            }
            Self::BranchInvalid(reason) => write!(f, "'{reason}' is not a valid branch name"),
            Self::FolderExists(path) => write!(
                f,
                "the folder '{}' already exists, so the worktree was not created",
                path.display()
            ),
            Self::NotAWorktree(path) => {
                write!(f, "'{path}' is not a worktree of this repository")
            }
            Self::MainWorktree(path) => write!(
                f,
                "'{path}' is the main worktree of the repository and cannot be removed"
            ),
            Self::Git(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for WorktreeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::GitMissing(error) => Some(error),
            _ => None,
        }
    }
}

/// Checks a branch name for what needs no `git`: it is not blank, does not start with `-` and holds
/// no control character. The name is taken as typed: spaces around it are not trimmed (the caller
/// trims what a person typed). `git check-ref-format` has the last word, in [`GitCli::create`].
pub fn validate_branch_name(name: &str) -> Result<(), WorktreeError> {
    if name.trim().is_empty() {
        return Err(WorktreeError::BranchEmpty);
    }
    if name.starts_with('-') {
        return Err(WorktreeError::BranchStartsWithDash);
    }
    if name.chars().any(char::is_control) {
        return Err(WorktreeError::BranchInvalid(
            name.escape_debug().to_string(),
        ));
    }
    Ok(())
}

/// The name of the folder of a new worktree: the name of the repository, a dash and the branch
/// with every `/` turned into `-` (`noren` and `feature/login` give `noren-feature-login`). The
/// characters Windows does not allow in a file name (`\ : * ? " < > |`) are turned into `-` too.
pub fn worktree_folder_name(repo_name: &str, branch: &str) -> String {
    let branch: String = branch
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            other => other,
        })
        .collect();
    format!("{repo_name}-{branch}")
}

/// The path a worktree of `branch` gets: next to the main worktree `main` (same parent folder),
/// named by [`worktree_folder_name`]. `None` when `main` has no parent folder or no name.
pub fn worktree_destination(main: &Path, branch: &str) -> Option<PathBuf> {
    let parent = main.parent().filter(|p| !p.as_os_str().is_empty())?;
    let name = main.file_name()?.to_string_lossy();
    Some(parent.join(worktree_folder_name(&name, branch)))
}

/// Turns the path git prints (`D:/work/repo`) into the form of the system: the separator of
/// Windows there, no change elsewhere.
pub fn native_path(path: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.replace('/', "\\"))
    } else {
        PathBuf::from(path)
    }
}

/// Two paths name the same folder: the same text once the separators are alike and trailing ones
/// are gone; on Windows without the case too.
fn same_path(a: &str, b: &str) -> bool {
    fn key(path: &str) -> String {
        let slashed = path.replace('\\', "/");
        let trimmed = slashed.trim_end_matches('/');
        if cfg!(windows) {
            trimmed.to_lowercase()
        } else {
            trimmed.to_owned()
        }
    }
    key(a) == key(b)
}

/// The `git` of the system, or another program and environment for a test: the program is
/// replaceable so "git is not installed" can be tried, and the environment so a test gives git a
/// scratch home.
#[derive(Debug, Clone)]
pub struct GitCli {
    program: OsString,
    env: Vec<(OsString, OsString)>,
}

impl Default for GitCli {
    fn default() -> Self {
        Self::system()
    }
}

impl GitCli {
    /// The `git` found on the `PATH`.
    pub fn system() -> Self {
        Self::with_program("git")
    }

    /// Another program in place of `git` (a test points it at a name that does not exist).
    pub fn with_program(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            env: Vec::new(),
        }
    }

    /// Adds an environment variable to every command (a test: `HOME`, `GIT_CONFIG_GLOBAL`).
    #[must_use]
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Runs `git <args>` in `dir` and returns its output. The command has no terminal and asks for
    /// nothing (no prompt for a password), and on Windows opens no window.
    fn run<I, S>(&self, dir: &Path, args: I) -> Result<Output, WorktreeError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new(&self.program);
        command
            .args(args)
            .current_dir(dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null());
        for (key, value) in &self.env {
            command.env(key, value);
        }
        hide_window(&mut command);
        command.output().map_err(WorktreeError::GitMissing)
    }

    /// Runs `git <args>`, and turns a refusal into [`WorktreeError::Git`] with what git printed.
    fn run_ok<I, S>(&self, dir: &Path, args: I) -> Result<String, WorktreeError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.run(dir, args)?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            Err(WorktreeError::Git(failure_message(&output)))
        }
    }

    /// Checks that `folder` is a folder inside a git repository.
    fn check_repository(&self, folder: &Path) -> Result<(), WorktreeError> {
        if !folder.is_dir() {
            return Err(WorktreeError::NotAFolder(folder.to_owned()));
        }
        let output = self.run(folder, ["rev-parse", "--git-dir"])?;
        if output.status.success() {
            Ok(())
        } else {
            Err(WorktreeError::NotARepository(folder.to_owned()))
        }
    }

    /// The worktrees of the repository `folder` is in (the main one first), or an error when
    /// `folder` is in no repository.
    pub fn list(&self, folder: &Path) -> Result<Vec<Worktree>, WorktreeError> {
        self.check_repository(folder)?;
        let text = self.run_ok(folder, ["worktree", "list", "--porcelain"])?;
        Ok(parse_worktree_list(&text))
    }

    /// Adds a worktree for `branch` next to the main worktree of the repository `folder` is in,
    /// in `<parent>/<repository>-<branch with / as ->`, and returns it. The branch is created from
    /// the `HEAD` of `folder` when it does not exist, and used as it is when it does. Refuses a
    /// folder that exists, and a branch that git already has checked out in another worktree (git
    /// says so).
    pub fn create(&self, folder: &Path, branch: &str) -> Result<Worktree, WorktreeError> {
        validate_branch_name(branch)?;
        let list = self.list(folder)?;
        let main = list
            .first()
            .ok_or_else(|| WorktreeError::NotARepository(folder.to_owned()))?;
        self.check_branch_name(folder, branch)?;
        let destination = worktree_destination(&native_path(&main.path), branch)
            .ok_or_else(|| WorktreeError::NotAFolder(native_path(&main.path)))?;
        if destination.exists() {
            return Err(WorktreeError::FolderExists(destination));
        }
        let exists = self
            .run(
                folder,
                [
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}"),
                ],
            )?
            .status
            .success();
        let mut args: Vec<OsString> = vec!["worktree".into(), "add".into(), "--quiet".into()];
        if exists {
            args.push(destination.as_os_str().to_owned());
            args.push(branch.into());
        } else {
            args.extend([
                "-b".into(),
                branch.into(),
                destination.as_os_str().to_owned(),
            ]);
        }
        self.run_ok(folder, args)?;
        let created = destination.to_string_lossy().into_owned();
        self.list(folder)?
            .into_iter()
            .find(|worktree| same_path(&worktree.path, &created))
            .ok_or_else(|| {
                WorktreeError::Git(format!("git did not list the new worktree '{created}'"))
            })
    }

    /// `git check-ref-format --branch`: the name must be one git accepts as a branch, and must be
    /// printed back as it is (a name like `@{-1}` is expanded to another branch, so it is refused).
    fn check_branch_name(&self, folder: &Path, branch: &str) -> Result<(), WorktreeError> {
        let output = self.run(folder, ["check-ref-format", "--branch", branch])?;
        let printed = String::from_utf8_lossy(&output.stdout);
        if output.status.success() && printed.trim_end_matches(['\r', '\n']) == branch {
            Ok(())
        } else {
            Err(WorktreeError::BranchInvalid(branch.to_owned()))
        }
    }

    /// Removes the worktree at `worktree` from the repository `folder` is in, with
    /// `git worktree remove` and no `--force`: a worktree with changes (or untracked files, or
    /// locked) is refused with the message of git. The branch stays. The main worktree is never
    /// removed. Git runs in the main worktree, so it never stands in the folder it deletes.
    pub fn remove(&self, folder: &Path, worktree: &str) -> Result<(), WorktreeError> {
        let list = self.list(folder)?;
        let main = list
            .first()
            .ok_or_else(|| WorktreeError::NotARepository(folder.to_owned()))?;
        if same_path(&main.path, worktree) {
            return Err(WorktreeError::MainWorktree(worktree.to_owned()));
        }
        let target = list
            .iter()
            .find(|candidate| same_path(&candidate.path, worktree))
            .ok_or_else(|| WorktreeError::NotAWorktree(worktree.to_owned()))?;
        let main_dir = native_path(&main.path);
        let run_in = if main_dir.is_dir() {
            main_dir
        } else {
            folder.to_owned()
        };
        self.run_ok(
            &run_in,
            [
                OsStr::new("worktree"),
                OsStr::new("remove"),
                native_path(&target.path).as_os_str(),
            ],
        )?;
        Ok(())
    }
}

/// What git printed to say why it refused: the error stream, else the output, else the exit code.
fn failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let text = text.trim();
    if text.is_empty() {
        format!("git exited with {}", output.status)
    } else {
        text.to_owned()
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

/// The worktrees of the repository `folder` is in, with the `git` of the system.
pub fn list_worktrees(folder: &Path) -> Result<Vec<Worktree>, WorktreeError> {
    GitCli::system().list(folder)
}

/// Adds a worktree for `branch` next to the repository `folder` is in, with the `git` of the system.
pub fn create_worktree(folder: &Path, branch: &str) -> Result<Worktree, WorktreeError> {
    GitCli::system().create(folder, branch)
}

/// Removes the worktree at `worktree` (never forced), with the `git` of the system.
pub fn remove_worktree(folder: &Path, worktree: &str) -> Result<(), WorktreeError> {
    GitCli::system().remove(folder, worktree)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "worktree D:/work/repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree D:/work/repo-feature-login\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feature/login\nlocked in use\n\nworktree D:/work/repo-detached\nHEAD 3333333333333333333333333333333333333333\ndetached\nprunable gitdir file points to non-existent location\n\n";

    #[test]
    fn parses_branch_detached_locked_and_prunable_worktrees() {
        let list = parse_worktree_list(LIST);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].path, "D:/work/repo");
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(
            list[0].head.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert!(!list[0].detached && !list[0].locked && !list[0].prunable && !list[0].bare);
        // A branch with a slash keeps it; `locked` carries a reason after the word.
        assert_eq!(list[1].branch.as_deref(), Some("feature/login"));
        assert!(list[1].locked);
        assert_eq!(list[2].branch, None);
        assert!(list[2].detached && list[2].prunable);
    }

    #[test]
    fn parses_a_bare_repository_and_a_path_with_spaces() {
        let list = parse_worktree_list("worktree /srv/my repo.git\nbare\n\n");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/srv/my repo.git");
        assert!(list[0].bare);
        assert_eq!(list[0].head, None);
    }

    #[test]
    fn parses_without_a_trailing_blank_line_and_with_crlf() {
        let list = parse_worktree_list("worktree /a\r\nHEAD abc\r\nbranch refs/heads/x\r\n");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].path, "/a");
        assert_eq!(list[0].branch.as_deref(), Some("x"));
    }

    #[test]
    fn ignores_what_is_not_a_worktree_block() {
        assert!(parse_worktree_list("").is_empty());
        assert!(parse_worktree_list("\n\n").is_empty());
        // A line before any `worktree` line, and a key git may add later, are skipped.
        let list =
            parse_worktree_list("HEAD abc\nworktree /a\nfuture thing\nbranch refs/heads/b\n");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].branch.as_deref(), Some("b"));
    }

    #[test]
    fn a_branch_must_not_be_empty_dashed_or_hold_control_characters() {
        assert!(validate_branch_name("feature/login").is_ok());
        assert!(validate_branch_name("fix-1").is_ok());
        assert!(matches!(
            validate_branch_name(""),
            Err(WorktreeError::BranchEmpty)
        ));
        assert!(matches!(
            validate_branch_name("   "),
            Err(WorktreeError::BranchEmpty)
        ));
        assert!(matches!(
            validate_branch_name("-x"),
            Err(WorktreeError::BranchStartsWithDash)
        ));
        assert!(matches!(
            validate_branch_name("--force"),
            Err(WorktreeError::BranchStartsWithDash)
        ));
        assert!(matches!(
            validate_branch_name("a\nb"),
            Err(WorktreeError::BranchInvalid(_))
        ));
        assert!(matches!(
            validate_branch_name("a\0b"),
            Err(WorktreeError::BranchInvalid(_))
        ));
    }

    #[test]
    fn the_folder_name_joins_the_repository_and_the_branch_with_a_dash() {
        assert_eq!(worktree_folder_name("noren", "main"), "noren-main");
        assert_eq!(
            worktree_folder_name("noren", "feature/login"),
            "noren-feature-login"
        );
        assert_eq!(worktree_folder_name("r", "a/b/c"), "r-a-b-c");
        assert_eq!(worktree_folder_name("r", "a:b|c"), "r-a-b-c");
    }

    #[test]
    fn the_destination_is_next_to_the_repository() {
        assert_eq!(
            worktree_destination(Path::new("/work/noren"), "fix/x"),
            Some(PathBuf::from("/work/noren-fix-x"))
        );
        assert_eq!(worktree_destination(Path::new("/"), "x"), None);
        assert_eq!(worktree_destination(Path::new("noren"), "x"), None);
    }

    #[test]
    fn same_path_ignores_separator_direction_and_a_trailing_separator() {
        assert!(same_path("D:/a/b", "D:\\a\\b\\"));
        assert!(!same_path("/a/b", "/a/c"));
    }

    #[test]
    fn a_missing_git_is_a_readable_error() {
        let cli = GitCli::with_program("noren-no-such-git-program");
        let error = cli.list(&std::env::temp_dir()).expect_err("no git to run");
        assert!(matches!(error, WorktreeError::GitMissing(_)));
        assert!(error.to_string().contains("Install git"), "{error}");
    }

    #[test]
    fn a_folder_that_does_not_exist_is_refused_before_git_runs() {
        let gone = std::env::temp_dir().join("noren-worktree-folder-that-is-not-there");
        // Even with no git at all, the folder is checked first.
        let error = GitCli::with_program("noren-no-such-git-program")
            .list(&gone)
            .expect_err("no folder");
        assert!(matches!(error, WorktreeError::NotAFolder(_)), "{error}");
    }
}

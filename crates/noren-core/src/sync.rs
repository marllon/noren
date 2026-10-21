//! Sync of the settings through a git repository of the user, with the `git` of the system and no
//! Tauri dependency: the config, the themes, the mods and the spaces of this computer go to a
//! repository the person owns, and come back on another computer.
//!
//! The folder of the sync is a clone kept next to `config.jsonc` ([`SYNC_DIR_NAME`]). The config
//! folder is never a git repository itself: files travel between the two by copy, and only the
//! names a closed list allows ([`is_syncable`]):
//!
//! - `config.jsonc`;
//! - `themes/<id>.json` (a theme id);
//! - `mods/<name>.css` (a mod file name);
//! - `spaces/<name>.noren-space.json` (a space file, see `exportSpace` of `@noren/model`).
//!
//! Anything else in the config folder (`state.json`, the scrollback, `gallery.json`, `plugins/`, a
//! stray file) is never copied into the clone, and a file with another name that a repository
//! carries is never copied out of it. The API keys live in the keychain of the system and never in
//! these files.
//!
//! - **Push** copies the allowed files into the clone, commits what changed and pushes. A remote
//!   that has commits this clone lacks refuses the push ([`SyncError::Rejected`]): pull first.
//! - **Pull** first commits the local state the same way (so a local edit is one side of the
//!   merge, never lost), fetches, and merges. On a merge conflict it aborts the merge, writes
//!   nothing to the config folder and returns the paths in conflict ([`PullOutcome::Conflicts`]).
//!   Only when the merge is clean do the files it brought reach the config folder.
//! - **Nothing is deleted.** A file removed on one side is not removed on the other; the files a
//!   pull brings are the ones the merge added or changed.
//!
//! `git` runs with separate arguments, never through a shell, without a window on Windows, without
//! a terminal and asking for nothing (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), with a
//! deadline for the whole command and a ceiling on what it may print. The commits carry an
//! identity of their own, the hooks of the repository and the user's global settings that would
//! change the bytes (line endings) are turned off, and a symbolic link in the clone is a plain
//! file. The address of the remote is checked first ([`validate_remote_url`]).

use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::CONFIG_FILE_NAME;
use crate::mods::{MODS_DIR_NAME, is_valid_mod_file_name};
use crate::themes::{THEMES_DIR_NAME, is_valid_theme_id};
use crate::worktree::GitCli;

/// The folder of the clone, inside the config folder (it is never one of the folders copied).
pub const SYNC_DIR_NAME: &str = "sync";

/// The folder of the space files, inside the config folder and inside the clone.
pub const SPACES_DIR_NAME: &str = "spaces";

/// The end of the name of a space file.
pub const SPACE_FILE_SUFFIX: &str = ".noren-space.json";

/// The most a file may hold to travel (1 MiB; a theme, a mod or a space is far smaller).
pub const MAX_SYNC_FILE_BYTES: u64 = 1024 * 1024;

/// The most files that travel at once.
pub const MAX_SYNC_FILES: usize = 500;

/// The longest address of a remote, in characters.
pub const MAX_REMOTE_CHARS: usize = 2048;

/// How long a git command may run before it is stopped (a clone, a fetch or a push over a slow
/// network included).
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(120);

/// The most a git command may print on its output (1 MiB).
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// The most of the error stream of git that is kept.
const MAX_STDERR_BYTES: u64 = 64 * 1024;

/// The longest git message kept in an error.
const MAX_DETAIL_CHARS: usize = 500;

/// The most entries read from the config folder looking for files to copy.
const MAX_SCANNED_ENTRIES: usize = 5000;

/// A ref of the clone (never pushed) that names the last commit whose files a pull delivered to the
/// config folder. The next pull delivers what changed since.
const APPLIED_REF: &str = "refs/noren/applied";

/// The author of the commits, whatever the settings of the user say.
const COMMIT_NAME: &str = "Noren sync";
const COMMIT_EMAIL: &str = "sync@noren.invalid";

/// Settings given to every git command: the bytes of a file are never changed on the way in or out
/// of the clone, a repository runs no hook and no file monitor, a symbolic link is a plain file,
/// and the commit has an identity and no signature.
const GIT_SETTINGS: [&str; 16] = [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.symlinks=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=.git/noren-no-hooks",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "advice.detachedHead=false",
];

/// Why a sync step did not happen.
#[derive(Debug)]
pub enum SyncError {
    /// The address of the remote is not one a sync accepts; the text says why.
    InvalidRemote(String),
    /// `git` could not be started (it is not installed, or not on the `PATH`).
    GitMissing(io::Error),
    /// There is no clone yet: connect to a remote first.
    NotConnected,
    /// The sync folder exists but is not a clone this module made.
    NotAClone(PathBuf),
    /// The remote has commits this clone does not: pull, then push again.
    Rejected(String),
    /// git refused; the text is what it printed.
    Git(String),
    /// git ran past [`SYNC_TIMEOUT`] and was stopped.
    TimedOut,
    /// git printed more than a command needs and was stopped.
    OutputTooLarge,
    /// A file to copy is larger than [`MAX_SYNC_FILE_BYTES`].
    FileTooLarge(String),
    /// More than [`MAX_SYNC_FILES`] files would travel.
    TooManyFiles,
    /// A file or folder could not be read or written.
    Io(String),
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRemote(reason) => write!(f, "this is not a usable remote: {reason}"),
            Self::GitMissing(error) => write!(
                f,
                "git was not found on this computer: install git and make sure it is on the PATH ({error})"
            ),
            Self::NotConnected => f.write_str("no remote is connected yet: connect to one first"),
            Self::NotAClone(path) => write!(
                f,
                "the folder {} is not a sync clone; move or remove it and connect again",
                path.display()
            ),
            Self::Rejected(detail) => write!(
                f,
                "the remote has changes this computer does not have: pull first, then push again ({detail})"
            ),
            Self::Git(detail) => write!(f, "git failed: {detail}"),
            Self::TimedOut => write!(
                f,
                "git did not finish within {} seconds and was stopped",
                SYNC_TIMEOUT.as_secs()
            ),
            Self::OutputTooLarge => {
                f.write_str("git printed more than a sync needs and was stopped")
            }
            Self::FileTooLarge(path) => write!(
                f,
                "{path} is larger than {} KiB and will not be synced",
                MAX_SYNC_FILE_BYTES / 1024
            ),
            Self::TooManyFiles => write!(f, "more than {MAX_SYNC_FILES} files would be synced"),
            Self::Io(detail) => write!(f, "could not read or write the sync files: {detail}"),
        }
    }
}

impl std::error::Error for SyncError {}

impl SyncError {
    fn io(error: &io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

/// What differs between a file of the config folder and the clone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// The clone has no such file.
    Added,
    /// The clone has it with other content.
    Modified,
}

impl ChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
        }
    }
}

/// One file the next push would carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingChange {
    /// The path inside the config folder, with `/` as the separator.
    pub path: String,
    pub kind: ChangeKind,
}

/// Where the sync stands, without any network: what the last fetch left in the clone.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SyncStatus {
    /// There is a clone of a remote.
    pub connected: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
    /// Files of the config folder that the clone does not hold yet, in path order.
    pub pending: Vec<PendingChange>,
    /// Commits of the clone the remote does not have.
    pub ahead: usize,
    /// Commits the remote has (as of the last fetch) that the clone does not.
    pub behind: usize,
}

/// What a pull did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullOutcome {
    /// Nothing came: the remote holds nothing new for this computer.
    UpToDate,
    /// The merge was clean; these files of the config folder were written.
    Updated(Vec<String>),
    /// The merge would conflict on these paths; it was aborted and the config folder is as it was.
    Conflicts(Vec<String>),
}

/// What a push did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushOutcome {
    /// A new commit was made from changes in the config folder.
    pub committed: bool,
    /// Something was sent to the remote.
    pub pushed: bool,
    /// The files that went into the new commit.
    pub files: Vec<String>,
}

/// Checks the address of a remote. Accepted: `https://host/path` (no user name, no password: a
/// token in the address would be kept in the clone in plain text), `ssh://[user@]host/path`,
/// `file:///path`, `[user@]host:path` (the form `git` calls scp-like), and a full local path
/// (`/srv/notes.git`, `C:\repos\notes.git`). Refused: a password anywhere, a value that git would
/// read as an option (starting with `-`), a helper transport (`ext::`, `fd::` and every
/// `name::`), plain `http://` and any other scheme.
pub fn validate_remote_url(url: &str) -> Result<(), SyncError> {
    let refuse = |reason: &str| Err(SyncError::InvalidRemote(reason.to_owned()));
    if url.is_empty() {
        return refuse("the address is empty");
    }
    if url.chars().count() > MAX_REMOTE_CHARS {
        return refuse("the address is too long");
    }
    if url.chars().any(char::is_control) {
        return refuse("the address has a control character");
    }
    if url.starts_with('-') {
        return refuse("the address starts with '-' and would read as an option");
    }
    if is_local_path(url) {
        return Ok(());
    }
    if url.chars().any(char::is_whitespace) {
        return refuse("the address has a space");
    }
    // `ext::sh -c ...`, `fd::3`, `hg::...`: a helper that runs a program.
    if let Some((prefix, _)) = url.split_once("::")
        && !prefix.is_empty()
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return refuse("a helper transport (name::address) is not allowed");
    }
    if let Some((scheme, rest)) = url.split_once("://") {
        return validate_url_with_scheme(&scheme.to_ascii_lowercase(), rest);
    }
    validate_scp_like(url)
}

/// A full path of this computer: `/...`, or a drive (`C:\...` or `C:/...`). A path may hold spaces.
fn is_local_path(url: &str) -> bool {
    let bytes = url.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    drive || (url.starts_with('/') && !url.starts_with("//"))
}

fn validate_url_with_scheme(scheme: &str, rest: &str) -> Result<(), SyncError> {
    let refuse = |reason: &str| Err(SyncError::InvalidRemote(reason.to_owned()));
    match scheme {
        "https" | "ssh" => {}
        "file" => {
            return if rest.is_empty() || rest.starts_with('-') {
                refuse("a file address needs a path")
            } else {
                Ok(())
            };
        }
        "http" => return refuse("http is not encrypted: use https"),
        _ => return refuse("only https, ssh and file addresses are accepted"),
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (userinfo, host_port) = match authority.rsplit_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, authority),
    };
    if let Some(user) = userinfo {
        if user.contains(':') {
            return refuse("the address has a password: use the credential manager of git instead");
        }
        if scheme == "https" {
            return refuse(
                "the address has a user name: https addresses are kept in the clone in plain text",
            );
        }
        if user.is_empty() || user.starts_with('-') {
            return refuse("the user name of the address is not valid");
        }
    }
    let host = match host_port.strip_prefix('[') {
        Some(inner) => inner.split(']').next().unwrap_or(""),
        None => host_port.split(':').next().unwrap_or(""),
    };
    if host.is_empty() {
        return refuse("the address has no host");
    }
    if host.starts_with('-') {
        return refuse("the host starts with '-' and would read as an option");
    }
    if host.contains('\\') {
        return refuse("the host has a backslash");
    }
    Ok(())
}

fn validate_scp_like(url: &str) -> Result<(), SyncError> {
    let refuse = |reason: &str| Err(SyncError::InvalidRemote(reason.to_owned()));
    let Some((head, path)) = url.split_once(':') else {
        return refuse("not an https, ssh or file address, nor a local path");
    };
    if head.contains('/') {
        return refuse("not an https, ssh or file address, nor a local path");
    }
    let (user, host) = match head.rsplit_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, head),
    };
    if user.is_none() && path.split('/').next().unwrap_or("").contains('@') {
        return refuse("the address looks like user:password@host");
    }
    if let Some(user) = user
        && (user.is_empty() || user.starts_with('-'))
    {
        return refuse("the user name of the address is not valid");
    }
    if host.len() < 2 || host.starts_with('-') {
        return refuse("the host of the address is not valid");
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return refuse("the host of the address is not valid");
    }
    if path.is_empty() {
        return refuse("the address has no path");
    }
    Ok(())
}

/// Whether `path` (relative to the config folder, `/` as the separator) may travel: the closed
/// list of this module and nothing else.
pub fn is_syncable(path: &str) -> bool {
    if path == CONFIG_FILE_NAME {
        return true;
    }
    let Some((dir, name)) = path.split_once('/') else {
        return false;
    };
    if name.contains('/') {
        return false;
    }
    match dir {
        THEMES_DIR_NAME => name.strip_suffix(".json").is_some_and(is_valid_theme_id),
        MODS_DIR_NAME => is_valid_mod_file_name(name),
        SPACES_DIR_NAME => is_space_file_name(name),
        _ => false,
    }
}

/// `<name>.noren-space.json` with a name that is one plain file name on every system.
fn is_space_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(SPACE_FILE_SUFFIX) else {
        return false;
    };
    !stem.is_empty()
        && name.chars().count() <= 128
        && !stem.starts_with('.')
        && !stem.ends_with(['.', ' '])
        && !stem.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        && !crate::mods::is_reserved_name(stem)
}

/// What a command that ran to the end printed.
struct Finished {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: String,
}

/// Runs `command` with its output piped: at most `cap` bytes of the standard output are read (one
/// more and the command is killed), the error stream is kept to [`MAX_STDERR_BYTES`], and the
/// command is killed when it runs past `timeout`.
fn run_limited(mut command: Command, cap: usize, timeout: Duration) -> Result<Finished, SyncError> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(SyncError::GitMissing)?;
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(SyncError::Io(
            "the output of git could not be read".to_owned(),
        ));
    };
    let overflow = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&overflow);
    let out_thread = thread::spawn(move || {
        let mut out = Vec::new();
        let _ = (&mut stdout).take(cap as u64 + 1).read_to_end(&mut out);
        if out.len() > cap {
            flag.store(true, Ordering::SeqCst);
        }
        out
    });
    let err_thread = thread::spawn(move || {
        let mut kept = Vec::new();
        let _ = (&mut stderr).take(MAX_STDERR_BYTES).read_to_end(&mut kept);
        let _ = io::copy(&mut stderr, &mut io::sink());
        String::from_utf8_lossy(&kept).into_owned()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if overflow.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = out_thread.join();
            let _ = err_thread.join();
            return Err(SyncError::OutputTooLarge);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err(SyncError::TimedOut);
            }
            Err(error) => {
                let _ = child.kill();
                return Err(SyncError::io(&error));
            }
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    if stdout.len() > cap {
        return Err(SyncError::OutputTooLarge);
    }
    Ok(Finished {
        status,
        stdout,
        stderr,
    })
}

/// What git printed to say why it refused: the error stream, else the output, else the exit code,
/// cut to [`MAX_DETAIL_CHARS`].
fn failure_text(finished: &Finished) -> String {
    let stderr = finished.stderr.trim();
    let stdout = String::from_utf8_lossy(&finished.stdout);
    let text = if stderr.is_empty() {
        stdout.trim().to_owned()
    } else {
        stderr.to_owned()
    };
    if text.is_empty() {
        format!("git exited with {}", finished.status)
    } else {
        text.chars().take(MAX_DETAIL_CHARS).collect()
    }
}

/// The sync of one config folder.
#[derive(Debug, Clone)]
pub struct SyncRepo {
    config_dir: PathBuf,
    clone_dir: PathBuf,
    git: GitCli,
    timeout: Duration,
}

impl SyncRepo {
    /// The sync of the config folder `config_dir`, with the `git` of the system. Nothing is made
    /// on disk until a remote is connected.
    pub fn new(config_dir: impl Into<PathBuf>) -> Self {
        let config_dir = config_dir.into();
        let clone_dir = config_dir.join(SYNC_DIR_NAME);
        Self {
            config_dir,
            clone_dir,
            git: GitCli::system().with_env("GCM_INTERACTIVE", "never"),
            timeout: SYNC_TIMEOUT,
        }
    }

    /// Another `git` in place of the system one (a test: another program name, or a scratch
    /// `HOME` and a global config of its own through [`GitCli::with_env`]).
    #[must_use]
    pub fn with_git(mut self, git: GitCli) -> Self {
        self.git = git.with_env("GCM_INTERACTIVE", "never");
        self
    }

    /// Another deadline for a git command.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The folder of the clone.
    pub fn clone_dir(&self) -> &Path {
        &self.clone_dir
    }

    fn is_cloned(&self) -> bool {
        self.clone_dir.join(".git").exists()
    }

    fn require_clone(&self) -> Result<(), SyncError> {
        if self.is_cloned() {
            Ok(())
        } else {
            Err(SyncError::NotConnected)
        }
    }

    /// Runs `git <settings> <args>` in `dir`.
    fn run(&self, dir: &Path, args: &[&str], cap: usize) -> Result<Finished, SyncError> {
        let mut all: Vec<OsString> = Vec::new();
        for setting in GIT_SETTINGS {
            all.push(setting.into());
        }
        for setting in [
            format!("user.name={COMMIT_NAME}"),
            format!("user.email={COMMIT_EMAIL}"),
        ] {
            all.push("-c".into());
            all.push(setting.into());
        }
        all.extend(args.iter().map(OsString::from));
        let mut command = self.git.command(dir, all);
        command
            .env("LC_ALL", "C")
            .env("GIT_ALLOW_PROTOCOL", "https:ssh:file");
        run_limited(command, cap, self.timeout)
    }

    /// Runs git in the clone and turns a refusal into [`SyncError::Git`].
    fn ok(&self, args: &[&str]) -> Result<String, SyncError> {
        let finished = self.run(&self.clone_dir, args, MAX_OUTPUT_BYTES)?;
        if finished.status.success() {
            Ok(String::from_utf8_lossy(&finished.stdout).into_owned())
        } else {
            Err(SyncError::Git(failure_text(&finished)))
        }
    }

    /// Runs git in the clone and tells only whether it ended with success.
    fn succeeds(&self, args: &[&str]) -> Result<bool, SyncError> {
        Ok(self
            .run(&self.clone_dir, args, MAX_OUTPUT_BYTES)?
            .status
            .success())
    }

    /// The branch of the clone, also when it has no commit yet.
    fn branch(&self) -> Result<String, SyncError> {
        let name = self.ok(&["symbolic-ref", "--short", "HEAD"])?;
        let name = name.trim();
        if name.is_empty() || name.starts_with('-') {
            return Err(SyncError::Git("the clone is on no branch".to_owned()));
        }
        Ok(name.to_owned())
    }

    /// The commit `HEAD` names, or `None` when the branch has no commit yet.
    fn head_commit(&self) -> Result<Option<String>, SyncError> {
        let finished = self.run(
            &self.clone_dir,
            &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
            MAX_OUTPUT_BYTES,
        )?;
        Ok(finished
            .status
            .success()
            .then(|| String::from_utf8_lossy(&finished.stdout).trim().to_owned()))
    }

    fn remote_url(&self) -> Option<String> {
        self.ok(&["config", "--get", "remote.origin.url"])
            .ok()
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty())
    }

    /// Connects this computer to `remote`: clones it into the sync folder (an empty repository is
    /// fine), or, when a clone exists, points it at the new address. Copies nothing into the config
    /// folder: that is what a pull does. The address is checked first.
    pub fn connect(&self, remote: &str) -> Result<SyncStatus, SyncError> {
        validate_remote_url(remote)?;
        if self.is_cloned() {
            if self.remote_url().as_deref() != Some(remote) {
                self.ok(&["remote", "set-url", "origin", "--", remote])?;
            }
            return self.status();
        }
        if self.clone_dir.exists() {
            return Err(SyncError::NotAClone(self.clone_dir.clone()));
        }
        fs::create_dir_all(&self.config_dir).map_err(|e| SyncError::io(&e))?;
        let finished = self.run(
            &self.config_dir,
            &["clone", "--origin", "origin", "--", remote, SYNC_DIR_NAME],
            MAX_OUTPUT_BYTES,
        )?;
        if !finished.status.success() {
            return Err(SyncError::Git(failure_text(&finished)));
        }
        self.status()
    }

    /// Where the sync stands, with no network: the remote, the branch, the files of the config
    /// folder the clone does not hold yet, and how far the clone is from what the last fetch saw.
    pub fn status(&self) -> Result<SyncStatus, SyncError> {
        if !self.is_cloned() {
            return Ok(SyncStatus::default());
        }
        let branch = self.branch()?;
        let (ahead, behind) = self.ahead_behind(&branch);
        Ok(SyncStatus {
            connected: true,
            remote: self.remote_url(),
            branch: Some(branch),
            pending: self.pending_changes()?,
            ahead,
            behind,
        })
    }

    fn ahead_behind(&self, branch: &str) -> (usize, usize) {
        let upstream = format!("refs/remotes/origin/{branch}");
        if !self
            .succeeds(&["rev-parse", "--verify", "--quiet", &upstream])
            .unwrap_or(false)
        {
            return (0, 0);
        }
        let range = format!("HEAD...{upstream}");
        let Ok(text) = self.ok(&["rev-list", "--left-right", "--count", &range]) else {
            return (0, 0);
        };
        let mut numbers = text
            .split_whitespace()
            .map(|n| n.parse::<usize>().unwrap_or(0));
        (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0))
    }

    /// The files of the config folder the clone lacks or holds with other content.
    fn pending_changes(&self) -> Result<Vec<PendingChange>, SyncError> {
        let mut pending = Vec::new();
        for path in self.local_files()? {
            let in_clone = self.clone_dir.join(&path);
            let kind = match fs::symlink_metadata(&in_clone) {
                Err(_) => ChangeKind::Added,
                Ok(meta) if meta.is_file() => {
                    if same_content(&self.config_dir.join(&path), &in_clone)? {
                        continue;
                    }
                    ChangeKind::Modified
                }
                Ok(_) => ChangeKind::Modified,
            };
            pending.push(PendingChange { path, kind });
        }
        Ok(pending)
    }

    /// The files of the config folder that may travel, in path order: the entries of the folder
    /// and of the folders in it, filtered by [`is_syncable`] and by being plain files (a link is
    /// skipped).
    fn local_files(&self) -> Result<Vec<String>, SyncError> {
        let mut found = Vec::new();
        let mut scanned = 0usize;
        let top = match fs::read_dir(&self.config_dir) {
            Ok(top) => top,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(found),
            Err(error) => return Err(SyncError::io(&error)),
        };
        for entry in top {
            let entry = entry.map_err(|e| SyncError::io(&e))?;
            scanned += 1;
            if scanned > MAX_SCANNED_ENTRIES {
                break;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name == SYNC_DIR_NAME || name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_file() {
                if is_syncable(&name) {
                    found.push(name);
                }
            } else if kind.is_dir() {
                let Ok(inner) = fs::read_dir(entry.path()) else {
                    continue;
                };
                for child in inner {
                    let Ok(child) = child else {
                        continue;
                    };
                    scanned += 1;
                    if scanned > MAX_SCANNED_ENTRIES {
                        break;
                    }
                    let Some(child_name) = child.file_name().to_str().map(str::to_owned) else {
                        continue;
                    };
                    let relative = format!("{name}/{child_name}");
                    if child.file_type().is_ok_and(|t| t.is_file()) && is_syncable(&relative) {
                        found.push(relative);
                    }
                }
            }
        }
        found.sort();
        if found.len() > MAX_SYNC_FILES {
            return Err(SyncError::TooManyFiles);
        }
        Ok(found)
    }

    /// Copies the files of the config folder that may travel into the clone, and commits what
    /// changed. Returns the files of the new commit; empty when there was nothing new.
    fn snapshot(&self) -> Result<Vec<String>, SyncError> {
        let local = self.local_files()?;
        // Every size is checked before the first copy, so a refusal leaves the clone as it was.
        for path in &local {
            let size = fs::metadata(self.config_dir.join(path))
                .map_err(|e| SyncError::io(&e))?
                .len();
            if size > MAX_SYNC_FILE_BYTES {
                return Err(SyncError::FileTooLarge(path.clone()));
            }
        }
        let was_unborn = self.head_commit()?.is_none();
        let mut copied = Vec::new();
        for path in local {
            let from = self.config_dir.join(&path);
            let to = self.clone_dir.join(&path);
            if fs::symlink_metadata(&to).is_ok_and(|m| m.is_file()) && same_content(&from, &to)? {
                continue;
            }
            write_file(&from, &to)?;
            copied.push(path);
        }
        if copied.is_empty() {
            return Ok(copied);
        }
        // Only the files copied just now are staged, a hundred names to a command.
        for chunk in copied.chunks(100) {
            let mut args = vec!["add", "--"];
            args.extend(chunk.iter().map(String::as_str));
            self.ok(&args)?;
        }
        // Nothing staged (the copy only touched what git already had): no commit.
        if self.succeeds(&["diff", "--cached", "--quiet"])? {
            return Ok(Vec::new());
        }
        let staged = self.ok(&["diff", "--cached", "--name-only", "-z"])?;
        let files = split_paths(&staged);
        self.ok(&[
            "commit",
            "--no-verify",
            "--quiet",
            "-m",
            "Noren sync: update settings",
        ])?;
        if was_unborn {
            // The first commit holds only what came from this computer: nothing is left to deliver.
            self.ok(&["update-ref", APPLIED_REF, "HEAD"])?;
        }
        Ok(files)
    }

    /// Commits the changed allowed files of the config folder and sends them to the remote. A
    /// remote with commits this clone lacks refuses ([`SyncError::Rejected`]); the commit stays in
    /// the clone and goes out with the next push, after a pull.
    pub fn push(&self) -> Result<PushOutcome, SyncError> {
        self.require_clone()?;
        let branch = self.branch()?;
        let upstream = format!("refs/remotes/origin/{branch}");
        if self.head_commit()?.is_none() {
            // Nothing committed yet: when the remote has a branch by now, this computer would
            // start a history of its own beside it.
            self.ok(&["fetch", "--prune", "origin"])?;
            if self.succeeds(&["rev-parse", "--verify", "--quiet", &upstream])? {
                return Err(SyncError::Rejected(
                    "the remote has settings and this computer has not pulled them yet".to_owned(),
                ));
            }
        } else if !self.has_applied()? {
            // The clone holds what the remote had, and no pull delivered it to this computer: a file
            // here that differs would silently replace the remote's.
            let clashes = self.clashes_with("HEAD")?;
            if !clashes.is_empty() {
                return Err(SyncError::Rejected(format!(
                    "these files differ from the remote's: {}",
                    clashes.join(", ")
                )));
            }
        }
        let files = self.snapshot()?;
        let committed = !files.is_empty();
        if self.head_commit()?.is_none() {
            return Ok(PushOutcome {
                committed,
                pushed: false,
                files,
            });
        }
        let (ahead, _) = self.ahead_behind(&branch);
        let has_upstream = self.succeeds(&["rev-parse", "--verify", "--quiet", &upstream])?;
        if has_upstream && ahead == 0 {
            return Ok(PushOutcome {
                committed,
                pushed: false,
                files,
            });
        }
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        let finished = self.run(
            &self.clone_dir,
            &["push", "--set-upstream", "origin", &refspec],
            MAX_OUTPUT_BYTES,
        )?;
        if !finished.status.success() {
            let text = failure_text(&finished);
            let lower = text.to_ascii_lowercase();
            return Err(
                if lower.contains("non-fast-forward")
                    || lower.contains("fetch first")
                    || lower.contains("[rejected]")
                {
                    SyncError::Rejected(text)
                } else {
                    SyncError::Git(text)
                },
            );
        }
        Ok(PushOutcome {
            committed,
            pushed: true,
            files,
        })
    }

    /// Brings the remote into the config folder. The local state is committed into the clone
    /// first, the remote is fetched and merged, and:
    ///
    /// - on a conflict the merge is aborted, nothing is written to the config folder and the paths
    ///   in conflict come back;
    /// - on a clean merge, the allowed files the merge added or changed are written to the config
    ///   folder.
    pub fn pull(&self) -> Result<PullOutcome, SyncError> {
        self.require_clone()?;
        let branch = self.branch()?;
        self.ok(&["fetch", "--prune", "origin"])?;
        let upstream = format!("refs/remotes/origin/{branch}");
        if !self.succeeds(&["rev-parse", "--verify", "--quiet", &upstream])? {
            return Ok(PullOutcome::UpToDate);
        }
        if self.head_commit()?.is_none() {
            // A clone with no commit of its own (the remote was empty when it was made): the
            // remote branch becomes the clone, unless a file of this computer differs from it.
            let clashes = self.clashes_with(&upstream)?;
            if !clashes.is_empty() {
                return Ok(PullOutcome::Conflicts(clashes));
            }
            self.ok(&["checkout", "-B", &branch, &upstream])?;
        } else {
            if !self.has_applied()? {
                // The clone holds what the remote had and no pull delivered it yet: a file here that
                // differs would be committed over the remote's, with no merge to see it.
                let clashes = self.clashes_with("HEAD")?;
                if !clashes.is_empty() {
                    return Ok(PullOutcome::Conflicts(clashes));
                }
            }
            self.snapshot()?;
            let merge = self.run(
                &self.clone_dir,
                &["merge", "--no-edit", "--no-verify", &upstream],
                MAX_OUTPUT_BYTES,
            )?;
            if !merge.status.success() {
                return self.abort_merge(&merge);
            }
        }
        let outcome = self.apply_changes()?;
        self.ok(&["update-ref", APPLIED_REF, "HEAD"])?;
        Ok(outcome)
    }

    /// A merge that did not end: when it stopped on conflicts, aborts it and returns the paths; any
    /// other refusal is an error (and the merge is aborted if one is in progress).
    fn abort_merge(&self, merge: &Finished) -> Result<PullOutcome, SyncError> {
        let in_progress = self.succeeds(&["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])?;
        let conflicts = if in_progress {
            split_paths(&self.ok(&["diff", "--name-only", "--diff-filter=U", "-z"])?)
        } else {
            Vec::new()
        };
        if in_progress && !self.succeeds(&["merge", "--abort"])? {
            self.ok(&["reset", "--merge"])?;
        }
        if conflicts.is_empty() {
            return Err(SyncError::Git(failure_text(merge)));
        }
        Ok(PullOutcome::Conflicts(conflicts))
    }

    /// Whether a pull ever delivered files to the config folder (or the first commit came from it).
    fn has_applied(&self) -> Result<bool, SyncError> {
        self.succeeds(&["rev-parse", "--verify", "--quiet", APPLIED_REF])
    }

    /// The allowed files that exist on this computer and in the commit `rev` with different
    /// content.
    fn clashes_with(&self, rev: &str) -> Result<Vec<String>, SyncError> {
        let listed = self.ok(&["ls-tree", "-r", "--name-only", "-z", rev])?;
        let mut clashes = Vec::new();
        for path in split_paths(&listed) {
            if !is_syncable(&path) {
                continue;
            }
            let local = self.config_dir.join(&path);
            if !fs::symlink_metadata(&local).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let finished = self.run(
                &self.clone_dir,
                &["show", &format!("{rev}:{path}")],
                MAX_SYNC_FILE_BYTES as usize,
            )?;
            if !finished.status.success() {
                return Err(SyncError::Git(failure_text(&finished)));
            }
            let mine = fs::read(&local).map_err(|e| SyncError::io(&e))?;
            if mine != finished.stdout {
                clashes.push(path);
            }
        }
        Ok(clashes)
    }

    /// Writes to the config folder the allowed files that changed between the last commit a pull
    /// delivered ([`APPLIED_REF`]; every file of `HEAD` when no pull delivered yet) and `HEAD`,
    /// when their content differs from what the folder holds.
    fn apply_changes(&self) -> Result<PullOutcome, SyncError> {
        let listed = if self.has_applied()? {
            self.ok(&[
                "diff",
                "--name-only",
                "-z",
                "--diff-filter=ACMR",
                APPLIED_REF,
                "HEAD",
            ])?
        } else {
            self.ok(&["ls-tree", "-r", "--name-only", "-z", "HEAD"])?
        };
        let mut written = Vec::new();
        for path in split_paths(&listed) {
            if !is_syncable(&path) {
                continue;
            }
            let from = self.clone_dir.join(&path);
            if !fs::symlink_metadata(&from).is_ok_and(|m| m.is_file()) {
                continue;
            }
            if fs::metadata(&from).map_err(|e| SyncError::io(&e))?.len() > MAX_SYNC_FILE_BYTES {
                return Err(SyncError::FileTooLarge(path));
            }
            let to = self.config_dir.join(&path);
            if fs::symlink_metadata(&to).is_ok_and(|m| m.is_file()) && same_content(&from, &to)? {
                continue;
            }
            written.push((from, to, path));
        }
        if written.len() > MAX_SYNC_FILES {
            return Err(SyncError::TooManyFiles);
        }
        let mut names = Vec::new();
        for (from, to, path) in written {
            write_file(&from, &to)?;
            names.push(path);
        }
        names.sort();
        Ok(if names.is_empty() {
            PullOutcome::UpToDate
        } else {
            PullOutcome::Updated(names)
        })
    }
}

/// The paths in the output of a git command that ends each name with a NUL.
fn split_paths(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Whether two files hold the same bytes.
fn same_content(a: &Path, b: &Path) -> Result<bool, SyncError> {
    let size = |path: &Path| {
        fs::metadata(path)
            .map(|m| m.len())
            .map_err(|e| SyncError::io(&e))
    };
    if size(a)? != size(b)? {
        return Ok(false);
    }
    Ok(
        fs::read(a).map_err(|e| SyncError::io(&e))?
            == fs::read(b).map_err(|e| SyncError::io(&e))?,
    )
}

/// Copies `from` to `to` through a temporary file beside it, so the destination is never half
/// written; makes the folder of `to` when it is missing.
fn write_file(from: &Path, to: &Path) -> Result<(), SyncError> {
    let bytes = fs::read(from).map_err(|e| SyncError::io(&e))?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| SyncError::io(&e))?;
    }
    let mut temporary = to.as_os_str().to_owned();
    temporary.push(".noren-sync-tmp");
    let temporary = PathBuf::from(temporary);
    fs::write(&temporary, bytes).map_err(|e| SyncError::io(&e))?;
    fs::rename(&temporary, to).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        SyncError::io(&e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::AtomicUsize;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A folder in the temp dir that no other test or run uses, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "noren-sync-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A git that reads no config of the user: `HOME` and the global config are a scratch folder
    /// and the system config is off.
    fn clean_git(home: &Path) -> GitCli {
        GitCli::system()
            .with_env("HOME", home)
            .with_env("USERPROFILE", home)
            .with_env("XDG_CONFIG_HOME", home)
            .with_env("GIT_CONFIG_GLOBAL", home.join("gitconfig"))
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
    }

    /// A bare repository (branch `main`) in a folder of its own.
    struct Remote {
        _dir: TempDir,
        path: PathBuf,
        home: PathBuf,
    }

    impl Remote {
        fn new() -> Self {
            let dir = TempDir::new("remote");
            let path = dir.path("remote.git");
            let home = dir.path("home");
            fs::create_dir_all(&home).expect("home");
            let output = Command::new("git")
                .args(["init", "--bare", "--quiet", "--initial-branch=main"])
                .arg(&path)
                .env("HOME", &home)
                .env("USERPROFILE", &home)
                .env("GIT_CONFIG_GLOBAL", home.join("gitconfig"))
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .expect("git is installed on the machine that runs the tests");
            assert!(output.status.success(), "git init --bare failed");
            Self {
                _dir: dir,
                path,
                home,
            }
        }

        fn url(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    /// A computer: a config folder and a sync over it, with the scratch home of the remote.
    struct Machine {
        dir: TempDir,
        sync: SyncRepo,
    }

    impl Machine {
        fn new(label: &str, remote: &Remote) -> Self {
            let dir = TempDir::new(label);
            let config = dir.path("config");
            fs::create_dir_all(&config).expect("config folder");
            let sync = SyncRepo::new(&config).with_git(clean_git(&remote.home));
            Self { dir, sync }
        }

        fn config(&self) -> PathBuf {
            self.dir.path("config")
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.config().join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            fs::write(path, text).expect("write");
        }

        fn read(&self, relative: &str) -> Option<String> {
            fs::read_to_string(self.config().join(relative)).ok()
        }
    }

    /// The names of the files a bare remote holds on `main`.
    fn remote_files(remote: &Remote) -> Vec<String> {
        let output = Command::new("git")
            .args(["ls-tree", "-r", "--name-only", "main"])
            .current_dir(&remote.path)
            .env("HOME", &remote.home)
            .env("GIT_CONFIG_GLOBAL", remote.home.join("gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git ls-tree");
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_owned)
            .collect()
    }

    // The address of the remote.

    #[test]
    fn plain_addresses_are_accepted() {
        for url in [
            "https://example.com/me/settings.git",
            "ssh://git@example.com/me/settings.git",
            "ssh://example.com:2222/me/settings.git",
            "git@example.com:me/settings.git",
            "example.com:me/settings.git",
            "file:///srv/settings.git",
            "/srv/settings.git",
            "C:\\repos\\my settings.git",
            "C:/repos/settings.git",
        ] {
            assert!(validate_remote_url(url).is_ok(), "{url}");
        }
    }

    #[test]
    fn addresses_that_carry_a_secret_or_a_trick_are_refused() {
        for url in [
            "",
            "-oProxyCommand=calc",
            "--upload-pack=calc",
            "ext::sh -c calc",
            "ext::calc",
            "fd::3",
            "hg::https://example.com/x",
            "https://user:token@example.com/x.git",
            "https://token@example.com/x.git",
            "ssh://user:secret@example.com/x.git",
            "ssh://-oProxyCommand=calc/x",
            "ssh://@example.com/x",
            "http://example.com/x.git",
            "ftp://example.com/x.git",
            "git://example.com/x.git",
            "https:///x.git",
            "https://exa mple.com/x.git",
            "user:password@example.com:x.git",
            "-host:path",
            "x:path",
            "relative/path.git",
            "noscheme",
            "file://",
            "https://example.com/x\n.git",
        ] {
            assert!(validate_remote_url(url).is_err(), "{url:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_REMOTE_CHARS));
        assert!(validate_remote_url(&long).is_err());
    }

    // The closed list.

    #[test]
    fn only_the_listed_names_may_travel() {
        for path in [
            "config.jsonc",
            "themes/midnight.json",
            "themes/a-b-1.json",
            "mods/tweak.css",
            "spaces/Work.noren-space.json",
            "spaces/my space.noren-space.json",
        ] {
            assert!(is_syncable(path), "{path}");
        }
        for path in [
            "state.json",
            "gallery.json",
            "config.json",
            "scrollback/p1.txt",
            "plugins/x/plugin.json",
            "themes/Mid.json",
            "themes/notes.txt",
            "themes/con.json",
            "themes/sub/a.json",
            "mods/script.js",
            "mods/.hidden.css",
            "spaces/a.json",
            "spaces/.noren-space.json",
            "spaces/.hidden.noren-space.json",
            "spaces/a/b.noren-space.json",
            "spaces/con.noren-space.json",
            "spaces/a:b.noren-space.json",
            ".env",
            "sync/config.jsonc",
            "../config.jsonc",
            "",
        ] {
            assert!(!is_syncable(path), "{path}");
        }
    }

    // Git.

    #[test]
    fn git_missing_gives_a_clear_error() {
        let dir = TempDir::new("missing");
        let sync = SyncRepo::new(dir.path("config"))
            .with_git(GitCli::with_program("noren-no-such-git-program"));
        let error = sync
            .connect("https://example.com/me/settings.git")
            .expect_err("no git");
        assert!(matches!(error, SyncError::GitMissing(_)), "{error}");
        assert!(error.to_string().contains("git was not found"), "{error}");
        assert!(!dir.path("config").join(SYNC_DIR_NAME).exists());
    }

    #[test]
    fn a_bad_address_is_refused_before_git_runs() {
        let dir = TempDir::new("badurl");
        // Were git started, this program would fail with GitMissing instead.
        let sync = SyncRepo::new(dir.path("config"))
            .with_git(GitCli::with_program("noren-no-such-git-program"));
        let error = sync.connect("ext::sh -c calc").expect_err("refused");
        assert!(matches!(error, SyncError::InvalidRemote(_)), "{error}");
    }

    #[test]
    fn status_without_a_clone_is_not_connected_and_pull_and_push_say_so() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        assert_eq!(a.sync.status().expect("status"), SyncStatus::default());
        assert!(matches!(a.sync.pull(), Err(SyncError::NotConnected)));
        assert!(matches!(a.sync.push(), Err(SyncError::NotConnected)));
    }

    #[test]
    fn connect_clones_an_empty_remote_and_status_lists_what_would_be_pushed() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write("config.jsonc", "{ \"theme\": \"x\" }\n");
        a.write("themes/midnight.json", "{}\n");
        let status = a.sync.connect(&remote.url()).expect("connect");
        assert!(status.connected);
        assert_eq!(status.remote.as_deref(), Some(remote.url().as_str()));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!((status.ahead, status.behind), (0, 0));
        assert_eq!(
            status.pending,
            vec![
                PendingChange {
                    path: "config.jsonc".to_owned(),
                    kind: ChangeKind::Added
                },
                PendingChange {
                    path: "themes/midnight.json".to_owned(),
                    kind: ChangeKind::Added
                },
            ]
        );
        // Connecting again to the same remote changes nothing.
        assert_eq!(a.sync.connect(&remote.url()).expect("again"), status);
    }

    #[test]
    fn push_then_pull_into_a_second_computer() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write("config.jsonc", "{ // mine\n  \"fontSize\": 15\n}\r\n");
        a.write("themes/midnight.json", "{\"id\":\"midnight\"}\n");
        a.write("mods/tweak.css", "body { color: red }\n");
        a.write(
            "spaces/Work.noren-space.json",
            "{\"format\":\"noren-space\"}\n",
        );
        a.sync.connect(&remote.url()).expect("connect a");
        let pushed = a.sync.push().expect("push");
        assert!(pushed.committed && pushed.pushed);
        assert_eq!(pushed.files.len(), 4);
        let status = a.sync.status().expect("status");
        assert!(status.pending.is_empty());
        assert_eq!((status.ahead, status.behind), (0, 0));
        assert_eq!(remote_files(&remote).len(), 4);

        let b = Machine::new("b", &remote);
        let status = b.sync.connect(&remote.url()).expect("connect b");
        // The clone has the files; the config folder of b does not yet.
        assert_eq!(status.pending.len(), 0);
        assert!(b.read("config.jsonc").is_none());
        let outcome = b.sync.pull().expect("pull");
        assert_eq!(
            outcome,
            PullOutcome::Updated(vec![
                "config.jsonc".to_owned(),
                "mods/tweak.css".to_owned(),
                "spaces/Work.noren-space.json".to_owned(),
                "themes/midnight.json".to_owned(),
            ])
        );
        // The bytes are the same, line endings and comments included.
        assert_eq!(
            b.read("config.jsonc").as_deref(),
            Some("{ // mine\n  \"fontSize\": 15\n}\r\n")
        );
        assert_eq!(
            b.read("mods/tweak.css").as_deref(),
            Some("body { color: red }\n")
        );
        // Nothing left to do on either side.
        assert_eq!(b.sync.pull().expect("again"), PullOutcome::UpToDate);
        let pushed = b.sync.push().expect("push b");
        assert!(!pushed.committed && !pushed.pushed);
    }

    #[test]
    fn a_change_on_one_computer_reaches_the_other() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        a.write("config.jsonc", "one\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");
        b.sync.connect(&remote.url()).expect("b");
        b.sync.pull().expect("pull b");

        a.write("config.jsonc", "two\n");
        a.write("themes/new-one.json", "{}\n");
        a.sync.push().expect("push a again");
        let behind = b.sync.pull().expect("pull b");
        assert_eq!(
            behind,
            PullOutcome::Updated(vec![
                "config.jsonc".to_owned(),
                "themes/new-one.json".to_owned()
            ])
        );
        assert_eq!(b.read("config.jsonc").as_deref(), Some("two\n"));
    }

    #[test]
    fn changes_in_different_files_merge_cleanly_and_both_land() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        a.write("config.jsonc", "base\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");
        b.sync.connect(&remote.url()).expect("b");
        b.sync.pull().expect("pull b");

        a.write("themes/from-a.json", "{}\n");
        a.sync.push().expect("push a");
        b.write("mods/from-b.css", "p {}\n");
        // b has an unpushed file: pull keeps it and brings a's.
        let outcome = b.sync.pull().expect("pull b");
        assert_eq!(
            outcome,
            PullOutcome::Updated(vec!["themes/from-a.json".to_owned()])
        );
        assert_eq!(b.read("mods/from-b.css").as_deref(), Some("p {}\n"));
        let pushed = b.sync.push().expect("push b");
        assert!(pushed.pushed);
        let files = remote_files(&remote);
        assert!(files.contains(&"mods/from-b.css".to_owned()), "{files:?}");
        assert!(
            files.contains(&"themes/from-a.json".to_owned()),
            "{files:?}"
        );
    }

    #[test]
    fn a_pull_never_writes_what_the_remote_holds_outside_the_list() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write("config.jsonc", "{}\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");
        // Someone puts other files in the repository with git itself.
        let scratch = TempDir::new("crafted");
        let crafted = scratch.path("work");
        let git = |args: &[&str], dir: &Path| {
            let output = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("HOME", &remote.home)
                .env("USERPROFILE", &remote.home)
                .env("GIT_CONFIG_GLOBAL", remote.home.join("gitconfig"))
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .expect("git");
            assert!(output.status.success(), "{args:?}: {output:?}");
        };
        git(&["clone", "--quiet", &remote.url(), "work"], &scratch.0);
        fs::write(crafted.join("state.json"), "{\"stolen\":true}").expect("state");
        fs::create_dir_all(crafted.join("themes")).expect("themes");
        fs::write(crafted.join("themes").join("notes.txt"), "x").expect("notes");
        fs::write(crafted.join("themes").join("fine.json"), "{}\n").expect("fine");
        fs::create_dir_all(crafted.join("plugins")).expect("plugins");
        fs::write(crafted.join("plugins").join("p.js"), "x").expect("plugin");
        git(&["add", "-A"], &crafted);
        git(
            &[
                "-c",
                "user.name=x",
                "-c",
                "user.email=x@x",
                "commit",
                "--quiet",
                "-m",
                "crafted",
            ],
            &crafted,
        );
        git(&["push", "--quiet", "origin", "main"], &crafted);

        let b = Machine::new("b", &remote);
        b.sync.connect(&remote.url()).expect("b");
        let outcome = b.sync.pull().expect("pull");
        assert_eq!(
            outcome,
            PullOutcome::Updated(vec![
                "config.jsonc".to_owned(),
                "themes/fine.json".to_owned()
            ])
        );
        assert!(b.read("state.json").is_none());
        assert!(b.read("themes/notes.txt").is_none());
        assert!(b.read("plugins/p.js").is_none());
    }

    #[test]
    fn what_is_not_on_the_list_never_reaches_the_remote() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write("config.jsonc", "{}\n");
        a.write("themes/ok.json", "{}\n");
        a.write("state.json", "{\"session\":\"secret\"}");
        a.write("gallery.json", "{}");
        a.write("scrollback/p1.txt", "password: hunter2");
        a.write("plugins/p/plugin.json", "{}");
        a.write("themes/leak.txt", "hunter2");
        a.write("themes/Bad Name.json", "{}");
        a.write("mods/steal.js", "x");
        a.write("spaces/plain.json", "x");
        a.write(".env", "TOKEN=1");
        a.write("api.key", "sk-1");
        a.sync.connect(&remote.url()).expect("connect");
        let status = a.sync.status().expect("status");
        let pending: Vec<_> = status.pending.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(pending, vec!["config.jsonc", "themes/ok.json"]);
        a.sync.push().expect("push");
        assert_eq!(
            remote_files(&remote),
            vec!["config.jsonc".to_owned(), "themes/ok.json".to_owned()]
        );
        // Not even in the clone.
        for name in [
            "state.json",
            "gallery.json",
            "scrollback",
            "plugins",
            ".env",
            "api.key",
        ] {
            assert!(!a.sync.clone_dir().join(name).exists(), "{name}");
        }
        assert!(!a.sync.clone_dir().join("themes").join("leak.txt").exists());
    }

    #[test]
    fn a_conflict_aborts_the_merge_lists_the_paths_and_leaves_local_files_alone() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        a.write("config.jsonc", "line\nother\n");
        a.write("themes/quiet.json", "{}\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");
        b.sync.connect(&remote.url()).expect("b");
        b.sync.pull().expect("pull b");

        a.write("config.jsonc", "from a\nother\n");
        a.write("themes/quiet.json", "{\"a\":1}\n");
        a.sync.push().expect("push a again");

        b.write("config.jsonc", "from b\nother\n");
        b.write("themes/quiet.json", "{\"b\":1}\n");
        b.write("mods/mine.css", "p {}\n");
        let outcome = b.sync.pull().expect("pull b");
        assert_eq!(
            outcome,
            PullOutcome::Conflicts(vec![
                "config.jsonc".to_owned(),
                "themes/quiet.json".to_owned()
            ])
        );
        // Nothing of the config folder changed.
        assert_eq!(b.read("config.jsonc").as_deref(), Some("from b\nother\n"));
        assert_eq!(b.read("themes/quiet.json").as_deref(), Some("{\"b\":1}\n"));
        assert_eq!(b.read("mods/mine.css").as_deref(), Some("p {}\n"));
        // The merge is aborted: no merge in progress, no marker in the clone.
        let clone = b.sync.clone_dir();
        assert!(!clone.join(".git").join("MERGE_HEAD").exists());
        let clone_config = fs::read_to_string(clone.join("config.jsonc")).expect("clone file");
        assert_eq!(clone_config, "from b\nother\n");
        assert!(!clone_config.contains("<<<<<<<"));
        // A second pull says the same thing.
        assert!(matches!(b.sync.pull(), Ok(PullOutcome::Conflicts(paths)) if paths.len() == 2));
        // And push is refused until the conflict is gone.
        assert!(matches!(b.sync.push(), Err(SyncError::Rejected(_))));
        assert_eq!(remote_files(&remote).len(), 2);
    }

    #[test]
    fn a_push_the_remote_has_moved_past_is_rejected_and_a_pull_then_allows_it() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        a.write("config.jsonc", "base\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");
        b.sync.connect(&remote.url()).expect("b");
        b.sync.pull().expect("pull b");

        a.write("themes/from-a.json", "{}\n");
        a.sync.push().expect("push a");
        b.write("mods/from-b.css", "p {}\n");
        let error = b.sync.push().expect_err("rejected");
        assert!(matches!(error, SyncError::Rejected(_)), "{error}");
        assert!(error.to_string().contains("pull first"), "{error}");
        b.sync.pull().expect("pull b");
        assert!(b.sync.push().expect("push b").pushed);
    }

    #[test]
    fn a_first_pull_onto_files_that_differ_is_a_conflict_and_changes_nothing() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        // b connects while the remote is empty, then a fills the remote.
        b.write("config.jsonc", "mine\n");
        b.write("themes/only-b.json", "{}\n");
        b.sync.connect(&remote.url()).expect("b");
        a.write("config.jsonc", "theirs\n");
        a.write("themes/only-a.json", "{}\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");

        let outcome = b.sync.pull().expect("pull b");
        assert_eq!(
            outcome,
            PullOutcome::Conflicts(vec!["config.jsonc".to_owned()])
        );
        assert_eq!(b.read("config.jsonc").as_deref(), Some("mine\n"));
        assert!(b.read("themes/only-a.json").is_none());
        // Same files on both sides are not a clash: b adopts the remote.
        b.write("config.jsonc", "theirs\n");
        let outcome = b.sync.pull().expect("pull b");
        assert_eq!(
            outcome,
            PullOutcome::Updated(vec!["themes/only-a.json".to_owned()])
        );
        assert_eq!(b.read("themes/only-b.json").as_deref(), Some("{}\n"));
        assert!(b.sync.push().expect("push b").pushed);
        assert!(remote_files(&remote).contains(&"themes/only-b.json".to_owned()));
    }

    #[test]
    fn a_computer_with_its_own_config_that_joins_a_filled_remote_must_pull_before_anything_replaces_it()
     {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write("config.jsonc", "the real one\n");
        a.write("themes/shared.json", "{}\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");

        // A new computer with a config of its own connects: the clone holds the remote's files.
        let b = Machine::new("b", &remote);
        b.write("config.jsonc", "defaults\n");
        b.write("mods/mine.css", "p {}\n");
        b.sync.connect(&remote.url()).expect("b");
        let before = remote_files(&remote);
        let error = b.sync.push().expect_err("must pull first");
        assert!(matches!(error, SyncError::Rejected(_)), "{error}");
        assert!(error.to_string().contains("config.jsonc"), "{error}");
        assert_eq!(remote_files(&remote), before);
        assert_eq!(
            b.sync.pull().expect("pull"),
            PullOutcome::Conflicts(vec!["config.jsonc".to_owned()])
        );
        // Neither the config folder nor the clone changed, and the remote still has the real one.
        assert_eq!(b.read("config.jsonc").as_deref(), Some("defaults\n"));
        assert!(b.read("themes/shared.json").is_none());
        assert_eq!(
            fs::read_to_string(b.sync.clone_dir().join("config.jsonc")).expect("clone"),
            "the real one\n"
        );
        assert_eq!(b.sync.status().expect("status").ahead, 0);
        // Once the file is the same on both sides, the pull goes through and keeps the local file.
        b.write("config.jsonc", "the real one\n");
        assert_eq!(
            b.sync.pull().expect("pull"),
            PullOutcome::Updated(vec!["themes/shared.json".to_owned()])
        );
        assert_eq!(b.read("mods/mine.css").as_deref(), Some("p {}\n"));
        assert!(b.sync.push().expect("push").pushed);
    }

    #[test]
    fn a_push_from_a_clone_with_no_commit_is_refused_when_the_remote_has_settings_by_now() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        a.sync.connect(&remote.url()).expect("a");
        b.sync.connect(&remote.url()).expect("b");
        a.write("config.jsonc", "from a\n");
        a.sync.push().expect("push a");
        b.write("themes/from-b.json", "{}\n");
        let error = b.sync.push().expect_err("refused");
        assert!(matches!(error, SyncError::Rejected(_)), "{error}");
        // No history of its own was started, so the pull is a plain one and keeps the new file.
        assert_eq!(
            b.sync.pull().expect("pull"),
            PullOutcome::Updated(vec!["config.jsonc".to_owned()])
        );
        assert!(b.sync.push().expect("push").pushed);
        let files = remote_files(&remote);
        assert!(
            files.contains(&"themes/from-b.json".to_owned()),
            "{files:?}"
        );
    }

    #[test]
    fn a_file_deleted_on_one_side_is_not_deleted_on_the_other() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let b = Machine::new("b", &remote);
        a.write("themes/keep.json", "{}\n");
        a.write("config.jsonc", "x\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push a");
        b.sync.connect(&remote.url()).expect("b");
        b.sync.pull().expect("pull b");
        fs::remove_file(a.config().join("themes/keep.json")).expect("delete");
        a.write("config.jsonc", "y\n");
        a.sync.push().expect("push a");
        b.sync.pull().expect("pull b");
        assert_eq!(b.read("themes/keep.json").as_deref(), Some("{}\n"));
        assert!(remote_files(&remote).contains(&"themes/keep.json".to_owned()));
    }

    #[test]
    fn a_big_file_is_refused_and_the_clone_is_left_without_it() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write(
            "config.jsonc",
            &"x".repeat(MAX_SYNC_FILE_BYTES as usize + 1),
        );
        a.sync.connect(&remote.url()).expect("a");
        let error = a.sync.push().expect_err("too large");
        assert!(matches!(error, SyncError::FileTooLarge(_)), "{error}");
    }

    #[test]
    fn a_command_that_runs_too_long_is_stopped() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.sync.connect(&remote.url()).expect("a");
        let slow = a.sync.clone().with_timeout(Duration::from_millis(0));
        let error = slow.push().expect_err("timed out");
        assert!(
            matches!(error, SyncError::TimedOut | SyncError::Git(_)),
            "{error}"
        );
    }

    #[test]
    fn a_remote_that_is_not_a_repository_is_a_git_error_with_its_words() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        let nowhere = remote.path.with_file_name("not-there.git");
        let error = a
            .sync
            .connect(&nowhere.to_string_lossy())
            .expect_err("no such repository");
        assert!(matches!(error, SyncError::Git(_)), "{error}");
        assert!(!a.sync.clone_dir().exists());
    }

    #[test]
    fn the_folder_of_the_clone_is_never_copied_into_itself() {
        let remote = Remote::new();
        let a = Machine::new("a", &remote);
        a.write("config.jsonc", "{}\n");
        a.sync.connect(&remote.url()).expect("a");
        a.sync.push().expect("push");
        // A file the clone holds under the names of the list is not "local".
        let files = a.sync.local_files().expect("files");
        assert_eq!(files, vec!["config.jsonc".to_owned()]);
    }
}

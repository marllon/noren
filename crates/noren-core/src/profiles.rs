//! Shell profile detection.
//!
//! Detection reads the machine only through [`ProbeEnv`], so the same code runs
//! against a fake environment in tests. Paths are handled as plain strings and
//! the platform is a parameter ([`Platform`]), which lets Windows and Unix
//! detection be tested on any operating system.

use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::daemon::SshTarget;
use crate::pty::SpawnSpec;

/// How long `wsl.exe -l -q` may run before it is abandoned.
const WSL_TIMEOUT: Duration = Duration::from_secs(5);

/// A shell the user can open in a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Stable identifier, for example `pwsh`, `git-bash`, `wsl-Ubuntu`, `shell-zsh`.
    pub id: String,
    /// Human readable name.
    pub name: String,
    /// Executable to launch (an absolute path when it was found on disk).
    pub program: String,
    pub args: Vec<String>,
    /// Folder a session of this profile starts in when the call that opens it names none. `None`
    /// for a detected profile (the shell starts in the folder of the user, see
    /// [`crate::default_start_dir`]).
    pub cwd: Option<String>,
    /// Whether Noren loads its shell integration script into this shell (see
    /// [`Profile::spawn_spec_with_integration`]). `true` for every detected profile.
    pub inject_integration: bool,
    /// The machine whose `norend` runs the shell, for a profile of kind `ssh`; `None` for a shell on
    /// this machine. For such a profile `program`, `args` and `cwd` are what to run there (see
    /// [`Profile::remote_spec`]) and `inject_integration` is `false`.
    pub remote: Option<SshProfile>,
}

/// What the remote shell of an `ssh` profile runs when the profile names no program: the login shell
/// of the user on that machine (`$SHELL`, else `sh`), started as a login shell so it reads the files
/// that set the `PATH`. The daemon starts programs directly, never through a shell, so `sh -c` is
/// how a profile with no program picks `$SHELL` there.
const REMOTE_LOGIN_SHELL: (&str, [&str; 2]) = ("sh", ["-c", "exec \"${SHELL:-/bin/sh}\" -l"]);

impl Profile {
    /// Builds the [`SpawnSpec`] that opens this profile, exactly as detected (no integration).
    pub fn spawn_spec(&self, cols: u16, rows: u16) -> SpawnSpec {
        SpawnSpec {
            program: self.program.clone(),
            args: self.args.clone(),
            cwd: self.cwd.as_ref().map(PathBuf::from),
            env: Vec::new(),
            cols,
            rows,
        }
    }

    /// The [`SpawnSpec`] a profile of kind `ssh` sends to the `norend` on the other machine, and
    /// nothing else: no environment (the daemon there has its own, and a Windows `PATH` or
    /// `USERPROFILE` is wrong in a Linux shell), no folder of this machine, no shell integration
    /// script of this machine (finding 198). The program, its arguments and the folder are what the
    /// profile says; without a program it is the login shell of the user there, and without a
    /// folder the shell opens in the home folder of that user (a pseudo terminal starts a program
    /// that has no folder in the home folder).
    pub fn remote_spec(&self, cols: u16, rows: u16) -> SpawnSpec {
        let (program, args) = if is_blank(&self.program) {
            (
                REMOTE_LOGIN_SHELL.0.to_owned(),
                REMOTE_LOGIN_SHELL.1.map(str::to_owned).to_vec(),
            )
        } else {
            (self.program.clone(), self.args.clone())
        };
        SpawnSpec {
            program,
            args,
            cwd: self.cwd.as_ref().map(PathBuf::from),
            env: Vec::new(),
            cols,
            rows,
        }
    }
}

/// The machine of a profile of kind `ssh` and how to log in to it: what the `ssh` of the system needs
/// to reach a `norend` there. Names and paths only; a password or a passphrase has no place in it
/// (a key with a passphrase works through an agent).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SshProfile {
    /// A host name or an address.
    pub host: String,
    /// The user to log in as; `ssh` decides when `None`.
    pub user: Option<String>,
    /// The port of the ssh server; 22 (or what the ssh configuration says) when `None`.
    pub port: Option<u16>,
    /// The private key file (`ssh -i`). `%NAME%` is replaced by the environment variable `NAME`.
    pub identity_file: Option<String>,
    /// The known hosts file (`UserKnownHostsFile`); the user's own when `None`. `%NAME%` as above.
    pub known_hosts_file: Option<String>,
}

impl SshProfile {
    /// The target the `ssh` of the system is run for (see [`SshTarget`]): keys only, no prompt, no
    /// window. Nothing about it is kept beyond the call.
    pub fn target(&self) -> SshTarget {
        let mut target = SshTarget::new(self.host.clone());
        target.user = self.user.clone();
        target.port = self.port;
        target.identity_file = self.identity_file.as_ref().map(PathBuf::from);
        target.known_hosts_file = self.known_hosts_file.as_ref().map(PathBuf::from);
        target
    }

    /// The same machine with `%NAME%` replaced in the two paths (see [`expand_env_vars`]).
    pub fn expanded(&self, env: &dyn Fn(&str) -> Option<String>) -> Self {
        Self {
            identity_file: self
                .identity_file
                .as_ref()
                .map(|path| expand_env_vars(path, env)),
            known_hosts_file: self
                .known_hosts_file
                .as_ref()
                .map(|path| expand_env_vars(path, env)),
            ..self.clone()
        }
    }
}

/// Detected profiles plus the one to use by default.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProfileSet {
    pub profiles: Vec<Profile>,
    /// `id` of the default profile; `None` only when `profiles` is empty.
    pub default_id: Option<String>,
}

impl ProfileSet {
    pub fn default_profile(&self) -> Option<&Profile> {
        let id = self.default_id.as_deref()?;
        self.profiles.iter().find(|profile| profile.id == id)
    }

    pub fn get(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }
}

/// Which family of shells to look for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    /// The platform this binary was compiled for.
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }

    fn path_separator(self) -> char {
        match self {
            Platform::Windows => ';',
            Platform::Unix => ':',
        }
    }

    fn dir_separator(self) -> char {
        match self {
            Platform::Windows => '\\',
            Platform::Unix => '/',
        }
    }

    fn join(self, dir: &str, file: &str) -> String {
        let sep = self.dir_separator();
        format!("{}{}{}", dir.trim_end_matches(['/', '\\']), sep, file)
    }
}

/// Everything detection needs to know about the machine.
pub trait ProbeEnv {
    /// Value of an environment variable.
    fn var(&self, name: &str) -> Option<String>;
    /// Whether `path` is an existing file.
    fn file_exists(&self, path: &str) -> bool;
    /// Raw standard output of `wsl.exe -l -q`; `None` when it is missing, fails,
    /// lists nothing useful or takes too long.
    fn wsl_list(&self) -> Option<Vec<u8>>;
    /// Contents of `/etc/shells`, when readable.
    fn read_etc_shells(&self) -> Option<String>;
}

/// The real machine.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemEnv;

impl ProbeEnv for SystemEnv {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    fn file_exists(&self, path: &str) -> bool {
        std::path::Path::new(path).is_file()
    }

    fn wsl_list(&self) -> Option<Vec<u8>> {
        if !cfg!(windows) {
            return None;
        }
        run_with_timeout("wsl.exe", &["-l", "-q"], WSL_TIMEOUT)
    }

    fn read_etc_shells(&self) -> Option<String> {
        std::fs::read_to_string("/etc/shells").ok()
    }
}

/// Runs a program and returns its stdout when it exits successfully in time.
/// The child is killed on timeout. Never inherits stdin and never opens a window.
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<Vec<u8>> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + timeout;
    let output = match rx.recv_timeout(timeout) {
        Ok(output) => output,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    // Stdout closed, so the process is ending; give it the rest of the budget.
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success().then_some(output),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Detects the shells available on this machine.
pub fn detect_system_profiles() -> ProfileSet {
    detect_profiles(&SystemEnv, Platform::current())
}

/// A machine that answers as `E` does except that it never asks `wsl.exe` for its distros.
struct WithoutWsl<E>(E);

impl<E: ProbeEnv> ProbeEnv for WithoutWsl<E> {
    fn var(&self, name: &str) -> Option<String> {
        self.0.var(name)
    }

    fn file_exists(&self, path: &str) -> bool {
        self.0.file_exists(path)
    }

    fn wsl_list(&self) -> Option<Vec<u8>> {
        None
    }

    fn read_etc_shells(&self) -> Option<String> {
        self.0.read_etc_shells()
    }
}

/// The shells of this machine as [`detect_system_profiles`] finds them, without asking `wsl.exe`
/// for its distros (that takes ~70 ms and the distros come last in the list). Every profile in it
/// is the same one the full detection finds, and so is the default, unless this set has none: the
/// distros only add profiles after the others and the default is chosen among the others first. So
/// whatever starts from a profile found here starts exactly what the full detection would give it.
pub fn detect_system_profiles_without_wsl() -> ProfileSet {
    detect_profiles(&WithoutWsl(SystemEnv), Platform::current())
}

/// Detects shells through `env` for the given platform.
pub fn detect_profiles(env: &dyn ProbeEnv, platform: Platform) -> ProfileSet {
    match platform {
        Platform::Windows => detect_windows(env),
        Platform::Unix => detect_unix(env),
    }
}

fn first_existing(
    env: &dyn ProbeEnv,
    candidates: impl IntoIterator<Item = String>,
) -> Option<String> {
    candidates
        .into_iter()
        .find(|candidate| env.file_exists(candidate))
}

/// Candidate locations of `exe` in every `PATH` directory.
fn path_candidates(env: &dyn ProbeEnv, platform: Platform, exe: &str) -> Vec<String> {
    let path = env
        .var("PATH")
        .or_else(|| env.var("Path"))
        .unwrap_or_default();
    path.split(platform.path_separator())
        .map(|dir| dir.trim().trim_matches('"'))
        .filter(|dir| !dir.is_empty())
        .map(|dir| platform.join(dir, exe))
        .collect()
}

fn detect_windows(env: &dyn ProbeEnv) -> ProfileSet {
    let platform = Platform::Windows;
    let program_files = env
        .var("ProgramFiles")
        .unwrap_or_else(|| "C:\\Program Files".to_string());
    let system_root = env
        .var("SystemRoot")
        .unwrap_or_else(|| "C:\\Windows".to_string());
    let system32 = platform.join(&system_root, "System32");
    let mut profiles = Vec::new();

    let mut pwsh_candidates = path_candidates(env, platform, "pwsh.exe");
    pwsh_candidates.push("C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string());
    pwsh_candidates.push(platform.join(&program_files, "PowerShell\\7\\pwsh.exe"));
    if let Some(program) = first_existing(env, pwsh_candidates) {
        profiles.push(Profile {
            id: "pwsh".into(),
            name: "PowerShell 7".into(),
            program,
            args: Vec::new(),
            cwd: None,
            inject_integration: true,
            remote: None,
        });
    }

    let powershell_candidates =
        vec![platform.join(&system32, "WindowsPowerShell\\v1.0\\powershell.exe")];
    let powershell_candidates =
        powershell_candidates
            .into_iter()
            .chain(path_candidates(env, platform, "powershell.exe"));
    if let Some(program) = first_existing(env, powershell_candidates) {
        profiles.push(Profile {
            id: "powershell".into(),
            name: "Windows PowerShell".into(),
            program,
            args: Vec::new(),
            cwd: None,
            inject_integration: true,
            remote: None,
        });
    }

    let cmd_candidates = env
        .var("ComSpec")
        .into_iter()
        .chain([platform.join(&system32, "cmd.exe")]);
    if let Some(program) = first_existing(env, cmd_candidates) {
        profiles.push(Profile {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            program,
            args: Vec::new(),
            cwd: None,
            inject_integration: true,
            remote: None,
        });
    }

    let git_bash = [
        "C:\\Program Files\\Git\\bin\\bash.exe".to_string(),
        platform.join(&program_files, "Git\\bin\\bash.exe"),
    ];
    if let Some(program) = first_existing(env, git_bash) {
        profiles.push(Profile {
            id: "git-bash".into(),
            name: "Git Bash".into(),
            program,
            args: vec!["--login".into(), "-i".into()],
            cwd: None,
            inject_integration: true,
            remote: None,
        });
    }

    if let Some(raw) = env.wsl_list() {
        let mut seen = HashSet::new();
        for distro in parse_wsl_list(&raw) {
            if seen.insert(distro.clone()) {
                profiles.push(Profile {
                    id: format!("wsl-{distro}"),
                    name: format!("WSL: {distro}"),
                    program: "wsl.exe".into(),
                    args: vec!["-d".into(), distro],
                    cwd: None,
                    inject_integration: true,
                    remote: None,
                });
            }
        }
    }

    let default_id = ["pwsh", "powershell", "cmd"]
        .into_iter()
        .find(|id| profiles.iter().any(|profile| profile.id == *id))
        .map(str::to_string)
        .or_else(|| profiles.first().map(|profile| profile.id.clone()));
    ProfileSet {
        profiles,
        default_id,
    }
}

/// Decodes the output of `wsl.exe -l -q` into distro names.
///
/// `wsl.exe` writes UTF-16LE, usually with a byte order mark and CRLF line
/// endings. Output without NUL bytes is read as UTF-8 (`WSL_UTF8=1`).
pub fn parse_wsl_list(raw: &[u8]) -> Vec<String> {
    let raw = raw.strip_prefix(&[0xFF, 0xFE]).unwrap_or(raw);
    let text = if raw.contains(&0) {
        let units: Vec<u16> = raw
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };
    text.replace(['\0', '\u{feff}', '\r'], "")
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn detect_unix(env: &dyn ProbeEnv) -> ProfileSet {
    let login_shell = env.var("SHELL");
    let listed = env
        .read_etc_shells()
        .map(|text| parse_etc_shells(&text))
        .unwrap_or_default();

    let mut profiles: Vec<Profile> = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut seen_ids = HashSet::new();

    for path in login_shell.iter().cloned().chain(listed) {
        if !path.starts_with('/') || !seen_paths.insert(path.clone()) || !env.file_exists(&path) {
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or(&path).to_string();
        let id = format!("shell-{name}");
        // Merged-usr systems list the same shell as /bin/x and /usr/bin/x.
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        profiles.push(Profile {
            id,
            name,
            program: path,
            args: Vec::new(),
            cwd: None,
            inject_integration: true,
            remote: None,
        });
    }

    let default_id = profiles
        .iter()
        .find(|profile| Some(&profile.program) == login_shell.as_ref())
        .or_else(|| profiles.first())
        .map(|profile| profile.id.clone());
    ProfileSet {
        profiles,
        default_id,
    }
}

/// Paths listed in `/etc/shells`, without comments, blank lines or duplicates.
pub fn parse_etc_shells(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.lines()
        .map(|line| line.split('#').next().unwrap_or("").trim())
        .filter(|line| !line.is_empty())
        .filter(|line| seen.insert(line.to_string()))
        .map(str::to_string)
        .collect()
}

/// The id a pane uses to say "the profile the machine defaults to": no profile of the user may take it.
pub const RESERVED_PROFILE_ID: &str = "default";

/// The most profiles of the user the interface may hand over.
pub const MAX_USER_PROFILES: usize = 200;

const MAX_ID_LEN: usize = 64;
const MAX_NAME_CHARS: usize = 100;
const MAX_TEXT_CHARS: usize = 1024;
const MAX_ARGS: usize = 200;
const MAX_ARG_CHARS: usize = 4096;

/// A shell profile the user defined (the `profiles` list of `config.jsonc`), as the interface sends
/// it. It joins the detected ones through [`ProfileSet::with_user_profiles`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserProfile {
    /// Lower case words joined by hyphens, unique among all the profiles.
    pub id: String,
    /// Name shown in the interface.
    pub name: String,
    /// Executable to launch. `%NAME%` is replaced by the environment variable `NAME`. For an
    /// `ssh` profile it is the program on the other machine, taken as written, and may be empty
    /// (the login shell of the user there).
    pub program: String,
    pub args: Vec<String>,
    /// Folder a session starts in unless the call that opens it names one. For an `ssh` profile
    /// it is a folder on the other machine, taken as written.
    pub cwd: Option<String>,
    /// The machine, for a profile of kind `ssh`; `None` for a shell on this machine.
    pub ssh: Option<SshProfile>,
}

/// Why a list of profiles of the user was refused. The text names the profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserProfileError {
    /// More than [`MAX_USER_PROFILES`].
    TooMany(usize),
    /// The id is not lower case words joined by hyphens (or is longer than 64 characters).
    InvalidId(String),
    /// The id is [`RESERVED_PROFILE_ID`].
    ReservedId(String),
    /// Two profiles of the user have this id.
    DuplicateId(String),
    /// A shell found on the machine has this id.
    DetectedId(String),
    /// The name is empty or only blanks, or too long.
    InvalidName(String),
    /// The program is empty or only blanks, or too long.
    EmptyProgram(String),
    /// An argument or the folder is too long, empty, or has a NUL character; the text says which.
    InvalidField(String, &'static str),
    /// The machine of an `ssh` profile cannot be put on a command line (the text says why: a host
    /// that could be taken for an option, a port of 0, a path with a control character).
    InvalidSsh(String, String),
}

impl std::fmt::Display for UserProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooMany(count) => {
                write!(
                    f,
                    "{count} profiles; at most {MAX_USER_PROFILES} are allowed"
                )
            }
            Self::InvalidId(id) => write!(
                f,
                "profile id '{id}' is not lower case words joined by hyphens (at most {MAX_ID_LEN} characters)"
            ),
            Self::ReservedId(id) => write!(f, "profile id '{id}' is reserved"),
            Self::DuplicateId(id) => write!(f, "profile id '{id}' is used by two profiles"),
            Self::DetectedId(id) => {
                write!(
                    f,
                    "profile id '{id}' is already a shell found on this machine"
                )
            }
            Self::InvalidName(id) => write!(
                f,
                "profile '{id}': the name is empty or longer than {MAX_NAME_CHARS} characters"
            ),
            Self::EmptyProgram(id) => write!(
                f,
                "profile '{id}': the program is empty or longer than {MAX_TEXT_CHARS} characters"
            ),
            Self::InvalidField(id, field) => write!(f, "profile '{id}': {field}"),
            Self::InvalidSsh(id, why) => write!(f, "profile '{id}': {why}"),
        }
    }
}

impl std::error::Error for UserProfileError {}

fn is_valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

impl UserProfile {
    /// Checks the profile by itself (not against the other profiles).
    pub fn validate(&self) -> Result<(), UserProfileError> {
        let id = &self.id;
        if !is_valid_profile_id(id) {
            return Err(UserProfileError::InvalidId(id.clone()));
        }
        if id == RESERVED_PROFILE_ID {
            return Err(UserProfileError::ReservedId(id.clone()));
        }
        if is_blank(&self.name)
            || self.name.chars().count() > MAX_NAME_CHARS
            || self.name.contains('\0')
        {
            return Err(UserProfileError::InvalidName(id.clone()));
        }
        // A shell on this machine needs a program; a remote one may leave it to the login shell.
        let program_missing = if self.ssh.is_some() {
            !self.program.is_empty() && is_blank(&self.program)
        } else {
            is_blank(&self.program)
        };
        if program_missing
            || self.program.chars().count() > MAX_TEXT_CHARS
            || self.program.contains('\0')
        {
            return Err(UserProfileError::EmptyProgram(id.clone()));
        }
        if self.args.len() > MAX_ARGS {
            return Err(UserProfileError::InvalidField(
                id.clone(),
                "too many arguments",
            ));
        }
        if self
            .args
            .iter()
            .any(|arg| arg.chars().count() > MAX_ARG_CHARS || arg.contains('\0'))
        {
            return Err(UserProfileError::InvalidField(
                id.clone(),
                "an argument is too long or has a NUL character",
            ));
        }
        if let Some(cwd) = &self.cwd
            && (is_blank(cwd) || cwd.chars().count() > MAX_TEXT_CHARS || cwd.contains('\0'))
        {
            return Err(UserProfileError::InvalidField(
                id.clone(),
                "the folder is empty, too long or has a NUL character",
            ));
        }
        if let Some(ssh) = &self.ssh {
            ssh.target()
                .validate()
                .map_err(|e| UserProfileError::InvalidSsh(id.clone(), e.to_string()))?;
        }
        Ok(())
    }

    /// The profile as a session starts it: `%NAME%` in the program, the arguments and the folder
    /// is replaced through `env` (see [`expand_env_vars`]). The shell integration stays on, as for
    /// a detected profile; it only does anything for the shells it knows.
    ///
    /// An `ssh` profile is different: what it runs, and where, is on the other machine, so the
    /// program, the arguments and the folder are kept as written (a `%` in them is not a variable
    /// of this machine) and nothing of this machine's shell integration is loaded; only the two
    /// files it names are on this machine, and those have their `%NAME%` replaced.
    pub fn to_profile(&self, env: &dyn Fn(&str) -> Option<String>) -> Profile {
        if let Some(ssh) = &self.ssh {
            return Profile {
                id: self.id.clone(),
                name: self.name.clone(),
                program: self.program.clone(),
                args: self.args.clone(),
                cwd: self.cwd.clone(),
                inject_integration: false,
                remote: Some(ssh.expanded(env)),
            };
        }
        Profile {
            id: self.id.clone(),
            name: self.name.clone(),
            program: expand_env_vars(&self.program, env),
            args: self
                .args
                .iter()
                .map(|arg| expand_env_vars(arg, env))
                .collect(),
            cwd: self.cwd.as_ref().map(|cwd| expand_env_vars(cwd, env)),
            inject_integration: true,
            remote: None,
        }
    }
}

/// Replaces each `%NAME%` in `text` with the value of the environment variable `NAME` (as `env`
/// answers). A name `env` does not know, and a `%` with no partner, stay as written.
pub fn expand_env_vars(text: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end)
                if end > 0
                    && !after[..end]
                        .contains(|c: char| c.is_whitespace() || c == '=' || c == '"') =>
            {
                let name = &after[..end];
                match env(name) {
                    Some(value) => out.push_str(&value),
                    None => out.push_str(&rest[start..start + end + 2]),
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

impl ProfileSet {
    /// This set (the detected shells) followed by `user`, in the order given. The default stays the
    /// detected one; with none detected, the first profile of the user is the default.
    ///
    /// The whole list is refused, and nothing is joined, when any profile is not valid
    /// ([`UserProfile::validate`], an empty program for one), when an id repeats, or when an id is
    /// one of the detected shells. `env` answers `%NAME%` in the programs, arguments and folders.
    pub fn with_user_profiles(
        &self,
        user: &[UserProfile],
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ProfileSet, UserProfileError> {
        if user.len() > MAX_USER_PROFILES {
            return Err(UserProfileError::TooMany(user.len()));
        }
        let mut seen = HashSet::new();
        for profile in user {
            profile.validate()?;
            if self.get(&profile.id).is_some() {
                return Err(UserProfileError::DetectedId(profile.id.clone()));
            }
            if !seen.insert(profile.id.as_str()) {
                return Err(UserProfileError::DuplicateId(profile.id.clone()));
            }
        }
        let mut profiles = self.profiles.clone();
        profiles.extend(user.iter().map(|profile| profile.to_profile(env)));
        Ok(ProfileSet {
            // The default is a shell of this machine: a profile on another machine needs a login
            // and a connection, which nothing should start without being asked.
            default_id: self.default_id.clone().or_else(|| {
                user.iter()
                    .find(|profile| profile.ssh.is_none())
                    .map(|profile| profile.id.clone())
            }),
            profiles,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// Fake machine: only what the test sets up exists.
    #[derive(Default)]
    struct FakeEnv {
        vars: HashMap<String, String>,
        files: HashSet<String>,
        wsl: Option<Vec<u8>>,
        shells: Option<String>,
    }

    impl FakeEnv {
        fn var(mut self, name: &str, value: &str) -> Self {
            self.vars.insert(name.into(), value.into());
            self
        }

        fn file(mut self, path: &str) -> Self {
            self.files.insert(path.into());
            self
        }
    }

    impl ProbeEnv for FakeEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).cloned()
        }

        fn file_exists(&self, path: &str) -> bool {
            self.files.contains(path)
        }

        fn wsl_list(&self) -> Option<Vec<u8>> {
            self.wsl.clone()
        }

        fn read_etc_shells(&self) -> Option<String> {
            self.shells.clone()
        }
    }

    fn utf16le(text: &str, bom: bool) -> Vec<u8> {
        let mut bytes = if bom { vec![0xFF, 0xFE] } else { Vec::new() };
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    fn windows_base() -> FakeEnv {
        FakeEnv::default()
            .var("SystemRoot", "C:\\Windows")
            .var("ComSpec", "C:\\Windows\\System32\\cmd.exe")
            .file("C:\\Windows\\System32\\cmd.exe")
            .file("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    }

    fn ids(set: &ProfileSet) -> Vec<&str> {
        set.profiles.iter().map(|p| p.id.as_str()).collect()
    }

    #[test]
    fn windows_with_pwsh_defaults_to_pwsh() {
        let env = windows_base()
            .var("PATH", "C:\\Tools;C:\\Apps\\PS7")
            .file("C:\\Apps\\PS7\\pwsh.exe")
            .file("C:\\Program Files\\Git\\bin\\bash.exe");
        let set = detect_profiles(&env, Platform::Windows);
        assert_eq!(ids(&set), ["pwsh", "powershell", "cmd", "git-bash"]);
        assert_eq!(set.default_id.as_deref(), Some("pwsh"));
        assert_eq!(
            set.default_profile().unwrap().program,
            "C:\\Apps\\PS7\\pwsh.exe"
        );
        assert_eq!(set.get("git-bash").unwrap().args, ["--login", "-i"]);
    }

    #[test]
    fn windows_finds_pwsh_in_default_install_dir() {
        let env = windows_base().file("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
        let set = detect_profiles(&env, Platform::Windows);
        assert_eq!(set.default_id.as_deref(), Some("pwsh"));
    }

    #[test]
    fn windows_without_pwsh_defaults_to_powershell() {
        let env = windows_base().var("PATH", "C:\\Tools");
        let set = detect_profiles(&env, Platform::Windows);
        assert_eq!(ids(&set), ["powershell", "cmd"]);
        assert_eq!(set.default_id.as_deref(), Some("powershell"));
    }

    #[test]
    fn windows_with_only_cmd_defaults_to_cmd() {
        let env = FakeEnv::default().file("C:\\Windows\\System32\\cmd.exe");
        let set = detect_profiles(&env, Platform::Windows);
        assert_eq!(ids(&set), ["cmd"]);
        assert_eq!(set.default_id.as_deref(), Some("cmd"));
    }

    #[test]
    fn windows_with_nothing_has_no_default() {
        let set = detect_profiles(&FakeEnv::default(), Platform::Windows);
        assert!(set.profiles.is_empty());
        assert_eq!(set.default_id, None);
        assert!(set.default_profile().is_none());
    }

    #[test]
    fn two_wsl_distros_in_utf16le_with_bom_and_crlf() {
        let mut env = windows_base();
        env.wsl = Some(utf16le("Ubuntu-22.04\r\nDebian\r\n\r\n", true));
        let set = detect_profiles(&env, Platform::Windows);
        let wsl: Vec<&Profile> = set
            .profiles
            .iter()
            .filter(|p| p.id.starts_with("wsl-"))
            .collect();
        assert_eq!(wsl.len(), 2);
        assert_eq!(wsl[0].id, "wsl-Ubuntu-22.04");
        assert_eq!(wsl[0].program, "wsl.exe");
        assert_eq!(wsl[0].args, ["-d", "Ubuntu-22.04"]);
        assert_eq!(wsl[1].id, "wsl-Debian");
        // WSL never becomes the default while a Windows shell exists.
        assert_eq!(set.default_id.as_deref(), Some("powershell"));
    }

    #[test]
    fn wsl_parsing_edge_cases() {
        assert_eq!(parse_wsl_list(&utf16le("A\r\nA\r\n", false)), ["A", "A"]);
        assert_eq!(parse_wsl_list(b"Alpine\r\nArch\n"), ["Alpine", "Arch"]);
        assert!(parse_wsl_list(&[]).is_empty());
        assert!(parse_wsl_list(&[0xFF, 0xFE]).is_empty());
        // Odd trailing byte is ignored instead of panicking.
        assert_eq!(parse_wsl_list(&[b'A', 0, b'\n', 0, b'B']), ["A"]);
    }

    #[test]
    fn duplicate_wsl_distros_become_one_profile() {
        let env = FakeEnv {
            wsl: Some(utf16le("Debian\r\nDebian\r\n", true)),
            ..FakeEnv::default()
        };
        let set = detect_profiles(&env, Platform::Windows);
        assert_eq!(ids(&set), ["wsl-Debian"]);
        assert_eq!(set.default_id.as_deref(), Some("wsl-Debian"));
    }

    #[test]
    fn the_set_without_wsl_is_the_full_set_less_the_distros_with_the_same_default() {
        let mut machine = windows_base()
            .var("PATH", "C:\\Tools;C:\\Apps\\PS7")
            .file("C:\\Apps\\PS7\\pwsh.exe")
            .file("C:\\Program Files\\Git\\bin\\bash.exe");
        machine.wsl = Some(utf16le("Ubuntu\r\nDebian\r\n", true));
        let full = detect_profiles(&machine, Platform::Windows);
        let without = detect_profiles(&WithoutWsl(machine), Platform::Windows);
        assert_eq!(
            ids(&full),
            [
                "pwsh",
                "powershell",
                "cmd",
                "git-bash",
                "wsl-Ubuntu",
                "wsl-Debian"
            ]
        );
        assert_eq!(ids(&without), ["pwsh", "powershell", "cmd", "git-bash"]);
        // The profiles that are in both are the same ones, and so is the default.
        for profile in &without.profiles {
            assert_eq!(full.get(&profile.id), Some(profile));
        }
        assert_eq!(without.default_id, full.default_id);
    }

    #[test]
    fn the_set_without_wsl_has_no_default_when_the_distros_are_all_there_is() {
        let machine = FakeEnv {
            wsl: Some(utf16le("Ubuntu\r\n", true)),
            ..FakeEnv::default()
        };
        let full = detect_profiles(&machine, Platform::Windows);
        let without = detect_profiles(&WithoutWsl(machine), Platform::Windows);
        assert_eq!(full.default_id.as_deref(), Some("wsl-Ubuntu"));
        assert_eq!(without.default_id, None);
        assert!(without.default_profile().is_none());
    }

    #[test]
    fn linux_with_zsh_defaults_to_zsh_without_duplicates() {
        let mut env = FakeEnv::default()
            .var("SHELL", "/usr/bin/zsh")
            .file("/bin/bash")
            .file("/usr/bin/zsh");
        env.shells = Some(
            "# /etc/shells: valid login shells\n\n/bin/bash\n/usr/bin/zsh  # comment\n/usr/bin/zsh\n/bin/missing\n"
                .into(),
        );
        let set = detect_profiles(&env, Platform::Unix);
        assert_eq!(ids(&set), ["shell-zsh", "shell-bash"]);
        assert_eq!(set.default_id.as_deref(), Some("shell-zsh"));
        assert_eq!(set.default_profile().unwrap().program, "/usr/bin/zsh");
    }

    #[test]
    fn unix_without_shell_variable_defaults_to_first_listed() {
        let mut env = FakeEnv::default().file("/bin/bash").file("/usr/bin/fish");
        env.shells = Some("/bin/bash\n/usr/bin/fish\n".into());
        let set = detect_profiles(&env, Platform::Unix);
        assert_eq!(set.default_id.as_deref(), Some("shell-bash"));
    }

    #[test]
    fn unix_skips_same_shell_listed_under_two_prefixes() {
        let mut env = FakeEnv::default()
            .var("SHELL", "/usr/bin/bash")
            .file("/bin/bash")
            .file("/usr/bin/bash");
        env.shells = Some("/bin/bash\n/usr/bin/bash\n".into());
        let set = detect_profiles(&env, Platform::Unix);
        assert_eq!(ids(&set), ["shell-bash"]);
        assert_eq!(set.default_profile().unwrap().program, "/usr/bin/bash");
    }

    #[test]
    fn unix_ignores_missing_shell_variable_file() {
        let mut env = FakeEnv::default()
            .var("SHELL", "/gone/zsh")
            .file("/bin/bash");
        env.shells = Some("/bin/bash\n".into());
        let set = detect_profiles(&env, Platform::Unix);
        assert_eq!(ids(&set), ["shell-bash"]);
        assert_eq!(set.default_id.as_deref(), Some("shell-bash"));
    }

    #[test]
    fn profile_converts_to_spawn_spec() {
        let profile = Profile {
            id: "git-bash".into(),
            name: "Git Bash".into(),
            program: "bash.exe".into(),
            args: vec!["--login".into(), "-i".into()],
            cwd: None,
            inject_integration: true,
            remote: None,
        };
        let spec = profile.spawn_spec(100, 30);
        assert_eq!(spec.program, "bash.exe");
        assert_eq!(spec.args, ["--login", "-i"]);
        assert_eq!(spec.cwd, None);
        assert_eq!((spec.cols, spec.rows), (100, 30));
    }

    #[test]
    fn profile_with_a_folder_starts_there() {
        let profile = Profile {
            id: "dev".into(),
            name: "Dev".into(),
            program: "sh".into(),
            args: Vec::new(),
            cwd: Some("/work".into()),
            inject_integration: true,
            remote: None,
        };
        assert_eq!(
            profile.spawn_spec(80, 24).cwd,
            Some(std::path::PathBuf::from("/work"))
        );
    }

    fn user(id: &str, program: &str) -> UserProfile {
        UserProfile {
            id: id.into(),
            name: format!("Name of {id}"),
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            ssh: None,
        }
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn detected() -> ProfileSet {
        detect_profiles(&windows_base(), Platform::Windows)
    }

    #[test]
    fn user_profiles_follow_the_detected_ones_in_one_list() {
        let detected = detected();
        assert_eq!(ids(&detected), ["powershell", "cmd"]);
        let mut dev = user("dev-shell", "pwsh.exe");
        dev.args = vec!["-NoLogo".into()];
        dev.cwd = Some("C:\\work".into());
        let set = detected
            .with_user_profiles(&[dev, user("other", "sh")], &no_env)
            .expect("valid");
        assert_eq!(ids(&set), ["powershell", "cmd", "dev-shell", "other"]);
        // The default is still the detected one.
        assert_eq!(set.default_id.as_deref(), Some("powershell"));
        let dev = set.get("dev-shell").expect("listed");
        assert_eq!(dev.name, "Name of dev-shell");
        assert_eq!(dev.program, "pwsh.exe");
        assert_eq!(dev.args, ["-NoLogo"]);
        assert_eq!(dev.cwd.as_deref(), Some("C:\\work"));
        // A session of it starts what the profile says.
        let spec = dev.spawn_spec(90, 20);
        assert_eq!(spec.program, "pwsh.exe");
        assert_eq!(spec.args, ["-NoLogo"]);
        assert_eq!(spec.cwd, Some(std::path::PathBuf::from("C:\\work")));
        // The detected set itself is untouched.
        assert_eq!(ids(&detected), ["powershell", "cmd"]);
    }

    #[test]
    fn no_user_profiles_leave_the_detected_list_as_it_was() {
        let detected = detected();
        assert_eq!(
            detected.with_user_profiles(&[], &no_env).expect("valid"),
            detected
        );
    }

    #[test]
    fn the_first_profile_of_the_user_is_the_default_when_nothing_was_detected() {
        let set = ProfileSet::default()
            .with_user_profiles(&[user("a", "sh"), user("b", "sh")], &no_env)
            .expect("valid");
        assert_eq!(set.default_id.as_deref(), Some("a"));
    }

    #[test]
    fn an_empty_program_is_refused_and_so_is_a_blank_one() {
        for program in ["", "   ", "\t"] {
            let error = detected()
                .with_user_profiles(&[user("ok", "sh"), user("bad", program)], &no_env)
                .expect_err("refused");
            assert_eq!(error, UserProfileError::EmptyProgram("bad".into()));
            assert!(error.to_string().contains("bad"), "{error}");
        }
    }

    #[test]
    fn one_bad_profile_refuses_the_whole_list() {
        let mut no_name = user("no-name", "sh");
        no_name.name = "  ".into();
        let mut nul_arg = user("nul-arg", "sh");
        nul_arg.args = vec!["a\0b".into()];
        let nul_program = user("nul-program", "sh\0");
        let mut blank_cwd = user("blank-cwd", "sh");
        blank_cwd.cwd = Some(" ".into());
        let mut many_args = user("many-args", "sh");
        many_args.args = vec!["x".into(); MAX_ARGS + 1];
        for (profile, wanted) in [
            (no_name, UserProfileError::InvalidName("no-name".into())),
            (
                nul_arg,
                UserProfileError::InvalidField(
                    "nul-arg".into(),
                    "an argument is too long or has a NUL character",
                ),
            ),
            (
                nul_program,
                UserProfileError::EmptyProgram("nul-program".into()),
            ),
            (
                blank_cwd,
                UserProfileError::InvalidField(
                    "blank-cwd".into(),
                    "the folder is empty, too long or has a NUL character",
                ),
            ),
            (
                many_args,
                UserProfileError::InvalidField("many-args".into(), "too many arguments"),
            ),
        ] {
            assert_eq!(
                detected().with_user_profiles(&[profile], &no_env),
                Err(wanted)
            );
        }
    }

    #[test]
    fn ids_must_be_ids_and_unique_and_not_a_detected_shell() {
        for bad in [
            "",
            "Dev",
            "dev shell",
            "dev_shell",
            "-dev",
            "dev-",
            "a--b",
            "../x",
            "é",
        ] {
            assert_eq!(
                detected().with_user_profiles(&[user(bad, "sh")], &no_env),
                Err(UserProfileError::InvalidId(bad.into())),
                "{bad:?}"
            );
        }
        assert_eq!(
            detected().with_user_profiles(&[user(&"a".repeat(65), "sh")], &no_env),
            Err(UserProfileError::InvalidId("a".repeat(65)))
        );
        assert_eq!(
            detected().with_user_profiles(&[user("default", "sh")], &no_env),
            Err(UserProfileError::ReservedId("default".into()))
        );
        assert_eq!(
            detected().with_user_profiles(&[user("x", "sh"), user("x", "bash")], &no_env),
            Err(UserProfileError::DuplicateId("x".into()))
        );
        // "cmd" and "powershell" are shells of this machine.
        assert_eq!(
            detected().with_user_profiles(&[user("cmd", "sh")], &no_env),
            Err(UserProfileError::DetectedId("cmd".into()))
        );
    }

    #[test]
    fn too_many_profiles_are_refused() {
        let many: Vec<UserProfile> = (0..=MAX_USER_PROFILES)
            .map(|n| user(&format!("p{n}"), "sh"))
            .collect();
        assert_eq!(
            detected().with_user_profiles(&many, &no_env),
            Err(UserProfileError::TooMany(MAX_USER_PROFILES + 1))
        );
        assert!(
            detected()
                .with_user_profiles(&many[..MAX_USER_PROFILES], &no_env)
                .is_ok()
        );
    }

    #[test]
    fn variables_in_the_program_arguments_and_folder_are_replaced_when_joined() {
        let env = |name: &str| match name {
            "SystemRoot" => Some("C:\\Windows".to_owned()),
            "USERPROFILE" => Some("C:\\Users\\me".to_owned()),
            _ => None,
        };
        let mut profile = user("ps", "%SystemRoot%\\System32\\cmd.exe");
        profile.args = vec!["/k".into(), "cd %USERPROFILE%".into(), "%NOPE%".into()];
        profile.cwd = Some("%USERPROFILE%".into());
        let set = detected()
            .with_user_profiles(&[profile], &env)
            .expect("valid");
        let joined = set.get("ps").expect("listed");
        assert_eq!(joined.program, "C:\\Windows\\System32\\cmd.exe");
        assert_eq!(joined.args, ["/k", "cd C:\\Users\\me", "%NOPE%"]);
        assert_eq!(joined.cwd.as_deref(), Some("C:\\Users\\me"));
    }

    #[test]
    fn expanding_variables_leaves_what_it_does_not_know_as_written() {
        let env = |name: &str| (name == "HOME").then(|| "/home/me".to_owned());
        let cases = [
            ("%HOME%", "/home/me"),
            ("%HOME%/%HOME%", "/home/me//home/me"),
            ("%UNKNOWN%", "%UNKNOWN%"),
            ("%UNKNOWN%x%HOME%", "%UNKNOWN%x/home/me"),
            ("100%", "100%"),
            ("%", "%"),
            ("%%", "%%"),
            ("a % b %HOME%", "a % b /home/me"),
            ("%a b%", "%a b%"),
            ("no variables", "no variables"),
            ("", ""),
            ("%HOME", "%HOME"),
            ("é%HOME%é", "é/home/meé"),
        ];
        for (text, wanted) in cases {
            assert_eq!(expand_env_vars(text, &env), wanted, "{text:?}");
        }
    }

    // ----- profiles of kind ssh (NOR-F14-04b) -----

    fn ssh_machine() -> SshProfile {
        SshProfile {
            host: "build.example.org".into(),
            user: Some("deploy".into()),
            port: Some(2222),
            identity_file: Some("%USERPROFILE%\\.ssh\\id_ed25519".into()),
            known_hosts_file: Some("%USERPROFILE%\\.ssh\\known_hosts_noren".into()),
        }
    }

    fn ssh_user(id: &str) -> UserProfile {
        UserProfile {
            id: id.into(),
            name: format!("Name of {id}"),
            program: String::new(),
            args: Vec::new(),
            cwd: None,
            ssh: Some(ssh_machine()),
        }
    }

    #[test]
    fn an_ssh_profile_needs_a_machine_and_no_program() {
        assert_eq!(ssh_user("box").validate(), Ok(()));
        let mut with_program = ssh_user("box");
        with_program.program = "bash".into();
        with_program.args = vec!["-l".into()];
        with_program.cwd = Some("/srv/app".into());
        assert_eq!(with_program.validate(), Ok(()));
        // A program that is only blanks is a mistake; an empty one means the login shell.
        let mut blank = ssh_user("box");
        blank.program = "   ".into();
        assert_eq!(
            blank.validate(),
            Err(UserProfileError::EmptyProgram("box".into()))
        );
        // A shell of this machine still needs its program.
        let mut shell = user("sh", "");
        assert_eq!(
            shell.validate(),
            Err(UserProfileError::EmptyProgram("sh".into()))
        );
        shell.program = "sh".into();
        assert_eq!(shell.validate(), Ok(()));
    }

    #[test]
    fn an_ssh_profile_whose_machine_cannot_go_on_a_command_line_is_refused() {
        type Change = fn(&mut SshProfile);
        let cases: [(&str, Change); 7] = [
            ("a host that is an option", |m| {
                m.host = "-oProxyCommand=x".into()
            }),
            ("an empty host", |m| m.host = String::new()),
            ("a host with a space", |m| m.host = "a b".into()),
            ("a user that is an option", |m| m.user = Some("-x".into())),
            ("a port of 0", |m| m.port = Some(0)),
            ("a key path with a newline", |m| {
                m.identity_file = Some("a\nb".into())
            }),
            ("an empty known hosts path", |m| {
                m.known_hosts_file = Some(String::new())
            }),
        ];
        for (what, change) in cases {
            let mut profile = ssh_user("box");
            change(profile.ssh.as_mut().expect("ssh"));
            let error = profile.validate().expect_err(what);
            assert!(
                matches!(&error, UserProfileError::InvalidSsh(id, _) if id == "box"),
                "{what}: {error:?}"
            );
            assert!(error.to_string().starts_with("profile 'box': "), "{what}");
        }
    }

    #[test]
    fn an_ssh_profile_joins_the_list_and_is_never_the_default() {
        let detected = detected();
        let set = detected
            .with_user_profiles(&[ssh_user("box"), user("sh", "sh")], &no_env)
            .expect("valid");
        assert_eq!(ids(&set), ["powershell", "cmd", "box", "sh"]);
        assert_eq!(set.default_id.as_deref(), Some("powershell"));
        assert!(set.get("box").expect("listed").remote.is_some());
        assert!(set.get("sh").expect("listed").remote.is_none());
        // With nothing detected the default is the first shell of this machine, not the ssh one.
        let only = ProfileSet::default()
            .with_user_profiles(&[ssh_user("box"), user("sh", "sh")], &no_env)
            .expect("valid");
        assert_eq!(only.default_id.as_deref(), Some("sh"));
        // With nothing but ssh profiles there is no default at all.
        let none = ProfileSet::default()
            .with_user_profiles(&[ssh_user("box")], &no_env)
            .expect("valid");
        assert_eq!(none.default_id, None);
        // The id rules are the same for both kinds.
        assert_eq!(
            detected.with_user_profiles(&[ssh_user("cmd")], &no_env),
            Err(UserProfileError::DetectedId("cmd".into()))
        );
        assert_eq!(
            detected.with_user_profiles(&[ssh_user("box"), user("box", "sh")], &no_env),
            Err(UserProfileError::DuplicateId("box".into()))
        );
    }

    #[test]
    fn only_the_two_files_of_an_ssh_profile_have_their_variables_replaced() {
        let env = |name: &str| match name {
            "USERPROFILE" => Some("C:\\Users\\me".to_owned()),
            "HOME" => Some("C:\\wrong".to_owned()),
            _ => None,
        };
        let mut profile = ssh_user("box");
        profile.program = "printf".into();
        profile.args = vec!["%s %HOME%".into()];
        profile.cwd = Some("/srv/%HOME%".into());
        let joined = ProfileSet::default()
            .with_user_profiles(&[profile], &env)
            .expect("valid");
        let box_profile = joined.get("box").expect("listed");
        let remote = box_profile.remote.as_ref().expect("remote");
        assert_eq!(
            remote.identity_file.as_deref(),
            Some("C:\\Users\\me\\.ssh\\id_ed25519")
        );
        assert_eq!(
            remote.known_hosts_file.as_deref(),
            Some("C:\\Users\\me\\.ssh\\known_hosts_noren")
        );
        // What runs on the other machine is the profile's word, not this machine's variables.
        assert_eq!(box_profile.program, "printf");
        assert_eq!(box_profile.args, ["%s %HOME%"]);
        assert_eq!(box_profile.cwd.as_deref(), Some("/srv/%HOME%"));
        assert!(!box_profile.inject_integration);
    }

    #[test]
    fn the_machine_of_an_ssh_profile_becomes_the_target_of_the_ssh_of_the_system() {
        let target = ssh_machine().target();
        assert_eq!(target.host, "build.example.org");
        assert_eq!(target.user.as_deref(), Some("deploy"));
        assert_eq!(target.port, Some(2222));
        assert_eq!(
            target.identity_file,
            Some(PathBuf::from("%USERPROFILE%\\.ssh\\id_ed25519"))
        );
        assert_eq!(
            target.known_hosts_file,
            Some(PathBuf::from("%USERPROFILE%\\.ssh\\known_hosts_noren"))
        );
        assert_eq!(target.remote_program, "norend");
        assert!(target.validate().is_ok());
        let plain = SshProfile {
            host: "box".into(),
            user: None,
            port: None,
            identity_file: None,
            known_hosts_file: None,
        };
        let args = plain.target().args().expect("args");
        assert!(args.iter().any(|a| a == "box"));
        assert!(!args.iter().any(|a| a == "-i" || a == "-p"));
    }

    #[test]
    fn a_remote_session_gets_what_the_profile_says_and_nothing_of_this_machine() {
        // Finding 198: not the environment, not the folder, not the shell integration.
        let mut profile = ProfileSet::default()
            .with_user_profiles(&[ssh_user("box")], &no_env)
            .expect("valid")
            .get("box")
            .cloned()
            .expect("listed");
        let spec = profile.remote_spec(120, 40);
        assert!(spec.env.is_empty(), "no environment of this machine");
        assert_eq!(spec.cwd, None, "no folder: the home of the user there");
        assert_eq!((spec.cols, spec.rows), (120, 40));
        // No program: the login shell of the user there.
        assert_eq!(spec.program, "sh");
        assert_eq!(spec.args, ["-c", "exec \"${SHELL:-/bin/sh}\" -l"]);

        profile.program = "bash".into();
        profile.args = vec!["--noprofile".into()];
        profile.cwd = Some("/srv/app".into());
        let spec = profile.remote_spec(80, 24);
        assert_eq!(spec.program, "bash");
        assert_eq!(spec.args, ["--noprofile"]);
        assert_eq!(spec.cwd, Some(PathBuf::from("/srv/app")));
        assert!(spec.env.is_empty());
    }
}

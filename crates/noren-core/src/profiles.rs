//! Shell profile detection.
//!
//! Detection reads the machine only through [`ProbeEnv`], so the same code runs
//! against a fake environment in tests. Paths are handled as plain strings and
//! the platform is a parameter ([`Platform`]), which lets Windows and Unix
//! detection be tested on any operating system.

use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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
}

impl Profile {
    /// Builds the [`SpawnSpec`] that opens this profile.
    pub fn spawn_spec(&self, cols: u16, rows: u16) -> SpawnSpec {
        SpawnSpec {
            program: self.program.clone(),
            args: self.args.clone(),
            cwd: None,
            env: Vec::new(),
            cols,
            rows,
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
        };
        let spec = profile.spawn_spec(100, 30);
        assert_eq!(spec.program, "bash.exe");
        assert_eq!(spec.args, ["--login", "-i"]);
        assert_eq!((spec.cols, spec.rows), (100, 30));
    }
}

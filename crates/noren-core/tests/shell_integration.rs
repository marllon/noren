//! Runs PowerShell, bash and cmd in a real PTY with the integration and checks the sequences they
//! write. No window is involved and nothing touches the network. When a shell is not installed
//! its test prints a warning and returns.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use noren_core::is_cmd;
use noren_core::{
    BASH_SCRIPT, Profile, SessionEvent, SessionManager, detect_system_profiles, is_bash,
    is_powershell,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const STEP_TIMEOUT: Duration = Duration::from_secs(25);

/// The folder of the integration scripts, as the repository keeps them.
fn integration_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src-tauri/resources/shell-integration")
}

/// `pwsh` when installed, otherwise Windows PowerShell.
fn powershell_profile() -> Option<Profile> {
    let set = detect_system_profiles();
    let found = set
        .profiles
        .iter()
        .filter(|profile| is_powershell(&profile.program))
        .min_by_key(|profile| !profile.program.to_ascii_lowercase().contains("pwsh"));
    found.cloned()
}

/// Reads output until `needle` (raw text) shows up after the first `from` bytes already seen.
fn wait_for(rx: &Receiver<Vec<u8>>, seen: &mut Vec<u8>, needle: &str, from: usize) -> usize {
    let deadline = Instant::now() + STEP_TIMEOUT;
    loop {
        let text = String::from_utf8_lossy(seen).into_owned();
        if let Some(at) = text.get(from..).and_then(|tail| tail.find(needle)) {
            return from + at + needle.len();
        }
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(bytes) => seen.extend_from_slice(&bytes),
            Err(_) => panic!(
                "{needle:?} not found within {STEP_TIMEOUT:?}; output so far: {:?}",
                String::from_utf8_lossy(seen)
            ),
        }
    }
}

fn run() {
    let Some(profile) = powershell_profile() else {
        eprintln!("warning: no PowerShell found on this machine, shell integration test skipped");
        return;
    };
    eprintln!("shell integration test uses {}", profile.program);
    assert!(profile.inject_integration);

    let manager = SessionManager::new();
    let spec = profile.spawn_spec_with_integration(120, 30, Some(&integration_dir()));
    assert!(
        spec.args.iter().any(|arg| arg == "-Command"),
        "the integration must be injected: {:?}",
        spec.args
    );
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            if let SessionEvent::Output(bytes) = event {
                let _ = tx.send(bytes.to_vec());
            }
        })
        .expect("spawn PowerShell");

    let mut seen = Vec::new();
    // The first prompt: folder, prompt start and prompt end, and no command ended before it.
    let mut at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", 0);
    let first = String::from_utf8_lossy(&seen).into_owned();
    assert!(first.contains("\x1b]7;file://"), "OSC 7 missing: {first:?}");
    assert!(
        first.contains("\x1b]133;A\x07"),
        "OSC 133;A missing: {first:?}"
    );
    assert!(
        !first.contains("\x1b]133;D"),
        "no command ran yet, so there is no 133;D: {first:?}"
    );

    // A command that fails with a known code.
    #[cfg(windows)]
    let failing: &[u8] = b"cmd /c exit 3\r";
    #[cfg(not(windows))]
    let failing: &[u8] = b"sh -c 'exit 3'\r";
    manager.write(id, failing).expect("write the command");
    at = wait_for(&rx, &mut seen, "\x1b]133;D;3\x07", at);

    let text = String::from_utf8_lossy(&seen).into_owned();
    let command_line = text.find("\x1b]633;E;").expect("OSC 633;E missing");
    let command_start = text.find("\x1b]133;C\x07").expect("OSC 133;C missing");
    let command_end = text.find("\x1b]133;D;3\x07").expect("OSC 133;D missing");
    assert!(
        command_line < command_start && command_start < command_end,
        "E, C and D must come in this order: {text:?}"
    );
    #[cfg(windows)]
    assert!(text.contains("\x1b]633;E;cmd /c exit 3\x07"), "{text:?}");
    // The next prompt follows the end of the command.
    at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);

    // A command that succeeds ends with code 0, and a line with a ';' is escaped.
    manager
        .write(id, b"$null = 'a'; $null = 'b'\r")
        .expect("write the command");
    at = wait_for(&rx, &mut seen, "\x1b]133;D;0\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(
        text.contains("\x1b]633;E;$null = 'a'\\x3b $null = 'b'\x07"),
        "{text:?}"
    );
    wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);

    manager.kill(id).expect("kill the session");
    assert_eq!(manager.live_threads(), 0);
}

/// Runs `body` on its own thread and fails the test if it does not finish in `TEST_TIMEOUT`.
fn with_timeout(body: impl FnOnce() + Send + 'static) {
    let (done_tx, done_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        body();
        let _ = done_tx.send(());
    });
    match done_rx.recv_timeout(TEST_TIMEOUT) {
        Ok(()) => handle.join().unwrap(),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            if let Err(panic) = handle.join() {
                std::panic::resume_unwind(panic);
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("timed out after {TEST_TIMEOUT:?}"),
    }
}

/// The user's own prompt, defined before the script is loaded (as a profile would), keeps being
/// the prompt shown and keeps seeing the `$?` of the command that just ran.
fn run_with_user_prompt() {
    let Some(profile) = powershell_profile() else {
        eprintln!("warning: no PowerShell found on this machine, shell integration test skipped");
        return;
    };
    let plain = profile.spawn_spec_with_integration(120, 30, Some(&integration_dir()));
    let mut spec = profile.spawn_spec(120, 30);
    spec.args.extend(plain.args[..3].iter().cloned());
    spec.args.push(format!(
        "function prompt {{ 'MINE:' + $? + '> ' }}; {}",
        plain.args[3]
    ));

    let manager = SessionManager::new();
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            if let SessionEvent::Output(bytes) = event {
                let _ = tx.send(bytes.to_vec());
            }
        })
        .expect("spawn PowerShell");

    let mut seen = Vec::new();
    let mut at = wait_for(&rx, &mut seen, "MINE:True> \x1b]133;B\x07", 0);
    #[cfg(windows)]
    let failing: &[u8] = b"cmd /c exit 3\r";
    #[cfg(not(windows))]
    let failing: &[u8] = b"sh -c 'exit 3'\r";
    manager.write(id, failing).expect("write the command");
    at = wait_for(&rx, &mut seen, "MINE:False> \x1b]133;B\x07", at);
    manager
        .write(id, b"$null = 1\r")
        .expect("write the command");
    wait_for(&rx, &mut seen, "MINE:True> \x1b]133;B\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(text.contains("\x1b]133;D;3\x07"), "{text:?}");
    manager.kill(id).expect("kill the session");
}

/// A scratch folder, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("noren-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create the scratch folder");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The bash this machine has: Git Bash on Windows (never the `bash.exe` of the Windows system
/// folder, which is the launcher of WSL: `is_bash` leaves it out), `/bin/bash` elsewhere.
fn bash_profile() -> Option<Profile> {
    detect_system_profiles()
        .profiles
        .into_iter()
        .find(|profile| is_bash(&profile.program))
}

/// What a bash session needs: a profile (login or not), a copy of the script in a folder whose
/// name has a space, and a home folder of its own, so the files of the real user are never read.
struct BashSetup {
    profile: Profile,
    scripts: TempDir,
    home: TempDir,
}

impl BashSetup {
    fn new(name: &str, login: bool) -> Option<Self> {
        let Some(mut profile) = bash_profile() else {
            eprintln!("warning: no bash found on this machine, bash integration test skipped");
            return None;
        };
        eprintln!(
            "bash integration test uses {} (login: {login})",
            profile.program
        );
        profile.args = if login {
            vec!["--login".to_owned(), "-i".to_owned()]
        } else {
            vec!["-i".to_owned()]
        };
        let scripts = TempDir::new(&format!("{name} scripts"));
        std::fs::copy(
            integration_dir().join(BASH_SCRIPT),
            scripts.0.join(BASH_SCRIPT),
        )
        .expect("copy the script");
        let home = TempDir::new(&format!("{name}-home"));
        Some(Self {
            profile,
            scripts,
            home,
        })
    }

    /// Writes the file bash reads for this kind of session in the scratch home.
    fn write_user_file(&self, text: &str) {
        let name = if self.profile.args.iter().any(|arg| arg == "--login") {
            ".bash_profile"
        } else {
            ".bashrc"
        };
        std::fs::write(self.home.0.join(name), text).expect("write the user's file");
    }

    fn spawn(&self) -> (SessionManager, noren_core::SessionId, Receiver<Vec<u8>>) {
        let mut spec = self
            .profile
            .spawn_spec_with_integration(120, 30, Some(&self.scripts.0));
        assert!(
            spec.args.iter().any(|arg| arg == "--rcfile"),
            "the integration must be injected: {:?}",
            spec.args
        );
        spec.env.push((
            "HOME".to_owned(),
            self.home.0.to_string_lossy().into_owned(),
        ));
        let manager = SessionManager::new();
        let (tx, rx) = mpsc::channel();
        let id = manager
            .spawn(spec, move |event| {
                if let SessionEvent::Output(bytes) = event {
                    let _ = tx.send(bytes.to_vec());
                }
            })
            .expect("spawn bash");
        (manager, id, rx)
    }
}

/// bash with the script reports the folder, the prompt, the command line and the exit code.
fn bash_run(login: bool) {
    let Some(setup) = BashSetup::new(if login { "bash-login" } else { "bash-plain" }, login) else {
        return;
    };
    let (manager, id, rx) = setup.spawn();
    let mut seen = Vec::new();

    // The first prompt: folder, prompt start and prompt end, and no command ended before it.
    let mut at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", 0);
    let first = String::from_utf8_lossy(&seen).into_owned();
    assert!(first.contains("\x1b]7;file://"), "OSC 7 missing: {first:?}");
    assert!(
        first.contains("\x1b]133;A\x07"),
        "OSC 133;A missing: {first:?}"
    );
    assert!(
        !first.contains("\x1b]133;D"),
        "no command ran yet, so there is no 133;D: {first:?}"
    );

    // A command that fails with a known code.
    manager.write(id, b"(exit 3)\r").expect("write the command");
    at = wait_for(&rx, &mut seen, "\x1b]133;D;3\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    let command_line = text.find("\x1b]633;E;").expect("OSC 633;E missing");
    let command_start = text.find("\x1b]133;C\x07").expect("OSC 133;C missing");
    let command_end = text.find("\x1b]133;D;3\x07").expect("OSC 133;D missing");
    assert!(
        command_line < command_start && command_start < command_end,
        "E, C and D must come in this order: {text:?}"
    );
    assert!(text.contains("\x1b]633;E;(exit 3)\x07"), "{text:?}");
    // The next prompt follows the end of the command, with the folder first.
    at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);

    // A command that succeeds ends with code 0, and a line with a ';' is escaped.
    manager
        .write(id, b"true; true\r")
        .expect("write the command");
    at = wait_for(&rx, &mut seen, "\x1b]133;D;0\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(text.contains("\x1b]633;E;true\\x3b true\x07"), "{text:?}");
    at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);

    // An empty line is no command: no E, C or D between this prompt and the next.
    let before = at;
    manager.write(id, b"\r").expect("write the line");
    wait_for(&rx, &mut seen, "\x1b]133;B\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    let tail = &text[before..];
    assert!(
        !tail.contains("\x1b]133;C") && !tail.contains("\x1b]133;D") && !tail.contains("633;E"),
        "{tail:?}"
    );

    manager.kill(id).expect("kill the session");
    assert_eq!(manager.live_threads(), 0);
}

/// The prompt and the prompt command of the user, set in the file bash reads, are kept.
fn bash_user_prompt(login: bool) {
    let Some(setup) = BashSetup::new(
        if login {
            "bash-prompt-login"
        } else {
            "bash-prompt-plain"
        },
        login,
    ) else {
        return;
    };
    setup.write_user_file("PS1='MINE> '\nPROMPT_COMMAND='printf \"PCRAN:%s\\n\" \"$?\"'\n");
    let (manager, id, rx) = setup.spawn();
    let mut seen = Vec::new();

    let at = wait_for(&rx, &mut seen, "\x1b]133;A\x07MINE> \x1b]133;B\x07", 0);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(
        text.contains("PCRAN:0"),
        "the user's PROMPT_COMMAND must run: {text:?}"
    );
    assert!(
        text.find("PCRAN:0").unwrap() < text.find("\x1b]133;A\x07").unwrap(),
        "{text:?}"
    );

    // The prompt command of the user still sees the status of the command that just ran.
    manager.write(id, b"(exit 3)\r").expect("write the command");
    wait_for(&rx, &mut seen, "\x1b]133;A\x07MINE> \x1b]133;B\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(text.contains("PCRAN:3"), "{text:?}");
    assert!(text.contains("\x1b]133;D;3\x07"), "{text:?}");
    manager.kill(id).expect("kill the session");
}

/// A DEBUG trap of the user stays as it is. The command is then reported when it has ended, with
/// E, C and D together before the next prompt.
fn bash_user_debug_trap() {
    let Some(setup) = BashSetup::new("bash-trap", false) else {
        return;
    };
    setup.write_user_file("PS1='MINE> '\ntrap 'USERTRAP=1' DEBUG\n");
    let (manager, id, rx) = setup.spawn();
    let mut seen = Vec::new();
    let at = wait_for(&rx, &mut seen, "\x1b]133;A\x07MINE> \x1b]133;B\x07", 0);
    manager.write(id, b"echo hi\r").expect("write the command");
    wait_for(&rx, &mut seen, "\x1b]133;D;0\x07", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    let command_line = text
        .find("\x1b]633;E;echo hi\x07")
        .expect("OSC 633;E missing");
    let command_start = text.find("\x1b]133;C\x07").expect("OSC 133;C missing");
    let command_end = text.find("\x1b]133;D;0\x07").expect("OSC 133;D missing");
    assert!(
        command_line < command_start && command_start < command_end,
        "{text:?}"
    );
    manager.kill(id).expect("kill the session");
}

/// A shell session the test types into, line by line.
struct Typed {
    manager: SessionManager,
    id: noren_core::SessionId,
    rx: Receiver<Vec<u8>>,
    seen: Vec<u8>,
    at: usize,
}

impl Typed {
    /// What the shell printed from sending `line` to the next prompt.
    fn ask(&mut self, line: &str) -> String {
        let from = self.at;
        self.manager
            .write(self.id, format!("{line}\r").as_bytes())
            .expect("write the line");
        self.at = wait_for(&self.rx, &mut self.seen, "\x1b]133;B\x07", from);
        String::from_utf8_lossy(&self.seen)[from..self.at].to_owned()
    }

    /// The reply of `__noren_wsl_folder` for `path` (the typed text has `$REPLY`, not its value).
    fn folder(&mut self, path: &str) -> String {
        self.ask(&format!(
            r#"__noren_wsl_folder '{path}'; echo "R=[$REPLY]""#
        ))
    }
}

/// Inside WSL the script tells the folder as Windows names it: a folder on a drive as `C:/...`, and
/// the files of the distro as `//wsl.localhost/<distro>/...`. This machine's bash is no WSL, so the
/// test says it is one (`OSTYPE`, `WSL_DISTRO_NAME`) and gives `wslpath` as a function: it checks
/// the script's own rules, not WSL (`tests/wsl_integration.rs` runs the real thing).
fn bash_wsl_folders() {
    let Some(setup) = BashSetup::new("bash-wsl", false) else {
        return;
    };
    let (manager, id, rx) = setup.spawn();
    let mut seen = Vec::new();
    let at = wait_for(&rx, &mut seen, "\x1b]133;B\x07", 0);
    let mut shell = Typed {
        manager,
        id,
        rx,
        seen,
        at,
    };

    // Not in WSL (no distro name): the folder is left alone, a POSIX path as before.
    shell.ask("OSTYPE=linux-gnu; cd /tmp");
    let outside = shell.ask("true");
    assert!(
        outside.contains("/tmp\x07") && !outside.contains("wsl.localhost"),
        "{outside:?}"
    );

    // In WSL, with no `wslpath`: the default mount of a drive, and the distro for the rest.
    shell.ask("WSL_DISTRO_NAME='Ubuntu 22.04'");
    for (path, reply) in [
        ("/mnt/c/Users/me", "/C:/Users/me"),
        ("/mnt/d", "/D:/"),
        ("/mnt/D/x y", "/D:/x y"),
        (
            "/home/ada/proj",
            "//wsl.localhost/Ubuntu 22.04/home/ada/proj",
        ),
        ("/", "//wsl.localhost/Ubuntu 22.04/"),
        // Not a drive: more than one letter, or nothing after the mount point.
        ("/mnt/cc/x", "//wsl.localhost/Ubuntu 22.04/mnt/cc/x"),
        ("/mnt", "//wsl.localhost/Ubuntu 22.04/mnt"),
    ] {
        let text = shell.folder(path);
        assert!(text.contains(&format!("R=[{reply}]")), "{path}: {text:?}");
    }

    // The folder of the prompt is the same name, in the form of a file URI (the space is %20). It is a
    // new folder: the URI of the one the shell was in is kept until the folder changes.
    let text = shell.ask("cd /usr");
    assert!(
        text.contains("//wsl.localhost/Ubuntu%2022.04/usr\x07"),
        "{text:?}"
    );
    assert!(text.contains("\x1b]7;file://"), "{text:?}");

    // With `wslpath`, what it says is used: it knows how this distro mounts its drives.
    shell.ask("wslpath() { echo 'D:/Projetos/noren'; }");
    assert!(
        shell
            .folder("/mnt/whatever")
            .contains("R=[/D:/Projetos/noren]")
    );
    shell.ask("wslpath() { echo '//wsl.localhost/Ubuntu 22.04/srv'; }");
    assert!(
        shell
            .folder("/srv")
            .contains("R=[//wsl.localhost/Ubuntu 22.04/srv]")
    );
    // An answer that is neither a drive nor a share of WSL is not trusted.
    shell.ask("wslpath() { echo 'weird'; }");
    assert!(
        shell
            .folder("/srv")
            .contains("R=[//wsl.localhost/Ubuntu 22.04/srv]")
    );
    // A `wslpath` that fails falls back to the rules above.
    shell.ask("wslpath() { return 1; }");
    assert!(shell.folder("/mnt/c/a").contains("R=[/C:/a]"));
    assert!(
        shell
            .folder("/home/x")
            .contains("R=[//wsl.localhost/Ubuntu 22.04/home/x]")
    );

    shell.manager.kill(shell.id).expect("kill the session");
}

/// cmd gets its folder and prompt marks from a PROMPT variable, ended with ST. It has no exit code,
/// so there is no `133;D`.
#[cfg(windows)]
fn cmd_run() {
    let Some(profile) = detect_system_profiles()
        .profiles
        .into_iter()
        .find(|profile| is_cmd(&profile.program))
    else {
        eprintln!("warning: no cmd found on this machine, cmd integration test skipped");
        return;
    };
    let folder = TempDir::new("cmd-folder");
    let mut spec = profile.spawn_spec_with_integration(120, 30, None);
    assert!(
        spec.env.iter().any(|(key, _)| key == "PROMPT"),
        "PROMPT must be set: {:?}",
        spec.env
    );
    spec.cwd = Some(folder.0.clone());
    let manager = SessionManager::new();
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            if let SessionEvent::Output(bytes) = event {
                let _ = tx.send(bytes.to_vec());
            }
        })
        .expect("spawn cmd");

    let mut seen = Vec::new();
    let at = wait_for(&rx, &mut seen, "\x1b]133;B\x1b\\", 0);
    let first = String::from_utf8_lossy(&seen).into_owned();
    assert!(first.contains("\x1b]133;A\x1b\\"), "{first:?}");
    assert!(
        first
            .to_ascii_lowercase()
            .contains(&format!("\x1b]9;9;{}", folder.0.to_string_lossy()).to_ascii_lowercase()),
        "OSC 9;9 with the folder missing: {first:?}"
    );

    // The folder follows `cd`.
    let other = TempDir::new("cmd-folder-two");
    manager
        .write(id, format!("cd /d \"{}\"\r", other.0.display()).as_bytes())
        .expect("write the command");
    wait_for(&rx, &mut seen, "\x1b]133;B\x1b\\", at);
    let text = String::from_utf8_lossy(&seen).into_owned();
    assert!(
        text.to_ascii_lowercase()
            .contains(&format!("\x1b]9;9;{}", other.0.to_string_lossy()).to_ascii_lowercase()),
        "{text:?}"
    );
    assert!(
        !text.contains("\x1b]133;D"),
        "cmd cannot report an exit code: {text:?}"
    );
    manager.kill(id).expect("kill the session");
}

#[test]
fn bash_with_the_script_reports_the_exit_code_in_a_login_shell() {
    with_timeout(|| bash_run(true));
}

#[test]
fn bash_with_the_script_reports_the_exit_code_in_a_plain_shell() {
    with_timeout(|| bash_run(false));
}

#[test]
fn bash_keeps_the_prompt_and_prompt_command_of_the_user_in_a_login_shell() {
    with_timeout(|| bash_user_prompt(true));
}

#[test]
fn bash_keeps_the_prompt_and_prompt_command_of_the_user_in_a_plain_shell() {
    with_timeout(|| bash_user_prompt(false));
}

#[test]
fn bash_leaves_a_debug_trap_of_the_user_alone() {
    with_timeout(bash_user_debug_trap);
}

#[test]
fn bash_in_wsl_names_the_folders_as_windows_does() {
    with_timeout(bash_wsl_folders);
}

#[cfg(windows)]
#[test]
fn cmd_with_the_prompt_reports_the_folder_and_the_marks() {
    with_timeout(cmd_run);
}

#[test]
fn powershell_with_the_script_reports_the_exit_code() {
    with_timeout(run);
}

#[test]
fn the_script_keeps_the_prompt_of_the_user() {
    with_timeout(run_with_user_prompt);
}

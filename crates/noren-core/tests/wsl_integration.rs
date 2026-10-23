//! Opens a shell in a real WSL distro with the integration and checks what it reports, what the
//! Windows side reads from it, and that a folder it reported starts the shell again in the same
//! place. No window is involved and nothing touches the network.
//!
//! This test runs a real distro, and the machine's own distros are somebody's work, so it is careful:
//!
//! - It uses only a distro that is **already running** (`wsl.exe -l --running -q`); it never starts
//!   one, never stops one, never changes the default one and never unregisters one. The only
//!   process it ends is the `wsl.exe` of its own session, when the shell did not end by itself.
//!   `NOREN_WSL_TEST_DISTRO` picks one of the running distros by name. The system distros of Docker
//!   Desktop are left out.
//! - It writes only inside one scratch folder that it creates with `mktemp -d` in the distro (and
//!   one on the Windows side, under the temporary folder or `CARGO_TARGET_TMPDIR`), and removes both
//!   when it ends. The shell is given the scratch folder as `HOME` and `history` is switched off,
//!   so the files and the history of the real user are not read or written by the shell.
//! - It opens no file that belongs to a project in the distro.
//!
//! With no running distro (or no `wsl.exe`, or a distro without bash, or one that cannot read this
//! checkout) it prints a warning and returns.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use noren_core::profiles::parse_wsl_list;
use noren_core::{
    BASH_SCRIPT, GitHead, Profile, SessionEvent, SessionId, SessionManager, SpawnSpec,
    WSL_LAUNCHER, read_head,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(150);
const STEP_TIMEOUT: Duration = Duration::from_secs(30);
const WSL_STEP: Duration = Duration::from_secs(30);

/// The folder of the integration scripts, as the repository keeps them.
fn integration_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src-tauri/resources/shell-integration")
        .canonicalize()
        .expect("the integration folder of the repository")
}

/// Runs `wsl.exe` with `args`: its output when it ended with 0 in time. Only the process it started
/// is killed when it takes too long.
fn wsl(args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new("wsl.exe");
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
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(WSL_STEP) {
        Ok(output) => child
            .wait()
            .ok()
            .and_then(|status| status.success().then_some(output)),
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// What a command in the distro printed, trimmed (UTF-8: the programs inside write it, not wsl.exe).
fn wsl_text(args: &[&str]) -> Option<String> {
    let output = wsl(args)?;
    Some(String::from_utf8_lossy(&output).trim().to_owned())
}

/// A distro that is running now and is not a system distro of Docker Desktop.
fn running_distro() -> Option<String> {
    let installed = parse_wsl_list(&wsl(&["-l", "-q"])?);
    let running = parse_wsl_list(&wsl(&["-l", "--running", "-q"])?);
    let wanted = std::env::var("NOREN_WSL_TEST_DISTRO").ok();
    running
        .into_iter()
        .filter(|name| installed.contains(name))
        .filter(|name| !name.to_ascii_lowercase().starts_with("docker-desktop"))
        .find(|name| wanted.as_ref().is_none_or(|wanted| wanted == name))
}

/// The folder this test makes in the distro, removed when it is dropped. The name is checked before
/// anything is removed: it has to be the folder `mktemp -d` made.
struct LinuxScratch {
    distro: String,
    path: String,
}

fn is_scratch_name(path: &str) -> bool {
    path.starts_with("/tmp/tmp.")
        && path.len() > "/tmp/tmp.".len()
        && path["/tmp/".len()..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.')
}

impl LinuxScratch {
    fn new(distro: &str) -> Option<Self> {
        let path = wsl_text(&["-d", distro, "-e", "mktemp", "-d"])?;
        is_scratch_name(&path).then(|| Self {
            distro: distro.to_owned(),
            path,
        })
    }

    /// The folder the way Windows names it (and the shell reports it).
    fn unc(&self, relative: &str) -> String {
        format!("//wsl.localhost/{}{}{relative}", self.distro, self.path)
    }
}

impl Drop for LinuxScratch {
    fn drop(&mut self) {
        if is_scratch_name(&self.path) {
            let _ = wsl(&["-d", &self.distro, "-e", "rm", "-rf", "--", &self.path]);
        }
    }
}

/// A folder on the Windows side that the distro can see, removed when it is dropped.
struct WindowsScratch {
    dir: PathBuf,
    /// The same folder inside the distro (`/mnt/d/...`).
    inside: String,
}

impl Drop for WindowsScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A scratch folder with a repository in it (`repo/.git/HEAD`) that the distro can see: under the
/// temporary folder when its drive is mounted in the distro, else under `CARGO_TARGET_TMPDIR`.
fn windows_scratch(distro: &str) -> Option<WindowsScratch> {
    for base in [
        std::env::temp_dir(),
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")),
    ] {
        let dir = base.join(format!("noren-wsl-it-{}", std::process::id()));
        let head = dir.join("repo/.git/HEAD");
        std::fs::create_dir_all(head.parent().expect("has a parent")).ok()?;
        std::fs::write(&head, "ref: refs/heads/win-test\n").ok()?;
        let windows = plain_path(&dir);
        let inside = wsl_text(&["-d", distro, "-e", "wslpath", "-u", &windows]);
        if let Some(inside) = inside.filter(|inside| inside.starts_with("/mnt/"))
            && wsl(&["-d", distro, "-e", "test", "-d", &inside]).is_some()
        {
            return Some(WindowsScratch { dir, inside });
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    None
}

/// The path as text without the `\\?\` prefix Windows APIs add.
fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

/// The path the way the script writes it in a file URI: everything but letters, digits and
/// `/._~:-` as `%XX`.
fn encode(path: &str) -> String {
    path.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"/._~:-".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

/// A shell session the test types into, line by line.
struct Shell {
    manager: SessionManager,
    id: SessionId,
    rx: Receiver<Vec<u8>>,
    exited: Receiver<()>,
    seen: Vec<u8>,
    at: usize,
}

impl Shell {
    fn open(spec: SpawnSpec) -> Self {
        let manager = SessionManager::new();
        let (tx, rx) = mpsc::channel();
        let (exit_tx, exited) = mpsc::channel();
        let id = manager
            .spawn(spec, move |event| match event {
                SessionEvent::Output(bytes) => {
                    let _ = tx.send(bytes.to_vec());
                }
                SessionEvent::Exit(_) => {
                    let _ = exit_tx.send(());
                }
            })
            .expect("spawn wsl.exe");
        Self {
            manager,
            id,
            rx,
            exited,
            seen: Vec::new(),
            at: 0,
        }
    }

    /// Reads output until `needle` shows up after what was already taken; returns the text since
    /// the last stop up to the end of `needle`.
    fn wait_for(&mut self, needle: &str) -> String {
        let from = self.at;
        let deadline = Instant::now() + STEP_TIMEOUT;
        loop {
            let text = String::from_utf8_lossy(&self.seen).into_owned();
            if let Some(found) = text.get(from..).and_then(|tail| tail.find(needle)) {
                self.at = from + found + needle.len();
                return text[from..self.at].to_owned();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(bytes) => self.seen.extend_from_slice(&bytes),
                Err(_) => panic!(
                    "{needle:?} not found within {STEP_TIMEOUT:?}; output so far: {:?}",
                    String::from_utf8_lossy(&self.seen)
                ),
            }
        }
    }

    /// The first prompt: the text up to the end of the first prompt.
    fn first_prompt(&mut self) -> String {
        self.wait_for("\x1b]133;B\x07")
    }

    /// Types `line` and returns what the shell printed up to the end of the next prompt.
    fn ask(&mut self, line: &str) -> String {
        self.manager
            .write(self.id, format!("{line}\r").as_bytes())
            .expect("write the line");
        self.wait_for("\x1b]133;B\x07")
    }

    /// Ends the shell the way a person does, and waits for it. Only when it does not end does the
    /// test end the process it started.
    fn finish(self) {
        let _ = self.manager.write(self.id, b"exit\r");
        if self.exited.recv_timeout(Duration::from_secs(20)).is_err() {
            eprintln!("warning: the shell did not end by itself; ending the wsl.exe of this test");
            let _ = self.manager.kill(self.id);
        } else {
            // Nothing left to end: the session cleans itself up.
            let _ = self.manager.kill(self.id);
        }
    }
}

/// Hands `vars` over to the distro in addition to what the integration already shares (`WSLENV`).
fn share_with_wsl(spec: &mut SpawnSpec, vars: &[(&str, &str)]) {
    for (name, value) in vars {
        spec.env.push(((*name).to_owned(), (*value).to_owned()));
    }
    let names = vars
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(":");
    for (key, value) in &mut spec.env {
        if key == "WSLENV" {
            value.push(':');
            value.push_str(&names);
        }
    }
}

fn branch(name: &str) -> Option<GitHead> {
    Some(GitHead {
        branch: name.to_owned(),
        detached: false,
    })
}

fn run() {
    if !cfg!(windows) {
        eprintln!("warning: WSL exists only on Windows, WSL integration test skipped");
        return;
    }
    let Some(distro) = running_distro() else {
        eprintln!("warning: no WSL distro is running, WSL integration test skipped");
        return;
    };
    let probe = "command -v bash >/dev/null && command -v mktemp >/dev/null && command -v wslpath >/dev/null && echo noren-ok";
    if wsl_text(&["-d", &distro, "-e", "sh", "-c", probe]).as_deref() != Some("noren-ok") {
        eprintln!("warning: {distro} has no bash, mktemp or wslpath, WSL integration test skipped");
        return;
    }
    let script = integration_dir().join(BASH_SCRIPT);
    let script_windows = plain_path(&script);
    let readable = wsl_text(&["-d", &distro, "-e", "wslpath", "-u", &script_windows])
        .filter(|path| path.starts_with('/'))
        .is_some_and(|path| wsl(&["-d", &distro, "-e", "test", "-r", &path]).is_some());
    if !readable {
        eprintln!("warning: {distro} cannot read {script_windows}, WSL integration test skipped");
        return;
    }
    let Some(scratch) = LinuxScratch::new(&distro) else {
        eprintln!("warning: could not make a scratch folder in {distro}, test skipped");
        return;
    };
    eprintln!("WSL integration test uses the running distro {distro:?}");
    eprintln!("scratch folder in the distro: {}", scratch.path);
    let make = "mkdir -p \"$1/home\" \"$1/proj/.git\" \"$1/proj/sub\" && printf 'ref: refs/heads/wsl-test\\n' > \"$1/proj/.git/HEAD\"";
    assert!(
        wsl(&["-d", &distro, "-e", "sh", "-c", make, "sh", &scratch.path]).is_some(),
        "could not make the folders of the test in the distro"
    );

    let profile = Profile {
        id: format!("wsl-{distro}"),
        name: format!("WSL: {distro}"),
        program: "wsl.exe".to_owned(),
        args: vec!["-d".to_owned(), distro.clone()],
        cwd: None,
        inject_integration: true,
        remote: None,
    };
    let home = format!("{}/home", scratch.path);
    let spec_for = |cwd: Option<&str>| {
        let mut spec = profile.spawn_spec_with_integration(120, 30, Some(&integration_dir()));
        assert_eq!(
            spec.args.last().map(String::as_str),
            Some(WSL_LAUNCHER),
            "the integration must be injected: {:?}",
            spec.args
        );
        spec.cwd = cwd.map(PathBuf::from);
        let mut spec = profile.place_wsl_folder(spec);
        // The shell works in the scratch folder as its home and keeps no history.
        share_with_wsl(
            &mut spec,
            &[("HOME", home.as_str()), ("HISTFILE", "/dev/null")],
        );
        spec
    };

    // --- A shell with the integration: folder, branch, commands, a folder on a drive ---
    let spec = spec_for(None);
    eprintln!("arguments: {:?}", &spec.args[..spec.args.len() - 1]);
    let mut shell = Shell::open(spec);
    let first = shell.first_prompt();
    assert!(first.contains("\x1b]7;file://"), "OSC 7 missing: {first:?}");
    assert!(first.contains("\x1b]133;A\x07"), "OSC 133;A: {first:?}");
    assert!(
        !first.contains("\x1b]133;D"),
        "no command ran yet, so there is no 133;D: {first:?}"
    );
    // The integration is the bash of the distro, started as a login shell by the launcher.
    let kind = shell.ask("echo \"K=[$BASH_VERSION|$(shopt -q login_shell && echo login || echo plain)|$NOREN_WSL_SCRIPT|$HOME]\"");
    eprintln!("the shell says: {}", kind.replace(['\r', '\n'], " "));
    assert!(
        kind.contains("K=[5.") || kind.contains("K=[4.") || kind.contains("K=[3."),
        "{kind:?}"
    );
    // The variable that carried the script path is gone from the shell of the user.
    assert!(!kind.contains("noren.bash"), "{kind:?}");
    shell.ask("unset HISTFILE");

    // A folder of the distro is reported as the UNC path Windows opens...
    let sub = scratch.unc("/proj/sub");
    let text = shell.ask(&format!("cd '{}/proj/sub'", scratch.path));
    let expected = format!("{}\x07", encode(&sub));
    assert!(
        text.contains(&format!("//wsl.localhost/{}", encode(&distro))) && text.contains(&expected),
        "the folder of the distro as OSC 7: expected {expected:?} in {text:?}"
    );
    // ...and the Windows side reads its branch through that path.
    assert_eq!(read_head(Path::new(&sub)), branch("wsl-test"), "{sub}");
    assert_eq!(
        read_head(Path::new(&scratch.unc("/proj"))),
        branch("wsl-test")
    );
    assert_eq!(read_head(Path::new(&scratch.unc("/home"))), None);
    eprintln!("branch read from {sub}: wsl-test");

    // The last command: E, C and D in this order, with the exit code.
    let text = shell.ask("(exit 3)");
    let command_line = text.find("\x1b]633;E;(exit 3)\x07").expect("633;E missing");
    let command_start = text.find("\x1b]133;C\x07").expect("133;C missing");
    let command_end = text.find("\x1b]133;D;3\x07").expect("133;D;3 missing");
    assert!(
        command_line < command_start && command_start < command_end,
        "E, C and D must come in this order: {text:?}"
    );

    // A command of the catalog of agents: the line is what tells the app which agent runs, since
    // the process tree of Windows stops at wsl.exe.
    shell.ask("claude() { sleep 0.2; }");
    let text = shell.ask("claude --help");
    let command_line = text
        .find("\x1b]633;E;claude --help\x07")
        .expect("633;E of the command missing");
    let command_start = text.find("\x1b]133;C\x07").expect("133;C missing");
    let command_end = text.find("\x1b]133;D;0\x07").expect("133;D;0 missing");
    assert!(
        command_line < command_start && command_start < command_end,
        "{text:?}"
    );

    // A folder on a drive seen from inside: reported as the drive path, which reads the branch.
    let windows = windows_scratch(&distro);
    match &windows {
        Some(windows) => {
            let repo = plain_path(&windows.dir.join("repo")).replace('\\', "/");
            let text = shell.ask(&format!("cd '{}/repo'", windows.inside));
            let expected = format!("/{}\x07", encode(&repo));
            assert!(
                text.contains(&expected) && !text.contains("wsl.localhost"),
                "the folder on a drive as OSC 7: expected {expected:?} in {text:?}"
            );
            assert_eq!(read_head(Path::new(&repo)), branch("win-test"), "{repo}");
            eprintln!(
                "folder on a drive: {} is reported as {repo}",
                windows.inside
            );
        }
        None => eprintln!(
            "warning: no folder on a Windows drive is visible in {distro}, the folder on a drive was not checked"
        ),
    }
    shell.finish();

    // --- A pane restored in the folder it reported starts there again ---
    let restored = spec_for(Some(&sub));
    assert!(
        restored
            .args
            .windows(2)
            .any(|pair| pair[0] == "--cd" && pair[1] == format!("{}/proj/sub", scratch.path)),
        "the folder must become --cd: {:?}",
        restored.args
    );
    assert_eq!(restored.cwd, None);
    let mut shell = Shell::open(restored);
    let first = shell.first_prompt();
    assert!(
        first.contains(&format!("{}\x07", encode(&sub))),
        "the restored shell must be in {sub}: {first:?}"
    );
    shell.finish();
    eprintln!("restored in {sub}: the first prompt reported it");

    if let Some(windows) = &windows {
        let repo = plain_path(&windows.dir.join("repo"));
        let restored = spec_for(Some(&repo));
        assert!(
            !restored.args.iter().any(|arg| arg == "--cd"),
            "a folder on a drive is the folder of the process: {:?}",
            restored.args
        );
        let mut shell = Shell::open(restored);
        let first = shell.first_prompt();
        let expected = format!("/{}\x07", encode(&repo.replace('\\', "/")));
        assert!(
            first.contains(&expected),
            "the restored shell must be in {repo}: expected {expected:?} in {first:?}"
        );
        shell.finish();
        eprintln!("restored in {repo} (a drive): the first prompt reported it");
    }
}

/// Runs `body` on a thread and fails the test when it takes longer than [`TEST_TIMEOUT`].
fn with_timeout(body: impl FnOnce() + Send + 'static) {
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        body();
        let _ = tx.send(());
    });
    match rx.recv_timeout(TEST_TIMEOUT) {
        Ok(()) => handle.join().expect("the test thread"),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            // The body panicked: show its message.
            match handle.join() {
                Err(panic) => std::panic::resume_unwind(panic),
                Ok(()) => unreachable!("the body ended without reporting"),
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("the test took more than {TEST_TIMEOUT:?}"),
    }
}

#[test]
fn bash_in_a_running_wsl_distro_reports_the_folder_the_branch_and_the_commands() {
    with_timeout(run);
}

//! Shell integration: how Noren starts a shell so that it reports its folder, its prompts and its
//! commands to the terminal (OSC 7, OSC 133 and OSC 633;E, read by the interface).
//!
//! This module only decides the command line. The script itself ships with the app (see
//! `apps/desktop/src-tauri/resources/shell-integration/`), and the app tells this module in which
//! folder it is. Nothing here runs a process or reads the user's configuration.
//!
//! Covered: PowerShell (`pwsh` and Windows PowerShell), bash, zsh and cmd. Any other shell is
//! started exactly as detected. What each one gets:
//!
//! - PowerShell: `-Command` that loads `noren.ps1` after the user's profile.
//! - bash: `--rcfile noren.bash`; the script loads the user's own files first. Bash ignores
//!   `--rcfile` in a login shell, so `--login` is taken out of the arguments and the script is told
//!   through `NOREN_BASH_LOGIN`.
//! - zsh: `ZDOTDIR` points at the `zsh` folder of the integration folder, whose dotfiles load the
//!   user's, and `NOREN_USER_ZDOTDIR` carries the user's own `ZDOTDIR`.
//! - cmd: a `PROMPT` environment variable with the sequences around the user's prompt. No script,
//!   and cmd does not know the exit code of the last command, so it sends no `OSC 133;D`.
//!
//! Profile arguments that choose what runs (`-c`, a script, `/c`, `/k`, ...) leave the spec plain.

use std::path::Path;

use crate::profiles::Profile;
use crate::pty::SpawnSpec;

/// File name of the PowerShell script inside the integration folder.
pub const POWERSHELL_SCRIPT: &str = "noren.ps1";

/// File name of the bash script inside the integration folder.
pub const BASH_SCRIPT: &str = "noren.bash";

/// Folder of the zsh dotfiles inside the integration folder.
pub const ZSH_DIR: &str = "zsh";

/// The zsh file that must be in [`ZSH_DIR`] for the integration to be used.
pub const ZSH_RC: &str = ".zshrc";

/// Environment variable that tells `noren.bash` the profile asked for a login shell.
pub const BASH_LOGIN_VAR: &str = "NOREN_BASH_LOGIN";

/// Environment variable with the user's own `ZDOTDIR` (empty when there is none).
pub const ZSH_USER_DIR_VAR: &str = "NOREN_USER_ZDOTDIR";

/// The program name without folders and without `.exe`, lower case.
fn program_stem(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

/// Whether `program` (a path or a bare name) is `pwsh` or Windows PowerShell.
pub fn is_powershell(program: &str) -> bool {
    let stem = program_stem(program);
    stem == "pwsh" || stem == "powershell"
}

/// Whether `program` is bash. The `bash.exe` in the Windows system folder is the launcher of the
/// Windows Subsystem for Linux, not a bash, and is not one here.
pub fn is_bash(program: &str) -> bool {
    if program_stem(program) != "bash" {
        return false;
    }
    let path = program.to_ascii_lowercase().replace('\\', "/");
    ![
        "/windows/system32/",
        "/windows/syswow64/",
        "/windows/sysnative/",
    ]
    .iter()
    .any(|folder| path.contains(folder))
}

/// Whether `program` is zsh.
pub fn is_zsh(program: &str) -> bool {
    program_stem(program) == "zsh"
}

/// Whether `program` is the Windows command interpreter.
pub fn is_cmd(program: &str) -> bool {
    program_stem(program) == "cmd"
}

/// The arguments that start PowerShell with the integration script loaded after the user's
/// profile. The script text is read and compiled by PowerShell itself (`[scriptblock]::Create`),
/// so the execution policy, which only checks script files, does not stop it.
pub fn powershell_integration_args(script: &Path) -> Vec<String> {
    let path = script_path_text(script);
    let command = format!(
        ". ([scriptblock]::Create([System.IO.File]::ReadAllText({})))",
        powershell_quote(&path)
    );
    vec![
        "-NoLogo".to_owned(),
        "-NoExit".to_owned(),
        "-Command".to_owned(),
        command,
    ]
}

/// The path as PowerShell and .NET read it: without the `\\?\` prefix Windows APIs add.
fn script_path_text(script: &Path) -> String {
    let text = script.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_owned(),
        _ => text.into_owned(),
    }
}

/// `text` as a PowerShell single-quoted string. PowerShell reads the typographic quotes as
/// quotes too, so they are doubled like the plain one.
fn powershell_quote(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('\'');
    for ch in text.chars() {
        quoted.push(ch);
        if matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

/// Whether the user already chose what PowerShell runs (`-Command`, `-File`, ...), in which case
/// Noren does not add its own.
fn chooses_what_to_run(args: &[String]) -> bool {
    args.iter().any(|arg| {
        let arg = arg.to_ascii_lowercase();
        matches!(
            arg.as_str(),
            "-c" | "-command" | "-f" | "-file" | "-ec" | "-encodedcommand" | "-commandwithargs"
        )
    })
}

/// What the arguments of a Bourne-like shell (bash, zsh) say about how it will run.
#[derive(Debug, Default)]
struct ShellArgs {
    /// The arguments choose what runs (`-c`, a script, `-`), or turn the user's files off.
    leaves_alone: bool,
    /// The shell is a login shell (`--login`, `-l`). Taken out of `kept`.
    login: bool,
    /// An `-i` is among the arguments.
    interactive: bool,
    /// The arguments to keep, in order.
    kept: Vec<String>,
}

/// Reads the arguments of bash or zsh. `opt_out_long` and `opt_out_short` are the options that
/// turn the user's startup files off (`--norc`, `-f`, ...): the user chose that, so Noren leaves
/// the shell alone.
fn scan_shell_args(args: &[String], opt_out_long: &[&str], opt_out_short: &[char]) -> ShellArgs {
    let mut scan = ShellArgs::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--" {
            scan.leaves_alone |= iter.next().is_some();
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            if long == "login" {
                scan.login = true;
                continue;
            }
            scan.leaves_alone |= opt_out_long.contains(&long);
            scan.kept.push(arg.clone());
            continue;
        }
        let letters = match arg.chars().next() {
            Some(sign @ ('-' | '+')) if arg.len() > 1 => arg[sign.len_utf8()..].to_owned(),
            // A word with no dash is a script to run, and a lone `-` reads the script from input.
            _ => {
                scan.leaves_alone = true;
                scan.kept.push(arg.clone());
                continue;
            }
        };
        let minus = arg.starts_with('-');
        if minus {
            scan.leaves_alone |=
                letters.contains('c') || opt_out_short.iter().any(|short| letters.contains(*short));
            scan.interactive |= letters.contains('i');
        }
        // `-o name` and `-O name` take the next argument as their value.
        let takes_value = letters.contains(['o', 'O']);
        if minus && letters.contains('l') {
            scan.login = true;
            let rest: String = letters.chars().filter(|ch| *ch != 'l').collect();
            if rest.is_empty() {
                continue;
            }
            scan.kept.push(format!("-{rest}"));
        } else {
            scan.kept.push(arg.clone());
        }
        if takes_value && let Some(value) = iter.next() {
            scan.kept.push(value.clone());
        }
    }
    scan
}

/// Bash arguments for the integration: `--rcfile` first (bash only knows long options before the
/// short ones), the profile's own arguments without the login flag, and `-i`. Returns the login
/// flag as well. `None` when the arguments say the user wants something else.
fn bash_integration_args(args: &[String], script: &Path) -> Option<(Vec<String>, bool)> {
    let scan = scan_shell_args(args, &["rcfile", "init-file", "norc", "noprofile"], &[]);
    if scan.leaves_alone {
        return None;
    }
    let mut result = vec!["--rcfile".to_owned(), bash_path_text(script)];
    result.extend(scan.kept);
    if !scan.interactive {
        result.push("-i".to_owned());
    }
    Some((result, scan.login))
}

/// The script path as bash reads it: forward slashes on Windows, where Git Bash takes `C:/x/y`.
fn bash_path_text(script: &Path) -> String {
    let text = script_path_text(script);
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text
    }
}

/// The `PROMPT` that makes cmd report its folder (`OSC 9;9`, which has no BEL form here because
/// cmd has no code for BEL, so the sequences end with ST, `ESC \`) and its prompt marks, around the
/// user's own prompt (`$P$G` when there is none). A prompt that already has the marks is kept.
pub fn cmd_integration_prompt(user_prompt: Option<&str>) -> String {
    let user = user_prompt
        .filter(|prompt| !prompt.is_empty())
        .unwrap_or("$P$G");
    if user.contains("$E]133;A") || user.to_ascii_lowercase().contains("$e]133;a") {
        return user.to_owned();
    }
    format!("$E]9;9;$P$E\\$E]133;A$E\\{user}$E]133;B$E\\")
}

impl Profile {
    /// Builds the [`SpawnSpec`] that opens this profile with Noren's shell integration.
    ///
    /// `integration_dir` is the folder that holds the integration scripts. The spec is the plain
    /// one ([`Profile::spawn_spec`]) when the profile turns the integration off, when the shell is
    /// not one of the supported ones, when the profile's own arguments already say what the shell
    /// runs, and (except for cmd, which has no script) when there is no folder or the script is not
    /// in it.
    pub fn spawn_spec_with_integration(
        &self,
        cols: u16,
        rows: u16,
        integration_dir: Option<&Path>,
    ) -> SpawnSpec {
        self.spec_with_integration(cols, rows, integration_dir, &|name| {
            std::env::var(name).ok()
        })
    }

    /// [`Profile::spawn_spec_with_integration`] with the environment of the process (the `ZDOTDIR`
    /// and `PROMPT` of the user) given by `process_env`.
    fn spec_with_integration(
        &self,
        cols: u16,
        rows: u16,
        integration_dir: Option<&Path>,
        process_env: &dyn Fn(&str) -> Option<String>,
    ) -> SpawnSpec {
        let mut spec = self.spawn_spec(cols, rows);
        if !self.inject_integration {
            return spec;
        }
        if is_cmd(&self.program) {
            if !chooses_what_to_run_cmd(&self.args) {
                let prompt = cmd_integration_prompt(process_env("PROMPT").as_deref());
                spec.env.push(("PROMPT".to_owned(), prompt));
            }
            return spec;
        }
        let Some(dir) = integration_dir else {
            return spec;
        };
        if is_powershell(&self.program) {
            let script = dir.join(POWERSHELL_SCRIPT);
            if script.is_file() && !chooses_what_to_run(&self.args) {
                spec.args.extend(powershell_integration_args(&script));
            }
        } else if is_bash(&self.program) {
            let script = dir.join(BASH_SCRIPT);
            if !script.is_file() {
                return spec;
            }
            if let Some((args, login)) = bash_integration_args(&self.args, &script) {
                spec.args = args;
                if login {
                    spec.env.push((BASH_LOGIN_VAR.to_owned(), "1".to_owned()));
                }
            }
        } else if is_zsh(&self.program) {
            let zsh_dir = dir.join(ZSH_DIR);
            let scan = scan_shell_args(&self.args, &["no-rcs"], &['f']);
            if zsh_dir.join(ZSH_RC).is_file() && !scan.leaves_alone {
                spec.env
                    .push(("ZDOTDIR".to_owned(), script_path_text(&zsh_dir)));
                spec.env.push((
                    ZSH_USER_DIR_VAR.to_owned(),
                    process_env("ZDOTDIR").unwrap_or_default(),
                ));
            }
        }
        spec
    }
}

/// Whether the arguments of a cmd profile say what cmd runs (`/c`, `/k`, `/r`).
fn chooses_what_to_run_cmd(args: &[String]) -> bool {
    args.iter().any(|arg| {
        let arg = arg.to_ascii_lowercase();
        matches!(arg.as_str(), "/c" | "/k" | "/r")
            || arg.starts_with("/c ")
            || arg.starts_with("/k ")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn profile(id: &str, program: &str, args: &[&str]) -> Profile {
        Profile {
            id: id.into(),
            name: id.into(),
            program: program.into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            cwd: None,
            inject_integration: true,
            remote: None,
        }
    }

    /// A folder with the script in it, removed on drop.
    struct ScriptDir(PathBuf);

    impl ScriptDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("noren-integration-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("create the folder");
            std::fs::write(dir.join(POWERSHELL_SCRIPT), "# test script\n").expect("write script");
            std::fs::write(dir.join(BASH_SCRIPT), "# test script\n").expect("write script");
            std::fs::create_dir_all(dir.join(ZSH_DIR)).expect("create the zsh folder");
            std::fs::write(dir.join(ZSH_DIR).join(ZSH_RC), "# test script\n").expect("write rc");
            Self(dir)
        }
    }

    impl Drop for ScriptDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn recognizes_the_powershell_programs() {
        for program in [
            "pwsh",
            "pwsh.exe",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE",
            "/usr/bin/pwsh",
            "powershell",
        ] {
            assert!(is_powershell(program), "{program}");
        }
        for program in [
            "cmd.exe",
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "/bin/zsh",
            "wsl.exe",
            "pwsh-wrapper.exe",
            "",
        ] {
            assert!(!is_powershell(program), "{program}");
        }
    }

    #[test]
    fn pwsh_gets_the_script_after_its_profile() {
        let dir = ScriptDir::new("pwsh");
        let profile = profile("pwsh", "C:\\Apps\\pwsh.exe", &[]);
        let spec = profile.spawn_spec_with_integration(100, 30, Some(&dir.0));
        assert_eq!(spec.program, "C:\\Apps\\pwsh.exe");
        assert_eq!((spec.cols, spec.rows), (100, 30));
        assert_eq!(&spec.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert_eq!(spec.args.len(), 4);
        let command = &spec.args[3];
        // Dot-sourced in the session scope, so the functions it defines stay.
        assert!(command.starts_with(". ("), "{command}");
        assert!(command.contains("[scriptblock]::Create"), "{command}");
        assert!(command.contains(POWERSHELL_SCRIPT), "{command}");
        // The user's profile is not skipped.
        assert!(
            !spec
                .args
                .iter()
                .any(|a| a.eq_ignore_ascii_case("-NoProfile"))
        );
        assert!(spec.env.is_empty());
    }

    #[test]
    fn windows_powershell_gets_the_script_too() {
        let dir = ScriptDir::new("winps");
        let profile = profile(
            "powershell",
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            &[],
        );
        let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
        assert_eq!(&spec.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
    }

    #[test]
    fn the_profile_arguments_come_first() {
        let dir = ScriptDir::new("args");
        let profile = profile("pwsh", "pwsh", &["-NoProfileLoadTime", "-MTA"]);
        let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
        assert_eq!(&spec.args[..2], ["-NoProfileLoadTime", "-MTA"]);
        assert_eq!(&spec.args[2..5], ["-NoLogo", "-NoExit", "-Command"]);
    }

    #[test]
    fn integration_off_gives_the_plain_spec() {
        let dir = ScriptDir::new("off");
        let mut profile = profile("pwsh", "pwsh", &[]);
        profile.inject_integration = false;
        let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
        assert_eq!(spec.program, "pwsh");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn other_shells_are_unchanged() {
        let dir = ScriptDir::new("others");
        for (program, args) in [
            ("wsl.exe", &["-d", "Debian"][..]),
            // The launcher of the Windows Subsystem for Linux is not a bash.
            ("C:\\Windows\\System32\\bash.exe", &[][..]),
            ("C:\\WINDOWS\\sysnative\\bash.exe", &[][..]),
            ("/usr/bin/fish", &[][..]),
            ("/bin/sh", &[][..]),
        ] {
            let profile = profile("other", program, args);
            let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
            let plain = profile.spawn_spec(80, 24);
            assert_eq!(spec.program, plain.program);
            assert_eq!(spec.args, plain.args, "{program}");
            assert!(spec.env.is_empty(), "{program}");
        }
    }

    fn no_process_env(_: &str) -> Option<String> {
        None
    }

    fn env_value<'a>(spec: &'a SpawnSpec, name: &str) -> Option<&'a str> {
        spec.env
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn recognizes_bash_zsh_and_cmd() {
        for program in [
            "bash",
            "C:\\Program Files\\Git\\bin\\bash.exe",
            "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
            "/bin/bash",
            "/opt/homebrew/bin/bash",
        ] {
            assert!(is_bash(program), "{program}");
        }
        for program in [
            "C:\\Windows\\System32\\bash.exe",
            "c:\\windows\\system32\\BASH.EXE",
            "C:\\Windows\\SysWOW64\\bash.exe",
            "bashful",
            "wsl.exe",
            "",
        ] {
            assert!(!is_bash(program), "{program}");
        }
        assert!(is_zsh("/bin/zsh") && is_zsh("/usr/local/bin/zsh") && is_zsh("zsh"));
        assert!(!is_zsh("/bin/bash") && !is_zsh("zshell"));
        assert!(is_cmd("C:\\Windows\\System32\\cmd.exe") && is_cmd("CMD.EXE") && is_cmd("cmd"));
        assert!(!is_cmd("cmder.exe") && !is_cmd("pwsh"));
    }

    #[test]
    fn non_login_bash_gets_rcfile_and_no_login_variable() {
        let dir = ScriptDir::new("bash-plain");
        let profile = profile("bash", "/bin/bash", &[]);
        let spec = profile.spawn_spec_with_integration(100, 30, Some(&dir.0));
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!((spec.cols, spec.rows), (100, 30));
        assert_eq!(spec.args.len(), 3, "{:?}", spec.args);
        assert_eq!(spec.args[0], "--rcfile");
        assert!(spec.args[1].ends_with(BASH_SCRIPT), "{:?}", spec.args);
        assert!(!spec.args[1].contains('\\'), "{:?}", spec.args);
        assert_eq!(spec.args[2], "-i");
        assert!(spec.env.is_empty());
    }

    #[test]
    fn login_bash_loses_the_login_flag_and_is_told_through_the_environment() {
        let dir = ScriptDir::new("bash-login");
        // The detected Git Bash profile.
        let git_bash = profile(
            "git-bash",
            "C:\\Program Files\\Git\\bin\\bash.exe",
            &["--login", "-i"],
        );
        let spec = git_bash.spawn_spec_with_integration(80, 24, Some(&dir.0));
        assert_eq!(spec.args[0], "--rcfile");
        assert_eq!(&spec.args[2..], ["-i"], "{:?}", spec.args);
        assert!(!spec.args.iter().any(|arg| arg == "--login"));
        assert_eq!(env_value(&spec, BASH_LOGIN_VAR), Some("1"));

        // The short form, alone and joined to other flags.
        for (args, rest) in [
            (&["-l", "-i"][..], &["-i"][..]),
            (&["-li"][..], &["-i"][..]),
            (&["-l"][..], &["-i"][..]),
            (&["-i", "-l"][..], &["-i"][..]),
        ] {
            let profile = profile("bash", "/bin/bash", args);
            let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
            assert_eq!(&spec.args[2..], rest, "{args:?}");
            assert_eq!(env_value(&spec, BASH_LOGIN_VAR), Some("1"), "{args:?}");
        }
    }

    #[test]
    fn bash_keeps_the_other_arguments_of_the_profile() {
        let dir = ScriptDir::new("bash-args");
        let profile = profile("bash", "/bin/bash", &["-o", "vi", "--noediting"]);
        let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
        assert_eq!(spec.args[0], "--rcfile");
        assert_eq!(&spec.args[2..], ["-o", "vi", "--noediting", "-i"]);
        assert!(env_value(&spec, BASH_LOGIN_VAR).is_none());
    }

    #[test]
    fn integration_off_gives_the_plain_spec_for_bash_zsh_and_cmd() {
        let dir = ScriptDir::new("off-all");
        for (program, args) in [
            (
                "C:\\Program Files\\Git\\bin\\bash.exe",
                &["--login", "-i"][..],
            ),
            ("/bin/zsh", &[][..]),
            ("C:\\Windows\\System32\\cmd.exe", &[][..]),
        ] {
            let mut profile = profile("off", program, args);
            profile.inject_integration = false;
            let spec = profile.spec_with_integration(80, 24, Some(&dir.0), &no_process_env);
            assert_eq!(spec.args, args, "{program}");
            assert!(spec.env.is_empty(), "{program}");
        }
    }

    #[test]
    fn bash_that_chooses_what_to_run_is_left_alone() {
        let dir = ScriptDir::new("bash-chosen");
        for chosen in [
            &["-c", "ls"][..],
            &["-lc", "ls"][..],
            &["--login", "-c", "ls"][..],
            &["script.sh"][..],
            &["-i", "script.sh", "arg"][..],
            &["-"][..],
            &["--rcfile", "/home/me/.mybashrc", "-i"][..],
            &["--init-file", "/home/me/.mybashrc"][..],
            &["--norc"][..],
            &["--noprofile", "--login"][..],
            &["--", "x"][..],
        ] {
            let profile = profile("bash", "/bin/bash", chosen);
            let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
            assert_eq!(spec.args, chosen);
            assert!(spec.env.is_empty(), "{chosen:?}");
        }
    }

    #[test]
    fn bash_without_the_script_or_the_folder_is_plain() {
        let profile = profile("bash", "/bin/bash", &["--login", "-i"]);
        let spec = profile.spawn_spec_with_integration(80, 24, None);
        assert_eq!(spec.args, ["--login", "-i"]);
        let empty = std::env::temp_dir().join("noren-integration-no-such-folder-77d0");
        let spec = profile.spawn_spec_with_integration(80, 24, Some(&empty));
        assert_eq!(spec.args, ["--login", "-i"]);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn zsh_gets_a_zdotdir_that_leads_back_to_the_user() {
        let dir = ScriptDir::new("zsh");
        let profile = profile("zsh", "/bin/zsh", &[]);
        let spec = profile.spec_with_integration(80, 24, Some(&dir.0), &no_process_env);
        assert!(spec.args.is_empty());
        let zdotdir = env_value(&spec, "ZDOTDIR").expect("ZDOTDIR is set");
        assert!(
            Path::new(zdotdir).ends_with(ZSH_DIR) && Path::new(zdotdir).join(ZSH_RC).is_file(),
            "{zdotdir}"
        );
        // No ZDOTDIR of the user: the variable is there, empty.
        assert_eq!(env_value(&spec, ZSH_USER_DIR_VAR), Some(""));

        // A ZDOTDIR of the user is handed over.
        let spec = profile.spec_with_integration(80, 24, Some(&dir.0), &|name| {
            (name == "ZDOTDIR").then(|| "/home/me/.config/zsh".to_owned())
        });
        assert_eq!(
            env_value(&spec, ZSH_USER_DIR_VAR),
            Some("/home/me/.config/zsh")
        );
        assert_ne!(env_value(&spec, "ZDOTDIR"), Some("/home/me/.config/zsh"));
    }

    #[test]
    fn zsh_keeps_the_profile_arguments_and_leaves_alone_what_chooses_what_runs() {
        let dir = ScriptDir::new("zsh-args");
        let login = profile("zsh", "/bin/zsh", &["-l"]);
        let spec = login.spec_with_integration(80, 24, Some(&dir.0), &no_process_env);
        assert_eq!(spec.args, ["-l"]);
        assert!(env_value(&spec, "ZDOTDIR").is_some());

        for chosen in [
            &["-c", "ls"][..],
            &["-lc", "ls"][..],
            &["script.zsh"][..],
            &["-f"][..],
            &["--no-rcs"][..],
        ] {
            let profile = profile("zsh", "/bin/zsh", chosen);
            let spec = profile.spec_with_integration(80, 24, Some(&dir.0), &no_process_env);
            assert_eq!(spec.args, chosen);
            assert!(spec.env.is_empty(), "{chosen:?}");
        }
    }

    #[test]
    fn zsh_without_its_files_or_the_folder_is_plain() {
        let profile = profile("zsh", "/bin/zsh", &[]);
        let spec = profile.spec_with_integration(80, 24, None, &no_process_env);
        assert!(spec.env.is_empty());
        let empty = std::env::temp_dir().join("noren-integration-no-such-folder-5e19");
        let spec = profile.spec_with_integration(80, 24, Some(&empty), &no_process_env);
        assert!(spec.env.is_empty());
    }

    #[test]
    fn cmd_gets_a_prompt_around_the_default_one() {
        let profile = profile("cmd", "C:\\Windows\\System32\\cmd.exe", &[]);
        // cmd has no script, so it works with no folder at all.
        let spec = profile.spec_with_integration(80, 24, None, &no_process_env);
        assert!(spec.args.is_empty());
        assert_eq!(
            env_value(&spec, "PROMPT"),
            Some("$E]9;9;$P$E\\$E]133;A$E\\$P$G$E]133;B$E\\")
        );
    }

    #[test]
    fn cmd_keeps_the_prompt_of_the_user() {
        let profile = profile("cmd", "cmd.exe", &["/d"]);
        let spec = profile.spec_with_integration(80, 24, None, &|name| {
            (name == "PROMPT").then(|| "$T $P$_$G ".to_owned())
        });
        assert_eq!(spec.args, ["/d"]);
        let prompt = env_value(&spec, "PROMPT").expect("PROMPT is set");
        assert!(
            prompt.contains("$E]133;A$E\\$T $P$_$G $E]133;B$E\\"),
            "{prompt}"
        );
        assert!(prompt.starts_with("$E]9;9;$P$E\\"), "{prompt}");
        // An empty PROMPT is no prompt.
        assert_eq!(
            cmd_integration_prompt(Some("")),
            cmd_integration_prompt(None)
        );
        // Marks that are already there are not added a second time.
        let once = cmd_integration_prompt(None);
        assert_eq!(cmd_integration_prompt(Some(&once)), once);
    }

    #[test]
    fn cmd_that_chooses_what_to_run_is_left_alone() {
        for chosen in [
            &["/c", "dir"][..],
            &["/K", "echo"][..],
            &["/d", "/c", "x"][..],
        ] {
            let profile = profile("cmd", "cmd.exe", chosen);
            let spec = profile.spec_with_integration(80, 24, None, &no_process_env);
            assert_eq!(spec.args, chosen);
            assert!(spec.env.is_empty(), "{chosen:?}");
        }
    }

    #[test]
    fn the_bash_script_path_uses_forward_slashes_on_windows() {
        let text = bash_path_text(Path::new(r"\\?\C:\Program Files\Noren\noren.bash"));
        if cfg!(windows) {
            assert_eq!(text, "C:/Program Files/Noren/noren.bash");
        } else {
            assert!(text.ends_with("noren.bash"));
        }
    }

    #[test]
    fn no_folder_or_no_script_gives_the_plain_spec() {
        let profile = profile("pwsh", "pwsh", &[]);
        assert!(
            profile
                .spawn_spec_with_integration(80, 24, None)
                .args
                .is_empty()
        );
        let missing = std::env::temp_dir().join("noren-integration-no-such-folder-8c21");
        assert!(
            profile
                .spawn_spec_with_integration(80, 24, Some(&missing))
                .args
                .is_empty()
        );
    }

    #[test]
    fn a_profile_that_chooses_what_to_run_is_left_alone() {
        let dir = ScriptDir::new("chosen");
        for chosen in [
            &["-Command", "Get-Date"][..],
            &["-c", "ls"][..],
            &["-File", "x.ps1"][..],
            &["-NoLogo", "-EncodedCommand", "AAAA"][..],
        ] {
            let profile = profile("pwsh", "pwsh", chosen);
            let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
            assert_eq!(spec.args, chosen);
        }
    }

    #[test]
    fn quotes_in_the_script_path_are_doubled() {
        assert_eq!(powershell_quote("C:\\a b\\x.ps1"), "'C:\\a b\\x.ps1'");
        assert_eq!(powershell_quote("C:\\it's\\x"), "'C:\\it''s\\x'");
        assert_eq!(
            powershell_quote("a\u{2018}b\u{2019}c"),
            "'a\u{2018}\u{2018}b\u{2019}\u{2019}c'"
        );
        assert_eq!(powershell_quote("$(evil)`x"), "'$(evil)`x'");
    }

    #[test]
    fn the_verbatim_prefix_is_removed_from_the_script_path() {
        assert_eq!(
            script_path_text(Path::new(r"\\?\C:\app\noren.ps1")),
            r"C:\app\noren.ps1"
        );
        assert_eq!(
            script_path_text(Path::new(r"C:\app\noren.ps1")),
            r"C:\app\noren.ps1"
        );
        assert_eq!(
            script_path_text(Path::new(r"\\?\UNC\srv\share\noren.ps1")),
            r"\\?\UNC\srv\share\noren.ps1"
        );
    }
}

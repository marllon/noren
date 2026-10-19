//! Shell integration: how Noren starts a shell so that it reports its folder, its prompts and its
//! commands to the terminal (OSC 7, OSC 133 and OSC 633;E, read by the interface).
//!
//! This module only decides the command line. The script itself ships with the app (see
//! `apps/desktop/src-tauri/resources/shell-integration/`), and the app tells this module in which
//! folder it is. Nothing here runs a process or reads the user's configuration.
//!
//! Only PowerShell (`pwsh` and Windows PowerShell) is covered so far; any other shell is started
//! exactly as detected.

use std::path::Path;

use crate::profiles::Profile;
use crate::pty::SpawnSpec;

/// File name of the PowerShell script inside the integration folder.
pub const POWERSHELL_SCRIPT: &str = "noren.ps1";

/// Whether `program` (a path or a bare name) is `pwsh` or Windows PowerShell.
pub fn is_powershell(program: &str) -> bool {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.to_ascii_lowercase();
    let stem = name.strip_suffix(".exe").unwrap_or(&name);
    stem == "pwsh" || stem == "powershell"
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

impl Profile {
    /// Builds the [`SpawnSpec`] that opens this profile with Noren's shell integration.
    ///
    /// `integration_dir` is the folder that holds the integration scripts. The spec is the plain
    /// one ([`Profile::spawn_spec`]) when the profile turns the integration off, when there is no
    /// folder or no script in it, when the shell is not PowerShell, or when the profile's own
    /// arguments already say what PowerShell runs.
    pub fn spawn_spec_with_integration(
        &self,
        cols: u16,
        rows: u16,
        integration_dir: Option<&Path>,
    ) -> SpawnSpec {
        let mut spec = self.spawn_spec(cols, rows);
        if !self.inject_integration || !is_powershell(&self.program) {
            return spec;
        }
        let Some(dir) = integration_dir else {
            return spec;
        };
        let script = dir.join(POWERSHELL_SCRIPT);
        if !script.is_file() || chooses_what_to_run(&self.args) {
            return spec;
        }
        spec.args.extend(powershell_integration_args(&script));
        spec
    }
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
            inject_integration: true,
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
            ("C:\\Windows\\System32\\cmd.exe", &[][..]),
            (
                "C:\\Program Files\\Git\\bin\\bash.exe",
                &["--login", "-i"][..],
            ),
            ("wsl.exe", &["-d", "Debian"][..]),
            ("/bin/zsh", &[][..]),
        ] {
            let profile = profile("other", program, args);
            let spec = profile.spawn_spec_with_integration(80, 24, Some(&dir.0));
            let plain = profile.spawn_spec(80, 24);
            assert_eq!(spec.program, plain.program);
            assert_eq!(spec.args, plain.args, "{program}");
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

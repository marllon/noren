//! WSL profiles (`wsl.exe -d <distro>`): how the shell inside a distro gets Noren's bash
//! integration, and how a folder that the shell reported is given back to it.
//!
//! The Windows process tree stops at `wsl.exe`, so what runs inside the distro can only be known
//! from what the shell inside it says (OSC 7, OSC 133, OSC 633;E). The bash script of the
//! integration folder is loaded there through a small launcher; this module builds the command line
//! of that launcher and nothing else. Nothing here runs a process.
//!
//! - **The launcher.** `wsl.exe` is given `-e sh -c <launcher>` after the arguments of the profile
//!   (`-e` runs the program as is, with no shell and no quoting of its own in between). The launcher
//!   finds the login shell of the user in the distro (`getent`, then `$SHELL`): a bash gets
//!   `--rcfile <noren.bash>` and loads the files of the user as a login shell would
//!   (`NOREN_BASH_LOGIN`), any other shell (zsh, fish, ...) is started as a login shell as plain
//!   `wsl.exe -d <distro>` would start it, with no integration.
//! - **The script path.** The script is a Windows file, and the shell needs its Linux path. It travels
//!   in the environment variable [`WSL_SCRIPT_VAR`], which is listed in `WSLENV` with the `/p` flag so
//!   that WSL itself translates it (it knows how the drives are mounted in that distro). The
//!   `WSLENV` of the user is kept.
//! - **The folder.** The script tells the folder as a path Windows can open (`C:/Users/me` for a
//!   drive, `//wsl.localhost/<distro>/home/me` for the files of the distro), so everything that reads
//!   the folder of a pane from Windows (the git branch, the project actions, the diff) works for it.
//!   A pane that is opened again in such a folder has to start the shell there: `wsl.exe --cd` takes a
//!   Linux path or a path on a drive, but refuses the `\\wsl.localhost\...` form
//!   (`E_INVALIDARG`), so [`Profile::place_wsl_folder`] turns it back into the Linux path.

use crate::profiles::Profile;
use crate::pty::SpawnSpec;

/// Environment variable that carries the Windows path of `noren.bash` into the distro.
pub const WSL_SCRIPT_VAR: &str = "NOREN_WSL_SCRIPT";

/// The environment variable that lists what `wsl.exe` hands to the distro.
pub const WSLENV_VAR: &str = "WSLENV";

/// What the shell inside the distro runs, as the argument of `sh -c`. One line, with no new line
/// character, so the command line of Windows carries it unchanged.
///
/// It picks the login shell of the user (`getent passwd`, then `$SHELL`, then `sh`), forgets the
/// variable that carried the script path, and starts a bash with the script (as a login shell, the
/// way `wsl.exe` starts it) or any other shell as a login shell. A script that cannot be read gives
/// the plain login shell too.
pub const WSL_LAUNCHER: &str = "u=$(getent passwd \"$(id -u)\" 2>/dev/null); u=${u##*:}; [ -x \"$u\" ] || u=${SHELL:-/bin/sh}; s=$NOREN_WSL_SCRIPT; unset NOREN_WSL_SCRIPT; case ${u##*/} in bash) [ -r \"$s\" ] && NOREN_BASH_LOGIN=1 exec \"$u\" --rcfile \"$s\" -i;; esac; exec \"$u\" -l";

/// The program name without folders and without `.exe`, lower case.
fn program_stem(program: &str) -> String {
    let name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let name = name.to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

/// Whether `program` (a path or a bare name) is `wsl.exe`. The `bash.exe` of the Windows system
/// folder is another launcher of the same subsystem and is not touched.
pub fn is_wsl(program: &str) -> bool {
    program_stem(program) == "wsl"
}

/// What the arguments of a `wsl.exe` profile say about how it starts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WslArgs {
    /// The distribution (`-d`, `--distribution`); `None` when the profile names none (the default
    /// distribution of the machine) or names it by id.
    pub distro: Option<String>,
    /// The profile already says where the shell starts (`--cd`).
    pub start_folder: bool,
}

/// Reads the arguments of a `wsl.exe` profile. `None` when they do something Noren does not
/// understand: a command to run (`-e`, `--exec`, `--`, a bare word), a shell type, a management
/// option (`--shutdown`, `--list`, ...), or an option that is missing its value. Then the profile
/// runs exactly as it is.
pub fn scan_wsl_args(args: &[String]) -> Option<WslArgs> {
    let mut scan = WslArgs::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.to_ascii_lowercase().as_str() {
            "-d" | "--distribution" => scan.distro = Some(iter.next()?.clone()),
            "-u" | "--user" | "--distribution-id" => {
                iter.next()?;
            }
            "--cd" => {
                iter.next()?;
                scan.start_folder = true;
            }
            "--system" => {}
            _ => return None,
        }
    }
    Some(scan)
}

/// The arguments that start the shell of a distro with the integration: the arguments of the
/// profile, then `-e sh -c` and the [`WSL_LAUNCHER`]. `None` when the profile chooses what runs.
pub fn wsl_integration_args(args: &[String]) -> Option<Vec<String>> {
    scan_wsl_args(args)?;
    let mut result = args.to_vec();
    result.extend(
        ["-e", "sh", "-c", WSL_LAUNCHER]
            .iter()
            .map(|arg| (*arg).to_owned()),
    );
    Some(result)
}

/// The value of `WSLENV` that hands [`WSL_SCRIPT_VAR`] over as a path (`/p`): what the user already
/// has in it, then the variable. The user's own entry for the same name, if any, is replaced.
pub fn wslenv_with_script(user: Option<&str>) -> String {
    let ours = format!("{WSL_SCRIPT_VAR}/p");
    let mut entries: Vec<&str> = user
        .unwrap_or("")
        .split(':')
        .filter(|entry| !entry.is_empty())
        .filter(|entry| entry.split('/').next() != Some(WSL_SCRIPT_VAR))
        .collect();
    entries.push(&ours);
    entries.join(":")
}

/// The longest folder taken; the interface refuses longer ones too.
const MAX_FOLDER_CHARS: usize = 4096;

/// The Linux path of `folder` when it is a folder of the distro `distro` as Windows names it
/// (`//wsl.localhost/<distro>/home/me`, `\\wsl$\<distro>\home\me`, with either slash and with or
/// without one at the end): `/home/me`, and `/` for the root of the distro. The name of the distro
/// is compared without regard to case, as Windows compares the name of a share.
///
/// `None` for anything else: a folder on a drive, a folder of another distro, a relative path, a
/// path with a control character or an empty distro name.
pub fn folder_in_distro(distro: &str, folder: &str) -> Option<String> {
    if distro.is_empty() || folder.chars().count() > MAX_FOLDER_CHARS {
        return None;
    }
    if folder.chars().any(char::is_control) {
        return None;
    }
    let text = folder.replace('\\', "/");
    let rest = text.strip_prefix("//")?;
    let (host, rest) = rest.split_once('/')?;
    if !host.eq_ignore_ascii_case("wsl.localhost") && !host.eq_ignore_ascii_case("wsl$") {
        return None;
    }
    let (name, path) = rest.split_once('/').unwrap_or((rest, ""));
    if !name.eq_ignore_ascii_case(distro) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    Some(format!("/{}", parts.join("/")))
}

impl Profile {
    /// Gives the shell of a WSL profile the folder it is to start in, once the spec is complete:
    /// a start folder that is a folder of the profile's own distro as Windows names it
    /// (`\\wsl.localhost\Ubuntu\home\me`) leaves the process folder and becomes `--cd /home/me`,
    /// placed before the launcher. A folder on a drive stays the folder of the process, which
    /// `wsl.exe` carries into the distro (`C:\proj` is `/mnt/c/proj`).
    ///
    /// The spec stays as it is when the profile is not a WSL profile with the integration (the
    /// launcher is not in it), says where to start itself (`--cd`), names no distro, or the folder
    /// is not one of that distro.
    pub fn place_wsl_folder(&self, mut spec: SpawnSpec) -> SpawnSpec {
        if !self.inject_integration || !is_wsl(&self.program) {
            return spec;
        }
        let Some(scan) = scan_wsl_args(&self.args) else {
            return spec;
        };
        let Some(distro) = scan.distro.filter(|_| !scan.start_folder) else {
            return spec;
        };
        let at = spec.args.len().saturating_sub(4);
        let launched = spec.args.len() >= 4 && spec.args[at..] == ["-e", "sh", "-c", WSL_LAUNCHER];
        if !launched {
            return spec;
        }
        let Some(folder) = spec
            .cwd
            .as_ref()
            .and_then(|cwd| folder_in_distro(&distro, &cwd.to_string_lossy()))
        else {
            return spec;
        };
        spec.args.splice(at..at, ["--cd".to_owned(), folder]);
        spec.cwd = None;
        spec
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    fn wsl_profile(args: &[&str]) -> Profile {
        Profile {
            id: "wsl-Ubuntu".into(),
            name: "WSL: Ubuntu".into(),
            program: "wsl.exe".into(),
            args: strings(args),
            cwd: None,
            inject_integration: true,
            remote: None,
        }
    }

    /// The spec of an integrated profile, as `spawn_spec_with_integration` builds it, with `cwd`.
    fn spec_with(profile: &Profile, cwd: Option<&str>) -> SpawnSpec {
        let mut spec = profile.spawn_spec(100, 30);
        spec.args = wsl_integration_args(&profile.args).expect("integrated args");
        spec.cwd = cwd.map(PathBuf::from);
        spec
    }

    #[test]
    fn recognizes_wsl_exe() {
        for program in [
            "wsl",
            "wsl.exe",
            "WSL.EXE",
            "C:\\Windows\\System32\\wsl.exe",
            "/mnt/c/Windows/System32/wsl.exe",
        ] {
            assert!(is_wsl(program), "{program}");
        }
        for program in [
            "bash.exe",
            "C:\\Windows\\System32\\bash.exe",
            "wslconfig.exe",
            "wsl-wrapper",
            "pwsh",
            "",
        ] {
            assert!(!is_wsl(program), "{program}");
        }
    }

    #[test]
    fn the_arguments_of_a_distro_profile_are_understood() {
        assert_eq!(
            scan_wsl_args(&strings(&["-d", "Ubuntu"])),
            Some(WslArgs {
                distro: Some("Ubuntu".into()),
                start_folder: false
            })
        );
        // A name with a space is one argument.
        let scan = scan_wsl_args(&strings(&["--distribution", "Ubuntu 22.04", "-u", "ada"]));
        assert_eq!(
            scan.and_then(|scan| scan.distro).as_deref(),
            Some("Ubuntu 22.04")
        );
        // No distribution: the default one of the machine.
        assert_eq!(scan_wsl_args(&[]), Some(WslArgs::default()));
        assert_eq!(
            scan_wsl_args(&strings(&["--system"])),
            Some(WslArgs::default())
        );
        // A start folder of the profile itself.
        let scan = scan_wsl_args(&strings(&["-d", "Debian", "--cd", "~"])).expect("scan");
        assert!(scan.start_folder);
        // By id: no name to compare the folders with.
        let scan = scan_wsl_args(&strings(&["--distribution-id", "{0}"])).expect("scan");
        assert_eq!(scan.distro, None);
    }

    #[test]
    fn a_profile_that_chooses_what_runs_or_how_is_not_understood() {
        for chosen in [
            &["-d", "Ubuntu", "-e", "htop"][..],
            &["-d", "Ubuntu", "--exec", "htop"][..],
            &["-d", "Ubuntu", "--", "htop"][..],
            &["-d", "Ubuntu", "htop"][..],
            &["-d", "Ubuntu", "--shell-type", "none"][..],
            &["--shutdown"][..],
            &["--terminate", "Ubuntu"][..],
            &["--unregister", "Ubuntu"][..],
            &["-l", "-q"][..],
            // An option that lost its value.
            &["-d"][..],
            &["-d", "Ubuntu", "--cd"][..],
        ] {
            assert_eq!(scan_wsl_args(&strings(chosen)), None, "{chosen:?}");
            assert_eq!(wsl_integration_args(&strings(chosen)), None, "{chosen:?}");
        }
    }

    #[test]
    fn the_launcher_comes_after_the_arguments_of_the_profile() {
        let args = wsl_integration_args(&strings(&["-d", "Ubuntu", "-u", "ada"])).expect("args");
        assert_eq!(
            &args[..4],
            ["-d", "Ubuntu", "-u", "ada"],
            "the profile's own arguments stay first"
        );
        assert_eq!(&args[4..7], ["-e", "sh", "-c"]);
        assert_eq!(args[7], WSL_LAUNCHER);
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn the_launcher_is_one_line_and_names_the_script_variable_and_the_login_flag() {
        assert!(!WSL_LAUNCHER.contains(['\n', '\r']));
        assert!(WSL_LAUNCHER.contains(WSL_SCRIPT_VAR));
        // The variable that carried the script is gone before any program of the user starts.
        assert!(WSL_LAUNCHER.contains(&format!("unset {WSL_SCRIPT_VAR}")));
        // A bash is told it is a login shell (what the script reads), and gets the script.
        assert!(WSL_LAUNCHER.contains("NOREN_BASH_LOGIN=1 exec \"$u\" --rcfile \"$s\" -i"));
        // Any other shell, and a script that cannot be read, start the shell of the user as it is.
        assert!(WSL_LAUNCHER.ends_with("exec \"$u\" -l"));
        assert!(WSL_LAUNCHER.contains("getent passwd"));
    }

    #[test]
    fn wslenv_keeps_what_the_user_has() {
        assert_eq!(wslenv_with_script(None), "NOREN_WSL_SCRIPT/p");
        assert_eq!(wslenv_with_script(Some("")), "NOREN_WSL_SCRIPT/p");
        assert_eq!(wslenv_with_script(Some("::")), "NOREN_WSL_SCRIPT/p");
        assert_eq!(
            wslenv_with_script(Some("GOPATH/l:USERPROFILE/up")),
            "GOPATH/l:USERPROFILE/up:NOREN_WSL_SCRIPT/p"
        );
        // A trailing separator does not leave an empty entry.
        assert_eq!(wslenv_with_script(Some("A/p:")), "A/p:NOREN_WSL_SCRIPT/p");
        // An entry of the user for the same variable is replaced, not repeated.
        assert_eq!(
            wslenv_with_script(Some("NOREN_WSL_SCRIPT:A")),
            "A:NOREN_WSL_SCRIPT/p"
        );
        // A longer name that merely starts the same is another variable.
        assert_eq!(
            wslenv_with_script(Some("NOREN_WSL_SCRIPT_X/p")),
            "NOREN_WSL_SCRIPT_X/p:NOREN_WSL_SCRIPT/p"
        );
    }

    #[test]
    fn a_folder_of_the_distro_is_a_linux_path() {
        for (folder, linux) in [
            ("//wsl.localhost/Ubuntu/home/ada/proj", "/home/ada/proj"),
            (r"\\wsl.localhost\Ubuntu\home\ada\proj", "/home/ada/proj"),
            (r"\\wsl$\Ubuntu\home\ada\proj", "/home/ada/proj"),
            ("//wsl$/Ubuntu/home/ada/proj", "/home/ada/proj"),
            // A slash at the end, repeated slashes.
            ("//wsl.localhost/Ubuntu/home/ada/", "/home/ada"),
            ("//wsl.localhost/Ubuntu//home///ada", "/home/ada"),
            // The root of the distro, with and without the last slash.
            ("//wsl.localhost/Ubuntu/", "/"),
            ("//wsl.localhost/Ubuntu", "/"),
            (r"\\wsl$\Ubuntu", "/"),
            // The host and the name of the distro do not care about case.
            ("//WSL.LOCALHOST/ubuntu/Home/Ada", "/Home/Ada"),
            // What is in the path keeps its case, its dots and its spaces.
            (
                "//wsl.localhost/Ubuntu/home/ada/My Project/.config",
                "/home/ada/My Project/.config",
            ),
        ] {
            assert_eq!(
                folder_in_distro("Ubuntu", folder).as_deref(),
                Some(linux),
                "{folder}"
            );
        }
    }

    #[test]
    fn a_distro_with_a_space_in_its_name_is_found() {
        assert_eq!(
            folder_in_distro("Ubuntu 22.04", "//wsl.localhost/Ubuntu 22.04/home/ada").as_deref(),
            Some("/home/ada")
        );
        assert_eq!(
            folder_in_distro("Ubuntu 22.04", r"\\wsl$\Ubuntu 22.04\").as_deref(),
            Some("/")
        );
        // A distro that merely starts with the same words is another distro.
        assert_eq!(
            folder_in_distro("Ubuntu", "//wsl.localhost/Ubuntu 22.04/home/ada"),
            None
        );
        assert_eq!(
            folder_in_distro("Ubuntu 22.04", "//wsl.localhost/Ubuntu/home/ada"),
            None
        );
    }

    #[test]
    fn what_is_not_a_folder_of_the_distro_is_not_converted() {
        for folder in [
            // Another distro.
            "//wsl.localhost/Debian/home/ada",
            // A drive, which the process folder carries into the distro by itself.
            r"C:\Users\ada\proj",
            "C:/Users/ada/proj",
            // Another server.
            "//server/share/dir",
            r"\\server\Ubuntu\home",
            // A Linux path (never what the pane holds), a relative path, nothing.
            "/home/ada/proj",
            "home/ada",
            "",
            // The host alone.
            "//wsl.localhost",
            "//wsl.localhost/",
            // A control character, or a path no interface sends.
            "//wsl.localhost/Ubuntu/home/a\nb",
            "//wsl.localhost/Ubuntu/home/a\0b",
        ] {
            assert_eq!(folder_in_distro("Ubuntu", folder), None, "{folder:?}");
        }
        assert_eq!(folder_in_distro("", "//wsl.localhost//home"), None);
        let long = format!("//wsl.localhost/Ubuntu/{}", "a".repeat(5000));
        assert_eq!(folder_in_distro("Ubuntu", &long), None);
    }

    #[test]
    fn a_folder_of_the_distro_becomes_cd_before_the_launcher() {
        let profile = wsl_profile(&["-d", "Ubuntu"]);
        let spec = spec_with(&profile, Some("//wsl.localhost/Ubuntu/home/ada/proj"));
        let placed = profile.place_wsl_folder(spec);
        assert_eq!(
            placed.args,
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/ada/proj",
                "-e",
                "sh",
                "-c",
                WSL_LAUNCHER
            ]
        );
        // The folder is not also the folder of the process.
        assert_eq!(placed.cwd, None);

        // The root, the legacy name of the share, a distro with a space.
        let root = profile.place_wsl_folder(spec_with(&profile, Some(r"\\wsl$\Ubuntu")));
        assert_eq!(&root.args[2..4], ["--cd", "/"]);
        let spaced = wsl_profile(&["-d", "Ubuntu 22.04"]);
        let placed = spaced.place_wsl_folder(spec_with(
            &spaced,
            Some("//wsl.localhost/Ubuntu 22.04/home/ada"),
        ));
        assert_eq!(
            &placed.args[..4],
            ["-d", "Ubuntu 22.04", "--cd", "/home/ada"]
        );
    }

    #[test]
    fn the_other_arguments_of_the_profile_keep_their_place() {
        let profile = wsl_profile(&["-d", "Ubuntu", "-u", "ada"]);
        let placed =
            profile.place_wsl_folder(spec_with(&profile, Some("//wsl.localhost/Ubuntu/home/ada")));
        assert_eq!(
            placed.args,
            [
                "-d",
                "Ubuntu",
                "-u",
                "ada",
                "--cd",
                "/home/ada",
                "-e",
                "sh",
                "-c",
                WSL_LAUNCHER
            ]
        );
    }

    #[test]
    fn a_folder_that_is_not_of_the_distro_stays_the_folder_of_the_process() {
        let profile = wsl_profile(&["-d", "Ubuntu"]);
        for folder in [
            r"C:\Users\ada\proj",
            "//wsl.localhost/Debian/home/ada",
            "//server/share",
            "/home/ada",
        ] {
            let spec = spec_with(&profile, Some(folder));
            let placed = profile.place_wsl_folder(spec.clone());
            assert_eq!(placed, spec, "{folder}");
        }
        // No folder at all.
        let spec = spec_with(&profile, None);
        assert_eq!(profile.place_wsl_folder(spec.clone()), spec);
    }

    #[test]
    fn a_profile_that_names_its_own_start_folder_is_left_alone() {
        let profile = wsl_profile(&["-d", "Ubuntu", "--cd", "~/work"]);
        let spec = spec_with(&profile, Some("//wsl.localhost/Ubuntu/home/ada"));
        assert_eq!(profile.place_wsl_folder(spec.clone()), spec);
    }

    #[test]
    fn a_profile_with_no_distro_is_left_alone() {
        let profile = wsl_profile(&[]);
        let spec = spec_with(&profile, Some("//wsl.localhost/Ubuntu/home/ada"));
        assert_eq!(profile.place_wsl_folder(spec.clone()), spec);
    }

    #[test]
    fn a_spec_without_the_launcher_is_left_alone() {
        // The integration is off: the spec is the plain one, folder and all.
        let mut off = wsl_profile(&["-d", "Ubuntu"]);
        off.inject_integration = false;
        let spec = off.spawn_spec(80, 24);
        let mut spec = SpawnSpec {
            cwd: Some(PathBuf::from("//wsl.localhost/Ubuntu/home/ada")),
            ..spec
        };
        assert_eq!(off.place_wsl_folder(spec.clone()), spec);

        // The integration is on but the script was not there, so the launcher was not added.
        let on = wsl_profile(&["-d", "Ubuntu"]);
        spec.args = on.args.clone();
        assert_eq!(on.place_wsl_folder(spec.clone()), spec);

        // The profile chooses what runs.
        let command = wsl_profile(&["-d", "Ubuntu", "-e", "htop"]);
        let spec = SpawnSpec {
            cwd: Some(PathBuf::from("//wsl.localhost/Ubuntu/home/ada")),
            ..command.spawn_spec(80, 24)
        };
        assert_eq!(command.place_wsl_folder(spec.clone()), spec);

        // Not a WSL profile at all.
        let mut other = wsl_profile(&["-d", "Ubuntu"]);
        other.program = "pwsh.exe".into();
        let spec = SpawnSpec {
            cwd: Some(PathBuf::from("//wsl.localhost/Ubuntu/home/ada")),
            ..other.spawn_spec(80, 24)
        };
        assert_eq!(other.place_wsl_folder(spec.clone()), spec);
    }
}

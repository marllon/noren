//! The command line of `noren-cli`, parsed by hand (a parser crate would be a dependency for a
//! dozen options). Pure apart from one thing: a `--cwd` is made absolute against the folder the
//! command runs in, which is the point of `--cwd .`.

use std::fmt;
use std::path::PathBuf;

use noren_core::api::SplitDirection;
use noren_core::api::protocol::MAX_READ_LINES;

pub const USAGE: &str = "\
Usage: noren-cli <command> [options]

Drives a running Noren through its local API. The result of a command is the JSON the app answered,
on one line of standard output. Nothing here ever presses Enter for you.

Commands:
  new-tab [--space <id or name>] [--cwd <folder>] [--profile <id>]
        Open a tab with a new shell. The space is an id or a name as 'spaces.list' shows them. Left
        out, Noren picks it: the space of the first routing rule (routing.rules in the settings
        file) that matches the folder and the profile, else the active space. --cwd '.' means the
        folder you run this in.
  split --item <id> --direction right|down [--cwd <folder>] [--profile <id>]
        Split the focused pane of a tab (its item id) with a new shell.
  send --terminal <id> [--text <text>] [--key <name>]...
        Type into a terminal: the text exactly as given, then the keys by name (Enter, Tab, Esc,
        Ctrl+C, Up...). At least one of the two. No Enter is added: a command runs only if you
        send the Enter key (or a line break in the text) yourself.
  read --terminal <id> [--lines <n>]
        The newest lines the terminal printed (1 to 10000).
  notify --title <text> [--body <text>] [--terminal <id>]
        Ask Noren to show a notification of the system. It answers {\"shown\":false} when the
        notifications are off in the settings of the user.

Where Noren is (for tests and for a second copy of the app):
  --endpoint <name>      Name of the API to reach: api-<name>. Default: default
                         (environment: NOREN_API_ENDPOINT)
  --token-file <path>    File with the API token. Default: the one in the data folder of Noren
                         (environment: NOREN_API_TOKEN_FILE). Read again at every run.

  -h, --help             Print this text and exit
  -V, --version          Print the version and exit

Exit codes: 0 done; 1 Noren answered with an error (see the message on standard error); 2 wrong
command line; 3 Noren could not be reached (not running, no token file, token refused).
";

/// A command line that cannot be run: what is wrong, as a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(pub String);

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn usage(message: impl Into<String>) -> UsageError {
    UsageError(message.into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    NewTab {
        space: Option<String>,
        cwd: Option<String>,
        profile: Option<String>,
    },
    Split {
        item: String,
        direction: SplitDirection,
        cwd: Option<String>,
        profile: Option<String>,
    },
    Send {
        terminal: String,
        text: Option<String>,
        keys: Vec<String>,
    },
    Read {
        terminal: String,
        lines: Option<u32>,
    },
    Notify {
        title: String,
        body: Option<String>,
        terminal: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Help,
    Version,
    Run(Command),
}

/// A whole command line: what to do, and where Noren is when the line says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub endpoint: Option<String>,
    pub token_file: Option<PathBuf>,
    pub action: Action,
}

/// Options that take a value; the second field is whether the option may repeat.
const VALUE_OPTIONS: [(&str, bool); 13] = [
    ("endpoint", false),
    ("token-file", false),
    ("space", false),
    ("item", false),
    ("direction", false),
    ("cwd", false),
    ("profile", false),
    ("terminal", false),
    ("text", false),
    ("key", true),
    ("lines", false),
    ("title", false),
    ("body", false),
];

/// The options each command takes besides `--endpoint` and `--token-file`.
fn allowed(command: &str) -> Option<&'static [&'static str]> {
    Some(match command {
        "new-tab" => &["space", "cwd", "profile"],
        "split" => &["item", "direction", "cwd", "profile"],
        "send" => &["terminal", "text", "key"],
        "read" => &["terminal", "lines"],
        "notify" => &["title", "body", "terminal"],
        _ => return None,
    })
}

struct Options {
    values: Vec<(String, String)>,
}

impl Options {
    fn take(&mut self, name: &str) -> Option<String> {
        let at = self.values.iter().position(|(key, _)| key == name)?;
        Some(self.values.remove(at).1)
    }

    fn take_all(&mut self, name: &str) -> Vec<String> {
        let mut found = Vec::new();
        self.values.retain(|(key, value)| {
            if key == name {
                found.push(value.clone());
                false
            } else {
                true
            }
        });
        found
    }

    fn require(&mut self, name: &str) -> Result<String, UsageError> {
        self.take(name)
            .ok_or_else(|| usage(format!("missing --{name}")))
    }
}

/// Parses the arguments after the program name.
pub fn parse(args: &[String]) -> Result<Invocation, UsageError> {
    let mut command: Option<String> = None;
    let mut help = false;
    let mut version = false;
    let mut options = Options { values: Vec::new() };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "-h" || arg == "--help" {
            help = true;
        } else if arg == "-V" || arg == "--version" {
            version = true;
        } else if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (long, None),
            };
            let Some((_, repeats)) = VALUE_OPTIONS.iter().find(|(known, _)| *known == name) else {
                return Err(usage(format!("unknown option --{name}")));
            };
            let value = match inline {
                Some(value) => value,
                None => rest
                    .next()
                    .cloned()
                    .ok_or_else(|| usage(format!("--{name} needs a value")))?,
            };
            if !repeats && options.values.iter().any(|(key, _)| key == name) {
                return Err(usage(format!("--{name} was given twice")));
            }
            options.values.push((name.to_owned(), value));
        } else if arg.starts_with('-') && arg.len() > 1 {
            return Err(usage(format!("unknown option {arg}")));
        } else if command.is_none() {
            command = Some(arg.clone());
        } else {
            return Err(usage(format!("unexpected argument {arg:?}")));
        }
    }
    let endpoint = options.take("endpoint");
    let token_file = options.take("token-file").map(PathBuf::from);
    let finish = |action| Invocation {
        endpoint: endpoint.clone(),
        token_file: token_file.clone(),
        action,
    };
    if help {
        return Ok(finish(Action::Help));
    }
    if version {
        return Ok(finish(Action::Version));
    }
    let Some(command) = command else {
        return Err(usage("no command given"));
    };
    let Some(accepted) = allowed(&command) else {
        return Err(usage(format!("unknown command {command:?}")));
    };
    if let Some((name, _)) = options
        .values
        .iter()
        .find(|(name, _)| !accepted.contains(&name.as_str()))
    {
        return Err(usage(format!("{command} does not take --{name}")));
    }
    let parsed = match command.as_str() {
        "new-tab" => Command::NewTab {
            space: options.take("space"),
            cwd: cwd_of(&mut options)?,
            profile: options.take("profile"),
        },
        "split" => {
            let item = options.require("item")?;
            let direction = match options.require("direction")?.as_str() {
                "right" => SplitDirection::Right,
                "down" => SplitDirection::Down,
                other => {
                    return Err(usage(format!(
                        "--direction must be right or down, not {other:?}"
                    )));
                }
            };
            Command::Split {
                item,
                direction,
                cwd: cwd_of(&mut options)?,
                profile: options.take("profile"),
            }
        }
        "send" => {
            let terminal = options.require("terminal")?;
            let text = options.take("text");
            let keys = options.take_all("key");
            if text.as_deref().is_none_or(str::is_empty) && keys.is_empty() {
                return Err(usage("send needs --text, --key or both"));
            }
            Command::Send {
                terminal,
                text,
                keys,
            }
        }
        "read" => Command::Read {
            terminal: options.require("terminal")?,
            lines: match options.take("lines") {
                None => None,
                Some(text) => Some(
                    text.parse::<u32>()
                        .ok()
                        .filter(|n| (1..=MAX_READ_LINES).contains(n))
                        .ok_or_else(|| {
                            usage(format!(
                                "--lines must be a whole number from 1 to {MAX_READ_LINES}"
                            ))
                        })?,
                ),
            },
        },
        "notify" => Command::Notify {
            title: options.require("title")?,
            body: options.take("body"),
            terminal: options.take("terminal"),
        },
        _ => unreachable!("`allowed` knows every command"),
    };
    Ok(finish(Action::Run(parsed)))
}

/// `--cwd`, made absolute: the app does not know the folder this command runs in.
fn cwd_of(options: &mut Options) -> Result<Option<String>, UsageError> {
    let Some(given) = options.take("cwd") else {
        return Ok(None);
    };
    if given.is_empty() {
        return Err(usage("--cwd must not be empty"));
    }
    let absolute = std::path::absolute(&given).map_err(|e| {
        usage(format!(
            "--cwd {given:?} cannot be made an absolute path: {e}"
        ))
    })?;
    absolute
        .into_os_string()
        .into_string()
        .map(Some)
        .map_err(|_| usage("--cwd is not valid text"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    fn command(line: &str) -> Command {
        match parse(&args(line)).expect("a valid line").action {
            Action::Run(command) => command,
            other => panic!("not a command: {other:?}"),
        }
    }

    fn error(line: &str) -> String {
        parse(&args(line)).expect_err("an invalid line").0
    }

    #[test]
    fn each_command_reads_its_options() {
        assert_eq!(
            command("new-tab --space work --profile pwsh"),
            Command::NewTab {
                space: Some("work".into()),
                cwd: None,
                profile: Some("pwsh".into())
            }
        );
        assert_eq!(
            command("new-tab --profile pwsh"),
            Command::NewTab {
                space: None,
                cwd: None,
                profile: Some("pwsh".into())
            }
        );
        assert_eq!(
            command("new-tab"),
            Command::NewTab {
                space: None,
                cwd: None,
                profile: None
            }
        );
        assert_eq!(
            command("split --item i1 --direction down"),
            Command::Split {
                item: "i1".into(),
                direction: SplitDirection::Down,
                cwd: None,
                profile: None
            }
        );
        assert_eq!(
            command("send --terminal t1 --text ls --key Ctrl+C --key=Up"),
            Command::Send {
                terminal: "t1".into(),
                text: Some("ls".into()),
                keys: vec!["Ctrl+C".into(), "Up".into()]
            }
        );
        assert_eq!(
            command("read --terminal=t1 --lines 20"),
            Command::Read {
                terminal: "t1".into(),
                lines: Some(20)
            }
        );
        assert_eq!(
            command("notify --title Done --body ok --terminal t1"),
            Command::Notify {
                title: "Done".into(),
                body: Some("ok".into()),
                terminal: Some("t1".into())
            }
        );
    }

    #[test]
    fn a_dot_cwd_becomes_the_absolute_folder_the_command_runs_in() {
        let Command::NewTab { cwd, .. } = command("new-tab --space s --cwd .") else {
            panic!("new-tab");
        };
        let cwd = PathBuf::from(cwd.expect("a cwd"));
        assert!(cwd.is_absolute(), "{cwd:?}");
        assert_eq!(
            cwd.canonicalize().unwrap(),
            std::env::current_dir().unwrap().canonicalize().unwrap()
        );
    }

    #[test]
    fn an_absolute_cwd_is_kept() {
        let here = std::env::current_dir().unwrap();
        let line = vec![
            "split".to_owned(),
            "--item".into(),
            "i".into(),
            "--direction".into(),
            "right".into(),
            "--cwd".into(),
            here.to_str().unwrap().into(),
        ];
        let Action::Run(Command::Split { cwd, .. }) = parse(&line).unwrap().action else {
            panic!("split");
        };
        assert_eq!(cwd.as_deref(), here.to_str());
    }

    #[test]
    fn a_value_may_start_with_a_dash_and_text_may_have_spaces() {
        let line = vec![
            "send".to_owned(),
            "--terminal".into(),
            "t".into(),
            "--text".into(),
            "-la --all".into(),
        ];
        let Action::Run(Command::Send { text, .. }) = parse(&line).unwrap().action else {
            panic!("send");
        };
        assert_eq!(text.as_deref(), Some("-la --all"));
    }

    #[test]
    fn where_noren_is_comes_from_the_line() {
        let invocation = parse(&args(
            "read --terminal t --endpoint test-1 --token-file a/token",
        ))
        .unwrap();
        assert_eq!(invocation.endpoint.as_deref(), Some("test-1"));
        assert_eq!(invocation.token_file, Some(PathBuf::from("a/token")));
    }

    #[test]
    fn help_and_version_win_over_a_missing_option() {
        assert_eq!(parse(&args("--help")).unwrap().action, Action::Help);
        assert_eq!(parse(&args("send -h")).unwrap().action, Action::Help);
        assert_eq!(parse(&args("-V")).unwrap().action, Action::Version);
    }

    #[test]
    fn wrong_lines_are_refused_with_a_reason() {
        assert!(error("").contains("no command"));
        assert!(error("fly").contains("unknown command"));
        assert!(error("read").contains("missing --terminal"));
        assert!(error("read --terminal").contains("needs a value"));
        assert!(error("read --terminal t --terminal u").contains("twice"));
        assert!(error("read --terminal t --bogus 1").contains("unknown option --bogus"));
        assert!(error("read --terminal t -x").contains("unknown option -x"));
        assert!(error("read --terminal t extra").contains("unexpected argument"));
        assert!(error("read --terminal t --text x").contains("does not take --text"));
        assert!(error("new-tab --space").contains("needs a value"));
        assert!(error("new-tab --space a --space b").contains("twice"));
        assert!(error("split --item i --direction left").contains("right or down"));
        assert!(error("split --item i").contains("missing --direction"));
        assert!(error("notify --body b").contains("missing --title"));
        for lines in ["0", "10001", "-1", "many", ""] {
            let line = vec![
                "read".to_owned(),
                "--terminal".into(),
                "t".into(),
                "--lines".into(),
                lines.into(),
            ];
            assert!(parse(&line).unwrap_err().0.contains("--lines"), "{lines:?}");
        }
    }

    #[test]
    fn send_needs_something_to_send() {
        assert!(error("send --terminal t").contains("--text, --key or both"));
        let line = vec![
            "send".to_owned(),
            "--terminal".into(),
            "t".into(),
            "--text".into(),
            String::new(),
        ];
        assert!(
            parse(&line)
                .unwrap_err()
                .0
                .contains("--text, --key or both")
        );
    }

    #[test]
    fn the_usage_names_every_command_and_option() {
        for word in [
            "new-tab",
            "split",
            "send",
            "read",
            "notify",
            "--space",
            "--cwd",
            "--profile",
            "--item",
            "--direction",
            "--terminal",
            "--text",
            "--key",
            "--lines",
            "--title",
            "--body",
            "--endpoint",
            "--token-file",
        ] {
            assert!(USAGE.contains(word), "{word}");
        }
    }
}

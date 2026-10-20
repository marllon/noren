//! The command line of `norend`: two options and the usual help and version flags, parsed by hand
//! (a parser crate would be a dependency for two flags).

use noren_core::daemon::protocol::MAX_BUFFER_BYTES;

pub const USAGE: &str = "\
Usage: norend [--endpoint <name>] [--buffer-bytes <n>]

Keeps terminal sessions alive in this process while windows come and go. It listens on a local
endpoint that only the current user can open (a named pipe on Windows, a Unix socket elsewhere).
Stop it with Ctrl+C, with SIGTERM, or with a Shutdown request from a client.

Options:
  --endpoint <name>    Name of the daemon to run: 1 to 64 ASCII letters, digits, '-', '_' or '.',
                       not starting with a dot. Default: default
  --buffer-bytes <n>   Bytes of output each session keeps for a client that attaches later.
                       Default and maximum: 1048576 (1 MiB)
  -h, --help           Print this text and exit
  -V, --version        Print the version of norend and of the protocol and exit

Exit codes: 0 stopped cleanly, 1 could not run, 2 wrong command line, 3 another norend already
listens on that endpoint.
";

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run(RunOptions),
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOptions {
    pub endpoint: String,
    /// `None` keeps the default of the daemon.
    pub buffer_bytes: Option<usize>,
}

/// The name of the daemon a normal installation runs.
pub const DEFAULT_ENDPOINT: &str = "default";

/// Reads the arguments after the program name. The error is a sentence for the person at the
/// terminal.
pub fn parse<I, S>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into);
    let mut options = RunOptions {
        endpoint: DEFAULT_ENDPOINT.to_owned(),
        buffer_bytes: None,
    };
    while let Some(arg) = args.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_owned(), Some(value.to_owned()))
            }
            _ => (arg, None),
        };
        match name.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            "--endpoint" => {
                options.endpoint = value_of(&name, inline, &mut args)?;
            }
            "--buffer-bytes" => {
                let text = value_of(&name, inline, &mut args)?;
                let bytes: usize = text.parse().map_err(|_| {
                    format!("--buffer-bytes needs a whole number of bytes, not {text:?}")
                })?;
                if bytes > MAX_BUFFER_BYTES {
                    return Err(format!(
                        "--buffer-bytes {bytes} is over the limit of {MAX_BUFFER_BYTES} bytes"
                    ));
                }
                options.buffer_bytes = Some(bytes);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(Command::Run(options))
}

fn value_of(
    name: &str,
    inline: Option<String>,
    rest: &mut impl Iterator<Item = String>,
) -> Result<String, String> {
    inline
        .or_else(|| rest.next())
        .ok_or_else(|| format!("{name} needs a value"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> RunOptions {
        match parse(args.iter().copied()) {
            Ok(Command::Run(options)) => options,
            other => panic!("expected a run, got {other:?}"),
        }
    }

    #[test]
    fn no_arguments_means_the_default_daemon() {
        assert_eq!(
            run(&[]),
            RunOptions {
                endpoint: "default".into(),
                buffer_bytes: None
            }
        );
    }

    #[test]
    fn both_options_in_both_spellings() {
        let a = run(&["--endpoint", "work", "--buffer-bytes", "4096"]);
        let b = run(&["--endpoint=work", "--buffer-bytes=4096"]);
        assert_eq!(a, b);
        assert_eq!(a.endpoint, "work");
        assert_eq!(a.buffer_bytes, Some(4096));
        assert_eq!(run(&["--buffer-bytes", "0"]).buffer_bytes, Some(0));
    }

    #[test]
    fn help_and_version_win_where_they_appear() {
        assert_eq!(parse(["--help"]), Ok(Command::Help));
        assert_eq!(parse(["-h"]), Ok(Command::Help));
        assert_eq!(parse(["-V"]), Ok(Command::Version));
        assert_eq!(parse(["--version"]), Ok(Command::Version));
    }

    #[test]
    fn mistakes_are_explained() {
        for (args, needle) in [
            (vec!["--nope"], "unknown argument"),
            (vec!["stray"], "unknown argument"),
            (vec!["--endpoint"], "needs a value"),
            (vec!["--buffer-bytes"], "needs a value"),
            (vec!["--buffer-bytes", "many"], "whole number"),
            (vec!["--buffer-bytes", "-5"], "whole number"),
            (vec!["--buffer-bytes", "1048577"], "over the limit"),
        ] {
            let error = parse(args.clone()).expect_err(&format!("{args:?}"));
            assert!(error.contains(needle), "{args:?}: {error}");
        }
        assert!(parse(["--buffer-bytes", "1048576"]).is_ok());
    }
}

//! The command line of `norend`: three options and the usual help and version flags, parsed by hand
//! (a parser crate would be a dependency for a handful of flags).

use noren_core::daemon::protocol::MAX_BUFFER_BYTES;

pub const USAGE: &str = "\
Usage: norend [--endpoint <name>] [--buffer-bytes <n>]
       norend --stop [--endpoint <name>]
       norend --bridge [--endpoint <name>]

Keeps terminal sessions alive in this process while windows come and go. It listens on a local
endpoint that only the current user can open (a named pipe on Windows, a Unix socket elsewhere).
Stop it with Ctrl+C, with SIGTERM, with a Shutdown request from a client, or with 'norend --stop'.

Options:
  --endpoint <name>    Name of the daemon to run (or to stop): 1 to 64 ASCII letters, digits, '-',
                       '_' or '.', not starting with a dot. Default: default
  --buffer-bytes <n>   Bytes of output each session keeps for a client that attaches later.
                       Default and maximum: 1048576 (1 MiB)
  --stop               Do not run a daemon: ask the one on the endpoint to stop (it ends its
                       sessions and exits) and wait until it is gone: the endpoint free and its
                       process ended. Nothing running there is not an error. This is what an
                       installer calls before it replaces the program.
  --bridge             Do not run a daemon: connect to the one on the endpoint of this user
                       (starting a detached one when none answers) and pass one connection
                       between it and standard input and output, byte for byte, until either side
                       closes; the daemon and its sessions stay. Standard output carries only the
                       protocol. This is what a client on another machine runs through ssh.
  -h, --help           Print this text and exit
  -V, --version        Print the version of norend and of the protocol and exit

Exit codes: 0 stopped cleanly (or, with --stop, stopped or nothing to stop; with --bridge, one
side closed), 1 could not run (or could not stop it, or reach a daemon), 2 wrong command line,
3 another norend already listens on that endpoint.
";

/// What the command line asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Run(RunOptions),
    /// `--stop`: stop the daemon on this endpoint instead of running one.
    Stop(StopOptions),
    /// `--bridge`: relay one connection to the daemon over standard input and output.
    Bridge(BridgeOptions),
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopOptions {
    pub endpoint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeOptions {
    pub endpoint: String,
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
    let mut stop = false;
    let mut bridge = false;
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
            "--stop" => {
                if inline.is_some() {
                    return Err("--stop takes no value".to_owned());
                }
                stop = true;
            }
            "--bridge" => {
                if inline.is_some() {
                    return Err("--bridge takes no value".to_owned());
                }
                bridge = true;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    if stop && bridge {
        return Err("--stop does not go with --bridge".to_owned());
    }
    if bridge {
        if options.buffer_bytes.is_some() {
            return Err("--buffer-bytes does not go with --bridge".to_owned());
        }
        return Ok(Command::Bridge(BridgeOptions {
            endpoint: options.endpoint,
        }));
    }
    if !stop {
        return Ok(Command::Run(options));
    }
    if options.buffer_bytes.is_some() {
        return Err("--buffer-bytes does not go with --stop".to_owned());
    }
    Ok(Command::Stop(StopOptions {
        endpoint: options.endpoint,
    }))
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
    fn stop_asks_to_stop_the_daemon_of_the_endpoint_instead_of_running_one() {
        assert_eq!(
            parse(["--stop"]),
            Ok(Command::Stop(StopOptions {
                endpoint: "default".into()
            }))
        );
        // The endpoint may come before or after, in both spellings.
        for args in [
            vec!["--stop", "--endpoint", "work"],
            vec!["--endpoint", "work", "--stop"],
            vec!["--endpoint=work", "--stop"],
        ] {
            assert_eq!(
                parse(args.clone()),
                Ok(Command::Stop(StopOptions {
                    endpoint: "work".into()
                })),
                "{args:?}"
            );
        }
        // Without it nothing changed.
        assert!(matches!(parse(["--endpoint", "work"]), Ok(Command::Run(_))));
    }

    #[test]
    fn stop_does_not_go_with_the_options_of_a_running_daemon() {
        let error = parse(["--stop", "--buffer-bytes", "4096"]).expect_err("a mix");
        assert!(error.contains("does not go with --stop"), "{error}");
        let error = parse(["--stop=yes"]).expect_err("a value");
        assert!(error.contains("takes no value"), "{error}");
    }

    #[test]
    fn bridge_relays_to_the_daemon_of_the_endpoint_instead_of_running_one() {
        assert_eq!(
            parse(["--bridge"]),
            Ok(Command::Bridge(BridgeOptions {
                endpoint: "default".into()
            }))
        );
        for args in [
            vec!["--bridge", "--endpoint", "work"],
            vec!["--endpoint=work", "--bridge"],
        ] {
            assert_eq!(
                parse(args.clone()),
                Ok(Command::Bridge(BridgeOptions {
                    endpoint: "work".into()
                })),
                "{args:?}"
            );
        }
    }

    #[test]
    fn bridge_does_not_go_with_the_other_modes() {
        for (args, needle) in [
            (vec!["--bridge", "--stop"], "does not go with --bridge"),
            (vec!["--stop", "--bridge"], "does not go with --bridge"),
            (
                vec!["--bridge", "--buffer-bytes", "4096"],
                "does not go with --bridge",
            ),
            (vec!["--bridge=yes"], "takes no value"),
        ] {
            let error = parse(args.clone()).expect_err(&format!("{args:?}"));
            assert!(error.contains(needle), "{args:?}: {error}");
        }
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

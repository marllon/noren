//! Runs a parsed command line: finds Noren, makes the call or calls, prints the result.

use std::io::Write;
use std::path::PathBuf;

use noren_core::api::{
    ApiClient, ApiMethod, ApiTarget, ClientError, DEFAULT_API_NAME, SplitDirection,
    default_token_file,
};
use serde_json::{Map, Value, json};

use crate::args::{self, Action, Command, Invocation};

/// Done.
pub const EXIT_OK: i32 = 0;
/// Noren answered with an error.
pub const EXIT_REFUSED: i32 = 1;
/// The command line is wrong.
pub const EXIT_USAGE: i32 = 2;
/// Noren could not be reached.
pub const EXIT_UNREACHABLE: i32 = 3;

/// Environment variable that names the API to reach (see `--endpoint`).
pub const ENDPOINT_VAR: &str = "NOREN_API_ENDPOINT";
/// Environment variable that names the token file (see `--token-file`).
pub const TOKEN_FILE_VAR: &str = "NOREN_API_TOKEN_FILE";

/// Why a command did not finish.
enum Failure {
    /// The call or the connection failed.
    Client(ClientError),
    /// Noren was reached and the command cannot go on (for example, no such space).
    Refused(String),
}

impl From<ClientError> for Failure {
    fn from(error: ClientError) -> Self {
        Self::Client(error)
    }
}

/// Runs the command line `args` (without the program name). `env` reads an environment
/// variable. The result goes to `out`, a message for a person to `err`; the return value is the
/// exit code.
pub fn run(
    args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let invocation = match args::parse(args) {
        Ok(invocation) => invocation,
        Err(e) => {
            let _ = writeln!(err, "noren-cli: {e}\nTry 'noren-cli --help'.");
            return EXIT_USAGE;
        }
    };
    let command = match invocation.action {
        Action::Help => {
            let _ = out.write_all(args::USAGE.as_bytes());
            return EXIT_OK;
        }
        Action::Version => {
            let _ = writeln!(out, "noren-cli {}", env!("CARGO_PKG_VERSION"));
            return EXIT_OK;
        }
        Action::Run(ref command) => command.clone(),
    };
    let target = match target_of(&invocation, env) {
        Ok(target) => target,
        Err(e) => return fail(err, &e, None),
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            let _ = writeln!(err, "noren-cli: cannot start: {e}");
            return EXIT_UNREACHABLE;
        }
    };
    match runtime.block_on(execute(&command, &target)) {
        Ok(result) => {
            let _ = writeln!(out, "{result}");
            EXIT_OK
        }
        Err(Failure::Refused(message)) => {
            let _ = writeln!(err, "noren-cli: {message}");
            EXIT_REFUSED
        }
        Err(Failure::Client(e)) => fail(err, &e, Some(&target)),
    }
}

/// Prints a client error and picks the exit code.
fn fail(err: &mut dyn Write, error: &ClientError, target: Option<&ApiTarget>) -> i32 {
    let message = match (error.api_code(), target) {
        (Some("unauthorized"), Some(target)) => format!(
            "Noren refused the token in {}: it is not the token of the Noren that runs",
            target.token_file.display()
        ),
        _ => error.to_string(),
    };
    let _ = writeln!(err, "noren-cli: {message}");
    if error.is_unreachable() {
        EXIT_UNREACHABLE
    } else {
        EXIT_REFUSED
    }
}

/// Where Noren is: the line wins over the environment, which wins over the standard place.
fn target_of(
    invocation: &Invocation,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ApiTarget, ClientError> {
    let name = invocation
        .endpoint
        .clone()
        .or_else(|| env(ENDPOINT_VAR).filter(|v| !v.is_empty()))
        .unwrap_or_else(|| DEFAULT_API_NAME.to_owned());
    let token_file = match invocation.token_file.clone().or_else(|| {
        env(TOKEN_FILE_VAR)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }) {
        Some(path) => path,
        None => default_token_file()?,
    };
    ApiTarget::named(&name, token_file)
}

async fn execute(command: &Command, target: &ApiTarget) -> Result<Value, Failure> {
    let mut client = ApiClient::connect(target).await?;
    match command {
        Command::NewTab {
            space,
            cwd,
            profile,
        } => {
            let listed = client.call(ApiMethod::SpacesList, json!({})).await?;
            let space = resolve_space(&listed, space).map_err(Failure::Refused)?;
            let mut params = Map::new();
            params.insert("space".into(), space.into());
            insert_some(&mut params, "cwd", cwd);
            insert_some(&mut params, "profile", profile);
            Ok(client.call(ApiMethod::ItemsCreate, params.into()).await?)
        }
        Command::Split {
            item,
            direction,
            cwd,
            profile,
        } => {
            let mut params = Map::new();
            params.insert("item".into(), item.clone().into());
            let direction = match direction {
                SplitDirection::Right => "right",
                SplitDirection::Down => "down",
            };
            params.insert("direction".into(), direction.into());
            insert_some(&mut params, "cwd", cwd);
            insert_some(&mut params, "profile", profile);
            Ok(client.call(ApiMethod::SplitsCreate, params.into()).await?)
        }
        Command::Send {
            terminal,
            text,
            keys,
        } => {
            // Exactly what was asked: no line break, no Enter, nothing is added.
            let mut params = Map::new();
            params.insert("terminal".into(), terminal.clone().into());
            insert_some(&mut params, "text", text);
            if !keys.is_empty() {
                params.insert("keys".into(), keys.clone().into());
            }
            Ok(client.call(ApiMethod::TerminalSend, params.into()).await?)
        }
        Command::Read { terminal, lines } => {
            let mut params = Map::new();
            params.insert("terminal".into(), terminal.clone().into());
            if let Some(lines) = lines {
                params.insert("lines".into(), (*lines).into());
            }
            Ok(client.call(ApiMethod::TerminalRead, params.into()).await?)
        }
        Command::Notify {
            title,
            body,
            terminal,
        } => {
            let mut params = Map::new();
            params.insert("title".into(), title.clone().into());
            insert_some(&mut params, "body", body);
            insert_some(&mut params, "terminal", terminal);
            Ok(client.call(ApiMethod::Notify, params.into()).await?)
        }
    }
}

fn insert_some(params: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        params.insert(key.into(), value.clone().into());
    }
}

/// The id of the space `wanted` names in the answer of `spaces.list`: an id first, then a name.
/// A name that two spaces share is not guessed.
fn resolve_space(listed: &Value, wanted: &str) -> Result<String, String> {
    let spaces: Vec<(&str, &str)> = listed
        .get("spaces")
        .and_then(Value::as_array)
        .map(|spaces| {
            spaces
                .iter()
                .filter_map(|space| {
                    Some((
                        space.get("id")?.as_str()?,
                        space.get("name").and_then(Value::as_str).unwrap_or(""),
                    ))
                })
                .collect()
        })
        .ok_or("spaces.list answered something that is not a list of spaces")?;
    if let Some((id, _)) = spaces.iter().find(|(id, _)| *id == wanted) {
        return Ok((*id).to_owned());
    }
    let named: Vec<&(&str, &str)> = spaces.iter().filter(|(_, name)| *name == wanted).collect();
    match named.as_slice() {
        [(id, _)] => Ok((*id).to_owned()),
        [] => Err(format!(
            "no space has the id or the name {wanted:?} (spaces: {})",
            if spaces.is_empty() {
                "none".to_owned()
            } else {
                spaces
                    .iter()
                    .map(|(id, name)| format!("{name:?} {id}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        )),
        many => Err(format!(
            "{} spaces are named {wanted:?}; use an id: {}",
            many.len(),
            many.iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spaces() -> Value {
        json!({ "spaces": [
            { "id": "s1", "name": "Work" },
            { "id": "s2", "name": "Home" },
            { "id": "s3", "name": "Twin" },
            { "id": "s4", "name": "Twin" },
            { "id": "Home", "name": "Odd" },
        ] })
    }

    #[test]
    fn a_space_is_found_by_id_or_by_name() {
        assert_eq!(resolve_space(&spaces(), "s1").unwrap(), "s1");
        assert_eq!(resolve_space(&spaces(), "Work").unwrap(), "s1");
    }

    #[test]
    fn an_id_wins_over_a_name() {
        // "Home" is the name of s2 and the id of another space: the id is meant.
        assert_eq!(resolve_space(&spaces(), "Home").unwrap(), "Home");
    }

    #[test]
    fn a_name_two_spaces_share_is_refused_and_so_is_an_unknown_one() {
        let twin = resolve_space(&spaces(), "Twin").unwrap_err();
        assert!(twin.contains("s3") && twin.contains("s4"), "{twin}");
        let none = resolve_space(&spaces(), "Nope").unwrap_err();
        assert!(none.contains("Nope") && none.contains("Work"), "{none}");
        assert!(
            resolve_space(&json!({ "spaces": [] }), "x")
                .unwrap_err()
                .contains("none")
        );
        assert!(resolve_space(&json!({}), "x").is_err());
    }
}

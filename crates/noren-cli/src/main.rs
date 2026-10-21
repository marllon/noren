//! `noren-cli`: the command line of Noren. It drives a running Noren through its local API
//! (`noren_core::api`), the same calls a script could make: open a tab, split, type into a
//! terminal, read it, show a notification. No Tauri here and no window; this is a plain console
//! program, which is why it is not the `noren` binary of the app (see `Cargo.toml`).

use std::io::Write;
use std::process::ExitCode;

mod args;
mod run;

fn main() -> ExitCode {
    let mut arguments = Vec::new();
    for argument in std::env::args_os().skip(1) {
        match argument.into_string() {
            Ok(text) => arguments.push(text),
            Err(_) => {
                eprintln!("noren-cli: an argument is not valid text");
                return exit_code(run::EXIT_USAGE);
            }
        }
    }
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let mut out = stdout.lock();
    let mut err = stderr.lock();
    let code = run::run(
        &arguments,
        &|name| std::env::var(name).ok(),
        &mut out,
        &mut err,
    );
    let _ = out.flush();
    exit_code(code)
}

fn exit_code(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

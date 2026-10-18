// Keeps the release build from opening a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::process;
use std::thread;
use std::time::Duration;

use tauri::Listener;

const SMOKE_FLAG: &str = "--smoke";
const SMOKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Prints `line` to stdout and flushes it so a parent process sees it before we exit.
fn print_line(line: &str) {
    let mut out = std::io::stdout().lock();
    // A closed stdout must not turn the smoke check into a panic.
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// Smoke mode: wait for the interface to emit `app-ready`, report it and quit.
/// If the interface never answers, exit with an error after `SMOKE_TIMEOUT`.
fn arm_smoke(app: &tauri::App) {
    let handle = app.handle().clone();
    app.listen("app-ready", move |_event| {
        print_line("SMOKE OK");
        handle.exit(0);
    });

    thread::spawn(|| {
        thread::sleep(SMOKE_TIMEOUT);
        eprintln!(
            "SMOKE FAILED: app-ready not received within {}s",
            SMOKE_TIMEOUT.as_secs()
        );
        process::exit(1);
    });
}

fn main() {
    let smoke = std::env::args().any(|arg| arg == SMOKE_FLAG);

    tauri::Builder::default()
        .setup(move |app| {
            if smoke {
                arm_smoke(app);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Noren");
}

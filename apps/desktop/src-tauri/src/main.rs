// Keeps the release build from opening a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod smoke;

use tauri::{Manager, RunEvent};

use bridge::AppState;

fn main() {
    let smoke = std::env::args().any(|arg| arg == smoke::SMOKE_FLAG);

    let app = tauri::Builder::default()
        .manage(AppState::detect())
        .invoke_handler(tauri::generate_handler![
            bridge::profiles_list,
            bridge::session_create,
            bridge::session_write,
            bridge::session_resize,
            bridge::session_kill,
        ])
        .setup(move |app| {
            if smoke {
                smoke::arm(app);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Noren");

    app.run(|handle, event| {
        // No terminal session may outlive the app.
        if let RunEvent::Exit = event {
            handle.state::<AppState>().sessions.shutdown();
        }
    });
}

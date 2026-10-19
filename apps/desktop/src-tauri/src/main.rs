// Keeps the release build from opening a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod deeplink;
mod lifecycle;
mod notify;
mod smoke;
mod window_effect;

use tauri::{Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use bridge::{AppState, BackgroundState, ConfigState, ModState, ScrollbackState, ThemeState};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let smoke = args.iter().skip(1).any(|arg| arg == smoke::SMOKE_FLAG);
    let smoke_deeplink = deeplink::has_smoke_deeplink_flag(&args);
    // The deep-link check needs a link with a folder before anything starts.
    let smoke_link = if smoke_deeplink {
        match smoke::deeplink_target(&args) {
            Ok(target) => Some(target),
            Err(message) => {
                eprintln!("SMOKE FAILED: {message}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    let any_smoke = smoke || smoke_deeplink;

    let mut builder = tauri::Builder::default();
    // First of all, so a second instance is detected before the rest of the setup runs. Not in a
    // smoke mode: there it would hand the link to a Noren the user has open and focus its window.
    if !any_smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            deeplink::on_second_instance(app, argv);
        }));
    }
    // The scheme itself is declared in tauri.conf.json (plugins > deep-link) and written by the
    // installer. Nothing here registers it at run time or touches the registry.
    builder = builder.plugin(tauri_plugin_deep_link::init());
    // Only the Rust side of the plugin is used (see notify.rs); nothing is shown until asked.
    builder = builder.plugin(tauri_plugin_notification::init());

    let app = builder
        .manage(AppState::detect())
        .manage(deeplink::Links::default())
        .manage(lifecycle::CloseGate::default())
        .on_window_event(lifecycle::on_window_event)
        .invoke_handler(tauri::generate_handler![
            bridge::profiles_list,
            bridge::profiles_set_user,
            bridge::session_create,
            bridge::session_write,
            bridge::session_resize,
            bridge::session_kill,
            bridge::state_load,
            bridge::state_save,
            bridge::state_quarantine,
            bridge::project_actions_read,
            bridge::project_command_run,
            bridge::git_info,
            bridge::config_load,
            bridge::config_save,
            bridge::config_watch,
            bridge::theme_list,
            bridge::theme_save,
            bridge::scrollback_load,
            bridge::scrollback_list,
            bridge::scrollback_save,
            bridge::scrollback_delete,
            lifecycle::app_close_listening,
            lifecycle::app_close_ready,
            bridge::mod_list,
            bridge::mod_watch,
            bridge::window_effect_set,
            bridge::background_image_read,
            bridge::fonts_list_monospace,
            notify::notify_show,
            notify::window_is_focused,
            deeplink::deep_link_take_waiting,
            deeplink::deep_link_applied,
        ])
        .setup(move |app| {
            match &smoke_link {
                // The deep-link check never touches the user's state: it runs on an empty folder.
                Some(target) => {
                    app.manage(smoke::deeplink_state_store(target));
                    app.manage(ConfigState::new(smoke::deeplink_config_store(target)));
                    app.manage(ThemeState::new(smoke::deeplink_theme_store(target)));
                    app.manage(ScrollbackState::new(smoke::deeplink_scrollback_store(
                        target,
                    )));
                    app.manage(ModState::new(smoke::deeplink_mod_store(target)).without_watching());
                    app.manage(BackgroundState::new(smoke::deeplink_background_store(
                        target,
                    )));
                    app.manage(target.clone());
                }
                None => {
                    app.manage(bridge::state_store(app.handle())?);
                    let config = ConfigState::new(bridge::config_store(app.handle())?);
                    // The smoke run reads the settings but does not watch them: watching would
                    // create the config folder of the user.
                    app.manage(if smoke {
                        config.without_watching()
                    } else {
                        config
                    });
                    // The smoke run lists the themes of the user (a read) but never writes one.
                    let themes = ThemeState::new(bridge::theme_store(app.handle())?);
                    app.manage(if smoke {
                        themes.without_writing()
                    } else {
                        themes
                    });
                    // The smoke run reads the scrollback snapshots of the user but never writes or
                    // removes one.
                    let scrollback = ScrollbackState::new(bridge::scrollback_store(app.handle())?);
                    app.manage(if smoke {
                        scrollback.without_writing()
                    } else {
                        scrollback
                    });
                    // The smoke run lists the mods of the user (a read) but does not watch the
                    // folder: watching would create it.
                    let mods = ModState::new(bridge::mod_store(app.handle())?);
                    app.manage(if smoke { mods.without_watching() } else { mods });
                    // The pictures of a background are only read.
                    app.manage(BackgroundState::new(bridge::background_store(
                        app.handle(),
                    )?));
                }
            }
            // The window is created hidden (tauri.conf.json); only a normal start shows it.
            if smoke::should_show_window(any_smoke)
                && let Some(window) = app.get_webview_window("main")
            {
                window.show()?;
                window.set_focus()?;
            }
            // A link the system passed on the command line of this first start.
            for url in deeplink::links_from_args(std::env::args()) {
                deeplink::deliver(app.handle(), url);
            }
            // Links the system hands over while running (macOS); on Windows and Linux they come
            // as arguments, through the single-instance callback above.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let url = url.to_string();
                    if deeplink::looks_like_link(&url) {
                        deeplink::deliver(&handle, url);
                    }
                }
            });
            if smoke {
                smoke::arm(app);
            }
            if let Some(target) = smoke_link.clone() {
                smoke::arm_deeplink(app, target);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Noren");

    app.run(|handle, event| {
        // No terminal session may outlive the app.
        if let RunEvent::Exit = event {
            handle.state::<AppState>().sessions.shutdown();
            if let Some(target) = handle.try_state::<smoke::DeepLinkTarget>() {
                target.remove_state_dir();
            }
        }
    });
}

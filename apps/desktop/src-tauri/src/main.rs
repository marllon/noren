// Keeps the release build from opening a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod api_bridge;
mod api_events;
mod bridge;
mod browser_pane;
#[cfg(test)]
mod capabilities;
mod daemon_link;
mod deeplink;
mod lifecycle;
mod link;
mod navigation;
mod notify;
mod pane_sessions;
mod perf;
mod persist;
mod prespawn;
mod quick;
mod remote;
#[cfg(test)]
mod remote_docker;
#[cfg(test)]
mod remote_fake;
mod route;
mod shortcut;
mod smoke;
mod smoke_api;
mod smoke_browser;
mod smoke_persist;
mod smoke_window;
mod tray;
mod window_effect;
mod windows;

use tauri::{Listener, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

use ai::AiState;
use bridge::{
    AppState, BackgroundState, BenchState, ConfigState, ModState, ScrollbackState, ThemeState,
};
use daemon_link::{DEFAULT_ENDPOINT_NAME, DaemonSettings, Host};
use pane_sessions::PaneBook;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // The first thing, so the zero of the marks is the start of the program (NOR-F11-01d).
    if perf::has_perf_flag(&args) {
        perf::enable();
    }
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
    let smoke_quick = smoke::has_smoke_quick_flag(&args);
    // The quick run promotes a shell into a new tab, which the interface saves: it keeps the files
    // of the app in a folder of its own.
    let quick_sandbox = smoke_quick.then(smoke::QuickSandbox::new);
    // The perf run keeps the files of the app in a folder of its own too, with a saved workspace
    // of the tabs it was asked for, and writes its result to the file it was given.
    let perf_run = if perf::has_perf_flag(&args) {
        match perf::parse_args(&args).and_then(|run| run.prepare().map(|()| run)) {
            Ok(run) => Some(run),
            Err(message) => {
                eprintln!("SMOKE FAILED: {message}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    // The persistence run: a shell outlives the app that started it, checked by two runs on one
    // daemon and one folder of their own (scripts/smoke.mjs starts both).
    let persist_run = if smoke_persist::has_flag(&args) {
        match smoke_persist::parse_args(&args) {
            Ok(run) => Some(run),
            Err(message) => {
                eprintln!("SMOKE FAILED: {message}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    // The window run makes a second window and moves a tab to it. The page of the main window saves
    // the workspace it makes, so the run keeps the files of the app in a folder of its own too.
    let smoke_window = smoke_window::has_flag(&args);
    let window_sandbox = smoke_window.then(smoke_window::WindowSandbox::new);
    // The API run is a client of the local API: it makes a space, which the page of the main window
    // saves, so it keeps the files of the app in a folder of its own too.
    let smoke_api = smoke_api::has_flag(&args);
    let api_sandbox = smoke_api.then(smoke_api::ApiSandbox::new);
    let any_smoke = smoke
        || smoke_deeplink
        || smoke_quick
        || smoke_window
        || smoke_api
        || perf_run.is_some()
        || persist_run.is_some();

    let mut builder = tauri::Builder::default();
    // First of all, so a second instance is detected before the rest of the setup runs. Not in a
    // smoke mode: there it would hand the link to a Noren the user has open and focus its window.
    if !any_smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            deeplink::on_second_instance(app, argv);
        }));
    }
    // No web view of the app may navigate away from the pages the app serves.
    builder = builder.plugin(navigation::guard());
    // The scheme itself is declared in tauri.conf.json (plugins > deep-link) and written by the
    // installer. Nothing here registers it at run time or touches the registry.
    builder = builder.plugin(tauri_plugin_deep_link::init());
    // Only the Rust side of the plugin is used (see notify.rs); nothing is shown until asked.
    builder = builder.plugin(tauri_plugin_notification::init());
    // The global shortcut of the quick terminal. The plugin registers nothing by itself and its own
    // commands get no capability; `shortcut.rs` is the only caller. Present in the smoke runs too,
    // so they can ask it what is registered (nothing, they register no shortcut).
    builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(shortcut::on_event)
            .build(),
    );

    // The keys of the AI providers live in the keychain of the system. The smoke runs get a vault
    // in memory: they never touch the keychain of the person, and call no AI command.
    let ai_state = if any_smoke {
        AiState::with_vault(std::sync::Arc::new(noren_core::MemoryVault::new()))
    } else {
        AiState::system()
    }
    .expect("could not build the AI client");

    // Where the sessions live: in the session daemon of the user, found or started next to the app.
    // A smoke run has a daemon of its own, under a name only it uses, and stops it when it ends, so
    // it never meets the daemon of the user. The perf run measures the start of a shell inside the
    // app (what its numbers are compared with), so it keeps the sessions in the process.
    let host = if perf_run.is_some() {
        Host::InProcess
    } else if let Some(run) = &persist_run {
        Host::Daemon(run.daemon_settings())
    } else if any_smoke {
        Host::Daemon(DaemonSettings::for_run(smoke::run_daemon_name()))
    } else {
        Host::Daemon(DaemonSettings::normal())
    };
    let perf_state_file = perf_run
        .as_ref()
        .map(|run| run.state_dir.join(bridge::STATE_FILE_NAME));
    let app = builder
        .manage(AppState::detect(host))
        .manage(deeplink::Links::default())
        .manage(lifecycle::CloseGate::default())
        .manage(shortcut::QuickShortcut::new(!any_smoke))
        // The windows besides the main one; the ones a smoke run opens stay hidden.
        .manage(windows::WindowBook::new(!any_smoke))
        .manage(ai_state)
        .manage(bridge::HardwareState::system())
        .on_window_event(lifecycle::on_window_event)
        .on_page_load(|webview, payload| {
            let event = match payload.event() {
                tauri::webview::PageLoadEvent::Started => "started",
                tauri::webview::PageLoadEvent::Finished => "finished",
            };
            perf::mark(&format!("page-load-{event}:{}", webview.label()));
            // A page of the main window that starts loading is not listening for API calls yet.
            if webview.label() == lifecycle::MAIN_LABEL
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                api_bridge::page_loading(webview.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            ai::ai_providers,
            ai::ai_configure,
            ai::ai_ollama_models,
            ai::ai_ollama_memory,
            ai::ai_test_connection,
            ai::ai_set_key,
            ai::ai_chat_stream,
            ai::ai_cancel,
            bridge::profiles_list,
            bridge::profiles_set_user,
            bridge::session_create,
            bridge::session_attach,
            bridge::session_reattach,
            bridge::sessions_keep_set,
            shortcut::quick_shortcut_set,
            shortcut::quick_toggle,
            bridge::session_write,
            bridge::session_resize,
            bridge::session_kill,
            bridge::session_retry,
            bridge::state_load,
            bridge::state_save,
            bridge::state_quarantine,
            bridge::project_actions_read,
            bridge::project_command_run,
            bridge::git_info,
            bridge::agents_scan,
            bridge::worktree_list,
            bridge::worktree_create,
            bridge::worktree_remove,
            bridge::ssh_hosts_list,
            bridge::docker_containers_list,
            bridge::config_load,
            bridge::config_save,
            bridge::config_watch,
            bridge::theme_list,
            bridge::theme_save,
            bridge::bench_list,
            bridge::bench_save,
            bridge::scrollback_load,
            bridge::scrollback_list,
            bridge::scrollback_save,
            bridge::scrollback_delete,
            lifecycle::app_close_listening,
            lifecycle::app_close_ready,
            bridge::mod_list,
            bridge::mod_watch,
            bridge::plugins_list,
            bridge::gallery_index,
            bridge::gallery_installed,
            bridge::gallery_install,
            bridge::window_effect_set,
            bridge::background_image_read,
            bridge::file_preview_read,
            bridge::git_diff_read,
            bridge::fonts_list_monospace,
            bridge::hardware_read,
            link::link_open,
            browser_pane::browser_open,
            browser_pane::browser_navigate,
            browser_pane::browser_set_bounds,
            browser_pane::browser_close,
            windows::window_open,
            windows::window_close,
            windows::window_move_tab,
            notify::notify_show,
            notify::window_is_focused,
            deeplink::deep_link_take_waiting,
            deeplink::deep_link_applied,
            api_bridge::api_respond,
            api_bridge::api_ready,
            api_events::api_agent_state,
        ])
        .setup(move |app| {
            perf::mark("setup-start");
            windows::install(app.handle());
            match (
                &smoke_link,
                &quick_sandbox,
                &perf_run,
                &persist_run,
                &window_sandbox,
                &api_sandbox,
            ) {
                // The deep-link, quick, perf and persistence checks never touch the user's files:
                // they run on a folder of their own.
                (Some(target), _, _, _, _, _) => {
                    smoke::manage_sandbox_stores(app, &target.state_dir);
                    app.manage(target.clone());
                }
                (None, Some(sandbox), _, _, _, _) => {
                    smoke::manage_sandbox_stores(app, &sandbox.state_dir);
                    app.manage(sandbox.clone());
                }
                (None, None, Some(run), _, _, _) => {
                    smoke::manage_sandbox_stores(app, &run.state_dir);
                    app.manage(run.clone());
                }
                (None, None, None, None, Some(sandbox), _) => {
                    smoke::manage_sandbox_stores(app, &sandbox.state_dir);
                    app.manage(sandbox.clone());
                }
                (None, None, None, Some(run), _, _) => {
                    smoke::manage_sandbox_stores(app, &run.dir);
                    // Both runs of the pair keep the book of which shell is which pane's in the
                    // folder they share.
                    app.state::<AppState>()
                        .use_pane_book(PaneBook::open(run.book_file(), &run.endpoint));
                }
                (None, None, None, None, None, Some(sandbox)) => {
                    smoke::manage_sandbox_stores(app, &sandbox.state_dir);
                    app.manage(sandbox.clone());
                }
                (None, None, None, None, None, None) => {
                    // Which shell is which pane's is kept next to the saved state, for the daemon
                    // of the user. The plain smoke run keeps it in memory: it must not touch the
                    // book of the user.
                    if !any_smoke {
                        let book = bridge::state_file(app.handle())?
                            .with_file_name(pane_sessions::BOOK_FILE_NAME);
                        app.state::<AppState>()
                            .use_pane_book(PaneBook::open(book, DEFAULT_ENDPOINT_NAME));
                    }
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
                    // The smoke run lists the bench results of the user (a read) but never writes one.
                    let bench = BenchState::new(bridge::bench_store(app.handle())?);
                    app.manage(if smoke {
                        bench.without_writing()
                    } else {
                        bench
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
                    // The plugins of the user are only read, never watched or made.
                    app.manage(bridge::plugin_store(app.handle())?);
                    // The gallery downloads and installs only when the interface asks; the smoke
                    // run never installs.
                    let gallery = bridge::gallery_state(app.handle())?;
                    app.manage(if smoke {
                        gallery.without_installing()
                    } else {
                        gallery
                    });
                    // The pictures of a background are only read.
                    app.manage(BackgroundState::new(bridge::background_store(
                        app.handle(),
                    )?));
                }
            }
            // The local API (NOR-F17-01c): its token lives in the data folder of the user, and a smoke
            // run uses an endpoint and a folder of its own, like its daemon, so it never meets the API
            // of a Noren the user has open. A server that does not start leaves the app without it.
            api_bridge::install(
                app.handle(),
                if any_smoke {
                    Ok(api_bridge::ApiSettings::for_run(
                        smoke::run_daemon_name(),
                        smoke::fresh_dir("noren-smoke-api"),
                    ))
                } else {
                    app.path()
                        .app_data_dir()
                        .map(|dir| api_bridge::ApiSettings::normal(&dir))
                        .map_err(|e| format!("could not find the app data folder: {e}"))
                },
            );
            // The window is created hidden (tauri.conf.json); only a normal start shows it.
            if smoke::should_show_window(any_smoke)
                && let Some(window) = lifecycle::main_window(app.handle())
            {
                window.show()?;
                window.set_focus()?;
            }
            // The tray icon, which closing the window with the shells kept leaves the app running
            // in. Only a normal start has one: the smoke modes have no one to click it. Without it
            // closing the window quits, as before.
            if !any_smoke && let Err(reason) = tray::install(app.handle()) {
                eprintln!("warning: no tray icon ({reason}); closing the window will quit the app");
            }
            // The quick terminal: a second window, hidden, that loads its page once the main one is up
            // (see `quick::create_hidden_after_ready`), so it is ready when something shows it. The
            // plain smoke runs check the main window alone and leave it out.
            if !smoke && !smoke_deeplink && !smoke_window && !smoke_api && persist_run.is_none() {
                quick::create_hidden_after_ready(app);
            }
            // The global shortcut of the quick terminal: only a normal start registers one. A chord
            // another program holds is a line in the log, not a reason to stop.
            if !any_smoke {
                shortcut::register_default(app.handle());
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
            if let Some(sandbox) = quick_sandbox.clone() {
                smoke::arm_quick(app, sandbox);
            }
            if let Some(run) = perf_run.clone() {
                perf::arm(app, run);
            }
            if let Some(run) = persist_run.clone() {
                smoke_persist::arm(app, run);
            }
            if let Some(sandbox) = window_sandbox.clone() {
                smoke_window::arm(app, sandbox);
            }
            if let Some(sandbox) = api_sandbox.clone() {
                smoke_api::arm(app, sandbox);
            }
            perf::mark("setup-end");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Noren");
    perf::mark("built");
    // The shell of the pane on screen starts now, in the time the web view takes to start (see
    // `prespawn`). Not in the smoke runs, whose state is not the one the page will read, and whose
    // sessions the checks count.
    let prespawn_state = match (perf_state_file, any_smoke) {
        (Some(file), _) => Some(file),
        (None, false) => bridge::state_file(app.handle()).ok(),
        (None, true) => None,
    };
    if let Some(file) = prespawn_state {
        prespawn::start(app.handle(), file);
        // The page asks for its shells before it says it is up; one nobody claimed ends here.
        let handle = app.handle().clone();
        app.once("app-ready", move |_| {
            handle.state::<AppState>().close_prespawn();
            // Every pane has had its shell by now (the ones it had before the app was closed taken
            // over, new ones for the rest): what the daemon still holds belongs to no pane. This
            // can wait on the daemon, so it does not hold the event up.
            let handle = handle.clone();
            std::thread::spawn(move || {
                handle.state::<AppState>().reap_orphans();
            });
        });
    }

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // The shells of the panes outlive the app when the settings keep them and they live in
            // the daemon; every other session ends with it.
            handle.state::<AppState>().end_sessions_on_exit();
            if let Some(api) = handle.try_state::<api_bridge::ApiState>() {
                api.stop();
            }
            if let Some(target) = handle.try_state::<smoke::DeepLinkTarget>() {
                target.remove_state_dir();
            }
            if let Some(sandbox) = handle.try_state::<smoke::QuickSandbox>() {
                sandbox.remove();
            }
            if let Some(run) = handle.try_state::<perf::PerfRun>() {
                run.remove();
            }
            if let Some(sandbox) = handle.try_state::<smoke_window::WindowSandbox>() {
                sandbox.remove();
            }
            if let Some(sandbox) = handle.try_state::<smoke_api::ApiSandbox>() {
                sandbox.remove();
            }
        }
    });
}

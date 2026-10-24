//! The browser process of the web view, started while the program is still setting itself up
//! (NOR-F20-14b).
//!
//! The first prompt waited about 200 ms for WebView2: after the builder, the event loop makes the
//! window, wry creates the environment (the runtime library is loaded and the browser process
//! started) and only then the controller and the navigation follow. Creating the environment is a
//! call that starts the process and answers later, so a thread of its own makes it from the first
//! line of `main`, and the environment wry makes some milliseconds after finds the process there
//! already, with its profile read.
//!
//! This only works while the two environments agree: WebView2 refuses (`ERROR_INVALID_STATE`) a
//! second environment on the same user data folder in the same process with other options, and the
//! window would not open. So the folder is the one Tauri gives the web view (the local data folder
//! of the app) and the options are the ones wry 0.57 builds when nothing asks for others:
//! `wry/src/webview2/mod.rs`, `create_environment`. `pnpm smoke` is what tells a wry that changed
//! them: the main window would not come up and the run would fail. A mismatch in the folder alone
//! is harmless (a browser process nobody uses and a thread that ends); one in the options is not.

/// What wry gives the browser when a webview asks for nothing else: its own default features, and
/// the autoplay policy it adds for a webview with autoplay on (the default).
#[cfg(windows)]
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// How long the thread keeps its environment: until the window of the app has made its own, which
/// holds the browser process by then. Dropped sooner than that, the process would end with it.
#[cfg(windows)]
const HOLD: std::time::Duration = std::time::Duration::from_secs(8);

/// Starts the browser process of the web view of the app `identifier` (the `identifier` of
/// `tauri.conf.json`, which names its folder under the local data folder). Returns at once; nothing
/// is waited for and a failure at any step is ignored (the window then makes its own environment,
/// as it always did).
pub fn start(identifier: &str) {
    #[cfg(windows)]
    {
        let Some(local) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let folder = std::path::PathBuf::from(local).join(identifier);
        let _ = std::thread::Builder::new()
            .name("web-view-warm".to_owned())
            .spawn(move || warm(&folder));
    }
    #[cfg(not(windows))]
    {
        let _ = identifier;
    }
}

#[cfg(windows)]
fn warm(folder: &std::path::Path) {
    use std::sync::mpsc;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT, CreateCoreWebView2EnvironmentWithOptions,
        ICoreWebView2EnvironmentOptions,
    };
    use webview2_com::{
        CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentCompletedHandler,
    };
    use windows::Win32::Globalization::{
        GetUserDefaultUILanguage, LCIDToLocaleName, LOCALE_ALLOW_NEUTRAL_NAMES, MAX_LOCALE_NAME,
    };
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};
    use windows::core::{HSTRING, PCWSTR};

    let (sender, receiver) = mpsc::channel();
    let environment = unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let options = CoreWebView2EnvironmentOptions::default();
        options.set_additional_browser_arguments(BROWSER_ARGS.to_owned());
        options.set_are_browser_extensions_enabled(false);
        // The language of the system, written the way wry writes it.
        let lcid = GetUserDefaultUILanguage();
        let mut language = [0; MAX_LOCALE_NAME as usize];
        LCIDToLocaleName(lcid as u32, Some(&mut language), LOCALE_ALLOW_NEUTRAL_NAMES);
        options.set_language(String::from_utf16_lossy(&language));
        options.set_scroll_bar_style(COREWEBVIEW2_SCROLLBAR_STYLE_DEFAULT);
        let started = CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &HSTRING::from(folder),
            &ICoreWebView2EnvironmentOptions::from(options),
            &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                move |error_code, environment| {
                    let result = (|| {
                        error_code?;
                        environment.ok_or_else(|| {
                            windows::core::Error::from(windows::Win32::Foundation::E_POINTER)
                        })
                    })();
                    sender.send(result).map_err(|_| {
                        windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)
                    })
                },
            )),
        );
        if started.is_err() {
            return;
        }
        webview2_com::wait_with_pump(receiver)
    };
    // Kept for a while so the browser process outlives the wait for the window's own environment.
    if let Ok(Ok(environment)) = environment {
        std::thread::sleep(HOLD);
        drop(environment);
    }
}

use super::*;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse};
use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

const BOUNDS: Bounds = Bounds {
    x: 10.0,
    y: 20.0,
    width: 400.0,
    height: 300.0,
};

fn url(text: &str) -> Url {
    Url::parse(text).expect("a valid address")
}

#[test]
fn only_http_and_https_pages_are_accepted() {
    for address in [
        "http://example.com",
        "https://example.com/a/b?c=d#e",
        "HTTPS://Example.COM/",
        "http://localhost:3000/",
        "http://127.0.0.1:8080/index.html",
        "http://[::1]:8080/",
        "http://notlocalhost.example/",
    ] {
        assert!(check_url(address).is_ok(), "{address}");
    }
}

#[test]
fn file_javascript_data_and_noren_addresses_are_refused() {
    for address in [
        "file:///C:/Windows/win.ini",
        "file://server/share/x",
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "noren://open?path=/tmp",
        "tauri://localhost/",
        "ipc://localhost/session_create",
        "blob:http://example.com/1",
        "about:blank",
        "ftp://example.com/",
        "ws://example.com/",
        "example.com",
        "C:\\Windows\\notepad.exe",
        "",
    ] {
        assert!(check_url(address).is_err(), "{address:?}");
        // The same rule for a page that goes somewhere by itself, where the address is a parsed one.
        if let Ok(parsed) = Url::parse(address) {
            assert!(!allows_navigation(&parsed), "{address:?}");
        }
    }
}

#[test]
fn an_address_with_a_user_name_a_blank_or_a_control_character_is_refused() {
    for address in [
        "https://good.example@evil.example/",
        "https://user:pass@example.com/",
        "https://example.com/a b",
        "https://example.com/\u{0}",
        "https://example.com\\evil",
        "https://",
        "https:///path",
    ] {
        assert!(check_url(address).is_err(), "{address:?}");
    }
    let long = format!("https://example.com/{}", "a".repeat(2048));
    assert!(check_url(&long).is_err());
}

#[test]
fn the_names_the_app_serves_its_own_pages_from_are_refused() {
    for address in [
        "http://tauri.localhost/",
        "https://tauri.localhost/index.html",
        "HTTP://TAURI.LOCALHOST/",
        "http://tauri.localhost./",
        "http://tauri.localhost:80/",
        "http://ipc.localhost/session_create",
        "http://asset.localhost/x",
        "https://anything.localhost/",
        "http://a.b.localhost:3000/",
        // The engine reads an escape in a host as the character, and so does `Url`.
        "http://tauri%2Elocalhost/",
        "http://tauri.local%68ost/",
    ] {
        let result = check_url(address);
        assert_eq!(
            result,
            Err("The address is one of the app's own.".to_owned()),
            "{address}"
        );
        let parsed = url(address);
        assert!(!allows_navigation(&parsed), "{address}");
    }
    // A path or a query that mentions the app is only text.
    assert!(check_url("https://example.com/tauri.localhost").is_ok());
    assert!(check_url("https://example.com/?next=http://tauri.localhost/").is_ok());
}

#[test]
fn a_page_that_goes_somewhere_by_itself_follows_the_same_rule() {
    assert!(allows_navigation(&url("https://example.com/next")));
    // A long address is fine for a link the page follows (only the one typed is bounded).
    let long = format!("https://example.com/{}", "a".repeat(5000));
    assert!(allows_navigation(&url(&long)));
    for refused in [
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "data:text/html,hi",
        "blob:https://example.com/1",
        "noren://open",
        "tauri://localhost/",
        "http://tauri.localhost/",
        "https://user@example.com/",
    ] {
        assert!(!allows_navigation(&url(refused)), "{refused}");
    }
}

#[test]
fn the_label_of_a_web_view_is_the_pane_id_after_a_fixed_start() {
    assert_eq!(pane_label("p1").as_deref(), Ok("browser-p1"));
    let uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";
    assert_eq!(pane_label(uuid), Ok(format!("browser-{uuid}")));
    assert_eq!(pane_label(&"x".repeat(64)).map(|l| l.len()), Ok(72));
    for id in ["", "a b", "../x", "p/1", "p:1", "p.1", "é", &"x".repeat(65)] {
        assert!(pane_label(id).is_err(), "{id:?}");
    }
    // No id can make the label of another web view of the app.
    for id in ["main", "quick", "a", "browser"] {
        assert!(is_pane_label(&pane_label(id).expect("a pane id")));
    }
    assert!(!is_pane_label("main"));
    assert!(!is_pane_label("quick"));
    assert!(!is_pane_label("Browser-x"));
}

#[test]
fn the_place_of_a_web_view_must_be_numbers_that_make_sense() {
    assert_eq!(check_bounds(&BOUNDS), Ok(()));
    let at = |change: fn(&mut Bounds)| {
        let mut bounds = BOUNDS;
        change(&mut bounds);
        check_bounds(&bounds)
    };
    assert_eq!(at(|b| (b.width, b.height) = (0.0, 0.0)), Ok(()));
    assert_eq!(at(|b| (b.x, b.y) = (-120.0, -5.0)), Ok(()));
    assert_eq!(at(|b| b.width = MAX_EXTENT), Ok(()));
    assert!(at(|b| b.x = f64::NAN).is_err());
    assert!(at(|b| b.y = f64::INFINITY).is_err());
    assert!(at(|b| b.width = f64::NEG_INFINITY).is_err());
    assert!(at(|b| b.height = f64::NAN).is_err());
    assert!(at(|b| b.width = -1.0).is_err());
    assert!(at(|b| b.height = -0.5).is_err());
    assert!(at(|b| b.width = MAX_EXTENT + 1.0).is_err());
    assert!(at(|b| b.height = MAX_EXTENT + 1.0).is_err());
    assert!(at(|b| b.x = MAX_EXTENT + 1.0).is_err());
    assert!(at(|b| b.y = -MAX_EXTENT - 1.0).is_err());
}

#[test]
fn the_page_sends_the_place_as_four_numbers() {
    let bounds: Bounds =
        serde_json::from_str(r#"{"x":1.5,"y":-2,"width":300,"height":200}"#).expect("bounds");
    assert_eq!(
        bounds,
        Bounds {
            x: 1.5,
            y: -2.0,
            width: 300.0,
            height: 200.0
        }
    );
    // A missing number is an error of the call, not a zero.
    assert!(serde_json::from_str::<Bounds>(r#"{"x":1,"y":2,"width":3}"#).is_err());
}

fn app_with_main_window() -> tauri::App<MockRuntime> {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            browser_open,
            browser_navigate,
            browser_set_bounds,
            browser_close
        ])
        .build(mock_context(noop_assets()))
        .expect("build the mock app");
    tauri::WebviewWindowBuilder::new(&app, PARENT_WINDOW, Default::default())
        .build()
        .expect("build the mock window");
    app
}

#[test]
fn a_web_view_opens_as_a_child_of_the_main_window_and_closes() {
    let app = app_with_main_window();
    let handle = app.handle();
    assert!(app.get_webview("browser-p1").is_none());

    open(handle, "p1", "https://example.com/", BOUNDS, None).expect("open");
    let view = app.get_webview("browser-p1").expect("the web view");
    assert_eq!(view.window().label(), "main");
    assert_eq!(view.label(), "browser-p1");
    // The main window keeps its own web view next to it.
    assert!(app.get_webview("main").is_some());

    close(handle, "p1").expect("close");
    assert!(app.get_webview("browser-p1").is_none());
    assert!(app.get_webview("main").is_some());
    // A pane with none is not an error.
    close(handle, "p1").expect("close again");
    close(handle, "never-opened").expect("close a pane that never had one");
}

#[test]
fn a_refused_address_a_bad_place_or_a_bad_id_opens_nothing() {
    let app = app_with_main_window();
    let handle = app.handle();
    for address in [
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "data:text/html,hi",
        "noren://open",
        "http://tauri.localhost/",
        "",
    ] {
        assert!(
            open(handle, "p1", address, BOUNDS, None).is_err(),
            "{address:?}"
        );
    }
    let wide = Bounds {
        width: -1.0,
        ..BOUNDS
    };
    assert!(open(handle, "p1", "https://example.com/", wide, None).is_err());
    for id in ["", "a b", "../x"] {
        assert!(
            open(handle, id, "https://example.com/", BOUNDS, None).is_err(),
            "{id:?}"
        );
    }
    assert!(app.get_webview("browser-p1").is_none());
    assert_eq!(
        app.webviews().len(),
        1,
        "only the web view of the window itself"
    );

    // A pane called `main` gets `browser-main`: no id can name the web view of the window.
    open(handle, "main", "https://example.com/", BOUNDS, None).expect("open");
    assert!(app.get_webview("browser-main").is_some());
    close(handle, "main").expect("close");
    assert!(
        app.get_webview("main").is_some(),
        "the web view of the window was not closed"
    );
}

#[test]
fn a_pane_has_one_web_view_at_a_time() {
    let app = app_with_main_window();
    let handle = app.handle();
    open(handle, "p1", "https://example.com/", BOUNDS, None).expect("open");
    let again = open(handle, "p1", "https://example.org/", BOUNDS, None);
    assert_eq!(again, Err("Pane p1 has a web view already.".to_owned()));
    open(handle, "p2", "https://example.org/", BOUNDS, None).expect("another pane");
    close(handle, "p1").expect("close");
    open(handle, "p1", "https://example.org/", BOUNDS, None).expect("open after close");
}

#[test]
fn navigating_and_moving_need_a_web_view_and_a_good_argument() {
    let app = app_with_main_window();
    let handle = app.handle();
    assert_eq!(
        navigate(handle, "p9", "https://example.com/"),
        Err("Pane p9 has no web view.".to_owned())
    );
    assert_eq!(
        set_bounds(handle, "p9", BOUNDS),
        Err("Pane p9 has no web view.".to_owned())
    );

    open(handle, "p1", "https://example.com/", BOUNDS, None).expect("open");
    navigate(handle, "p1", "https://example.org/docs").expect("navigate");
    set_bounds(
        handle,
        "p1",
        Bounds {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        },
    )
    .expect("move");

    for address in [
        "file:///etc/passwd",
        "javascript:1",
        "data:text/plain,x",
        "noren://x",
    ] {
        assert!(navigate(handle, "p1", address).is_err(), "{address}");
    }
    let negative = Bounds {
        width: -5.0,
        ..BOUNDS
    };
    assert!(set_bounds(handle, "p1", negative).is_err());
    assert!(navigate(handle, "../x", "https://example.com/").is_err());
}

/// Whether the command `cmd` is carried out when the page at `origin`, in the web view `label`,
/// asks for it. Goes through the same `on_message` as a call from a real page.
fn call_is_allowed(
    app: &tauri::App<MockRuntime>,
    label: &str,
    origin: &str,
    cmd: &str,
    args: serde_json::Value,
) -> bool {
    let webview = app.get_webview(label).expect("the web view");
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    webview.on_message(
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().expect("url"),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
        Box::new(move |_webview, _cmd, response, _callback, _error| {
            tx.send(matches!(response, InvokeResponse::Ok(_))).unwrap();
        }),
    );
    rx.recv().expect("an answer to the call")
}

#[test]
fn a_page_in_a_web_view_of_a_pane_can_call_no_command_of_the_app() {
    let app = app_with_main_window();
    open(app.handle(), "p1", "https://example.com/", BOUNDS, None).expect("open");
    open(app.handle(), "p2", "http://127.0.0.1:8080/", BOUNDS, None).expect("open");
    let own = serde_json::json!({ "paneId": "p2" });

    // The web view sits inside the `main` window, whose own page may call the commands: here the
    // control is the page of the app asking from the web view of the window itself.
    let local = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    assert!(
        call_is_allowed(&app, "main", local, "browser_close", own.clone()),
        "the page of the app can call the command"
    );
    open(app.handle(), "p2", "http://127.0.0.1:8080/", BOUNDS, None).expect("open again");

    // A page of someone else cannot, whichever address it is at and whichever web view it is in.
    for origin in [
        "https://example.com/",
        "http://127.0.0.1:8080/",
        "http://localhost:3000/",
    ] {
        for label in ["browser-p1", "browser-p2"] {
            for cmd in ["browser_close", "browser_open", "browser_navigate"] {
                assert!(
                    !call_is_allowed(&app, label, origin, cmd, own.clone()),
                    "{cmd} from {origin} in {label} was allowed"
                );
            }
        }
    }
    assert!(
        app.get_webview("browser-p2").is_some(),
        "a refused call closed nothing"
    );
}

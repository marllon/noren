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

// ---- A web view that is a child of a window besides the main one (NOR-F15-04e) ----

/// The main window, and the book of the windows the app opened (the commands that make a window
/// put each one in it; here `open_window` does).
fn app_with_windows() -> tauri::App<MockRuntime> {
    let app = app_with_main_window();
    app.manage(WindowBook::new(false));
    app
}

/// A web view of the app by its label, with the label of the window it is a child of.
fn parent_of(app: &tauri::App<MockRuntime>, label: &str) -> Option<String> {
    app.get_webview(label)
        .map(|view| view.window().label().to_owned())
}

#[test]
fn a_web_view_opens_as_a_child_of_a_window_the_app_opened() {
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    windows::open_window(handle, "w2", "s3").expect("another window");

    open_in(
        handle,
        Parent::Window("w1"),
        "p1",
        "https://example.com/",
        BOUNDS,
        None,
    )
    .expect("open in w1");
    assert_eq!(parent_of(&app, "browser-p1").as_deref(), Some("window-w1"));
    // The same call for the main window, and for the other window, name those.
    open_in(
        handle,
        Parent::Window("w2"),
        "p2",
        "https://example.org/",
        BOUNDS,
        None,
    )
    .expect("open in w2");
    open_in(
        handle,
        Parent::Main,
        "p3",
        "https://example.net/",
        BOUNDS,
        None,
    )
    .expect("open in main");
    assert_eq!(parent_of(&app, "browser-p2").as_deref(), Some("window-w2"));
    assert_eq!(parent_of(&app, "browser-p3").as_deref(), Some("main"));
    // `open` is the same as a child of main.
    open(handle, "p4", "https://example.com/", BOUNDS, None).expect("open");
    assert_eq!(parent_of(&app, "browser-p4").as_deref(), Some("main"));

    // The other calls find the web view by the pane, whoever its parent is.
    navigate(handle, "p1", "https://example.com/docs").expect("navigate");
    set_bounds(handle, "p1", BOUNDS).expect("move");
    close(handle, "p1").expect("close");
    assert!(app.get_webview("browser-p1").is_none());
    // The windows keep their own pages, and nothing else was closed.
    assert!(app.get_webview("window-w1").is_some());
    assert!(app.get_webview("browser-p2").is_some());
}

#[test]
fn a_window_with_a_web_view_of_a_pane_is_still_a_window_but_no_longer_a_webview_window() {
    // Tauri calls a window a "webview window" only while its one web view is the only one it has.
    // Once the web view of a pane is a child of it, `get_webview_window` does not find it any more
    // and `get_window` does: `windows.rs` looks the windows up the second way for that reason (the
    // lookups of `main` by the first way in other files, finding 256, miss it while a pane is open).
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    assert!(app.get_webview_window("window-w1").is_some());
    open_in(
        handle,
        Parent::Window("w1"),
        "p1",
        "https://example.com/",
        BOUNDS,
        None,
    )
    .expect("open");
    assert!(app.get_webview_window("window-w1").is_none());
    assert!(app.get_window("window-w1").is_some());
    assert!(app.windows().contains_key("window-w1"));
    close(handle, "p1").expect("close");
    assert!(app.get_webview_window("window-w1").is_some());
}

#[test]
fn a_web_view_cannot_be_made_a_child_of_a_window_that_is_not_one_the_app_opened() {
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    let refuse =
        |parent: Parent| open_in(handle, parent, "p1", "https://example.com/", BOUNDS, None);
    // A window nobody opened, the labels of the other windows and of a web view, and bad ids.
    assert_eq!(
        refuse(Parent::Window("w9")),
        Err("Window w9 is not open.".to_owned())
    );
    for id in [
        "main",
        "quick",
        "browser-p2",
        "",
        "a b",
        "../w1",
        "w1\n",
        "window-w1",
    ] {
        assert!(refuse(Parent::Window(id)).is_err(), "{id:?}");
    }
    assert!(app.get_webview("browser-p1").is_none());
    // A window the book forgot (it was closed) cannot be a parent even if its native window lingers.
    app.state::<WindowBook>().remove("w1");
    assert_eq!(
        refuse(Parent::Window("w1")),
        Err("Window w1 is not open.".to_owned())
    );
    // And without a book at all (the app did not set one up) nothing is a window.
    let bare = app_with_main_window();
    assert_eq!(
        open_in(
            bare.handle(),
            Parent::Window("w1"),
            "p1",
            "https://example.com/",
            BOUNDS,
            None
        ),
        Err("Window w1 is not open.".to_owned())
    );
}

#[test]
fn a_pane_has_one_web_view_whichever_window_it_is_a_child_of() {
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    open(handle, "p1", "https://example.com/", BOUNDS, None).expect("open in main");
    assert_eq!(
        open_in(
            handle,
            Parent::Window("w1"),
            "p1",
            "https://example.org/",
            BOUNDS,
            None
        ),
        Err("Pane p1 has a web view already.".to_owned())
    );
    assert_eq!(parent_of(&app, "browser-p1").as_deref(), Some("main"));
    // Closing it first (what the page of a window does before it opens) lets the window have it.
    close(handle, "p1").expect("close");
    open_in(
        handle,
        Parent::Window("w1"),
        "p1",
        "https://example.org/",
        BOUNDS,
        None,
    )
    .expect("open in the window");
    assert_eq!(parent_of(&app, "browser-p1").as_deref(), Some("window-w1"));
    // And back: closed, it opens again as a child of main.
    close(handle, "p1").expect("close");
    open(handle, "p1", "https://example.com/", BOUNDS, None).expect("open in main again");
    assert_eq!(parent_of(&app, "browser-p1").as_deref(), Some("main"));
}

#[test]
fn a_web_view_goes_with_its_window_and_the_other_windows_keep_theirs() {
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    windows::open_window(handle, "w2", "s3").expect("another window");
    for (pane, parent) in [
        ("p1", Parent::Window("w1")),
        ("p2", Parent::Window("w1")),
        ("p3", Parent::Window("w2")),
        ("p4", Parent::Main),
    ] {
        open_in(handle, parent, pane, "https://example.com/", BOUNDS, None).expect("open");
    }
    windows::close_window(handle, "w1").expect("close the window");
    assert!(app.get_webview("browser-p1").is_none(), "left behind");
    assert!(app.get_webview("browser-p2").is_none(), "left behind");
    // (The mock runtime has no event loop, so the window it destroys stays in its list; the book
    // forgets it, and `noren --smoke-window` shows the real window go.)
    assert_eq!(app.state::<WindowBook>().ids(), ["w2"]);
    // The web views of the others are where they were.
    assert_eq!(parent_of(&app, "browser-p3").as_deref(), Some("window-w2"));
    assert_eq!(parent_of(&app, "browser-p4").as_deref(), Some("main"));
    // The pane of the window that closed can have a web view again, in main.
    open(handle, "p1", "https://example.com/", BOUNDS, None).expect("open in main");
    assert_eq!(parent_of(&app, "browser-p1").as_deref(), Some("main"));
    // A window the app closes in a block (the app is closing) takes its web views too.
    windows::destroy_all(handle);
    assert!(app.get_webview("browser-p3").is_none(), "left behind");
    assert!(
        app.get_webview("browser-p1").is_some(),
        "main is not a window to destroy"
    );
}

#[test]
fn only_the_main_window_can_ask_for_a_web_view_for_a_window() {
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    let local = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    let ask = serde_json::json!({
        "paneId": "p1",
        "url": "https://example.com/",
        "bounds": { "x": 1, "y": 2, "width": 300, "height": 200 },
        "windowId": "w1",
    });
    // The page of the window itself is the app's own page, so the access control would let it
    // through here (the mock has none); the command refuses it for not being the main window.
    assert!(!call_is_allowed(
        &app,
        "window-w1",
        local,
        "browser_open",
        ask.clone()
    ));
    assert!(app.get_webview("browser-p1").is_none());
    // The main window's page can: the web view is made, a child of the window it names.
    assert!(call_is_allowed(&app, "main", local, "browser_open", ask));
    assert_eq!(parent_of(&app, "browser-p1").as_deref(), Some("window-w1"));
    // Without a window it is a child of main, as it always was.
    let plain = serde_json::json!({
        "paneId": "p2",
        "url": "https://example.com/",
        "bounds": { "x": 1, "y": 2, "width": 300, "height": 200 },
    });
    assert!(call_is_allowed(&app, "main", local, "browser_open", plain));
    assert_eq!(parent_of(&app, "browser-p2").as_deref(), Some("main"));
    // And a window that is not one is refused by the command too.
    let ghost = serde_json::json!({
        "paneId": "p3",
        "url": "https://example.com/",
        "bounds": { "x": 1, "y": 2, "width": 300, "height": 200 },
        "windowId": "ghost",
    });
    assert!(!call_is_allowed(&app, "main", local, "browser_open", ghost));
    assert!(app.get_webview("browser-p3").is_none());
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

#[test]
fn a_page_in_a_web_view_that_is_a_child_of_a_window_can_call_no_command_of_the_app() {
    let app = app_with_windows();
    let handle = app.handle();
    windows::open_window(handle, "w1", "s2").expect("a window");
    open_in(
        handle,
        Parent::Window("w1"),
        "p1",
        "https://example.com/",
        BOUNDS,
        None,
    )
    .expect("open");
    open_in(
        handle,
        Parent::Window("w1"),
        "p2",
        "http://127.0.0.1:8080/",
        BOUNDS,
        None,
    )
    .expect("open");
    // The web views sit inside a window whose own page may call what its capability grants: a page
    // of someone else in them is a remote origin, whichever window it is in.
    let own = serde_json::json!({ "paneId": "p2" });
    for origin in [
        "https://example.com/",
        "http://127.0.0.1:8080/",
        "http://localhost:3000/",
    ] {
        for label in ["browser-p1", "browser-p2"] {
            for cmd in [
                "browser_close",
                "browser_open",
                "browser_navigate",
                "window_close",
                "session_attach",
            ] {
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

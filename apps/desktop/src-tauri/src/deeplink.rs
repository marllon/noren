//! `noren://` links on the Rust side: pick them out of command-line arguments, hold them until the
//! interface can take them and hand them over as data. Validation is the interface's job (the
//! parser in `@noren/model`); nothing here reads a link beyond what the smoke check needs.

use std::sync::Mutex;
use std::sync::mpsc::Sender;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::lifecycle::main_window;

/// Event the interface listens to; the payload is the raw link as a JSON string.
pub const LINK_EVENT: &str = "deep-link-url";
/// Flag of the hidden mode that proves a link reaches the interface.
pub const SMOKE_DEEPLINK_FLAG: &str = "--smoke-deeplink";

const SCHEME_PREFIX: &str = "noren://";
/// Longest link passed on. A longer one is not a link anybody typed; the parser would refuse it.
const MAX_LINK_CHARS: usize = 8192;
/// Links kept while the interface is not ready; the oldest goes first, like on the interface side.
const MAX_WAITING: usize = 8;

/// True when `arg` could be a `noren://` link: it starts with the scheme (any case), is not
/// absurdly long and has no control character. This only filters command-line noise; the
/// interface decides whether the link is acceptable.
pub fn looks_like_link(arg: &str) -> bool {
    let head = arg.get(..SCHEME_PREFIX.len());
    head.is_some_and(|h| h.eq_ignore_ascii_case(SCHEME_PREFIX))
        && arg.chars().count() <= MAX_LINK_CHARS
        && !arg.chars().any(char::is_control)
}

/// The links among a process's arguments (the first one, the executable, is skipped), in order.
/// The system hands a clicked link to a new process as one argument.
pub fn links_from_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .map(|arg| arg.as_ref().to_string())
        .filter(|arg| looks_like_link(arg))
        .collect()
}

/// The value after `--smoke-deeplink`, if the flag is there.
pub fn smoke_deeplink_arg<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter().skip(1);
    while let Some(arg) = args.next() {
        if arg.as_ref() == SMOKE_DEEPLINK_FLAG {
            return args.next().map(|value| value.as_ref().to_string());
        }
    }
    None
}

/// Whether the flag of the deep-link smoke mode is among the arguments.
pub fn has_smoke_deeplink_flag<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == SMOKE_DEEPLINK_FLAG)
}

/// Decodes `%XX` sequences into text. `None` for a bad sequence or bytes that are not UTF-8. A `+`
/// stays a plus, like in the interface's parser.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The decoded `path` parameter of a link, for the smoke check. `None` when the link has no
/// query, no `path` or a bad encoding.
pub fn folder_of_link(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    let query = query.split('#').next().unwrap_or(query);
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (percent_decode(name)? == "path")
            .then(|| percent_decode(value))
            .flatten()
    })
}

/// A drive path (`C:\x`, `C:/x`) or a UNC path (`\\server\share`).
fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    drive || path.starts_with("\\\\") || path.starts_with("//")
}

/// The form two folders are compared in: `/` for `\`, repeated separators folded (a UNC prefix
/// keeps its two), no trailing separator (the root keeps its own).
fn folder_key(path: &str) -> String {
    let slashed = path.replace('\\', "/");
    let unc = slashed.starts_with("//");
    let mut folded = String::with_capacity(slashed.len());
    for c in slashed.chars() {
        if c == '/' && folded.ends_with('/') {
            continue;
        }
        folded.push(c);
    }
    let trimmed = if folded.len() > 1 {
        folded.trim_end_matches('/').to_string()
    } else {
        folded
    };
    let key = if unc { format!("/{trimmed}") } else { trimmed };
    if key.is_empty() { "/".to_string() } else { key }
}

/// True when two folder paths name the same folder, by the same rules as `sameFolder` in
/// `@noren/model`: `/` and `\` are one separator, a trailing separator does not count, and a path
/// in the Windows style on either side compares without regard to case.
pub fn same_folder(a: &str, b: &str) -> bool {
    let (left, right) = (folder_key(a), folder_key(b));
    if is_windows_path(a) || is_windows_path(b) {
        left.to_lowercase() == right.to_lowercase()
    } else {
        left == right
    }
}

#[derive(Default)]
struct Inner {
    /// True once the interface asked for the waiting links; from then on links are emitted.
    ready: bool,
    waiting: Vec<String>,
}

/// What [`Links::deliver`] decided for one link.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// The interface is up: emit the link now.
    Emit,
    /// The interface is not up: the link waits for [`Links::take_waiting`].
    Kept,
}

/// Links on their way to the interface. Until the interface asks for the waiting ones, a link is
/// kept (so one that arrives during startup is not lost); after that, links are emitted.
#[derive(Default)]
pub struct Links {
    inner: Mutex<Inner>,
    /// Where the interface's report of the active space folder goes, in the deep-link smoke mode.
    report: Mutex<Option<Sender<Option<String>>>>,
}

impl Links {
    /// Decides what to do with a link; a kept link is stored.
    pub fn deliver(&self, url: String) -> Delivery {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.ready {
            return Delivery::Emit;
        }
        inner.waiting.push(url);
        if inner.waiting.len() > MAX_WAITING {
            inner.waiting.remove(0);
        }
        Delivery::Kept
    }

    /// Returns the waiting links and marks the interface ready, in one step, so a link is either
    /// in the returned list or emitted afterwards, never both and never neither.
    pub fn take_waiting(&self) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.ready = true;
        std::mem::take(&mut inner.waiting)
    }

    /// Sends the folder of the active space to the smoke check, if one is waiting for it.
    pub fn report(&self, folder: Option<String>) {
        let sender = self.report.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sender) = sender.as_ref() {
            // The check may have ended already; a late report is of no interest.
            let _ = sender.send(folder);
        }
    }

    /// Arms the smoke check: the next reports go to `sender`.
    pub fn watch_reports(&self, sender: Sender<Option<String>>) {
        *self.report.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    }
}

/// Hands one link to the interface, as data: emitted as an event payload (JSON-escaped by
/// Tauri), never spliced into script text.
pub fn deliver(app: &AppHandle, url: String) {
    let links = app.state::<Links>();
    if links.deliver(url.clone()) == Delivery::Emit {
        let _ = app.emit(LINK_EVENT, url);
    }
}

/// Brings the existing window to the front: shown (it may be hidden in the tray), not minimized,
/// focused. Found with a browser pane open too (see [`main_window`]). `false` when there is no
/// main window to bring up.
pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = main_window(app) else {
        return false;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    true
}

/// What a second instance does: its links go to the interface and the existing window comes up.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>) {
    for url in links_from_args(&args) {
        deliver(app, url);
    }
    focus_main_window(app);
}

/// The interface is up and listening: returns the links that arrived before and makes the next
/// ones come as events.
#[tauri::command]
pub fn deep_link_take_waiting(links: State<'_, Links>) -> Vec<String> {
    links.take_waiting()
}

/// The interface applied a link and reports the default folder of the space it now shows. Only
/// the deep-link smoke mode listens; otherwise this does nothing.
#[tauri::command]
pub fn deep_link_applied(links: State<'_, Links>, folder: Option<String>) {
    links.report(folder);
}

/// The scheme as the plugin spells it, without `://`.
const SCHEME: &str = "noren";

/// What the "register the link" option needs from the system: write the scheme in, take it out.
/// The system implements it through the plugin; the tests use a list.
trait LinkRegistry {
    fn register(&self) -> Result<(), String>;
    fn unregister(&self) -> Result<(), String>;
}

/// The registration of the system, through the deep-link plugin.
struct SystemLinks<'a>(&'a AppHandle);

#[cfg(any(windows, target_os = "linux"))]
impl LinkRegistry for SystemLinks<'_> {
    fn register(&self) -> Result<(), String> {
        use tauri_plugin_deep_link::DeepLinkExt;
        self.0
            .deep_link()
            .register(SCHEME)
            .map_err(|e| format!("could not register the {SCHEME}:// link: {e}"))
    }

    fn unregister(&self) -> Result<(), String> {
        use tauri_plugin_deep_link::DeepLinkExt;
        self.0
            .deep_link()
            .unregister(SCHEME)
            .map_err(|e| format!("could not remove the {SCHEME}:// link: {e}"))
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
impl LinkRegistry for SystemLinks<'_> {
    fn register(&self) -> Result<(), String> {
        Err(format!(
            "registering the {SCHEME}:// link is not supported on this system"
        ))
    }

    fn unregister(&self) -> Result<(), String> {
        Err(format!(
            "removing the {SCHEME}:// link is not supported on this system"
        ))
    }
}

/// Turns the link on (`true`) or off. Exactly one of the two calls is made, and its error is the
/// answer.
fn apply_registration<L: LinkRegistry>(links: &L, registered: bool) -> Result<(), String> {
    if registered {
        links.register()
    } else {
        links.unregister()
    }
}

/// The person turned the option "Register the noren:// link on this computer" on or off in the
/// settings. This is the only place that writes the scheme in the system or takes it out: nothing
/// calls it at start, to bring the system in line with the file, or in a smoke run.
#[tauri::command]
pub fn deep_link_register_set(app: AppHandle, registered: bool) -> Result<(), String> {
    apply_registration(&SystemLinks(&app), registered)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    fn a_mock_app_with_the_main_window() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("the main window");
        app
    }

    #[test]
    fn the_main_window_is_brought_up_with_or_without_a_browser_pane_open() {
        // A link or a second launch brings the window up; the web view of a pane makes Tauri stop
        // calling the main window a webview window, and it must be found all the same.
        let app = a_mock_app_with_the_main_window();
        assert!(focus_main_window(app.handle()));
        crate::browser_pane::open_a_pane_in_main(app.handle());
        assert!(focus_main_window(app.handle()));
    }

    #[test]
    fn with_no_main_window_there_is_nothing_to_bring_up() {
        let app = tauri::test::mock_app();
        assert!(!focus_main_window(app.handle()));
        tauri::WebviewWindowBuilder::new(&app, "other", tauri::WebviewUrl::default())
            .build()
            .expect("a window");
        assert!(!focus_main_window(app.handle()));
    }

    #[test]
    fn the_scheme_filter_accepts_links_in_any_case() {
        assert!(looks_like_link("noren://open?path=%2Fsrv"));
        assert!(looks_like_link("NOREN://open?path=%2Fsrv"));
        assert!(looks_like_link("Noren://action?path=x&id=y"));
        assert!(looks_like_link("noren://"));
    }

    #[test]
    fn the_scheme_filter_refuses_other_arguments() {
        assert!(!looks_like_link(""));
        assert!(!looks_like_link("--smoke"));
        assert!(!looks_like_link("C:\\Users\\x\\noren.exe"));
        assert!(!looks_like_link("https://example.com"));
        assert!(!looks_like_link("noren:open"));
        assert!(!looks_like_link("noren:/open"));
        assert!(!looks_like_link(" noren://open?path=x"));
        assert!(!looks_like_link("xnoren://open?path=x"));
    }

    #[test]
    fn the_scheme_filter_refuses_control_characters_and_huge_arguments() {
        assert!(!looks_like_link("noren://open?path=a\nb"));
        assert!(!looks_like_link("noren://open?path=a\u{0}b"));
        let huge = format!("noren://open?path={}", "a".repeat(MAX_LINK_CHARS));
        assert!(!looks_like_link(&huge));
    }

    #[test]
    fn the_filter_does_not_split_a_multibyte_character() {
        // The first 8 bytes end inside an accented letter.
        assert!(!looks_like_link("noren:/é/open"));
        assert!(!looks_like_link("é"));
    }

    #[test]
    fn links_come_from_the_arguments_after_the_executable() {
        let list = args(&["noren.exe", "noren://open?path=%2Fsrv%2Fproj"]);
        assert_eq!(links_from_args(&list), ["noren://open?path=%2Fsrv%2Fproj"]);
        // The executable itself is never a link.
        assert!(links_from_args(args(&["noren://open?path=%2Fsrv"])).is_empty());
        assert!(links_from_args(args(&["noren.exe"])).is_empty());
        assert!(links_from_args(args(&[])).is_empty());
    }

    #[test]
    fn other_arguments_are_left_out() {
        let list = args(&["noren.exe", "--smoke", "noren://open?path=x", "file.txt"]);
        assert_eq!(links_from_args(&list), ["noren://open?path=x"]);
    }

    #[test]
    fn a_link_with_a_space_and_an_accent_stays_as_written() {
        let raw = "noren://open?path=C%3A%5CUsers%5CJo%C3%A3o%5CMeus%20Projetos";
        assert_eq!(links_from_args(args(&["noren.exe", raw])), [raw]);
    }

    #[test]
    fn a_command_in_the_link_is_passed_on_untouched_for_the_parser_to_refuse() {
        // The Rust side never judges a link beyond the scheme; the interface refuses this one.
        let raw = "noren://open?path=%2Fsrv&command=calc.exe";
        assert_eq!(links_from_args(args(&["noren.exe", raw])), [raw]);
    }

    #[test]
    fn the_smoke_flag_and_its_value_are_found() {
        let list = args(&["noren.exe", "--smoke-deeplink", "noren://open?path=x"]);
        assert!(has_smoke_deeplink_flag(&list));
        assert_eq!(
            smoke_deeplink_arg(&list).as_deref(),
            Some("noren://open?path=x")
        );
        // The value is also a link on the command line, which is how the first start gets it.
        assert_eq!(links_from_args(&list), ["noren://open?path=x"]);
    }

    #[test]
    fn the_smoke_flag_without_a_value_or_absent() {
        let bare = args(&["noren.exe", "--smoke-deeplink"]);
        assert!(has_smoke_deeplink_flag(&bare));
        assert_eq!(smoke_deeplink_arg(&bare), None);
        let none = args(&["noren.exe", "--smoke"]);
        assert!(!has_smoke_deeplink_flag(&none));
        assert_eq!(smoke_deeplink_arg(&none), None);
        // The executable position is not an argument.
        assert!(!has_smoke_deeplink_flag(args(&["--smoke-deeplink"])));
    }

    #[test]
    fn the_folder_of_a_link_is_decoded() {
        assert_eq!(
            folder_of_link("noren://open?path=C%3A%5CUsers%5CJo%C3%A3o%5CMeus%20Projetos")
                .as_deref(),
            Some("C:\\Users\\João\\Meus Projetos")
        );
        assert_eq!(
            folder_of_link("noren://action?id=dev&path=%2Fsrv%2Fproj").as_deref(),
            Some("/srv/proj")
        );
        assert_eq!(
            folder_of_link("noren://open?path=a+b").as_deref(),
            Some("a+b")
        );
    }

    #[test]
    fn a_link_without_a_usable_folder_has_none() {
        assert_eq!(folder_of_link("noren://open"), None);
        assert_eq!(folder_of_link("noren://open?id=x"), None);
        assert_eq!(folder_of_link("noren://open?path=%ZZ"), None);
        assert_eq!(folder_of_link("noren://open?path=%C3"), None);
        assert_eq!(folder_of_link("noren://open?path=%"), None);
    }

    #[test]
    fn same_folder_ignores_the_separator_and_a_trailing_one() {
        assert!(same_folder("C:\\Users\\ada\\dev", "C:/Users/ada/dev"));
        assert!(same_folder("\\\\srv\\share\\p", "//srv/share/p"));
        assert!(same_folder("/srv/proj/", "/srv/proj"));
        assert!(same_folder("C:\\dev\\", "C:/dev"));
        assert!(same_folder("/srv/proj//", "/srv/proj"));
        assert!(same_folder("/", "/"));
        assert!(same_folder("C:\\", "C:/"));
    }

    #[test]
    fn same_folder_ignores_case_only_for_windows_paths() {
        assert!(same_folder("c:\\users\\Ada\\DEV", "C:\\Users\\ada\\dev"));
        assert!(same_folder("\\\\SRV\\Share\\p", "//srv/share/P"));
        assert!(!same_folder("/srv/Proj", "/srv/proj"));
    }

    #[test]
    fn same_folder_tells_different_folders_apart() {
        assert!(!same_folder("/srv/proj", "/srv/proj2"));
        assert!(!same_folder("/srv/proj", "/srv"));
        assert!(!same_folder("C:\\a", "D:\\a"));
        assert!(!same_folder("/", "/srv"));
        assert!(!same_folder("/home/jo\u{e3}o", "/home/joao"));
        assert!(same_folder("/home/jo\u{e3}o", "/home/jo\u{e3}o/"));
    }

    #[test]
    fn a_path_with_a_space_matches_itself() {
        let dir = "C:\\Users\\x\\AppData\\Local\\Temp\\noren smoke 1";
        assert!(same_folder(dir, dir));
        assert!(same_folder(
            dir,
            "c:/users/x/appdata/local/temp/noren smoke 1/"
        ));
    }

    #[test]
    fn a_link_that_comes_early_waits_and_a_later_one_is_emitted() {
        let links = Links::default();
        assert_eq!(links.deliver("noren://open?path=a".into()), Delivery::Kept);
        assert_eq!(links.deliver("noren://open?path=b".into()), Delivery::Kept);
        assert_eq!(
            links.take_waiting(),
            ["noren://open?path=a", "noren://open?path=b"]
        );
        assert_eq!(links.deliver("noren://open?path=c".into()), Delivery::Emit);
        // Nothing is kept once the interface is ready, and nothing is handed out twice.
        assert!(links.take_waiting().is_empty());
    }

    #[test]
    fn a_flood_before_the_interface_is_ready_keeps_the_newest() {
        let links = Links::default();
        for i in 0..20 {
            links.deliver(format!("noren://open?path=%2F{i}"));
        }
        let waiting = links.take_waiting();
        assert_eq!(waiting.len(), MAX_WAITING);
        assert_eq!(
            waiting.first().map(String::as_str),
            Some("noren://open?path=%2F12")
        );
        assert_eq!(
            waiting.last().map(String::as_str),
            Some("noren://open?path=%2F19")
        );
    }

    #[test]
    fn reports_reach_only_an_armed_check() {
        let links = Links::default();
        // Nobody listens: nothing happens.
        links.report(Some("/x".into()));
        let (tx, rx) = std::sync::mpsc::channel();
        links.watch_reports(tx);
        links.report(Some("/srv/proj".into()));
        links.report(None);
        assert_eq!(rx.try_recv().unwrap().as_deref(), Some("/srv/proj"));
        assert_eq!(rx.try_recv().unwrap(), None);
    }

    /// A registry that only counts the calls it gets, and can refuse them.
    #[derive(Default)]
    struct CountingLinks {
        calls: std::cell::RefCell<Vec<&'static str>>,
        refuse: bool,
    }

    impl LinkRegistry for CountingLinks {
        fn register(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("register");
            if self.refuse {
                Err("refused".into())
            } else {
                Ok(())
            }
        }

        fn unregister(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("unregister");
            if self.refuse {
                Err("refused".into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn turning_the_link_on_registers_and_turning_it_off_removes() {
        let on = CountingLinks::default();
        assert_eq!(apply_registration(&on, true), Ok(()));
        assert_eq!(*on.calls.borrow(), ["register"]);

        let off = CountingLinks::default();
        assert_eq!(apply_registration(&off, false), Ok(()));
        assert_eq!(*off.calls.borrow(), ["unregister"]);
    }

    #[test]
    fn a_refusal_of_the_system_is_the_answer() {
        let links = CountingLinks {
            refuse: true,
            ..CountingLinks::default()
        };
        assert_eq!(apply_registration(&links, true), Err("refused".to_string()));
        assert_eq!(*links.calls.borrow(), ["register"]);
    }

    #[test]
    fn nothing_registers_the_link_at_start() {
        // The plugin is loaded in `main.rs` to receive links; writing the scheme in the system is
        // only done by `deep_link_register_set`, when the person changes the option.
        let main = include_str!("main.rs");
        assert!(!main.contains("register_all"));
        assert!(!main.contains("deep_link().register"));
        assert!(!main.contains("deep_link().unregister"));
        assert!(main.contains("deeplink::deep_link_register_set"));
    }
}

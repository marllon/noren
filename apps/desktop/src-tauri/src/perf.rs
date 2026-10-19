//! Performance mode (`noren --smoke-perf --perf-out <file> [--perf-tabs <n>]`, NOR-F11-01b): runs
//! the real app, hidden like the smoke runs, over a saved workspace of `n` tabs made for the run,
//! and writes down when the first prompt of the shell reached the terminal on screen of the page.
//! Then it holds the app open, with every shell alive, until `<file>.done` appears, so that the
//! script that started it can read the memory of the whole tree of processes. `scripts/perf.mjs`
//! is the one that starts it, 5 times, and docs/PERF.md says how the numbers are read.
//!
//! The result goes to a file, not to the output: the release build is a window program and has no
//! console to print to. The files of the app are in a folder of their own in the temp folder
//! (never the state, the settings or the scrollback of the person), removed when the run ends.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Listener, Manager};

use crate::bridge::{AppState, STATE_FILE_NAME};
use crate::smoke;

pub const PERF_FLAG: &str = "--smoke-perf";
pub const PERF_OUT_FLAG: &str = "--perf-out";
pub const PERF_TABS_FLAG: &str = "--perf-tabs";
/// Event the page emits when the first prompt of a terminal is drawn (see `perf-probe.ts`).
pub const PROMPT_SHOWN_EVENT: &str = "perf-prompt-shown";

/// Tabs of the saved workspace when `--perf-tabs` is not given: the first start of the app.
const DEFAULT_TABS: usize = 1;
/// The most tabs a run may ask for.
const MAX_TABS: usize = 100;
/// Time for the app to start every shell and for every prompt to reach the page.
const PROMPTS_TIMEOUT: Duration = Duration::from_secs(90);
/// Time the app waits to be told the memory was read, before it ends on its own.
const HOLD_TIMEOUT: Duration = Duration::from_secs(120);

/// Whether this process is a perf run: only then do the marks below keep anything.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// The moments the app went through, in the order they were marked (microseconds since 1970).
static MARKS: Mutex<Vec<(String, u128)>> = Mutex::new(Vec::new());

/// Notes that the app reached `name` now (NOR-F11-01d). Does nothing outside a perf run, so the
/// calls left in the code of a normal start cost one atomic read.
pub fn mark(name: &str) {
    if ENABLED.load(Ordering::Relaxed) {
        MARKS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((name.to_owned(), unix_us()));
    }
}

/// Like [`mark`], but only the first time `name` is reached (the first byte of a shell).
pub fn mark_once(name: &str) {
    if ENABLED.load(Ordering::Relaxed) {
        let mut marks = MARKS.lock().unwrap_or_else(|e| e.into_inner());
        if !marks.iter().any(|(known, _)| known == name) {
            marks.push((name.to_owned(), unix_us()));
        }
    }
}

/// The bytes that start a prompt (`ESC ] 133 ; A`), the mark the page waits for too.
const PROMPT_MARK: &[u8] = b"]133;A";

/// Marks the first chunk of shell output that holds a prompt: the moment the shell has the first
/// prompt ready, before the page has had any part in it. A mark split between two chunks is missed
/// (the page-side mark still catches it).
pub fn mark_prompt_bytes(chunk: &[u8]) {
    if ENABLED.load(Ordering::Relaxed) && chunk.windows(PROMPT_MARK.len()).any(|w| w == PROMPT_MARK)
    {
        mark_once("shell-prompt-bytes");
    }
}

fn unix_us() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros())
}

/// Turns the marks on for this process. Called at the start of `main`, before anything else.
pub fn enable() {
    ENABLED.store(true, Ordering::Relaxed);
    mark("main");
}

/// Every mark as `[name, milliseconds since 1970]`, the ones of the page (`page`, same shape,
/// from the payload of the first prompt event) included, sorted by time.
fn marks_json(page: &[(String, f64)]) -> Value {
    let mut all: Vec<(String, f64)> = MARKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(name, us)| (name.clone(), (*us as f64) / 1000.0))
        .collect();
    all.extend(page.iter().cloned());
    all.sort_by(|a, b| a.1.total_cmp(&b.1));
    Value::Array(
        all.into_iter()
            .map(|(name, ms)| json!([name, (ms * 10.0).round() / 10.0]))
            .collect(),
    )
}

/// The `[name, ms]` pairs the page put in the payload of its first prompt event.
fn page_marks(payload: &Value) -> Vec<(String, f64)> {
    payload
        .get("marks")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((pair.first()?.as_str()?.to_owned(), pair.get(1)?.as_f64()?))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What the page told the app: the event, the session it names, when it arrived (milliseconds since
/// 1970) and the marks the page made.
type Arrival = (String, Option<u64>, u128, Vec<(String, f64)>);

/// What the run was asked for, and the folder that holds its own files.
#[derive(Clone, Debug)]
pub struct PerfRun {
    /// Where the result is written (atomically: it appears whole or not at all).
    pub out: PathBuf,
    /// Tabs of the saved workspace, one shell each.
    pub tabs: usize,
    /// A fresh folder for `state.json` and the rest, so the files of the person are neither read nor
    /// written. The shells start in it.
    pub state_dir: PathBuf,
    /// When `main` began: the zero of every time in the result.
    pub started: Instant,
    /// The same moment on the clock of the system (milliseconds since 1970), for the script to
    /// compare with its own.
    pub started_unix_ms: u128,
}

/// Whether `--smoke-perf` is among the arguments (the first one is the program).
pub fn has_perf_flag(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == PERF_FLAG)
}

/// The text after `flag`, when it is there and is not another flag.
fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let at = args.iter().skip(1).position(|arg| arg == flag)? + 1;
    args.get(at + 1)
        .map(String::as_str)
        .filter(|value| !value.starts_with("--"))
}

/// Reads the arguments of the run: `--perf-out <file>` is required, `--perf-tabs <n>` (1 to 100)
/// is optional.
pub fn parse_args(args: &[String]) -> Result<PerfRun, String> {
    let out = value_of(args, PERF_OUT_FLAG)
        .ok_or_else(|| format!("{PERF_FLAG} needs {PERF_OUT_FLAG} <file> for the result"))?;
    let tabs = match args.iter().skip(1).any(|arg| arg == PERF_TABS_FLAG) {
        false => DEFAULT_TABS,
        true => {
            let text = value_of(args, PERF_TABS_FLAG)
                .ok_or_else(|| format!("{PERF_TABS_FLAG} needs a number of tabs"))?;
            text.parse::<usize>()
                .ok()
                .filter(|n| (1..=MAX_TABS).contains(n))
                .ok_or_else(|| {
                    format!("{PERF_TABS_FLAG} takes a number from 1 to {MAX_TABS}, not {text:?}")
                })?
        }
    };
    Ok(PerfRun {
        out: PathBuf::from(out),
        tabs,
        state_dir: smoke::fresh_dir("noren-smoke-perf"),
        started: Instant::now(),
        started_unix_ms: unix_ms(),
    })
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

/// The file whose appearance tells the app that the script has read what it came for.
pub fn done_path(out: &Path) -> PathBuf {
    let mut name = out.as_os_str().to_owned();
    name.push(".done");
    PathBuf::from(name)
}

impl PerfRun {
    /// Makes the folder of the run and the saved workspace in it, before anything starts.
    pub fn prepare(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.state_dir)
            .map_err(|e| format!("could not make {:?}: {e}", self.state_dir))?;
        let state = seed_state(self.tabs, &self.state_dir.to_string_lossy());
        std::fs::write(self.state_dir.join(STATE_FILE_NAME), state)
            .map_err(|e| format!("could not write the saved workspace: {e}"))
    }

    /// Deletes the folder this run made (only that one).
    pub fn remove(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

/// A saved workspace (the `state.json` the interface reads) with one space of `tabs` tabs, each
/// with one pane of the default profile in `cwd`.
pub fn seed_state(tabs: usize, cwd: &str) -> String {
    let mut items = Map::new();
    let mut tree = Vec::new();
    for n in 1..=tabs {
        let item = format!("i{n}");
        let pane = format!("p{n}");
        items.insert(
            item.clone(),
            json!({
                "id": item,
                "title": format!("tab {n}"),
                "titleLocked": true,
                "layout": {
                    "kind": "pane",
                    "pane": {
                        "id": pane,
                        "type": "terminal",
                        "profileId": "default",
                        "cwd": cwd,
                        "status": "idle",
                        "unread": false,
                        "bell": false,
                    },
                },
                "focusedPaneId": pane,
                "lastActivityAt": 1,
            }),
        );
        tree.push(json!({ "kind": "item", "id": item }));
    }
    json!({
        "version": 2,
        "activeSpaceId": "s1",
        "favorites": [],
        "closed": [],
        "archive": [],
        "spaces": [{
            "id": "s1",
            "name": "Perf",
            "icon": "terminal",
            "color": "#6b8afd",
            "modIds": [],
            "defaults": { "env": {}, "cwd": cwd },
            "aiEnabled": true,
            "saveScrollback": false,
            "pinned": [],
            "tree": tree,
            "items": items,
            "activeItemId": "i1",
        }],
    })
    .to_string()
}

/// Writes `value` to `path` whole or not at all (the script reads the file as soon as it exists).
fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".part");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, value.to_string())?;
    std::fs::rename(&temp, path)
}

/// The result of the run: the prompts in the order they reached the page, with their times.
fn result_json(
    run: &PerfRun,
    app_ready_ms: Option<u128>,
    prompts: &[(u64, u128, u128)],
    page: &[(String, f64)],
) -> Value {
    let ms: Vec<u128> = prompts.iter().map(|p| p.1).collect();
    let unix: Vec<u128> = prompts.iter().map(|p| p.2).collect();
    json!({
        "pid": process::id(),
        "tabs": run.tabs,
        "startedUnixMs": run.started_unix_ms.to_string(),
        "appReadyMs": app_ready_ms,
        "promptsMs": ms,
        "promptsUnixMs": unix.iter().map(u128::to_string).collect::<Vec<_>>(),
        "firstPromptMs": ms.first(),
        "lastPromptMs": ms.last(),
        "marksUnixMs": marks_json(page),
    })
}

/// Reports a failure (in the result file too, so the script does not wait for it), ends every
/// session, removes the folder of the run and exits with code 1.
fn fail(app: &AppHandle, run: &PerfRun, message: &str) -> ! {
    eprintln!("SMOKE FAILED: {message}");
    let _ = write_atomic(&run.out, &json!({ "error": message }));
    app.state::<AppState>().sessions.shutdown();
    run.remove();
    process::exit(1);
}

/// The whole run, from the page being ready to the prompts being drawn.
fn wait_for_prompts(
    app: &AppHandle,
    run: &PerfRun,
    rx: &mpsc::Receiver<Arrival>,
) -> Result<Value, String> {
    let deadline = run.started + PROMPTS_TIMEOUT;
    let mut app_ready = None;
    let mut prompts: Vec<(u64, u128, u128)> = Vec::new();
    let mut seen = HashSet::new();
    let mut page: Vec<(String, f64)> = Vec::new();
    while prompts.len() < run.tabs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok((name, id, at_ms, marks)) => {
                let since = |at: u128| at.saturating_sub(run.started_unix_ms);
                if name == "app-ready" {
                    app_ready.get_or_insert(since(at_ms));
                    smoke::print_line("SMOKE app-ready received");
                } else if let Some(id) = id
                    && seen.insert(id)
                {
                    if prompts.is_empty() {
                        page = marks;
                    }
                    prompts.push((id, since(at_ms), at_ms));
                }
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "{} of {} prompts reached the page within {}s (app-ready {}); the shell integration \
                     of the default profile writes the mark that tells a prompt apart",
                    prompts.len(),
                    run.tabs,
                    PROMPTS_TIMEOUT.as_secs(),
                    if app_ready.is_some() {
                        "received"
                    } else {
                        "not received"
                    },
                ));
            }
        }
    }
    let live = app.state::<AppState>().sessions.session_count();
    if live != run.tabs {
        return Err(format!(
            "{live} shells were alive, expected {} (one per tab)",
            run.tabs
        ));
    }
    Ok(result_json(run, app_ready, &prompts, &page))
}

/// Starts the run: waits for the prompts, writes the result, holds the app open until the script
/// says it has read the memory (`<file>.done`), then exits with 0.
pub fn arm(app: &tauri::App, run: PerfRun) {
    let (tx, rx) = mpsc::channel::<Arrival>();
    for name in ["app-ready", PROMPT_SHOWN_EVENT] {
        let tx = tx.clone();
        let started = run.started_unix_ms;
        app.listen(name, move |event| {
            mark(name);
            let payload = serde_json::from_str::<Value>(event.payload()).unwrap_or(Value::Null);
            let id = payload.get("id").and_then(Value::as_u64);
            // The run is over once the receiver is gone; late events are of no interest.
            let _ = tx.send((
                name.to_owned(),
                id,
                unix_ms().max(started),
                page_marks(&payload),
            ));
        });
    }

    let handle = app.handle().clone();
    thread::spawn(move || {
        let result = wait_for_prompts(&handle, &run, &rx)
            .and_then(|result| smoke::check_no_global_shortcut(&handle).map(|()| result))
            .and_then(|result| smoke::check_window_hidden(&handle).map(|()| result));
        let result = match result {
            Ok(result) => result,
            Err(message) => fail(&handle, &run, &message),
        };
        if let Err(error) = write_atomic(&run.out, &result) {
            fail(
                &handle,
                &run,
                &format!("could not write the result: {error}"),
            );
        }
        smoke::print_line(&format!(
            "SMOKE PERF ready, {} tabs, first prompt at {} ms",
            run.tabs, result["firstPromptMs"]
        ));
        let done = done_path(&run.out);
        let hold_until = Instant::now() + HOLD_TIMEOUT;
        while !done.exists() {
            if Instant::now() >= hold_until {
                fail(
                    &handle,
                    &run,
                    "nobody read the memory within the time of the run",
                );
            }
            thread::sleep(Duration::from_millis(50));
        }
        smoke::print_line("SMOKE PERF OK");
        handle.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_flag_is_found_among_the_arguments() {
        assert!(has_perf_flag(&args(&["noren.exe", "--smoke-perf"])));
        assert!(!has_perf_flag(&args(&["noren.exe", "--smoke"])));
        // The first argument is the program, whatever it is called.
        assert!(!has_perf_flag(&args(&["--smoke-perf"])));
    }

    #[test]
    fn the_arguments_give_the_file_and_the_tabs() {
        let run = parse_args(&args(&[
            "noren.exe",
            "--smoke-perf",
            "--perf-out",
            "C:\\Temp\\out.json",
            "--perf-tabs",
            "30",
        ]))
        .unwrap();
        assert_eq!(run.out, PathBuf::from("C:\\Temp\\out.json"));
        assert_eq!(run.tabs, 30);
        // Without --perf-tabs the run is a first start: one tab.
        let one = parse_args(&args(&[
            "noren.exe",
            "--smoke-perf",
            "--perf-out",
            "o.json",
        ]))
        .unwrap();
        assert_eq!(one.tabs, 1);
    }

    #[test]
    fn the_arguments_refuse_what_the_run_cannot_do() {
        let run = |list: &[&str]| parse_args(&args(list));
        assert!(run(&["noren.exe", "--smoke-perf"]).is_err());
        assert!(run(&["noren.exe", "--smoke-perf", "--perf-out"]).is_err());
        assert!(
            run(&[
                "noren.exe",
                "--smoke-perf",
                "--perf-out",
                "--perf-tabs",
                "3"
            ])
            .is_err()
        );
        for tabs in ["0", "101", "-1", "many", "3.5"] {
            let list = [
                "noren.exe",
                "--smoke-perf",
                "--perf-out",
                "o",
                "--perf-tabs",
                tabs,
            ];
            assert!(run(&list).is_err(), "{tabs} was taken");
        }
        let missing = [
            "noren.exe",
            "--smoke-perf",
            "--perf-out",
            "o",
            "--perf-tabs",
        ];
        assert!(run(&missing).is_err());
    }

    #[test]
    fn each_run_has_its_own_folder_in_the_temp_folder_and_removes_only_that() {
        let list = args(&["noren.exe", "--smoke-perf", "--perf-out", "o.json"]);
        let first = parse_args(&list).unwrap();
        let second = parse_args(&list).unwrap();
        assert_ne!(first.state_dir, second.state_dir);
        assert!(first.state_dir.starts_with(std::env::temp_dir()));
        assert!(!first.state_dir.exists());

        first.prepare().unwrap();
        assert!(first.state_dir.join("state.json").is_file());
        // Nothing of the person's: the folder is new and holds only what the run made.
        assert_eq!(std::fs::read_dir(&first.state_dir).unwrap().count(), 1);
        first.remove();
        assert!(!first.state_dir.exists());
        // Removing it again is harmless.
        first.remove();
    }

    #[test]
    fn the_seeded_workspace_has_one_tab_and_one_pane_for_each_tab_asked() {
        let state: Value = serde_json::from_str(&seed_state(30, "C:\\Temp\\perf run")).unwrap();
        assert_eq!(state["version"], 2);
        let space = &state["spaces"][0];
        assert_eq!(space["tree"].as_array().unwrap().len(), 30);
        let items = space["items"].as_object().unwrap();
        assert_eq!(items.len(), 30);
        let mut panes = HashSet::new();
        for (id, item) in items {
            assert_eq!(&item["id"], id);
            let pane = &item["layout"]["pane"];
            assert_eq!(pane["profileId"], "default");
            assert_eq!(pane["cwd"], "C:\\Temp\\perf run");
            assert!(panes.insert(pane["id"].as_str().unwrap().to_owned()));
            assert_eq!(item["focusedPaneId"], pane["id"]);
        }
        assert_eq!(space["activeItemId"], "i1");
        assert!(items.contains_key("i1") && items.contains_key("i30"));
    }

    #[test]
    fn the_done_file_sits_beside_the_result() {
        assert_eq!(
            done_path(Path::new("C:\\Temp\\out.json")),
            PathBuf::from("C:\\Temp\\out.json.done")
        );
    }

    #[test]
    fn the_result_lists_the_prompts_in_order() {
        let run = parse_args(&args(&["noren.exe", "--smoke-perf", "--perf-out", "o"])).unwrap();
        let result = result_json(
            &run,
            Some(310),
            &[(1, 420, 1_000_420), (2, 450, 1_000_450)],
            &[("boot-start".to_owned(), 1_234.5)],
        );
        assert_eq!(result["firstPromptMs"], 420);
        assert_eq!(result["lastPromptMs"], 450);
        assert_eq!(result["appReadyMs"], 310);
        assert_eq!(result["promptsMs"], json!([420, 450]));
        assert_eq!(result["tabs"], 1);
        // The marks of the page come in the result, in time order, beside the ones of this side.
        let marks = result["marksUnixMs"].as_array().unwrap();
        assert!(marks.iter().any(|m| m == &json!(["boot-start", 1234.5])));
    }

    #[test]
    fn the_prompt_mark_is_found_inside_a_chunk() {
        let hit = b"abc]133;Adef";
        assert!(hit.windows(PROMPT_MARK.len()).any(|w| w == PROMPT_MARK));
        let miss = b"abc]133;Bdef";
        assert!(!miss.windows(PROMPT_MARK.len()).any(|w| w == PROMPT_MARK));
    }

    #[test]
    fn the_marks_of_the_page_are_read_from_the_payload_and_bad_ones_are_dropped() {
        let payload =
            json!({ "id": 1, "marks": [["a", 10.5], ["b"], [3, 4.0], ["c", "x"], ["d", 12]] });
        assert_eq!(
            page_marks(&payload),
            vec![("a".to_owned(), 10.5), ("d".to_owned(), 12.0)]
        );
        assert!(page_marks(&json!({ "id": 1 })).is_empty());
    }

    #[test]
    fn the_result_is_written_whole() {
        let run = parse_args(&args(&["noren.exe", "--smoke-perf", "--perf-out", "o"])).unwrap();
        run.prepare().unwrap();
        let path = run.state_dir.join("out.json");
        write_atomic(&path, &json!({ "a": 1 })).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"a":1}"#);
        assert!(!run.state_dir.join("out.json.part").exists());
        run.remove();
    }
}

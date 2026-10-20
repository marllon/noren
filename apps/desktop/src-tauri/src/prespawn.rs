//! The shell of the pane on screen, started before the page asks for it (NOR-F11-01d).
//!
//! The first prompt waited for the web view to start, the page to load and its boot to reach
//! `restoreWorkspace`, which is what asks for the shell, and then for the shell itself (Windows
//! PowerShell takes ~350 ms to its first prompt). The shell does not need any of that: the folder,
//! the profile and the environment it will be asked for are in `state.json`, which this side can
//! read as soon as the program has started. So a thread reads the file, works out the command the
//! page will ask for first (the pane on screen of the active space), and starts it with the output
//! held aside. When the page's `session_create` arrives with the very same command, it is handed that
//! session (and what the shell printed meanwhile) instead of starting another one. If it differs
//! (the profiles of the user changed the default, the file is of an older version, the folder is
//! gone), nothing is claimed and the session is started as it always was; a shell nobody claimed is
//! ended when the page says it is up (`app-ready`), without a word to the page.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use noren_core::{SessionId, SpawnSpec};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime};

use crate::bridge::{AppState, launch, session_spec};
use crate::perf;

/// The size `restoreWorkspace` gives the sessions it starts (the view fits them to the real size).
const COLS: u16 = 80;
const ROWS: u16 = 24;
/// The saved-state version this reads; any other goes through the migrations of the interface, which
/// this side does not repeat.
const STATE_VERSION: u64 = 2;
/// The profile id a pane has when it wants the default one.
const DEFAULT_PROFILE_ID: &str = "default";

/// Where the shell started ahead stands.
#[derive(Default)]
pub enum Slot {
    /// Not looking for one: the run is a smoke run, or the thread has not started.
    #[default]
    Closed,
    /// The thread is working on it; nothing to claim yet.
    Waiting,
    /// A shell is running, with its output held for the page.
    Ready(Ready),
}

/// A shell started ahead, waiting for the call that asks for it.
pub struct Ready {
    spec: SpawnSpec,
    id: SessionId,
    /// What the shell printed since it started; taken by the page that claims it.
    backlog: Arc<Mutex<Option<Vec<Vec<u8>>>>>,
    /// Set when nobody will claim the shell, so its end is not announced to a page that never knew it.
    silent: Arc<AtomicBool>,
}

/// What the first `session_create` of the page will ask for, read from the saved state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    /// The pane the shell is for.
    pub pane_id: String,
    /// `None` for the default profile, as the page sends it.
    pub profile_id: Option<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

fn object<'a>(value: &'a Value, key: &str) -> Option<&'a serde_json::Map<String, Value>> {
    value.get(key)?.as_object()
}

/// The pane `id` in a layout tree, depth first, or the first pane when `id` is `None`.
fn find_pane<'a>(layout: &'a Value, id: Option<&str>) -> Option<&'a Value> {
    match layout.get("kind")?.as_str()? {
        "pane" => {
            let pane = layout.get("pane")?;
            (id.is_none() || pane.get("id")?.as_str() == id).then_some(pane)
        }
        "split" => layout
            .get("children")?
            .as_array()?
            .iter()
            .find_map(|child| find_pane(child, id)),
        _ => None,
    }
}

/// The command the page asks for first, from the text of `state.json`: the focused pane of the
/// active tab of the active space, with what `restoreWorkspace` (packages/model/src/restore.ts) adds
/// to it: the profile unless it is the default one, the folder of the pane or else of the space, and
/// the environment of the space when it has one. `None` for anything it does not know how to read.
pub fn wanted_from_state(text: &str) -> Option<Wanted> {
    let state: Value = serde_json::from_str(text).ok()?;
    if state.get("version")?.as_u64()? != STATE_VERSION {
        return None;
    }
    let active = state.get("activeSpaceId")?.as_str()?;
    let space = state
        .get("spaces")?
        .as_array()?
        .iter()
        .find(|space| space.get("id").and_then(Value::as_str) == Some(active))?;
    let item = object(space, "items")?.get(space.get("activeItemId")?.as_str()?)?;
    let pane = find_pane(
        item.get("layout")?,
        item.get("focusedPaneId").and_then(Value::as_str),
    )
    .or_else(|| find_pane(item.get("layout")?, None))?;
    if pane.get("type")?.as_str()? != "terminal" {
        return None;
    }
    let profile = pane.get("profileId")?.as_str()?;
    let defaults = space.get("defaults")?;
    let cwd = match pane
        .get("cwd")
        .filter(|cwd| !cwd.is_null())
        .or_else(|| defaults.get("cwd").filter(|cwd| !cwd.is_null()))
    {
        None => None,
        Some(cwd) => Some(cwd.as_str()?.to_owned()),
    };
    let env = object(defaults, "env")?;
    let env = if env.is_empty() {
        None
    } else {
        let mut map = HashMap::new();
        for (key, value) in env {
            map.insert(key.clone(), value.as_str()?.to_owned());
        }
        Some(map)
    };
    Some(Wanted {
        pane_id: pane.get("id")?.as_str()?.to_owned(),
        profile_id: (profile != DEFAULT_PROFILE_ID).then(|| profile.to_owned()),
        cwd,
        env,
    })
}

impl AppState {
    /// Hands over the shell started ahead when `spec` is exactly what it was started with: its
    /// output goes to `output` from here on, after what it printed meanwhile. `None` when there is
    /// none, it differs, or it has already ended; nothing is lost then, the caller starts its own.
    pub fn claim_prespawned(
        &self,
        spec: &SpawnSpec,
        output: &Channel<InvokeResponseBody>,
    ) -> Option<SessionId> {
        let mut slot = self.prespawn.lock().unwrap_or_else(|e| e.into_inner());
        let Slot::Ready(ready) = &*slot else {
            return None;
        };
        if &ready.spec != spec {
            return None;
        }
        let Slot::Ready(ready) = std::mem::take(&mut *slot) else {
            return None;
        };
        // A shell that ended while it waited has no route left: it is not worth handing over.
        let route = self.route(ready.id.0)?;
        route.adopt(output.clone(), || {
            ready
                .backlog
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take()
                .unwrap_or_default()
        });
        perf::mark("prespawn-claimed");
        Some(ready.id)
    }

    /// Ends the shell started ahead, if nobody claimed it, and stops looking for one.
    pub fn close_prespawn(&self) {
        let old = std::mem::take(&mut *self.prespawn.lock().unwrap_or_else(|e| e.into_inner()));
        if let Slot::Ready(ready) = old {
            perf::mark("prespawn-discarded");
            self.discard(ready);
        }
    }

    fn discard(&self, ready: Ready) {
        ready.silent.store(true, Ordering::SeqCst);
        let _ = self.sessions.kill(ready.id);
    }

    /// Keeps `ready` for the page, unless the search was closed meanwhile.
    fn stock_prespawned(&self, ready: Ready) {
        let mut slot = self.prespawn.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*slot, Slot::Waiting) {
            *slot = Slot::Ready(ready);
        } else {
            drop(slot);
            self.discard(ready);
        }
    }
}

/// Looks, on a thread of its own, for the shell the page will ask for first and starts it. Call it
/// once the state of the app is managed; `state_file` is the `state.json` the interface will read.
pub fn start<R: Runtime>(app: &AppHandle<R>, state_file: PathBuf) {
    *app.state::<AppState>()
        .prespawn
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Slot::Waiting;
    let app = app.clone();
    thread::spawn(move || {
        perf::mark("prespawn-start");
        if run(&app, &state_file).is_none() {
            // No shell to start ahead (no file yet, an unknown version, ...): the page does it all.
            perf::mark("prespawn-none");
            app.state::<AppState>().close_prespawn();
        }
    });
}

fn run<R: Runtime>(app: &AppHandle<R>, state_file: &PathBuf) -> Option<()> {
    let text = String::from_utf8_lossy(&std::fs::read(state_file).ok()?).into_owned();
    let wanted = wanted_from_state(&text)?;
    let state = app.state::<AppState>();
    // The shell this pane had before the app was closed may be waiting for it in the daemon (see
    // `persist`): the page takes it back instead of asking for a new one, and a shell started here
    // would only be thrown away.
    if state.has_kept_shell(&wanted.pane_id) {
        return None;
    }
    let (_, spec) = session_spec(
        app,
        &state,
        wanted.profile_id.as_deref(),
        wanted.cwd.as_deref(),
        wanted.env,
        COLS,
        ROWS,
    )
    .ok()?;

    let backlog = Arc::new(Mutex::new(Some(Vec::new())));
    let silent = Arc::new(AtomicBool::new(false));
    let held = Arc::clone(&backlog);
    let channel = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Raw(bytes) = body
            && let Some(chunks) = held.lock().unwrap_or_else(|e| e.into_inner()).as_mut()
        {
            chunks.push(bytes);
        }
        Ok(())
    });
    let id = launch(
        app,
        &state,
        spec.clone(),
        channel,
        Some(Arc::clone(&silent)),
    )
    .ok()?;
    state.stock_prespawned(Ready {
        spec,
        id,
        backlog,
        silent,
    });
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state_with(pane: Value, defaults: Value) -> String {
        json!({
            "version": 2,
            "activeSpaceId": "s1",
            "spaces": [
                { "id": "s0", "defaults": { "env": {} }, "items": {}, "activeItemId": "x" },
                {
                    "id": "s1",
                    "defaults": defaults,
                    "activeItemId": "i2",
                    "items": {
                        "i1": { "focusedPaneId": "p1", "layout": { "kind": "pane", "pane": { "id": "p1", "type": "terminal", "profileId": "default", "cwd": "C:\\other" } } },
                        "i2": {
                            "focusedPaneId": "p3",
                            "layout": { "kind": "split", "children": [
                                { "kind": "pane", "pane": { "id": "p2", "type": "terminal", "profileId": "default", "cwd": "C:\\left" } },
                                { "kind": "pane", "pane": pane },
                            ] },
                        },
                    },
                },
            ],
        })
        .to_string()
    }

    fn pane(profile: &str, cwd: Option<&str>) -> Value {
        let mut pane = json!({ "id": "p3", "type": "terminal", "profileId": profile });
        if let Some(cwd) = cwd {
            pane["cwd"] = json!(cwd);
        }
        pane
    }

    #[test]
    fn the_focused_pane_of_the_active_tab_of_the_active_space_is_the_one_asked_for() {
        let text = state_with(pane("default", Some("C:\\work")), json!({ "env": {} }));
        assert_eq!(
            wanted_from_state(&text),
            Some(Wanted {
                pane_id: "p3".to_owned(),
                profile_id: None,
                cwd: Some("C:\\work".to_owned()),
                env: None
            })
        );
    }

    #[test]
    fn a_profile_other_than_the_default_is_named_and_the_space_gives_the_folder_and_the_environment()
     {
        let text = state_with(
            pane("dev-shell", None),
            json!({ "cwd": "C:\\space", "env": { "A": "1" } }),
        );
        let wanted = wanted_from_state(&text).unwrap();
        assert_eq!(wanted.profile_id.as_deref(), Some("dev-shell"));
        assert_eq!(wanted.cwd.as_deref(), Some("C:\\space"));
        assert_eq!(
            wanted.env,
            Some(HashMap::from([("A".to_owned(), "1".to_owned())]))
        );
    }

    #[test]
    fn a_pane_without_a_folder_in_a_space_without_one_asks_for_none() {
        let text = state_with(pane("default", None), json!({ "env": {} }));
        let wanted = wanted_from_state(&text).unwrap();
        assert_eq!((wanted.cwd, wanted.env), (None, None));
    }

    #[test]
    fn what_this_side_does_not_read_exactly_asks_for_nothing() {
        let good = state_with(pane("default", Some("C:\\work")), json!({ "env": {} }));
        let older = good.replace("\"version\":2", "\"version\":1");
        assert_eq!(wanted_from_state(&older), None);
        assert_eq!(wanted_from_state("not json"), None);
        assert_eq!(wanted_from_state("{}"), None);
        let no_active = good.replace("\"activeSpaceId\":\"s1\"", "\"activeSpaceId\":\"nope\"");
        assert_eq!(wanted_from_state(&no_active), None);
        let odd_env = state_with(pane("default", None), json!({ "env": { "A": 1 } }));
        assert_eq!(wanted_from_state(&odd_env), None);
        let odd_type = state_with(
            json!({ "id": "p3", "type": "browser", "profileId": "default" }),
            json!({ "env": {} }),
        );
        assert_eq!(wanted_from_state(&odd_type), None);
    }

    #[test]
    fn nothing_is_claimed_while_no_shell_waits_and_closing_twice_is_harmless() {
        let state = AppState::with_detected(noren_core::ProfileSet {
            profiles: Vec::new(),
            default_id: None,
        });
        let spec = SpawnSpec {
            program: "sh".to_owned(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            cols: COLS,
            rows: ROWS,
        };
        let channel = Channel::new(|_body: InvokeResponseBody| Ok(()));
        assert!(state.claim_prespawned(&spec, &channel).is_none());
        state.close_prespawn();
        state.close_prespawn();
        assert!(matches!(*state.prespawn.lock().unwrap(), Slot::Closed));
    }
}

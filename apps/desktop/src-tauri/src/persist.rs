//! The shells of the panes outliving the app (NOR-F14-02b).
//!
//! With the session daemon the shells do not have to end when the window closes. When the settings
//! keep them (`sessions.keepOnClose`, on by default; the interface hands the value over through
//! `sessions_keep_set`):
//!
//! - **On the way out** the app lets go of the shells that belong to a pane, which go on running in
//!   the daemon, and ends the rest (a shell of the quick window has no pane to come back to).
//!   `pane_sessions` is what remembers which shell is which pane's.
//! - **When it opens** the page asks for the shell of each restored pane by its id
//!   ([`AppState::reattach_pane`]): the daemon is asked what it holds, and a session that is the one
//!   the pane had (same id, same process) and still runs is taken over, with the output it kept; a
//!   pane without one gets a new shell, as before.
//! - **Once the page is up** the sessions that no pane came back for are ended
//!   ([`AppState::reap_orphans`]): nobody could ever reach them.
//!
//! With the setting off, or with the sessions in this process (no `norend`), the app ends every
//! session on the way out, and nothing here finds anything to take over.
//!
//! Closing the window with the shells kept does not even leave the app (NOR-F14-02c): the window is
//! hidden and the app stays in the tray (`tray`, `lifecycle`). The way out above is taken when the
//! tray icon's "Quit" is chosen, which also ends the daemon ([`AppState::begin_quit`]), or when the
//! window closes with the setting off or no daemon.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};

use noren_core::SessionId;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Runtime};

use crate::bridge::{AppState, attach_session, launch_existing};
use crate::pane_sessions::{Binding, PaneBook};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl AppState {
    /// Whether the shells of the panes outlive the app, as the interface last said.
    pub fn keeps_sessions(&self) -> bool {
        self.keep_sessions.load(Ordering::SeqCst)
    }

    /// Takes the value of `sessions.keepOnClose` from the interface.
    pub fn set_keep_sessions(&self, keep: bool) {
        self.keep_sessions.store(keep, Ordering::SeqCst);
    }

    /// The tray icon's "Quit" was chosen: the app goes away for real, ending the sessions and the
    /// daemon on its way out.
    pub fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    /// Whether [`Self::begin_quit`] was called.
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    /// Replaces the book of which shell is which pane's (a run starts with one in memory, and the
    /// normal run swaps in the one kept next to `state.json`).
    pub fn use_pane_book(&self, book: PaneBook) {
        *lock(&self.pane_book) = book;
    }

    /// Writes down that the session `id` is the shell of `pane`, so a later run can find it. Nothing
    /// is written for a session that lives in this process (it ends with the app) or has no process.
    pub fn bind_pane(&self, pane: &str, id: SessionId) {
        if !self.sessions.in_daemon() {
            return;
        }
        let Some(pid) = self
            .sessions
            .process_ids(&[id])
            .first()
            .and_then(|(_, pid)| *pid)
        else {
            return;
        };
        if !lock(&self.pane_book).bind(pane, Binding { session: id.0, pid }) {
            eprintln!(
                "warning: the shell of a pane was not written down: the pane id is not usable"
            );
        }
    }

    /// Whether the book says `pane` had a shell that may still be in the daemon.
    pub fn has_kept_shell(&self, pane: &str) -> bool {
        lock(&self.pane_book).binding(pane).is_some()
    }

    /// Forgets the pane that had the session `id`.
    pub fn unbind_session(&self, id: SessionId) {
        lock(&self.pane_book).unbind_session(id.0);
    }

    /// The shell `pane` had before the app was closed, taken over: its output (the buffer the daemon
    /// kept, then everything after) goes to `output` through a route, like a new session's. `None`
    /// when the settings do not keep shells, the pane has none written down, the daemon does not hold
    /// it any more, or it is not the same process (the daemon was started again and its ids began
    /// over), or it ended meanwhile (it is released then); the caller starts a new shell.
    pub fn reattach_pane<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pane: &str,
        output: Channel<InvokeResponseBody>,
    ) -> Option<SessionId> {
        if !self.keeps_sessions() {
            return None;
        }
        let binding = lock(&self.pane_book).binding(pane)?;
        let id = SessionId(binding.session);
        let listed = match self.sessions.list() {
            Ok(listed) => listed,
            Err(error) => {
                eprintln!("warning: could not ask the session daemon for its sessions: {error}");
                return None;
            }
        };
        let Some(info) = listed
            .into_iter()
            .find(|info| info.session == id && info.pid == Some(binding.pid))
        else {
            lock(&self.pane_book).unbind_pane(pane);
            return None;
        };
        if info.exit.is_some() {
            // The shell ended while the app was away: there is nothing to come back to.
            let _ = self.sessions.kill(id);
            self.unbind_session(id);
            return None;
        }
        // This run already shows it (the interface asked twice): only the output moves.
        if self.route(id.0).is_some() {
            return attach_session(self, id.0, output, false).ok().map(|()| id);
        }
        match launch_existing(app, self, id, output) {
            Ok(id) => Some(id),
            Err(error) => {
                eprintln!("warning: could not take over the shell of a pane: {error}");
                self.unbind_session(id);
                None
            }
        }
    }

    /// Ends the sessions the daemon holds that this run did not start or take over and that nobody
    /// is attached to: shells that no pane came back for. Returns how many it ended. A session some
    /// other client is attached to is left alone, and so is everything when the sessions live in
    /// this process.
    pub fn reap_orphans(&self) -> usize {
        let listed = match self.sessions.list() {
            Ok(listed) => listed,
            Err(_) => return 0,
        };
        let mut ended = 0;
        for info in listed {
            if info.attached > 0 || self.sessions.owns(info.session) {
                continue;
            }
            if self.sessions.kill(info.session).is_ok() {
                ended += 1;
            }
            self.unbind_session(info.session);
        }
        if ended > 0 {
            eprintln!(
                "the session daemon held {ended} shell(s) no pane came back for; they were ended"
            );
        }
        ended
    }

    /// What the app does with its sessions on its way out. With the shells kept and the sessions in
    /// the daemon, the ones that belong to a pane and still run are left there and the others end;
    /// otherwise every session ends. After "Quit" of the tray icon (NOR-F14-02c) nothing is kept:
    /// every session ends and so does the daemon, whoever started it, and the endpoint is free when
    /// this returns.
    pub fn end_sessions_on_exit(&self) {
        if self.is_quitting() {
            lock(&self.pane_book).clear();
            match self.sessions.quit_for_good() {
                Ok(stopped) => {
                    if let Some(pid) = stopped.norend_pid {
                        eprintln!("quit for good: the session daemon (pid {pid}) was stopped");
                    }
                }
                Err(error) => {
                    eprintln!("warning: could not stop the session daemon: {error}");
                    // The daemon would not go: at least what this run started does not stay behind.
                    self.sessions.shutdown();
                }
            }
            return;
        }
        if !(self.keeps_sessions() && self.sessions.in_daemon()) {
            lock(&self.pane_book).clear();
            self.sessions.shutdown();
            return;
        }
        let bound: HashSet<u64> = lock(&self.pane_book).sessions().into_iter().collect();
        let staying: Vec<SessionId> = self
            .sessions
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|info| {
                info.exit.is_none()
                    && bound.contains(&info.session.0)
                    && self.sessions.owns(info.session)
            })
            .map(|info| info.session)
            .collect();
        self.sessions.detach(&staying);
        let mut book = lock(&self.pane_book);
        for session in bound {
            if !staying.contains(&SessionId(session)) {
                book.unbind_session(session);
            }
        }
    }
}

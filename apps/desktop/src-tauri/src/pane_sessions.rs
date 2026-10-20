//! Which session of the daemon belongs to which pane (NOR-F14-02b).
//!
//! A session of the daemon outlives the window, but it knows nothing about panes: the ids of the
//! panes live in `state.json`, which the page writes and restores. So that the app can tell, when it
//! opens again, which of the sessions the daemon still holds belongs to which restored pane, it keeps
//! this small book of its own next to `state.json`: pane id, the id of the session and the pid of its
//! process. The pid is what makes a match safe: after the daemon was restarted (the machine booted)
//! its ids start over, and a session with the same id but another process is not the one the pane had.
//!
//! The book is written whenever it changes (it is a few lines) and read once, at the start. It is
//! only a hint: a book that is missing, damaged, or from another endpoint is an empty one, and the
//! panes then get new shells, as they did before the daemon kept anything.
//!
//! Nothing here knows about Tauri.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use noren_core::StateStore;
use serde::{Deserialize, Serialize};

/// The book next to `state.json`.
pub const BOOK_FILE_NAME: &str = "sessions.json";
/// The version of the file; another one is read as an empty book.
const BOOK_VERSION: u32 = 1;
/// Longest pane id the book holds (the ids the interface makes are UUIDs).
const MAX_PANE_ID_CHARS: usize = 128;
/// Most panes the book holds. The daemon holds 256 sessions at most, so more is not a pane.
const MAX_PANES: usize = 1024;

/// The session a pane had: its id in the daemon and the pid of its process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub session: u64,
    pub pid: u32,
}

#[derive(Serialize, Deserialize)]
struct BookFile {
    version: u32,
    /// The daemon the sessions are in; a book for another daemon does not apply to this one.
    endpoint: String,
    panes: BTreeMap<String, Binding>,
}

/// The panes that have a session in the daemon, and where that is written down.
#[derive(Default)]
pub struct PaneBook {
    /// `None` keeps the book in memory only (the smoke runs, which must not touch the files of the
    /// user, and the tests).
    store: Option<StateStore>,
    endpoint: String,
    panes: BTreeMap<String, Binding>,
}

impl PaneBook {
    /// A book that is not written anywhere.
    pub fn in_memory() -> Self {
        Self::default()
    }

    /// The book kept in `file`, for the daemon on `endpoint`, as it was left. A file that cannot be
    /// used (missing, damaged, another version, another endpoint) gives an empty book; the next
    /// change replaces it.
    pub fn open(file: PathBuf, endpoint: &str) -> Self {
        let panes = read_book(&file, endpoint).unwrap_or_default();
        Self {
            store: Some(StateStore::new(file)),
            endpoint: endpoint.to_owned(),
            panes,
        }
    }

    /// Where the book is written, when it is.
    #[cfg(test)]
    pub fn file(&self) -> Option<&Path> {
        self.store.as_ref().map(StateStore::path)
    }

    /// The session of `pane`, if the book has one.
    pub fn binding(&self, pane: &str) -> Option<Binding> {
        self.panes.get(pane).copied()
    }

    /// The ids of the sessions the book knows a pane for.
    pub fn sessions(&self) -> Vec<u64> {
        self.panes.values().map(|binding| binding.session).collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.panes.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.panes.is_empty()
    }

    /// Records that `pane` runs in `binding`. A session belongs to one pane: whichever pane had it
    /// before loses it. Refused (`false`) for a pane id that is empty, too long, or when the book is
    /// full.
    pub fn bind(&mut self, pane: &str, binding: Binding) -> bool {
        if pane.is_empty() || pane.chars().count() > MAX_PANE_ID_CHARS {
            return false;
        }
        if !self.panes.contains_key(pane) && self.panes.len() >= MAX_PANES {
            return false;
        }
        self.panes
            .retain(|other, held| other == pane || held.session != binding.session);
        if self.panes.insert(pane.to_owned(), binding) != Some(binding) {
            self.save();
        }
        true
    }

    /// Forgets the pane that had `session` (it ended, or the app ended it).
    pub fn unbind_session(&mut self, session: u64) {
        let before = self.panes.len();
        self.panes.retain(|_, binding| binding.session != session);
        if self.panes.len() != before {
            self.save();
        }
    }

    /// Forgets `pane`.
    pub fn unbind_pane(&mut self, pane: &str) {
        if self.panes.remove(pane).is_some() {
            self.save();
        }
    }

    /// Forgets every pane (the sessions ended with the app).
    pub fn clear(&mut self) {
        if !self.panes.is_empty() {
            self.panes.clear();
            self.save();
        }
    }

    /// Writes the book. A failure is a line in the log: the sessions go on, and the next start
    /// finds them as orphans instead of as the sessions of their panes.
    fn save(&self) {
        let Some(store) = &self.store else {
            return;
        };
        let file = BookFile {
            version: BOOK_VERSION,
            endpoint: self.endpoint.clone(),
            panes: self.panes.clone(),
        };
        let text = match serde_json::to_vec_pretty(&file) {
            Ok(text) => text,
            Err(error) => {
                eprintln!(
                    "warning: could not write down which session belongs to which pane: {error}"
                );
                return;
            }
        };
        if let Err(error) = store.save(&text) {
            eprintln!("warning: could not write down which session belongs to which pane: {error}");
        }
    }
}

/// The panes of the book in `file` when it is a book of version 1 for `endpoint`.
fn read_book(file: &Path, endpoint: &str) -> Option<BTreeMap<String, Binding>> {
    let bytes = match StateStore::new(file).load() {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return None,
        Err(error) => {
            eprintln!("warning: could not read {}: {error}", file.display());
            return None;
        }
    };
    let book: BookFile = match serde_json::from_slice(&bytes) {
        Ok(book) => book,
        Err(error) => {
            eprintln!(
                "warning: {} is not a usable book of sessions: {error}",
                file.display()
            );
            return None;
        }
    };
    (book.version == BOOK_VERSION && book.endpoint == endpoint).then_some(book.panes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("noren-test-book-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("make the folder");
        dir
    }

    fn binding(session: u64, pid: u32) -> Binding {
        Binding { session, pid }
    }

    #[test]
    fn a_book_written_is_read_back_by_the_next_run_on_the_same_endpoint() {
        let dir = folder("round-trip");
        let file = dir.join(BOOK_FILE_NAME);
        let mut book = PaneBook::open(file.clone(), "default");
        assert!(book.is_empty());
        assert!(book.bind("pane-1", binding(4, 1000)));
        assert!(book.bind("pane-2", binding(5, 1001)));

        let again = PaneBook::open(file, "default");
        assert_eq!(again.binding("pane-1"), Some(binding(4, 1000)));
        assert_eq!(again.binding("pane-2"), Some(binding(5, 1001)));
        assert_eq!(again.binding("pane-3"), None);
        assert_eq!(again.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_book_for_another_endpoint_or_version_or_a_damaged_one_is_an_empty_book() {
        let dir = folder("unusable");
        let file = dir.join(BOOK_FILE_NAME);
        PaneBook::open(file.clone(), "default").bind("pane-1", binding(1, 10));

        assert!(PaneBook::open(file.clone(), "smoke-1").is_empty());

        std::fs::write(
            &file,
            r#"{"version":2,"endpoint":"default","panes":{"pane-1":{"session":1,"pid":10}}}"#,
        )
        .expect("write");
        assert!(PaneBook::open(file.clone(), "default").is_empty());

        std::fs::write(&file, "{ not json").expect("write");
        assert!(PaneBook::open(file.clone(), "default").is_empty());

        std::fs::write(&file, [0xff, 0xfe, 0x00]).expect("write");
        assert!(PaneBook::open(file, "default").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_belongs_to_one_pane_and_binding_a_pane_again_replaces_its_session() {
        let mut book = PaneBook::in_memory();
        assert!(book.bind("a", binding(1, 10)));
        assert!(book.bind("b", binding(1, 10)));
        assert_eq!(
            book.binding("a"),
            None,
            "the session moved to the other pane"
        );
        assert_eq!(book.binding("b"), Some(binding(1, 10)));

        assert!(book.bind("b", binding(2, 20)));
        assert_eq!(book.binding("b"), Some(binding(2, 20)));
        assert_eq!(book.sessions(), vec![2]);
    }

    #[test]
    fn unbinding_a_session_forgets_its_pane_and_is_written() {
        let dir = folder("unbind");
        let file = dir.join(BOOK_FILE_NAME);
        let mut book = PaneBook::open(file.clone(), "default");
        book.bind("a", binding(1, 10));
        book.bind("b", binding(2, 20));
        book.unbind_session(1);
        book.unbind_session(99);
        assert_eq!(book.sessions(), vec![2]);

        let again = PaneBook::open(file.clone(), "default");
        assert_eq!(again.binding("a"), None);
        assert_eq!(again.binding("b"), Some(binding(2, 20)));

        let mut book = again;
        book.clear();
        assert!(PaneBook::open(file, "default").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pane_id_that_cannot_be_one_is_refused_and_the_book_has_a_limit() {
        let mut book = PaneBook::in_memory();
        assert!(!book.bind("", binding(1, 10)));
        assert!(!book.bind(&"x".repeat(MAX_PANE_ID_CHARS + 1), binding(1, 10)));
        assert!(book.bind(&"x".repeat(MAX_PANE_ID_CHARS), binding(1, 10)));

        let mut full = PaneBook::in_memory();
        for n in 0..MAX_PANES as u64 {
            assert!(full.bind(&format!("pane-{n}"), binding(n, 10)));
        }
        assert!(!full.bind("one-too-many", binding(5000, 10)));
        // A pane that is already in the book may still change its session.
        assert!(full.bind("pane-0", binding(5000, 10)));
    }

    #[test]
    fn a_book_in_memory_writes_nothing() {
        let mut book = PaneBook::in_memory();
        assert!(book.file().is_none());
        book.bind("a", binding(1, 10));
        assert_eq!(book.len(), 1);
    }
}

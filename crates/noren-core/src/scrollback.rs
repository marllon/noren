//! The scrollback snapshots of the panes, without any Tauri dependency: the folder `scrollback/`
//! next to `state.json`, one text file per pane (`scrollback/<paneId>.txt`).
//!
//! Like the other stores this one keeps text and does not look inside it: the interface serializes
//! the terminal, cleans the text (a snapshot is data from disk, so it is never trusted when it comes
//! back) and decides when to save. The store only makes sure the folder stays safe to write to:
//!
//! - **The id of the pane is a file name**, so it must be [`is_valid_pane_id`]: ASCII letters, digits,
//!   `-` and `_`, at most 64 characters, and not a device name Windows reserves. Anything else, a path
//!   included, is refused before the disk is touched, by every method.
//! - **Writing** is atomic, through the same temporary-file-and-rename path as `state.json`.
//! - **The size is limited** ([`MAX_SCROLLBACK_BYTES`]): a text over the limit is not written, and a
//!   file over the limit is not read (it was not written by this app).
//! - **Reading and deleting never create the folder**, and deleting a pane that has no file is not an
//!   error.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::mods::is_reserved_name;
use crate::store::{StoreError, write_atomic};

/// Name of the folder inside the app data folder, next to `state.json`.
pub const SCROLLBACK_DIR_NAME: &str = "scrollback";

/// The largest snapshot written or read. The last 2,000 lines of a terminal are a few hundred KiB
/// even with a color on every cell; this stops a file that is not a snapshot from being read whole.
pub const MAX_SCROLLBACK_BYTES: u64 = 4 * 1024 * 1024;

/// The longest pane id (it is a file name).
const MAX_ID_LEN: usize = 64;

const EXTENSION: &str = ".txt";

/// Errors returned by [`ScrollbackStore`].
#[derive(Debug)]
pub enum ScrollbackError {
    /// The id is not a pane id, so it cannot be a file name.
    InvalidId(String),
    /// The text, or the file, is larger than [`MAX_SCROLLBACK_BYTES`].
    TooLarge(u64),
    /// The file could not be read or removed.
    Io {
        action: &'static str,
        source: io::Error,
    },
    /// The file could not be written (see [`StoreError`] for the step).
    Write(StoreError),
}

impl fmt::Display for ScrollbackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId(id) => write!(f, "'{id}' is not a valid pane id"),
            Self::TooLarge(size) => write!(
                f,
                "the scrollback is {size} bytes; a snapshot is at most {MAX_SCROLLBACK_BYTES}"
            ),
            Self::Io { action, source } => write!(f, "could not {action}: {source}"),
            Self::Write(source) => write!(f, "could not write the scrollback file: {source}"),
        }
    }
}

impl std::error::Error for ScrollbackError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Write(source) => Some(source),
            _ => None,
        }
    }
}

/// Whether `id` can name a snapshot file: ASCII letters, digits, `-` and `_`, 1 to 64 characters,
/// and not a device name Windows reserves (`con`, `nul`, `com1`...). A UUID is one.
pub fn is_valid_pane_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        && !is_reserved_name(id)
}

/// The folder of the snapshots. Operations of the same store never run at the same time.
#[derive(Debug)]
pub struct ScrollbackStore {
    dir: PathBuf,
    busy: Mutex<()>,
}

impl ScrollbackStore {
    /// A store for the folder `dir`. Nothing is touched on disk until a method runs.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            busy: Mutex::new(()),
        }
    }

    /// Path of the folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.busy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The file of a pane, once its id is known to be safe.
    fn file_of(&self, pane_id: &str) -> Result<PathBuf, ScrollbackError> {
        if !is_valid_pane_id(pane_id) {
            return Err(ScrollbackError::InvalidId(pane_id.to_owned()));
        }
        Ok(self.dir.join(format!("{pane_id}{EXTENSION}")))
    }

    /// Replaces the snapshot of `pane_id` with `text` atomically, exactly as given. Creates the
    /// folder when it is missing. Refuses an id that is not a pane id and a text over
    /// [`MAX_SCROLLBACK_BYTES`], writing nothing.
    pub fn save(&self, pane_id: &str, text: &str) -> Result<(), ScrollbackError> {
        let path = self.file_of(pane_id)?;
        let size = text.len() as u64;
        if size > MAX_SCROLLBACK_BYTES {
            return Err(ScrollbackError::TooLarge(size));
        }
        let _guard = self.lock();
        write_atomic(&path, text.as_bytes()).map_err(ScrollbackError::Write)
    }

    /// The snapshot of `pane_id`; `None` when the pane has none (no file, no folder, or something
    /// that is not a file under that name). Bytes that are not UTF-8 are replaced, so a damaged file
    /// still reads. A file over [`MAX_SCROLLBACK_BYTES`] is an error and is not read whole.
    pub fn load(&self, pane_id: &str) -> Result<Option<String>, ScrollbackError> {
        let path = self.file_of(pane_id)?;
        let _guard = self.lock();
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(ScrollbackError::Io {
                    action: "read the scrollback file",
                    source: error,
                });
            }
        };
        // A folder with that name opens on some systems and fails to read on all of them.
        match file.metadata() {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Ok(None),
            Err(error) => {
                return Err(ScrollbackError::Io {
                    action: "read the scrollback file",
                    source: error,
                });
            }
        }
        // One byte more than the limit tells a file that is too large from one that is exactly at it,
        // without trusting the length the file reported a moment ago.
        let mut bytes = Vec::new();
        file.take(MAX_SCROLLBACK_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| ScrollbackError::Io {
                action: "read the scrollback file",
                source: error,
            })?;
        if bytes.len() as u64 > MAX_SCROLLBACK_BYTES {
            return Err(ScrollbackError::TooLarge(bytes.len() as u64));
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Removes the snapshot of `pane_id`. A pane with no snapshot is not an error, and the folder is
    /// never created. Only a file of that name is removed: something else under it (a folder) stays
    /// and is reported.
    pub fn delete(&self, pane_id: &str) -> Result<(), ScrollbackError> {
        let path = self.file_of(pane_id)?;
        let _guard = self.lock();
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ScrollbackError::Io {
                action: "remove the scrollback file",
                source: error,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A folder under the system temp dir with a unique name, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-scrollback-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        /// The `scrollback` folder inside, which does not exist until something is saved.
        fn scrollback(&self) -> PathBuf {
            self.0.join(SCROLLBACK_DIR_NAME)
        }

        fn names(&self, folder: &Path) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(folder)
                .expect("list the folder")
                .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const UUID: &str = "3f2b8c1e-9d4a-4c7b-8e21-0a5d6f7b9c11";

    #[test]
    fn a_pane_with_no_folder_and_no_file_has_no_snapshot_and_nothing_is_created() {
        let dir = TempDir::new("missing");
        let store = ScrollbackStore::new(dir.scrollback());
        assert_eq!(store.load(UUID).expect("load"), None);
        store.delete(UUID).expect("deleting nothing is fine");
        assert!(!dir.scrollback().exists());
    }

    #[test]
    fn save_creates_the_folder_and_the_file_and_load_reads_it_back_as_given() {
        let dir = TempDir::new("round-trip");
        let store = ScrollbackStore::new(dir.scrollback());
        let text = "\u{1b}[2mline one \u{e9}\u{1b}[0m\nline two \u{1f600}\r\nlast";
        store.save(UUID, text).expect("save");
        assert_eq!(dir.names(&dir.scrollback()), [format!("{UUID}.txt")]);
        assert_eq!(
            fs::read_to_string(dir.scrollback().join(format!("{UUID}.txt"))).expect("read"),
            text
        );
        assert_eq!(store.load(UUID).expect("load").as_deref(), Some(text));
    }

    #[test]
    fn the_snapshot_of_one_pane_is_not_the_snapshot_of_another() {
        let dir = TempDir::new("two-panes");
        let store = ScrollbackStore::new(dir.scrollback());
        store.save("pane-1", "first").expect("save 1");
        store.save("pane-2", "second").expect("save 2");
        assert_eq!(
            store.load("pane-1").expect("load").as_deref(),
            Some("first")
        );
        assert_eq!(
            store.load("pane-2").expect("load").as_deref(),
            Some("second")
        );
        assert_eq!(store.load("pane-3").expect("load"), None);
    }

    #[test]
    fn saving_again_replaces_the_file_and_leaves_no_temporary_file() {
        let dir = TempDir::new("replace");
        let store = ScrollbackStore::new(dir.scrollback());
        store
            .save("pane-1", "a much longer first content")
            .expect("first");
        store.save("pane-1", "second").expect("second");
        assert_eq!(
            store.load("pane-1").expect("load").as_deref(),
            Some("second")
        );
        assert_eq!(dir.names(&dir.scrollback()), ["pane-1.txt"]);
    }

    #[test]
    fn an_empty_snapshot_is_written_and_read_back_empty() {
        let dir = TempDir::new("empty");
        let store = ScrollbackStore::new(dir.scrollback());
        store.save("pane-1", "").expect("save");
        assert_eq!(store.load("pane-1").expect("load").as_deref(), Some(""));
    }

    #[test]
    fn an_id_that_is_not_a_file_name_is_refused_by_every_method_and_nothing_is_touched() {
        let dir = TempDir::new("bad-id");
        let store = ScrollbackStore::new(dir.scrollback());
        let long = "a".repeat(65);
        for id in [
            "",
            ".",
            "..",
            "../escape",
            "..\\escape",
            "a/b",
            "a\\b",
            "/abs",
            "C:\\x",
            "c:x",
            "a:b",
            "a.txt",
            "a b",
            "a\0b",
            "\u{202e}pane",
            "caf\u{e9}",
            "con",
            "CON",
            "Nul",
            "aux",
            "prn",
            "com1",
            "LPT9",
            long.as_str(),
        ] {
            assert!(
                matches!(store.save(id, "x"), Err(ScrollbackError::InvalidId(_))),
                "save {id:?} should be refused"
            );
            assert!(
                matches!(store.load(id), Err(ScrollbackError::InvalidId(_))),
                "load {id:?} should be refused"
            );
            assert!(
                matches!(store.delete(id), Err(ScrollbackError::InvalidId(_))),
                "delete {id:?} should be refused"
            );
        }
        assert!(!dir.scrollback().exists());
        assert_eq!(dir.names(&dir.0), Vec::<String>::new());
    }

    #[test]
    fn ids_that_real_panes_have_are_valid() {
        for id in [
            UUID,
            "pane-1",
            "p_2",
            "id1",
            "7",
            "console",
            "com10",
            &"a".repeat(64),
        ] {
            assert!(is_valid_pane_id(id), "{id:?} should be valid");
        }
        for id in [
            "",
            "a b",
            "a.b",
            "a/b",
            "con",
            "COM9",
            "caf\u{e9}",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_pane_id(id), "{id:?} should be invalid");
        }
    }

    #[test]
    fn an_id_that_is_a_path_cannot_reach_a_file_outside_the_folder() {
        let dir = TempDir::new("escape");
        // A file the id could name by climbing out of the folder.
        fs::write(dir.0.join("victim.txt"), "keep me").expect("write");
        let store = ScrollbackStore::new(dir.scrollback());
        assert!(store.delete("../victim").is_err());
        assert!(store.save("../victim", "overwritten").is_err());
        assert_eq!(store.load("../victim").ok(), None);
        assert_eq!(
            fs::read_to_string(dir.0.join("victim.txt")).expect("read"),
            "keep me"
        );
    }

    #[test]
    fn a_text_over_the_limit_is_not_written() {
        let dir = TempDir::new("too-large");
        let store = ScrollbackStore::new(dir.scrollback());
        let text = "x".repeat(usize::try_from(MAX_SCROLLBACK_BYTES).expect("size") + 1);
        assert!(matches!(
            store.save("pane-1", &text),
            Err(ScrollbackError::TooLarge(_))
        ));
        assert!(!dir.scrollback().exists());
    }

    #[test]
    fn a_text_exactly_at_the_limit_is_written_and_read_back() {
        let dir = TempDir::new("at-limit");
        let store = ScrollbackStore::new(dir.scrollback());
        let text = "y".repeat(usize::try_from(MAX_SCROLLBACK_BYTES).expect("size"));
        store.save("pane-1", &text).expect("save");
        let back = store.load("pane-1").expect("load").expect("some");
        assert_eq!(back.len(), text.len());
    }

    #[test]
    fn a_file_over_the_limit_is_not_read() {
        let dir = TempDir::new("big-file");
        fs::create_dir_all(dir.scrollback()).expect("folder");
        let big = vec![b'z'; usize::try_from(MAX_SCROLLBACK_BYTES).expect("size") + 10];
        fs::write(dir.scrollback().join("pane-1.txt"), big).expect("write");
        let store = ScrollbackStore::new(dir.scrollback());
        assert!(matches!(
            store.load("pane-1"),
            Err(ScrollbackError::TooLarge(_))
        ));
    }

    #[test]
    fn a_damaged_file_reads_with_the_bad_bytes_replaced() {
        let dir = TempDir::new("not-utf8");
        fs::create_dir_all(dir.scrollback()).expect("folder");
        fs::write(
            dir.scrollback().join("pane-1.txt"),
            [b'a', 0xff, 0xfe, b'b'],
        )
        .expect("write");
        let store = ScrollbackStore::new(dir.scrollback());
        assert_eq!(
            store.load("pane-1").expect("load").as_deref(),
            Some("a\u{fffd}\u{fffd}b")
        );
    }

    #[test]
    fn delete_removes_only_the_file_of_that_pane() {
        let dir = TempDir::new("delete");
        let store = ScrollbackStore::new(dir.scrollback());
        store.save("pane-1", "one").expect("save 1");
        store.save("pane-2", "two").expect("save 2");
        fs::write(dir.scrollback().join("notes.md"), "not ours").expect("write");

        store.delete("pane-1").expect("delete");
        assert_eq!(store.load("pane-1").expect("load"), None);
        assert_eq!(dir.names(&dir.scrollback()), ["notes.md", "pane-2.txt"]);
        // Deleting what is not there is fine, and so is deleting twice.
        store.delete("pane-1").expect("delete again");
        store.delete("pane-9").expect("delete a pane with no file");
        assert_eq!(dir.names(&dir.scrollback()), ["notes.md", "pane-2.txt"]);
    }

    #[test]
    fn a_folder_with_the_name_of_a_file_is_no_snapshot_and_is_not_removed() {
        let dir = TempDir::new("folder-in-the-way");
        fs::create_dir_all(dir.scrollback().join("pane-1.txt")).expect("folder");
        let store = ScrollbackStore::new(dir.scrollback());
        assert_eq!(store.load("pane-1").ok().flatten(), None);
        assert!(store.delete("pane-1").is_err());
        assert!(dir.scrollback().join("pane-1.txt").is_dir());
    }

    #[test]
    fn save_fails_with_a_message_when_the_folder_is_a_file() {
        let dir = TempDir::new("in-the-way");
        fs::write(dir.scrollback(), b"a file where the folder should be").expect("write");
        let store = ScrollbackStore::new(dir.scrollback());
        let error = store.save("pane-1", "x").expect_err("must fail");
        assert!(matches!(error, ScrollbackError::Write(_)));
        assert!(
            error
                .to_string()
                .starts_with("could not write the scrollback file")
        );
    }

    #[test]
    fn concurrent_saves_leave_one_complete_content() {
        let dir = TempDir::new("concurrent");
        let folder = dir.scrollback();
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let folder = folder.clone();
                thread::spawn(move || {
                    // Different stores on the same file: only the atomic rename protects them.
                    let store = ScrollbackStore::new(folder);
                    let text = char::from(b'a' + i).to_string().repeat(4096);
                    for _ in 0..20 {
                        store.save("pane-1", &text).expect("save");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread");
        }
        let text = ScrollbackStore::new(&folder)
            .load("pane-1")
            .expect("load")
            .expect("file");
        assert_eq!(text.len(), 4096);
        let first = text.chars().next().expect("a character");
        assert!(text.chars().all(|c| c == first));
        assert_eq!(dir.names(&folder), ["pane-1.txt"]);
    }
}

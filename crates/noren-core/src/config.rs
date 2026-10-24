//! The settings file `config.jsonc`, without any Tauri dependency: read, write atomically and
//! watch.
//!
//! The file is text that belongs to the person: it may hold comments, trailing commas and keys
//! this build does not know. Nothing here parses it (the interface owns the schema); the store
//! keeps text. A write goes through the same atomic path as `state.json` (temporary file in the
//! same folder, flush, rename), so a crash leaves the old file or the new one, never half of one.
//!
//! [`ConfigStore::watch`] tells when the file changes, from inside or outside the app. It watches
//! the folder, not the file, because editors and the atomic write replace the file instead of
//! changing it; events are gathered until the folder is quiet for [`SETTLE`], the file is read
//! once, and the callback runs only when the text differs from the last one it reported.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::store::{StoreError, parent_and_name, write_atomic};

/// Name of the settings file inside the config folder of the app.
pub const CONFIG_FILE_NAME: &str = "config.jsonc";

/// How long the folder must stay quiet before the file is read. An atomic write, or an editor that
/// saves through a backup file, produces several events within a few milliseconds.
pub const SETTLE: Duration = Duration::from_millis(100);

/// Reads of a file another program is replacing can fail for a moment (Windows keeps the file
/// busy while a scanner or an editor has it open); they are tried again.
const READ_ATTEMPTS: u32 = 5;
const READ_RETRY_DELAY: Duration = Duration::from_millis(20);

/// Errors returned by [`ConfigStore`].
#[derive(Debug)]
pub enum ConfigError {
    /// The file could not be read.
    Read(io::Error),
    /// The file could not be written (see [`StoreError`] for the step).
    Write(StoreError),
    /// The folder could not be created or watched.
    Watch(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(source) => write!(f, "could not read the config file: {source}"),
            Self::Write(source) => write!(f, "could not write the config file: {source}"),
            Self::Watch(message) => write!(f, "could not watch the config file: {message}"),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(source) => Some(source),
            Self::Write(source) => Some(source),
            Self::Watch(_) => None,
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reads `path` as text; `None` when it does not exist. Bytes that are not valid UTF-8 are
/// replaced, so a damaged file still reaches the interface, which reports it as invalid.
fn read_text(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Like [`read_text`], trying again for a moment when the file is busy.
fn read_text_patiently(path: &Path) -> io::Result<Option<String>> {
    let mut attempt = 1;
    loop {
        match read_text(path) {
            Err(_) if attempt < READ_ATTEMPTS => {
                attempt += 1;
                thread::sleep(READ_RETRY_DELAY);
            }
            other => return other,
        }
    }
}

/// One settings file. Reads and writes of the same store never run at the same time.
#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
    busy: Mutex<()>,
}

impl ConfigStore {
    /// A store for the file at `path`. Nothing is touched on disk until a method runs.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            busy: Mutex::new(()),
        }
    }

    /// Path of the settings file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The text of the file; `None` when it does not exist yet.
    pub fn load(&self) -> Result<Option<String>, ConfigError> {
        let _guard = lock(&self.busy);
        read_text(&self.path).map_err(ConfigError::Read)
    }

    /// Replaces the file with `text` atomically. Creates the folder when it is missing.
    pub fn save(&self, text: &str) -> Result<(), ConfigError> {
        let _guard = lock(&self.busy);
        write_atomic(&self.path, text.as_bytes()).map_err(ConfigError::Write)
    }

    /// Calls `on_change` with the new text (`None` when the file was removed) every time the file
    /// changes, whoever changed it, from a thread of its own. The text the file has now is the
    /// starting point: it is not reported, unless it changes before this returns. Creates the
    /// folder when it is missing, so a file that does not exist yet can still be watched.
    ///
    /// Dropping the returned [`ConfigWatcher`] stops the watching.
    pub fn watch<F>(&self, on_change: F) -> Result<ConfigWatcher, ConfigError>
    where
        F: Fn(Option<String>) + Send + 'static,
    {
        let (folder, name) = parent_and_name(&self.path).map_err(ConfigError::Write)?;
        let name = name.to_owned();
        fs::create_dir_all(&folder).map_err(|e| ConfigError::Watch(e.to_string()))?;
        let initial = read_text_patiently(&self.path).map_err(ConfigError::Read)?;

        let (signal, quiet) = mpsc::channel::<()>();
        let sender = signal.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                // A failed event (the OS dropped some) says nothing about which file: look anyway.
                let about_the_file = match &event {
                    Ok(event) => event
                        .paths
                        .iter()
                        .any(|path| path.file_name() == Some(name.as_os_str())),
                    Err(_) => true,
                };
                if about_the_file {
                    let _ = sender.send(());
                }
            })
            .map_err(|e| ConfigError::Watch(e.to_string()))?;
        watcher
            .watch(&folder, RecursiveMode::NonRecursive)
            .map_err(|e| ConfigError::Watch(e.to_string()))?;

        // A change between the first read and the start of the watching raised no event: one
        // look now closes that gap.
        let _ = signal.send(());
        let path = self.path.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        thread::spawn(move || {
            let mut last = initial;
            // The senders live in the watcher: when it is dropped the loop ends.
            while quiet.recv().is_ok() {
                while quiet.recv_timeout(SETTLE).is_ok() {}
                let Ok(text) = read_text_patiently(&path) else {
                    continue;
                };
                // The watching of the OS stops a moment after the drop; what it still reports
                // must not reach the caller.
                if stop.load(Ordering::Acquire) {
                    continue;
                }
                if text != last {
                    last = text.clone();
                    on_change(text);
                }
            }
        });
        Ok(ConfigWatcher {
            _watcher: watcher,
            stopped,
        })
    }
}

/// Keeps the watching of a [`ConfigStore`] alive; dropping it stops it.
pub struct ConfigWatcher {
    _watcher: RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl Drop for ConfigWatcher {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

impl fmt::Debug for ConfigWatcher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConfigWatcher").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// More than enough for an OS event to arrive and [`SETTLE`] to pass, even on a busy machine.
    const PATIENCE: Duration = Duration::from_secs(15);
    /// Long enough for an event that is going to arrive to have arrived.
    const QUIET_FOR: Duration = Duration::from_millis(800);

    /// A folder under the system temp dir with a unique name, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-config-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }

        fn names(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .expect("list the test folder")
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

    /// A watcher whose reports can be waited for.
    fn watching(store: &ConfigStore) -> (ConfigWatcher, mpsc::Receiver<Option<String>>) {
        let (reports, heard) = mpsc::channel();
        let watcher = store
            .watch(move |text| {
                let _ = reports.send(text);
            })
            .expect("watch");
        (watcher, heard)
    }

    fn next(heard: &mpsc::Receiver<Option<String>>) -> Option<String> {
        heard
            .recv_timeout(PATIENCE)
            .expect("the change was reported in time")
    }

    #[test]
    fn missing_file_loads_as_none() {
        let dir = TempDir::new("missing");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        assert_eq!(store.load().expect("load"), None);
    }

    #[test]
    fn a_save_is_read_back_with_comments_and_commas_untouched() {
        let dir = TempDir::new("roundtrip");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        let text = "// my settings\r\n{\r\n  /* side */ \"appearance\": { \"sidebar\": { \"position\": \"right\", }, },\r\n}\r\n";
        store.save(text).expect("save");
        assert_eq!(store.load().expect("load"), Some(text.to_owned()));
    }

    #[test]
    fn a_save_keeps_the_bytes_of_the_text_it_is_given() {
        // What the settings screen hands over after editing the file: a byte order mark, comments
        // in two languages, and the line breaks the person's editor chose, none of it normalized.
        let dir = TempDir::new("verbatim");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        let text = "\u{feff}// configuração — não mexa\n{\r\n\t\"notifications\": { \"enabled\": false }, // sem aviso\n}";
        store.save(text).expect("save");
        assert_eq!(
            fs::read(store.path()).expect("read"),
            text.as_bytes(),
            "the file holds the text as given"
        );
        assert_eq!(store.load().expect("load"), Some(text.to_owned()));
    }

    #[test]
    fn a_save_can_empty_the_file_and_make_it_again() {
        let dir = TempDir::new("empty");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        store.save("{ }").expect("save");
        store.save("").expect("save empty");
        assert_eq!(store.load().expect("load"), Some(String::new()));
        store
            .save("{\n  \"keybindings\": { \"preset\": \"browser\" }\n}\n")
            .expect("save again");
        assert_eq!(dir.names(), [CONFIG_FILE_NAME]);
    }

    #[test]
    fn a_save_does_not_follow_a_folder_where_the_file_should_be() {
        // A folder named like the file cannot be replaced by a text: the save says so and the
        // folder is left alone.
        let dir = TempDir::new("folder-in-the-way");
        let in_the_way = dir.file(CONFIG_FILE_NAME);
        fs::create_dir(&in_the_way).expect("create the folder");
        let store = ConfigStore::new(&in_the_way);
        assert!(matches!(store.save("{}"), Err(ConfigError::Write(_))));
        assert!(in_the_way.is_dir());
        assert_eq!(dir.names(), [CONFIG_FILE_NAME]);
    }

    #[test]
    fn save_creates_the_missing_folder() {
        let dir = TempDir::new("mkdir");
        let store = ConfigStore::new(dir.file("a").join("b").join(CONFIG_FILE_NAME));
        store.save("{}").expect("save");
        assert_eq!(store.load().expect("load"), Some("{}".to_owned()));
    }

    #[test]
    fn save_replaces_the_file_and_leaves_no_temporary_file() {
        let dir = TempDir::new("overwrite");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        store
            .save("{ \"first\": \"a longer text\" }")
            .expect("save 1");
        store.save("{}").expect("save 2");
        assert_eq!(store.load().expect("load"), Some("{}".to_owned()));
        assert_eq!(dir.names(), [CONFIG_FILE_NAME]);
    }

    #[test]
    fn an_interrupted_write_leaves_the_old_file_readable() {
        let dir = TempDir::new("interrupted");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        store.save("{ \"good\": true }").expect("save");
        // What a crash in the middle of a write leaves behind: a half-written temporary file.
        let stray = dir.file("config.jsonc.99999-0.tmp");
        fs::write(&stray, "{ \"half\":").expect("write the stray file");

        assert_eq!(
            store.load().expect("load"),
            Some("{ \"good\": true }".to_owned())
        );
        store.save("{ \"newer\": true }").expect("save again");
        assert_eq!(
            store.load().expect("load"),
            Some("{ \"newer\": true }".to_owned())
        );
        // The temporary file of another write is not ours to remove.
        assert!(stray.exists());
    }

    #[test]
    fn concurrent_saves_leave_one_complete_text() {
        let text_of = |writer: u8| format!("{{ \"writer\": {writer} }}{}", " ".repeat(4096));
        let dir = TempDir::new("concurrent");
        let path = dir.file(CONFIG_FILE_NAME);
        let handles: Vec<_> = (0..8u8)
            .map(|writer| {
                let path = path.clone();
                thread::spawn(move || {
                    // Different stores on the same file: only the atomic rename protects them.
                    let store = ConfigStore::new(path);
                    for _ in 0..20 {
                        store.save(&text_of(writer)).expect("save");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread");
        }
        let text = ConfigStore::new(&path).load().expect("load").expect("file");
        assert!((0..8u8).any(|writer| text == text_of(writer)), "{text:.40}");
        assert_eq!(dir.names(), [CONFIG_FILE_NAME]);
    }

    #[test]
    fn bytes_that_are_not_text_still_load() {
        let dir = TempDir::new("lossy");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        fs::write(store.path(), b"{ \"a\": \"\xff\" }").expect("write");
        let text = store.load().expect("load").expect("file");
        assert!(text.contains('\u{fffd}'), "{text:?}");
    }

    #[test]
    fn a_folder_where_the_file_should_be_is_a_read_error() {
        let dir = TempDir::new("folder");
        let path = dir.file(CONFIG_FILE_NAME);
        fs::create_dir(&path).expect("make the folder");
        let store = ConfigStore::new(path);
        assert!(matches!(store.load(), Err(ConfigError::Read(_))));
    }

    #[test]
    fn save_into_a_path_without_a_file_name_is_an_error() {
        let store = ConfigStore::new("..");
        assert!(matches!(store.save("{}"), Err(ConfigError::Write(_))));
    }

    #[test]
    fn watch_reports_a_save_made_by_the_app() {
        let dir = TempDir::new("watch-save");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        store.save("{}").expect("save");
        let (_watcher, heard) = watching(&store);

        store.save("{ \"a\": 1 }").expect("save again");
        assert_eq!(next(&heard), Some("{ \"a\": 1 }".to_owned()));
    }

    #[test]
    fn watch_reports_an_edit_made_by_another_program() {
        let dir = TempDir::new("watch-edit");
        let path = dir.file(CONFIG_FILE_NAME);
        fs::write(&path, "{}").expect("write");
        let store = ConfigStore::new(&path);
        let (_watcher, heard) = watching(&store);

        // An editor changing the file in place, with no rename.
        fs::write(&path, "// edited\n{ \"b\": 2 }").expect("edit");
        assert_eq!(next(&heard), Some("// edited\n{ \"b\": 2 }".to_owned()));
    }

    #[test]
    fn watch_reports_a_file_created_in_a_folder_that_did_not_exist() {
        let dir = TempDir::new("watch-create");
        let store = ConfigStore::new(dir.file("not-yet").join(CONFIG_FILE_NAME));
        let (_watcher, heard) = watching(&store);

        store.save("{ \"new\": true }").expect("save");
        assert_eq!(next(&heard), Some("{ \"new\": true }".to_owned()));
    }

    #[test]
    fn watch_reports_the_removal_of_the_file() {
        let dir = TempDir::new("watch-remove");
        let path = dir.file(CONFIG_FILE_NAME);
        fs::write(&path, "{}").expect("write");
        let store = ConfigStore::new(&path);
        let (_watcher, heard) = watching(&store);

        fs::remove_file(&path).expect("remove");
        assert_eq!(next(&heard), None);
    }

    #[test]
    fn watch_does_not_report_the_starting_text_or_an_unchanged_one() {
        let dir = TempDir::new("watch-same");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        store.save("{ \"same\": true }").expect("save");
        let (_watcher, heard) = watching(&store);
        assert!(heard.recv_timeout(QUIET_FOR).is_err(), "starting text");

        store
            .save("{ \"same\": true }")
            .expect("save the same text");
        assert!(heard.recv_timeout(QUIET_FOR).is_err(), "same text");

        // The watcher is still alive: a real change goes through.
        store.save("{ \"same\": false }").expect("save a change");
        assert_eq!(next(&heard), Some("{ \"same\": false }".to_owned()));
    }

    #[test]
    fn watch_gathers_a_burst_of_writes_into_the_last_text() {
        let dir = TempDir::new("watch-burst");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        let (_watcher, heard) = watching(&store);

        for n in 0..10 {
            store.save(&format!("{{ \"n\": {n} }}")).expect("save");
        }
        let mut last = next(&heard);
        while let Ok(more) = heard.recv_timeout(QUIET_FOR) {
            last = more;
        }
        assert_eq!(last, Some("{ \"n\": 9 }".to_owned()));
    }

    #[test]
    fn watch_ignores_other_files_in_the_folder() {
        let dir = TempDir::new("watch-other");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        let (_watcher, heard) = watching(&store);

        fs::write(dir.file("state.json"), "{}").expect("write another file");
        assert!(heard.recv_timeout(QUIET_FOR).is_err());
    }

    #[test]
    fn dropping_the_watcher_stops_the_reports() {
        let dir = TempDir::new("watch-drop");
        let store = ConfigStore::new(dir.file(CONFIG_FILE_NAME));
        let (watcher, heard) = watching(&store);
        store.save("{ \"before\": true }").expect("save");
        assert_eq!(next(&heard), Some("{ \"before\": true }".to_owned()));
        // Let the late events of that save drain, or they would make the thread read the next one.
        thread::sleep(QUIET_FOR);

        drop(watcher);
        store.save("{ \"after\": true }").expect("save after");
        // The sender went away with the thread: nothing more arrives, and the channel closes.
        assert!(heard.recv_timeout(QUIET_FOR).is_err());
    }
}

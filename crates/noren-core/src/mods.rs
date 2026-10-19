//! The mods of the user, without any Tauri dependency: the folder `mods/` next to `config.jsonc`,
//! one CSS file per mod (`mods/<name>.css`).
//!
//! The app only reads this folder: a mod is a file the person puts there (or copies from
//! `examples/mods/`) and edits with their own editor. Like the other stores this one keeps text and
//! does not look inside it; the interface wraps each file in `@layer mods` and applies it.
//!
//! - **Listing** reads the text of every file that can be a mod and leaves out the rest: a name that
//!   is not [`is_valid_mod_file_name`] (so there is never a path in it), a folder, a file that is not
//!   UTF-8 text or is larger than [`MAX_MOD_BYTES`], and everything past the first [`MAX_MODS`] by
//!   name. The folder is never created by a list.
//! - **Watching** ([`ModStore::watch`]) tells when the folder changes, from inside or outside the
//!   app: a file added, edited or removed. It watches the folder that holds `mods/`, not `mods/`
//!   itself, because the folder can be deleted and made again; events are gathered until the folder is
//!   quiet for [`SETTLE`], the folder is listed once, and the callback runs only when the files
//!   differ from the last list it reported.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Name of the folder inside the config folder of the app.
pub const MODS_DIR_NAME: &str = "mods";

/// The largest mod file read. A mod is a few KiB of CSS; this only stops a file that is not a mod
/// from being read whole.
pub const MAX_MOD_BYTES: u64 = 256 * 1024;

/// The most mods listed (the first ones by name).
pub const MAX_MODS: usize = 100;

/// How long the folder must stay quiet before it is listed. An editor that saves through a backup
/// file produces several events within a few milliseconds.
pub const SETTLE: Duration = Duration::from_millis(100);

/// Reads of a file another program is replacing can fail for a moment (Windows keeps the file busy
/// while a scanner or an editor has it open); they are tried again.
const READ_ATTEMPTS: u32 = 5;
const READ_RETRY_DELAY: Duration = Duration::from_millis(20);

const EXTENSION: &str = ".css";

/// The longest name before the extension.
const MAX_STEM_LEN: usize = 64;

/// Device names Windows reserves: a file called `con.css` is the console there.
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Errors returned by [`ModStore`].
#[derive(Debug)]
pub enum ModError {
    /// The folder could not be read.
    Read(io::Error),
    /// The folder could not be created or watched.
    Watch(String),
}

impl fmt::Display for ModError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(source) => write!(f, "could not read the mods folder: {source}"),
            Self::Watch(message) => write!(f, "could not watch the mods folder: {message}"),
        }
    }
}

impl std::error::Error for ModError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(source) => Some(source),
            Self::Watch(_) => None,
        }
    }
}

/// Whether `name` is the file name of a mod: a letter or digit, then letters, digits, `.`, `_` and
/// `-` (64 characters at most), then `.css` in lower case. It is not a Windows device name
/// (`con.css`, `aux.v2.css`). The names are plain ASCII on purpose: the same rule holds on every
/// system, and a name can never be a path.
pub fn is_valid_mod_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(EXTENSION) else {
        return false;
    };
    let mut bytes = stem.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    stem.len() <= MAX_STEM_LEN
        && first.is_ascii_alphanumeric()
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !is_reserved_name(stem)
}

/// Whether the part of `stem` before its first dot is a device name, in any case.
fn is_reserved_name(stem: &str) -> bool {
    let first = stem.split('.').next().unwrap_or(stem).to_ascii_lowercase();
    RESERVED_NAMES.contains(&first.as_str())
}

/// One mod: the name of its file and its CSS, exactly as the file holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModFile {
    pub name: String,
    pub text: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The mod a file holds, when it can be one: UTF-8 text.
fn mod_text(bytes: Vec<u8>) -> Option<String> {
    String::from_utf8(bytes).ok()
}

/// Reads `path`, trying again for a moment when the file is busy. `None` when it cannot be read.
fn read_patiently(path: &Path) -> Option<Vec<u8>> {
    let mut attempt = 1;
    loop {
        match fs::read(path) {
            Ok(bytes) => return Some(bytes),
            Err(_) if attempt < READ_ATTEMPTS => {
                attempt += 1;
                thread::sleep(READ_RETRY_DELAY);
            }
            Err(_) => return None,
        }
    }
}

/// The folder of the mods of the user. Reads of the same store never run at the same time.
#[derive(Debug)]
pub struct ModStore {
    dir: PathBuf,
    busy: Mutex<()>,
}

impl ModStore {
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

    /// Every file that can be a mod (see the top of this file), in the order of the file names. A
    /// folder that does not exist is no files. The folder is never created here.
    pub fn list(&self) -> Result<Vec<ModFile>, ModError> {
        let _guard = lock(&self.busy);
        list_dir(&self.dir, false)
    }

    /// Calls `on_change` with the files of the folder every time they change, whoever changed
    /// them, from a thread of its own. The files there now are the starting point: they are not
    /// reported, unless they change before this returns. Creates the folder when it is missing, so
    /// there is somewhere to put a file, and watches it even if it is deleted and made again.
    ///
    /// Dropping the returned [`ModWatcher`] stops the watching.
    pub fn watch<F>(&self, on_change: F) -> Result<ModWatcher, ModError>
    where
        F: Fn(Vec<ModFile>) + Send + 'static,
    {
        fs::create_dir_all(&self.dir).map_err(|e| ModError::Watch(e.to_string()))?;
        // The folder that holds `mods/` is the one watched, so the folder itself can come and go.
        let parent = self
            .dir
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| ModError::Watch("the mods folder has no parent folder".to_owned()))?
            .to_path_buf();
        let initial = list_dir(&self.dir, true)?;

        let (signal, quiet) = mpsc::channel::<()>();
        let sender = signal.clone();
        let watched_dir = self.dir.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                // A failed event (the OS dropped some) says nothing about which file: look anyway.
                let about_the_mods = match &event {
                    Ok(event) => event
                        .paths
                        .iter()
                        .any(|path| path.starts_with(&watched_dir)),
                    Err(_) => true,
                };
                if about_the_mods {
                    let _ = sender.send(());
                }
            })
            .map_err(|e| ModError::Watch(e.to_string()))?;
        watcher
            .watch(&parent, RecursiveMode::Recursive)
            .map_err(|e| ModError::Watch(e.to_string()))?;

        // A change between the first list and the start of the watching raised no event: one look
        // now closes that gap.
        let _ = signal.send(());
        let dir = self.dir.clone();
        thread::spawn(move || {
            let mut last = initial;
            // The senders live in the watcher: when it is dropped the loop ends.
            while quiet.recv().is_ok() {
                while quiet.recv_timeout(SETTLE).is_ok() {}
                let Ok(files) = list_dir(&dir, true) else {
                    continue;
                };
                if files != last {
                    last = files.clone();
                    on_change(files);
                }
            }
        });
        Ok(ModWatcher { _watcher: watcher })
    }
}

/// The files of `dir` that can be mods, by name. `patient` tries a busy file again for a moment
/// (the watching reads while an editor may still hold the file).
fn list_dir(dir: &Path, patient: bool) -> Result<Vec<ModFile>, ModError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ModError::Read(error)),
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| is_valid_mod_file_name(name))
        .collect();
    names.sort();

    let mut files = Vec::new();
    for name in names {
        if files.len() == MAX_MODS {
            break;
        }
        let path = dir.join(&name);
        // `metadata` follows a link, so a link to a folder is not a file either.
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_MOD_BYTES {
            continue;
        }
        let bytes = if patient {
            read_patiently(&path)
        } else {
            fs::read(&path).ok()
        };
        if let Some(text) = bytes.and_then(mod_text) {
            files.push(ModFile { name, text });
        }
    }
    Ok(files)
}

/// Keeps the watching of a [`ModStore`] alive; dropping it stops it.
pub struct ModWatcher {
    _watcher: RecommendedWatcher,
}

impl fmt::Debug for ModWatcher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModWatcher").finish_non_exhaustive()
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
                "noren-mods-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        /// The `mods` folder inside, which does not exist until something makes it.
        fn mods(&self) -> PathBuf {
            self.0.join(MODS_DIR_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn file(name: &str, text: &str) -> ModFile {
        ModFile {
            name: name.to_owned(),
            text: text.to_owned(),
        }
    }

    /// A watcher whose reports can be waited for.
    fn watching(store: &ModStore) -> (ModWatcher, mpsc::Receiver<Vec<ModFile>>) {
        let (reports, heard) = mpsc::channel();
        let watcher = store
            .watch(move |files| {
                let _ = reports.send(files);
            })
            .expect("watch");
        (watcher, heard)
    }

    fn next(heard: &mpsc::Receiver<Vec<ModFile>>) -> Vec<ModFile> {
        heard
            .recv_timeout(PATIENCE)
            .expect("the change was reported in time")
    }

    #[test]
    fn mod_file_names_are_plain_names_ending_in_dot_css() {
        for name in [
            "a.css",
            "compact-tabs.css",
            "Sidebar_v2.css",
            "dark.theme.css",
            "7.css",
            "con-x.css",
            "nul2.css",
            &format!("{}.css", "a".repeat(64)),
        ] {
            assert!(is_valid_mod_file_name(name), "{name:?} should be valid");
        }
        for name in [
            "",
            ".css",
            "css",
            "a",
            "a.CSS",
            "a.css ",
            "a.css.bak",
            "a.txt",
            "-a.css",
            "_a.css",
            ".a.css",
            "a b.css",
            "a/b.css",
            "a\\b.css",
            "../a.css",
            "..\\a.css",
            "a:b.css",
            "a\u{0}.css",
            "caf\u{e9}.css",
            "con.css",
            "CON.css",
            "Aux.v2.css",
            "com1.css",
            "LPT9.css",
            &format!("{}.css", "a".repeat(65)),
        ] {
            assert!(!is_valid_mod_file_name(name), "{name:?} should be invalid");
        }
    }

    #[test]
    fn a_folder_that_does_not_exist_has_no_mods_and_is_not_created() {
        let dir = TempDir::new("missing");
        let store = ModStore::new(dir.mods());
        assert_eq!(store.list().expect("list"), Vec::new());
        assert!(!dir.mods().exists());
    }

    #[test]
    fn list_reads_the_files_as_they_are_in_the_order_of_their_names() {
        let dir = TempDir::new("order");
        fs::create_dir_all(dir.mods()).expect("folder");
        let text = "\u{feff}/* caf\u{e9} */\r\n.sidebar { opacity: 1; }\n";
        for (name, body) in [("zeta.css", "z"), ("alpha.css", text), ("mid.css", "m")] {
            fs::write(dir.mods().join(name), body).expect("write");
        }
        let store = ModStore::new(dir.mods());
        assert_eq!(
            store.list().expect("list"),
            [
                file("alpha.css", text),
                file("mid.css", "m"),
                file("zeta.css", "z")
            ]
        );
    }

    #[test]
    fn list_leaves_out_what_cannot_be_a_mod() {
        let dir = TempDir::new("invalid");
        let folder = dir.mods();
        fs::create_dir_all(&folder).expect("folder");
        let put = |name: &str, bytes: &[u8]| fs::write(folder.join(name), bytes).expect("write");
        put("good.css", b"a { color: red }");
        put("empty.css", b"");
        // Not UTF-8.
        put("binary.css", &[b'a', 0xff, 0xfe, b'{', b'}']);
        // The name is not `<name>.css`.
        put("Upper.CSS", b"a{}");
        put("has space.css", b"a{}");
        put("notes.txt", b"a{}");
        put("good.css.bak", b"a{}");
        put("good.css.4242-0.tmp", b"a{");
        put(".css", b"a{}");
        put("con.css", b"a{}");
        // A folder with a good name.
        fs::create_dir_all(folder.join("folder.css")).expect("subfolder");
        // Too large.
        let mut big = b"/* ".to_vec();
        big.resize(usize::try_from(MAX_MOD_BYTES).expect("size") + 10, b'x');
        big.extend_from_slice(b" */");
        put("big.css", &big);

        let store = ModStore::new(&folder);
        assert_eq!(
            store.list().expect("list"),
            [file("empty.css", ""), file("good.css", "a { color: red }")]
        );
    }

    #[test]
    fn list_stops_at_the_limit_by_name() {
        let dir = TempDir::new("limit");
        fs::create_dir_all(dir.mods()).expect("folder");
        for n in 0..MAX_MODS + 5 {
            fs::write(dir.mods().join(format!("m{n:03}.css")), "a{}").expect("write");
        }
        let files = ModStore::new(dir.mods()).list().expect("list");
        assert_eq!(files.len(), MAX_MODS);
        assert_eq!(files[0].name, "m000.css");
        assert_eq!(
            files[MAX_MODS - 1].name,
            format!("m{:03}.css", MAX_MODS - 1)
        );
    }

    #[test]
    fn a_file_in_the_way_of_the_folder_is_a_read_error() {
        let dir = TempDir::new("in-the-way");
        fs::write(dir.mods(), b"a file where the folder should be").expect("write");
        let store = ModStore::new(dir.mods());
        let error = store.list().expect_err("must fail");
        assert!(matches!(error, ModError::Read(_)));
        assert!(
            error
                .to_string()
                .starts_with("could not read the mods folder")
        );
    }

    #[test]
    fn watch_creates_the_folder_so_there_is_somewhere_to_put_a_file() {
        let dir = TempDir::new("watch-creates");
        let store = ModStore::new(dir.mods());
        let (_watcher, _heard) = watching(&store);
        assert!(dir.mods().is_dir());
    }

    #[test]
    fn watch_reports_a_file_added_changed_and_removed() {
        let dir = TempDir::new("watch-life");
        let store = ModStore::new(dir.mods());
        let (_watcher, heard) = watching(&store);
        let path = dir.mods().join("dark.css");

        fs::write(&path, ".a { color: red }").expect("add");
        assert_eq!(next(&heard), [file("dark.css", ".a { color: red }")]);

        // An editor changing the file in place, with no rename.
        fs::write(&path, ".a { color: blue }").expect("edit");
        assert_eq!(next(&heard), [file("dark.css", ".a { color: blue }")]);

        fs::remove_file(&path).expect("remove");
        assert_eq!(next(&heard), Vec::new());
    }

    #[test]
    fn watch_does_not_report_the_starting_files_or_an_unchanged_one() {
        let dir = TempDir::new("watch-same");
        fs::create_dir_all(dir.mods()).expect("folder");
        let path = dir.mods().join("same.css");
        fs::write(&path, "a{}").expect("write");
        let store = ModStore::new(dir.mods());
        let (_watcher, heard) = watching(&store);
        assert!(heard.recv_timeout(QUIET_FOR).is_err(), "starting files");

        fs::write(&path, "a{}").expect("write the same text");
        assert!(heard.recv_timeout(QUIET_FOR).is_err(), "same text");

        // The watcher is still alive: a real change goes through.
        fs::write(&path, "b{}").expect("write a change");
        assert_eq!(next(&heard), [file("same.css", "b{}")]);
    }

    #[test]
    fn watch_gathers_a_burst_of_writes_into_the_last_files() {
        let dir = TempDir::new("watch-burst");
        let store = ModStore::new(dir.mods());
        let (_watcher, heard) = watching(&store);

        for n in 0..10 {
            fs::write(dir.mods().join("burst.css"), format!("a{{ order: {n} }}")).expect("write");
        }
        let mut last = next(&heard);
        while let Ok(more) = heard.recv_timeout(QUIET_FOR) {
            last = more;
        }
        assert_eq!(last, [file("burst.css", "a{ order: 9 }")]);
    }

    #[test]
    fn watch_ignores_other_files_in_the_config_folder_and_names_that_are_not_mods() {
        let dir = TempDir::new("watch-other");
        let store = ModStore::new(dir.mods());
        let (_watcher, heard) = watching(&store);

        // What the app itself writes next to the folder, and files that are not mods in it.
        fs::write(dir.0.join("state.json"), "{}").expect("write another file");
        fs::write(dir.0.join("config.jsonc"), "{}").expect("write the config");
        fs::write(dir.mods().join("notes.txt"), "not a mod").expect("write a text file");
        assert!(heard.recv_timeout(QUIET_FOR).is_err());
    }

    #[test]
    fn watch_goes_on_when_the_folder_is_deleted_and_made_again() {
        let dir = TempDir::new("watch-recreate");
        let store = ModStore::new(dir.mods());
        fs::create_dir_all(dir.mods()).expect("folder");
        fs::write(dir.mods().join("first.css"), "a{}").expect("write");
        let (_watcher, heard) = watching(&store);

        fs::remove_dir_all(dir.mods()).expect("delete the folder");
        assert_eq!(next(&heard), Vec::new());
        thread::sleep(QUIET_FOR);
        while heard.try_recv().is_ok() {}

        fs::create_dir_all(dir.mods()).expect("make the folder again");
        fs::write(dir.mods().join("second.css"), "b{}").expect("write again");
        assert_eq!(next(&heard), [file("second.css", "b{}")]);
    }

    #[test]
    fn dropping_the_watcher_stops_the_reports() {
        let dir = TempDir::new("watch-drop");
        let store = ModStore::new(dir.mods());
        let (watcher, heard) = watching(&store);
        fs::write(dir.mods().join("before.css"), "a{}").expect("write");
        assert_eq!(next(&heard), [file("before.css", "a{}")]);
        // Let the late events of that write drain, or they would make the thread list the next one.
        thread::sleep(QUIET_FOR);

        drop(watcher);
        fs::write(dir.mods().join("after.css"), "b{}").expect("write after");
        // The sender went away with the thread: nothing more arrives, and the channel closes.
        assert!(heard.recv_timeout(QUIET_FOR).is_err());
    }
}

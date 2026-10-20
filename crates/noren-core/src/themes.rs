//! The themes of the user, without any Tauri dependency: the folder `themes/` next to
//! `config.jsonc`, one JSON file per theme (`themes/<id>.json`).
//!
//! Like the other stores this one keeps text and does not know the schema of a theme (the
//! interface owns it). It does two things so the folder stays safe to read and to write:
//!
//! - **Saving** takes the id of the theme and turns it into the file name, so the id must be a
//!   theme id (lower case words joined by single hyphens, the same rule as the schema): anything
//!   else, a path included, is refused before anything is written. The write is atomic, through the
//!   same temporary-file-and-rename path as `state.json` and `config.jsonc`.
//! - **Listing** reads the text of every file that can be a theme and leaves out the rest: files
//!   whose name is not `<id>.json`, folders, a leftover temporary file, a file that is not UTF-8
//!   text, is empty, is not shaped like a JSON object, or is larger than [`MAX_THEME_BYTES`]. A
//!   file that survives this and is still not a valid theme is left out by the interface, which
//!   validates it against the schema.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::mods::is_reserved_name;
use crate::store::{StoreError, write_atomic};

/// Name of the folder inside the config folder of the app.
pub const THEMES_DIR_NAME: &str = "themes";

/// The largest theme file read or written. A theme is about 1 KiB of JSON; this only stops a file
/// that is not a theme from being read whole.
pub const MAX_THEME_BYTES: u64 = 256 * 1024;

/// The longest theme id (it is a file name).
const MAX_ID_LEN: usize = 64;

const EXTENSION: &str = ".json";

/// Errors returned by [`ThemeStore`].
#[derive(Debug)]
pub enum ThemeError {
    /// The id is not a theme id, so it cannot be a file name.
    InvalidId(String),
    /// The text is larger than [`MAX_THEME_BYTES`].
    TooLarge(usize),
    /// The folder could not be read.
    Read(io::Error),
    /// The file could not be written (see [`StoreError`] for the step).
    Write(StoreError),
}

impl fmt::Display for ThemeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId(id) => write!(f, "'{id}' is not a valid theme id"),
            Self::TooLarge(size) => write!(
                f,
                "the theme is {size} bytes; a theme file is at most {MAX_THEME_BYTES}"
            ),
            Self::Read(source) => write!(f, "could not read the themes folder: {source}"),
            Self::Write(source) => write!(f, "could not write the theme file: {source}"),
        }
    }
}

impl std::error::Error for ThemeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(source) => Some(source),
            Self::Write(source) => Some(source),
            _ => None,
        }
    }
}

/// Whether `id` is a theme id: lower case letters and digits, in words joined by single hyphens,
/// at most 64 characters, and not a device name Windows reserves (`con.json` is the console there).
pub fn is_valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && !is_reserved_name(id)
        && id.split('-').all(|word| {
            !word.is_empty()
                && word
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// The text of a file when it can be a theme: UTF-8, not empty, shaped like a JSON object.
fn theme_text(bytes: Vec<u8>) -> Option<String> {
    let text = String::from_utf8(bytes).ok()?;
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text).trim();
    (body.starts_with('{') && body.ends_with('}')).then_some(text)
}

/// The folder of the themes of the user. Reads and writes of the same store never run at the same time.
#[derive(Debug)]
pub struct ThemeStore {
    dir: PathBuf,
    busy: Mutex<()>,
}

impl ThemeStore {
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

    /// The text of every file that can be a theme (see the top of this file), in the order of the
    /// file names. A folder that does not exist is no files. The folder is never created here.
    pub fn list(&self) -> Result<Vec<String>, ThemeError> {
        let _guard = self.lock();
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(ThemeError::Read(error)),
        };
        let mut found: Vec<(String, String)> = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(id) = name.strip_suffix(EXTENSION) else {
                continue;
            };
            if !is_valid_theme_id(id) {
                continue;
            }
            // `metadata` follows a link, so a link to a folder is not a file either.
            let Ok(metadata) = fs::metadata(entry.path()) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_THEME_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            if let Some(text) = theme_text(bytes) {
                found.push((name, text));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(found.into_iter().map(|(_, text)| text).collect())
    }

    /// Replaces `<id>.json` with `text` atomically, exactly as given. Creates the folder when it is
    /// missing. Refuses an id that is not a theme id and a text over [`MAX_THEME_BYTES`], writing nothing.
    pub fn save(&self, id: &str, text: &str) -> Result<(), ThemeError> {
        if !is_valid_theme_id(id) {
            return Err(ThemeError::InvalidId(id.to_owned()));
        }
        if text.len() as u64 > MAX_THEME_BYTES {
            return Err(ThemeError::TooLarge(text.len()));
        }
        let _guard = self.lock();
        write_atomic(&self.dir.join(format!("{id}{EXTENSION}")), text.as_bytes())
            .map_err(ThemeError::Write)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
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
                "noren-themes-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        /// The `themes` folder inside, which does not exist until something is saved.
        fn themes(&self) -> PathBuf {
            self.0.join(THEMES_DIR_NAME)
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

    #[test]
    fn a_folder_that_does_not_exist_has_no_themes_and_is_not_created() {
        let dir = TempDir::new("missing");
        let store = ThemeStore::new(dir.themes());
        assert_eq!(store.list().expect("list"), Vec::<String>::new());
        assert!(!dir.themes().exists());
    }

    #[test]
    fn save_creates_the_folder_and_the_file_and_list_reads_it_back_as_given() {
        let dir = TempDir::new("round-trip");
        let store = ThemeStore::new(dir.themes());
        let text = "{\n  \"id\": \"lagoon\",\r\n  \"name\": \"Lagoon \u{e9}\"\n}\n";
        store.save("lagoon", text).expect("save");
        assert_eq!(dir.names(&dir.themes()), ["lagoon.json"]);
        assert_eq!(
            fs::read_to_string(dir.themes().join("lagoon.json")).expect("read"),
            text
        );
        assert_eq!(store.list().expect("list"), [text]);
    }

    #[test]
    fn saving_the_same_id_again_replaces_the_file_and_leaves_no_temporary_file() {
        let dir = TempDir::new("replace");
        let store = ThemeStore::new(dir.themes());
        store
            .save("lagoon", "{\"v\": 1, \"long\": true}")
            .expect("first");
        store.save("lagoon", "{\"v\": 2}").expect("second");
        assert_eq!(store.list().expect("list"), ["{\"v\": 2}"]);
        assert_eq!(dir.names(&dir.themes()), ["lagoon.json"]);
    }

    #[test]
    fn list_gives_the_files_in_the_order_of_their_names() {
        let dir = TempDir::new("order");
        let store = ThemeStore::new(dir.themes());
        for id in ["zeta", "alpha", "mid-2", "mid"] {
            store
                .save(id, &format!("{{\"id\": \"{id}\"}}"))
                .expect("save");
        }
        let ids: Vec<String> = store
            .list()
            .expect("list")
            .iter()
            .map(|text| text.replace("{\"id\": \"", "").replace("\"}", ""))
            .collect();
        // File names compare as "alpha.json", "mid-2.json", "mid.json", "zeta.json".
        assert_eq!(ids, ["alpha", "mid-2", "mid", "zeta"]);
    }

    #[test]
    fn list_leaves_out_what_cannot_be_a_theme() {
        let dir = TempDir::new("invalid");
        let folder = dir.themes();
        fs::create_dir_all(&folder).expect("folder");
        let put = |name: &str, bytes: &[u8]| fs::write(folder.join(name), bytes).expect("write");
        put("good.json", b"{\"id\": \"good\"}");
        put("with-bom.json", "\u{feff}{\"id\": \"with-bom\"}".as_bytes());
        // Not shaped like an object.
        put("array.json", b"[1, 2]");
        put("text.json", b"just words");
        put("empty.json", b"");
        put("cut.json", b"{\"id\": \"cut\"");
        // Not UTF-8.
        put("binary.json", &[b'{', 0xff, 0xfe, b'}']);
        // The name is not `<id>.json`.
        put("Upper.json", b"{}");
        put("has space.json", b"{}");
        put("notes.txt", b"{}");
        put("good.json.bak", b"{}");
        put("good.json.4242-0.tmp", b"{\"id\": \"half\"");
        put(".json", b"{}");
        // A folder with a good name.
        fs::create_dir_all(folder.join("folder.json")).expect("subfolder");
        // Too large.
        let mut big = b"{\"pad\": \"".to_vec();
        big.resize(usize::try_from(MAX_THEME_BYTES).expect("size") + 10, b'x');
        big.extend_from_slice(b"\"}");
        put("big.json", &big);

        let store = ThemeStore::new(&folder);
        assert_eq!(
            store.list().expect("list"),
            ["{\"id\": \"good\"}", "\u{feff}{\"id\": \"with-bom\"}"]
        );
    }

    #[test]
    fn save_refuses_an_id_that_is_not_a_theme_id_and_writes_nothing() {
        let dir = TempDir::new("bad-id");
        let store = ThemeStore::new(dir.themes());
        for id in [
            "",
            "../escape",
            "a/b",
            "a\\b",
            "..",
            "A",
            "a b",
            "-a",
            "a-",
            "a--b",
            "a.json",
            "caf\u{e9}",
            &"a".repeat(65),
        ] {
            assert!(
                matches!(store.save(id, "{}"), Err(ThemeError::InvalidId(_))),
                "{id:?} should be refused"
            );
        }
        assert!(!dir.themes().exists());
        assert_eq!(dir.names(&dir.0), Vec::<String>::new());
    }

    #[test]
    fn save_refuses_a_text_over_the_limit() {
        let dir = TempDir::new("too-large");
        let store = ThemeStore::new(dir.themes());
        let text = format!("{{\"pad\": \"{}\"}}", "x".repeat(300 * 1024));
        assert!(matches!(
            store.save("big", &text),
            Err(ThemeError::TooLarge(_))
        ));
        assert!(!dir.themes().exists());
    }

    #[test]
    fn save_fails_with_a_message_when_the_folder_is_a_file() {
        let dir = TempDir::new("in-the-way");
        fs::write(dir.themes(), b"a file where the folder should be").expect("write");
        let store = ThemeStore::new(dir.themes());
        let error = store.save("lagoon", "{}").expect_err("must fail");
        assert!(matches!(error, ThemeError::Write(_)));
        assert!(
            error
                .to_string()
                .starts_with("could not write the theme file")
        );
    }

    #[test]
    fn theme_ids_are_words_of_lower_case_letters_and_digits_joined_by_hyphens() {
        for id in ["a", "noren-dusk", "a1-b2-c3", "7", &"a".repeat(64)] {
            assert!(is_valid_theme_id(id), "{id:?} should be valid");
        }
        for id in [
            "", "-", "a-", "-a", "a--b", "Ab", "a_b", "a b", "a.b", "a/b",
        ] {
            assert!(!is_valid_theme_id(id), "{id:?} should be invalid");
        }
    }

    #[test]
    fn a_device_name_of_windows_is_not_a_theme_id() {
        for id in ["con", "prn", "aux", "nul", "com1", "lpt9"] {
            assert!(!is_valid_theme_id(id), "{id:?} should be invalid");
        }
        // Only the whole name is a device: these are ordinary files.
        for id in ["con-dark", "aux2", "com10", "my-nul", "console"] {
            assert!(is_valid_theme_id(id), "{id:?} should be valid");
        }
    }
}

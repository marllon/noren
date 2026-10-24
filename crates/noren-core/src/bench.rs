//! The results of the bench of local models, without any Tauri dependency: the folder
//! `bench-results/` in the data folder of the app, one JSON file per run
//! (`<YYYY-MM-DD-HHmmss>.json`, named from the time the run started, in UTC).
//!
//! Like the other stores this one keeps text and does not know the schema of a run (the interface
//! owns it, `benchRunSchema`). It does three things so the folder stays safe to read and to write:
//!
//! - **Naming.** The name of a file is never given by the caller. [`BenchStore::save`] takes the
//!   text of the run and builds the name from its `startedAt`, which must be an ISO 8601 time in
//!   UTC; [`BenchStore::save_stamped`] takes the stamp itself. Either way the stamp has to be
//!   exactly `YYYY-MM-DD-HHmmss` (digits and hyphens, a real month, day and time), so a slash,
//!   `..`, a drive, an absolute path or any other shape is refused before anything is written. A
//!   second run that starts in the same second is written as `<stamp>-2.json`, then `-3`, and
//!   never replaces a file. The write is atomic, through the same temporary-file-and-rename path
//!   as `state.json`.
//! - **Listing.** The runs come newest first. Only files named exactly like the ones this module
//!   writes are read; folders, links to folders, leftover temporary files, a file that is not UTF-8
//!   text, is not shaped like a JSON object or is larger than [`MAX_BENCH_BYTES`] are left out, and
//!   at most [`MAX_BENCH_RESULTS`] are returned. A file that survives this and is still not a valid
//!   run is left out by the interface, which validates it against the schema.
//! - **Staying inside.** The path is always the folder joined with a name that passed the check
//!   above, so it cannot leave the folder.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::store::{StoreError, write_atomic};

/// Name of the folder inside the data folder of the app.
pub const BENCH_DIR_NAME: &str = "bench-results";

/// The largest result file read or written. A run of the 60 tasks is about 30 KiB of JSON; this only
/// stops a file that is not a result from being read whole.
pub const MAX_BENCH_BYTES: u64 = 1024 * 1024;

/// The most results [`BenchStore::list`] returns (the newest).
pub const MAX_BENCH_RESULTS: usize = 100;

/// The highest suffix a file of the same second gets. Past it, saving is refused.
const MAX_SUFFIX: u32 = 999;

const EXTENSION: &str = ".json";

/// `YYYY-MM-DD-HHmmss`.
const STAMP_LEN: usize = 17;

/// Errors returned by [`BenchStore`].
#[derive(Debug)]
pub enum BenchError {
    /// The stamp is not `YYYY-MM-DD-HHmmss` with a real date and time, so it cannot be a file name.
    InvalidStamp(String),
    /// The text is not the JSON of a run that tells when it started; the reason says what is wrong.
    InvalidRun(String),
    /// The text is larger than [`MAX_BENCH_BYTES`].
    TooLarge(usize),
    /// [`MAX_SUFFIX`] files already hold that second.
    TooMany(String),
    /// The folder could not be read.
    Read(io::Error),
    /// The file could not be written (see [`StoreError`] for the step).
    Write(StoreError),
}

impl fmt::Display for BenchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidStamp(stamp) => {
                write!(
                    f,
                    "'{stamp}' is not a bench result stamp (YYYY-MM-DD-HHmmss)"
                )
            }
            Self::InvalidRun(reason) => write!(f, "the bench result is not a run: {reason}"),
            Self::TooLarge(size) => write!(
                f,
                "the bench result is {size} bytes; a result file is at most {MAX_BENCH_BYTES}"
            ),
            Self::TooMany(stamp) => write!(
                f,
                "there are already {MAX_SUFFIX} bench results from the second {stamp}"
            ),
            Self::Read(source) => write!(f, "could not read the bench results folder: {source}"),
            Self::Write(source) => write!(f, "could not write the bench result: {source}"),
        }
    }
}

impl std::error::Error for BenchError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(source) => Some(source),
            Self::Write(source) => Some(source),
            _ => None,
        }
    }
}

/// One result file as the interface sees it: its name and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BenchFile {
    pub name: String,
    pub text: String,
}

/// The number written at `bytes[start..start + len]`, for bytes already known to be digits.
fn digits(bytes: &[u8], start: usize, len: usize) -> u32 {
    bytes[start..start + len]
        .iter()
        .fold(0, |n, b| n * 10 + u32::from(b - b'0'))
}

/// Whether `stamp` is `YYYY-MM-DD-HHmmss`: digits and hyphens in exactly those places, with a month
/// from 1 to 12, a day from 1 to 31, an hour up to 23, and minutes and seconds up to 59.
pub fn is_valid_bench_stamp(stamp: &str) -> bool {
    let bytes = stamp.as_bytes();
    if bytes.len() != STAMP_LEN {
        return false;
    }
    let shaped = bytes.iter().enumerate().all(|(i, b)| match i {
        4 | 7 | 10 => *b == b'-',
        _ => b.is_ascii_digit(),
    });
    shaped
        && (1..=12).contains(&digits(bytes, 5, 2))
        && (1..=31).contains(&digits(bytes, 8, 2))
        && digits(bytes, 11, 2) < 24
        && digits(bytes, 13, 2) < 60
        && digits(bytes, 15, 2) < 60
}

/// The file name of the result of `stamp` that is number `n` in its second: `<stamp>.json` for the
/// first, `<stamp>-2.json` for the second one.
fn bench_file_name(stamp: &str, n: u32) -> String {
    if n <= 1 {
        format!("{stamp}{EXTENSION}")
    } else {
        format!("{stamp}-{n}{EXTENSION}")
    }
}

/// Reads a file name written by this module: the stamp and the number in its second (1 for no
/// suffix). Anything else, a name this module would never write, is `None`.
fn parse_bench_file_name(name: &str) -> Option<(&str, u32)> {
    let base = name.strip_suffix(EXTENSION)?;
    let stamp = base.get(..STAMP_LEN)?;
    if !is_valid_bench_stamp(stamp) {
        return None;
    }
    match &base[STAMP_LEN..] {
        "" => Some((stamp, 1)),
        suffix => {
            let number = suffix.strip_prefix('-')?;
            let canonical = number.bytes().all(|b| b.is_ascii_digit())
                && !number.starts_with('0')
                && number.len() <= 3;
            let n: u32 = number.parse().ok().filter(|_| canonical)?;
            (2..=MAX_SUFFIX).contains(&n).then_some((stamp, n))
        }
    }
}

/// The stamp of a time `startedAt` written the way `Date.toISOString` writes it:
/// `YYYY-MM-DDTHH:mm:ss`, an optional fraction of a second, and `Z`. Any other form, an offset
/// included, is `None`.
fn stamp_of_started_at(started_at: &str) -> Option<String> {
    let bytes = started_at.as_bytes();
    let shaped = bytes.len() >= 20
        && bytes.iter().take(19).enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            _ => b.is_ascii_digit(),
        });
    if !shaped {
        return None;
    }
    let rest = &bytes[19..];
    let zone_ok = match rest {
        [b'Z'] => true,
        [b'.', fraction @ .., b'Z'] => {
            !fraction.is_empty() && fraction.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    };
    if !zone_ok {
        return None;
    }
    let stamp = format!(
        "{}-{}{}{}",
        &started_at[..10],
        &started_at[11..13],
        &started_at[14..16],
        &started_at[17..19]
    );
    is_valid_bench_stamp(&stamp).then_some(stamp)
}

/// The stamp of the run in `text`: the JSON must be an object with a `startedAt` time.
fn stamp_of_run(text: &str) -> Result<String, BenchError> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| BenchError::InvalidRun(format!("not JSON ({e})")))?;
    let started_at = value
        .as_object()
        .ok_or_else(|| BenchError::InvalidRun("not a JSON object".to_owned()))?
        .get("startedAt")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| BenchError::InvalidRun("no startedAt time".to_owned()))?;
    stamp_of_started_at(started_at).ok_or_else(|| {
        BenchError::InvalidRun("startedAt is not an ISO 8601 time in UTC".to_owned())
    })
}

/// The text of a file when it can be a result: UTF-8, shaped like a JSON object.
fn bench_text(bytes: Vec<u8>) -> Option<String> {
    let text = String::from_utf8(bytes).ok()?;
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text).trim();
    (body.starts_with('{') && body.ends_with('}')).then_some(text)
}

/// The folder of the bench results. Reads and writes of the same store never run at the same time.
#[derive(Debug)]
pub struct BenchStore {
    dir: PathBuf,
    busy: Mutex<()>,
}

impl BenchStore {
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

    /// Writes the run in `text` as `<stamp>.json`, the stamp taken from its `startedAt`, and
    /// returns the name of the file (see [`BenchStore::save_stamped`]). Refuses text that is not a
    /// JSON object with a `startedAt` time in UTC, writing nothing.
    pub fn save(&self, text: &str) -> Result<String, BenchError> {
        if text.len() as u64 > MAX_BENCH_BYTES {
            return Err(BenchError::TooLarge(text.len()));
        }
        let stamp = stamp_of_run(text)?;
        self.save_stamped(&stamp, text)
    }

    /// Writes `text`, exactly as given, as `<stamp>.json` atomically, or as `<stamp>-2.json`,
    /// `-3`, ... when that second already has a file: no file is ever replaced. Creates the folder
    /// when it is missing and returns the name of the file written. Refuses a stamp that is not
    /// `YYYY-MM-DD-HHmmss` and a text over [`MAX_BENCH_BYTES`], writing nothing.
    pub fn save_stamped(&self, stamp: &str, text: &str) -> Result<String, BenchError> {
        if !is_valid_bench_stamp(stamp) {
            return Err(BenchError::InvalidStamp(stamp.to_owned()));
        }
        if text.len() as u64 > MAX_BENCH_BYTES {
            return Err(BenchError::TooLarge(text.len()));
        }
        let _guard = self.lock();
        for n in 1..=MAX_SUFFIX {
            let name = bench_file_name(stamp, n);
            let path = self.dir.join(&name);
            // `symlink_metadata` also sees a link that points nowhere: a name taken is a name taken.
            match fs::symlink_metadata(&path) {
                Ok(_) => continue,
                // A path under a file is "not a directory" on Unix and "not found" on Windows:
                // either way the name is free, and the write below says what is wrong.
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) => {}
                Err(error) => return Err(BenchError::Read(error)),
            }
            write_atomic(&path, text.as_bytes()).map_err(BenchError::Write)?;
            return Ok(name);
        }
        Err(BenchError::TooMany(stamp.to_owned()))
    }

    /// The results in the folder, newest first (by stamp, then by the number in the second), at most
    /// [`MAX_BENCH_RESULTS`] (see the top of this file for what is left out). A folder that does not
    /// exist is no files. The folder is never created here.
    pub fn list(&self) -> Result<Vec<BenchFile>, BenchError> {
        let _guard = self.lock();
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(BenchError::Read(error)),
        };
        let mut names: Vec<(String, u32, String)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_str()?.to_owned();
                let (stamp, n) = parse_bench_file_name(&name)?;
                Some((stamp.to_owned(), n, name))
            })
            .collect();
        names.sort_by(|a, b| (&b.0, b.1).cmp(&(&a.0, a.1)));
        let mut found = Vec::new();
        for (_, _, name) in names {
            if found.len() >= MAX_BENCH_RESULTS {
                break;
            }
            let path = self.dir.join(&name);
            // `metadata` follows a link, so a link to a folder is not a file either.
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_BENCH_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            if let Some(text) = bench_text(bytes) {
                found.push(BenchFile { name, text });
            }
        }
        Ok(found)
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
                "noren-bench-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        /// The `bench-results` folder inside, which does not exist until something is saved.
        fn results(&self) -> PathBuf {
            self.0.join(BENCH_DIR_NAME)
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

    /// The JSON of a run that started at `started_at`, with a marker so files can be told apart.
    fn run(started_at: &str, marker: &str) -> String {
        format!("{{\"startedAt\":\"{started_at}\",\"marker\":\"{marker}\"}}")
    }

    fn names_of(files: &[BenchFile]) -> Vec<&str> {
        files.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn a_folder_that_does_not_exist_has_no_results_and_is_not_created() {
        let dir = TempDir::new("missing");
        let store = BenchStore::new(dir.results());
        assert_eq!(store.list().expect("list"), Vec::new());
        assert!(!dir.results().exists());
    }

    #[test]
    fn save_names_the_file_from_the_start_time_and_list_reads_it_back_as_given() {
        let dir = TempDir::new("round-trip");
        let store = BenchStore::new(dir.results());
        let text = String::from(
            "{\n  \"startedAt\": \"2026-10-20T14:05:09.123Z\",\r\n  \"model\": \"caf\u{e9}\"\n}\n",
        );
        let name = store.save(&text).expect("save");
        assert_eq!(name, "2026-10-20-140509.json");
        assert_eq!(dir.names(&dir.results()), ["2026-10-20-140509.json"]);
        assert_eq!(
            fs::read_to_string(dir.results().join(&name)).expect("read"),
            text
        );
        assert_eq!(
            store.list().expect("list"),
            [BenchFile {
                name,
                text: text.clone()
            }]
        );
    }

    #[test]
    fn a_start_time_with_no_fraction_names_the_file_too() {
        let dir = TempDir::new("no-fraction");
        let store = BenchStore::new(dir.results());
        let name = store.save(&run("2026-01-02T03:04:05Z", "a")).expect("save");
        assert_eq!(name, "2026-01-02-030405.json");
    }

    #[test]
    fn the_same_second_gets_a_suffix_and_never_overwrites() {
        let dir = TempDir::new("collision");
        let store = BenchStore::new(dir.results());
        let started = "2026-10-20T14:05:09.000Z";
        let first = store.save(&run(started, "first")).expect("first");
        let second = store.save(&run(started, "second")).expect("second");
        let third = store.save(&run(started, "third")).expect("third");
        assert_eq!(first, "2026-10-20-140509.json");
        assert_eq!(second, "2026-10-20-140509-2.json");
        assert_eq!(third, "2026-10-20-140509-3.json");
        for (name, marker) in [(&first, "first"), (&second, "second"), (&third, "third")] {
            let text = fs::read_to_string(dir.results().join(name)).expect("read");
            assert!(text.contains(marker), "{name}: {text}");
        }
        // No temporary file is left behind.
        assert_eq!(dir.names(&dir.results()).len(), 3);
    }

    #[test]
    fn a_suffix_is_not_reused_after_a_gap() {
        let dir = TempDir::new("gap");
        let store = BenchStore::new(dir.results());
        let started = "2026-10-20T14:05:09.000Z";
        store.save(&run(started, "a")).expect("a");
        store.save(&run(started, "b")).expect("b");
        // Somebody deleted the first: the freed name is taken again, and -2 is still there.
        fs::remove_file(dir.results().join("2026-10-20-140509.json")).expect("remove");
        assert_eq!(
            store.save(&run(started, "c")).expect("c"),
            "2026-10-20-140509.json"
        );
        assert_eq!(
            store.save(&run(started, "d")).expect("d"),
            "2026-10-20-140509-3.json"
        );
    }

    #[test]
    fn list_gives_the_newest_first_and_a_suffix_after_the_file_it_follows() {
        let dir = TempDir::new("order");
        let store = BenchStore::new(dir.results());
        for started in [
            "2026-10-20T14:05:09Z",
            "2025-12-31T23:59:59Z",
            "2026-10-20T14:05:09Z",
            "2026-10-21T00:00:00Z",
            "2026-10-20T14:05:09Z",
        ] {
            store.save(&run(started, started)).expect("save");
        }
        let files = store.list().expect("list");
        assert_eq!(
            names_of(&files),
            [
                "2026-10-21-000000.json",
                "2026-10-20-140509-3.json",
                "2026-10-20-140509-2.json",
                "2026-10-20-140509.json",
                "2025-12-31-235959.json",
            ]
        );
    }

    #[test]
    fn a_start_time_that_is_not_a_utc_time_writes_nothing() {
        let dir = TempDir::new("bad-time");
        let store = BenchStore::new(dir.results());
        for started in [
            "",
            "yesterday",
            "2026-10-20",
            "2026-10-20T14:05:09",
            "2026-10-20T14:05:09+02:00",
            "2026-10-20T14:05:09.Z",
            "2026-13-20T14:05:09Z",
            "2026-10-32T14:05:09Z",
            "2026-10-20T24:05:09Z",
            "2026-10-20T14:60:09Z",
            "2026-10-20T14:05:60Z",
            "../../2026-10-20T14:05:09Z",
            "2026-10-20T14:05:09Z/../x",
            "\u{661}026-10-20T14:05:09Z",
        ] {
            assert!(
                matches!(
                    store.save(&run(started, "x")),
                    Err(BenchError::InvalidRun(_))
                ),
                "{started:?}"
            );
        }
        assert!(!dir.results().exists(), "a refused save created the folder");
    }

    #[test]
    fn text_that_is_not_the_json_of_a_run_writes_nothing() {
        let dir = TempDir::new("bad-text");
        let store = BenchStore::new(dir.results());
        for text in [
            "",
            "not json",
            "[]",
            "\"2026-10-20T14:05:09Z\"",
            "{}",
            "{\"startedAt\": 5}",
            "{\"startedAt\": null}",
        ] {
            assert!(
                matches!(store.save(text), Err(BenchError::InvalidRun(_))),
                "{text:?}"
            );
        }
        assert!(!dir.results().exists());
    }

    #[test]
    fn a_stamp_that_names_a_path_or_another_shape_is_refused_and_nothing_is_written() {
        let dir = TempDir::new("hostile");
        let store = BenchStore::new(dir.results());
        for stamp in [
            "",
            "..",
            "../escape",
            "..\\escape",
            "../../2026-10-20-14050",
            "2026-10-20-140509/../x",
            "/2026-10-20-140509",
            "C:\\2026-10-20-14",
            "C:/2026-10-20-140509",
            "2026-10-20-140509.json",
            "2026-10-20-140509-2",
            "2026-10-20-14050",
            "2026-10-20T140509",
            "2026-10-20-1405090",
            "26-10-20-14050999",
            "2026-13-20-140509",
            "2026-00-20-140509",
            "2026-10-00-140509",
            "2026-10-20-240000",
            "2026-10-20-146000",
            "2026-10-20-140560",
            "2026-10-20-14050\u{e9}",
            "2026-10-20-140509\n",
            "con",
        ] {
            assert!(
                matches!(
                    store.save_stamped(stamp, "{}"),
                    Err(BenchError::InvalidStamp(_))
                ),
                "{stamp:?}"
            );
        }
        assert!(!dir.results().exists());
        assert!(
            !dir.0.join("escape.json").exists() && !dir.0.join("x").exists(),
            "something was written outside the folder"
        );
    }

    #[test]
    fn a_text_over_the_ceiling_is_refused_and_one_at_the_ceiling_is_written() {
        let dir = TempDir::new("big-save");
        let store = BenchStore::new(dir.results());
        let head = "{\"startedAt\":\"2026-10-20T14:05:09Z\",\"pad\":\"";
        let tail = "\"}";
        let fill = |total: usize| {
            format!(
                "{head}{}{tail}",
                "a".repeat(total - head.len() - tail.len())
            )
        };
        let over = fill(MAX_BENCH_BYTES as usize + 1);
        assert!(matches!(store.save(&over), Err(BenchError::TooLarge(_))));
        assert!(!dir.results().exists());
        let exact = fill(MAX_BENCH_BYTES as usize);
        store.save(&exact).expect("at the ceiling");
        assert_eq!(store.list().expect("list").len(), 1);
    }

    #[test]
    fn list_leaves_out_what_this_module_would_not_have_written() {
        let dir = TempDir::new("skips");
        let results = dir.results();
        fs::create_dir_all(&results).expect("folder");
        let good = run("2026-10-20T14:05:09Z", "good");
        fs::write(results.join("2026-10-20-140509.json"), &good).expect("good");
        // The name is not one this module writes.
        for name in [
            "notes.json",
            "2026-10-20-140509.txt",
            "2026-10-20-140509.json.tmp",
            "2026-10-20-140509-1.json",
            "2026-10-20-140509-02.json",
            "2026-10-20-140509-0.json",
            "2026-10-20-140509-x.json",
            "2026-10-20-140509-1000.json",
            "2026-13-20-140509.json",
            ".2026-10-20-140509.json.1-1.tmp",
            "2026-10-20-140509.JSON",
        ] {
            fs::write(results.join(name), &good).expect("write");
        }
        // The name is right, the file is not.
        fs::create_dir(results.join("2026-10-20-140510.json")).expect("a folder named like a file");
        fs::write(
            results.join("2026-10-20-140511.json"),
            [0xff, 0xfe, 0x7b, 0x7d],
        )
        .expect("bytes");
        fs::write(results.join("2026-10-20-140512.json"), "").expect("empty");
        fs::write(results.join("2026-10-20-140513.json"), "[1]").expect("array");
        fs::write(
            results.join("2026-10-20-140514.json"),
            vec![b'{'; MAX_BENCH_BYTES as usize + 1],
        )
        .expect("large");
        let store = BenchStore::new(&results);
        let files = store.list().expect("list");
        assert_eq!(names_of(&files), ["2026-10-20-140509.json"]);
        assert_eq!(files[0].text, good);
    }

    #[test]
    fn list_returns_a_file_at_the_ceiling_and_skips_one_byte_over() {
        let dir = TempDir::new("ceiling");
        let results = dir.results();
        fs::create_dir_all(&results).expect("folder");
        let object = |size: usize| format!("{{{}}}", " ".repeat(size - 2));
        fs::write(
            results.join("2026-10-20-140509.json"),
            object(MAX_BENCH_BYTES as usize),
        )
        .expect("at the ceiling");
        fs::write(
            results.join("2026-10-20-140510.json"),
            object(MAX_BENCH_BYTES as usize + 1),
        )
        .expect("over");
        let files = BenchStore::new(&results).list().expect("list");
        assert_eq!(names_of(&files), ["2026-10-20-140509.json"]);
    }

    #[test]
    fn list_returns_at_most_the_newest_results_and_skips_do_not_count() {
        let dir = TempDir::new("cap");
        let results = dir.results();
        fs::create_dir_all(&results).expect("folder");
        for minute in 0..60 {
            for hour in [10, 11] {
                fs::write(
                    results.join(format!("2026-10-20-{hour:02}{minute:02}00.json")),
                    "{}",
                )
                .expect("write");
            }
        }
        // The newest names are not results at all; they must not use up the cap.
        fs::write(results.join("2026-10-20-235959.json"), "nope").expect("junk");
        let files = BenchStore::new(&results).list().expect("list");
        assert_eq!(files.len(), MAX_BENCH_RESULTS);
        assert_eq!(files[0].name, "2026-10-20-115900.json");
        assert_eq!(
            files[MAX_BENCH_RESULTS - 1].name,
            "2026-10-20-102000.json",
            "the oldest 20 were cut"
        );
    }

    #[test]
    fn a_file_where_the_folder_should_be_makes_the_save_fail_with_a_message() {
        let dir = TempDir::new("blocked");
        let blocked = dir.0.join("blocked");
        fs::write(&blocked, b"in the way").expect("write");
        let store = BenchStore::new(&blocked);
        let error = store
            .save(&run("2026-10-20T14:05:09Z", "x"))
            .expect_err("fails");
        assert!(error.to_string().starts_with("could not"), "{error}");
        // Listing a path that is a file is a read failure, not a panic or an empty list.
        assert!(matches!(store.list(), Err(BenchError::Read(_))));
    }

    #[test]
    fn the_names_this_module_writes_are_read_back_by_it() {
        for (stamp, n) in [
            ("2026-10-20-140509", 1),
            ("2026-10-20-140509", 2),
            ("2026-10-20-140509", 10),
            ("2026-10-20-140509", MAX_SUFFIX),
        ] {
            let name = bench_file_name(stamp, n);
            assert_eq!(parse_bench_file_name(&name), Some((stamp, n)), "{name}");
        }
    }
}

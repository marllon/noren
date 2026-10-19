//! Durable storage for the workspace state file, without any Tauri dependency.
//!
//! The store does not look at the content: it keeps bytes. Writes are atomic: the new content
//! goes to a temporary file in the same folder, is flushed to disk and then renamed over the
//! target, so a crash leaves either the old file or the new one, never a half-written file.
//! A temporary file left behind by an interrupted write is never read and never removed by
//! another write (it may belong to a write still in progress).
//!
//! A file the caller finds unusable is not deleted: [`StateStore::quarantine`] copies it byte
//! for byte to `<stem>.broken-<UTC date and time>.<ext>` next to it and leaves the original in
//! place, so the next successful save is what replaces it.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Distinguishes the temporary files of writes made by the same process.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Attempts to rename the temporary file over the target before giving up. On Windows the
/// rename can fail for a moment while another program (a scanner, an indexer) has the target open.
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(20);

/// Errors returned by [`StateStore`].
#[derive(Debug)]
pub enum StoreError {
    /// The file could not be read, written or copied.
    Io {
        action: &'static str,
        source: io::Error,
    },
    /// The path has no file name or its parent folder cannot be derived.
    InvalidPath(PathBuf),
    /// There is no file to quarantine.
    NothingToQuarantine,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { action, source } => write!(f, "could not {action}: {source}"),
            Self::InvalidPath(path) => {
                write!(f, "'{}' is not a valid file path", path.display())
            }
            Self::NothingToQuarantine => write!(f, "there is no state file to quarantine"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

fn io_error(action: &'static str) -> impl FnOnce(io::Error) -> StoreError {
    move |source| StoreError::Io { action, source }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One state file. Operations of the same store never run at the same time.
#[derive(Debug)]
pub struct StateStore {
    path: PathBuf,
    busy: Mutex<()>,
}

impl StateStore {
    /// A store for the file at `path`. Nothing is touched on disk until a method runs.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            busy: Mutex::new(()),
        }
    }

    /// Path of the state file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reads the file; `None` when it does not exist yet.
    pub fn load(&self) -> Result<Option<Vec<u8>>, StoreError> {
        let _guard = lock(&self.busy);
        read_file(&self.path)
    }

    /// Replaces the file with `content` atomically. Creates the folder when it is missing.
    pub fn save(&self, content: &[u8]) -> Result<(), StoreError> {
        let _guard = lock(&self.busy);
        write_atomic(&self.path, content)
    }

    /// Copies the file, byte for byte, to `<stem>.broken-<now>.<ext>` and returns the new path.
    /// The original stays where it is. An existing copy is never overwritten.
    pub fn quarantine(&self) -> Result<PathBuf, StoreError> {
        self.quarantine_at(SystemTime::now())
    }

    /// Same as [`StateStore::quarantine`] with an explicit time (for tests).
    pub fn quarantine_at(&self, now: SystemTime) -> Result<PathBuf, StoreError> {
        let _guard = lock(&self.busy);
        copy_to_quarantine(&self.path, now)
    }
}

/// Reads `path`; `None` when it does not exist.
pub fn read_file(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(StoreError::Io {
            action: "read the file",
            source: e,
        }),
    }
}

pub(crate) fn parent_and_name(path: &Path) -> Result<(PathBuf, &std::ffi::OsStr), StoreError> {
    let name = path
        .file_name()
        .ok_or_else(|| StoreError::InvalidPath(path.to_owned()))?;
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_owned(),
        _ => PathBuf::from("."),
    };
    Ok((parent, name))
}

/// Writes `content` to a new temporary file next to `path`, flushes it and renames it over `path`.
pub fn write_atomic(path: &Path, content: &[u8]) -> Result<(), StoreError> {
    let (parent, name) = parent_and_name(path)?;
    fs::create_dir_all(&parent).map_err(io_error("create the data folder"))?;

    let (temp_path, mut temp) = create_temp(&parent, name)?;
    let result = temp
        .write_all(content)
        .and_then(|()| temp.sync_all())
        .map_err(io_error("write the temporary file"))
        .and_then(|()| {
            drop(temp);
            rename_over(&temp_path, path).map_err(io_error("replace the file"))
        });
    if result.is_err() {
        // Only this write's own temporary file is removed.
        let _ = fs::remove_file(&temp_path);
    }
    result
}

/// Creates a temporary file with a name no other write (of this or another process) uses.
fn create_temp(parent: &Path, name: &std::ffi::OsStr) -> Result<(PathBuf, File), StoreError> {
    loop {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temp_name = name.to_owned();
        temp_name.push(format!(".{}-{n}.tmp", std::process::id()));
        let temp_path = parent.join(temp_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error("create the temporary file")(e)),
        }
    }
}

/// `fs::rename` replaces an existing destination on every platform we support (on Windows it
/// uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`). A brief permission error is retried.
fn rename_over(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && attempt < RENAME_ATTEMPTS => {
                attempt += 1;
                thread::sleep(RENAME_RETRY_DELAY);
            }
            Err(e) => return Err(e),
        }
    }
}

fn copy_to_quarantine(path: &Path, now: SystemTime) -> Result<PathBuf, StoreError> {
    let bytes = read_file(path)?.ok_or(StoreError::NothingToQuarantine)?;
    let (parent, name) = parent_and_name(path)?;
    let stamp = utc_stamp(now);

    let (stem, ext) = match Path::new(name).extension() {
        Some(ext) => (
            Path::new(name)
                .file_stem()
                .unwrap_or(name)
                .to_string_lossy()
                .into_owned(),
            format!(".{}", ext.to_string_lossy()),
        ),
        None => (name.to_string_lossy().into_owned(), String::new()),
    };

    for n in 0u32.. {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let target = parent.join(format!("{stem}.broken-{stamp}{suffix}{ext}"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(mut file) => {
                let written = file
                    .write_all(&bytes)
                    .and_then(|()| file.sync_all())
                    .map_err(io_error("write the quarantine copy"));
                if written.is_err() {
                    drop(file);
                    let _ = fs::remove_file(&target);
                }
                return written.map(|()| target);
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error("create the quarantine copy")(e)),
        }
    }
    unreachable!("the loop above only ends by returning")
}

/// `YYYYMMDDTHHMMSSZ` in UTC (no characters that are invalid in a Windows file name).
fn utc_stamp(time: SystemTime) -> String {
    let secs = match time.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX / 2),
        Err(_) => 0,
    };
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a (year, month, day) in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder under the system temp dir with a unique name, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-store-{label}-{}-{nanos}-{n}",
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

    fn at(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    #[test]
    fn missing_file_loads_as_none() {
        let dir = TempDir::new("missing");
        let store = StateStore::new(dir.file("state.json"));
        assert!(store.load().expect("load").is_none());
    }

    #[test]
    fn round_trip_keeps_every_byte() {
        let dir = TempDir::new("roundtrip");
        let store = StateStore::new(dir.file("state.json"));
        let content: Vec<u8> = (0..=255u8)
            .chain(*b"{\"version\":1} \xc3\xa9\r\n")
            .collect();
        store.save(&content).expect("save");
        assert_eq!(store.load().expect("load"), Some(content));
    }

    #[test]
    fn save_creates_the_missing_folder() {
        let dir = TempDir::new("mkdir");
        let store = StateStore::new(dir.file("a").join("b").join("state.json"));
        store.save(b"{}").expect("save");
        assert_eq!(store.load().expect("load"), Some(b"{}".to_vec()));
    }

    #[test]
    fn save_overwrites_and_leaves_no_temporary_file() {
        let dir = TempDir::new("overwrite");
        let store = StateStore::new(dir.file("state.json"));
        store.save(b"first, a longer content").expect("save 1");
        store.save(b"second").expect("save 2");
        assert_eq!(store.load().expect("load"), Some(b"second".to_vec()));
        assert_eq!(dir.names(), ["state.json"]);
    }

    #[test]
    fn abandoned_temporary_file_does_not_affect_the_read() {
        let dir = TempDir::new("abandoned");
        let store = StateStore::new(dir.file("state.json"));
        store.save(b"good").expect("save");
        // What an interrupted write leaves behind: a half-written temporary file.
        let stray = dir.file("state.json.99999-0.tmp");
        fs::write(&stray, b"{\"half\":").expect("write the stray file");

        assert_eq!(store.load().expect("load"), Some(b"good".to_vec()));
        store.save(b"newer").expect("save again");
        assert_eq!(store.load().expect("load"), Some(b"newer".to_vec()));
        // Another write's temporary file is not ours to remove.
        assert_eq!(fs::read(&stray).expect("stray file"), b"{\"half\":");
    }

    #[test]
    fn abandoned_temporary_file_alone_loads_as_none() {
        let dir = TempDir::new("abandoned-only");
        let store = StateStore::new(dir.file("state.json"));
        fs::write(dir.file("state.json.1-0.tmp"), b"partial").expect("write");
        assert!(store.load().expect("load").is_none());
    }

    #[test]
    fn quarantine_copies_byte_for_byte_and_keeps_the_original() {
        let dir = TempDir::new("quarantine");
        let store = StateStore::new(dir.file("state.json"));
        let corrupt: Vec<u8> = b"{\"version\": 1, \"spaces\": [\xff\xfe\x00 not json".to_vec();
        fs::write(store.path(), &corrupt).expect("write corrupt file");

        // 2026-10-18T17:38:05Z
        let copy = store.quarantine_at(at(1_792_345_085)).expect("quarantine");

        assert_eq!(
            copy.file_name().and_then(|n| n.to_str()),
            Some("state.broken-20261018T173805Z.json")
        );
        assert_eq!(fs::read(&copy).expect("copy"), corrupt);
        assert_eq!(fs::read(store.path()).expect("original"), corrupt);
        assert_eq!(
            dir.names(),
            ["state.broken-20261018T173805Z.json", "state.json"]
        );
    }

    #[test]
    fn corrupt_file_does_not_erase_the_previous_good_copy() {
        let dir = TempDir::new("keep-previous");
        let store = StateStore::new(dir.file("state.json"));
        store.save(b"good").expect("save");
        let first = store.quarantine_at(at(0)).expect("first quarantine");
        // Quarantining again in the same second must not overwrite the first copy.
        fs::write(store.path(), b"worse").expect("replace the original");
        let second = store.quarantine_at(at(0)).expect("second quarantine");

        assert_ne!(first, second);
        assert_eq!(fs::read(&first).expect("first copy"), b"good");
        assert_eq!(fs::read(&second).expect("second copy"), b"worse");
        assert_eq!(
            second.file_name().and_then(|n| n.to_str()),
            Some("state.broken-19700101T000000Z-1.json")
        );
    }

    #[test]
    fn quarantine_without_a_file_is_an_error() {
        let dir = TempDir::new("quarantine-none");
        let store = StateStore::new(dir.file("state.json"));
        assert!(matches!(
            store.quarantine(),
            Err(StoreError::NothingToQuarantine)
        ));
        assert!(dir.names().is_empty());
    }

    #[test]
    fn write_into_a_path_without_file_name_is_an_error() {
        let result = write_atomic(Path::new(".."), b"x");
        assert!(matches!(result, Err(StoreError::InvalidPath(_))));
    }

    #[test]
    fn utc_stamp_handles_known_dates() {
        assert_eq!(utc_stamp(at(0)), "19700101T000000Z");
        assert_eq!(utc_stamp(at(951_782_399)), "20000228T235959Z");
        // Leap day.
        assert_eq!(utc_stamp(at(951_782_400)), "20000229T000000Z");
        assert_eq!(utc_stamp(at(1_792_345_085)), "20261018T173805Z");
    }

    #[test]
    fn concurrent_saves_leave_one_complete_content() {
        let dir = TempDir::new("concurrent");
        let path = dir.file("state.json");
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let path = path.clone();
                thread::spawn(move || {
                    // Different stores on the same file: only the atomic rename protects them.
                    let store = StateStore::new(path);
                    for _ in 0..20 {
                        store.save(&vec![i; 4096]).expect("save");
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().expect("writer thread");
        }
        let content = StateStore::new(&path).load().expect("load").expect("file");
        assert_eq!(content.len(), 4096);
        assert!(content.iter().all(|b| *b == content[0]));
        assert_eq!(dir.names(), ["state.json"]);
    }
}

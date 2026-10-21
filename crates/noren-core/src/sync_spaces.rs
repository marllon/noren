//! The space files of the sync (NOR-F19-01c): `spaces/<name>.noren-space.json` in the config
//! folder, one per space, which the sync carries like any other allowed file (see [`crate::sync`]).
//! This module lists, reads and writes them and keeps the local record of which space each file
//! stands for. It never runs git: [`crate::sync::SyncRepo`] copies the files to and from the clone.
//!
//! What a file holds is the business of the interface (`exportSpace` and `parseSpaceFile` of
//! `@noren/model`); here it is text with a name and a size.
//!
//! - **Names** are checked by [`is_syncable`] as `spaces/<name>`: the closed list is the only way in,
//!   whatever the caller says, so a name with a folder in it, a dot in front, a reserved device name
//!   or another ending is refused. A batch with one refused name writes nothing.
//! - **Ceilings** are those of the sync: a file over [`MAX_SYNC_FILE_BYTES`] is refused (and left
//!   out of the listing), and more than [`MAX_SYNC_FILES`] space files are an error.
//! - **The record** is `sync-spaces.json` next to `config.jsonc`: for each file, the id of the
//!   space it was made from or became and the sha256 of its bytes at that moment. It is local to
//!   this computer (space ids mean nothing on another) and is not on the closed list, so it never
//!   reaches the clone or the remote. With it a pull tells a file it already holds (nothing to
//!   do), one that changed since (the linked space is made again from it) and one it has never
//!   seen (a new space), and a space exported by a push is not imported again by the next pull.
//!   A record that cannot be read is an error and not an empty record: an empty one would import
//!   every file a second time.
//! - **Nothing is deleted**, like the rest of the sync. A removed space leaves its file behind.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::gallery::sha256_hex;
use crate::sync::{
    MAX_SYNC_FILE_BYTES, MAX_SYNC_FILES, SPACES_DIR_NAME, SYNC_DIR_NAME, SyncError, is_syncable,
    write_bytes,
};

/// The record of which space each file stands for, in the config folder (not on the closed list).
pub const SPACE_LINKS_FILE_NAME: &str = "sync-spaces.json";

/// The version of the record this build writes and reads.
const LINKS_VERSION: u64 = 1;

/// The longest id of a space the record keeps, in characters.
const MAX_SPACE_ID_CHARS: usize = 200;

/// The most bytes the record may hold: 500 entries of a name, an id and a hash fit far inside it.
const MAX_LINKS_BYTES: u64 = 512 * 1024;

/// A file and the space it stands for, as the record last saw them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceLink {
    /// The id of the space (an id of the interface; this module only keeps it).
    pub space_id: String,
    /// The sha256 of the bytes of the file at that moment, 64 lower case hexadecimal digits.
    pub hash: String,
}

/// One space file in the config folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceFileInfo {
    /// The bare file name, `<name>.noren-space.json`.
    pub name: String,
    /// The sha256 of the bytes now, 64 lower case hexadecimal digits.
    pub hash: String,
    /// The space the record ties the file to, if it does.
    pub link: Option<SpaceLink>,
}

/// What the config folder holds of the spaces.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SpaceFolder {
    /// The space files of the config folder, in name order.
    pub files: Vec<SpaceFileInfo>,
    /// The names of the space files the clone of the sync holds (what the remote had when it was
    /// last pulled or pushed), in name order. A new file should not take one of these names.
    pub cloned: Vec<String>,
}

/// A file to write and the space it is made from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceFileWrite {
    pub name: String,
    pub text: String,
    pub space_id: String,
}

/// A file already in the folder and the space it now stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceFileLink {
    pub name: String,
    pub space_id: String,
}

/// The space files of one config folder.
#[derive(Debug, Clone)]
pub struct SpaceFiles {
    config_dir: PathBuf,
}

impl SpaceFiles {
    /// The space files in `config_dir`. Nothing is made on disk until a file is written.
    pub fn new(config_dir: impl Into<PathBuf>) -> Self {
        Self {
            config_dir: config_dir.into(),
        }
    }

    fn dir(&self) -> PathBuf {
        self.config_dir.join(SPACES_DIR_NAME)
    }

    fn links_path(&self) -> PathBuf {
        self.config_dir.join(SPACE_LINKS_FILE_NAME)
    }

    /// The space files in the folder with their hashes and links, and the names the clone holds.
    /// A file that is not a plain file, is over the ceiling or has a name off the list is not
    /// listed; more than [`MAX_SYNC_FILES`] files are an error.
    pub fn list(&self) -> Result<SpaceFolder, SyncError> {
        let links = self.load_links()?;
        let mut files = Vec::new();
        for name in plain_names(&self.dir())? {
            let path = self.dir().join(&name);
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.len() > MAX_SYNC_FILE_BYTES {
                continue;
            }
            let bytes = fs::read(&path).map_err(|e| SyncError::Io(e.to_string()))?;
            files.push(SpaceFileInfo {
                link: links.get(&name).cloned(),
                hash: sha256_hex(&bytes),
                name,
            });
        }
        let clone_spaces = self.config_dir.join(SYNC_DIR_NAME).join(SPACES_DIR_NAME);
        let cloned = plain_names(&clone_spaces).unwrap_or_default();
        Ok(SpaceFolder { files, cloned })
    }

    /// The text of one space file. A name off the list, a file that is missing or over the ceiling
    /// and bytes that are not UTF-8 are errors.
    pub fn read(&self, name: &str) -> Result<String, SyncError> {
        let path = self.checked_path(name)?;
        let meta = fs::symlink_metadata(&path).map_err(|e| SyncError::Io(e.to_string()))?;
        if !meta.is_file() {
            return Err(SyncError::Io(format!(
                "{SPACES_DIR_NAME}/{name} is not a file"
            )));
        }
        if meta.len() > MAX_SYNC_FILE_BYTES {
            return Err(SyncError::FileTooLarge(format!("{SPACES_DIR_NAME}/{name}")));
        }
        let bytes = fs::read(&path).map_err(|e| SyncError::Io(e.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|_| SyncError::Io(format!("{SPACES_DIR_NAME}/{name} is not UTF-8 text")))
    }

    /// Writes the files and ties each to its space in the record, with the hash of what was
    /// written. Every name, size and id is checked before the first byte is written, so a refusal
    /// leaves the folder as it was; a file that already holds the same bytes is not touched (its
    /// link is still recorded). Links of files that are gone from the folder are dropped.
    pub fn write(&self, files: &[SpaceFileWrite]) -> Result<(), SyncError> {
        let mut seen = BTreeSet::new();
        for file in files {
            self.checked_path(&file.name)?;
            check_space_id(&file.space_id)?;
            if file.text.len() as u64 > MAX_SYNC_FILE_BYTES {
                return Err(SyncError::FileTooLarge(format!(
                    "{SPACES_DIR_NAME}/{}",
                    file.name
                )));
            }
            // Two names that differ only in case are one file on Windows and macOS.
            if !seen.insert(file.name.to_lowercase()) {
                return Err(SyncError::Io(format!(
                    "{} is written twice in one batch",
                    file.name
                )));
            }
        }
        let mut names: BTreeSet<String> = plain_names(&self.dir())?.into_iter().collect();
        names.extend(files.iter().map(|file| file.name.clone()));
        if names.len() > MAX_SYNC_FILES {
            return Err(SyncError::TooManyFiles);
        }
        let mut links = self.load_links()?;
        let mut failure = None;
        for file in files {
            let path = self.dir().join(&file.name);
            let bytes = file.text.as_bytes();
            let same = fs::symlink_metadata(&path).is_ok_and(|m| m.is_file())
                && fs::read(&path).is_ok_and(|held| held == bytes);
            if !same && let Err(error) = write_bytes(&path, bytes) {
                failure = Some(error);
                break;
            }
            links.insert(
                file.name.clone(),
                SpaceLink {
                    space_id: file.space_id.clone(),
                    hash: sha256_hex(bytes),
                },
            );
        }
        // What was written is recorded even when a later file failed, so no written file is left
        // without its link (a pull would import it as a second copy of its space).
        self.save_links(&links)?;
        failure.map_or(Ok(()), Err)
    }

    /// Ties files already in the folder to the spaces made from them, with the hash of their bytes
    /// now (a pull does this after it made a space from a file). Names are checked first and a
    /// file that is not in the folder is an error.
    pub fn link(&self, wanted: &[SpaceFileLink]) -> Result<(), SyncError> {
        let mut hashes = Vec::new();
        for link in wanted {
            let path = self.checked_path(&link.name)?;
            check_space_id(&link.space_id)?;
            let meta = fs::symlink_metadata(&path).map_err(|e| SyncError::Io(e.to_string()))?;
            if !meta.is_file() || meta.len() > MAX_SYNC_FILE_BYTES {
                return Err(SyncError::Io(format!(
                    "{SPACES_DIR_NAME}/{} cannot be tied to a space",
                    link.name
                )));
            }
            let bytes = fs::read(&path).map_err(|e| SyncError::Io(e.to_string()))?;
            hashes.push(sha256_hex(&bytes));
        }
        let mut links = self.load_links()?;
        for (link, hash) in wanted.iter().zip(hashes) {
            links.insert(
                link.name.clone(),
                SpaceLink {
                    space_id: link.space_id.clone(),
                    hash,
                },
            );
        }
        self.save_links(&links)
    }

    /// `spaces/<name>` as a path of the config folder, when the closed list allows it.
    fn checked_path(&self, name: &str) -> Result<PathBuf, SyncError> {
        let relative = format!("{SPACES_DIR_NAME}/{name}");
        if is_syncable(&relative) {
            Ok(self.dir().join(name))
        } else {
            Err(SyncError::NotSyncable(relative))
        }
    }

    /// The record, empty when there is none yet; one that cannot be read is an error.
    fn load_links(&self) -> Result<BTreeMap<String, SpaceLink>, SyncError> {
        let path = self.links_path();
        let damaged = |why: &str| {
            SyncError::Io(format!(
                "{SPACE_LINKS_FILE_NAME} cannot be read ({why}): fix or delete it, then sync again"
            ))
        };
        let meta = match fs::metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(error) => return Err(SyncError::Io(error.to_string())),
        };
        if meta.len() > MAX_LINKS_BYTES {
            return Err(damaged("it is too large"));
        }
        let bytes = fs::read(&path).map_err(|e| SyncError::Io(e.to_string()))?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| damaged("not JSON"))?;
        if value.get("version").and_then(Value::as_u64) != Some(LINKS_VERSION) {
            return Err(damaged("another version"));
        }
        let entries = value
            .get("files")
            .and_then(Value::as_object)
            .ok_or_else(|| damaged("no list of files"))?;
        let mut links = BTreeMap::new();
        for (name, entry) in entries {
            let space_id = entry.get("spaceId").and_then(Value::as_str);
            let hash = entry.get("hash").and_then(Value::as_str);
            let (Some(space_id), Some(hash)) = (space_id, hash) else {
                return Err(damaged("an entry is incomplete"));
            };
            if check_space_id(space_id).is_err() || !is_sha256_hex(hash) {
                return Err(damaged("an entry is not valid"));
            }
            // A name off the list can never be asked for; it is dropped, not an error.
            if is_syncable(&format!("{SPACES_DIR_NAME}/{name}")) {
                links.insert(
                    name.clone(),
                    SpaceLink {
                        space_id: space_id.to_owned(),
                        hash: hash.to_owned(),
                    },
                );
            }
        }
        Ok(links)
    }

    /// Writes the record, keeping only the files that are still in the folder.
    fn save_links(&self, links: &BTreeMap<String, SpaceLink>) -> Result<(), SyncError> {
        let present: BTreeSet<String> = plain_names(&self.dir())?.into_iter().collect();
        let mut files = serde_json::Map::new();
        for (name, link) in links {
            if present.contains(name) {
                files.insert(
                    name.clone(),
                    json!({ "spaceId": link.space_id, "hash": link.hash }),
                );
            }
        }
        let record = json!({ "version": LINKS_VERSION, "files": files });
        let mut text =
            serde_json::to_string_pretty(&record).map_err(|e| SyncError::Io(e.to_string()))?;
        text.push('\n');
        write_bytes(&self.links_path(), text.as_bytes())
    }
}

/// The names in `dir` that may travel as space files and are plain files (a link is skipped), in
/// name order. A folder that is not there holds none. More than [`MAX_SYNC_FILES`] are an error.
fn plain_names(dir: &Path) -> Result<Vec<String>, SyncError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(SyncError::Io(error.to_string())),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| SyncError::Io(e.to_string()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        if is_syncable(&format!("{SPACES_DIR_NAME}/{name}")) {
            names.push(name);
        }
        if names.len() > MAX_SYNC_FILES {
            return Err(SyncError::TooManyFiles);
        }
    }
    names.sort();
    Ok(names)
}

/// An id of a space: text of one to [`MAX_SPACE_ID_CHARS`] characters with no control character.
fn check_space_id(id: &str) -> Result<(), SyncError> {
    if id.is_empty() || id.chars().count() > MAX_SPACE_ID_CHARS || id.chars().any(char::is_control)
    {
        return Err(SyncError::Io("the id of a space is not valid".to_owned()));
    }
    Ok(())
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A folder in the temp dir that no other test or run uses, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "noren-sync-spaces-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put(name: &str, text: &str, id: &str) -> SpaceFileWrite {
        SpaceFileWrite {
            name: name.to_owned(),
            text: text.to_owned(),
            space_id: id.to_owned(),
        }
    }

    #[test]
    fn a_name_off_the_list_is_refused_everywhere_and_nothing_is_written() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        for name in [
            "",
            "plain.json",
            "../escape.noren-space.json",
            "a/b.noren-space.json",
            "a\\b.noren-space.json",
            ".hidden.noren-space.json",
            "con.noren-space.json",
            "a:b.noren-space.json",
            "trailing .noren-space.json",
            "space.noren-space.json.tmp",
            ".noren-space.json",
        ] {
            let wrote = files.write(&[put(name, "{}", "s1")]);
            assert!(matches!(wrote, Err(SyncError::NotSyncable(_))), "{name:?}");
            assert!(
                matches!(files.read(name), Err(SyncError::NotSyncable(_))),
                "{name:?}"
            );
            let linked = files.link(&[SpaceFileLink {
                name: name.to_owned(),
                space_id: "s1".to_owned(),
            }]);
            assert!(matches!(linked, Err(SyncError::NotSyncable(_))), "{name:?}");
        }
        assert!(!dir.0.join(SPACES_DIR_NAME).exists());
        assert!(!dir.0.join(SPACE_LINKS_FILE_NAME).exists());
    }

    #[test]
    fn one_bad_file_in_a_batch_writes_none_of_them() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        let error = files
            .write(&[
                put("Work.noren-space.json", "{}", "s1"),
                put("../Bad.noren-space.json", "{}", "s2"),
            ])
            .expect_err("refused");
        assert!(matches!(error, SyncError::NotSyncable(_)), "{error}");
        assert!(!dir.0.join(SPACES_DIR_NAME).exists());

        let big = "x".repeat(MAX_SYNC_FILE_BYTES as usize + 1);
        let error = files
            .write(&[
                put("Work.noren-space.json", "{}", "s1"),
                put("Big.noren-space.json", &big, "s2"),
            ])
            .expect_err("too large");
        assert!(matches!(error, SyncError::FileTooLarge(_)), "{error}");
        assert!(!dir.0.join(SPACES_DIR_NAME).exists());

        let error = files
            .write(&[
                put("Work.noren-space.json", "{}", "s1"),
                put("work.noren-space.json", "{}", "s2"),
            ])
            .expect_err("the same file twice");
        assert!(matches!(error, SyncError::Io(_)), "{error}");
        assert!(!dir.0.join(SPACES_DIR_NAME).exists());

        let error = files
            .write(&[put("Work.noren-space.json", "{}", "")])
            .expect_err("no id");
        assert!(matches!(error, SyncError::Io(_)), "{error}");
    }

    #[test]
    fn a_file_at_the_ceiling_goes_and_one_byte_more_does_not() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        let at = "x".repeat(MAX_SYNC_FILE_BYTES as usize);
        files
            .write(&[put("At.noren-space.json", &at, "s1")])
            .expect("at the ceiling");
        assert_eq!(
            files.read("At.noren-space.json").expect("read").len(),
            at.len()
        );
        // A file that grew past the ceiling is neither listed nor read.
        fs::write(
            dir.0.join(SPACES_DIR_NAME).join("Grown.noren-space.json"),
            "x".repeat(MAX_SYNC_FILE_BYTES as usize + 1),
        )
        .expect("grown");
        let names: Vec<_> = files
            .list()
            .expect("list")
            .files
            .into_iter()
            .map(|file| file.name)
            .collect();
        assert_eq!(names, vec!["At.noren-space.json".to_owned()]);
        assert!(matches!(
            files.read("Grown.noren-space.json"),
            Err(SyncError::FileTooLarge(_))
        ));
    }

    #[test]
    fn more_files_than_the_ceiling_are_refused_and_listing_says_so() {
        let dir = TempDir::new();
        let folder = dir.0.join(SPACES_DIR_NAME);
        fs::create_dir_all(&folder).expect("folder");
        for n in 0..MAX_SYNC_FILES {
            fs::write(folder.join(format!("s{n}.noren-space.json")), "{}").expect("file");
        }
        let files = SpaceFiles::new(&dir.0);
        assert_eq!(
            files.list().expect("at the ceiling").files.len(),
            MAX_SYNC_FILES
        );
        // Rewriting one that is there is fine; a new name is the file too many.
        files
            .write(&[put("s1.noren-space.json", "{\"a\":1}", "x")])
            .expect("a file that is there");
        let error = files
            .write(&[put("one-more.noren-space.json", "{}", "y")])
            .expect_err("too many");
        assert!(matches!(error, SyncError::TooManyFiles), "{error}");
        assert!(!folder.join("one-more.noren-space.json").exists());
        fs::write(folder.join("one-more.noren-space.json"), "{}").expect("file");
        assert!(matches!(files.list(), Err(SyncError::TooManyFiles)));
    }

    #[test]
    fn what_was_written_is_listed_read_back_and_tied_to_its_space() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        assert_eq!(files.list().expect("empty"), SpaceFolder::default());
        files
            .write(&[
                put("Work.noren-space.json", "{\"a\":1}\n", "s-work"),
                put("Play.noren-space.json", "{\"b\":2}\n", "s-play"),
            ])
            .expect("write");
        let folder = files.list().expect("list");
        let names: Vec<_> = folder.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Play.noren-space.json", "Work.noren-space.json"]
        );
        let work = &folder.files[1];
        assert_eq!(work.hash, sha256_hex(b"{\"a\":1}\n"));
        assert_eq!(
            work.link,
            Some(SpaceLink {
                space_id: "s-work".to_owned(),
                hash: sha256_hex(b"{\"a\":1}\n"),
            })
        );
        assert_eq!(
            files.read("Work.noren-space.json").expect("read"),
            "{\"a\":1}\n"
        );

        // The same text again changes nothing; another text moves the hash of the file and of the link.
        files
            .write(&[put("Work.noren-space.json", "{\"a\":1}\n", "s-work")])
            .expect("same");
        assert_eq!(files.list().expect("list"), folder);
        files
            .write(&[put("Work.noren-space.json", "{\"a\":2}\n", "s-work")])
            .expect("changed");
        let changed = files.list().expect("list");
        assert_eq!(changed.files[1].hash, sha256_hex(b"{\"a\":2}\n"));
        assert_eq!(
            changed.files[1].link.as_ref().map(|l| l.hash.as_str()),
            Some(changed.files[1].hash.as_str())
        );
        assert_eq!(changed.files[0], folder.files[0]);
    }

    #[test]
    fn linking_records_the_hash_of_the_file_as_it_is_now() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        let folder = dir.0.join(SPACES_DIR_NAME);
        fs::create_dir_all(&folder).expect("folder");
        fs::write(folder.join("Came.noren-space.json"), "from the remote").expect("file");
        assert_eq!(files.list().expect("list").files[0].link, None);
        files
            .link(&[SpaceFileLink {
                name: "Came.noren-space.json".to_owned(),
                space_id: "s-new".to_owned(),
            }])
            .expect("link");
        assert_eq!(
            files.list().expect("list").files[0].link,
            Some(SpaceLink {
                space_id: "s-new".to_owned(),
                hash: sha256_hex(b"from the remote"),
            })
        );
        // A file that is not there cannot be tied to a space.
        let error = files
            .link(&[SpaceFileLink {
                name: "Gone.noren-space.json".to_owned(),
                space_id: "s-x".to_owned(),
            }])
            .expect_err("missing");
        assert!(matches!(error, SyncError::Io(_)), "{error}");
    }

    #[test]
    fn the_link_of_a_file_that_is_gone_is_dropped_with_the_next_save() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        files
            .write(&[
                put("A.noren-space.json", "a", "s-a"),
                put("B.noren-space.json", "b", "s-b"),
            ])
            .expect("write");
        fs::remove_file(dir.0.join(SPACES_DIR_NAME).join("A.noren-space.json")).expect("delete");
        files
            .write(&[put("C.noren-space.json", "c", "s-c")])
            .expect("write");
        let record = fs::read_to_string(dir.0.join(SPACE_LINKS_FILE_NAME)).expect("record");
        assert!(!record.contains("A.noren-space.json"), "{record}");
        assert!(record.contains("B.noren-space.json"), "{record}");
        assert!(record.contains("C.noren-space.json"), "{record}");
    }

    #[test]
    fn a_record_that_cannot_be_read_is_an_error_and_not_an_empty_record() {
        let dir = TempDir::new();
        let files = SpaceFiles::new(&dir.0);
        files
            .write(&[put("Work.noren-space.json", "{}", "s1")])
            .expect("write");
        for damaged in [
            "not json",
            "{\"version\":2,\"files\":{}}",
            "{\"version\":1}",
            "{\"version\":1,\"files\":{\"Work.noren-space.json\":{\"spaceId\":\"s1\"}}}",
            "{\"version\":1,\"files\":{\"Work.noren-space.json\":{\"spaceId\":\"s1\",\"hash\":\"nope\"}}}",
        ] {
            fs::write(dir.0.join(SPACE_LINKS_FILE_NAME), damaged).expect("damage");
            let error = files.list().expect_err("damaged");
            assert!(error.to_string().contains(SPACE_LINKS_FILE_NAME), "{error}");
            assert!(
                files
                    .write(&[put("Other.noren-space.json", "{}", "s2")])
                    .is_err()
            );
            // Nothing was written while the record was unreadable.
            assert!(
                !dir.0
                    .join(SPACES_DIR_NAME)
                    .join("Other.noren-space.json")
                    .exists()
            );
        }
    }

    #[test]
    fn the_listing_leaves_out_what_is_not_a_space_file() {
        let dir = TempDir::new();
        let folder = dir.0.join(SPACES_DIR_NAME);
        fs::create_dir_all(folder.join("Dir.noren-space.json")).expect("a folder");
        for name in [
            "Fine.noren-space.json",
            "notes.txt",
            ".hidden.noren-space.json",
            "con.noren-space.json",
            "Fine.noren-space.json.noren-sync-tmp",
        ] {
            fs::write(folder.join(name), "x").expect("file");
        }
        let names: Vec<_> = SpaceFiles::new(&dir.0)
            .list()
            .expect("list")
            .files
            .into_iter()
            .map(|file| file.name)
            .collect();
        assert_eq!(names, vec!["Fine.noren-space.json".to_owned()]);
    }

    #[test]
    fn the_names_the_clone_holds_are_listed_apart() {
        let dir = TempDir::new();
        let clone = dir.0.join(SYNC_DIR_NAME).join(SPACES_DIR_NAME);
        fs::create_dir_all(&clone).expect("clone folder");
        fs::write(clone.join("Theirs.noren-space.json"), "{}").expect("file");
        fs::write(clone.join("notes.txt"), "x").expect("file");
        let folder = SpaceFiles::new(&dir.0).list().expect("list");
        assert!(folder.files.is_empty());
        assert_eq!(folder.cloned, vec!["Theirs.noren-space.json".to_owned()]);
    }

    #[test]
    fn the_record_is_not_on_the_closed_list() {
        for path in [
            SPACE_LINKS_FILE_NAME,
            "sync-spaces.json.noren-sync-tmp",
            "spaces/sync-spaces.json",
        ] {
            assert!(!is_syncable(path), "{path}");
        }
    }
}

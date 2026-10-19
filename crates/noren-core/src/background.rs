//! The picture behind the window, without any Tauri dependency: which paths can name it, and
//! reading the file.
//!
//! A background is a file on this computer: an absolute path, or a path inside the config folder of
//! the app. The interface asks for the bytes (`Backend.readBackgroundImage`) and shows them from
//! memory, so the page never gets a path or an address to fetch. This side is the one that opens
//! the file, so it checks again what `backgroundImageProblem` of `@noren/model` checks (the two are
//! tested with the same cases):
//!
//! - **The path.** Web addresses and every other scheme, network paths (`\\server\share`), a path
//!   inside the config folder that climbs out with `..`, a control character, and a name that does
//!   not end in a picture extension are refused before anything is opened.
//! - **The file.** It must be a regular file of at most [`MAX_BACKGROUND_BYTES`], and its first
//!   bytes must be those of a png, jpeg, webp, gif or bmp picture: the name of the file is not
//!   trusted. Nothing else is read, so this cannot be used to read a text file.

use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

/// Largest picture file read.
pub const MAX_BACKGROUND_BYTES: u64 = 32 * 1024 * 1024;

/// Longest path accepted, counted in UTF-16 units like the interface counts it.
pub const MAX_BACKGROUND_PATH: usize = 1024;

/// The extensions a background can have.
pub const BACKGROUND_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// Errors returned by [`BackgroundStore::read`]. Each says what is wrong in a sentence for a person.
#[derive(Debug)]
pub enum BackgroundError {
    /// The path cannot name a background (see [`path_problem`]).
    Refused(String),
    /// There is no file at the path.
    NotFound(String),
    /// The file is larger than [`MAX_BACKGROUND_BYTES`].
    TooLarge(u64),
    /// The first bytes are not those of a picture Noren can show.
    NotAPicture(String),
    /// The file could not be read.
    Read(io::Error),
}

impl fmt::Display for BackgroundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(problem) => f.write_str(problem),
            Self::NotFound(path) => write!(f, "The image {path} was not found."),
            Self::TooLarge(size) => write!(
                f,
                "The image file is {size} bytes; a background picture is at most {MAX_BACKGROUND_BYTES}."
            ),
            Self::NotAPicture(path) => write!(
                f,
                "{path} is not a picture Noren can show (png, jpeg, webp, gif or bmp)."
            ),
            Self::Read(source) => write!(f, "The image could not be read: {source}"),
        }
    }
}

impl std::error::Error for BackgroundError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(source) => Some(source),
            _ => None,
        }
    }
}

/// Whether `path` starts with a URL scheme of two or more letters (`https:`, `file:`, `data:`); a
/// single letter before the colon is a drive.
fn has_url_scheme(path: &str) -> bool {
    let Some(colon) = path.find(':') else {
        return false;
    };
    let scheme = &path[..colon];
    scheme.len() >= 2
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

fn has_drive(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some(d), Some(':')) if d.is_ascii_alphabetic())
}

fn has_drive_root(path: &str) -> bool {
    has_drive(path) && matches!(path.chars().nth(2), Some('/' | '\\'))
}

/// The extension of the last part of `path`, lower case, without the dot (empty when it has none).
fn extension_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Why `path` cannot name a background, or `None` when it can. The same rules as
/// `backgroundImageProblem` of `@noren/model`. Whether the file exists is not asked here.
pub fn path_problem(path: &str) -> Option<String> {
    if path.trim().is_empty() {
        return Some("The path of the image is empty.".to_owned());
    }
    if path != path.trim() {
        return Some("The path of the image starts or ends with a space.".to_owned());
    }
    if path.encode_utf16().count() > MAX_BACKGROUND_PATH {
        return Some(format!(
            "The path of the image is longer than {MAX_BACKGROUND_PATH} characters."
        ));
    }
    if path.chars().any(|c| c.is_control()) {
        return Some("The path of the image has a control character.".to_owned());
    }
    if has_url_scheme(path) {
        return Some(
            "The image must be a file on this computer: web addresses and other schemes are not allowed."
                .to_owned(),
        );
    }
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Some(
            "The image must be a file on this computer: network paths are not allowed.".to_owned(),
        );
    }
    if has_drive(path) && !has_drive_root(path) {
        return Some(
            "A path with a drive letter must start from the root of the drive, such as C:\\Pictures\\sky.png."
                .to_owned(),
        );
    }
    let absolute = has_drive_root(path) || path.starts_with('/') || path.starts_with('\\');
    if !absolute && path.split(['/', '\\']).any(|part| part == "..") {
        return Some(
            "A path inside the config folder cannot climb out of it with '..'.".to_owned(),
        );
    }
    if !BACKGROUND_EXTENSIONS.contains(&extension_of(path).as_str()) {
        return Some(format!(
            "The image must be a {} file.",
            BACKGROUND_EXTENSIONS.join(", ")
        ));
    }
    None
}

/// The kind of picture the first bytes of a file are (`image/png`, `image/jpeg`, `image/webp`,
/// `image/gif`, `image/bmp`), or `None` when they are none of them.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

/// Reads background pictures. A relative path is a path inside `base`, the config folder of the app.
#[derive(Debug, Clone)]
pub struct BackgroundStore {
    base: PathBuf,
}

impl BackgroundStore {
    /// A store whose relative paths are inside `base`. Nothing is touched on disk until `read`.
    pub fn new(base: impl Into<PathBuf>) -> Self {
        Self { base: base.into() }
    }

    /// The file `path` stands for: itself when it is absolute, else inside the base folder. Refuses
    /// a path that [`path_problem`] refuses, and a relative one that is not made only of plain names.
    pub fn resolve(&self, path: &str) -> Result<PathBuf, BackgroundError> {
        if let Some(problem) = path_problem(path) {
            return Err(BackgroundError::Refused(problem));
        }
        let wanted = Path::new(path);
        if wanted.is_absolute() {
            return Ok(wanted.to_path_buf());
        }
        let plain = wanted
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir));
        if !plain {
            return Err(BackgroundError::Refused(
                "The image must be an absolute path, or a path inside the config folder."
                    .to_owned(),
            ));
        }
        Ok(self.base.join(wanted))
    }

    /// The bytes of the picture at `path`. See the top of this file for what is refused.
    pub fn read(&self, path: &str) -> Result<Vec<u8>, BackgroundError> {
        let file = self.resolve(path)?;
        let metadata = match fs::metadata(&file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(BackgroundError::NotFound(path.to_owned()));
            }
            Err(error) => return Err(BackgroundError::Read(error)),
        };
        if !metadata.is_file() {
            return Err(BackgroundError::NotFound(path.to_owned()));
        }
        if metadata.len() > MAX_BACKGROUND_BYTES {
            return Err(BackgroundError::TooLarge(metadata.len()));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
        // One byte more than the limit: a file that grew since `metadata` is still caught.
        File::open(&file)
            .and_then(|f| f.take(MAX_BACKGROUND_BYTES + 1).read_to_end(&mut bytes))
            .map_err(BackgroundError::Read)?;
        if bytes.len() as u64 > MAX_BACKGROUND_BYTES {
            return Err(BackgroundError::TooLarge(bytes.len() as u64));
        }
        if sniff_image(&bytes).is_none() {
            return Err(BackgroundError::NotAPicture(path.to_owned()));
        }
        Ok(bytes)
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
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-background-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let file = self.0.join(name);
            if let Some(parent) = file.parent() {
                fs::create_dir_all(parent).expect("create the parent folder");
            }
            fs::write(&file, bytes).expect("write the file");
            file
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

    #[test]
    fn paths_that_can_name_a_background() {
        for path in [
            "C:\\Pictures\\sky.png",
            "c:/pictures/sky.JPG",
            "/home/me/sky.jpeg",
            "\\rooted\\sky.webp",
            "backgrounds/sky.gif",
            "backgrounds\\sky.bmp",
            "./sky.png",
            "sky.png",
            "My Pictures/a b.png",
            "a..b/sky.png",
        ] {
            assert_eq!(path_problem(path), None, "{path}");
        }
    }

    #[test]
    fn paths_that_cannot() {
        for path in [
            "",
            "   ",
            " sky.png",
            "sky.png ",
            "http://example.com/sky.png",
            "https://example.com/sky.png",
            "HTTPS://example.com/sky.png",
            "file:///C:/sky.png",
            "data:image/png;base64,AAAA",
            "blob:abc",
            "ftp:sky.png",
            "\\\\server\\share\\sky.png",
            "//server/share/sky.png",
            "\\\\?\\C:\\sky.png",
            "C:sky.png",
            "../sky.png",
            "backgrounds/../../sky.png",
            "backgrounds\\..\\sky.png",
            "sky.txt",
            "sky",
            "sky.png.exe",
            ".png",
            "sky.svg",
            "bad\0name.png",
            "bad\nname.png",
        ] {
            assert!(path_problem(path).is_some(), "{path:?}");
        }
        assert!(path_problem(&format!("{}.png", "a".repeat(MAX_BACKGROUND_PATH))).is_some());
        assert!(path_problem(&format!("{}.png", "a".repeat(MAX_BACKGROUND_PATH - 4))).is_none());
    }

    #[test]
    fn the_first_bytes_tell_the_kind_of_picture() {
        assert_eq!(sniff_image(PNG), Some("image/png"));
        assert_eq!(sniff_image(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image(b"GIF87a...."), Some("image/gif"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"BM......"), Some("image/bmp"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_image(b"<svg xmlns="), None);
        assert_eq!(sniff_image(b"hello"), None);
        assert_eq!(sniff_image(b""), None);
    }

    #[test]
    fn reads_an_absolute_path_and_a_path_inside_the_base_folder() {
        let dir = TempDir::new();
        let absolute = dir.write("elsewhere/sky.png", PNG);
        dir.write("config/backgrounds/dusk.png", PNG);
        let store = BackgroundStore::new(dir.0.join("config"));
        assert_eq!(
            store.read(&absolute.to_string_lossy()).expect("absolute"),
            PNG
        );
        assert_eq!(store.read("backgrounds/dusk.png").expect("relative"), PNG);
        assert_eq!(store.read("./backgrounds/dusk.png").expect("relative"), PNG);
    }

    #[test]
    fn a_refused_path_opens_nothing() {
        let dir = TempDir::new();
        dir.write("secret.png", PNG);
        let store = BackgroundStore::new(dir.0.join("config"));
        for path in [
            "http://127.0.0.1/sky.png",
            "../secret.png",
            "\\\\server\\share\\sky.png",
            "notes.txt",
        ] {
            assert!(
                matches!(store.read(path), Err(BackgroundError::Refused(_))),
                "{path}"
            );
        }
    }

    #[test]
    fn a_missing_file_a_folder_a_text_file_and_a_large_file_are_refused_with_a_sentence() {
        let dir = TempDir::new();
        let store = BackgroundStore::new(&dir.0);
        assert!(matches!(
            store.read("missing.png"),
            Err(BackgroundError::NotFound(_))
        ));
        fs::create_dir_all(dir.0.join("folder.png")).expect("folder");
        assert!(matches!(
            store.read("folder.png"),
            Err(BackgroundError::NotFound(_))
        ));
        dir.write("notes.png", b"this is text, not a picture");
        let error = store
            .read("notes.png")
            .expect_err("text with a picture name");
        assert!(matches!(error, BackgroundError::NotAPicture(_)));
        assert_eq!(
            error.to_string(),
            "notes.png is not a picture Noren can show (png, jpeg, webp, gif or bmp)."
        );
        dir.write("empty.png", b"");
        assert!(matches!(
            store.read("empty.png"),
            Err(BackgroundError::NotAPicture(_))
        ));
        let large = dir.0.join("large.png");
        let file = File::create(&large).expect("create");
        file.set_len(MAX_BACKGROUND_BYTES + 1).expect("sparse file");
        drop(file);
        assert!(matches!(
            store.read("large.png"),
            Err(BackgroundError::TooLarge(_))
        ));
    }

    #[test]
    fn a_relative_path_never_leaves_the_base_folder() {
        let store = BackgroundStore::new("/config");
        let resolved = store.resolve("backgrounds/sky.png").expect("inside");
        assert!(resolved.starts_with("/config"));
        assert!(store.resolve("../sky.png").is_err());
    }
}

//! The token of the local API: 32 random bytes that live in a file of the user. Whoever can read
//! the file can use the API, which is the point: the endpoint is closed to other users already
//! (see [`daemon::ipc`](crate::daemon::ipc)), and the token keeps a program that merely runs as
//! the same user from driving the terminals without having been given the file.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Bytes of a token.
pub const TOKEN_BYTES: usize = 32;
/// Characters of a token written as text (lowercase hexadecimal).
pub const TOKEN_HEX_CHARS: usize = TOKEN_BYTES * 2;
/// A token file is read up to this many bytes; a longer file is not a token file.
const MAX_TOKEN_FILE_BYTES: u64 = 256;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A token. It has no `PartialEq` on purpose: the only way to compare is [`ApiToken::matches`],
/// which takes the same time whatever the bytes are. `Debug` does not show the bytes.
#[derive(Clone)]
pub struct ApiToken([u8; TOKEN_BYTES]);

impl ApiToken {
    /// A new token from the random generator of the system.
    pub fn generate() -> io::Result<Self> {
        let mut bytes = [0u8; TOKEN_BYTES];
        getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
        Ok(Self(bytes))
    }

    /// Reads a token written as 64 hexadecimal characters (either case). Anything else is `None`.
    pub fn from_hex(text: &str) -> Option<Self> {
        let text = text.as_bytes();
        if text.len() != TOKEN_HEX_CHARS {
            return None;
        }
        let (pairs, _) = text.as_chunks::<2>();
        let mut bytes = [0u8; TOKEN_BYTES];
        for (byte, pair) in bytes.iter_mut().zip(pairs) {
            *byte = (hex_value(pair[0])? << 4) | hex_value(pair[1])?;
        }
        Some(Self(bytes))
    }

    /// The token as 64 lowercase hexadecimal characters.
    pub fn to_hex(&self) -> String {
        use fmt::Write as _;
        let mut text = String::with_capacity(TOKEN_HEX_CHARS);
        for byte in self.0 {
            let _ = write!(text, "{byte:02x}");
        }
        text
    }

    /// Whether `other` is this token. The time does not depend on where the bytes differ.
    pub fn matches(&self, other: &ApiToken) -> bool {
        let mut difference = 0u8;
        for (a, b) in self.0.iter().zip(other.0.iter()) {
            difference |= std::hint::black_box(a ^ b);
        }
        std::hint::black_box(difference) == 0
    }

    /// Whether `presented`, the text a client sent, is this token. Text that is not a token
    /// (wrong length, not hexadecimal) is a mismatch.
    pub fn matches_hex(&self, presented: &str) -> bool {
        ApiToken::from_hex(presented).is_some_and(|other| self.matches(&other))
    }
}

impl fmt::Debug for ApiToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiToken(..)")
    }
}

fn hex_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// What [`load_or_create_token`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenOrigin {
    /// There was no file, and a new token was written.
    Created,
    /// The file held a token, which is the one in use.
    Reused,
    /// The file existed but did not hold a token (empty, cut, not hexadecimal, too long, not a
    /// plain file), and a new token replaced it.
    Regenerated,
}

/// Reads the token in `path`, or writes a new one when the file is missing or does not hold one.
///
/// The file is 64 hexadecimal characters and a line break. A new token is written to a file next
/// to it and moved over `path`, so a reader sees the old token or the new one and never half of
/// it; on Unix the file is created with mode 0600 and a reused file that is open to others is
/// tightened to 0600. A missing folder is created (mode 0700 on Unix).
///
/// On Windows the file keeps the access list it inherits from its folder, so `path` should be
/// under the profile of the user.
pub fn load_or_create_token(path: &Path) -> io::Result<(ApiToken, TokenOrigin)> {
    let existed = match read_token_file(path) {
        Ok(Some(token)) => {
            tighten_mode(path)?;
            return Ok((token, TokenOrigin::Reused));
        }
        Ok(None) => true,
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    let token = ApiToken::generate()?;
    write_token_file(path, &token)?;
    let origin = if existed {
        TokenOrigin::Regenerated
    } else {
        TokenOrigin::Created
    };
    Ok((token, origin))
}

/// `Ok(None)` when the file exists and holds no token; `NotFound` when it does not exist.
fn read_token_file(path: &Path) -> io::Result<Option<ApiToken>> {
    // Not `File::open` first: opening a pipe or a device would wait for a writer.
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Ok(None);
    }
    let mut text = String::new();
    let read = fs::File::open(path)?
        .take(MAX_TOKEN_FILE_BYTES + 1)
        .read_to_string(&mut text);
    match read {
        Ok(n) if n as u64 <= MAX_TOKEN_FILE_BYTES => Ok(ApiToken::from_hex(text.trim())),
        // Longer than a token file, or not text.
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::InvalidData => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn tighten_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(path)?.permissions().mode() & 0o777;
    if mode != 0o600 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn tighten_mode(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn write_token_file(path: &Path, token: &ApiToken) -> io::Result<()> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir.to_path_buf(),
        _ => PathBuf::from("."),
    };
    create_private_dir(&dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the token path has no name"))?
        .to_string_lossy();
    let temp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let written = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(token.to_hex().as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        // Replaces a file already there; a link in its place is replaced, not followed.
        fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    static DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noren-token-{}-{}",
            std::process::id(),
            DIR_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_token_round_trips_through_hex_and_two_tokens_differ() {
        let a = ApiToken::generate().unwrap();
        let b = ApiToken::generate().unwrap();
        assert_eq!(a.to_hex().len(), TOKEN_HEX_CHARS);
        assert!(a.to_hex().bytes().all(|c| c.is_ascii_hexdigit()));
        assert!(a.matches(&ApiToken::from_hex(&a.to_hex()).unwrap()));
        assert!(a.matches(&ApiToken::from_hex(&a.to_hex().to_uppercase()).unwrap()));
        assert!(!a.matches(&b));
        assert!(!a.matches_hex(&b.to_hex()));
        assert!(a.matches_hex(&a.to_hex()));
    }

    #[test]
    fn text_that_is_not_a_token_never_matches() {
        let token = ApiToken::generate().unwrap();
        let hex = token.to_hex();
        for bad in [
            "",
            "0",
            &hex[..63],
            &format!("{hex}0"),
            &format!("{}g", &hex[..63]),
            &format!(" {}", &hex[..63]),
            &"é".repeat(32),
        ] {
            assert!(!token.matches_hex(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_debug_text_does_not_show_the_token() {
        let token = ApiToken::generate().unwrap();
        assert!(!format!("{token:?}").contains(&token.to_hex()));
    }

    #[test]
    fn a_missing_file_is_created_then_reused() {
        let dir = temp_dir();
        let path = dir.join("api-token");
        let (first, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Created);
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("{}\n", first.to_hex())
        );
        let (second, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Reused);
        assert!(first.matches(&second));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_folder_is_created() {
        let dir = temp_dir();
        let path = dir.join("a").join("b").join("api-token");
        let (_, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Created);
        assert!(path.is_file());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_without_a_token_is_replaced() {
        let dir = temp_dir();
        let path = dir.join("api-token");
        let hex = ApiToken::generate().unwrap().to_hex();
        let bad: [Vec<u8>; 6] = [
            Vec::new(),
            b"not a token\n".to_vec(),
            hex.as_bytes()[..40].to_vec(),
            format!("{}z", &hex[..63]).into_bytes(),
            vec![b'a'; 10_000],
            vec![0xff, 0xfe, 0x00],
        ];
        for content in bad {
            fs::write(&path, &content).unwrap();
            let (token, origin) = load_or_create_token(&path).unwrap();
            assert_eq!(origin, TokenOrigin::Regenerated, "{:?}", content.len());
            let (again, origin) = load_or_create_token(&path).unwrap();
            assert_eq!(origin, TokenOrigin::Reused);
            assert!(token.matches(&again));
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_in_place_of_the_file_is_an_error_and_not_a_token() {
        let dir = temp_dir();
        let path = dir.join("api-token");
        fs::create_dir(&path).unwrap();
        // It is not a plain file, so a token is written over it: the rename of a file onto a
        // folder fails, and the failure leaves no temporary file behind.
        assert!(load_or_create_token(&path).is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writing_leaves_no_temporary_file() {
        let dir = temp_dir();
        let path = dir.join("api-token");
        load_or_create_token(&path).unwrap();
        fs::write(&path, b"broken").unwrap();
        load_or_create_token(&path).unwrap();
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("api-token")]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private_and_a_loose_file_is_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join("nested").join("api-token");
        load_or_create_token(&path).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let (_, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Reused);
        assert_eq!(mode(&path), 0o600);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_link_in_place_of_the_file_is_replaced_not_followed() {
        let dir = temp_dir();
        let target = dir.join("target");
        fs::write(&target, b"keep me").unwrap();
        let path = dir.join("api-token");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let (_, origin) = load_or_create_token(&path).unwrap();
        assert_eq!(origin, TokenOrigin::Regenerated);
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
        assert!(
            !fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}

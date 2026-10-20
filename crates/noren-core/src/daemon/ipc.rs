//! Local IPC: where the daemon listens and how a client reaches it. A named pipe on Windows and a
//! Unix domain socket everywhere else, both closed to every user but the current one:
//!
//! - **Windows** (`pipe.rs`): the pipe is created with a security descriptor that grants access to
//!   the SID of the current user and nobody else, with remote clients rejected, and the first
//!   instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a second daemon (or a program
//!   that took the name first) makes the start fail instead of sharing the name. The name carries
//!   the SID, so two users on one machine do not fight over it.
//! - **Unix** (`socket.rs`): the socket sits in a folder that belongs to the current user and has
//!   mode 0700 (created that way, or checked when it exists: another owner, a link, or any
//!   access for group or others is refused), the socket file is 0600, and every accepted
//!   connection must come from the same user id.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io;
#[cfg(unix)]
use std::path::Path;

#[cfg(windows)]
mod pipe;
#[cfg(unix)]
mod socket;

#[cfg(windows)]
use pipe as platform;
#[cfg(unix)]
use socket as platform;

pub use platform::{ClientStream, Listener, ServerStream, connect};

/// Longest name [`Endpoint::named`] accepts.
pub const MAX_ENDPOINT_NAME_CHARS: usize = 64;

/// The address of a daemon: the full name of a pipe, or the path of a socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    address: OsString,
}

impl Endpoint {
    /// The endpoint of the daemon called `name` for the current user (`default` is the one a
    /// normal installation uses). The name is ASCII letters, digits, `-`, `_` and `.`, does not
    /// start with a dot and has at most [`MAX_ENDPOINT_NAME_CHARS`] characters.
    ///
    /// On Windows it is a pipe named after the user's SID; elsewhere it is a socket in
    /// `$XDG_RUNTIME_DIR/noren` when that is set, else in `noren-<uid>` in the temporary folder.
    pub fn named(name: &str) -> io::Result<Self> {
        check_name(name)?;
        platform::endpoint(name)
    }

    /// A socket called `<name>.sock` in `dir`, which the daemon creates with mode 0700 when it
    /// is missing and refuses when it is not private to the current user.
    #[cfg(unix)]
    pub fn in_dir(dir: &Path, name: &str) -> io::Result<Self> {
        check_name(name)?;
        Ok(Self {
            address: dir.join(format!("{name}.sock")).into_os_string(),
        })
    }

    /// The pipe name or the socket path.
    pub fn address(&self) -> &OsStr {
        &self.address
    }

    #[cfg(windows)]
    pub(crate) fn from_address(address: OsString) -> Self {
        Self { address }
    }
}

impl fmt::Display for Endpoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.address.to_string_lossy())
    }
}

pub(super) fn check_name(name: &str) -> io::Result<()> {
    let valid = !name.is_empty()
        && name.len() <= MAX_ENDPOINT_NAME_CHARS
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{name:?} is not a valid daemon name: use 1 to {MAX_ENDPOINT_NAME_CHARS} ASCII \
                 letters, digits, '-', '_' or '.', not starting with a dot"
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain_and_short() {
        for good in [
            "default",
            "a",
            "test-123-4",
            "my_daemon.v2",
            &"x".repeat(64),
        ] {
            assert!(check_name(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            ".hidden",
            "..",
            "a/b",
            "a\\b",
            "a b",
            "ünï",
            "a:b",
            "a\0b",
            &"x".repeat(65),
        ] {
            let error = check_name(bad).expect_err(bad);
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{bad}");
        }
    }

    #[test]
    fn an_endpoint_has_the_name_in_its_address() {
        let endpoint = Endpoint::named("probe-1").unwrap();
        assert!(endpoint.to_string().contains("probe-1"), "{endpoint}");
        assert_eq!(endpoint.address().to_string_lossy(), endpoint.to_string());
        assert!(Endpoint::named("../escape").is_err());
    }
}

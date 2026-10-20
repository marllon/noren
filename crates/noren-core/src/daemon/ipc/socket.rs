//! The Unix side of [`ipc`](super): a domain socket in a folder that only the current user can
//! enter.

use std::fs::{self, DirBuilder};
use std::io;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use tokio::net::{UnixListener, UnixStream};

use super::Endpoint;

pub type ServerStream = UnixStream;
pub type ClientStream = UnixStream;

/// The user id the process runs as.
fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments, no failure and no side effects.
    unsafe { libc::geteuid() }
}

/// `$XDG_RUNTIME_DIR/noren/<name>.sock` when the variable holds an absolute path (that folder is
/// private to the user by definition), else `<temporary folder>/noren-<uid>/<name>.sock`. The
/// folder is checked, not trusted, when the daemon binds and when a client connects.
pub(super) fn endpoint(name: &str) -> io::Result<Endpoint> {
    let dir = match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from) {
        Some(runtime) if runtime.is_absolute() => runtime.join("noren"),
        _ => std::env::temp_dir().join(format!("noren-{}", effective_uid())),
    };
    Endpoint::in_dir(&dir, name)
}

/// Makes sure `dir` is a real folder (not a link) that belongs to the current user and that
/// neither the group nor others can touch. A missing folder is created with mode 0700 when
/// `create` is set (with its missing parents), and is an error otherwise.
fn check_private_dir(dir: &Path, create: bool) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
            DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
            fs::symlink_metadata(dir)?
        }
        Err(e) => return Err(e),
    };
    let refuse = |why: String| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not a private folder: {why}", dir.display()),
        ))
    };
    if !metadata.file_type().is_dir() {
        return refuse("it is not a folder (a link to one does not count)".into());
    }
    if metadata.uid() != effective_uid() {
        return refuse(format!("it belongs to user {}", metadata.uid()));
    }
    let mode = metadata.mode() & 0o777;
    if mode & 0o077 != 0 {
        return refuse(format!(
            "its mode is {mode:03o} and group and others must have no access (use 700)"
        ));
    }
    Ok(())
}

/// Removes a socket file that no daemon listens on any more (one left by a daemon that was
/// killed). A socket somebody listens on is `AddrInUse`, and anything that is not a socket is
/// left alone and refused.
fn clear_stale_socket(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} exists and is not a socket", path.display()),
        ));
    }
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("a daemon is already listening on {}", path.display()),
        )),
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => fs::remove_file(path),
        Err(e) => Err(e),
    }
}

/// The socket the daemon accepts connections on.
pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
    uid: u32,
}

impl Listener {
    /// Checks (or creates) the private folder, clears a stale socket, binds and makes the socket
    /// file readable and writable by the owner only. Needs a tokio runtime in context.
    pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        let path = PathBuf::from(endpoint.address());
        let dir = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "the socket has no folder")
        })?;
        check_private_dir(dir, true)?;
        clear_stale_socket(&path)?;
        let inner = UnixListener::bind(&path)?;
        let listener = Self {
            inner,
            path,
            uid: effective_uid(),
        };
        if let Err(e) = fs::set_permissions(&listener.path, fs::Permissions::from_mode(0o600)) {
            listener.cleanup();
            return Err(e);
        }
        Ok(listener)
    }

    /// Waits for a client of the same user. A connection from another user id is closed and the
    /// wait goes on (the folder keeps them out already; this is the second lock).
    pub async fn accept(&mut self) -> io::Result<ServerStream> {
        loop {
            let (stream, _) = self.inner.accept().await?;
            match stream.peer_cred() {
                Ok(cred) if cred.uid() == self.uid => return Ok(stream),
                _ => drop(stream),
            }
        }
    }

    /// Removes the socket file.
    pub fn cleanup(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Connects to the daemon, after checking that the folder of the socket is private to the user
/// (a socket in a folder somebody else controls could be somebody else's).
pub async fn connect(endpoint: &Endpoint) -> io::Result<ClientStream> {
    let path = PathBuf::from(endpoint.address());
    if let Some(dir) = path.parent() {
        check_private_dir(dir, false)?;
    }
    UnixStream::connect(&path).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// A folder name under the temporary folder that no other test or run uses. Kept short:
    /// a socket path has a hard limit of about 100 bytes.
    fn unique_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "n-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().mode() & 0o777
    }

    #[test]
    fn a_missing_folder_is_created_private_with_its_parents() {
        let root = unique_dir();
        let dir = root.join("a").join("b");
        check_private_dir(&dir, true).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(mode_of(&root.join("a")), 0o700);
        // Checking it again changes nothing and passes.
        check_private_dir(&dir, true).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_folder_is_an_error_when_creating_is_not_allowed() {
        let dir = unique_dir();
        let error = check_private_dir(&dir, false).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(!dir.exists());
    }

    #[test]
    fn a_folder_open_to_group_or_others_is_refused() {
        for mode in [0o755, 0o750, 0o705, 0o770, 0o777] {
            let dir = unique_dir();
            DirBuilder::new().mode(0o700).create(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(mode)).unwrap();
            for create in [true, false] {
                let error = check_private_dir(&dir, create).unwrap_err();
                assert_eq!(error.kind(), io::ErrorKind::PermissionDenied, "{mode:o}");
                assert!(error.to_string().contains("group and others"), "{error}");
            }
            fs::remove_dir(&dir).unwrap();
        }
    }

    #[test]
    fn a_link_or_a_file_in_place_of_the_folder_is_refused() {
        let root = unique_dir();
        check_private_dir(&root, true).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let file = root.join("file");
        fs::write(&file, b"x").unwrap();
        for not_a_folder in [&link, &file] {
            let error = check_private_dir(not_a_folder, true).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(error.to_string().contains("not a folder"), "{error}");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_folder_of_another_user_is_refused() {
        // The root folder belongs to root, and is open to others besides: refused either way.
        assert!(check_private_dir(Path::new("/"), false).is_err());
    }

    #[test]
    fn the_default_endpoint_is_a_short_socket_path_with_the_name() {
        let endpoint = Endpoint::named("probe").unwrap();
        let address = endpoint.address().to_string_lossy().into_owned();
        assert!(address.ends_with("/probe.sock"), "{address}");
        assert!(address.contains("noren"), "{address}");
        assert!(address.len() < 100, "{address}");
    }

    #[tokio::test]
    async fn binding_makes_a_private_folder_and_a_private_socket_and_cleanup_removes_it() {
        let dir = unique_dir();
        let endpoint = Endpoint::in_dir(&dir, "s").unwrap();
        let listener = Listener::bind(&endpoint).unwrap();
        let path = dir.join("s.sock");
        assert_eq!(mode_of(&dir), 0o700);
        assert_eq!(mode_of(&path), 0o600);
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        listener.cleanup();
        assert!(!path.exists());
        fs::remove_dir(&dir).unwrap();
    }

    #[tokio::test]
    async fn binding_in_a_folder_open_to_others_fails_and_leaves_no_socket() {
        let dir = unique_dir();
        DirBuilder::new().mode(0o755).create(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let endpoint = Endpoint::in_dir(&dir, "s").unwrap();
        let error = Listener::bind(&endpoint).err().expect("refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!dir.join("s.sock").exists());
        // A client does not connect through such a folder either.
        let error = connect(&endpoint).await.expect_err("refused");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        fs::remove_dir(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_socket_left_by_a_dead_daemon_is_replaced() {
        let dir = unique_dir();
        let endpoint = Endpoint::in_dir(&dir, "s").unwrap();
        let first = Listener::bind(&endpoint).unwrap();
        // Dropping the listener without `cleanup` leaves the file, like a daemon that was killed.
        drop(first);
        assert!(dir.join("s.sock").exists());
        let second = Listener::bind(&endpoint).unwrap();
        second.cleanup();
        fs::remove_dir(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_socket_somebody_listens_on_is_not_taken() {
        let dir = unique_dir();
        let endpoint = Endpoint::in_dir(&dir, "s").unwrap();
        let live = Listener::bind(&endpoint).unwrap();
        let error = Listener::bind(&endpoint).err().expect("second bind fails");
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse, "{error}");
        assert!(dir.join("s.sock").exists(), "the live socket is untouched");
        live.cleanup();
        fs::remove_dir(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_file_that_is_not_a_socket_is_never_removed() {
        let dir = unique_dir();
        check_private_dir(&dir, true).unwrap();
        let path = dir.join("s.sock");
        fs::write(&path, b"precious").unwrap();
        let endpoint = Endpoint::in_dir(&dir, "s").unwrap();
        let error = Listener::bind(&endpoint).err().expect("refused");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{error}");
        assert_eq!(fs::read(&path).unwrap(), b"precious");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_client_of_the_same_user_is_accepted_again_and_again() {
        let dir = unique_dir();
        let endpoint = Endpoint::in_dir(&dir, "s").unwrap();
        let mut listener = Listener::bind(&endpoint).unwrap();
        for _ in 0..3 {
            let (server, client) = tokio::join!(listener.accept(), connect(&endpoint));
            drop((server.unwrap(), client.unwrap()));
        }
        listener.cleanup();
        fs::remove_dir(&dir).unwrap();
    }
}

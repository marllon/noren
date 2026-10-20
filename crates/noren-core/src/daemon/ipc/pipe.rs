//! The Windows side of [`ipc`](super): a named pipe that only the current user can open.

use std::ffi::{OsStr, OsString, c_void};
use std::io;
use std::ptr;
use std::slice;
use std::time::{Duration, Instant};

use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_BUSY, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::Endpoint;

pub type ServerStream = NamedPipeServer;
pub type ClientStream = NamedPipeClient;

/// How long a client waits for a free instance of the pipe. Every instance is busy for the
/// moment between a connection and the creation of the next instance, which is brief.
const BUSY_WAIT: Duration = Duration::from_secs(2);
const BUSY_POLL: Duration = Duration::from_millis(10);

/// `\\.\pipe\noren-<SID of the user>-<name>`.
pub(super) fn endpoint(name: &str) -> io::Result<Endpoint> {
    let sid = current_user_sid()?;
    Ok(Endpoint::from_address(OsString::from(format!(
        r"\\.\pipe\noren-{sid}-{name}"
    ))))
}

/// The pipe the daemon accepts connections on.
pub struct Listener {
    name: OsString,
    security: PipeSecurity,
    /// The instance waiting for a client. Created before the one that was connected is handed
    /// out, so a client that arrives in between finds a free instance.
    next: Option<NamedPipeServer>,
}

impl Listener {
    /// Creates the first instance of the pipe. Fails with `AddrInUse` when the name is taken.
    /// Needs a tokio runtime in context.
    pub fn bind(endpoint: &Endpoint) -> io::Result<Self> {
        let mut listener = Self {
            name: endpoint.address().to_owned(),
            security: PipeSecurity::current_user_only()?,
            next: None,
        };
        let first = listener.create_instance(true).map_err(|e| {
            // Creating the first instance of a name that is in use fails with "access denied".
            if e.kind() == io::ErrorKind::PermissionDenied {
                io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!("{endpoint} is already in use: {e}"),
                )
            } else {
                e
            }
        })?;
        listener.next = Some(first);
        Ok(listener)
    }

    fn create_instance(&self, first: bool) -> io::Result<NamedPipeServer> {
        let mut attributes = self.security.attributes();
        let mut options = ServerOptions::new();
        options.first_pipe_instance(first);
        options.reject_remote_clients(true);
        // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES for the duration of the call, and
        // its descriptor is owned by `self.security`, which outlives it. CreateNamedPipeW copies
        // the descriptor, so nothing keeps the pointer afterwards.
        unsafe {
            options.create_with_security_attributes_raw(
                &self.name,
                ptr::addr_of_mut!(attributes).cast::<c_void>(),
            )
        }
    }

    /// Waits for a client and hands out the connected instance. Cancel safe: the waiting
    /// instance stays in the listener until a client has connected to it, so dropping this
    /// future never closes the instance a client is about to open (which, as the last one,
    /// would make the pipe vanish).
    pub async fn accept(&mut self) -> io::Result<ServerStream> {
        if self.next.is_none() {
            self.next = Some(self.create_instance(false)?);
        }
        if let Some(waiting) = &self.next
            && let Err(e) = waiting.connect().await
        {
            self.next = None;
            return Err(e);
        }
        let connected = self
            .next
            .take()
            .ok_or_else(|| io::Error::other("no pipe instance was waiting"))?;
        // A failure here only means there is no spare instance yet: the next `accept` tries
        // again, and this client is served.
        self.next = self.create_instance(false).ok();
        Ok(connected)
    }

    /// Nothing to remove: the pipe goes away with its last instance.
    pub fn cleanup(&self) {}
}

/// Opens the pipe, waiting briefly when every instance is busy.
pub async fn connect(endpoint: &Endpoint) -> io::Result<ClientStream> {
    let deadline = Instant::now() + BUSY_WAIT;
    loop {
        match ClientOptions::new().open(endpoint.address()) {
            Ok(client) => return Ok(client),
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && Instant::now() < deadline =>
            {
                tokio::time::sleep(BUSY_POLL).await;
            }
            Err(e) => return Err(e),
        }
    }
}

/// A security descriptor that gives full access to the current user's SID and to no one else
/// (`D:P(A;;GA;;;<SID>)`: a protected DACL with one allow entry).
struct PipeSecurity {
    descriptor: *mut c_void,
}

// SAFETY: the descriptor is a block of memory that is written once, when it is built, and only
// read afterwards.
unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    fn current_user_only() -> io::Result<Self> {
        let sddl = wide(&format!("D:P(A;;GA;;;{})", current_user_sid()?));
        let mut descriptor: *mut c_void = ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated and `descriptor` receives a block that this type frees.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { descriptor })
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        }
    }
}

impl Drop for PipeSecurity {
    fn drop(&mut self) {
        // SAFETY: the block came from ConvertStringSecurityDescriptorToSecurityDescriptorW,
        // which allocates it with LocalAlloc, and nothing uses it after this.
        unsafe {
            LocalFree(self.descriptor);
        }
    }
}

/// A token handle that is closed when it goes out of scope.
struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by OpenProcessToken and is closed once.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// The SID of the user the process runs as, in its text form (`S-1-5-21-...`).
pub(super) fn current_user_sid() -> io::Result<String> {
    // SAFETY: every pointer handed to the Win32 calls below points into a local that is alive for
    // the call, buffers are sized by the calls themselves, and the string that
    // ConvertSidToStringSidW allocates is copied and freed before returning.
    unsafe {
        let mut handle: HANDLE = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = Token(handle);

        // The first call fails on purpose and only tells how big the answer is.
        let mut needed = 0u32;
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        // Eight-byte units, so the buffer is aligned for the pointers inside TOKEN_USER.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let size = u32::try_from(buffer.len() * 8).unwrap_or(needed);
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast::<c_void>(),
            size,
            &mut needed,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();

        let mut text: *mut u16 = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(slice::from_raw_parts(text, len));
        LocalFree(text.cast::<c_void>());
        Ok(sid)
    }
}

/// UTF-16 with the closing NUL that Win32 strings need.
fn wide(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

    use super::*;

    #[test]
    fn the_sid_of_the_user_is_a_sid() {
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        assert!(
            sid.bytes()
                .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-'),
            "{sid}"
        );
    }

    #[test]
    fn the_endpoint_carries_the_sid() {
        let endpoint = Endpoint::named("probe").unwrap();
        let expected = format!(r"\\.\pipe\noren-{}-probe", current_user_sid().unwrap());
        assert_eq!(endpoint.address().to_string_lossy(), expected);
    }

    /// Reads the access list of a live pipe back from the system and checks that it names the
    /// current user and nobody else: this is what keeps another account on the machine out.
    #[tokio::test]
    async fn the_pipe_grants_access_to_the_current_user_only() {
        let endpoint = Endpoint::named(&format!("acl-probe-{}", std::process::id())).unwrap();
        let listener = Listener::bind(&endpoint).unwrap();
        let instance = listener.next.as_ref().expect("first instance");

        let mut descriptor: *mut c_void = ptr::null_mut();
        // SAFETY: the handle is a live pipe handle; `descriptor` receives a block freed below.
        let status = unsafe {
            GetSecurityInfo(
                instance.as_raw_handle(),
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, 0, "GetSecurityInfo");

        let mut text: *mut u16 = ptr::null_mut();
        // SAFETY: `descriptor` was just returned by GetSecurityInfo; `text` is freed below.
        let converted = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                ptr::null_mut(),
            )
        };
        assert_ne!(converted, 0, "ConvertSecurityDescriptorToString");
        // SAFETY: `text` is a NUL-terminated string allocated by the call above.
        let sddl = unsafe {
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let sddl = String::from_utf16_lossy(slice::from_raw_parts(text, len));
            LocalFree(text.cast::<c_void>());
            LocalFree(descriptor);
            sddl
        };

        let sid = current_user_sid().unwrap();
        println!("access list of the pipe: {sddl}");
        assert!(sddl.starts_with("D:"), "{sddl}");
        assert_eq!(sddl.matches('(').count(), 1, "one entry only: {sddl}");
        assert!(sddl.contains("(A;"), "an allow entry: {sddl}");
        assert!(
            sddl.ends_with(&format!(";;;{sid})")),
            "for the user: {sddl}"
        );
    }

    #[tokio::test]
    async fn a_second_listener_on_the_same_name_is_refused() {
        let endpoint = Endpoint::named(&format!("twice-probe-{}", std::process::id())).unwrap();
        let _first = Listener::bind(&endpoint).unwrap();
        let error = Listener::bind(&endpoint).err().expect("second bind fails");
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse, "{error}");
    }

    #[tokio::test]
    async fn a_client_connects_and_the_listener_keeps_accepting() {
        let endpoint = Endpoint::named(&format!("accept-probe-{}", std::process::id())).unwrap();
        let mut listener = Listener::bind(&endpoint).unwrap();
        for _ in 0..3 {
            let (server, client) = tokio::join!(listener.accept(), connect(&endpoint));
            drop((server.unwrap(), client.unwrap()));
        }
    }
}

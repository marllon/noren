//! Which addresses the app may hand to the system browser, without any Tauri dependency.
//!
//! A link in the terminal output is text written by whatever program ran there, so it is never
//! trusted: the page asks the person first (a dialog that shows the address), and this check runs
//! again on the Rust side, right before the system opens anything, so a page that skips its own
//! dialog still cannot open a file, a program or a `noren://` link through it.
//!
//! Only `http://` and `https://` addresses pass (the scheme in any case), and only a plain address:
//! no blanks, control characters or backslashes, a host after the scheme and no user name or
//! password in front of it (`https://good.example@evil.example` shows one host and opens another).

use std::fmt;

/// The longest address handed to the system, in bytes.
pub const MAX_LINK_BYTES: usize = 2048;

/// Why an address cannot be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    /// Empty, or longer than [`MAX_LINK_BYTES`].
    Size,
    /// Not `http://` or `https://`.
    Scheme,
    /// A blank, a control character or a backslash.
    Characters,
    /// Nothing between the scheme and the first `/`, `?` or `#`.
    NoHost,
    /// A user name or password before the host.
    UserInfo,
}

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Size => write!(
                f,
                "The link is empty or longer than {MAX_LINK_BYTES} bytes."
            ),
            Self::Scheme => write!(f, "Only http and https links can be opened."),
            Self::Characters => write!(
                f,
                "The link has a blank, a control character or a backslash."
            ),
            Self::NoHost => write!(f, "The link has no host."),
            Self::UserInfo => write!(f, "The link has a user name or password before the host."),
        }
    }
}

impl std::error::Error for LinkError {}

/// The part of `address` after `http://` or `https://` (the scheme in any case), or `None`.
fn after_scheme(address: &str) -> Option<&str> {
    ["http://", "https://"].iter().find_map(|scheme| {
        let head = address.get(..scheme.len())?;
        head.eq_ignore_ascii_case(scheme)
            .then(|| &address[scheme.len()..])
    })
}

/// The address itself when it may be opened, else why not. The text is not changed.
pub fn check_external_link(address: &str) -> Result<&str, LinkError> {
    if address.is_empty() || address.len() > MAX_LINK_BYTES {
        return Err(LinkError::Size);
    }
    // Checked before the scheme so `javascript:alert(1)` and `file:///x` are "not http" and an
    // address that hides a control character behind `http://` is "characters".
    let Some(rest) = after_scheme(address) else {
        return Err(LinkError::Scheme);
    };
    if address
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(LinkError::Characters);
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err(LinkError::NoHost);
    }
    if authority.contains('@') {
        return Err(LinkError::UserInfo);
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_http_and_https_addresses_pass_unchanged() {
        for address in [
            "http://example.com",
            "https://example.com/",
            "HTTPS://Example.com/Path?q=1&r=2#frag",
            "http://127.0.0.1:8080/a",
            "https://[::1]:3000/",
            "https://example.com/a%20b",
            "https://example.com/?next=https://other.example/@x",
        ] {
            assert_eq!(check_external_link(address), Ok(address), "{address}");
        }
    }

    #[test]
    fn every_other_scheme_is_refused() {
        for address in [
            "file:///C:/Windows/System32/calc.exe",
            "file://server/share/x",
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "noren://open?path=/home",
            "ms-msdt:/id PCWDiagnostic",
            "ftp://example.com/",
            "ssh://example.com",
            "mailto:a@example.com",
            "vbscript:msgbox(1)",
            "blob:http://example.com/1",
            "//example.com/path",
            "example.com",
            "C:\\Windows\\notepad.exe",
            "/etc/passwd",
            "httpx://example.com",
            "http:/example.com",
            "http:example.com",
            " https://example.com",
        ] {
            assert!(check_external_link(address).is_err(), "{address}");
        }
        assert_eq!(check_external_link("file:///x"), Err(LinkError::Scheme));
    }

    #[test]
    fn blanks_control_characters_and_backslashes_are_refused() {
        for address in [
            "https://example.com/a b",
            "https://example.com/\n",
            "https://example.com/\r\nHost: x",
            "https://example.com/\u{0}",
            "https://example.com/\t",
            "https://example.com\\@evil.example",
            "https://example.com/\u{85}",
            "https://example.com/\u{a0}",
            "https://example.com/ ",
        ] {
            assert_eq!(
                check_external_link(address),
                Err(LinkError::Characters),
                "{address:?}"
            );
        }
    }

    #[test]
    fn an_address_without_a_host_is_refused() {
        for address in [
            "https://",
            "http:///etc/passwd",
            "https://?x",
            "https://#x",
            "http://",
        ] {
            assert_eq!(
                check_external_link(address),
                Err(LinkError::NoHost),
                "{address}"
            );
        }
    }

    #[test]
    fn a_user_name_or_password_before_the_host_is_refused() {
        for address in [
            "https://good.example@evil.example/",
            "https://user:pass@example.com",
            "http://@example.com",
        ] {
            assert_eq!(
                check_external_link(address),
                Err(LinkError::UserInfo),
                "{address}"
            );
        }
    }

    #[test]
    fn an_empty_or_huge_address_is_refused() {
        assert_eq!(check_external_link(""), Err(LinkError::Size));
        let long = format!("https://example.com/{}", "a".repeat(MAX_LINK_BYTES));
        assert_eq!(check_external_link(&long), Err(LinkError::Size));
        let limit = format!(
            "https://example.com/{}",
            "a".repeat(MAX_LINK_BYTES - "https://example.com/".len())
        );
        assert_eq!(check_external_link(&limit), Ok(limit.as_str()));
    }

    #[test]
    fn a_multibyte_head_does_not_panic() {
        // `get(..n)` on a boundary inside a character must be a refusal, not a panic.
        for address in ["ééééééééé", "https:é//x", "日本語日本語日本語"] {
            assert!(check_external_link(address).is_err(), "{address}");
        }
    }
}

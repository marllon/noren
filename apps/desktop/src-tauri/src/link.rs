//! Opening a link of the terminal in the system browser.
//!
//! The page asks the person first and then calls `link_open`; this side checks the address again
//! (`noren_core::check_external_link`: only `http` and `https`, no blanks, no user name) and only
//! then hands it to the system. Nothing else in the app opens a web address: there is no opener
//! plugin, so the page cannot ask the system to open a file or a program through it.

use std::io;

/// Checks `url` and gives it to `open`; the system is `open::that_detached`, a test hands in its own.
fn open_checked(url: &str, open: impl FnOnce(&str) -> io::Result<()>) -> Result<(), String> {
    let checked = noren_core::check_external_link(url).map_err(|e| e.to_string())?;
    open(checked).map_err(|e| format!("Could not open the link: {e}"))
}

/// Opens an `http` or `https` address in the browser of the system. Any other address is refused.
#[tauri::command]
pub fn link_open(url: String) -> Result<(), String> {
    open_checked(&url, |checked| open::that_detached(checked))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn a_web_address_reaches_the_system_unchanged() {
        let seen = RefCell::new(Vec::new());
        let result = open_checked("https://example.com/a?b=1", |url| {
            seen.borrow_mut().push(url.to_owned());
            Ok(())
        });
        assert_eq!(result, Ok(()));
        assert_eq!(seen.into_inner(), ["https://example.com/a?b=1"]);
    }

    #[test]
    fn nothing_but_a_web_address_reaches_the_system() {
        for url in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "noren://action?path=/p&id=build",
            "calc.exe",
            "C:\\Windows\\notepad.exe",
            "https://user@example.com",
            "https://example.com/ with space",
            "",
        ] {
            let result = open_checked(url, |_| panic!("the system was asked to open {url:?}"));
            assert!(result.is_err(), "{url:?}");
        }
    }

    #[test]
    fn a_system_that_cannot_open_it_is_an_error_with_a_sentence() {
        let result = open_checked("https://example.com", |_| {
            Err(io::Error::new(io::ErrorKind::NotFound, "no browser"))
        });
        assert_eq!(
            result,
            Err("Could not open the link: no browser".to_owned())
        );
    }
}

//! The hosts of the user's `~/.ssh/config`, for the live group of SSH hosts. No Tauri dependency.
//!
//! [`parse_ssh_hosts`] is a pure function over the text of the file; [`read_ssh_hosts_from`] and
//! [`read_ssh_hosts`] read the file first. Only the `Host` lines count. The keyword is read without
//! regard to case, the value may follow a space or an `=` (`Host=a`), a line may name several hosts
//! (each one is an entry), and a `#` starts a comment. A name is kept only when it is safe to type
//! into a shell as `ssh <name>` ([`is_safe_host_name`]): letters, digits, `.`, `-` and `_`, not
//! starting with `-` (it would be read as an option). That drops, on purpose, a name with a wildcard
//! (`*`, `?`, `!`), a space, a quote or a `;`. `Include` and `Match` are not followed or read: the
//! hosts of an included file are not listed, and a `Match` block is skipped (a `Host` line after it
//! still counts, as a `Host` line starts a block of its own). A host named twice shows once, at its
//! first place. A file that is not there is no hosts and no error.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// The largest `config` read; a larger file is refused rather than loaded.
pub const MAX_SSH_CONFIG_BYTES: u64 = 1024 * 1024;

/// The longest host name kept.
pub const MAX_SSH_HOST_CHARS: usize = 255;

/// Whether `name` may be typed into a shell as the argument of `ssh`: letters, digits, `.`, `-` and
/// `_` only (so no space, quote, `;`, wildcard or `=`), not empty, not starting with `-`.
pub fn is_safe_host_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_SSH_HOST_CHARS
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The hosts named by the `Host` lines of an `ssh_config` text, in order, each one once.
pub fn parse_ssh_hosts(text: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let keyword_end = line
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(line.len());
        let (keyword, rest) = line.split_at(keyword_end);
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        // One `=` may sit between the keyword and the value, with blanks around it.
        let rest = rest.trim_start();
        let rest = rest.strip_prefix('=').unwrap_or(rest);
        for word in rest.split_whitespace() {
            if word.starts_with('#') {
                break;
            }
            if is_safe_host_name(word) && !hosts.iter().any(|known| known == word) {
                hosts.push(word.to_owned());
            }
        }
    }
    hosts
}

/// The hosts of the `config` file at `path`. A file that is not there gives no hosts. Fails with a
/// sentence when the file cannot be read or is larger than [`MAX_SSH_CONFIG_BYTES`].
pub fn read_ssh_hosts_from(path: &Path) -> Result<Vec<String>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SSH_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if bytes.len() as u64 > MAX_SSH_CONFIG_BYTES {
        return Err(format!(
            "{} is larger than {MAX_SSH_CONFIG_BYTES} bytes",
            path.display()
        ));
    }
    Ok(parse_ssh_hosts(&String::from_utf8_lossy(&bytes)))
}

/// `<home>/.ssh/config`.
pub fn ssh_config_path(home: &Path) -> PathBuf {
    home.join(".ssh").join("config")
}

/// The hosts of the `~/.ssh/config` of the user running the app (`HOME`, else `USERPROFILE`). No
/// home folder is no hosts.
pub fn read_ssh_hosts() -> Result<Vec<String>, String> {
    let home = ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(std::env::var_os)
        .find(|value| !value.is_empty());
    match home {
        Some(home) => read_ssh_hosts_from(&ssh_config_path(Path::new(&home))),
        None => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(text: &str) -> Vec<String> {
        parse_ssh_hosts(text)
    }

    #[test]
    fn lists_the_host_lines_in_order() {
        let text =
            "Host web-1\n  HostName 10.0.0.1\n  User deploy\n\nHost db.internal\n  Port 2222\n";
        assert_eq!(hosts(text), ["web-1", "db.internal"]);
    }

    #[test]
    fn one_line_with_several_names_makes_several_entries() {
        assert_eq!(hosts("Host a b\tc   d_e\n"), ["a", "b", "c", "d_e"]);
    }

    #[test]
    fn the_keyword_ignores_case_and_accepts_an_equals_sign() {
        let text = "HOST upper\nhost lower\nHost=eq\nHost = spaced\nhOsT\t=\ttabbed\n";
        assert_eq!(hosts(text), ["upper", "lower", "eq", "spaced", "tabbed"]);
    }

    #[test]
    fn other_keywords_that_start_with_host_are_not_hosts() {
        let text = "Host a\n  HostName b\n  HostKeyAlias c\nHostbasedAuthentication yes\n";
        assert_eq!(hosts(text), ["a"]);
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let text =
            "# Host hidden\n   # Host also-hidden\n\nHost shown # trailing note\nHost other#x\n";
        assert_eq!(hosts(text), ["shown"]);
    }

    #[test]
    fn names_with_wildcards_are_ignored() {
        let text = "Host *\nHost *.example.com\nHost web?\nHost !skip real\nHost a*b ok\n";
        assert_eq!(hosts(text), ["real", "ok"]);
    }

    #[test]
    fn include_and_match_are_not_followed() {
        let text = "Include ~/.ssh/other\nInclude=conf.d/*\nMatch host from-match\n  User x\nHost kept\nMatch all\n";
        assert_eq!(hosts(text), ["kept"]);
    }

    #[test]
    fn a_host_named_twice_shows_once_at_its_first_place() {
        assert_eq!(hosts("Host a b\nHost b c a\nHost a\n"), ["a", "b", "c"]);
    }

    #[test]
    fn a_name_that_is_not_safe_to_type_is_dropped() {
        let unsafe_names = [
            "a;rm",
            "a&b",
            "a|b",
            "a`b`",
            "a$b",
            "a$(x)",
            "'a'",
            "\"a\"",
            "a\\b",
            "a/b",
            "a>b",
            "a<b",
            "a:b",
            "a@b",
            "-oProxyCommand=x",
            "-v",
            "a=b",
            "a(b)",
            "a{b}",
            "é",
        ];
        for name in unsafe_names {
            assert!(!is_safe_host_name(name), "{name} should be unsafe");
            assert!(
                hosts(&format!("Host {name}\n")).is_empty(),
                "{name} was listed"
            );
        }
        // A quoted name with a space comes apart into pieces that are not safe either.
        assert!(hosts("Host \"my box\"\n").is_empty());
        // The safe names around it stay.
        assert_eq!(hosts("Host good ba;d fine\n"), ["good", "fine"]);
    }

    #[test]
    fn the_safe_names_are_letters_digits_dot_hyphen_underscore() {
        for name in [
            "a",
            "A1",
            "web-1",
            "db.internal",
            "build_box",
            "1.2.3.4",
            "a-",
        ] {
            assert!(is_safe_host_name(name), "{name} should be safe");
        }
        assert!(!is_safe_host_name(""));
        assert!(!is_safe_host_name(&"a".repeat(MAX_SSH_HOST_CHARS + 1)));
        assert!(is_safe_host_name(&"a".repeat(MAX_SSH_HOST_CHARS)));
    }

    #[test]
    fn crlf_lines_and_an_empty_text_work() {
        assert_eq!(hosts("Host a\r\nHost b\r\n"), ["a", "b"]);
        assert!(hosts("").is_empty());
        assert!(hosts("Host\nHost =\n").is_empty());
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("noren-ssh-config-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_missing_file_is_no_hosts_and_no_error() {
        let dir = scratch_dir("missing");
        assert_eq!(read_ssh_hosts_from(&dir.join("config")), Ok(Vec::new()));
        // Not even the .ssh folder is there.
        assert_eq!(read_ssh_hosts_from(&ssh_config_path(&dir)), Ok(Vec::new()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_the_file_of_a_fake_home() {
        let dir = scratch_dir("home");
        let path = ssh_config_path(&dir);
        fs::create_dir_all(path.parent().expect("parent")).expect(".ssh");
        fs::write(&path, b"Host web\n  HostName 10.0.0.1\nHost db *.wild\n").expect("config");
        assert_eq!(
            read_ssh_hosts_from(&path),
            Ok(vec!["web".to_owned(), "db".to_owned()])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bytes_that_are_not_utf8_do_not_stop_the_read() {
        let dir = scratch_dir("bytes");
        let path = dir.join("config");
        fs::write(&path, b"# caf\xe9\nHost ok\n").expect("config");
        assert_eq!(read_ssh_hosts_from(&path), Ok(vec!["ok".to_owned()]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_too_large_is_refused() {
        let dir = scratch_dir("large");
        let path = dir.join("config");
        let mut text = b"Host a\n".to_vec();
        text.resize(MAX_SSH_CONFIG_BYTES as usize + 1, b'#');
        fs::write(&path, text).expect("config");
        let error = read_ssh_hosts_from(&path).expect_err("too large");
        assert!(error.contains("larger"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_in_place_of_the_file_is_an_error_not_a_panic() {
        let dir = scratch_dir("folder");
        assert!(read_ssh_hosts_from(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}

//! Where the API keys of the AI providers are kept: the keychain of the system, behind a trait.
//!
//! A key is never written to a file of Noren, to the config, to the state or to a log. The code
//! above this module talks to [`KeyVault`]; the app plugs in [`KeyringVault`] (Credential Manager
//! on Windows, the Keychain on macOS, the Secret Service on Linux) and the tests plug in
//! [`MemoryVault`], so no test touches the keychain of the person running it.
//!
//! One entry per provider: the service is [`SERVICE`] (`noren`) and the user name is the provider
//! id. The id is checked before it reaches the system (see [`is_valid_provider_id`]), and no error
//! text of this module ever contains a key.
//!
//! The vault also keeps the secrets of the app itself, each under a fixed name that is not shaped
//! like a provider id ([`SYNC_GIST_TOKEN_ENTRY`]), so no provider the settings can declare has the
//! name of one of them, and the secret of the sync can never be read as the key of a provider and
//! sent to the address of one.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

/// The service name of every entry in the system keychain.
pub const SERVICE: &str = "noren";

/// Longest provider id, in bytes.
pub const MAX_PROVIDER_ID_LEN: usize = 64;

/// The entry that holds the token of the sync through a gist. A `:` is not allowed in a provider
/// id, so this name can never be the id of a provider.
pub const SYNC_GIST_TOKEN_ENTRY: &str = "sync:gist-token";

/// The names of the secrets of the app itself (see the top of this file).
const APP_ENTRIES: [&str; 1] = [SYNC_GIST_TOKEN_ENTRY];

/// Longest key accepted, in characters. Real keys have well under 200; the Windows credential
/// store itself refuses a secret much longer than this, so a longer text is a paste mistake and
/// is refused with a clear message instead of an opaque one from the system.
pub const MAX_KEY_CHARS: usize = 1024;

/// Whether `id` can name a provider: 1 to [`MAX_PROVIDER_ID_LEN`] ASCII letters, digits, `-` or
/// `_`, starting with a letter or a digit. The same shape serves the ids of the requests in
/// flight.
pub fn is_valid_provider_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_PROVIDER_ID_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
}

/// Why the vault could not do what was asked. None of the texts holds a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// The provider id is not shaped like one (see [`is_valid_provider_id`]).
    InvalidProviderId,
    /// The key is empty or too long.
    InvalidKey(String),
    /// The keychain of the system answered with an error, or there is none.
    Unavailable(String),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::InvalidProviderId => f.write_str(
                "the provider id must be 1 to 64 letters, digits, '-' or '_', starting with a letter or digit",
            ),
            VaultError::InvalidKey(reason) => f.write_str(reason),
            VaultError::Unavailable(reason) => {
                write!(f, "the system keychain is not available: {reason}")
            }
        }
    }
}

impl std::error::Error for VaultError {}

/// A place for the keys of the providers. Implementations validate the provider id themselves
/// (use [`check`]).
pub trait KeyVault: Send + Sync {
    /// The key of the provider, or `None` when none is stored.
    fn get(&self, provider_id: &str) -> Result<Option<String>, VaultError>;
    /// Stores the key, replacing the one there. An empty key is refused: use [`KeyVault::delete`].
    fn set(&self, provider_id: &str, key: &str) -> Result<(), VaultError>;
    /// Removes the key. A provider with no key is not an error.
    fn delete(&self, provider_id: &str) -> Result<(), VaultError>;
}

/// Whether `name` is one of the fixed names of the secrets of the app itself.
pub fn is_app_entry(name: &str) -> bool {
    APP_ENTRIES.contains(&name)
}

/// The checks every vault makes before it touches its store: the name is a provider id or one of
/// the fixed names of the app ([`is_app_entry`]).
pub fn check(provider_id: &str, key: Option<&str>) -> Result<(), VaultError> {
    if !is_valid_provider_id(provider_id) && !is_app_entry(provider_id) {
        return Err(VaultError::InvalidProviderId);
    }
    if let Some(key) = key {
        if key.is_empty() {
            return Err(VaultError::InvalidKey("the key is empty".to_string()));
        }
        if key.chars().count() > MAX_KEY_CHARS {
            return Err(VaultError::InvalidKey(format!(
                "the key is longer than {MAX_KEY_CHARS} characters"
            )));
        }
    }
    Ok(())
}

/// The keychain of the system, through the `keyring` crate: the entry has the service
/// [`SERVICE`] and the provider id as user name. Creating one reads nothing; the keychain is
/// touched only by `get`, `set` and `delete`.
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringVault;

impl KeyringVault {
    pub fn new() -> Self {
        KeyringVault
    }
}

#[cfg(any(windows, unix))]
mod native {
    use super::*;

    fn entry(provider_id: &str) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new(SERVICE, provider_id).map_err(unavailable)
    }

    fn unavailable(error: keyring::Error) -> VaultError {
        VaultError::Unavailable(error.to_string())
    }

    impl KeyVault for KeyringVault {
        fn get(&self, provider_id: &str) -> Result<Option<String>, VaultError> {
            check(provider_id, None)?;
            match entry(provider_id)?.get_password() {
                Ok(key) => Ok(Some(key)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(error) => Err(unavailable(error)),
            }
        }

        fn set(&self, provider_id: &str, key: &str) -> Result<(), VaultError> {
            check(provider_id, Some(key))?;
            entry(provider_id)?.set_password(key).map_err(unavailable)
        }

        fn delete(&self, provider_id: &str) -> Result<(), VaultError> {
            check(provider_id, None)?;
            match entry(provider_id)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(unavailable(error)),
            }
        }
    }
}

#[cfg(not(any(windows, unix)))]
mod native {
    use super::*;

    fn none() -> VaultError {
        VaultError::Unavailable("this system has no supported keychain".to_string())
    }

    impl KeyVault for KeyringVault {
        fn get(&self, provider_id: &str) -> Result<Option<String>, VaultError> {
            check(provider_id, None)?;
            Err(none())
        }

        fn set(&self, provider_id: &str, key: &str) -> Result<(), VaultError> {
            check(provider_id, Some(key))?;
            Err(none())
        }

        fn delete(&self, provider_id: &str) -> Result<(), VaultError> {
            check(provider_id, None)?;
            Err(none())
        }
    }
}

/// A vault that keeps the keys in memory and forgets them when it is dropped. For the tests and
/// for the runs that must not touch the keychain of the person (the smoke runs).
#[derive(Default)]
pub struct MemoryVault {
    keys: Mutex<HashMap<String, String>>,
    broken: bool,
}

impl MemoryVault {
    pub fn new() -> Self {
        Self::default()
    }

    /// A vault whose every call fails as `Unavailable`, like a system with no keychain service.
    pub fn broken() -> Self {
        MemoryVault {
            keys: Mutex::new(HashMap::new()),
            broken: true,
        }
    }

    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.keys.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fail_if_broken(&self) -> Result<(), VaultError> {
        if self.broken {
            Err(VaultError::Unavailable(
                "the test vault is broken".to_string(),
            ))
        } else {
            Ok(())
        }
    }
}

// The keys stay out of `{:?}`: a vault inside a struct that is printed must not print them.
impl fmt::Debug for MemoryVault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryVault")
            .field("entries", &self.keys().len())
            .field("broken", &self.broken)
            .finish()
    }
}

impl KeyVault for MemoryVault {
    fn get(&self, provider_id: &str) -> Result<Option<String>, VaultError> {
        check(provider_id, None)?;
        self.fail_if_broken()?;
        Ok(self.keys().get(provider_id).cloned())
    }

    fn set(&self, provider_id: &str, key: &str) -> Result<(), VaultError> {
        check(provider_id, Some(key))?;
        self.fail_if_broken()?;
        self.keys().insert(provider_id.to_string(), key.to_string());
        Ok(())
    }

    fn delete(&self, provider_id: &str) -> Result<(), VaultError> {
        check(provider_id, None)?;
        self.fail_if_broken()?;
        self.keys().remove(provider_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_have_a_plain_shape() {
        for good in ["ollama", "openai", "my-proxy_2", "A1", "0", &"a".repeat(64)] {
            assert!(is_valid_provider_id(good), "{good:?}");
        }
        for bad in [
            "",
            "-x",
            "_x",
            "a b",
            "a/b",
            "a\\b",
            "a:b",
            "a.b",
            "é",
            "a\0b",
            "a\nb",
            "../x",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_provider_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn sets_gets_replaces_and_deletes_a_key() {
        let vault = MemoryVault::new();
        assert_eq!(vault.get("openai"), Ok(None));
        vault.set("openai", "sk-one").expect("set");
        assert_eq!(vault.get("openai"), Ok(Some("sk-one".to_string())));
        vault.set("openai", "sk-two").expect("replace");
        assert_eq!(vault.get("openai"), Ok(Some("sk-two".to_string())));
        // Another provider is another entry.
        assert_eq!(vault.get("anthropic"), Ok(None));
        vault.delete("openai").expect("delete");
        assert_eq!(vault.get("openai"), Ok(None));
        // Removing what is not there is fine.
        assert_eq!(vault.delete("openai"), Ok(()));
    }

    #[test]
    fn refuses_a_bad_provider_id_in_every_call() {
        let vault = MemoryVault::new();
        assert_eq!(vault.get("a/b"), Err(VaultError::InvalidProviderId));
        assert_eq!(vault.set("", "k"), Err(VaultError::InvalidProviderId));
        assert_eq!(vault.delete("a b"), Err(VaultError::InvalidProviderId));
        // The real vault refuses before it asks the system anything, so this is safe to run.
        let real = KeyringVault::new();
        assert_eq!(real.get("../x"), Err(VaultError::InvalidProviderId));
        assert_eq!(real.set("a b", "k"), Err(VaultError::InvalidProviderId));
        assert_eq!(real.delete(""), Err(VaultError::InvalidProviderId));
    }

    #[test]
    fn refuses_an_empty_or_huge_key() {
        let vault = MemoryVault::new();
        assert!(matches!(
            vault.set("openai", ""),
            Err(VaultError::InvalidKey(_))
        ));
        let huge = "k".repeat(MAX_KEY_CHARS + 1);
        let error = vault.set("openai", &huge).expect_err("too long");
        assert!(matches!(error, VaultError::InvalidKey(_)));
        assert!(!error.to_string().contains(&huge));
        assert_eq!(vault.get("openai"), Ok(None));
        vault
            .set("openai", &"k".repeat(MAX_KEY_CHARS))
            .expect("the longest key");
    }

    #[test]
    fn a_broken_vault_reports_unavailable_without_a_key_in_the_text() {
        let vault = MemoryVault::broken();
        for result in [
            vault.get("openai").map(|_| ()),
            vault.set("openai", "sk-secret"),
            vault.delete("openai"),
        ] {
            let error = result.expect_err("broken");
            assert!(matches!(error, VaultError::Unavailable(_)));
            assert!(!error.to_string().contains("sk-secret"));
        }
    }

    #[test]
    fn debug_output_does_not_show_the_keys() {
        let vault = MemoryVault::new();
        vault.set("openai", "sk-secret").expect("set");
        let shown = format!("{vault:?}");
        assert!(!shown.contains("sk-secret"), "{shown}");
        assert!(shown.contains('1'));
    }

    #[test]
    fn the_token_of_the_sync_has_a_name_no_provider_can_have() {
        // A provider the settings declare must have a valid id, and this name is not one: so no
        // provider reads the token of the sync as its key and sends it to its address.
        assert!(!is_valid_provider_id(SYNC_GIST_TOKEN_ENTRY));
        assert!(is_app_entry(SYNC_GIST_TOKEN_ENTRY));
        assert!(!is_app_entry("openai"));
        assert!(!is_app_entry("sync:other"));
        let vault = MemoryVault::new();
        vault.set(SYNC_GIST_TOKEN_ENTRY, "ghp_secret").expect("set");
        assert_eq!(
            vault.get(SYNC_GIST_TOKEN_ENTRY),
            Ok(Some("ghp_secret".to_string()))
        );
        // No provider id reads it, and an id with a colon that is not a name of the app is refused.
        assert_eq!(vault.get("sync"), Ok(None));
        assert_eq!(vault.get("sync:other"), Err(VaultError::InvalidProviderId));
        assert_eq!(
            vault.set("sync:other", "k"),
            Err(VaultError::InvalidProviderId)
        );
        vault.delete(SYNC_GIST_TOKEN_ENTRY).expect("delete");
        assert_eq!(vault.get(SYNC_GIST_TOKEN_ENTRY), Ok(None));
        // The real vault accepts the name too, but this test never asks the system anything.
        assert_eq!(
            KeyringVault::new().get("sync:other"),
            Err(VaultError::InvalidProviderId)
        );
    }

    #[test]
    fn the_entry_is_named_noren_with_the_provider_id() {
        // The names the entry has in the system keychain (Credential Manager shows them as
        // `<id>.noren`); a change here would orphan every key a person saved.
        assert_eq!(SERVICE, "noren");
    }
}

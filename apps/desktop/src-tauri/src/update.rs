//! The update of the app itself (NOR-F20-02a): finding a newer version and installing it, only when
//! the interface asks. Nothing here runs by itself: no check at start, no download the person did
//! not ask for, no install without the command `update_install`, which the interface sends when the
//! person clicks (or runs the palette command) after being told what version is waiting.
//!
//! **Who does what.** `noren_core::update` gets the bytes: the feed and the package, over `https`
//! only, with a ceiling on the size and a deadline on the time (the plugin's own requests have
//! neither, so the plugin is never asked to fetch anything). `tauri-plugin-updater` decides about
//! them: it reads the feed in the format of the Tauri updater and picks the entry of this platform
//! ([`Updater::restore_update`]), says whether the version is newer than the one running, checks the
//! minisign signature of the package against the public key of `tauri.conf.json`
//! ([`Update::verify`]; the signature must also say it was made for the version the feed announces,
//! `requireSignedVersion`, so a feed cannot pair a new number with an old signed package), and runs
//! the installer of the system ([`Update::install`], which checks the signature once more).
//!
//! **The steps.** `update_status` has no network: whether this build can update at all, the version
//! running and the update found by the last check. `update_check` gets the feed and keeps the update
//! it announces, if it is newer, for the install. `update_install` downloads the package of that
//! update, checks it and only then hands it to the installer; on Windows the installer is started and
//! the app exits, on the other systems the person restarts the app. A package whose signature does
//! not match the key, or that is not the file the signature was made for, is never installed.
//!
//! **The key** is `plugins > updater > pubkey` of `tauri.conf.json`, the only place it is written. It
//! holds [`noren_core::PUBKEY_NOT_SET`] until the maintainer puts the real one there (NOR-F21-07);
//! until then `update_check` and `update_install` refuse, with the sentence that says why.
//!
//! The installer is behind [`PackageInstaller`] so a test can see what would be installed without
//! running an installer.

use std::sync::{Arc, Mutex, MutexGuard};

use noren_core::{
    UpdateError, UpdateFetcher, UpdateInfo, UpdateLimits, UpdateProgress, update_endpoint_of,
    update_key_is_set,
};
use serde::Serialize;
use serde_json::Value;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Window};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::lifecycle::MAIN_LABEL;
use crate::windows::require_owner;

/// The event with the progress of the download, sent to the main window.
pub const PROGRESS_EVENT: &str = "update-progress";

/// The name of the plugin in `tauri.conf.json` (`plugins > updater`).
const PLUGIN_NAME: &str = "updater";

/// A progress event is sent at most once for each this many bytes (and at the end).
const PROGRESS_STEP: u64 = 256 * 1024;

#[cfg(test)]
mod tests;

/// The updater plugin, as this app registers it: configured by `plugins > updater` of
/// `tauri.conf.json` (the key and the address), with one rule of its own: a version is newer only by
/// its precedence in semver, which leaves out the build metadata (`0.1.0+5` is `0.1.0`), as the
/// specification says and the `Ord` of the semver crate, which the plugin uses, does not. The plugin
/// makes no request of its own (see the top of this file) and its commands get no capability.
pub fn plugin<R: Runtime>() -> TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new()
        .default_version_comparator(|current, release| {
            let announced = &release.version;
            (
                announced.major,
                announced.minor,
                announced.patch,
                &announced.pre,
            ) > (current.major, current.minor, current.patch, &current.pre)
        })
        .build()
}

/// Installs a package whose signature was checked.
pub trait PackageInstaller: Send + Sync {
    /// Installs `package`, the bytes of the package announced by `update`.
    fn install(&self, update: &Update, package: Vec<u8>) -> Result<(), UpdateError>;
}

/// The installer of the system, through the plugin: on Windows it starts the installer and exits
/// the app, on Linux it replaces the AppImage or installs the package, on macOS it replaces the
/// bundle. It checks the signature once more before it touches anything.
struct SystemInstaller;

impl PackageInstaller for SystemInstaller {
    fn install(&self, update: &Update, package: Vec<u8>) -> Result<(), UpdateError> {
        update
            .install(package)
            .map_err(|error| UpdateError::Install(error.to_string()))
    }
}

/// An update found, kept until the person installs it.
#[derive(Clone)]
struct Pending {
    info: UpdateInfo,
    update: Update,
}

/// The update of the app: the fetcher of the endpoint of `tauri.conf.json`, the update the last
/// check found, and one step at a time.
pub struct UpdateState {
    fetcher: Result<UpdateFetcher, UpdateError>,
    key_set: bool,
    current_version: String,
    updating_allowed: bool,
    installer: Arc<dyn PackageInstaller>,
    pending: Mutex<Option<Pending>>,
    /// Held for the whole of a check or an install: a second step while one runs is refused.
    turn: tokio::sync::Mutex<()>,
}

impl UpdateState {
    /// The state of this app: the settings are the `plugins > updater` of its configuration.
    pub fn from_app<R: Runtime>(app: &AppHandle<R>) -> Self {
        let config = app
            .config()
            .plugins
            .0
            .get(PLUGIN_NAME)
            .cloned()
            .unwrap_or(Value::Null);
        Self::new(
            &config,
            app.package_info().version.to_string(),
            Arc::new(SystemInstaller),
            UpdateLimits::default(),
        )
    }

    /// A state over the plugin configuration `config`, for the version `current_version`.
    pub fn new(
        config: &Value,
        current_version: String,
        installer: Arc<dyn PackageInstaller>,
        limits: UpdateLimits,
    ) -> Self {
        Self {
            fetcher: update_endpoint_of(config)
                .and_then(|endpoint| UpdateFetcher::with_limits(&endpoint, limits)),
            key_set: update_key_is_set(config),
            current_version,
            updating_allowed: true,
            installer,
            pending: Mutex::new(None),
            turn: tokio::sync::Mutex::new(()),
        }
    }

    /// The same, but checking and installing refuse: the smoke run must neither reach the network
    /// nor start an installer. The status is only a read.
    pub fn without_updating(mut self) -> Self {
        self.updating_allowed = false;
        self
    }

    fn pending(&self) -> MutexGuard<'_, Option<Pending>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The fetcher, when this build may check and install: updating is allowed, there is a key to
    /// check packages against, and the endpoint is usable.
    fn ready(&self) -> Result<&UpdateFetcher, UpdateError> {
        if !self.updating_allowed {
            return Err(UpdateError::Off);
        }
        if !self.key_set {
            return Err(UpdateError::NotConfigured);
        }
        self.fetcher.as_ref().map_err(Clone::clone)
    }

    /// Where the update stands, with no network.
    pub fn status(&self) -> UpdateStatusDto {
        UpdateStatusDto {
            configured: self.key_set && self.fetcher.is_ok(),
            current_version: self.current_version.clone(),
            pending: self
                .pending()
                .as_ref()
                .map(|pending| UpdateInfoDto::from(&pending.info)),
        }
    }

    /// Gets the feed and says whether it announces a newer version with a package for this
    /// platform. The update it announces is kept for [`Self::install`]; `None` (and nothing kept)
    /// when there is none. The signature is not looked at yet: that is for the install, which
    /// is the first time the package is in hand.
    pub async fn check<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<Option<UpdateInfo>, UpdateError> {
        let fetcher = self.ready()?;
        let _turn = self.turn.try_lock().map_err(|_| UpdateError::Busy)?;
        let Some(feed) = fetcher.feed().await? else {
            *self.pending() = None;
            return Ok(None);
        };
        let updater = app
            .updater_builder()
            .build()
            .map_err(|error| refusal(&error))?;
        match updater
            .restore_update(feed)
            .map_err(|error| refusal(&error))?
        {
            Some(update) => {
                let info = UpdateInfo::new(
                    &update.version,
                    &update.current_version,
                    update.body.as_deref(),
                    update.date.map(|date| date.unix_timestamp()),
                );
                *self.pending() = Some(Pending {
                    info: info.clone(),
                    update,
                });
                Ok(Some(info))
            }
            None => {
                *self.pending() = None;
                Ok(None)
            }
        }
    }

    /// Downloads the package of the update the last check found, checks its signature and hands it
    /// to the installer. `on_progress` is told how much has come. Refuses when no update was found,
    /// and installs nothing when the package is not the one the signature was made for.
    pub async fn install(
        &self,
        on_progress: impl FnMut(UpdateProgress),
    ) -> Result<(), UpdateError> {
        let fetcher = self.ready()?;
        let _turn = self.turn.try_lock().map_err(|_| UpdateError::Busy)?;
        let Pending { update, .. } = self
            .pending()
            .clone()
            .ok_or(UpdateError::NothingToInstall)?;
        let package = fetcher
            .package(update.download_url.as_str(), on_progress)
            .await?;
        // Before the bytes go anywhere: the installer checks again, this is the refusal that says why.
        update.verify(&package).map_err(|error| refusal(&error))?;
        let installer = Arc::clone(&self.installer);
        let installed = update.clone();
        tauri::async_runtime::spawn_blocking(move || installer.install(&installed, package))
            .await
            .map_err(|error| UpdateError::Install(error.to_string()))??;
        *self.pending() = None;
        Ok(())
    }
}

/// What the plugin refused, as a sentence for the person.
fn refusal(error: &tauri_plugin_updater::Error) -> UpdateError {
    use tauri_plugin_updater::Error as E;
    match error {
        E::TargetNotFound(_) | E::TargetsNotFound(_) => {
            UpdateError::Refused("the release has no package for this platform".to_owned())
        }
        E::Minisign(_) => UpdateError::Refused(
            "the signature does not match the package and the update key".to_owned(),
        ),
        E::Base64(_) | E::SignatureUtf8(_) => {
            UpdateError::Refused("the signature or the update key is not valid text".to_owned())
        }
        E::SignedVersionMismatch { signed, announced } => UpdateError::Refused(format!(
            "the package was signed for version {signed}, not for {announced}"
        )),
        E::MissingSignedVersion => UpdateError::Refused(
            "the signature does not say which version it was made for".to_owned(),
        ),
        E::Serialization(_) | E::Semver(_) | E::UrlParse(_) => {
            UpdateError::BadFeed("it does not follow the format of the updater".to_owned())
        }
        other => UpdateError::Refused(other.to_string()),
    }
}

/// Whether a download that now has `progress` is worth an event, given the size at the last event
/// (`0` before the first): the first piece, one every [`PROGRESS_STEP`] bytes and the last.
fn worth_telling(last_told: &mut u64, progress: UpdateProgress) -> bool {
    let done = progress.total == Some(progress.downloaded);
    if *last_told == 0 || done || progress.downloaded.saturating_sub(*last_told) >= PROGRESS_STEP {
        *last_told = progress.downloaded;
        true
    } else {
        false
    }
}

/// A newer version, as the interface sees it (see [`UpdateInfo`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    /// When it was published, in seconds since 1970.
    pub published_at: Option<i64>,
}

impl From<&UpdateInfo> for UpdateInfoDto {
    fn from(info: &UpdateInfo) -> Self {
        Self {
            version: info.version.clone(),
            current_version: info.current_version.clone(),
            notes: info.notes.clone(),
            published_at: info.published_at,
        }
    }
}

/// Where the update stands, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusDto {
    /// This build has a key and an address to update from. Without it a check is refused.
    pub configured: bool,
    pub current_version: String,
    /// The update the last check found, not installed yet.
    pub pending: Option<UpdateInfoDto>,
}

/// The progress of the download, as the interface sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressDto {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Where the update stands, with no network: whether this build can update, the version running and
/// the update the last check found.
#[tauri::command]
pub fn update_status(state: State<'_, Arc<UpdateState>>) -> UpdateStatusDto {
    state.status()
}

/// Gets the feed and tells whether a newer version is waiting (`null` when there is none). Installs
/// nothing.
#[tauri::command]
pub async fn update_check<R: Runtime>(
    window: Window<R>,
    state: State<'_, Arc<UpdateState>>,
) -> Result<Option<UpdateInfoDto>, String> {
    require_owner(&window)?;
    let state = Arc::clone(&state);
    state
        .check(window.app_handle())
        .await
        .map(|found| found.as_ref().map(UpdateInfoDto::from))
        .map_err(|error| error.to_string())
}

/// Downloads the update the last check found, checks it and installs it. Only the interface calls
/// it, after the person asked for it. On Windows the app exits when the installer starts.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    window: Window<R>,
    state: State<'_, Arc<UpdateState>>,
) -> Result<(), String> {
    require_owner(&window)?;
    let state = Arc::clone(&state);
    let app = window.app_handle().clone();
    let mut last_told = 0;
    state
        .install(move |progress| {
            if worth_telling(&mut last_told, progress) {
                // A failed emit means the interface is gone; the install goes on without it.
                let _ = app.emit_to(
                    MAIN_LABEL,
                    PROGRESS_EVENT,
                    UpdateProgressDto {
                        downloaded: progress.downloaded,
                        total: progress.total,
                    },
                );
            }
        })
        .await
        .map_err(|error| error.to_string())
}

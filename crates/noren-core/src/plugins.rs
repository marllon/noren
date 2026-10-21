//! The plugins of the user, without any Tauri dependency: the folder `plugins/` next to
//! `config.jsonc`, one folder per plugin (`plugins/<id>/plugin.json` and the file `main` names).
//!
//! The app only reads this folder: a plugin is a folder the person puts there (or copies from
//! `examples/plugins/`). Like the other stores this one keeps text and does not judge it: whether
//! `plugin.json` is a valid manifest, and whether its `id` is the name of the folder, is for the
//! interface (`checkPluginFolders` of `@noren/model`). What is checked here is what only the file
//! system can say.
//!
//! - **Listing** answers one [`PluginFolder`] per folder, by name, with either the text of the
//!   manifest and of the main file or a short sentence about why the folder is not a plugin. A file
//!   in `plugins/`, a name that starts with a dot and everything past the first [`MAX_PLUGINS`] by
//!   name are left out. The folder is never created by a list, and nothing watches it: a plugin
//!   is read when the app asks.
//! - **The main file** is named by `main` in `plugin.json`: a relative path, with no `..`, no drive,
//!   no `:` (so no stream of a file either), no device name of Windows, and it must end up, once
//!   every link is followed, inside the folder of the plugin. It must be a file of UTF-8 text no
//!   larger than [`MAX_PLUGIN_FILE_BYTES`], like `plugin.json` itself.

use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use crate::mods::is_reserved_name;

/// Name of the folder inside the config folder of the app.
pub const PLUGINS_DIR_NAME: &str = "plugins";

/// Name of the manifest inside the folder of a plugin.
pub const MANIFEST_FILE_NAME: &str = "plugin.json";

/// The largest file read, the manifest and the main file each. A plugin is a few KiB of JavaScript;
/// this only stops a file that is not one from being read whole.
pub const MAX_PLUGIN_FILE_BYTES: u64 = 256 * 1024;

/// The most plugin folders listed (the first ones by name).
pub const MAX_PLUGINS: usize = 50;

/// Errors returned by [`PluginStore`].
#[derive(Debug)]
pub enum PluginError {
    /// The folder could not be read.
    Read(io::Error),
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read(source) => write!(f, "could not read the plugins folder: {source}"),
        }
    }
}

impl std::error::Error for PluginError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(source) => Some(source),
        }
    }
}

/// What a plugin folder holds: the text of `plugin.json` and of the file its `main` names, exactly
/// as the files hold them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginFiles {
    pub manifest: String,
    pub main: String,
}

/// One folder of `plugins/`: its name and the files read from it, or why it is not a plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginFolder {
    pub folder: String,
    pub files: Result<PluginFiles, String>,
}

/// The folder of the plugins of the user.
#[derive(Debug)]
pub struct PluginStore {
    dir: PathBuf,
}

impl PluginStore {
    /// A store for the folder `dir`. Nothing is touched on disk until a method runs.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Path of the folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Every folder of the plugins folder (see the top of this file), in the order of the names. A
    /// folder that does not exist is no plugins. The folder is never created here.
    pub fn list(&self) -> Result<Vec<PluginFolder>, PluginError> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(PluginError::Read(error)),
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| !name.starts_with('.'))
            .collect();
        names.sort();

        let mut folders = Vec::new();
        for name in names {
            if folders.len() == MAX_PLUGINS {
                break;
            }
            let path = self.dir.join(&name);
            // `metadata` follows a link: a link to a folder is a plugin folder the person chose.
            if !fs::metadata(&path).is_ok_and(|metadata| metadata.is_dir()) {
                continue;
            }
            let files = load_plugin(&path, &name);
            folders.push(PluginFolder {
                folder: name,
                files,
            });
        }
        Ok(folders)
    }
}

/// Reads the manifest and the main file of the plugin in `path` (named `name`).
fn load_plugin(path: &Path, name: &str) -> Result<PluginFiles, String> {
    // Before any access: `plugins\con\plugin.json` is the console on Windows.
    if is_reserved_name(name) {
        return Err("the name of the folder is a device name of Windows".to_owned());
    }
    let root = fs::canonicalize(path).map_err(|_| "could not read the plugin folder".to_owned())?;
    let manifest = read_inside(&root, Path::new(MANIFEST_FILE_NAME), MANIFEST_FILE_NAME)?;

    let json: serde_json::Value = serde_json::from_str(manifest.trim_start_matches('\u{feff}'))
        .map_err(|_| format!("{MANIFEST_FILE_NAME} is not valid JSON"))?;
    let main = match json.get("main") {
        Some(serde_json::Value::String(main)) => main,
        Some(_) => return Err("main must be text".to_owned()),
        None => return Err(format!("{MANIFEST_FILE_NAME} has no main")),
    };
    let relative = relative_main(main).map_err(str::to_owned)?;
    let main = read_inside(&root, &relative, "main file")?;
    Ok(PluginFiles { manifest, main })
}

/// The path `main` names inside the plugin folder, or why it cannot be one. Only looks at the
/// text: that no link takes the path out of the folder is [`read_inside`]'s to check.
fn relative_main(main: &str) -> Result<PathBuf, &'static str> {
    if main.is_empty() {
        return Err("main is empty");
    }
    if main.starts_with('/') || main.starts_with('\\') {
        return Err("main must be a relative path");
    }
    if main.chars().any(|c| c.is_control() || c == ':') {
        return Err("main must be a plain relative path (no drive, no ':')");
    }
    let mut relative = PathBuf::new();
    for part in main.split(['/', '\\']) {
        match part {
            ".." => return Err("main must not use .."),
            "" | "." => {}
            part if is_reserved_name(part) => return Err("main uses a device name of Windows"),
            part => relative.push(part),
        }
    }
    if relative.as_os_str().is_empty() {
        return Err("main must name a file");
    }
    Ok(relative)
}

/// Reads `relative` inside `root` (a canonical path) as UTF-8 text, after following every link: a
/// file that is not really inside `root` is refused. `what` names the file in the sentences.
fn read_inside(root: &Path, relative: &Path, what: &str) -> Result<String, String> {
    let real = fs::canonicalize(root.join(relative)).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!("{what} not found")
        } else {
            format!("could not read the {what}")
        }
    })?;
    if !real.starts_with(root) {
        return Err(format!("{what} is outside the plugin folder"));
    }
    let metadata = fs::metadata(&real).map_err(|_| format!("could not read the {what}"))?;
    if !metadata.is_file() {
        return Err(format!("{what} is not a file"));
    }
    if metadata.len() > MAX_PLUGIN_FILE_BYTES {
        return Err(too_large(what));
    }
    // The file may grow between the check and the read: read one byte past the limit and count.
    let mut bytes = Vec::new();
    fs::File::open(&real)
        .and_then(|file| file.take(MAX_PLUGIN_FILE_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| format!("could not read the {what}"))?;
    if bytes.len() as u64 > MAX_PLUGIN_FILE_BYTES {
        return Err(too_large(what));
    }
    String::from_utf8(bytes).map_err(|_| format!("{what} is not UTF-8 text"))
}

fn too_large(what: &str) -> String {
    format!("{what} is larger than {} KiB", MAX_PLUGIN_FILE_BYTES / 1024)
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
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "noren-plugins-{label}-{}-{nanos}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create the test folder");
            Self(path)
        }

        /// The `plugins` folder inside, which does not exist until something makes it.
        fn plugins(&self) -> PathBuf {
            self.0.join(PLUGINS_DIR_NAME)
        }

        /// Makes `plugins/<folder>/<file>` with `bytes`.
        fn put(&self, folder: &str, file: &str, bytes: impl AsRef<[u8]>) {
            let path = self.plugins().join(folder).join(file);
            fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            fs::write(path, bytes).expect("write");
        }

        /// A plugin whose manifest names `main` (a JSON string, already quoted) and holds `js`.
        fn plugin(&self, folder: &str, main_json: &str, js: &str) {
            self.put(folder, MANIFEST_FILE_NAME, manifest(main_json));
            self.put(folder, "main.js", js);
        }

        fn list(&self) -> Vec<PluginFolder> {
            PluginStore::new(self.plugins()).list().expect("list")
        }

        /// What the one folder `folder` lists as.
        fn files(&self, folder: &str) -> Result<PluginFiles, String> {
            self.list()
                .into_iter()
                .find(|plugin| plugin.folder == folder)
                .expect("the folder is listed")
                .files
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest(main_json: &str) -> String {
        format!(
            r#"{{"id":"x","name":"X","version":"1.0.0","apiVersion":1,"main":{main_json},"permissions":[]}}"#
        )
    }

    fn files(manifest: &str, main: &str) -> Result<PluginFiles, String> {
        Ok(PluginFiles {
            manifest: manifest.to_owned(),
            main: main.to_owned(),
        })
    }

    /// Makes `link` point at `target`; `false` when the system does not let this user (Windows asks
    /// for a privilege for a link to a file), in which case the test cannot say anything about it.
    /// A link to a folder falls back to a junction on Windows, which asks for nothing.
    fn try_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link).or_else(|_| {
                let status = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(link)
                    .arg(target)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()?;
                status
                    .success()
                    .then_some(())
                    .ok_or_else(|| io::ErrorKind::Other.into())
            })
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        #[cfg(not(any(unix, windows)))]
        let made: io::Result<()> = Err(io::ErrorKind::Unsupported.into());
        made.is_ok()
    }

    #[test]
    fn a_valid_plugin_is_read_as_it_is() {
        let dir = TempDir::new("valid");
        let main = "\u{feff}// caf\u{e9}\r\nself.postMessage(1);\n";
        dir.plugin("hello", "\"main.js\"", main);
        assert_eq!(
            dir.list(),
            [PluginFolder {
                folder: "hello".to_owned(),
                files: files(&manifest("\"main.js\""), main),
            }]
        );
    }

    #[test]
    fn main_may_sit_in_a_subfolder_of_the_plugin() {
        let dir = TempDir::new("subfolder");
        dir.put(
            "hello",
            MANIFEST_FILE_NAME,
            manifest("\"./dist\\\\index.js\""),
        );
        dir.put("hello", "dist/index.js", "ok");
        assert_eq!(
            dir.files("hello"),
            files(&manifest("\"./dist\\\\index.js\""), "ok")
        );
    }

    #[test]
    fn a_manifest_with_a_byte_order_mark_still_gives_its_main() {
        let dir = TempDir::new("bom");
        dir.put(
            "hello",
            MANIFEST_FILE_NAME,
            format!("\u{feff}{}", manifest("\"main.js\"")),
        );
        dir.put("hello", "main.js", "ok");
        assert_eq!(
            dir.files("hello").map(|plugin| plugin.main),
            Ok("ok".to_owned())
        );
    }

    #[test]
    fn a_folder_without_plugin_json_says_so() {
        let dir = TempDir::new("no-manifest");
        dir.put("hello", "main.js", "ok");
        assert_eq!(dir.files("hello"), Err("plugin.json not found".to_owned()));
    }

    #[test]
    fn a_plugin_json_that_is_not_json_or_has_no_usable_main_says_so() {
        let dir = TempDir::new("bad-json");
        dir.put("broken", MANIFEST_FILE_NAME, "{ not json");
        dir.put("empty", MANIFEST_FILE_NAME, "");
        dir.put("nomain", MANIFEST_FILE_NAME, r#"{"id":"nomain"}"#);
        dir.put("number", MANIFEST_FILE_NAME, r#"{"main":7}"#);
        dir.put("array", MANIFEST_FILE_NAME, "[1]");
        assert_eq!(
            dir.files("broken"),
            Err("plugin.json is not valid JSON".to_owned())
        );
        assert_eq!(
            dir.files("empty"),
            Err("plugin.json is not valid JSON".to_owned())
        );
        assert_eq!(
            dir.files("nomain"),
            Err("plugin.json has no main".to_owned())
        );
        assert_eq!(dir.files("number"), Err("main must be text".to_owned()));
        assert_eq!(
            dir.files("array"),
            Err("plugin.json has no main".to_owned())
        );
    }

    #[test]
    fn a_main_with_dot_dot_is_refused_even_when_it_would_stay_inside() {
        let dir = TempDir::new("dotdot");
        dir.plugin("up", "\"../secret.js\"", "ok");
        dir.put("", "secret.js", "outside the plugin");
        dir.plugin("inside", "\"sub/../main.js\"", "ok");
        dir.plugin("backslash", "\"..\\\\secret.js\"", "ok");
        for folder in ["up", "inside", "backslash"] {
            assert_eq!(
                dir.files(folder),
                Err("main must not use ..".to_owned()),
                "{folder}"
            );
        }
    }

    #[test]
    fn a_main_that_is_absolute_or_names_a_drive_is_refused() {
        let dir = TempDir::new("absolute");
        let outside = dir.0.join("outside.js");
        fs::write(&outside, "outside the plugin").expect("write");
        let absolute = serde_json::to_string(&outside.to_string_lossy()).expect("json");
        for (folder, main_json) in [
            ("unix", "\"/etc/passwd\"".to_owned()),
            ("root", "\"\\\\windows\\\\win.ini\"".to_owned()),
            ("drive", "\"C:\\\\Windows\\\\win.ini\"".to_owned()),
            ("driverel", "\"C:main.js\"".to_owned()),
            ("stream", "\"main.js:hidden\"".to_owned()),
            ("real", absolute),
        ] {
            dir.plugin(folder, &main_json, "ok");
            let answer = dir.files(folder);
            assert!(
                matches!(&answer, Err(reason) if reason.starts_with("main must be")),
                "{folder}: {answer:?}"
            );
        }
    }

    #[test]
    fn a_main_that_is_empty_has_a_control_or_a_device_name_is_refused() {
        let dir = TempDir::new("odd-main");
        for (folder, main_json, reason) in [
            ("empty", "\"\"", "main is empty"),
            ("dot", "\".\"", "main must name a file"),
            (
                "control",
                "\"main\\u0000.js\"",
                "main must be a plain relative path (no drive, no ':')",
            ),
            (
                "device",
                "\"sub/con.js\"",
                "main uses a device name of Windows",
            ),
        ] {
            dir.plugin(folder, main_json, "ok");
            assert_eq!(dir.files(folder), Err(reason.to_owned()), "{folder}");
        }
    }

    #[test]
    fn a_main_that_is_a_link_to_a_file_outside_the_folder_is_refused() {
        let dir = TempDir::new("link-file");
        let outside = dir.0.join("outside.js");
        fs::write(&outside, "outside the plugin").expect("write");
        dir.put("hello", MANIFEST_FILE_NAME, manifest("\"main.js\""));
        if !try_symlink(&outside, &dir.plugins().join("hello").join("main.js")) {
            eprintln!("links cannot be made here; the link test says nothing");
            return;
        }
        assert_eq!(
            dir.files("hello"),
            Err("main file is outside the plugin folder".to_owned())
        );
    }

    #[test]
    fn a_main_below_a_link_to_a_folder_outside_is_refused() {
        let dir = TempDir::new("link-folder");
        let outside_folder = dir.0.join("outside-folder");
        fs::create_dir_all(&outside_folder).expect("folder");
        fs::write(outside_folder.join("main.js"), "outside the plugin").expect("write");
        dir.put("hello", MANIFEST_FILE_NAME, manifest("\"linked/main.js\""));
        if !try_symlink(&outside_folder, &dir.plugins().join("hello").join("linked")) {
            eprintln!("links cannot be made here; the link test says nothing");
            return;
        }
        assert_eq!(
            dir.files("hello"),
            Err("main file is outside the plugin folder".to_owned())
        );
    }

    #[test]
    fn a_manifest_that_is_a_link_out_of_the_folder_is_refused() {
        let dir = TempDir::new("manifest-link");
        let outside = dir.0.join("outside.json");
        fs::write(&outside, manifest("\"main.js\"")).expect("write");
        dir.put("hello", "main.js", "ok");
        if !try_symlink(
            &outside,
            &dir.plugins().join("hello").join(MANIFEST_FILE_NAME),
        ) {
            eprintln!("links cannot be made here; the link test says nothing");
            return;
        }
        assert_eq!(
            dir.files("hello"),
            Err("plugin.json is outside the plugin folder".to_owned())
        );
    }

    #[test]
    fn a_link_that_stays_inside_the_folder_is_followed() {
        let dir = TempDir::new("link-inside");
        dir.put("hello", MANIFEST_FILE_NAME, manifest("\"main.js\""));
        dir.put("hello", "real.js", "ok");
        if !try_symlink(
            &dir.plugins().join("hello").join("real.js"),
            &dir.plugins().join("hello").join("main.js"),
        ) {
            eprintln!("links cannot be made here; the link test says nothing");
            return;
        }
        assert_eq!(dir.files("hello"), files(&manifest("\"main.js\""), "ok"));
    }

    #[test]
    fn a_main_that_is_missing_or_a_folder_says_so() {
        let dir = TempDir::new("main-missing");
        dir.put("missing", MANIFEST_FILE_NAME, manifest("\"main.js\""));
        dir.put("folder", MANIFEST_FILE_NAME, manifest("\"main.js\""));
        fs::create_dir_all(dir.plugins().join("folder").join("main.js")).expect("folder");
        assert_eq!(dir.files("missing"), Err("main file not found".to_owned()));
        assert_eq!(
            dir.files("folder"),
            Err("main file is not a file".to_owned())
        );
    }

    #[test]
    fn a_file_larger_than_the_limit_is_refused_at_the_limit() {
        let dir = TempDir::new("large");
        let limit = MAX_PLUGIN_FILE_BYTES as usize;
        dir.plugin("exact", "\"main.js\"", &"a".repeat(limit));
        dir.plugin("large", "\"main.js\"", &"a".repeat(limit + 1));
        // A manifest of the limit: padding inside a string keeps it JSON.
        let padding = limit - manifest("\"main.js\"").len() - r#","pad":"""#.len();
        let exact_manifest = format!(
            r#"{},"pad":"{}"}}"#,
            manifest("\"main.js\"").trim_end_matches('}'),
            "p".repeat(padding)
        );
        assert_eq!(exact_manifest.len(), limit);
        dir.put("manifest-exact", MANIFEST_FILE_NAME, &exact_manifest);
        dir.put("manifest-exact", "main.js", "ok");
        dir.put(
            "manifest-large",
            MANIFEST_FILE_NAME,
            format!("{exact_manifest} "),
        );
        dir.put("manifest-large", "main.js", "ok");

        assert!(dir.files("exact").is_ok());
        assert_eq!(
            dir.files("large"),
            Err("main file is larger than 256 KiB".to_owned())
        );
        assert!(dir.files("manifest-exact").is_ok());
        assert_eq!(
            dir.files("manifest-large"),
            Err("plugin.json is larger than 256 KiB".to_owned())
        );
    }

    #[test]
    fn a_file_that_is_not_utf8_is_refused() {
        let dir = TempDir::new("utf8");
        dir.put("main", MANIFEST_FILE_NAME, manifest("\"main.js\""));
        dir.put("main", "main.js", [0x66, 0xff, 0xfe, 0x6f]);
        dir.put("manifest", MANIFEST_FILE_NAME, [0x7b, 0xff, 0x7d]);
        assert_eq!(
            dir.files("main"),
            Err("main file is not UTF-8 text".to_owned())
        );
        assert_eq!(
            dir.files("manifest"),
            Err("plugin.json is not UTF-8 text".to_owned())
        );
    }

    #[test]
    fn a_folder_that_does_not_exist_has_no_plugins_and_is_not_created() {
        let dir = TempDir::new("missing");
        let store = PluginStore::new(dir.plugins());
        assert_eq!(store.list().expect("list"), Vec::new());
        assert!(!dir.plugins().exists());
    }

    #[test]
    fn a_plugins_path_that_is_a_file_cannot_be_read() {
        let dir = TempDir::new("blocked");
        fs::write(dir.plugins(), b"in the way").expect("write");
        let error = PluginStore::new(dir.plugins()).list().expect_err("fails");
        assert!(
            error
                .to_string()
                .starts_with("could not read the plugins folder")
        );
    }

    #[test]
    fn folders_come_by_name_and_files_and_hidden_folders_are_left_out() {
        let dir = TempDir::new("order");
        dir.plugin("zeta", "\"main.js\"", "z");
        dir.plugin("alpha", "\"main.js\"", "a");
        dir.put("empty", "notes.txt", "no manifest here");
        dir.plugin(".git", "\"main.js\"", "hidden");
        fs::write(dir.plugins().join("README.md"), "not a plugin").expect("write");
        let names: Vec<String> = dir.list().into_iter().map(|plugin| plugin.folder).collect();
        assert_eq!(names, ["alpha", "empty", "zeta"]);
    }

    #[test]
    fn only_the_first_plugins_by_name_are_listed() {
        let dir = TempDir::new("cap");
        for n in 0..MAX_PLUGINS + 5 {
            dir.plugin(&format!("p{n:03}"), "\"main.js\"", "ok");
        }
        let listed = dir.list();
        assert_eq!(listed.len(), MAX_PLUGINS);
        assert_eq!(listed[0].folder, "p000");
        assert_eq!(
            listed[MAX_PLUGINS - 1].folder,
            format!("p{:03}", MAX_PLUGINS - 1)
        );
    }

    #[test]
    fn a_device_name_as_the_folder_is_refused_before_any_access() {
        assert_eq!(
            load_plugin(Path::new("does-not-exist"), "con"),
            Err("the name of the folder is a device name of Windows".to_owned())
        );
    }

    #[test]
    fn one_bad_plugin_does_not_hide_the_good_ones() {
        let dir = TempDir::new("mixed");
        dir.plugin("good", "\"main.js\"", "ok");
        dir.plugin("bad", "\"../main.js\"", "ok");
        let listed = dir.list();
        assert_eq!(listed.len(), 2);
        assert!(listed[1].files.is_ok());
        assert!(listed[0].files.is_err());
    }
}

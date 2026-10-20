//! Path safety of every place the app reads or writes a file named by something it does not
//! control: a mod, a theme, a scrollback snapshot, a background picture. Each test hands the public
//! API a hostile name (`..`, an absolute path, a drive, a stream, a device name) and checks both the
//! answer and the disk: nothing outside the folder is read, written, created or listed.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use noren_core::{
    BackgroundError, BackgroundStore, ModStore, ScrollbackStore, ThemeError, ThemeStore,
    is_valid_mod_file_name, is_valid_pane_id, is_valid_theme_id,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A folder under the system temp dir, removed when dropped. `outside` is a sibling of the folder
/// the stores work in, holding a file the stores must never reach.
struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(label: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "noren-path-safety-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("inside")).expect("inside");
        fs::create_dir_all(root.join("outside")).expect("outside");
        Self { root }
    }

    fn inside(&self) -> PathBuf {
        self.root.join("inside")
    }

    fn outside(&self) -> PathBuf {
        self.root.join("outside")
    }

    /// Every file and folder under the root, as paths relative to it.
    fn tree(&self) -> Vec<String> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).expect("read_dir").flatten() {
                let path = entry.path();
                out.push(
                    path.strip_prefix(root)
                        .expect("under the root")
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
                if path.is_dir() {
                    walk(&path, root, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &self.root, &mut out);
        out.sort();
        out
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Names that try to leave a folder or to name something other than a plain file in it.
const HOSTILE_STEMS: &[&str] = &[
    "..",
    "../escape",
    "..\\escape",
    "../../escape",
    "a/../../escape",
    "a/b",
    "a\\b",
    "/etc/passwd",
    "\\windows\\system32",
    "C:\\escape",
    "C:escape",
    "c:/escape",
    "\\\\server\\share\\escape",
    "//server/share/escape",
    "escape\0",
    "escape\n",
    " escape",
    "escape ",
    "escape:stream",
    "escape.",
    "%2e%2e/escape",
    "..%2fescape",
    "con",
    "NUL",
    "aux.v2",
    "com1",
    "lpt9",
    "~",
    "$HOME",
    "",
];

#[test]
fn mod_file_names_never_hold_a_path_a_stream_or_a_device() {
    for stem in HOSTILE_STEMS {
        // "escape." + ".css" is "escape..css": a dot inside the name is a plain name (a dot at the
        // very end, which Windows drops, would not be).
        if *stem == "escape." {
            continue;
        }
        let name = format!("{stem}.css");
        assert!(!is_valid_mod_file_name(&name), "{name:?}");
    }
    for name in [
        "..",
        "../escape.css",
        "a/b.css",
        "escape.css/",
        "escape.CSS",
        "escape.css ",
        "escape.css.exe",
        "escape.css:stream",
        "escape.css\0",
        ".hidden.css",
        "-dash.css",
        "ünïcode.css",
        "full\u{ff0e}css",
    ] {
        assert!(!is_valid_mod_file_name(name), "{name:?}");
    }
    for name in ["dark.css", "my-mod_2.v3.css", "A1.css"] {
        assert!(is_valid_mod_file_name(name), "{name:?}");
    }
}

#[test]
fn a_mods_folder_lists_only_plain_files_in_it_and_reads_nothing_outside() {
    let sandbox = Sandbox::new("mods");
    fs::write(sandbox.outside().join("secret.css"), "body { color: red }").unwrap();
    fs::write(sandbox.inside().join("good.css"), "a {}").unwrap();
    // Things that sit in the folder but are not mods.
    fs::write(sandbox.inside().join("notes.txt"), "x").unwrap();
    fs::write(sandbox.inside().join("con.css"), "x").unwrap();
    fs::write(sandbox.inside().join("UPPER.CSS"), "x").unwrap();
    fs::create_dir_all(sandbox.inside().join("folder.css")).unwrap();
    fs::write(sandbox.inside().join("folder.css").join("inner.css"), "x").unwrap();

    let names: Vec<String> = ModStore::new(sandbox.inside())
        .list()
        .expect("list")
        .into_iter()
        .map(|file| file.name)
        .collect();
    assert_eq!(names, ["good.css"]);
}

#[test]
fn theme_ids_never_hold_a_path_a_stream_or_a_device() {
    for id in HOSTILE_STEMS {
        assert!(!is_valid_theme_id(id), "{id:?}");
    }
    for id in [
        "Upper",
        "a_b",
        "a--b",
        "-a",
        "a-",
        "a.json",
        "../a",
        "a/b",
        "caf\u{e9}",
    ] {
        assert!(!is_valid_theme_id(id), "{id:?}");
    }
    for id in ["dark", "tokyo-night", "theme-2", "a"] {
        assert!(is_valid_theme_id(id), "{id:?}");
    }
}

#[test]
fn saving_a_theme_with_a_hostile_id_writes_nothing_anywhere() {
    let sandbox = Sandbox::new("themes");
    let store = ThemeStore::new(sandbox.inside().join("themes"));
    let before = sandbox.tree();
    for id in HOSTILE_STEMS {
        match store.save(id, "{}") {
            Err(ThemeError::InvalidId(refused)) => assert_eq!(&refused, id),
            other => panic!("{id:?}: {other:?}"),
        }
    }
    for id in [
        "../outside/escape",
        "..\\outside\\escape",
        "../../escape",
        "../themes/x",
    ] {
        assert!(matches!(
            store.save(id, "{}"),
            Err(ThemeError::InvalidId(_))
        ));
    }
    assert_eq!(
        sandbox.tree(),
        before,
        "a refused save must not create the folder or a file"
    );
}

#[test]
fn saving_a_theme_writes_only_inside_its_folder() {
    let sandbox = Sandbox::new("themes-ok");
    let themes = sandbox.inside().join("themes");
    let store = ThemeStore::new(&themes);
    store.save("tokyo-night", "{\"name\":\"x\"}").expect("save");
    assert_eq!(
        sandbox.tree(),
        [
            "inside",
            "inside/themes",
            "inside/themes/tokyo-night.json",
            "outside"
        ]
    );
}

#[test]
fn scrollback_ids_never_hold_a_path_and_a_refused_id_touches_nothing() {
    let sandbox = Sandbox::new("scrollback");
    fs::write(sandbox.outside().join("escape.txt"), "secret").unwrap();
    let store = ScrollbackStore::new(sandbox.inside().join("scrollback"));
    let before = sandbox.tree();
    for id in HOSTILE_STEMS {
        assert!(!is_valid_pane_id(id), "{id:?}");
        assert!(store.save(id, "x").is_err(), "save {id:?}");
        assert!(store.load(id).is_err(), "load {id:?}");
        assert!(store.delete(id).is_err(), "delete {id:?}");
    }
    for id in [
        "../outside/escape",
        "..\\outside\\escape",
        "../../outside/escape",
    ] {
        assert!(store.load(id).is_err(), "{id:?}");
        assert!(store.delete(id).is_err(), "{id:?}");
    }
    assert_eq!(sandbox.tree(), before);
    assert_eq!(
        fs::read_to_string(sandbox.outside().join("escape.txt")).unwrap(),
        "secret"
    );
}

#[test]
fn a_background_path_that_climbs_or_leaves_the_computer_is_refused() {
    let sandbox = Sandbox::new("background");
    let store = BackgroundStore::new(sandbox.inside());
    for path in [
        "../outside/sky.png",
        "..\\outside\\sky.png",
        "backgrounds/../../outside/sky.png",
        "a/./../../sky.png",
        "https://example.com/sky.png",
        "HTTP://example.com/sky.png",
        "file:///C:/sky.png",
        "data:image/png;base64,AAAA",
        "blob:abc",
        "\\\\server\\share\\sky.png",
        "//server/share/sky.png",
        "C:sky.png",
        "C:..\\sky.png",
        "sky.png\0",
        "sky.png\n",
        " sky.png",
        "sky.png ",
        "sky.txt",
        "sky",
        "",
    ] {
        match store.resolve(path) {
            Err(BackgroundError::Refused(_)) => {}
            other => panic!("{path:?} should be refused, got {other:?}"),
        }
        assert!(store.read(path).is_err(), "{path:?}");
    }
}

#[test]
fn a_relative_background_path_stays_inside_the_config_folder() {
    let sandbox = Sandbox::new("background-inside");
    let store = BackgroundStore::new(sandbox.inside());
    for path in [
        "sky.png",
        "backgrounds/sky.png",
        "./sky.jpg",
        "a/b/c/sky.webp",
    ] {
        let resolved = store.resolve(path).expect(path);
        assert!(
            resolved.starts_with(sandbox.inside()),
            "{path}: {resolved:?}"
        );
        assert!(
            !resolved
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir)),
            "{path}: {resolved:?}"
        );
    }
}

#[test]
fn an_absolute_background_path_outside_the_folder_can_only_give_a_picture() {
    // An absolute path is allowed on purpose (the picture can live anywhere on the computer), so
    // what keeps the rest of the disk closed is the content check: a file that is not a picture,
    // however it is named, is never returned.
    let sandbox = Sandbox::new("background-absolute");
    let store = BackgroundStore::new(sandbox.inside());

    let secret = sandbox.outside().join("secret.png");
    fs::write(&secret, b"top secret text, not a picture").unwrap();
    let path = secret.to_str().expect("utf-8 temp dir");
    assert!(
        matches!(store.read(path), Err(BackgroundError::NotAPicture(_))),
        "{path}"
    );

    let text = sandbox.outside().join("passwords.txt");
    fs::write(&text, b"hunter2").unwrap();
    assert!(matches!(
        store.read(text.to_str().unwrap()),
        Err(BackgroundError::Refused(_))
    ));

    let picture = sandbox.outside().join("sky.png");
    let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend_from_slice(&[0; 16]);
    fs::write(&picture, &bytes).unwrap();
    assert_eq!(
        store.read(picture.to_str().unwrap()).expect("picture"),
        bytes
    );

    // A folder named like a picture is not one.
    let folder = sandbox.outside().join("folder.png");
    fs::create_dir_all(&folder).unwrap();
    assert!(matches!(
        store.read(folder.to_str().unwrap()),
        Err(BackgroundError::NotFound(_))
    ));
}

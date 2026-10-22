//! Where a shell opens when the session names no folder (NOR-F20-06). Real shells on real PTYs,
//! local only, no network. The process of the test sits in the folder of the crate, which is
//! never the folder of the "user" these tests make (a folder of their own in the temp folder,
//! created and removed here), so a shell that opens in the folder of the process fails them.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use noren_core::{SessionEvent, SessionManager, SpawnSpec, default_start_dir, start_dir_with};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// A folder in the temp folder that is removed when the value is dropped.
struct TempFolder(PathBuf);

impl TempFolder {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "noren-start-dir-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("create the folder");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFolder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The variable the platform reads for the folder of the user.
const HOME_VARIABLE: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

#[cfg(windows)]
fn print_folder() -> (&'static str, Vec<String>) {
    ("cmd.exe", vec!["/c".into(), "cd".into()])
}
#[cfg(not(windows))]
fn print_folder() -> (&'static str, Vec<String>) {
    ("sh", vec!["-c".into(), "pwd -P".into()])
}

/// The folder as the shell prints it, comparable with `folder_printed_by_a_shell`.
fn printable(path: &Path) -> String {
    if cfg!(windows) {
        path.display().to_string().to_lowercase()
    } else {
        path.canonicalize()
            .expect("canonical folder")
            .display()
            .to_string()
    }
}

/// Runs a real shell that prints its folder and ends; returns the output as text.
fn folder_printed_by_a_shell(cwd: Option<&Path>, env: Vec<(String, String)>) -> String {
    let (program, args) = print_folder();
    let spec = SpawnSpec {
        program: program.to_owned(),
        args,
        cwd: cwd.map(Path::to_owned),
        env,
        cols: 500,
        rows: 24,
    };
    let manager = SessionManager::new();
    let (tx, rx) = mpsc::channel();
    let id = manager
        .spawn(spec, move |event| {
            let _ = tx.send(match event {
                SessionEvent::Output(bytes) => Some(bytes.to_vec()),
                SessionEvent::Exit(_) => None,
            });
        })
        .expect("spawn");
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut output = Vec::new();
    while let Some(bytes) = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .expect("an event before the deadline")
    {
        output.extend_from_slice(&bytes);
    }
    manager.kill(id).expect("release the finished session");
    let text = String::from_utf8_lossy(&output).into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn the_user_variable(folder: &Path) -> Vec<(String, String)> {
    vec![(HOME_VARIABLE.to_owned(), folder.display().to_string())]
}

fn the_folder_of_this_process() -> PathBuf {
    std::env::current_dir().expect("current folder")
}

#[test]
fn a_session_without_a_folder_opens_in_the_folder_of_the_user_not_in_the_folder_of_the_process() {
    let user = TempFolder::new("user");
    assert_ne!(
        printable(user.path()),
        printable(&the_folder_of_this_process()),
        "the test needs a user folder other than the folder of the process"
    );
    let printed = folder_printed_by_a_shell(None, the_user_variable(user.path()));
    assert!(
        printed.contains(&printable(user.path())),
        "the shell should open in {:?}; it printed {printed:?}",
        user.path()
    );
    assert!(
        !printed.contains(&printable(&the_folder_of_this_process())),
        "the shell opened in the folder of the process: {printed:?}"
    );
}

#[test]
fn a_given_folder_wins_over_the_folder_of_the_user() {
    let user = TempFolder::new("user");
    let given = TempFolder::new("given");
    let printed = folder_printed_by_a_shell(Some(given.path()), the_user_variable(user.path()));
    assert!(
        printed.contains(&printable(given.path())),
        "the shell should open in {:?}; it printed {printed:?}",
        given.path()
    );
    assert!(!printed.contains(&printable(user.path())), "{printed:?}");
}

#[test]
fn a_restored_tab_opens_in_its_last_folder() {
    // A restored tab reaches the core as a session with the last folder the shell reported, which
    // is a given folder like any other: the folder of the user never replaces it.
    let user = TempFolder::new("user");
    let last = TempFolder::new("last");
    let printed = folder_printed_by_a_shell(Some(last.path()), the_user_variable(user.path()));
    assert!(printed.contains(&printable(last.path())), "{printed:?}");
}

#[test]
fn a_user_folder_that_is_gone_falls_back_to_the_folder_of_the_process_without_an_error() {
    let gone = std::env::temp_dir().join("noren-start-dir-gone-4f2a91-never-created");
    assert!(!gone.exists());
    let printed = folder_printed_by_a_shell(None, the_user_variable(&gone));
    assert!(
        printed.contains(&printable(&the_folder_of_this_process())),
        "the shell should open where the process is; it printed {printed:?}"
    );
}

#[test]
fn the_default_folder_of_this_machine_is_the_folder_of_the_user() {
    // Reads the real variable and writes nothing: the folder is only compared.
    if let Some(dir) = default_start_dir() {
        assert_eq!(
            Some(dir.clone()),
            std::env::var_os(HOME_VARIABLE).map(PathBuf::from)
        );
        assert!(dir.is_dir());
    }
    // The pure form, with nothing from the machine in it.
    let user = TempFolder::new("pure");
    let found = start_dir_with(
        cfg!(windows),
        |name| (name == HOME_VARIABLE).then(|| user.path().as_os_str().to_owned()),
        Path::is_dir,
    );
    assert_eq!(found.as_deref(), Some(user.path()));
}

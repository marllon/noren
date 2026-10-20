//! The git diff of a folder against repositories made by the real `git`: a clean repository, a
//! change in the working tree and one in the index, a deleted, a renamed and a binary file, a
//! subfolder, a repository with no commit, a folder that is no repository, a diff past the cap,
//! and what keeps the read a read (the settings of the repository do not change the text, its hooks
//! do not run, the index is not written). Skips with a warning when `git` is not installed. No
//! network, no global config: every command gets a scratch home and a fixed identity.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use noren_core::{GitCli, GitDiff, GitDiffRefusal, MAX_GIT_DIFF_BYTES};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("noren-diff-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git_is_installed() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

macro_rules! require_git {
    () => {
        if !git_is_installed() {
            eprintln!("warning: git is not installed; skipping the test against real repositories");
            return;
        }
    };
}

/// Runs `git` in `dir` with a scratch home and identity, and returns its trimmed output.
fn git(dir: &Path, home: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Noren Test",
            "-c",
            "user.email=test@example.com",
        ])
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .current_dir(dir)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.join("none"))
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A scratch repository (with one commit unless made empty) and the `GitCli` that works in it with
/// the same scratch home. `git` never looks above `root` for a repository.
struct Fixture {
    root: TempDir,
    home: PathBuf,
    repo: PathBuf,
    cli: GitCli,
}

impl Fixture {
    /// A repository with `README.md` ("hello") committed.
    fn new(name: &str) -> Self {
        let fx = Self::empty(name);
        fs::write(fx.repo.join("README.md"), "hello\n").unwrap();
        fx.git(&["add", "README.md"]);
        fx.git(&["commit", "--quiet", "-m", "first"]);
        fx
    }

    /// A repository with no commit.
    fn empty(name: &str) -> Self {
        let root = TempDir::new(name);
        let home = root.0.join("home");
        let repo = root.0.join("repo");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &home, &["init", "--quiet"]);
        let cli = GitCli::system()
            .with_env("HOME", &home)
            .with_env("USERPROFILE", &home)
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
            .with_env("GIT_CONFIG_GLOBAL", home.join("none"))
            .with_env("GIT_CEILING_DIRECTORIES", &root.0);
        Self {
            root,
            home,
            repo,
            cli,
        }
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.repo, &self.home, args)
    }

    fn write(&self, name: &str, content: &str) {
        let path = self.repo.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn diff_of(&self, folder: &Path) -> GitDiff {
        self.cli.diff(&folder.display().to_string())
    }

    /// The text of the diff of the repository; fails the test on a refusal.
    fn text(&self) -> String {
        match self.diff_of(&self.repo) {
            GitDiff::Text(text) => text,
            GitDiff::Refused(refusal) => panic!("the diff was refused: {refusal:?}"),
        }
    }
}

#[test]
fn a_clean_repository_has_an_empty_diff() {
    require_git!();
    let fx = Fixture::new("clean");
    assert_eq!(fx.diff_of(&fx.repo), GitDiff::Text(String::new()));
}

#[test]
fn a_change_in_the_working_tree_shows_against_head() {
    require_git!();
    let fx = Fixture::new("worktree");
    fx.write("README.md", "hello\nworld\n");
    let text = fx.text();
    assert!(
        text.starts_with("diff --git a/README.md b/README.md\n"),
        "{text}"
    );
    assert!(
        text.contains("\n--- a/README.md\n+++ b/README.md\n"),
        "{text}"
    );
    assert!(text.contains("@@ -1 +1,2 @@"), "{text}");
    assert!(text.contains("\n hello\n+world\n"), "{text}");
}

#[test]
fn the_index_and_the_working_tree_are_both_in_the_diff_against_head() {
    require_git!();
    let fx = Fixture::new("index");
    fx.write("a.txt", "one\n");
    fx.write("b.txt", "two\n");
    fx.git(&["add", "a.txt", "b.txt"]);
    fx.git(&["commit", "--quiet", "-m", "second"]);

    // a.txt: staged, then edited again (the diff is the last state against HEAD, once).
    fx.write("a.txt", "one\nstaged\n");
    fx.git(&["add", "a.txt"]);
    fx.write("a.txt", "one\nstaged\nunstaged\n");
    // b.txt: edited and not staged.
    fx.write("b.txt", "two\nedited\n");
    // c.txt: new and staged. d.txt: new and not added (git does not track it).
    fx.write("c.txt", "three\n");
    fx.git(&["add", "c.txt"]);
    fx.write("d.txt", "untracked\n");

    let text = fx.text();
    assert_eq!(
        text.matches("diff --git a/a.txt b/a.txt").count(),
        1,
        "{text}"
    );
    assert!(text.contains("+staged\n+unstaged\n"), "{text}");
    assert!(text.contains("diff --git a/b.txt b/b.txt"), "{text}");
    assert!(text.contains("+edited\n"), "{text}");
    assert!(
        text.contains("diff --git a/c.txt b/c.txt\nnew file mode"),
        "{text}"
    );
    assert!(text.contains("+three\n"), "{text}");
    assert!(
        !text.contains("d.txt"),
        "an untracked file is not in `git diff`: {text}"
    );
}

#[test]
fn a_deleted_a_renamed_and_a_binary_file_are_told_apart() {
    require_git!();
    let fx = Fixture::new("kinds");
    let long: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    fx.write("gone.txt", "bye\n");
    fx.write("old-name.txt", &long);
    fs::write(fx.repo.join("image.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
    fx.git(&["add", "."]);
    fx.git(&["commit", "--quiet", "-m", "second"]);

    fs::remove_file(fx.repo.join("gone.txt")).unwrap();
    fx.git(&["mv", "old-name.txt", "new-name.txt"]);
    fx.write("new-name.txt", &long.replace("line 30\n", "line thirty\n"));
    fs::write(fx.repo.join("image.bin"), [0u8, 1, 2, 3, 0, 254]).unwrap();

    let text = fx.text();
    assert!(text.contains("deleted file mode"), "{text}");
    assert!(text.contains("-bye\n"), "{text}");
    assert!(
        text.contains("rename from old-name.txt\nrename to new-name.txt"),
        "{text}"
    );
    assert!(text.contains("similarity index"), "{text}");
    assert!(text.contains("-line 30\n+line thirty\n"), "{text}");
    assert!(
        text.contains("Binary files a/image.bin and b/image.bin differ"),
        "{text}"
    );
}

#[test]
fn a_subfolder_gets_the_diff_of_the_whole_repository() {
    require_git!();
    let fx = Fixture::new("subfolder");
    fx.write("deep/er/file.txt", "x\n");
    fx.git(&["add", "."]);
    fx.git(&["commit", "--quiet", "-m", "second"]);
    fx.write("README.md", "changed\n");
    fx.write("deep/er/file.txt", "y\n");

    let from_root = fx.text();
    let from_sub = fx.diff_of(&fx.repo.join("deep").join("er"));
    assert_eq!(from_sub, GitDiff::Text(from_root.clone()));
    assert!(from_root.contains("a/README.md"));
    assert!(from_root.contains("a/deep/er/file.txt"));
}

#[test]
fn a_repository_with_no_commit_is_diffed_against_the_empty_tree() {
    require_git!();
    let fx = Fixture::empty("unborn");
    // Nothing yet: an empty diff, not a refusal.
    assert_eq!(fx.diff_of(&fx.repo), GitDiff::Text(String::new()));

    fx.write("first.txt", "alpha\nbeta\n");
    fx.git(&["add", "first.txt"]);
    fx.write("later.txt", "not added\n");
    let text = fx.text();
    assert!(
        text.contains("diff --git a/first.txt b/first.txt\nnew file mode"),
        "{text}"
    );
    assert!(text.contains("+alpha\n+beta\n"), "{text}");
    assert!(!text.contains("later.txt"), "{text}");
}

#[test]
fn a_folder_in_no_repository_is_refused() {
    require_git!();
    let fx = Fixture::new("plain");
    let plain = fx.root.0.join("plain");
    fs::create_dir_all(&plain).unwrap();
    assert_eq!(
        fx.diff_of(&plain),
        GitDiff::Refused(GitDiffRefusal::NotARepository)
    );
    // Not a folder at all: nothing there, or a file.
    assert_eq!(
        fx.diff_of(&fx.root.0.join("nowhere")),
        GitDiff::Refused(GitDiffRefusal::Missing)
    );
    assert_eq!(
        fx.diff_of(&fx.repo.join("README.md")),
        GitDiff::Refused(GitDiffRefusal::Missing)
    );
}

#[test]
fn the_inside_of_the_git_folder_has_no_working_tree() {
    require_git!();
    let fx = Fixture::new("inside-git");
    match fx.diff_of(&fx.repo.join(".git")) {
        GitDiff::Refused(GitDiffRefusal::Failed(detail)) => {
            assert!(detail.contains("working tree"), "{detail}");
        }
        other => panic!("expected a refusal that says there is no working tree: {other:?}"),
    }
}

#[test]
fn a_diff_past_the_cap_is_refused() {
    require_git!();
    let fx = Fixture::new("cap");
    // Each line is deleted and added again: the diff is about twice the size of the file.
    let before: String = (0..200_000).map(|n| format!("before {n}\n")).collect();
    let after: String = (0..200_000).map(|n| format!("after {n}\n")).collect();
    assert!(before.len() + after.len() > MAX_GIT_DIFF_BYTES);
    fx.write("big.txt", &before);
    fx.git(&["add", "big.txt"]);
    fx.git(&["commit", "--quiet", "-m", "big"]);
    fx.write("big.txt", &after);
    assert_eq!(
        fx.diff_of(&fx.repo),
        GitDiff::Refused(GitDiffRefusal::TooLarge)
    );

    // A diff just under the cap is still read whole.
    fx.write("big.txt", &before.replacen("before 0\n", "changed\n", 1));
    let text = fx.text();
    assert!(text.len() < MAX_GIT_DIFF_BYTES);
    assert!(text.contains("-before 0\n+changed\n"), "{text}");
}

#[test]
fn the_settings_of_the_repository_do_not_change_the_text() {
    require_git!();
    let fx = Fixture::new("settings");
    let long: String = (1..=20).map(|n| format!("line {n}\n")).collect();
    fx.write("old.txt", &long);
    fx.git(&["add", "old.txt"]);
    fx.git(&["commit", "--quiet", "-m", "second"]);
    fx.git(&["mv", "old.txt", "new.txt"]);
    fx.write("README.md", "hello\nagain\n");

    let plain = fx.text();
    // Settings that would change the shape of the text if git were asked without the flags.
    for (key, value) in [
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.renames", "false"),
        ("color.ui", "always"),
        ("color.diff", "always"),
        ("diff.external", "noren-no-such-diff-program"),
        ("core.quotePath", "true"),
    ] {
        fx.git(&["config", key, value]);
    }
    let configured = fx.text();
    assert_eq!(configured, plain);
    assert!(
        configured.contains("diff --git a/README.md b/README.md"),
        "{configured}"
    );
    assert!(
        configured.contains("rename from old.txt\nrename to new.txt"),
        "{configured}"
    );
    assert!(
        !configured.contains('\u{1b}'),
        "no colour codes: {configured:?}"
    );
}

#[test]
fn names_outside_ascii_come_as_they_are_written() {
    require_git!();
    let fx = Fixture::new("names");
    fx.write("caf\u{e9} au lait.txt", "a\n");
    fx.git(&["add", "."]);
    fx.git(&["commit", "--quiet", "-m", "second"]);
    fx.write("caf\u{e9} au lait.txt", "b\n");
    let text = fx.text();
    assert!(
        text.contains("diff --git a/caf\u{e9} au lait.txt b/caf\u{e9} au lait.txt"),
        "{text}"
    );
}

#[test]
fn the_hook_a_repository_names_does_not_run() {
    require_git!();
    let fx = Fixture::new("fsmonitor");
    let marker = fx.root.0.join("fsmonitor-ran");
    // The file-system monitor hook is a program the repository's own settings name; a clone could
    // carry one. Reading a diff must not start it.
    let hook = format!(
        "echo ran>>\"{}\"",
        marker.display().to_string().replace('\\', "/")
    );
    fx.git(&["config", "core.fsmonitor", &hook]);
    fx.write("README.md", "hello\nchanged\n");
    let text = fx.text();
    assert!(text.contains("+changed"), "{text}");
    assert!(!marker.exists(), "the fsmonitor hook of the repository ran");
}

#[test]
fn reading_the_diff_does_not_write_the_index() {
    require_git!();
    let fx = Fixture::new("index-untouched");
    fx.write("README.md", "hello\nchanged\n");
    fx.git(&["add", "README.md"]);
    // Same content, new modification time: a plain `git diff` would refresh the index and write it.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fx.write("README.md", "hello\nchanged\n");
    let index = fx.repo.join(".git").join("index");
    let before = fs::read(&index).unwrap();
    let text = fx.text();
    assert!(text.contains("+changed"), "{text}");
    assert_eq!(fs::read(&index).unwrap(), before, "the index was written");
}

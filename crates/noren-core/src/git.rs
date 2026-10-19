//! Git facts read straight from the files of a repository, without running `git`.
//!
//! [`read_head`] walks up from a folder to the first one that holds a `.git` with a usable `HEAD`
//! and says which branch it points at, or the short commit id of a detached `HEAD`. A `.git` that
//! is a file (a linked worktree, a submodule) holds a `gitdir:` line naming the folder with the
//! real `HEAD`, and is followed.
//!
//! The folder comes from the output of a terminal, so nothing about it is trusted: only a
//! `.git` entry and a `HEAD` file are ever read, no more than [`MAX_FILE_BYTES`] of each, and
//! anything that does not look like a repository is skipped, as `git` itself does.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Most bytes read from a `.git` file or a `HEAD`; both hold a single short line.
pub const MAX_FILE_BYTES: u64 = 4096;

/// How many characters of a commit id a detached `HEAD` is shown with.
pub const SHORT_ID_LEN: usize = 7;

/// Longest branch name taken (in characters); anything longer is not a branch a person made.
const MAX_BRANCH_CHARS: usize = 1024;

/// What the `HEAD` of a repository points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHead {
    /// The branch name, or the first [`SHORT_ID_LEN`] characters of the commit when detached.
    pub branch: String,
    /// `HEAD` holds a commit and no branch.
    pub detached: bool,
}

/// The `HEAD` of the repository `folder` is in, or `None` when it is in no repository (or the
/// path is not absolute, or nothing there can be read).
///
/// The search starts at `folder` itself and goes up one level at a time. A `.git` that cannot be
/// used (an empty folder, a file without `gitdir:`, a `HEAD` that is neither a branch nor a
/// commit) does not stop it, so a stray `.git` does not hide the real repository above.
pub fn read_head(folder: &Path) -> Option<GitHead> {
    if !folder.is_absolute() {
        return None;
    }
    folder
        .ancestors()
        .filter_map(git_dir_of)
        .find_map(|git_dir| parse_head(&git_dir))
}

/// The folder with the repository data for the `.git` entry in `dir`: that entry itself when it
/// is a folder, or the target of its `gitdir:` line when it is a file.
fn git_dir_of(dir: &Path) -> Option<PathBuf> {
    let entry = dir.join(".git");
    let kind = fs::metadata(&entry).ok()?;
    if kind.is_dir() {
        return Some(entry);
    }
    if !kind.is_file() {
        return None;
    }
    let text = read_small_file(&entry)?;
    let target = text.lines().next()?.strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let target = Path::new(target);
    // A relative target is relative to the folder that holds the `.git` file.
    Some(if target.is_absolute() {
        target.to_owned()
    } else {
        dir.join(target)
    })
}

/// Reads `HEAD` in `git_dir`: `ref: refs/heads/<branch>` or a commit id.
fn parse_head(git_dir: &Path) -> Option<GitHead> {
    let text = read_small_file(&git_dir.join("HEAD"))?;
    let line = text.lines().next()?.trim();
    if let Some(reference) = line.strip_prefix("ref:") {
        let reference = reference.trim();
        let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
        return usable_branch(name).then(|| GitHead {
            branch: name.to_owned(),
            detached: false,
        });
    }
    if is_commit_id(line) {
        return Some(GitHead {
            branch: line[..SHORT_ID_LEN].to_owned(),
            detached: true,
        });
    }
    None
}

/// A SHA-1 (40) or SHA-256 (64) commit id in hexadecimal.
fn is_commit_id(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What a repository in the `reftable` format keeps in `HEAD`, so that older git versions refuse
/// it. The real branch is in the reftable files, which this module does not read.
const REFTABLE_STUB: &str = ".invalid";

/// A branch name that can be shown: not empty, not absurdly long, with no control character, and
/// not the stub of a `reftable` repository.
fn usable_branch(name: &str) -> bool {
    !name.is_empty()
        && name != REFTABLE_STUB
        && name.chars().count() <= MAX_BRANCH_CHARS
        && !name.chars().any(char::is_control)
}

/// The start of a regular file as text (invalid UTF-8 is replaced); `None` for anything else. The
/// type is checked first so that a pipe or a device planted as `HEAD` is never opened.
fn read_small_file(path: &Path) -> Option<String> {
    if !fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    /// A fresh folder in the temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("noren-git-test-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        /// Makes the folder (and its parents) under this one and returns its path.
        fn folder(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(&path).expect("create folder");
            path
        }

        /// Writes a file under this folder, creating the folders on the way.
        fn file(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().expect("has a parent")).expect("create folder");
            fs::write(&path, content).expect("write file");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn branch(name: &str) -> Option<GitHead> {
        Some(GitHead {
            branch: name.to_owned(),
            detached: false,
        })
    }

    fn detached(short: &str) -> Option<GitHead> {
        Some(GitHead {
            branch: short.to_owned(),
            detached: true,
        })
    }

    #[test]
    fn a_repository_on_a_branch() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/main\n");
        assert_eq!(read_head(&dir.path().join("repo")), branch("main"));
    }

    #[test]
    fn a_branch_name_keeps_its_slashes() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/feature/login-form\n");
        assert_eq!(
            read_head(&dir.path().join("repo")),
            branch("feature/login-form")
        );
    }

    #[test]
    fn a_branch_without_commits_is_still_the_branch() {
        // `git init` writes HEAD before there is any ref or object.
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/trunk\n");
        assert!(!dir.path().join("repo/.git/refs/heads/trunk").exists());
        assert_eq!(read_head(&dir.path().join("repo")), branch("trunk"));
    }

    #[test]
    fn head_without_a_final_newline_or_with_crlf_is_read() {
        let dir = TempDir::new();
        dir.file("a/.git/HEAD", "ref: refs/heads/dev");
        dir.file("b/.git/HEAD", "ref: refs/heads/dev\r\n");
        assert_eq!(read_head(&dir.path().join("a")), branch("dev"));
        assert_eq!(read_head(&dir.path().join("b")), branch("dev"));
    }

    #[test]
    fn a_nested_subfolder_finds_the_repository_above() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/main\n");
        let deep = dir.folder("repo/crates/core/src");
        assert_eq!(read_head(&deep), branch("main"));
    }

    #[test]
    fn the_closest_repository_wins() {
        let dir = TempDir::new();
        dir.file("outer/.git/HEAD", "ref: refs/heads/outer\n");
        dir.file("outer/inner/.git/HEAD", "ref: refs/heads/inner\n");
        let deep = dir.folder("outer/inner/src");
        assert_eq!(read_head(&deep), branch("inner"));
        assert_eq!(read_head(&dir.path().join("outer")), branch("outer"));
    }

    #[test]
    fn a_detached_head_is_the_short_commit() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", &format!("{COMMIT}\n"));
        assert_eq!(read_head(&dir.path().join("repo")), detached("0123456"));
    }

    #[test]
    fn a_detached_head_in_a_sha256_repository() {
        let dir = TempDir::new();
        let id = "abcdef0123456789".repeat(4);
        dir.file("repo/.git/HEAD", &format!("{id}\n"));
        assert_eq!(read_head(&dir.path().join("repo")), detached("abcdef0"));
    }

    #[test]
    fn a_worktree_follows_the_gitdir_line_of_its_git_file() {
        let dir = TempDir::new();
        // The main repository keeps its own HEAD; the worktree has one of its own.
        dir.file("main/.git/HEAD", "ref: refs/heads/main\n");
        dir.file("main/.git/worktrees/wt/HEAD", "ref: refs/heads/fix-bug\n");
        let gitdir = dir.path().join("main/.git/worktrees/wt");
        dir.file("wt/.git", &format!("gitdir: {}\n", gitdir.display()));
        let inside = dir.folder("wt/src");
        assert_eq!(read_head(&dir.path().join("wt")), branch("fix-bug"));
        assert_eq!(read_head(&inside), branch("fix-bug"));
        assert_eq!(read_head(&dir.path().join("main")), branch("main"));
    }

    #[test]
    fn a_relative_gitdir_is_relative_to_the_git_file() {
        let dir = TempDir::new();
        dir.file("main/.git/worktrees/wt/HEAD", "ref: refs/heads/topic\n");
        dir.file("wt/.git", "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(read_head(&dir.path().join("wt")), branch("topic"));
    }

    #[test]
    fn a_worktree_with_a_detached_head() {
        let dir = TempDir::new();
        dir.file("main/.git/worktrees/wt/HEAD", &format!("{COMMIT}\n"));
        dir.file("wt/.git", "gitdir: ../main/.git/worktrees/wt\n");
        assert_eq!(read_head(&dir.path().join("wt")), detached("0123456"));
    }

    #[test]
    fn a_git_file_that_points_nowhere_does_not_hide_the_repository_above() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/main\n");
        dir.file("repo/lost/.git", "gitdir: ../../nowhere/at/all\n");
        let inside = dir.folder("repo/lost/src");
        assert_eq!(read_head(&inside), branch("main"));
    }

    /// Whether nothing above the temp folder is a repository, which the tests that expect `None`
    /// need. A machine whose temp folder sits inside a repository skips them, with a warning.
    fn no_repository_above(dir: &TempDir) -> bool {
        let above = dir
            .path()
            .ancestors()
            .find_map(|d| parse_head(&git_dir_of(d)?));
        if above.is_some() {
            eprintln!("warning: the temp folder is inside a repository; skipping a test");
        }
        above.is_none()
    }

    #[test]
    fn outside_any_repository_is_none() {
        let dir = TempDir::new();
        if !no_repository_above(&dir) {
            return;
        }
        let plain = dir.folder("plain/sub");
        assert_eq!(read_head(dir.path()), None);
        assert_eq!(read_head(&plain), None);
    }

    #[test]
    fn a_git_folder_with_nothing_usable_is_not_a_repository() {
        let dir = TempDir::new();
        if !no_repository_above(&dir) {
            return;
        }
        dir.folder("no-head/.git");
        dir.file("empty/.git/HEAD", "");
        dir.folder("dir-head/.git/HEAD");
        for name in ["no-head", "empty", "dir-head"] {
            assert_eq!(read_head(&dir.path().join(name)), None, "{name}");
        }
    }

    #[test]
    fn a_head_that_is_neither_a_branch_nor_a_commit_is_skipped() {
        // Each folder holds a `.git` that cannot be used, so the repository above shows instead.
        let outer = TempDir::new();
        outer.file(".git/HEAD", "ref: refs/heads/outer\n");
        for (name, content) in [
            ("garbage", "this is not a head\n"),
            ("short-id", "0123456\n"),
            ("not-hex", &"z".repeat(40)),
            ("empty-ref", "ref: refs/heads/\n"),
            ("control", "ref: refs/heads/bad\u{1b}[31mname\n"),
            // A reftable repository: the branch is not in HEAD, only this stub.
            ("reftable", "ref: refs/heads/.invalid\n"),
        ] {
            outer.file(&format!("{name}/.git/HEAD"), content);
            assert_eq!(
                read_head(&outer.path().join(name)),
                branch("outer"),
                "{name}"
            );
        }
    }

    #[test]
    fn a_very_long_branch_name_is_refused() {
        let outer = TempDir::new();
        outer.file(".git/HEAD", "ref: refs/heads/outer\n");
        let long = "x".repeat(MAX_BRANCH_CHARS + 1);
        outer.file("repo/.git/HEAD", &format!("ref: refs/heads/{long}\n"));
        assert_eq!(read_head(&outer.path().join("repo")), branch("outer"));
        let longest = "x".repeat(MAX_BRANCH_CHARS);
        outer.file("fits/.git/HEAD", &format!("ref: refs/heads/{longest}\n"));
        assert_eq!(read_head(&outer.path().join("fits")), branch(&longest));
    }

    #[test]
    fn a_huge_head_is_read_only_in_part() {
        let dir = TempDir::new();
        let mut text = String::from("ref: refs/heads/main\n");
        text.push_str(&"x".repeat(1_000_000));
        dir.file("repo/.git/HEAD", &text);
        assert_eq!(read_head(&dir.path().join("repo")), branch("main"));
    }

    #[test]
    fn a_relative_path_gives_nothing() {
        assert_eq!(read_head(Path::new("")), None);
        assert_eq!(read_head(Path::new("src/lib")), None);
        assert_eq!(read_head(Path::new(".")), None);
    }

    #[test]
    fn a_missing_folder_still_finds_the_repository_above() {
        // The shell may report a folder that was just removed; the part that exists decides.
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/main\n");
        let gone = dir.path().join("repo/removed/folder");
        assert_eq!(read_head(&gone), branch("main"));
    }

    #[test]
    fn a_file_path_uses_the_folder_it_is_in() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/main\n");
        let file = dir.file("repo/README.md", "hi");
        assert_eq!(read_head(&file), branch("main"));
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_folder_written_with_forward_slashes_works() {
        // The shells report `C:/Users/me/repo/src` (OSC 7), not a path with backslashes.
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/main\n");
        let inside = dir.folder("repo/src");
        let slashed = inside.to_string_lossy().replace('\\', "/");
        assert!(slashed.contains(":/"), "{slashed}");
        assert_eq!(read_head(Path::new(&slashed)), branch("main"));
    }

    #[test]
    fn a_branch_name_with_non_ascii_letters_is_kept() {
        let dir = TempDir::new();
        dir.file("repo/.git/HEAD", "ref: refs/heads/correção-ü\n");
        assert_eq!(read_head(&dir.path().join("repo")), branch("correção-ü"));
    }
}

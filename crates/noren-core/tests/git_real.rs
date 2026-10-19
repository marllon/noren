//! `read_head` against repositories made by the real `git`: the files it reads are the ones git
//! writes, so a worktree, a detached `HEAD` and a branch with slashes are checked in the form git
//! gives them. Skips with a warning when `git` is not installed. No network, no global config:
//! every command gets a scratch home and a fixed identity.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use noren_core::{GitHead, read_head};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("noren-{name}-{}", std::process::id()));
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

fn branch(name: &str) -> Option<GitHead> {
    Some(GitHead {
        branch: name.to_owned(),
        detached: false,
    })
}

#[test]
fn matches_what_git_reports_for_branches_worktrees_and_detached_heads() {
    if !git_is_installed() {
        eprintln!("warning: git is not installed; skipping the test against real repositories");
        return;
    }
    let root = TempDir::new("git-real");
    let home = root.0.join("home");
    let repo = root.0.join("repo");
    let linked = root.0.join("linked worktree");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(repo.join("src/deep")).unwrap();

    git(&repo, &home, &["init", "--quiet"]);
    // An unborn branch: no commit yet, HEAD already names the branch.
    assert_eq!(read_head(&repo), branch("main"));

    git(
        &repo,
        &home,
        &["commit", "--quiet", "--allow-empty", "-m", "first"],
    );
    git(&repo, &home, &["switch", "--quiet", "-c", "feature/login"]);
    assert_eq!(read_head(&repo), branch("feature/login"));
    assert_eq!(read_head(&repo.join("src/deep")), branch("feature/login"));

    // A linked worktree: its `.git` is a file, and its HEAD is its own.
    git(
        &repo,
        &home,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            "fix/crash",
            linked.to_str().unwrap(),
        ],
    );
    assert!(linked.join(".git").is_file());
    assert_eq!(read_head(&linked), branch("fix/crash"));
    assert_eq!(read_head(&repo), branch("feature/login"));

    // Detached: the short commit, 7 characters, the prefix of what git prints.
    git(&repo, &home, &["switch", "--quiet", "--detach"]);
    let full = git(&repo, &home, &["rev-parse", "HEAD"]);
    assert_eq!(
        read_head(&repo),
        Some(GitHead {
            branch: full[..7].to_owned(),
            detached: true
        })
    );
    assert_eq!(read_head(&linked), branch("fix/crash"));
}

//! Worktrees against repositories made by the real `git`: create (a new branch and an existing
//! one), list, remove, and the refusals (a worktree with changes, the main worktree, a branch name
//! git does not accept, a folder that exists, a folder outside any repository). Skips with a
//! warning when `git` is not installed. No network, no global config: every command gets a scratch
//! home and a fixed identity.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use noren_core::{GitCli, Worktree, WorktreeError, read_head};

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("noren-wt-{name}-{}", std::process::id()));
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

/// A scratch repository with one commit, and the `GitCli` that works in it with the same scratch
/// home. `repo` is `<root>/<repo name>`; the new worktrees land next to it, inside `root`.
struct Fixture {
    root: TempDir,
    home: PathBuf,
    repo: PathBuf,
    cli: GitCli,
}

impl Fixture {
    fn new(name: &str, repo_name: &str) -> Self {
        let root = TempDir::new(name);
        let home = root.0.join("home");
        let repo = root.0.join(repo_name);
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &home, &["init", "--quiet"]);
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        git(&repo, &home, &["add", "README.md"]);
        git(&repo, &home, &["commit", "--quiet", "-m", "first"]);
        let cli = GitCli::system()
            .with_env("HOME", &home)
            .with_env("USERPROFILE", &home)
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
            .with_env("GIT_CONFIG_GLOBAL", home.join("none"));
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

    /// The folder `name` would have next to the repository.
    fn sibling(&self, name: &str) -> PathBuf {
        self.root.0.join(name)
    }

    /// The names (folders) of the worktrees git lists, in order.
    fn listed_names(&self) -> Vec<String> {
        self.cli
            .list(&self.repo)
            .expect("list worktrees")
            .iter()
            .map(folder_name)
            .collect()
    }
}

fn folder_name(worktree: &Worktree) -> String {
    Path::new(&worktree.path)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

fn branch(name: &str) -> Option<noren_core::GitHead> {
    Some(noren_core::GitHead {
        branch: name.to_owned(),
        detached: false,
    })
}

macro_rules! require_git {
    () => {
        if !git_is_installed() {
            eprintln!("warning: git is not installed; skipping the test against real repositories");
            return;
        }
    };
}

#[test]
fn lists_the_main_worktree_of_a_fresh_repository() {
    require_git!();
    let fx = Fixture::new("list-main", "repo");
    let list = fx.cli.list(&fx.repo).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert!(!list[0].detached && !list[0].bare && !list[0].locked);
    assert_eq!(
        list[0].head.as_deref(),
        Some(fx.git(&["rev-parse", "HEAD"]).as_str())
    );
    // A subfolder of the repository lists the same repository.
    fs::create_dir_all(fx.repo.join("src/deep")).unwrap();
    assert_eq!(fx.cli.list(&fx.repo.join("src/deep")).unwrap(), list);
}

#[test]
fn creates_a_worktree_on_a_new_branch_next_to_the_repository() {
    require_git!();
    let fx = Fixture::new("create-new", "repo");
    let created = fx.cli.create(&fx.repo, "feature/login").unwrap();

    let folder = fx.sibling("repo-feature-login");
    assert!(folder.is_dir());
    assert!(
        folder.join(".git").is_file(),
        "a linked worktree has a .git file"
    );
    assert!(folder.join("README.md").is_file());
    assert_eq!(folder_name(&created), "repo-feature-login");
    assert_eq!(created.branch.as_deref(), Some("feature/login"));
    assert_eq!(read_head(&folder), branch("feature/login"));
    // The branch was made from the HEAD of the repository.
    assert_eq!(
        fx.git(&["rev-parse", "feature/login"]),
        fx.git(&["rev-parse", "main"])
    );
    assert_eq!(fx.listed_names(), ["repo", "repo-feature-login"]);
}

#[test]
fn uses_a_branch_that_already_exists() {
    require_git!();
    let fx = Fixture::new("create-existing", "repo");
    fx.git(&["branch", "hotfix"]);
    let before = fx.git(&["branch", "--list"]);

    let created = fx.cli.create(&fx.repo, "hotfix").unwrap();

    assert_eq!(created.branch.as_deref(), Some("hotfix"));
    assert_eq!(read_head(&fx.sibling("repo-hotfix")), branch("hotfix"));
    // No second branch was made: only the checked-out marker of the list changes.
    assert_eq!(
        fx.git(&["branch", "--list", "--format=%(refname:short)"])
            .lines()
            .count(),
        before.lines().count()
    );
}

#[test]
fn a_branch_checked_out_elsewhere_is_refused_with_the_message_of_git() {
    require_git!();
    let fx = Fixture::new("create-checked-out", "repo");
    let error = fx.cli.create(&fx.repo, "main").unwrap_err();
    assert!(matches!(error, WorktreeError::Git(_)), "{error}");
    assert!(error.to_string().contains("main"), "{error}");
    assert!(!fx.sibling("repo-main").exists());
    assert_eq!(fx.listed_names(), ["repo"]);
}

#[test]
fn a_new_worktree_from_inside_another_one_still_lands_next_to_the_main_repository() {
    require_git!();
    let fx = Fixture::new("create-from-linked", "repo");
    fx.cli.create(&fx.repo, "one").unwrap();
    let created = fx.cli.create(&fx.sibling("repo-one"), "two").unwrap();
    assert_eq!(folder_name(&created), "repo-two");
    assert!(fx.sibling("repo-two").is_dir());
    assert!(!fx.sibling("repo-one-two").exists());
    assert_eq!(fx.listed_names(), ["repo", "repo-one", "repo-two"]);
}

#[test]
fn a_repository_folder_with_spaces_and_a_branch_with_dashes_and_dots_work() {
    require_git!();
    let fx = Fixture::new("create-spaces", "my repo");
    let created = fx.cli.create(&fx.repo, "release-1.2/rc").unwrap();
    assert_eq!(folder_name(&created), "my repo-release-1.2-rc");
    assert_eq!(
        read_head(&fx.sibling("my repo-release-1.2-rc")),
        branch("release-1.2/rc")
    );
}

#[test]
fn removes_a_clean_worktree_and_keeps_its_branch() {
    require_git!();
    let fx = Fixture::new("remove-clean", "repo");
    let created = fx.cli.create(&fx.repo, "topic").unwrap();
    assert!(fx.sibling("repo-topic").is_dir());

    fx.cli.remove(&fx.repo, &created.path).unwrap();

    assert!(!fx.sibling("repo-topic").exists());
    assert_eq!(fx.listed_names(), ["repo"]);
    // The branch is still there, and the same branch can get a worktree again.
    assert_eq!(fx.git(&["branch", "--list", "topic"]).trim(), "topic");
    fx.cli.create(&fx.repo, "topic").unwrap();
    assert!(fx.sibling("repo-topic").is_dir());
}

#[test]
fn removing_from_inside_the_worktree_that_goes_away_works() {
    require_git!();
    let fx = Fixture::new("remove-from-inside", "repo");
    let created = fx.cli.create(&fx.repo, "inside").unwrap();
    fx.cli
        .remove(&fx.sibling("repo-inside"), &created.path)
        .unwrap();
    assert!(!fx.sibling("repo-inside").exists());
}

#[test]
fn a_worktree_with_changes_is_refused_and_never_forced() {
    require_git!();
    let fx = Fixture::new("remove-dirty", "repo");
    let created = fx.cli.create(&fx.repo, "dirty").unwrap();
    let folder = fx.sibling("repo-dirty");

    // An untracked file.
    fs::write(folder.join("notes.txt"), "work in progress\n").unwrap();
    let error = fx.cli.remove(&fx.repo, &created.path).unwrap_err();
    assert!(matches!(error, WorktreeError::Git(_)), "{error}");
    assert!(
        error.to_string().contains("untracked") || error.to_string().contains("modified"),
        "the message is the one of git: {error}"
    );
    assert!(folder.join("notes.txt").is_file());
    assert_eq!(fx.listed_names(), ["repo", "repo-dirty"]);

    // A modified tracked file.
    fs::remove_file(folder.join("notes.txt")).unwrap();
    fs::write(folder.join("README.md"), "changed\n").unwrap();
    let error = fx.cli.remove(&fx.repo, &created.path).unwrap_err();
    assert!(matches!(error, WorktreeError::Git(_)), "{error}");
    assert_eq!(
        fs::read_to_string(folder.join("README.md")).unwrap(),
        "changed\n"
    );

    // Once the change is gone the same call removes it.
    fs::write(folder.join("README.md"), "hello\n").unwrap();
    fx.cli.remove(&fx.repo, &created.path).unwrap();
    assert!(!folder.exists());
}

#[test]
fn the_main_worktree_and_a_stranger_are_never_removed() {
    require_git!();
    let fx = Fixture::new("remove-refused", "repo");
    let main = fx.cli.list(&fx.repo).unwrap().remove(0);
    let error = fx.cli.remove(&fx.repo, &main.path).unwrap_err();
    assert!(matches!(error, WorktreeError::MainWorktree(_)), "{error}");
    assert!(fx.repo.join(".git").is_dir());

    let stranger = fx.root.0.join("stranger");
    fs::create_dir_all(&stranger).unwrap();
    let error = fx
        .cli
        .remove(&fx.repo, stranger.to_str().unwrap())
        .unwrap_err();
    assert!(matches!(error, WorktreeError::NotAWorktree(_)), "{error}");
    assert!(stranger.is_dir());
}

#[test]
fn a_branch_name_git_does_not_accept_is_refused_and_nothing_is_made() {
    require_git!();
    let fx = Fixture::new("invalid-branch", "repo");
    for name in [
        "", "   ", "-x", "--detach", "a b", "a..b", "a~1", "a:b", "a^b", "x.lock", "/lead",
        "trail/", "@{-1}", "HEAD",
    ] {
        let error = fx.cli.create(&fx.repo, name).unwrap_err();
        assert!(
            matches!(
                error,
                WorktreeError::BranchEmpty
                    | WorktreeError::BranchStartsWithDash
                    | WorktreeError::BranchInvalid(_)
            ),
            "{name:?}: {error}"
        );
    }
    assert_eq!(fx.listed_names(), ["repo"]);
    let siblings = fs::read_dir(&fx.root.0).unwrap().count();
    assert_eq!(siblings, 2, "only home and repo are in the folder");
}

#[test]
fn a_folder_that_exists_is_refused_and_the_branch_is_not_created() {
    require_git!();
    let fx = Fixture::new("folder-exists", "repo");
    fs::create_dir_all(fx.sibling("repo-taken")).unwrap();
    fs::write(fx.sibling("repo-taken").join("mine.txt"), "keep\n").unwrap();

    let error = fx.cli.create(&fx.repo, "taken").unwrap_err();

    assert!(matches!(error, WorktreeError::FolderExists(_)), "{error}");
    assert!(error.to_string().contains("already exists"), "{error}");
    assert!(fx.sibling("repo-taken").join("mine.txt").is_file());
    assert_eq!(fx.git(&["branch", "--list", "taken"]), "");
    // `a/b` and `a-b` name the same folder: the second one is refused for that.
    fx.cli.create(&fx.repo, "a/b").unwrap();
    let error = fx.cli.create(&fx.repo, "a-b").unwrap_err();
    assert!(matches!(error, WorktreeError::FolderExists(_)), "{error}");
}

#[test]
fn a_folder_outside_a_repository_gives_a_readable_error() {
    require_git!();
    let fx = Fixture::new("outside", "repo");
    let plain = fx.root.0.join("plain");
    fs::create_dir_all(&plain).unwrap();

    for error in [
        fx.cli.list(&plain).unwrap_err(),
        fx.cli.create(&plain, "x").unwrap_err(),
        fx.cli.remove(&plain, "/anything").unwrap_err(),
    ] {
        assert!(matches!(error, WorktreeError::NotARepository(_)), "{error}");
        assert!(error.to_string().contains("not inside a git repository"));
    }
    let gone = fx.root.0.join("gone");
    assert!(matches!(
        fx.cli.list(&gone).unwrap_err(),
        WorktreeError::NotAFolder(_)
    ));
}

#[test]
fn git_that_is_not_installed_gives_a_readable_error() {
    let root = TempDir::new("no-git");
    let cli = GitCli::with_program("noren-git-that-does-not-exist");
    for error in [
        cli.list(&root.0).unwrap_err(),
        cli.create(&root.0, "x").unwrap_err(),
        cli.remove(&root.0, "/x").unwrap_err(),
    ] {
        assert!(matches!(error, WorktreeError::GitMissing(_)), "{error}");
        assert!(error.to_string().contains("Install git"), "{error}");
    }
}

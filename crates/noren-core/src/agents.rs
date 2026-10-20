//! Finds the CLI agent (a program that works for you in a terminal) running inside a session.
//!
//! The rule is a pure function of a picture of the process tree: [`find_agent`] takes the list of
//! processes (pid, parent, name, command line), the pid of the shell of a session and the catalog,
//! and answers the agent among the descendants of that shell. The real picture comes from
//! `sysinfo` ([`SystemProcesses`]) behind the [`ProcessSource`] trait, so the tests feed trees they
//! made up.
//!
//! The catalog identifies an agent by the name of its executable. Matching never looks at a part of
//! a name: `claudette` is not `claude`. A program that only runs other programs (`node`, `python`,
//! `npx`...) matches when an argument of its command line names a package the entry lists. The
//! catalog belongs to the user (`agents.catalog` of `config.jsonc`) and arrives from the page, so
//! its size is bounded before it is used ([`check_catalog`]).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::pty::SessionId;

/// Most entries a catalog may have.
pub const MAX_CATALOG_ENTRIES: usize = 64;
/// Most executable names, and most package names, one entry may list.
pub const MAX_ENTRY_NAMES: usize = 16;
/// Longest id or name in a catalog, in characters.
pub const MAX_NAME_CHARS: usize = 64;

/// Programs that start other programs: their own name says nothing, their arguments do.
const RUNNERS: &[&str] = &[
    "node", "nodejs", "npx", "bun", "bunx", "deno", "python", "python3", "py", "uv", "uvx", "pipx",
];

/// Endings a launcher adds to a program name on Windows; they are not part of the name.
const LAUNCHER_EXTENSIONS: &[&str] = &[".exe", ".cmd", ".bat", ".com"];

/// One process of the picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub parent: Option<u32>,
    /// The name of the program (`claude.exe`, `node`), as the system reports it.
    pub name: String,
    /// The command line, program first. Empty when the system would not say.
    pub cmdline: Vec<String>,
}

/// One agent of the catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentEntry {
    pub id: String,
    /// Names of the executable (`claude`); `.exe`, `.cmd`, `.bat` and the case are not part of it.
    pub executables: Vec<String>,
    /// Names of the packages that, found in an argument of `node`, `python`, `npx`..., mean it.
    pub packages: Vec<String>,
}

/// The agent found under a shell, and the process that is it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMatch {
    /// The `id` of the catalog entry.
    pub id: String,
    pub pid: u32,
}

/// Where the picture of the process tree comes from.
pub trait ProcessSource {
    fn snapshot(&self) -> Vec<ProcessInfo>;
}

/// The processes of this machine, read with `sysinfo`. It keeps the `System` between calls, so the
/// second picture only refreshes what changed.
pub struct SystemProcesses {
    system: Mutex<System>,
}

impl Default for SystemProcesses {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemProcesses {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }
}

impl ProcessSource for SystemProcesses {
    fn snapshot(&self) -> Vec<ProcessInfo> {
        let mut system = self.system.lock().unwrap_or_else(|e| e.into_inner());
        // The name and the parent come with any refresh; the command line is asked for once per
        // process (it does not change) and is the one costly read.
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
        );
        system
            .processes()
            .iter()
            .map(|(pid, process)| ProcessInfo {
                pid: pid.as_u32(),
                parent: process.parent().map(sysinfo::Pid::as_u32),
                name: process.name().to_string_lossy().into_owned(),
                cmdline: process
                    .cmd()
                    .iter()
                    .map(|part| part.to_string_lossy().into_owned())
                    .collect(),
            })
            .collect()
    }
}

/// Why a catalog was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogError(pub String);

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CatalogError {}

/// Bounds a catalog that came from the page: the page's word is not taken. Refused as a whole,
/// with the reason, when it has too many entries or names, a blank or too long name, or an id used
/// twice.
pub fn check_catalog(catalog: &[AgentEntry]) -> Result<(), CatalogError> {
    if catalog.len() > MAX_CATALOG_ENTRIES {
        return Err(CatalogError(format!(
            "the agent catalog has {} entries; at most {MAX_CATALOG_ENTRIES}",
            catalog.len()
        )));
    }
    let mut seen = HashSet::new();
    for (index, entry) in catalog.iter().enumerate() {
        let number = index + 1;
        let name_ok =
            |name: &String| !name.trim().is_empty() && name.chars().count() <= MAX_NAME_CHARS;
        if !name_ok(&entry.id) {
            return Err(CatalogError(format!(
                "agent {number}: the id must be 1 to {MAX_NAME_CHARS} characters"
            )));
        }
        if !seen.insert(entry.id.to_lowercase()) {
            return Err(CatalogError(format!(
                "agent {number}: the id \"{}\" is used twice",
                entry.id
            )));
        }
        for names in [&entry.executables, &entry.packages] {
            if names.len() > MAX_ENTRY_NAMES || !names.iter().all(name_ok) {
                return Err(CatalogError(format!(
                    "agent {number}: at most {MAX_ENTRY_NAMES} names of 1 to {MAX_NAME_CHARS} characters"
                )));
            }
        }
    }
    Ok(())
}

/// The name of a program for comparing: the file name without its folder and without the ending a
/// Windows launcher adds, in lower case.
pub fn program_name(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = file.trim().to_lowercase();
    for extension in LAUNCHER_EXTENSIONS {
        if let Some(stem) = lower.strip_suffix(extension)
            && !stem.is_empty()
        {
            return stem.to_owned();
        }
    }
    lower
}

/// Whether `argument` of a command line names the package `package`: it is the package, or a path
/// or a `name@version` whose segment is the package. Whole segments only, so `my-aider-fork` is not
/// `aider`.
fn mentions_package(argument: &str, package: &str) -> bool {
    let package = package.trim().to_lowercase().replace('\\', "/");
    if package.is_empty() {
        return false;
    }
    let argument = argument.trim().to_lowercase().replace('\\', "/");
    let bounded = |text: &str| {
        text == package
            || text.strip_prefix(package.as_str()).is_some_and(|rest| {
                rest.starts_with('@') || rest.starts_with('/') || rest.starts_with(".")
            })
    };
    // Every suffix that starts at a segment boundary.
    std::iter::once(argument.as_str())
        .chain(argument.match_indices('/').map(|(i, _)| &argument[i + 1..]))
        .any(bounded)
}

/// The entry of the catalog the process is, if any.
fn entry_of<'a>(process: &ProcessInfo, catalog: &'a [AgentEntry]) -> Option<&'a AgentEntry> {
    let name = program_name(&process.name);
    // A process whose name is blank (some systems hide it) is known by its command line.
    let name = if name.is_empty() {
        process
            .cmdline
            .first()
            .map(|c| program_name(c))
            .unwrap_or_default()
    } else {
        name
    };
    if let Some(entry) = catalog.iter().find(|entry| {
        entry
            .executables
            .iter()
            .any(|executable| program_name(executable) == name)
    }) {
        return Some(entry);
    }
    if RUNNERS.contains(&name.as_str()) {
        return catalog.iter().find(|entry| {
            entry.packages.iter().any(|package| {
                process
                    .cmdline
                    .iter()
                    .skip(1)
                    .any(|argument| mentions_package(argument, package))
            })
        });
    }
    None
}

/// The agent among the descendants of the process `root` (not `root` itself): the one nearest to
/// it, and the one with the lowest pid among those at the same distance. `None` when `root` is not
/// in the picture (the shell ended), when it has no descendants, or when none is in the catalog.
/// A parent loop in the picture (a pid the system reused) does not make it run forever.
pub fn find_agent(
    processes: &[ProcessInfo],
    root: u32,
    catalog: &[AgentEntry],
) -> Option<AgentMatch> {
    if !processes.iter().any(|process| process.pid == root) {
        return None;
    }
    let mut children: HashMap<u32, Vec<&ProcessInfo>> = HashMap::new();
    for process in processes {
        if let Some(parent) = process.parent
            && parent != process.pid
        {
            children.entry(parent).or_default().push(process);
        }
    }
    let mut visited = HashSet::from([root]);
    let mut level = vec![root];
    while !level.is_empty() {
        let mut next: Vec<&ProcessInfo> = Vec::new();
        for pid in &level {
            for child in children.get(pid).into_iter().flatten() {
                if visited.insert(child.pid) {
                    next.push(child);
                }
            }
        }
        next.sort_by_key(|process| process.pid);
        if let Some((process, entry)) = next
            .iter()
            .find_map(|process| entry_of(process, catalog).map(|entry| (process, entry)))
        {
            return Some(AgentMatch {
                id: entry.id.clone(),
                pid: process.pid,
            });
        }
        level = next.iter().map(|process| process.pid).collect();
    }
    None
}

/// One picture of the tree for all the sessions: the agent under the shell of each one that has
/// one. A session whose shell has no pid, or no agent under it, is left out.
pub fn scan_sessions(
    source: &dyn ProcessSource,
    roots: &[(SessionId, Option<u32>)],
    catalog: &[AgentEntry],
) -> Vec<(SessionId, AgentMatch)> {
    if catalog.is_empty() || roots.iter().all(|(_, pid)| pid.is_none()) {
        return Vec::new();
    }
    let processes = source.snapshot();
    roots
        .iter()
        .filter_map(|(session, pid)| {
            let found = find_agent(&processes, (*pid)?, catalog)?;
            Some((*session, found))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, name: &str, cmd: &[&str]) -> ProcessInfo {
        ProcessInfo {
            pid,
            parent: Some(parent),
            name: name.to_owned(),
            cmdline: cmd.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn entry(id: &str, executables: &[&str], packages: &[&str]) -> AgentEntry {
        AgentEntry {
            id: id.to_owned(),
            executables: executables.iter().map(|s| (*s).to_owned()).collect(),
            packages: packages.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn catalog() -> Vec<AgentEntry> {
        vec![
            entry("claude", &["claude"], &[]),
            entry("codex", &["codex"], &[]),
            entry("aider", &["aider"], &["aider"]),
        ]
    }

    /// The shell of the session is pid 100 and sits under the app (pid 1).
    fn shell() -> ProcessInfo {
        proc(100, 1, "pwsh.exe", &["pwsh.exe"])
    }

    #[test]
    fn a_direct_child_of_the_shell_is_found() {
        let tree = [shell(), proc(200, 100, "claude.exe", &["claude.exe"])];
        assert_eq!(
            find_agent(&tree, 100, &catalog()),
            Some(AgentMatch {
                id: "claude".into(),
                pid: 200
            })
        );
    }

    #[test]
    fn a_grandchild_through_another_shell_is_found() {
        let tree = [
            shell(),
            proc(150, 100, "cmd.exe", &["cmd.exe", "/c", "codex"]),
            proc(210, 150, "codex.exe", &["codex.exe", "--help"]),
        ];
        let found = find_agent(&tree, 100, &catalog()).expect("agent");
        assert_eq!((found.id.as_str(), found.pid), ("codex", 210));
    }

    #[test]
    fn no_agent_is_none() {
        let tree = [
            shell(),
            proc(200, 100, "git.exe", &["git.exe", "status"]),
            proc(201, 200, "ssh.exe", &["ssh.exe"]),
        ];
        assert_eq!(find_agent(&tree, 100, &catalog()), None);
        assert_eq!(find_agent(&[shell()], 100, &catalog()), None);
    }

    #[test]
    fn with_two_agents_the_nearest_wins_and_then_the_lowest_pid() {
        let deep_first = [
            shell(),
            proc(150, 100, "bash", &["bash"]),
            proc(160, 150, "codex", &["codex"]),
            proc(300, 100, "claude", &["claude"]),
        ];
        assert_eq!(
            find_agent(&deep_first, 100, &catalog()).map(|m| m.id),
            Some("claude".into())
        );
        let same_depth = [
            shell(),
            proc(300, 100, "claude", &["claude"]),
            proc(250, 100, "codex", &["codex"]),
        ];
        assert_eq!(
            find_agent(&same_depth, 100, &catalog()).map(|m| m.id),
            Some("codex".into())
        );
    }

    #[test]
    fn a_vanished_shell_is_none_even_with_agents_around() {
        let tree = [
            proc(1, 0, "noren.exe", &[]),
            proc(200, 1, "claude.exe", &["claude.exe"]),
        ];
        assert_eq!(find_agent(&tree, 100, &catalog()), None);
    }

    #[test]
    fn a_similar_name_does_not_match() {
        let tree = [
            shell(),
            proc(200, 100, "claudette.exe", &[]),
            proc(201, 100, "claude-helper", &[]),
            proc(202, 100, "myclaude", &[]),
            proc(203, 100, "codexd", &[]),
            proc(204, 100, "claud", &[]),
        ];
        assert_eq!(find_agent(&tree, 100, &catalog()), None);
    }

    #[test]
    fn the_agent_that_is_not_below_the_shell_is_not_found() {
        let tree = [
            shell(),
            proc(2, 1, "pwsh.exe", &[]),
            proc(200, 2, "claude.exe", &[]),
        ];
        assert_eq!(find_agent(&tree, 100, &catalog()), None);
    }

    #[test]
    fn the_shell_itself_is_not_a_descendant() {
        let tree = [proc(100, 1, "claude", &["claude"])];
        assert_eq!(find_agent(&tree, 100, &catalog()), None);
    }

    #[test]
    fn case_extension_and_folder_do_not_matter() {
        for name in ["CLAUDE.EXE", "claude.cmd", "Claude", "claude.bat"] {
            let tree = [shell(), proc(200, 100, name, &[])];
            assert!(find_agent(&tree, 100, &catalog()).is_some(), "{name}");
        }
        assert_eq!(program_name("C:\\Tools\\Claude.exe"), "claude");
        assert_eq!(program_name("/usr/local/bin/codex"), "codex");
    }

    #[test]
    fn a_runner_matches_only_through_a_package_the_catalog_lists() {
        let python = proc(
            200,
            100,
            "python.exe",
            &["python.exe", "-m", "aider", "--model", "x"],
        );
        assert_eq!(
            find_agent(&[shell(), python.clone()], 100, &catalog()).map(|m| m.id),
            Some("aider".into())
        );
        // The same process with a catalog that lists no package is nothing.
        let bare = vec![entry("aider", &["aider"], &[])];
        assert_eq!(find_agent(&[shell(), python], 100, &bare), None);
        // A runner of something else is nothing.
        let other = proc(201, 100, "node.exe", &["node.exe", "server.js"]);
        assert_eq!(find_agent(&[shell(), other], 100, &catalog()), None);
    }

    #[test]
    fn a_package_is_matched_by_whole_segments() {
        assert!(mentions_package("aider", "aider"));
        assert!(mentions_package("aider@1.2.3", "aider"));
        assert!(mentions_package(
            "C:\\npm\\node_modules\\aider\\cli.js",
            "aider"
        ));
        assert!(mentions_package(
            "/x/node_modules/@scope/tool/bin.js",
            "@scope/tool"
        ));
        assert!(!mentions_package("my-aider-fork", "aider"));
        assert!(!mentions_package("/x/aiderish/cli.js", "aider"));
        assert!(!mentions_package("", "aider"));
        assert!(!mentions_package("aider", ""));
    }

    #[test]
    fn a_loop_in_the_parents_ends() {
        let tree = [
            shell(),
            proc(200, 300, "git", &[]),
            proc(300, 200, "git", &[]),
            proc(400, 100, "git", &[]),
            proc(401, 401, "git", &[]),
        ];
        assert_eq!(find_agent(&tree, 100, &catalog()), None);
        let cyclic = [proc(100, 200, "pwsh", &[]), proc(200, 100, "claude", &[])];
        assert_eq!(
            find_agent(&cyclic, 100, &catalog()).map(|m| m.pid),
            Some(200)
        );
    }

    struct Fake(Vec<ProcessInfo>);
    impl ProcessSource for Fake {
        fn snapshot(&self) -> Vec<ProcessInfo> {
            self.0.clone()
        }
    }

    #[test]
    fn scan_answers_each_session_from_one_picture() {
        let source = Fake(vec![
            shell(),
            proc(200, 100, "claude.exe", &[]),
            proc(101, 1, "bash", &[]),
            proc(102, 1, "bash", &[]),
            proc(250, 102, "codex", &[]),
        ]);
        let roots = [
            (SessionId(1), Some(100)),
            (SessionId(2), Some(101)),
            (SessionId(3), Some(102)),
            (SessionId(4), None),
            (SessionId(5), Some(999)),
        ];
        let found = scan_sessions(&source, &roots, &catalog());
        let summary: Vec<(u64, &str)> = found.iter().map(|(s, m)| (s.0, m.id.as_str())).collect();
        assert_eq!(summary, vec![(1, "claude"), (3, "codex")]);
    }

    #[test]
    fn scan_with_an_empty_catalog_does_not_take_a_picture() {
        struct Never;
        impl ProcessSource for Never {
            fn snapshot(&self) -> Vec<ProcessInfo> {
                panic!("no picture needed");
            }
        }
        assert!(scan_sessions(&Never, &[(SessionId(1), Some(1))], &[]).is_empty());
        assert!(scan_sessions(&Never, &[(SessionId(1), None)], &catalog()).is_empty());
    }

    #[test]
    fn the_catalog_is_checked() {
        assert!(check_catalog(&catalog()).is_ok());
        let twice = vec![entry("a", &["a"], &[]), entry("A", &["b"], &[])];
        assert!(check_catalog(&twice).is_err());
        assert!(check_catalog(&[entry(" ", &["a"], &[])]).is_err());
        assert!(check_catalog(&[entry("a", &[""], &[])]).is_err());
        let many: Vec<AgentEntry> = (0..=MAX_CATALOG_ENTRIES)
            .map(|n| entry(&format!("a{n}"), &["x"], &[]))
            .collect();
        assert!(check_catalog(&many).is_err());
        let long = "x".repeat(MAX_NAME_CHARS + 1);
        assert!(check_catalog(&[entry("a", &[long.as_str()], &[])]).is_err());
    }

    #[test]
    fn the_system_picture_holds_this_test_process_and_its_parent() {
        let processes = SystemProcesses::new().snapshot();
        let me = std::process::id();
        let mine = processes.iter().find(|p| p.pid == me).expect("own process");
        assert!(mine.parent.is_some());
        assert!(!mine.name.is_empty());
        // The test process is a descendant of its own parent, and of nothing in the catalog.
        let parent = mine.parent.expect("parent");
        assert_eq!(find_agent(&processes, parent, &catalog()), None);
    }
}

// Pure rules of the "New worktree" command, shared by the dialog (to tell a problem before asking)
// and by the fake backend (to name the folder as the real one does). `git` has the last word on a
// branch name; this only catches what is plain without it, the same checks the Rust side makes first
// (`validate_branch_name`, `worktree_folder_name`).

/** What is wrong with a branch name before git is asked: blank, or a leading dash git reads as an option. */
export type BranchProblem = "empty" | "dash" | "control";

/** The plain problem with `name`, or `undefined` when it needs git's opinion to be judged. */
export function branchProblem(name: string): BranchProblem | undefined {
  if (name.trim() === "") return "empty";
  if (name.startsWith("-")) return "dash";
  // eslint-disable-next-line no-control-regex -- control characters are what is being refused
  if (/[\u0000-\u001f\u007f]/.test(name)) return "control";
  return undefined;
}

/**
 * The name of the folder of a new worktree: the repository name, a dash, the branch with every
 * separator and every character Windows does not allow in a file name turned into a dash
 * (`noren` and `feature/login` give `noren-feature-login`).
 */
export function worktreeFolderName(repoName: string, branch: string): string {
  return `${repoName}-${branch.replace(/[/\\:*?"<>|]/g, "-")}`;
}

/** The last segment of a path, with `/` or `\` as separator; empty for a root. */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/**
 * Where the worktree of `branch` goes: next to the main worktree `mainPath` (same parent folder),
 * in the separator that path uses. `undefined` when `mainPath` has no parent folder or no name.
 */
export function worktreeDestination(mainPath: string, branch: string): string | undefined {
  const trimmed = mainPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = lastSegment(trimmed);
  if (cut < 0 || name === "") return undefined;
  const separator = trimmed[cut] ?? "/";
  return `${trimmed.slice(0, cut)}${separator}${worktreeFolderName(name, branch)}`;
}

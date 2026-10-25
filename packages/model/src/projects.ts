import type { ProjectAction } from "./actions-file";
import type { ActionsFileState } from "./actions-watcher";
import type { Id, Space } from "./types";

/**
 * The action the one-line block of a space runs: the first one marked `"main": true`, else the
 * first of the file. `undefined` for a file with no action.
 */
export function mainAction(actions: readonly ProjectAction[]): ProjectAction | undefined {
  return actions.find((action) => action.main === true) ?? actions[0];
}

/** One block of the Projects section: a space with a valid actions file and at least one action. */
export interface ProjectEntry {
  space: Space;
  /** Every action of the file, in the order of the file. */
  actions: readonly ProjectAction[];
  /** The one the closed block's button runs. */
  main: ProjectAction;
  /** The block shows the other actions too. */
  open: boolean;
}

/**
 * The blocks of the Projects section, in the order of `spaces` (the order of the switcher). A space
 * is left out when it asks to be (`inProjects: false`), when its file was not read yet, is missing,
 * invalid or unreadable, or declares no action. A space with no folder has no file to read.
 */
export function listProjects(
  spaces: readonly Space[],
  files: ReadonlyMap<Id, ActionsFileState>,
): ProjectEntry[] {
  return spaces.flatMap((space): ProjectEntry[] => {
    if (space.inProjects === false) return [];
    const file = files.get(space.id);
    if (file?.status !== "ok") return [];
    const main = mainAction(file.actions);
    if (main === undefined) return [];
    return [{ space, actions: file.actions, main, open: space.projectsOpen === true }];
  });
}

/** True when some action of the block runs (`isRunning` answers for one action of the space). */
export function anyRunning(
  entry: Pick<ProjectEntry, "actions">,
  isRunning: (action: ProjectAction) => boolean,
): boolean {
  return entry.actions.some(isRunning);
}

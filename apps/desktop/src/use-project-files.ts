import type { ActionsFileState, Backend, Id, Space } from "@noren/model";
import { useMemo } from "react";
import { useWatchedActionFiles } from "./use-favorite-actions";

/**
 * The actions file of every space the Projects section may list: each one with a folder that has not
 * asked to be left out (`Space.inProjects`). The files are polled like the ones of the Favorites bar,
 * so a block appears, changes or goes within a couple of seconds of the file changing.
 */
export function useProjectFiles(
  backend: Pick<Backend, "readActionsFile">,
  spaces: readonly Space[],
): ReadonlyMap<Id, ActionsFileState> {
  const wanted = useMemo(() => {
    const folders = new Map<Id, string>();
    for (const space of spaces) {
      if (space.inProjects === false || space.defaults.cwd === undefined) continue;
      folders.set(space.id, space.defaults.cwd);
    }
    return folders;
  }, [spaces]);
  return useWatchedActionFiles(backend, wanted);
}

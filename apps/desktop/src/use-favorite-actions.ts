import { watchActionsFile } from "@noren/model";
import type { ActionsFileState, Backend, FavoriteLink, Id, Space } from "@noren/model";
import { useEffect, useMemo, useState } from "react";
import { realClock } from "./real-clock";

/** A reading of the actions file of a space, with the folder it was read in. */
interface Reading {
  cwd: string;
  state: ActionsFileState;
}

const folderKey = (spaceId: Id, cwd: string) => `${spaceId}\u0000${cwd}`;

/**
 * The actions file of every space that has an action in the Favorites bar. The bar is shown in every
 * space, so its tiles cannot wait for a space to be the active one: each folder is watched as long as
 * the bar holds an action of its space (the same polling as the header of the active space), and
 * the watcher goes when the last action of the space leaves the bar or the folder changes. A space
 * with no folder is not read (its tiles say so). A reading made in a folder that is not the space's
 * folder any more is never handed back.
 */
export function useFavoriteActionFiles(
  backend: Pick<Backend, "readActionsFile">,
  spaces: readonly Space[],
  links: readonly FavoriteLink[],
): ReadonlyMap<Id, ActionsFileState> {
  const [readings, setReadings] = useState<ReadonlyMap<Id, Reading>>(new Map());

  const wanted = useMemo(() => {
    const folders = new Map<Id, string>();
    for (const link of links) {
      if (link.kind !== "action" || folders.has(link.spaceId)) continue;
      const cwd = spaces.find((space) => space.id === link.spaceId)?.defaults.cwd;
      if (cwd !== undefined) folders.set(link.spaceId, cwd);
    }
    return folders;
  }, [spaces, links]);
  const wantedKey = [...wanted].map(([spaceId, cwd]) => folderKey(spaceId, cwd)).join("\n");

  useEffect(() => {
    const watchers = [...wanted].map(([spaceId, cwd]) =>
      watchActionsFile({
        backend,
        cwd,
        clock: realClock,
        onChange: (state) =>
          setReadings((current) => new Map(current).set(spaceId, { cwd, state })),
      }),
    );
    return () => {
      for (const watcher of watchers) watcher.dispose();
    };
    // `wantedKey` stands for `wanted`: a new Map with the same folders must not restart the polling.
  }, [backend, wantedKey]);

  return useMemo(() => {
    const current = new Map<Id, ActionsFileState>();
    for (const [spaceId, cwd] of wanted) {
      const reading = readings.get(spaceId);
      if (reading?.cwd === cwd) current.set(spaceId, reading.state);
    }
    return current;
  }, [wanted, readings]);
}

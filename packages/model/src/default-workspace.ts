import type { Clock } from "./clock";
import { DEFAULT_PROFILE_ID, createEmptySpace, createPane, createTab } from "./factories";
import { createSequentialIds, type IdGenerator } from "./ids";
import type { Workspace } from "./types";

export interface DefaultWorkspaceOptions {
  /** Defaults to a sequential generator, which is deterministic but not unique across restarts. */
  newId?: IdGenerator;
  /** Source of `lastActivityAt`. Defaults to a fixed 0. */
  clock?: Pick<Clock, "now">;
  /** Profile of the first pane. */
  profileId?: string;
}

/** A workspace with the space "Main" holding one tab of one pane. */
export function createDefaultWorkspace(options: DefaultWorkspaceOptions = {}): Workspace {
  const newId = options.newId ?? createSequentialIds();
  const now = options.clock?.now() ?? 0;
  const spaceId = newId();
  const itemId = newId();
  const paneId = newId();
  const item = createTab(itemId, createPane(paneId, options.profileId ?? DEFAULT_PROFILE_ID), now);
  return {
    version: 1,
    spaces: [
      {
        ...createEmptySpace(spaceId, "Main"),
        tree: [{ kind: "item", id: itemId }],
        items: { [itemId]: item },
      },
    ],
    activeSpaceId: spaceId,
    favorites: [],
    closed: [],
    archive: [],
  };
}

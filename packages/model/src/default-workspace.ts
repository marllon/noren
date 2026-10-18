import type { Clock } from "./clock";
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
  return {
    version: 1,
    spaces: [
      {
        id: spaceId,
        name: "Main",
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: true,
        pinned: [],
        tree: [{ kind: "item", id: itemId }],
        items: {
          [itemId]: {
            id: itemId,
            titleLocked: false,
            layout: {
              kind: "pane",
              pane: {
                id: paneId,
                type: "terminal",
                profileId: options.profileId ?? "default",
                status: "idle",
                unread: false,
                bell: false,
              },
            },
            focusedPaneId: paneId,
            lastActivityAt: now,
          },
        },
      },
    ],
    activeSpaceId: spaceId,
    favorites: [],
    closed: [],
    archive: [],
  };
}

import { createEmptySpace, createPane, createTab } from "./factories";
import type { GroupNode, Item, Pane, Workspace } from "./types";

// Shared by the state tests. Not part of the public API.

/**
 * A `state.json` as version 0 wrote it: `activeSpace` instead of `activeSpaceId`, no favorites,
 * closed or archive lists, and spaces without icon, color, defaults, mods, AI or scrollback fields.
 * Space "Main" has one tab; space "Docs" has a split of two panes. Panes carry stale sessions.
 */
export const STATE_V0_FIXTURE = JSON.stringify(
  {
    version: 0,
    activeSpace: "s2",
    spaces: [
      {
        id: "s1",
        name: "Main",
        pinned: [],
        tree: [{ kind: "item", id: "i1" }],
        items: {
          i1: {
            id: "i1",
            titleLocked: false,
            layout: {
              kind: "pane",
              pane: {
                id: "p1",
                type: "terminal",
                sessionId: "old-1",
                profileId: "bash",
                cwd: "/work/app",
                status: "running",
                unread: false,
                bell: false,
              },
            },
            focusedPaneId: "p1",
            lastActivityAt: 10,
          },
        },
      },
      {
        id: "s2",
        name: "Docs",
        pinned: [],
        tree: [{ kind: "item", id: "i2" }],
        items: {
          i2: {
            id: "i2",
            title: "writing",
            titleLocked: true,
            layout: {
              kind: "split",
              dir: "row",
              sizes: [50, 50],
              children: [
                {
                  kind: "pane",
                  pane: {
                    id: "p2",
                    type: "terminal",
                    sessionId: "old-2",
                    profileId: "bash",
                    cwd: "/work/docs",
                    status: "idle",
                    unread: true,
                    bell: false,
                  },
                },
                {
                  kind: "pane",
                  pane: {
                    id: "p3",
                    type: "terminal",
                    profileId: "bash",
                    status: "exited",
                    exitCode: 1,
                    unread: false,
                    bell: false,
                  },
                },
              ],
            },
            focusedPaneId: "p2",
            lastActivityAt: 20,
          },
        },
      },
    ],
  },
  null,
  2,
);

const withSession = (pane: Pane, sessionId: string): Pane => ({ ...pane, sessionId });

/**
 * A valid workspace with a bit of everything: two spaces with defaults, a pinned item, a group
 * holding a split, a favorite and a closed item. Panes hold sessions `x1`..`x3`; pane `p2` has
 * no cwd. Never mutate the result of one call after handing it to another.
 */
export function richWorkspace(): Workspace {
  const pinned: Item = createTab(
    "i1",
    withSession(createPane("p1", "bash", "/work/app"), "x1"),
    100,
  );
  const split: Item = {
    ...createTab("i2", withSession(createPane("p2", "default"), "x2"), 200),
    title: "two panes",
    titleLocked: true,
    layout: {
      kind: "split",
      dir: "column",
      sizes: [30, 70],
      children: [
        { kind: "pane", pane: withSession(createPane("p2", "default"), "x2") },
        { kind: "pane", pane: withSession(createPane("p3", "bash", "/work/docs"), "x3") },
      ],
    },
    focusedPaneId: "p3",
  };
  const closed: Item = createTab("i3", createPane("p4", "bash", "/old"), 50);
  const group: GroupNode = {
    kind: "group",
    id: "g1",
    name: "docs",
    color: "teal",
    collapsed: true,
    children: [{ kind: "item", id: "i2" }],
  };
  const main = createEmptySpace("s1", "Main", { cwd: "/work", profileId: "bash" });
  const work = createEmptySpace("s2", "Work");
  return {
    version: 1,
    spaces: [
      {
        ...main,
        pinned: ["i1"],
        tree: [group],
        items: { i1: pinned, i2: split },
        defaults: {
          ...main.defaults,
          env: { MODE: "dev" },
          gitIdentity: { name: "A", email: "a@x.io" },
        },
      },
      { ...work, themeId: "noren-paper", modIds: ["mod-a"] },
    ],
    activeSpaceId: "s1",
    favorites: ["i1"],
    closed: [{ item: closed, spaceId: "s2", closedAt: 60 }],
    archive: [],
  };
}

import type { Page } from "@playwright/test";

// Key of `state.json` in the browser storage of web mode (apps/desktop/src/web-backend.ts).
const WEB_STATE_KEY = "noren.web.state";

interface PaneSeed {
  id: string;
  cwd?: string;
  gitBranch?: string;
  unread?: boolean;
  bell?: boolean;
}

function tab(id: string, title: string, pane: PaneSeed) {
  return {
    id,
    title,
    titleLocked: true,
    layout: {
      kind: "pane",
      pane: {
        id: pane.id,
        type: "terminal",
        profileId: "default",
        ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
        ...(pane.gitBranch !== undefined ? { gitBranch: pane.gitBranch } : {}),
        status: "idle",
        unread: pane.unread ?? false,
        bell: pane.bell ?? false,
      },
    },
    focusedPaneId: pane.id,
    lastActivityAt: 1,
  };
}

/** Home folder of the in-memory backend, so folders under it show as `~`. */
export const FAKE_HOME = "/home/fake";

/**
 * A saved workspace for the sidebar: one pinned tab, a group of three tabs and two loose ones, with
 * folders, a git branch, an unread tab and a tab with a bell. The tab "build" has no flags: the
 * tests make it fail by running `exit 2` in it. `secondSpace` adds the space "Other" with one tab
 * ("elsewhere"), for the tests that drop a tab on another space.
 */
export function sidebarState(options: { secondSpace?: boolean } = {}): string {
  const second = {
    id: "s2",
    name: "Other",
    icon: "folder",
    color: "#e0a458",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: [],
    tree: [{ kind: "item", id: "j1" }],
    items: { j1: tab("j1", "elsewhere", { id: "q1" }) },
    activeItemId: "j1",
  };
  return JSON.stringify({
    version: 2,
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
    spaces: [
      {
        id: "s1",
        name: "Main",
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: true,
        pinned: ["i1"],
        tree: [
          {
            kind: "group",
            id: "g1",
            name: "Work",
            color: "teal",
            collapsed: false,
            children: [
              { kind: "item", id: "i2" },
              { kind: "item", id: "i3" },
              { kind: "item", id: "i4" },
            ],
          },
          { kind: "item", id: "i5" },
          { kind: "item", id: "i6" },
        ],
        items: {
          i1: tab("i1", "notes", { id: "p1", cwd: `${FAKE_HOME}` }),
          i2: tab("i2", "api", {
            id: "p2",
            cwd: `${FAKE_HOME}/projects/noren`,
            gitBranch: "main",
          }),
          i3: tab("i3", "build", { id: "p3", cwd: "/srv/builds/noren/release" }),
          i4: tab("i4", "logs", { id: "p4", cwd: "/var/log", unread: true }),
          i5: tab("i5", "deploy", {
            id: "p5",
            cwd: "C:\\Users\\ada\\dev\\site",
            gitBranch: "feature/long-branch-name",
            bell: true,
          }),
          i6: tab("i6", "scratch", { id: "p6" }),
        },
        activeItemId: "i2",
      },
      ...(options.secondSpace ? [second] : []),
    ],
  });
}

/** Seeds the saved workspace before the page loads; it only writes when nothing is saved yet. */
export async function seedSidebarState(
  page: Page,
  options: { secondSpace?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ key, state }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, state);
    },
    { key: WEB_STATE_KEY, state: sidebarState(options) },
  );
}

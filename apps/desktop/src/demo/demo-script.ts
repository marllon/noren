import { WEB_GIT_KEY, WEB_STATE_KEY } from "../web-backend";
import type { StateStorage } from "../web-backend";

// The script of the web demo (NOR-F12-02): the workspace a first visit opens on. It is only built
// into the demo (`vite build --mode demo`); the normal build never reaches this file.

/** Where the banner sends a visitor to get the real app. */
export const DEMO_DOWNLOAD_URL = "https://github.com/marllon/noren/releases";

/** Ids the e2e tests of the demo read; the rest of the script is free to change. */
export const DEMO_IDS = {
  spaces: { code: "demo-code", docs: "demo-docs", lab: "demo-lab" },
  split: { itemId: "demo-servers", first: "demo-pane-api", second: "demo-pane-web" },
} as const;

interface PaneSeed {
  id: string;
  cwd: string;
}

function leaf(pane: PaneSeed) {
  return {
    kind: "pane",
    pane: {
      id: pane.id,
      type: "terminal",
      profileId: "default",
      cwd: pane.cwd,
      status: "idle",
      unread: false,
      bell: false,
    },
  };
}

function tab(id: string, title: string, pane: PaneSeed) {
  return {
    id,
    title,
    titleLocked: true,
    layout: leaf(pane),
    focusedPaneId: pane.id,
    lastActivityAt: 1,
  };
}

function splitTab(id: string, title: string, first: PaneSeed, second: PaneSeed) {
  return {
    id,
    title,
    titleLocked: true,
    layout: { kind: "split", dir: "row", sizes: [50, 50], children: [leaf(first), leaf(second)] },
    focusedPaneId: first.id,
    lastActivityAt: 1,
  };
}

const HOME = "/home/fake";

/** The fake repositories behind the branches the demo shows. */
const DEMO_REPOS = { [`${HOME}/projects/noren`]: "main", [`${HOME}/projects/site`]: "docs" };

/**
 * Three spaces, each with a theme of its own: "Code" (a pinned tab, a group of two tabs, a loose
 * tab and a tab split in two panes, the one that opens), "Docs" and "Lab".
 */
export function demoState(): string {
  const { code, docs, lab } = DEMO_IDS.spaces;
  const { itemId, first, second } = DEMO_IDS.split;
  const space = (
    id: string,
    name: string,
    icon: string,
    color: string,
    themeId: string,
    rest: Record<string, unknown>,
  ) => ({
    id,
    name,
    icon,
    color,
    themeId,
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    ...rest,
  });
  return JSON.stringify({
    version: 2,
    activeSpaceId: code,
    favorites: [],
    closed: [],
    archive: [],
    spaces: [
      space(code, "Code", "terminal", "#6b8afd", "noren-dusk", {
        pinned: ["demo-welcome"],
        tree: [
          {
            kind: "group",
            id: "demo-group-work",
            name: "Work",
            color: "teal",
            collapsed: false,
            children: [
              { kind: "item", id: "demo-api" },
              { kind: "item", id: "demo-build" },
            ],
          },
          { kind: "item", id: itemId },
          { kind: "item", id: "demo-scratch" },
        ],
        items: {
          "demo-welcome": tab("demo-welcome", "welcome", { id: "demo-pane-welcome", cwd: HOME }),
          "demo-api": tab("demo-api", "api", {
            id: "demo-pane-code-api",
            cwd: `${HOME}/projects/noren`,
          }),
          "demo-build": tab("demo-build", "build", {
            id: "demo-pane-build",
            cwd: "/srv/builds/noren",
          }),
          [itemId]: splitTab(
            itemId,
            "servers",
            { id: first, cwd: "/srv/api" },
            { id: second, cwd: "/srv/web" },
          ),
          "demo-scratch": tab("demo-scratch", "scratch", { id: "demo-pane-scratch", cwd: HOME }),
        },
        activeItemId: itemId,
      }),
      space(docs, "Docs", "book-open", "#4caf7d", "noren-paper", {
        pinned: [],
        tree: [
          {
            kind: "group",
            id: "demo-group-writing",
            name: "Writing",
            color: "violet",
            collapsed: false,
            children: [
              { kind: "item", id: "demo-guide" },
              { kind: "item", id: "demo-changelog" },
            ],
          },
          { kind: "item", id: "demo-site" },
        ],
        items: {
          "demo-guide": tab("demo-guide", "guide", {
            id: "demo-pane-guide",
            cwd: `${HOME}/projects/site`,
          }),
          "demo-changelog": tab("demo-changelog", "changelog", {
            id: "demo-pane-changelog",
            cwd: `${HOME}/projects/site`,
          }),
          "demo-site": tab("demo-site", "site", {
            id: "demo-pane-site",
            cwd: `${HOME}/projects/site`,
          }),
        },
        activeItemId: "demo-guide",
      }),
      space(lab, "Lab", "flask-conical", "#a77bdc", "noren-fjord", {
        pinned: ["demo-experiments"],
        tree: [{ kind: "item", id: "demo-notes" }],
        items: {
          "demo-experiments": tab("demo-experiments", "experiments", {
            id: "demo-pane-experiments",
            cwd: HOME,
          }),
          "demo-notes": tab("demo-notes", "notes", { id: "demo-pane-notes", cwd: HOME }),
        },
        activeItemId: "demo-experiments",
      }),
    ],
  });
}

/**
 * Seeds the script when nothing is saved yet: a visitor who comes back finds their own workspace,
 * not the script again. A blocked storage leaves the app on its own empty workspace.
 */
export function seedDemo(storage: StateStorage): void {
  try {
    if (storage.getItem(WEB_STATE_KEY) !== null) return;
    storage.setItem(WEB_STATE_KEY, demoState());
    if (storage.getItem(WEB_GIT_KEY) === null) {
      storage.setItem(WEB_GIT_KEY, JSON.stringify(DEMO_REPOS));
    }
  } catch {
    // Storage is blocked: the demo opens on the app's own workspace.
  }
}

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

function leaf(pane: PaneSeed) {
  return {
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

/** A split tab: two panes side by side, the first one focused. */
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

/** Ids of the split tab the fixture adds with `split: true`, and of its two panes. */
export const SPLIT_FIXTURE = { itemId: "i7", title: "servers", first: "p7", second: "p8" } as const;

/** Home folder of the in-memory backend, so folders under it show as `~`. */
export const FAKE_HOME = "/home/fake";

interface SidebarOptions {
  secondSpace?: boolean;
  split?: boolean;
  /** Default folder of the space "Main" (the folder its `.noren/actions.json` is read from). */
  cwd?: string;
}

/**
 * A saved workspace for the sidebar: one pinned tab, a group of three tabs and two loose ones, with
 * folders, a git branch, an unread tab and a tab with a bell. The tab "build" has no flags: the
 * tests make it fail by running `exit 2` in it. `secondSpace` adds the space "Other" with one tab
 * ("elsewhere"), for the tests that drop a tab on another space. `split` adds the tab "servers"
 * (`SPLIT_FIXTURE`) with two panes, one in `/srv/api` and one in `/srv/web`, after "deploy".
 */
export function sidebarState(options: SidebarOptions = {}): string {
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
        defaults: { env: {}, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) },
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
          ...(options.split ? [{ kind: "item", id: SPLIT_FIXTURE.itemId }] : []),
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
          ...(options.split
            ? {
                [SPLIT_FIXTURE.itemId]: splitTab(
                  SPLIT_FIXTURE.itemId,
                  SPLIT_FIXTURE.title,
                  { id: SPLIT_FIXTURE.first, cwd: "/srv/api" },
                  { id: SPLIT_FIXTURE.second, cwd: "/srv/web" },
                ),
              }
            : {}),
        },
        activeItemId: "i2",
      },
      ...(options.secondSpace ? [second] : []),
    ],
  });
}

// Key of the fake git repositories in the browser storage of web mode (web-backend.ts).
const WEB_GIT_KEY = "noren.web.git";

/**
 * The fake repositories behind the branches of `sidebarState`: the shell of a tab reports its
 * folder at the first prompt and the branch is read again for it, so a branch in the saved state
 * only stays when a repository is there.
 */
export const SIDEBAR_REPOS: Record<string, string> = {
  [`${FAKE_HOME}/projects/noren`]: "main",
  "C:\\Users\\ada\\dev\\site": "feature/long-branch-name",
};

/** Seeds the fake git repositories before the page loads; it only writes when none are set yet. */
export async function seedGitRepos(page: Page, repos: Record<string, string>): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    },
    { key: WEB_GIT_KEY, value: repos },
  );
}

/** Seeds the saved workspace before the page loads; it only writes when nothing is saved yet. */
export async function seedSidebarState(page: Page, options: SidebarOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ key, state }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, state);
    },
    { key: WEB_STATE_KEY, state: sidebarState(options) },
  );
  await seedGitRepos(page, SIDEBAR_REPOS);
}

// Key of the `.noren/actions.json` texts in the browser storage of web mode (web-backend.ts).
const WEB_ACTIONS_KEY = "noren.web.actions";

/** Default folder of the space "Main" in the actions tests. */
export const ACTIONS_CWD = "/srv/proj";

/** An action with a stop command, and one without (stopping it ends the tab's shell). */
export const ACTIONS_TEXT = JSON.stringify({
  actions: [
    { id: "loop", label: "Loop", command: "loop", stop: "loop parar", tab: "loop" },
    { id: "dev", label: "Dev server", command: "pnpm dev", tab: "dev" },
  ],
});

/** Seeds the text of `.noren/actions.json` of a folder before the page loads (only when none is saved). */
export async function seedActionsFile(page: Page, cwd: string, text: string): Promise<void> {
  await page.addInitScript(
    ({ key, folder, content }) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify({ [folder]: content }));
      }
    },
    { key: WEB_ACTIONS_KEY, folder: cwd, content: text },
  );
}

/** Replaces the text of `.noren/actions.json` of a folder while the page runs; the next poll sees it. */
export async function changeActionsFile(page: Page, cwd: string, text: string): Promise<void> {
  await page.evaluate(
    ({ key, folder, content }) => {
      window.localStorage.setItem(key, JSON.stringify({ [folder]: content }));
    },
    { key: WEB_ACTIONS_KEY, folder: cwd, content: text },
  );
}

/**
 * Waits until a click reaches the page again after a drag. The drag library swallows every click
 * for 50 ms after a drop (it removes its capturing listener on a timer), so a click sent right
 * after `mouse.up()` can vanish. The probe sends a click to the body each frame and resolves on the
 * first one that gets past the capturing listener, with no fixed wait.
 */
export function clicksReachThePage(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((done) => {
        let over = false;
        const reached = () => {
          over = true;
          document.removeEventListener("click", reached);
          done();
        };
        document.addEventListener("click", reached);
        const probe = () => {
          if (over) return;
          document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          requestAnimationFrame(probe);
        };
        probe();
      }),
  );
}

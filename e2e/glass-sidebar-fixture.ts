import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { NOREN_DUSK, NOREN_PAPER } from "../packages/model/src/builtin-themes";
import { seedConfig } from "./settings-fixture";
import { solidPng } from "./solid-png";
import {
  ACTIONS_CWD,
  ACTIONS_TEXT,
  SIDEBAR_REPOS,
  SPLIT_FIXTURE,
  seedActionsFile,
  seedGitRepos,
  seedSidebarState,
} from "./sidebar-fixture";

// What the specs of the glass sidebar (NOR-F20-18b) and of the glass pane (NOR-F20-18c) share: the page started with a style, a theme, a
// language, the favorites bar, an agent working or waiting in a pane, names too long for the sidebar and a
// second space. Not a spec itself, so the specs that import it do not register each other's tests.

interface Hook {
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
  setPaneAgent(paneId: string, agentId: string | undefined): Promise<boolean>;
}
type HookWindow = Window & { __norenTest?: Hook };

export type Mode = "dark" | "light";
export const THEME: Record<Mode, typeof NOREN_DUSK> = { dark: NOREN_DUSK, light: NOREN_PAPER };

/** A fake agent the fake backend plays: "thinking" is working, "shall i continue" is waiting. */
const AGENTS = `"agents": { "catalog": [ { "id": "helper", "executables": ["helper-cli"], "patterns": { "working": ["thinking"], "waiting": ["shall i continue"] } } ] }`;

/** The three kinds of tile of the bar: two favorite tabs (the ids of the fixture), a profile, two actions. */
const BAR_LINKS = [
  { kind: "profile", profileId: "pwsh", label: "PowerShell" },
  { kind: "action", spaceId: "s1", actionId: "dev", label: "Dev server" },
  { kind: "action", spaceId: "s1", actionId: "loop", label: "Loop" },
];

const PROFILES = [
  { id: "pwsh", name: "PowerShell", default: true },
  { id: "git-bash", name: "Git Bash", default: false },
];

export interface StartOptions {
  lang?: "en" | "pt-BR";
  mode?: Mode;
  style?: "glass" | "dense";
  /** The rest of `appearance`, as JSON text: `"density": "compact"`, `"sidebar": { "width": 264 }`. */
  appearance?: string;
  /** Favorites bar: the tabs `i6` and `i5` and the three links. */
  bar?: boolean;
  /** Seeds the actions file of the space (the folder `ACTIONS_CWD`). */
  actions?: string | false;
  /** A second space, "Other" (amber), in the saved workspace. */
  secondSpace?: boolean;
  /** Names far too long for the sidebar: a tab, its folder and branch, a group, the space. */
  longNames?: boolean;
  /** Writes a pane as played by the agent after the page is up: `[pane, text]`. */
  agents?: readonly (readonly [string, string])[];
  /** Fake git repositories (folder to branch) the shells find; the ones of the fixture stay unless a folder is named here. */
  repos?: Record<string, string>;
  /** A picture behind the window, the settings name it `pic.png`: its color as `#rrggbb` (white and black are the worst of it). */
  picture?: string;
  /** Names far too long for a pane header: the folder and the branch of the first pane of the split tab. */
  longPane?: boolean;
}

interface SavedState {
  favorites?: string[];
  favoriteLinks?: object[];
  spaces: {
    name: string;
    items: Record<
      string,
      {
        title: string;
        layout: { pane: { cwd?: string; gitBranch?: string } };
      }
    >;
    tree: { name?: string }[];
  }[];
}

export const LONG = {
  title: "A tab with a title far too long for the sidebar to ever show",
  cwd: "/home/fake/projects/an-extremely-long-folder-name/with/many/parts",
  branch: "feature/a-branch-name-that-is-also-much-too-long",
  group: "A group named with a very long sentence indeed",
  space: "A space with a name that does not fit in the sidebar",
};

export async function start(page: Page, options: StartOptions = {}): Promise<void> {
  const { lang = "en", mode = "dark", style = "glass" } = options;
  const appearance = [
    `"theme": "${THEME[mode].id}"`,
    `"style": "${style}"`,
    ...(options.picture !== undefined ? ['"background": { "image": "pic.png" }'] : []),
    ...(options.appearance !== undefined && options.appearance !== "" ? [options.appearance] : []),
  ].join(", ");
  await seedConfig(
    page,
    `{ ${AGENTS}, ${lang === "pt-BR" ? '"language": "pt-BR", ' : ""}"appearance": { ${appearance} } }`,
  );
  await page.addInitScript(
    (profiles) => window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles)),
    PROFILES,
  );
  if (options.picture !== undefined) {
    const images = { "pic.png": solidPng(options.picture).toString("base64") };
    await page.addInitScript(
      (value) => window.localStorage.setItem("noren.web.images", JSON.stringify(value)),
      images,
    );
  }
  // The repositories of the page first: `seedSidebarState` leaves the ones it finds.
  if (options.repos !== undefined || options.longPane === true) {
    await seedGitRepos(page, {
      ...SIDEBAR_REPOS,
      ...(options.longPane === true ? { [LONG.cwd]: LONG.branch } : {}),
      ...options.repos,
    });
  }
  await seedSidebarState(page, {
    cwd: ACTIONS_CWD,
    split: true,
    ...(options.secondSpace === true ? { secondSpace: true } : {}),
  });
  if (options.longPane === true) {
    await page.addInitScript(
      ({ long, itemId, paneIndex }) => {
        const key = "noren.web.state";
        const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
          spaces: {
            items: Record<string, { layout: { children?: { pane: { cwd?: string } }[] } }>;
          }[];
        };
        const pane = state.spaces[0]?.items[itemId]?.layout.children?.[paneIndex]?.pane;
        if (pane !== undefined) pane.cwd = long;
        window.localStorage.setItem(key, JSON.stringify(state));
      },
      { long: LONG.cwd, itemId: SPLIT_FIXTURE.itemId, paneIndex: 0 },
    );
  }
  if (options.actions !== false) {
    await seedActionsFile(page, ACTIONS_CWD, options.actions ?? ACTIONS_TEXT);
  }
  if (options.bar === true) {
    await page.addInitScript((links) => {
      const key = "noren.web.state";
      const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as SavedState;
      state.favorites = ["i6", "i5"];
      state.favoriteLinks = links;
      window.localStorage.setItem(key, JSON.stringify(state));
    }, BAR_LINKS);
  }
  if (options.longNames === true) {
    await page.addInitScript((long) => {
      const key = "noren.web.state";
      const state = JSON.parse(window.localStorage.getItem(key) ?? "{}") as SavedState;
      const space = state.spaces[0];
      if (space === undefined) return;
      space.name = long.space;
      const item = space.items["i2"];
      if (item !== undefined) {
        item.title = long.title;
        item.layout.pane.cwd = long.cwd;
        item.layout.pane.gitBranch = long.branch;
      }
      const group = space.tree[0];
      if (group !== undefined) group.name = long.group;
      window.localStorage.setItem(key, JSON.stringify(state));
    }, LONG);
  }
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
  if (options.agents !== undefined) {
    for (const [pane, text] of options.agents) {
      await page.evaluate(
        async ({ id, output }) => {
          const hook = (window as HookWindow).__norenTest;
          await hook?.setPaneAgent(id, "helper");
          hook?.sendOutput(id, `${output}\r\n`);
        },
        { id: pane, output: text },
      );
    }
  }
}

/** api and scratch work, deploy waits for the person (the panes of the fixture: p2, p6, p5). */
export const AGENT_STATES = [
  ["p2", "thinking"],
  ["p5", "shall i continue"],
  ["p6", "thinking"],
] as const;

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// After the machine restarts (NOR-F14-03): the layout comes back with a new shell in the folder of
// each pane, and, only when the user turned `agents.resumeOnRestore` on, the pane that had an agent
// of the catalog running gets the resume command of that agent typed in its new shell, once, at the
// first prompt. The restart is played by a saved `state.json` with a pane whose shell reported a
// running command, on a fake backend that holds no old shell to hand back (a new daemon).

interface Hook {
  lines(): string[];
  writes(): { id: number; data: string }[];
  sessionStarts(): { profileId?: string; cwd?: string; env?: Record<string, string> }[];
  paneIds(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_STATE_KEY = "noren.web.state";
const WEB_CONFIG_KEY = "noren.web.config";

const FOLDER = "/srv/agent-work";
const RESUME = "claude --continue";

/** One tab with two panes: one that had `claude` running when the state was saved, one that had `sleep`. */
function savedState(): string {
  const pane = (id: string, cwd: string, command: string) => ({
    kind: "pane",
    pane: {
      id,
      type: "terminal",
      profileId: "default",
      cwd,
      status: "running",
      runningCommand: { text: command },
      unread: false,
      bell: false,
    },
  });
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
        pinned: [],
        tree: [{ kind: "item", id: "i1" }],
        items: {
          i1: {
            id: "i1",
            title: "work",
            titleLocked: true,
            layout: {
              kind: "split",
              dir: "row",
              sizes: [50, 50],
              children: [
                pane("agentpane", FOLDER, "claude --model x"),
                pane("plainpane", "/srv/other", "sleep 300"),
              ],
            },
            focusedPaneId: "agentpane",
            lastActivityAt: 1,
          },
        },
        activeItemId: "i1",
      },
    ],
  });
}

/** Seeds the saved workspace and the settings before the page loads (only once per test). */
async function seed(page: Page, config: string | undefined): Promise<void> {
  await page.addInitScript(
    ({ stateKey, state, configKey, text }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
      if (text !== undefined) window.localStorage.setItem(configKey, text);
    },
    { stateKey: WEB_STATE_KEY, state: savedState(), configKey: WEB_CONFIG_KEY, text: config },
  );
}

const writes = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.writes() ?? []);

const sessionStarts = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);

const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);

/** Waits until both panes are on screen with a shell that showed its prompt. */
async function waitForShells(page: Page): Promise<void> {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(2);
  await expect.poll(async () => (await sessionStarts(page)).length).toBe(2);
  await expect
    .poll(async () => (await lines(page)).some((line) => line.startsWith("fake$")))
    .toBe(true);
}

const typed = async (page: Page): Promise<string[]> =>
  (await writes(page)).map((write) => write.data);

test("with the option on, the new shell of the agent's pane gets the resume command once, at the prompt, in the saved folder", async ({
  page,
}) => {
  await seed(page, `{ "agents": { "resumeOnRestore": true } }\n`);
  await waitForShells(page);

  // The layout is back, with a new shell per pane in the folder that was saved.
  const starts = await sessionStarts(page);
  expect(starts.map((start) => start.cwd).sort()).toEqual(["/srv/agent-work", "/srv/other"]);

  // The command is typed once, with an Enter, into the shell of the pane that had the agent: the
  // fake shell runs it, so it shows up on screen after the prompt it waited for.
  await expect
    .poll(async () => (await typed(page)).filter((d) => d === `${RESUME}\r`).length)
    .toBe(1);
  await expect
    .poll(async () => (await lines(page)).some((line) => line.includes(RESUME)))
    .toBe(true);
  // Only that one: the `sleep` pane is not an agent, and nothing else was typed.
  expect(await typed(page)).toEqual([`${RESUME}\r`]);

  // Later prompts (the person runs something) never bring it back.
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type("echo later");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await lines(page)).filter((line) => line === "later").length)
    .toBe(1);
  expect((await typed(page)).filter((d) => d === `${RESUME}\r`)).toHaveLength(1);
});

test("with the option off (the default), nothing is typed in any pane", async ({ page }) => {
  await seed(page, undefined);
  await waitForShells(page);
  expect((await sessionStarts(page)).map((start) => start.cwd).sort()).toEqual([
    "/srv/agent-work",
    "/srv/other",
  ]);
  // Give a mistaken resume the time it would need, then look.
  await page.waitForTimeout(1500);
  expect(await typed(page)).toEqual([]);
});

test("with the option on but the agents off, nothing is typed", async ({ page }) => {
  await seed(page, `{ "agents": { "enabled": false, "resumeOnRestore": true } }\n`);
  await waitForShells(page);
  await page.waitForTimeout(1500);
  expect(await typed(page)).toEqual([]);
});

test("an agent whose catalog entry has no resume command is left alone", async ({ page }) => {
  await seed(
    page,
    `{ "agents": { "resumeOnRestore": true, "catalog": [{ "id": "claude", "executables": ["claude"] }] } }\n`,
  );
  await waitForShells(page);
  await page.waitForTimeout(1500);
  expect(await typed(page)).toEqual([]);
});

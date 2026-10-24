import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// Agent detection on a tab. The shell of a pane reports the command it runs (OSC 633;E), and the
// tab shows a generic agent icon, named by the executable, when that command is in the catalog of
// the settings. The other source is the process tree of the session: here the fake backend plays
// it (`setPaneAgent` puts an agent under the shell of a pane and the page looks at the tree).
// The fake shell has `sleep N` on the clock the test moves, so a command stays running as long as
// the test wants, and the catalog of the file can name `sleep` as an agent.

interface Hook {
  advanceClock(ms: number): void;
  paneIds(): string[];
  setPaneAgent(paneId: string, agentId: string | undefined): Promise<boolean>;
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const CATALOG = `{
  "agents": {
    "catalog": [
      { "id": "napper", "executables": ["sleep"] },
      { "id": "helper", "executables": ["helper-cli"] },
    ],
  },
}
`;

const tabs = (page: Page): Locator =>
  page.getByRole("tree", { name: "Tabs", exact: true }).locator('[data-nr-part="item"]');
const agentIcon = (page: Page): Locator => tabs(page).locator('[data-nr-indicator="agent"]');

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

const firstPane = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const id = (window as HookWindow).__norenTest?.paneIds()[0];
    if (id === undefined) throw new Error("no pane");
    return id;
  });

const setAgent = (page: Page, paneId: string, agentId: string | undefined): Promise<boolean> =>
  page.evaluate(
    ({ pane, agent }) => (window as HookWindow).__norenTest?.setPaneAgent(pane, agent) ?? false,
    { pane: paneId, agent: agentId },
  );

async function start(page: Page, file?: string): Promise<void> {
  if (file !== undefined) await seedConfig(page, file);
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

test("a tab has no agent icon when no agent runs", async ({ page }) => {
  await start(page);
  await expect(agentIcon(page)).toHaveCount(0);
});

test("the command the shell reports puts the icon on the tab while it runs", async ({ page }) => {
  await start(page, CATALOG);
  await run(page, "sleep 3");
  await expect(agentIcon(page)).toHaveCount(1);
  // The icon is generic and the only text is the name of the agent: the executable.
  await expect(agentIcon(page)).toHaveAttribute("title", "Agent napper");
  await expect(agentIcon(page).locator("svg")).toHaveCount(1);
  await expect(agentIcon(page)).toHaveText("");

  await page.evaluate(() => (window as HookWindow).__norenTest?.advanceClock(3000));
  await expect(agentIcon(page)).toHaveCount(0);
});

test("a command that is not in the catalog shows no icon", async ({ page }) => {
  await start(page, CATALOG);
  await run(page, "echo napper");
  await expect(tabs(page).locator('[data-nr-part="item-command"]')).toHaveAttribute(
    "data-nr-state",
    "done",
  );
  await expect(agentIcon(page)).toHaveCount(0);
});

test("an agent under the shell in the process tree puts the icon on the tab with no command", async ({
  page,
}) => {
  await start(page, CATALOG);
  const pane = await firstPane(page);
  expect(await setAgent(page, pane, "helper")).toBe(true);
  await expect(agentIcon(page)).toHaveCount(1);
  await expect(agentIcon(page)).toHaveAttribute("title", "Agent helper");

  expect(await setAgent(page, pane, undefined)).toBe(true);
  await expect(agentIcon(page)).toHaveCount(0);
});

test("the command wins over the process tree when both know", async ({ page }) => {
  await start(page, CATALOG);
  const pane = await firstPane(page);
  await setAgent(page, pane, "helper");
  await expect(agentIcon(page)).toHaveAttribute("title", "Agent helper");
  await run(page, "sleep 3");
  await expect(agentIcon(page)).toHaveAttribute("title", "Agent napper");
  await page.evaluate(() => (window as HookWindow).__norenTest?.advanceClock(3000));
  // The command ended: the tree is what is left.
  await expect(agentIcon(page)).toHaveAttribute("title", "Agent helper");
});

test("agents.enabled off hides the icon, whatever the command or the tree says", async ({
  page,
}) => {
  await start(
    page,
    `{ "agents": { "enabled": false, "catalog": [{ "id": "napper", "executables": ["sleep"] }] } }\n`,
  );
  await run(page, "sleep 3");
  await expect(tabs(page).locator('[data-nr-part="item-command"]')).toHaveAttribute(
    "data-nr-state",
    "running",
  );
  await expect(agentIcon(page)).toHaveCount(0);
  await setAgent(page, await firstPane(page), "napper");
  await expect(agentIcon(page)).toHaveCount(0);
});

test("the built-in catalog names the common agents by their executable", async ({ page }) => {
  await start(page);
  await setAgent(page, await firstPane(page), "claude");
  await expect(agentIcon(page)).toHaveAttribute("title", "Agent claude");
});

test("the icon is in the description of the tab for assistive technology, in Portuguese too", async ({
  page,
}) => {
  await start(page, CATALOG);
  await setAgent(page, await firstPane(page), "helper");
  await expect(agentIcon(page)).toHaveCount(1);
  const described = await tabs(page).getAttribute("aria-describedby");
  expect(described).not.toBeNull();
  await expect(page.locator(`#${described}`)).toContainText("Agent helper");

  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig(
      `{ "language": "pt-BR", "agents": { "catalog": [{ "id": "helper", "executables": ["helper-cli"] }] } }\n`,
    ),
  );
  // The tree is named in the language of the page, so look for the icon without it.
  await expect(page.locator('[data-nr-part="item"] [data-nr-indicator="agent"]')).toHaveAttribute(
    "title",
    "Agente helper",
  );
});

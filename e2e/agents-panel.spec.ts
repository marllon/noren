import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// The Agents panel (Ctrl+Alt+Shift+G) and its shortcut to the agent that waits for you
// (Ctrl+Alt+Shift+W). Three agents run in three spaces, one in each state; the fake backend plays
// them: `setPaneAgent` puts a program under the shell of a pane, `sendOutput` makes it print and
// `advanceClock` moves the clock the time in each state is measured on.

interface Hook {
  advanceClock(ms: number): void;
  focusedPaneId(): string | undefined;
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
  setPaneAgent(paneId: string, agentId: string | undefined): Promise<boolean>;
}
type HookWindow = Window & { __norenTest?: Hook };

const PATTERNS = `"patterns": { "working": ["thinking"], "waiting": ["shall i continue"], "idle": ["^ready> $"] }`;
const CATALOG = `{
  "agents": {
    "silenceSeconds": 5,
    "catalog": [
      { "id": "alpha", "executables": ["alpha-cli"], ${PATTERNS} },
      { "id": "beta", "executables": ["beta-cli"], ${PATTERNS} },
      { "id": "gamma", "executables": ["gamma-cli"], ${PATTERNS} },
    ],
  },
}
`;

const panel = (page: Page): Locator => page.locator('[data-nr-part="agents"]');
const rows = (page: Page): Locator => panel(page).locator('[data-nr-part="agents-row"]');
/** The state of each row, top to bottom. */
const states = (page: Page): Promise<(string | null)[]> =>
  rows(page).evaluateAll((all) => all.map((row) => row.getAttribute("data-nr-agent-state")));
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const terminalFocused = (page: Page): Locator =>
  page.locator("textarea.xterm-helper-textarea:focus");

const firstPane = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const id = (window as HookWindow).__norenTest?.paneIds()[0];
    if (id === undefined) throw new Error("no pane");
    return id;
  });
const focusedPane = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());
const print = (page: Page, paneId: string, text: string): Promise<boolean> =>
  page.evaluate(
    ({ pane, output }) => (window as HookWindow).__norenTest?.sendOutput(pane, output) ?? false,
    { pane: paneId, output: text },
  );
const advance = (page: Page, ms: number): Promise<void> =>
  page.evaluate((step) => (window as HookWindow).__norenTest?.advanceClock(step), ms);

/** Puts an agent under the shell of a pane once its session exists. */
async function setAgent(page: Page, paneId: string, agentId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ pane, agent }) => (window as HookWindow).__norenTest?.setPaneAgent(pane, agent),
        { pane: paneId, agent: agentId },
      ),
    )
    .toBe(true);
}

async function start(page: Page, file: string = CATALOG): Promise<string> {
  await seedConfig(page, file);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
  return firstPane(page);
}

/** A new space with this name, on screen, with the id of its first pane. */
async function newSpace(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, name)).toHaveAttribute("data-nr-state", "active");
  return firstPane(page);
}

interface Panes {
  alpha: string;
  beta: string;
  gamma: string;
}

/**
 * alpha in "Main" waits for you since the 5th second, beta in "Two" works since the 65th, gamma in
 * "Three" has been idle since the 5th. The clock ends on the 67th second, so alpha and gamma have
 * been in their state for 62 seconds and beta for 2.
 */
async function threeAgents(page: Page): Promise<Panes> {
  const alpha = await start(page);
  const beta = await newSpace(page, "Two");
  const gamma = await newSpace(page, "Three");
  await setAgent(page, alpha, "alpha");
  await setAgent(page, beta, "beta");
  await setAgent(page, gamma, "gamma");

  await print(page, gamma, `thinking: indexing ${"x".repeat(200)}\r\n`);
  await advance(page, 5000);
  await print(page, alpha, "\u001b[1mShall I continue?\u001b[0m [y/N] ");
  await advance(page, 60_000);
  await print(page, beta, "\u001b[33m✻\u001b[39m Thinking… (2s)\r\n");
  await advance(page, 2000);
  return { alpha, beta, gamma };
}

test("the panel lists the agents of three spaces: waiting, working, then idle, with time and last line", async ({
  page,
}) => {
  await threeAgents(page);
  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('[data-nr-part="agents-count"]')).toHaveText("3");

  await expect(rows(page)).toHaveCount(3);
  await expect.poll(() => states(page)).toEqual(["waiting", "working", "idle"]);
  const text = (row: number, part: string): Locator =>
    rows(page).nth(row).locator(`[data-nr-part="agents-${part}"]`);

  await expect(text(0, "name")).toHaveText("alpha");
  await expect(text(0, "state")).toHaveText("waiting for you");
  await expect(text(0, "elapsed")).toHaveText("1m 02s");
  await expect(text(0, "where")).toHaveText("Tab 1 in Main");
  await expect(text(0, "line")).toHaveText("Shall I continue? [y/N]");

  await expect(text(1, "name")).toHaveText("beta");
  await expect(text(1, "state")).toHaveText("working");
  await expect(text(1, "elapsed")).toHaveText("2s");
  await expect(text(1, "where")).toHaveText("Tab 1 in Two");
  await expect(text(1, "line")).toHaveText("✻ Thinking… (2s)");

  await expect(text(2, "name")).toHaveText("gamma");
  await expect(text(2, "state")).toHaveText("idle");
  await expect(text(2, "elapsed")).toHaveText("1m 02s");
  await expect(text(2, "where")).toHaveText("Tab 1 in Three");
  // A long last line is cut at 120 characters, the last one being the ellipsis.
  const longLine = (await text(2, "line").textContent()) ?? "";
  expect(Array.from(longLine)).toHaveLength(120);
  expect(longLine.startsWith("thinking: indexing xxx")).toBe(true);
  expect(longLine.endsWith("x…")).toBe(true);

  // No product name and no logo: the agent is named by its executable.
  await expect(panel(page).locator("img, svg")).toHaveCount(0);

  // The words for assistive technology are on each row's button.
  await expect(
    panel(page).getByRole("button", {
      name: "Agent beta is working, for 2s, Tab 1 in Two. Last line: ✻ Thinking… (2s). Go to it.",
      exact: true,
    }),
  ).toBeVisible();
});

test("the panel counts the time and follows the last line while it is open", async ({ page }) => {
  const { beta } = await threeAgents(page);
  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(rows(page)).toHaveCount(3);
  await advance(page, 2000);
  await print(page, beta, "reading the next file\r\n");
  const betaRow = rows(page).filter({ hasText: "beta" });
  await expect(betaRow.locator('[data-nr-part="agents-elapsed"]')).toHaveText("4s");
  await expect(betaRow.locator('[data-nr-part="agents-line"]')).toHaveText("reading the next file");
  await expect(rows(page).first().locator('[data-nr-part="agents-elapsed"]')).toHaveText("1m 04s");
});

test("a click on a row goes to its space, tab and pane, and the keyboard is in that terminal", async ({
  page,
}) => {
  const { alpha, beta } = await threeAgents(page);
  expect(await focusedPane(page)).not.toBe(beta);
  await page.keyboard.press("Control+Shift+Alt+G");
  await rows(page).filter({ hasText: "beta" }).getByRole("button").click();
  await expect(panel(page)).toBeHidden();
  await expect(spaceButton(page, "Two")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => focusedPane(page)).toBe(beta);
  await expect(terminalFocused(page)).toHaveCount(1);

  // From there, a row of another space goes back.
  await page.keyboard.press("Control+Shift+Alt+G");
  await rows(page).filter({ hasText: "alpha" }).getByRole("button").click();
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => focusedPane(page)).toBe(alpha);
});

test("Escape closes the panel, and the arrows and Enter drive it from the keyboard", async ({
  page,
}) => {
  const { gamma } = await threeAgents(page);
  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(rows(page).first().getByRole("button")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1).getByRole("button")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(2).getByRole("button")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await expect(spaceButton(page, "Three")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => focusedPane(page)).toBe(gamma);

  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(terminalFocused(page)).toHaveCount(1);
});

test("the shortcut goes to the agent that waits for you, from any space", async ({ page }) => {
  const { alpha } = await threeAgents(page);
  // "Three" is on screen; alpha waits in "Main".
  await expect(spaceButton(page, "Three")).toHaveAttribute("data-nr-state", "active");
  await page.keyboard.press("Control+Shift+Alt+W");
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => focusedPane(page)).toBe(alpha);
  await expect(terminalFocused(page)).toHaveCount(1);
  await expect(panel(page)).toBeHidden();
});

test("with two waiting, the shortcut picks the one that has waited longest", async ({ page }) => {
  const { alpha, beta } = await threeAgents(page);
  // beta asks too, 62 seconds after alpha did.
  await print(page, beta, "Shall I continue? ");
  await expect(spaceButton(page, "Three")).toHaveAttribute("data-nr-state", "active");
  await page.keyboard.press("Control+Shift+Alt+G");
  await expect.poll(() => states(page)).toEqual(["waiting", "waiting", "idle"]);
  await expect(rows(page).first().locator('[data-nr-part="agents-name"]')).toHaveText("alpha");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+Alt+W");
  await expect.poll(() => focusedPane(page)).toBe(alpha);
  expect(alpha).not.toBe(beta);
});

test("the palette lists both commands with their shortcuts and runs them", async ({ page }) => {
  const { beta, alpha } = await threeAgents(page);
  const palette = page.locator('[data-nr-part="palette"]');
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">agent");
  const options = palette.getByRole("option");
  await expect(options.filter({ hasText: "Open agents panel" })).toContainText("Ctrl+Alt+Shift+G");
  await expect(options.filter({ hasText: "Go to the agent waiting for you" })).toContainText(
    "Ctrl+Alt+Shift+W",
  );
  await options.filter({ hasText: "Open agents panel" }).click();
  await expect(palette).toBeHidden();
  await expect(panel(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press("Escape");

  await spaceButton(page, "Two").click();
  await expect.poll(() => focusedPane(page)).toBe(beta);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">waiting for you");
  await expect(options).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => focusedPane(page)).toBe(alpha);
});

test("with nobody waiting, the shortcut moves nothing and says so; with no agent, the panel says so", async ({
  page,
}) => {
  const pane = await start(page);
  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(panel(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(panel(page).locator('[data-nr-part="agents-empty"]')).toHaveText(
    "No agent is running in any tab.",
  );
  await page.keyboard.press("Escape");

  await setAgent(page, pane, "alpha");
  await print(page, pane, "thinking about it\r\n");
  await page.keyboard.press("Control+Shift+Alt+W");
  await expect(notice(page)).toHaveText("No agent is waiting for you.");
  await expect(panel(page)).toBeHidden();
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  expect(await focusedPane(page)).toBe(pane);
});

test("the panel and the commands are in Portuguese when the language is", async ({ page }) => {
  const pane = await start(page, CATALOG.replace("{\n", '{\n  "language": "pt-BR",\n'));
  await setAgent(page, pane, "alpha");
  await print(page, pane, "Shall I continue? ");
  await advance(page, 65_000);
  await page.keyboard.press("Control+Shift+Alt+G");
  const dialog = page.getByRole("dialog", { name: "Agentes", exact: true });
  await expect(dialog).toBeVisible();
  const row = dialog.locator('[data-nr-part="agents-row"]');
  await expect(row.locator('[data-nr-part="agents-state"]')).toHaveText("esperando você");
  await expect(row.locator('[data-nr-part="agents-elapsed"]')).toHaveText("1m 05s");
  await expect(
    dialog.getByRole("button", {
      name: "Agente alpha está esperando você, há 1m 05s, Aba 1 em Main. Última linha: Shall I continue?. Ir até ele.",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">agente");
  const options = page.locator('[data-nr-part="palette"]').getByRole("option");
  await expect(options.filter({ hasText: "Abrir o painel de agentes" })).toBeVisible();
  await expect(options.filter({ hasText: "Ir ao agente que está esperando você" })).toBeVisible();
});

test("with agents turned off, nothing is listed", async ({ page }) => {
  const pane = await start(
    page,
    CATALOG.replace('"silenceSeconds": 5,', '"enabled": false,\n    "silenceSeconds": 5,'),
  );
  await setAgent(page, pane, "alpha");
  await print(page, pane, "Shall I continue? ");
  await page.keyboard.press("Control+Shift+Alt+G");
  await expect(rows(page)).toHaveCount(0);
  await expect(panel(page).locator('[data-nr-part="agents-empty"]')).toBeVisible();
});

import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";

// The state of an agent on its tab and its pane: working, waiting for you or idle. The fake backend
// plays the agent: `setPaneAgent` puts one under the shell of a pane, `sendOutput` makes it print
// (a status line, a question, an OSC 9 notification) and `advanceClock` moves the clock the silence
// is measured on. The tab shows a dot with the state, the pane a ring in its color, and both say it
// in words for assistive technology.

interface Hook {
  advanceClock(ms: number): void;
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
  setPaneAgent(paneId: string, agentId: string | undefined): Promise<boolean>;
  setConfig(text: string | null): void;
  split(dir: "row" | "column", paneId?: string): string | undefined;
}
type HookWindow = Window & { __norenTest?: Hook };

const CATALOG = `{
  "agents": {
    "silenceSeconds": 5,
    "catalog": [
      {
        "id": "helper",
        "executables": ["helper-cli"],
        "patterns": { "working": ["thinking"], "waiting": ["shall i continue"], "idle": ["^ready> $"] },
      },
      { "id": "quiet", "executables": ["quiet-cli"], "silenceSeconds": 20 },
    ],
  },
}
`;

// The tree is named in the language of the page, so it is found by its role alone.
const tabs = (page: Page): Locator => page.locator('[role="tree"] [data-nr-part="item"]');
const dot = (page: Page): Locator => tabs(page).locator('[data-nr-indicator="agent-state"]');
const frame = (page: Page, paneId: string): Locator =>
  page.locator(`[data-nr-part="pane"][data-pane-id="${paneId}"]`);

async function start(page: Page, file: string = CATALOG): Promise<string> {
  await seedConfig(page, file);
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
  return firstPane(page);
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

const print = (page: Page, paneId: string, text: string): Promise<boolean> =>
  page.evaluate(
    ({ pane, output }) => (window as HookWindow).__norenTest?.sendOutput(pane, output) ?? false,
    { pane: paneId, output: text },
  );

const advance = (page: Page, ms: number): Promise<void> =>
  page.evaluate((step) => (window as HookWindow).__norenTest?.advanceClock(step), ms);

async function expectState(page: Page, paneId: string, state: string): Promise<void> {
  await expect(dot(page)).toHaveAttribute("data-nr-agent-state", state);
  await expect(frame(page, paneId)).toHaveAttribute("data-nr-agent-state", state);
}

test("a tab and a pane without an agent show no state", async ({ page }) => {
  const pane = await start(page);
  await print(page, pane, "thinking about it\r\n");
  await expect(dot(page)).toHaveCount(0);
  await expect(frame(page, pane)).not.toHaveAttribute("data-nr-agent-state", /.+/);
  await expect(page.locator('[data-nr-part="pane-agent-ring"]')).toHaveCount(0);
});

test("an agent that has printed nothing is idle", async ({ page }) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await expectState(page, pane, "idle");
});

test("output makes the agent work, and silence makes it idle again", async ({ page }) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await print(page, pane, "\u001b[33m✻\u001b[39m Thinking… (3s)\r\n");
  await expectState(page, pane, "working");

  await advance(page, 4999);
  await expectState(page, pane, "working");
  await advance(page, 1);
  await expectState(page, pane, "idle");
});

test("the silence of an agent entry replaces the one of the settings", async ({ page }) => {
  const pane = await start(page);
  await setAgent(page, pane, "quiet");
  await print(page, pane, "some output\r\n");
  await expectState(page, pane, "working");
  await advance(page, 19_999);
  await expectState(page, pane, "working");
  await advance(page, 1);
  await expectState(page, pane, "idle");
});

test("a question of the agent makes the tab wait for you, and typing the answer resumes", async ({
  page,
}) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await print(page, pane, "Thinking…\r\n");
  await expectState(page, pane, "working");
  await print(page, pane, "Shall I continue with the migration? (yes/no) ");
  await expectState(page, pane, "waiting");

  // Waiting never decays with the silence.
  await advance(page, 60_000);
  await expectState(page, pane, "waiting");

  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await advance(page, 500);
  await page.keyboard.type("y");
  await expectState(page, pane, "working");
});

test("a question that matches no pattern of the entry is still found when the entry has none", async ({
  page,
}) => {
  const pane = await start(page);
  await setAgent(page, pane, "quiet");
  await print(page, pane, "Overwrite the file? [y/N] ");
  await expectState(page, pane, "waiting");
});

test("an OSC 9 or OSC 777 notification makes the agent wait for you", async ({ page }) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await print(page, pane, "Thinking…\r\n");
  await expectState(page, pane, "working");
  await print(page, pane, "\u001b]9;I need your input\u0007");
  await expectState(page, pane, "waiting");

  await print(page, pane, "ready> ");
  await expectState(page, pane, "idle");
  await print(page, pane, "\u001b]777;notify;Agent;Done\u0007");
  await expectState(page, pane, "waiting");
});

test("the prompt back (an idle pattern) ends the work at once", async ({ page }) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await print(page, pane, "Thinking…\r\n");
  await expectState(page, pane, "working");
  await print(page, pane, "all done\r\nready> ");
  await expectState(page, pane, "idle");
});

test("the state is in words, in the description of the tab and next to the pane", async ({
  page,
}) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await print(page, pane, "Thinking…\r\n");
  await expectState(page, pane, "working");

  await expect(dot(page)).toHaveAttribute("title", "Agent helper is working");
  const described = await tabs(page).getAttribute("aria-describedby");
  expect(described).not.toBeNull();
  await expect(page.locator(`#${described}`)).toContainText("Agent helper is working");
  await expect(frame(page, pane).locator('[data-nr-part="pane-agent-state"]')).toHaveText(
    "Agent helper is working",
  );

  await print(page, pane, "shall i continue? ");
  await expect(dot(page)).toHaveAttribute("title", "Agent helper is waiting for you");
  await expect(page.locator(`#${described}`)).toContainText("Agent helper is waiting for you");
  await expect(frame(page, pane).locator('[data-nr-part="pane-agent-state"]')).toHaveText(
    "Agent helper is waiting for you",
  );

  await advance(page, 1);
  await print(page, pane, "ready> ");
  await expect(dot(page)).toHaveAttribute("title", "Agent helper is idle");
});

test("the words are in Portuguese when the language is", async ({ page }) => {
  const pane = await start(page, CATALOG.replace("{\n", '{\n  "language": "pt-BR",\n'));
  await setAgent(page, pane, "helper");
  await print(page, pane, "shall i continue? ");
  await expect(dot(page)).toHaveAttribute("title", "O agente helper está esperando você");
  await expect(frame(page, pane).locator('[data-nr-part="pane-agent-state"]')).toHaveText(
    "O agente helper está esperando você",
  );
  await print(page, pane, "ready> ");
  await expect(dot(page)).toHaveAttribute("title", "O agente helper está ocioso");
});

test("in a split, only the pane that has the agent gets the ring", async ({ page }) => {
  const first = await start(page);
  const second = await page.evaluate(() => (window as HookWindow).__norenTest?.split("row"));
  expect(second).toBeDefined();
  await expect(page.locator('[data-nr-part="pane"]')).toHaveCount(2);
  await setAgent(page, first, "helper");
  await print(page, first, "Thinking…\r\n");
  await expect(frame(page, first)).toHaveAttribute("data-nr-agent-state", "working");
  await expect(frame(page, second ?? "")).not.toHaveAttribute("data-nr-agent-state", /.+/);
  await expect(page.locator('[data-nr-part="pane-agent-ring"]')).toHaveCount(1);
});

test("the ring and the dot go with the agent, and with agents.enabled off nothing shows", async ({
  page,
}) => {
  const pane = await start(page);
  await setAgent(page, pane, "helper");
  await print(page, pane, "Thinking…\r\n");
  await expectState(page, pane, "working");

  await setAgent(page, pane, undefined);
  await expect(dot(page)).toHaveCount(0);
  await expect(page.locator('[data-nr-part="pane-agent-ring"]')).toHaveCount(0);

  await setAgent(page, pane, "helper");
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig(
      `{ "agents": { "enabled": false, "catalog": [{ "id": "helper", "executables": ["helper-cli"] }] } }\n`,
    ),
  );
  await expect(dot(page)).toHaveCount(0);
  await expect(page.locator('[data-nr-part="pane-agent-ring"]')).toHaveCount(0);
});

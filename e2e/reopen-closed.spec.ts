import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// A tab that closes goes to the stack of closed tabs with the place it had (space, group and
// position) and its scrollback; reopening it (Ctrl+Shift+Alt+T, or the palette) puts it back there,
// with a new shell in the same folder under the old output, dimmed, and the line "session restored".
// The fake shell of web mode keeps the snapshot files in the browser storage and its clock is moved
// by the page; nothing leaves the page.

interface Hook {
  lines(): string[];
  paneIds(): string[];
  paneDimLines(paneId: string): string[];
  sessionStarts(): { profileId?: string; cwd?: string }[];
  scrollbackFiles(): Record<string, string>;
  advanceClock(ms: number): void;
  scrollbackCalls(): {
    method: "loadScrollback" | "saveScrollback" | "deleteScrollback";
    paneId: string;
  }[];
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const MARKER = /^session restored \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const WEB_STATE_KEY = "noren.web.state";

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const group = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const labels = (page: Page): Promise<string[]> =>
  list(page)
    .locator('[data-nr-part="item"]')
    .evaluateAll((all) => all.map((el) => el.getAttribute("aria-label") ?? ""));

const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const dimLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneDimLines(id) ?? [], paneId);
const sessionStarts = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []);
const files = (page: Page): Promise<Record<string, string>> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackFiles() ?? {});
const calls = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.scrollbackCalls() ?? []);

async function waitForPrompt(page: Page): Promise<void> {
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
}

async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function waitForLine(page: Page, text: string): Promise<void> {
  await expect.poll(async () => (await lines(page)).includes(text)).toBe(true);
}

/** Gives the tab on screen a name that stays (a typed name locks the title). */
async function renameCurrent(page: Page, from: string, to: string): Promise<void> {
  await tab(page, from).dblclick();
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await field.fill(to);
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  // The focus goes back to the row that was renamed; keys typed before that would be lost.
  await expect(tab(page, to)).toBeFocused();
}

interface Made {
  name: string;
  folder: string;
  paneId: string;
}

/**
 * Opens a tab (the first one already exists) named `name`, moves its shell to `/srv/<name>` and
 * prints `out-<name>`: the folder and the output that must come back.
 */
async function makeTab(page: Page, name: string, first = false): Promise<Made> {
  const before = (await labels(page)).length;
  if (!first) await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(async () => (await labels(page)).length).toBe(before + (first ? 0 : 1));
  const placeholder = first ? "Tab 1" : `Tab ${before + 1}`;
  await renameCurrent(page, placeholder, name);
  await waitForPrompt(page);
  const folder = `/srv/${name}`;
  await run(page, `cd ${folder}`);
  // The shell reports its folder at the next prompt: the next line is typed after that.
  await expect(tab(page, name)).toContainText(folder);
  await run(page, `echo out-${name}`);
  await waitForLine(page, `out-${name}`);
  const [paneId = ""] = await paneIds(page);
  return { name, folder, paneId };
}

async function showTab(page: Page, name: string): Promise<void> {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute("aria-current", "true");
}

const CLOSE = "Control+Shift+W";
const REOPEN = "Control+Alt+Shift+T";

/** The tab that shows is `made`: its old output above the marker, dimmed, and a prompt of a new shell below it. */
async function expectRestored(page: Page, made: Made, shellsBefore: number): Promise<void> {
  await expect(tab(page, made.name)).toHaveAttribute("aria-current", "true");
  await expect.poll(async () => (await lines(page)).some((l) => MARKER.test(l))).toBe(true);
  await waitForPrompt(page);
  const shown = await lines(page);
  const old = shown.indexOf(`out-${made.name}`);
  const marker = shown.findIndex((l) => MARKER.test(l));
  expect(old).toBeGreaterThanOrEqual(0);
  expect(marker).toBeGreaterThan(old);
  expect(shown.slice(marker + 1).some((l) => l.startsWith("fake$"))).toBe(true);
  // A new shell, in the folder the closed one had moved to.
  const starts = await sessionStarts(page);
  expect(starts).toHaveLength(shellsBefore + 1);
  expect(starts.at(-1)?.cwd).toBe(made.folder);
  // The old lines are dimmed in the terminal buffer; the prompt of the new shell is not.
  const [pane = ""] = await paneIds(page);
  expect(pane).toBe(made.paneId);
  const dim = await dimLines(page, pane);
  expect(dim).toContain(`out-${made.name}`);
  expect(dim.some((l) => MARKER.test(l))).toBe(true);
}

test("three tabs closed, then reopened newest first, each one back in its place with its folder and output", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPrompt(page);
  const alpha = await makeTab(page, "alpha", true);
  const beta = await makeTab(page, "beta");
  const gamma = await makeTab(page, "gamma");
  const keeper = await makeTab(page, "keeper");
  expect(await labels(page)).toEqual(["alpha", "beta", "gamma", "keeper"]);
  expect(keeper.paneId).not.toBe("");

  // Close beta, gamma and alpha, in that order, with no minute of the clock gone by: closing is
  // what keeps their output.
  expect(await calls(page)).toEqual([]);
  for (const made of [beta, gamma, alpha]) {
    await showTab(page, made.name);
    await page.keyboard.press(CLOSE);
    await expect(tab(page, made.name)).toHaveCount(0);
  }
  expect(await labels(page)).toEqual(["keeper"]);
  const saved = await files(page);
  for (const made of [alpha, beta, gamma]) {
    expect(saved[made.paneId]).toContain(`out-${made.name}`);
  }
  // A tab that stayed open is not touched.
  expect(saved[keeper.paneId]).toBeUndefined();

  const shells = (await sessionStarts(page)).length;
  // Newest first: alpha, then gamma, then beta, each between the neighbors it had.
  await page.keyboard.press(REOPEN);
  await expect.poll(() => labels(page)).toEqual(["alpha", "keeper"]);
  await expectRestored(page, alpha, shells);

  await page.keyboard.press(REOPEN);
  await expect.poll(() => labels(page)).toEqual(["alpha", "gamma", "keeper"]);
  await expectRestored(page, gamma, shells + 1);

  await page.keyboard.press(REOPEN);
  await expect.poll(() => labels(page)).toEqual(["alpha", "beta", "gamma", "keeper"]);
  await expectRestored(page, beta, shells + 2);

  // The stack is empty now: the key says so and changes nothing.
  await page.keyboard.press(REOPEN);
  await expect(page.getByText("No closed tab to reopen", { exact: true })).toBeVisible();
  expect(await labels(page)).toEqual(["alpha", "beta", "gamma", "keeper"]);
  expect((await sessionStarts(page)).length).toBe(shells + 3);
  // Nothing was removed on the way: the files are still there for the tabs that are open again.
  expect((await calls(page)).filter((c) => c.method === "deleteScrollback")).toEqual([]);
});

test("a tab comes back to its group and position, and to the end of the tree when the group is gone", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPrompt(page);
  await makeTab(page, "alpha", true);
  await makeTab(page, "beta");
  await makeTab(page, "gamma");
  const delta = await makeTab(page, "delta");

  // Group alpha and beta.
  await tab(page, "alpha").click();
  await tab(page, "beta").click({ modifiers: ["Control"] });
  await tab(page, "alpha").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to new group", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(group(page, "New group")).toBeVisible();
  expect(await labels(page)).toEqual(["alpha", "beta", "gamma", "delta"]);

  // Closed inside the group, it comes back inside it, at the same position.
  await showTab(page, "beta");
  await page.keyboard.press(CLOSE);
  await expect(tab(page, "beta")).toHaveCount(0);
  await expect(group(page, "New group").locator('[data-nr-part="group-count"]')).toHaveText("1");
  await page.keyboard.press(REOPEN);
  await expect.poll(() => labels(page)).toEqual(["alpha", "beta", "gamma", "delta"]);
  await expect(group(page, "New group").locator('[data-nr-part="group-count"]')).toHaveText("2");
  await expect(tab(page, "beta")).toHaveAttribute("aria-current", "true");

  // Closed, then the group dissolves: nothing is left to go back to, so it goes to the end.
  await page.keyboard.press(CLOSE);
  await expect(tab(page, "beta")).toHaveCount(0);
  await group(page, "New group").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Ungroup", exact: true }).click();
  await expect(group(page, "New group")).toHaveCount(0);
  expect(await labels(page)).toEqual(["alpha", "gamma", "delta"]);
  await page.keyboard.press(REOPEN);
  await expect.poll(() => labels(page)).toEqual(["alpha", "gamma", "delta", "beta"]);
  await expect(tab(page, "beta")).toHaveAttribute("aria-current", "true");
  // Its output came back, too.
  await expect.poll(async () => (await lines(page)).includes("out-beta")).toBe(true);
  expect(delta.paneId).not.toBe("");
});

test("the palette reopens the tab closed last, and a tab of another space returns to that space", async ({
  page,
}) => {
  await page.goto("/");
  await waitForPrompt(page);
  await makeTab(page, "alpha", true);
  await makeTab(page, "beta");

  // A tab in a second space.
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Other");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await waitForPrompt(page);
  const other = await makeTab(page, "other", true);
  // Keep a tab in the space that is open when the other one closes.
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(async () => (await labels(page)).length).toBe(2);

  await showTab(page, "other");
  await page.keyboard.press(CLOSE);
  await expect(tab(page, "other")).toHaveCount(0);

  // Go to the first space, and reopen from the palette: the tab returns to "Other", which shows.
  await page.keyboard.press("Control+Alt+Digit1");
  await expect(tab(page, "alpha")).toBeVisible();
  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  await palette
    .getByRole("combobox", { name: "Command palette", exact: true })
    .fill("Reopen closed");
  const option = palette.getByRole("option", { name: /Reopen closed tab/ });
  await expect(option).toBeVisible();
  // The palette shows the chord in force.
  await expect(option).toContainText("Ctrl+Alt+Shift+T");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(tab(page, "other")).toHaveAttribute("aria-current", "true");
  await expect.poll(async () => (await lines(page)).some((l) => MARKER.test(l))).toBe(true);
  await expect.poll(async () => (await lines(page)).includes("out-other")).toBe(true);
  expect(await labels(page)).toEqual(["other", "Tab 2"]);
  const starts = await sessionStarts(page);
  expect(starts.at(-1)?.cwd).toBe(other.folder);
});

test("a space that never saves scrollback keeps no output of a closed tab, which still comes back in its folder", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    if (window.localStorage.getItem(key) !== null) return;
    window.localStorage.setItem(
      key,
      JSON.stringify({
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
            saveScrollback: false,
            pinned: [],
            tree: [
              { kind: "item", id: "i1" },
              { kind: "item", id: "i2" },
            ],
            items: {
              i1: {
                id: "i1",
                title: "one",
                titleLocked: true,
                layout: {
                  kind: "pane",
                  pane: {
                    id: "np1",
                    type: "terminal",
                    profileId: "default",
                    status: "idle",
                    unread: false,
                    bell: false,
                  },
                },
                focusedPaneId: "np1",
                lastActivityAt: 1,
              },
              i2: {
                id: "i2",
                title: "two",
                titleLocked: true,
                layout: {
                  kind: "pane",
                  pane: {
                    id: "np2",
                    type: "terminal",
                    profileId: "default",
                    status: "idle",
                    unread: false,
                    bell: false,
                  },
                },
                focusedPaneId: "np2",
                lastActivityAt: 1,
              },
            },
            activeItemId: "i1",
          },
        ],
      }),
    );
  }, WEB_STATE_KEY);
  await page.goto("/");
  await showTab(page, "one");
  await waitForPrompt(page);
  await run(page, "cd /srv/secret");
  await run(page, "echo never-kept");
  await waitForLine(page, "never-kept");

  await page.keyboard.press(CLOSE);
  await expect(tab(page, "one")).toHaveCount(0);
  // Not a write, not a removal: the backend is not even asked.
  expect((await calls(page)).filter((c) => c.method !== "loadScrollback")).toEqual([]);
  expect(await files(page)).toEqual({});

  await page.keyboard.press(REOPEN);
  await expect.poll(() => labels(page)).toEqual(["one", "two"]);
  await waitForPrompt(page);
  const shown = await lines(page);
  expect(shown).not.toContain("never-kept");
  expect(shown.some((l) => MARKER.test(l))).toBe(false);
  expect((await sessionStarts(page)).at(-1)?.cwd).toBe("/srv/secret");
});

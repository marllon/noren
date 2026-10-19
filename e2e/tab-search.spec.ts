import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { closeShortcutsScreen, openShortcutsScreen } from "./settings-fixture";

// The search over the output of every open tab: Ctrl+Shift+Alt+F, the lines grouped by tab, and
// Enter (or a click) going to the line: switch space if needed, focus the tab, scroll and select it.

type TestHook = {
  paneIds(): string[];
  writeCalls(): number;
  lines(): string[];
  selection(): string;
  viewport(): { top: number; rows: number };
};
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);
const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? -1);
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.lines() ?? []);
const selection = (page: Page): Promise<string> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.selection() ?? "");
const viewport = (page: Page): Promise<{ top: number; rows: number }> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.viewport() ?? { top: 0, rows: 0 });

const tabs = (page: Page) =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");
const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });

const panel = (page: Page): Locator => page.locator('[data-nr-part="tab-search"]');
const box = (page: Page): Locator =>
  panel(page).getByRole("textbox", { name: "Search text in all tabs", exact: true });
const rows = (page: Page): Locator => panel(page).getByRole("option");
const heads = (page: Page): Locator => panel(page).locator('[data-nr-part="tab-search-head"]');
const terminalFocused = (page: Page): Locator =>
  page.locator("textarea.xterm-helper-textarea:focus");

/** The name of the tab on screen: its title, not the lines under it (folder, branch, last command). */
const current = async (page: Page): Promise<string> =>
  (await tabs(page).evaluateAll(
    (all) =>
      all
        .find((b) => b.getAttribute("aria-current") === "true")
        ?.querySelector('[data-nr-part="item-title"]')?.textContent ?? "",
  )) as string;

/** Runs `echo <word>` in the terminal on screen and waits for its output. */
async function say(page: Page, word: string): Promise<void> {
  await page.keyboard.type(`echo ${word}`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines(page)).includes(word)).toBe(true);
}

/** Three tabs with their own output (the 2nd says needle-beta), the third one on screen. */
async function threeTabs(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await say(page, "alpha-out");
  for (const word of ["needle-beta", "gamma-out"]) {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect
      .poll(async () => (await lines(page)).some((l) => l.startsWith("fake$")))
      .toBe(true);
    await say(page, word);
  }
  await expect(tabs(page)).toHaveCount(3);
  expect(await current(page)).toBe("Tab 3");
}

/** Makes a second space "Other" whose only tab says zebra-out, then comes back to "Main". */
async function otherSpace(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Other");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await say(page, "zebra-out");
  await spaceButton(page, "Main").click();
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await page.locator('[data-nr-part="pane"]:visible').click();
}

test("a text only the 2nd tab has lists that tab, and Enter focuses it with the line selected", async ({
  page,
}) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+Alt+F");
  await expect(panel(page)).toBeVisible();
  await expect(box(page)).toBeFocused();

  // Nothing is listed until there is a query.
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.type("needle");
  // Grouped by tab: one group, for the tab that has the text, with a row for each line.
  await expect(heads(page)).toHaveCount(1);
  await expect(heads(page).first()).toContainText("Tab 2");
  await expect(heads(page).first()).toContainText("Main");
  await expect(rows(page)).toHaveCount(2);
  const first = rows(page).nth(0);
  await expect(first).toContainText("fake$ echo needle-beta");
  await expect(rows(page).nth(1)).toContainText("needle-beta");
  await expect(first).toHaveAttribute("aria-selected", "true");
  // Every row names its tab and its line (counting from 1).
  const itemId = await first.getAttribute("data-nr-item-id");
  expect(itemId).not.toBeNull();
  await expect(rows(page).nth(1)).toHaveAttribute("data-nr-item-id", itemId ?? "");
  const lineOfFirst = Number(await first.getAttribute("data-nr-line"));
  expect(Number(await rows(page).nth(1).getAttribute("data-nr-line"))).toBe(lineOfFirst + 1);

  const before = await writeCalls(page);
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  expect(await current(page)).toBe("Tab 2");
  // The terminal shows that tab's output with the found line selected, and holds the keyboard.
  await expect.poll(() => selection(page)).toBe("fake$ echo needle-beta");
  expect((await lines(page))[lineOfFirst - 1]).toBe("fake$ echo needle-beta");
  await expect(terminalFocused(page)).toHaveCount(1);
  // Going there typed nothing into the shell.
  expect(await writeCalls(page)).toBe(before);
});

test("Down moves to the next line and Enter selects exactly that line", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+Alt+F");
  await page.keyboard.type("needle");
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "false");
  const line = Number(await rows(page).nth(1).getAttribute("data-nr-line"));
  await page.keyboard.press("Enter");
  expect(await current(page)).toBe("Tab 2");
  await expect.poll(() => selection(page)).toBe("needle-beta");
  expect((await lines(page))[line - 1]).toBe("needle-beta");
});

test("clicking a line goes to it too", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+Alt+F");
  await page.keyboard.type("alpha");
  await expect(heads(page)).toHaveCount(1);
  await expect(heads(page).first()).toContainText("Tab 1");
  await rows(page).nth(1).click();
  await expect(panel(page)).toBeHidden();
  expect(await current(page)).toBe("Tab 1");
  await expect.poll(() => selection(page)).toBe("alpha-out");
  await expect(terminalFocused(page)).toHaveCount(1);
});

test("the match ignores case, and several tabs list in the order of the tabs", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+Alt+F");
  await page.keyboard.type("OUT");
  await expect(heads(page)).toHaveCount(2);
  await expect(heads(page).nth(0)).toContainText("Tab 1");
  await expect(heads(page).nth(1)).toContainText("Tab 3");
  await expect(rows(page)).toHaveCount(4);
  // The text that matched is marked in the line.
  await expect(rows(page).nth(1).locator("mark")).toHaveText("out");
});

test("a line in a tab of another space switches space and selects the line", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await otherSpace(page);

  await page.keyboard.press("Control+Shift+Alt+F");
  await page.keyboard.type("zebra");
  await expect(heads(page)).toHaveCount(1);
  await expect(heads(page).first()).toContainText("Other");
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");
  await expect.poll(() => selection(page)).toBe("zebra-out");
  await expect(terminalFocused(page)).toHaveCount(1);
});

test("a line far up in the scrollback is scrolled into view", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.locator('[data-nr-part="pane"]:visible').click();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.type(`echo scroll-${String(i).padStart(2, "0")}`);
    await page.keyboard.press("Enter");
  }
  await expect.poll(async () => (await lines(page)).includes("scroll-79")).toBe(true);
  // The view follows the output: the first lines are far above it.
  await expect.poll(async () => (await viewport(page)).top).toBeGreaterThan(20);

  await page.keyboard.press("Control+Shift+Alt+F");
  await page.keyboard.type("scroll-00");
  await expect(rows(page)).toHaveCount(2);
  const line = Number(await rows(page).nth(1).getAttribute("data-nr-line"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => selection(page)).toBe("scroll-00");
  // The line is inside the rows on screen.
  await expect
    .poll(async () => {
      const { top, rows: count } = await viewport(page);
      const row = line - 1;
      return row >= top && row < top + count;
    })
    .toBe(true);
});

test("Escape closes the search without going anywhere or typing", async ({ page }) => {
  await threeTabs(page);
  const before = await writeCalls(page);
  await page.keyboard.press("Control+Shift+Alt+F");
  await page.keyboard.type("needle");
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  expect(await current(page)).toBe("Tab 3");
  expect(await selection(page)).toBe("");
  expect(await writeCalls(page)).toBe(before);
  await expect(terminalFocused(page)).toHaveCount(1);
  // Opening it again starts blank.
  await page.keyboard.press("Control+Shift+Alt+F");
  await expect(box(page)).toHaveValue("");
  await expect(rows(page)).toHaveCount(0);
});

test("a text nobody has says so, and a blank query lists nothing", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+Alt+F");
  await expect(panel(page).getByRole("status")).toHaveText(
    "Type to search the output of every open tab.",
  );
  await page.keyboard.type("   ");
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.type("no-such-text-anywhere");
  await expect(rows(page)).toHaveCount(0);
  await expect(panel(page).getByRole("status")).toHaveText("No matches");
  // Enter with nothing to go to leaves the search open.
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
});

test("no shortcut acts while the search box has the keyboard", async ({ page }) => {
  await threeTabs(page);
  expect(await paneIds(page)).toHaveLength(1);
  await page.keyboard.press("Control+Shift+Alt+F");
  await expect(box(page)).toBeFocused();
  await page.keyboard.press("Control+Shift+D");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("d");
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('[data-nr-part="palette"]')).toBeHidden();
  expect(await paneIds(page)).toHaveLength(1);
  await expect(box(page)).toHaveValue("d");
});

test("the palette lists the action and running it opens the search with the box focused", async ({
  page,
}) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">search all");
  const options = page.locator('[data-nr-part="palette"]').getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText("Search all tabs");
  await expect(options.first().locator("kbd")).toHaveText("Ctrl+Alt+Shift+F");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-nr-part="palette"]')).toBeHidden();
  await expect(panel(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
});

test("the shortcuts screen lists the action with its chord and records a new one", async ({
  page,
}) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  const screen = await openShortcutsScreen(page);
  await expect(screen.getByLabel("Shortcut for Search all tabs", { exact: true })).toHaveText(
    "Ctrl+Alt+Shift+F",
  );
  await screen
    .getByRole("button", { name: "Record shortcut for Search all tabs", exact: true })
    .click();
  await page.keyboard.press("Control+Alt+J");
  await expect(screen.getByLabel("Shortcut for Search all tabs", { exact: true })).toHaveText(
    "Ctrl+Alt+J",
  );
  await closeShortcutsScreen(page);
  await expect(screen).toBeHidden();

  await page.locator('[data-nr-part="pane"]:visible').click();
  // The old chord is free now and the new one opens the search.
  await page.keyboard.press("Control+Shift+Alt+F");
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("Control+Alt+J");
  await expect(panel(page)).toBeVisible();
});

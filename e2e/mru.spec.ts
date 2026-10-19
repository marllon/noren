import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The Ctrl+Tab switcher: a tap goes to the previous tab, holding Ctrl and pressing Tab again walks
// the tabs by recent use in an overlay with a preview of each, releasing Ctrl commits and Escape
// cancels.

type TestHook = { paneIds(): string[]; writeCalls(): number; lines(): string[] };
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);
const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? -1);
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.lines() ?? []);

const tabs = (page: Page) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button");
const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });

const overlay = (page: Page): Locator => page.locator('[data-nr-part="mru"]');
const rows = (page: Page): Locator => overlay(page).locator("[data-nr-item-id]");
const terminalFocused = (page: Page): Locator =>
  page.locator("textarea.xterm-helper-textarea:focus");

/** The name of the tab on screen. */
const current = async (page: Page): Promise<string> =>
  (await tabs(page).evaluateAll(
    (all) => all.find((b) => b.getAttribute("aria-current") === "true")?.textContent ?? "",
  )) as string;

/** Runs `echo <word>` in the terminal on screen and waits for its output. */
async function say(page: Page, word: string): Promise<void> {
  await page.keyboard.type(`echo ${word}`);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await lines(page)).includes(word)).toBe(true);
}

/** Three tabs, each with its own output (alpha, beta, gamma), the third one on screen. */
async function threeTabs(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect.poll(async () => (await lines(page)).some((l) => l.startsWith("fake$"))).toBe(true);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await say(page, "alpha");
  for (const word of ["beta", "gamma"]) {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect
      .poll(async () => (await lines(page)).some((l) => l.startsWith("fake$")))
      .toBe(true);
    await say(page, word);
  }
  await expect(tabs(page)).toHaveCount(3);
  expect(await current(page)).toBe("Tab 3");
}

test("Ctrl+Tab goes to the tab used before, and again goes back", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Tab");
  expect(await current(page)).toBe("Tab 2");
  // A tap shows no overlay, and the terminal has the keyboard.
  await expect(overlay(page)).toBeHidden();
  await expect(terminalFocused(page)).toHaveCount(1);
  await expect.poll(async () => (await lines(page)).includes("beta")).toBe(true);
  await page.keyboard.press("Control+Tab");
  expect(await current(page)).toBe("Tab 3");
  await expect.poll(async () => (await lines(page)).includes("gamma")).toBe(true);
});

test("holding Ctrl and pressing Tab twice shows the recent tabs with a preview, releasing lands on the third", async ({
  page,
}) => {
  await threeTabs(page);
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  // One step is a tap in progress: nothing on screen yet.
  await expect(overlay(page)).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(overlay(page)).toBeVisible();
  // By recent use: the tab on screen, then the one before, then the oldest.
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText("Tab 3");
  await expect(rows(page).nth(1)).toContainText("Tab 2");
  await expect(rows(page).nth(2)).toContainText("Tab 1");
  await expect(rows(page).nth(0)).toContainText("gamma");
  await expect(rows(page).nth(1)).toContainText("beta");
  await expect(rows(page).nth(2)).toContainText("alpha");
  // The row it stands on is the selected one, and nothing has switched yet.
  await expect(rows(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "false");
  expect(await current(page)).toBe("Tab 3");

  await page.keyboard.up("Control");
  await expect(overlay(page)).toBeHidden();
  expect(await current(page)).toBe("Tab 1");
  await expect(terminalFocused(page)).toHaveCount(1);
  await expect.poll(async () => (await lines(page)).includes("alpha")).toBe(true);
});

test("Ctrl+Shift+Tab walks back up the list", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(rows(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Shift+Tab");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.up("Control");
  await expect(overlay(page)).toBeHidden();
  expect(await current(page)).toBe("Tab 2");
});

test("Ctrl+Shift+Tab alone goes to the tab used least recently", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Shift+Tab");
  expect(await current(page)).toBe("Tab 1");
});

test("Escape cancels: the tab stays and the terminal does not get the key", async ({ page }) => {
  await threeTabs(page);
  const before = await writeCalls(page);
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(overlay(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay(page)).toBeHidden();
  await page.keyboard.up("Control");
  expect(await current(page)).toBe("Tab 3");
  await expect(terminalFocused(page)).toHaveCount(1);
  expect(await writeCalls(page)).toBe(before);
  // A later tap still works from the list as it was.
  await page.keyboard.press("Control+Tab");
  expect(await current(page)).toBe("Tab 2");
});

test("with one tab Ctrl+Tab does nothing", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(overlay(page)).toBeHidden();
  await page.keyboard.up("Control");
  await expect(tabs(page)).toHaveCount(1);
});

test("a closed tab drops out of the list", async ({ page }) => {
  await threeTabs(page);
  await page.keyboard.press("Control+Tab");
  expect(await current(page)).toBe("Tab 2");
  // Close the tab on screen (Tab 2): the neighbor shows and the list has two tabs left.
  await page.keyboard.press("Control+Shift+W");
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.keyboard.up("Control");
});

test("it reaches the tabs of other spaces and switches space", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Other");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");
  await page.locator('[data-nr-part="pane"]:visible').click();

  await page.keyboard.press("Control+Tab");
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect(terminalFocused(page)).toHaveCount(1);
  await page.keyboard.press("Control+Tab");
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");

  // The overlay names the space of each tab.
  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(0)).toContainText("Other");
  await expect(rows(page).nth(1)).toContainText("Main");
  // With two tabs the second step is back on the tab on screen; a third reaches the other space.
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.up("Control");
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
});

test("the shortcuts screen lists both actions with their chords", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const screen = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(screen.getByLabel("Shortcut for Next recent tab", { exact: true })).toHaveText(
    "Ctrl+Tab",
  );
  await expect(screen.getByLabel("Shortcut for Previous recent tab", { exact: true })).toHaveText(
    "Ctrl+Shift+Tab",
  );
  await expect(
    screen.getByRole("button", { name: "Record shortcut for Next recent tab", exact: true }),
  ).toBeVisible();
});

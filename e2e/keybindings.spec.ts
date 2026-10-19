import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The shortcut preset is kept in the browser storage under `noren.ui.keybindings`; a new test
// context starts with none saved, which is the safe preset.

type TestHook = { writeCalls(): number; paneIds(): string[] };
type TestWindow = Window & { __norenTest?: TestHook };

const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? -1);
const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);

const tabs = (page: Page) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button");
const tab = (page: Page, name: string) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button", { name, exact: true });
const radio = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });

/** Opens the first tab and clicks its terminal so it holds the keyboard, as a user typing would. */
async function openTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect(tabs(page)).toHaveCount(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

/** Chooses a shortcut preset in the Layout panel and closes the panel. */
async function choosePreset(page: Page, name: "Safe" | "Browser"): Promise<void> {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  const panel = page.getByRole("group", { name: "Layout", exact: true });
  await expect(panel).toBeVisible();
  await radio(page, name).check();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await page.locator('[data-nr-part="pane"]:visible').click();
}

test("in the safe preset Ctrl+T adds no tab and reaches the terminal", async ({ page }) => {
  await openTerminal(page);
  const before = await writeCalls(page);
  await page.keyboard.press("Control+T");
  // The shell got the key (Ctrl+T is its own), and Noren opened nothing.
  await expect.poll(() => writeCalls(page)).toBe(before + 1);
  await expect(tabs(page)).toHaveCount(1);
});

test("in the safe preset Ctrl+W reaches the terminal and closes nothing", async ({ page }) => {
  await openTerminal(page);
  const before = await writeCalls(page);
  await page.keyboard.press("Control+W");
  await expect.poll(() => writeCalls(page)).toBe(before + 1);
  await expect(tabs(page)).toHaveCount(1);
  expect(await paneIds(page)).toHaveLength(1);
});

test("in the safe preset Ctrl+Shift+T opens a tab and Alt+1 goes back to the first", async ({
  page,
}) => {
  await openTerminal(page);
  const before = await writeCalls(page);
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "Tab 2")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Alt+1");
  await expect(tab(page, "Tab 1")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Alt+2");
  await expect(tab(page, "Tab 2")).toHaveAttribute("aria-current", "true");
  // Holding the key must not open a tab per repeat, and no key of these reached a shell.
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.down("KeyT");
  await page.keyboard.down("KeyT");
  await page.keyboard.down("KeyT");
  await page.keyboard.up("KeyT");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await expect(tabs(page)).toHaveCount(3);
  expect(await writeCalls(page)).toBe(before);
});

test("choosing the browser preset makes Ctrl+T open a tab", async ({ page }) => {
  await openTerminal(page);
  await choosePreset(page, "Browser");
  const before = await writeCalls(page);
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(2);
  await expect(tab(page, "Tab 2")).toHaveAttribute("aria-current", "true");
  // The key was Noren's: the shell saw nothing.
  expect(await writeCalls(page)).toBe(before);
});

test("in the browser preset Ctrl+1..2 pick a tab and Ctrl+W closes the pane", async ({ page }) => {
  await openTerminal(page);
  await choosePreset(page, "Browser");
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.press("Control+1");
  await expect(tab(page, "Tab 1")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Control+2");
  await expect(tab(page, "Tab 2")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Control+W");
  await expect(tabs(page)).toHaveCount(1);
});

test("in the browser preset the safe chords for those actions are free again", async ({ page }) => {
  await openTerminal(page);
  await choosePreset(page, "Browser");
  // Ctrl+Shift+T and Alt+1 are no action in this preset: Noren leaves them alone.
  await page.keyboard.press("Control+Shift+T");
  await page.keyboard.press("Alt+2");
  await expect(tabs(page)).toHaveCount(1);
});

test("the preset is remembered after a reload, and going back to safe frees Ctrl+T", async ({
  page,
}) => {
  await openTerminal(page);
  await choosePreset(page, "Browser");
  await page.reload();
  await expect(tabs(page)).toHaveCount(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(2);

  await choosePreset(page, "Safe");
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(3);
});

test("a corrupt saved value falls back to the safe preset", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("noren.ui.keybindings", "{this is not json");
  });
  await openTerminal(page);
  const before = await writeCalls(page);
  await page.keyboard.press("Control+T");
  await expect.poll(() => writeCalls(page)).toBe(before + 1);
  await expect(tabs(page)).toHaveCount(1);
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs(page)).toHaveCount(2);
});

test("a shortcut does not act while a text field has the keyboard", async ({ page }) => {
  await openTerminal(page);
  await choosePreset(page, "Browser");
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).focus();
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { changeSettings, configText, seedConfig } from "./settings-fixture";

// The shortcut preset is a setting of `config.jsonc` (`keybindings.preset`), chosen in the settings
// screen; a new test context starts with no file, which is the safe preset. The user's own chords
// stay in the browser storage under `noren.ui.keybindings`.

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

/** Opens the first tab and clicks its terminal so it holds the keyboard, as a user typing would. */
async function openTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await expect(tabs(page)).toHaveCount(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

/** Chooses a shortcut preset in the settings screen, saves, and gives the terminal the keyboard. */
async function choosePreset(page: Page, name: "Safe" | "Browser"): Promise<void> {
  await changeSettings(page, async (screen) => {
    const radio = screen.getByRole("radio", { name, exact: true });
    await radio.check();
    await expect(radio).toBeChecked();
  });
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

test("choosing the preset writes keybindings.preset into the file and leaves the rest of it alone", async ({
  page,
}) => {
  await seedConfig(page, '// mine\n{\n  "notifications": { "enabled": false }, // quiet\n}\n');
  await openTerminal(page);
  await choosePreset(page, "Browser");
  const text = (await configText(page)) ?? "";
  expect(text).toContain("// mine");
  expect(text).toContain("// quiet");
  expect(text).toContain('"enabled": false');
  expect(text).toMatch(/"keybindings": \{\s*"preset": "browser"\s*\}/);
  // And it works at once, with no reload.
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(2);
});

test("a preset chosen before the settings file existed moves into it once", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("noren.web.state") === null) {
      window.localStorage.setItem(
        "noren.ui.keybindings",
        JSON.stringify({ preset: "browser", overrides: { "pane.zoom": "Ctrl+Alt+KeyM" } }),
      );
    }
  });
  await openTerminal(page);
  // The browser preset is in force from the first frame: Ctrl+T opens a tab.
  await page.keyboard.press("Control+T");
  await expect(tabs(page)).toHaveCount(2);
  expect(JSON.parse((await configText(page)) ?? "null")).toEqual({
    keybindings: { preset: "browser" },
  });
  // The user's own chord stays in the storage, without the preset, which the file owns.
  const stored = await page.evaluate(() => window.localStorage.getItem("noren.ui.keybindings"));
  expect(JSON.parse(stored ?? "null")).toEqual({ overrides: { "pane.zoom": "Ctrl+Alt+KeyM" } });
});

test("an unknown preset in the settings file keeps the safe preset and says so", async ({
  page,
}) => {
  await seedConfig(page, '{\n  "keybindings": { "preset": "vim" }\n}\n');
  await openTerminal(page);
  const before = await writeCalls(page);
  await page.keyboard.press("Control+T");
  await expect.poll(() => writeCalls(page)).toBe(before + 1);
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.locator('[data-nr-part="config-notice"]')).toContainText("line 2");
});

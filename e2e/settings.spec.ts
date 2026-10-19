import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  cancelSettings,
  changeSettings,
  configText,
  openSettings,
  openShortcutsScreen,
  saveSettings,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";
import { sidebarState } from "./sidebar-fixture";

// The settings screen: appearance and layout, shortcuts and notifications. It is opened from the
// title bar and from the palette, edits are a draft until Save, and Save writes only the settings
// that changed into `config.jsonc` (the web build keeps that text under `noren.web.config`), with
// the comments of the file in place. The interface follows the file, so nothing reloads.

interface Hook {
  configSaves(): number;
  failConfigSaves(message: string | null): void;
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

const WEB_STATE_KEY = "noren.web.state";

const body = (page: Page) => page.locator(".app-body");
const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const tab = (page: Page, name: string) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button", { name, exact: true });
const radio = (screen: Locator, name: string) => screen.getByRole("radio", { name, exact: true });
const checkbox = (screen: Locator, name: string) =>
  screen.getByRole("checkbox", { name, exact: true });
const saveButton = (screen: Locator) => screen.getByRole("button", { name: "Save", exact: true });
const widthBox = (screen: Locator) => screen.getByRole("textbox", { name: "Sidebar width (px)" });

/** A settings file with comments of every kind and a trailing comma, as a person writes it. */
const COMMENTED = `// My Noren settings, keep this line.
{
  /* where things go */
  "appearance": {
    "sidebar": { "position": "left" }, // I like it on the left
    "density": "comfortable", /* rows */
  },
  // Quiet.
  "notifications": { "enabled": true },
}
`;

/** Starts the app with a workspace and, when given, a settings file already on disk. */
async function start(page: Page, file?: string): Promise<void> {
  await page.addInitScript(
    ({ key, state }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, state);
    },
    { key: WEB_STATE_KEY, state: sidebarState() },
  );
  if (file !== undefined) await seedConfig(page, file);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest !== undefined))
    .toBe(true);
}

const saves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? -1);

const markPage = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
const samePage = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as HookWindow).__stillHere);

test.describe("opening the screen", () => {
  test("the button in the title bar opens it, and Escape closes it without saving", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    await expect(screen.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    for (const name of ["Appearance", "Shortcuts", "Notifications"]) {
      await expect(screen.getByRole("region", { name, exact: true })).toBeVisible();
    }
    await radio(screen, "Right").check();
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBeNull();
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
  });

  test("the palette opens it, and closing it gives the terminal the keyboard back", async ({
    page,
  }) => {
    await start(page);
    await page.locator('[data-nr-part="pane"]:visible').click();
    await page.keyboard.press("Control+Shift+P");
    await page.keyboard.type(">open settings");
    const palette = page.locator('[data-nr-part="palette"]');
    const option = palette.getByRole("option");
    await expect(option).toHaveCount(1);
    await expect(option.first()).toContainText("Open settings");
    // The screen is not a key press away unless the user gives it a chord.
    await expect(option.first().locator("kbd")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(settingsScreen(page)).toBeVisible();

    await cancelSettings(page);
    await expect(page.locator("textarea.xterm-helper-textarea:focus")).toHaveCount(1);
  });

  test("Open settings is a shortcut like the others: it has no key, and can be given one", async ({
    page,
  }) => {
    await start(page);
    const shortcuts = await openShortcutsScreen(page);
    await expect(shortcuts.getByLabel("Shortcut for Open settings", { exact: true })).toHaveText(
      "None",
    );
    await shortcuts
      .getByRole("button", { name: "Record shortcut for Open settings", exact: true })
      .click();
    await page.keyboard.press("Control+Alt+Comma");
    await expect(shortcuts.getByLabel("Shortcut for Open settings", { exact: true })).toHaveText(
      "Ctrl+Alt+,",
    );
    await shortcuts.getByRole("button", { name: "Close", exact: true }).click();
    await cancelSettings(page);

    await page.locator('[data-nr-part="pane"]:visible').click();
    await page.keyboard.press("Control+Alt+Comma");
    await expect(settingsScreen(page)).toBeVisible();
  });
});

test.describe("saving", () => {
  test("keeps the comments of the file, changes only what changed, and the interface follows without a reload", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    await markPage(page);
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");

    const screen = await openSettings(page);
    // The screen shows what the file says.
    await expect(radio(screen, "Left")).toBeChecked();
    await expect(radio(screen, "Comfortable")).toBeChecked();
    await expect(checkbox(screen, "System notifications")).toBeChecked();

    await radio(screen, "Right").check();
    await checkbox(screen, "Pane headers").check();
    await saveSettings(page);

    // The interface changed, on the same page: nothing reloaded and the open tab is still open.
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    await expect(page.locator('[data-nr-part="pane-header"]:visible')).toHaveCount(1);
    expect(await samePage(page)).toBe(true);
    await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");

    // The file kept every comment and every line it had; only the two settings differ.
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain("/* where things go */");
    expect(text).toContain("// I like it on the left");
    expect(text).toContain("/* rows */");
    expect(text).toContain("// Quiet.");
    expect(text).toBe(
      COMMENTED.replace('"position": "left"', '"position": "right"').replace(
        '    "density": "comfortable", /* rows */\n',
        '    "density": "comfortable", /* rows */\n    "paneHeaders": true,\n',
      ),
    );
    expect(await saves(page)).toBe(1);
  });

  test("saving twice in a row keeps both changes and every comment", async ({ page }) => {
    await start(page, COMMENTED);
    await changeSettings(page, (screen) => radio(screen, "Compact").check());
    await changeSettings(page, async (screen) => {
      await radio(screen, "On top").check();
      await radio(screen, "Right").check();
    });
    await expect(page.locator('[data-nr-part="tabbar"]')).toBeVisible();
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// I like it on the left");
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain('"density": "compact"');
    expect(text).toContain('"tabs": "top"');
    expect(text).toContain('"position": "right"');
    expect(text).not.toContain('"position": "left"');
  });

  test("a draft that changes nothing cannot be saved, and a change put back cannot either", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await expect(saveButton(screen)).toBeDisabled();
    await radio(screen, "Right").check();
    await expect(saveButton(screen)).toBeEnabled();
    await radio(screen, "Left").check();
    await expect(saveButton(screen)).toBeDisabled();
    await checkbox(screen, "System notifications").uncheck();
    await expect(saveButton(screen)).toBeEnabled();
    await cancelSettings(page);
    expect(await saves(page)).toBe(0);
  });

  test("writes only the setting that changed when the file holds a lot", async ({ page }) => {
    const file = `{
  "appearance": {
    "sidebar": { "position": "right", "width": 260, "compact": false },
    "density": "compact", // tight
    "tabs": "sidebar",
  },
  "keybindings": { "preset": "safe" },
  "notifications": { "enabled": false, "longCommandSeconds": 90 },
}
`;
    await start(page, file);
    await changeSettings(page, (screen) => radio(screen, "Browser").check());
    expect(await configText(page)).toBe(file.replace('"preset": "safe"', '"preset": "browser"'));
  });

  test("creates the file when there is none, with only what was asked", async ({ page }) => {
    await start(page);
    expect(await configText(page)).toBeNull();
    await changeSettings(page, async (screen) => {
      await radio(screen, "Browser").check();
      await checkbox(screen, "System notifications").uncheck();
    });
    expect(JSON.parse((await configText(page)) ?? "null")).toEqual({
      keybindings: { preset: "browser" },
      notifications: { enabled: false },
    });
    // It is a file a person can read: one setting to a line, in the order of the documentation.
    expect(await configText(page)).toBe(
      '{\n  "keybindings": {\n    "preset": "browser"\n  },\n  "notifications": {\n    "enabled": false\n  }\n}\n',
    );
  });

  test("a number is read from its box, and Enter in the box saves", async ({ page }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await expect(widthBox(screen)).toHaveValue("200");
    await widthBox(screen).fill("260");
    await page.keyboard.press("Enter");
    await expect(settingsScreen(page)).toHaveCount(0);
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(260);
    expect(await configText(page)).toContain('"width": 260');
    expect(await configText(page)).toContain("// I like it on the left");
  });

  test("a number out of its range is refused where it is typed, and nothing is written", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await widthBox(screen).fill("9000");
    await expect(widthBox(screen)).toHaveAttribute("aria-invalid", "true");
    await expect(screen).toContainText("Whole pixels, from 180 to 480.");
    await expect(saveButton(screen)).toBeDisabled();
    await widthBox(screen).fill("two hundred");
    await expect(saveButton(screen)).toBeDisabled();

    const seconds = screen.getByRole("textbox", { name: "Long command limit (seconds)" });
    await seconds.fill("-3");
    await expect(screen).toContainText("A number of seconds, zero or more.");
    await expect(saveButton(screen)).toBeDisabled();

    await widthBox(screen).fill("300");
    await seconds.fill("45.5");
    await expect(saveButton(screen)).toBeEnabled();
    await saveSettings(page);
    expect(await configText(page)).toContain('"width": 300');
    expect(await configText(page)).toContain('"longCommandSeconds": 45.5');
  });
});

test.describe("when the file cannot be written", () => {
  test("a write that fails says why, keeps the screen and the draft, and the next try works", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves("disk full"));
    const screen = await openSettings(page);
    await radio(screen, "Right").check();
    await saveButton(screen).click();

    await expect(screen.locator('[data-nr-part="settings-failure"]')).toContainText(
      "Could not write config.jsonc: disk full",
    );
    await expect(screen).toBeVisible();
    await expect(radio(screen, "Right")).toBeChecked();
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
    expect(await configText(page)).toBe(COMMENTED);

    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves(null));
    await saveSettings(page);
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
  });

  test("a file with a mistake is not edited: the screen says where and Save waits", async ({
    page,
  }) => {
    const broken = '{\n  "appearance": {\n    "sidebar": { "position": "middle" }\n  }\n}\n';
    await start(page, broken);
    const screen = await openSettings(page);
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toContainText("line 3");
    await radio(screen, "Right").check();
    await expect(saveButton(screen)).toBeDisabled();
    await cancelSettings(page);
    expect(await configText(page)).toBe(broken);
    expect(await saves(page)).toBe(0);

    // Fixed by hand, the same screen saves.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{ "appearance": { "sidebar": { "position": "left" } } }',
      ),
    );
    await changeSettings(page, (open) => radio(open, "Right").check());
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
  });
});

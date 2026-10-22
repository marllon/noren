import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  closeSettings,
  changeSettings,
  configText,
  openSettings,
  openShortcutsScreen,
  quiet,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";
import { sidebarState } from "./sidebar-fixture";

// The settings screen: appearance and layout, terminal, profiles, shortcuts, notifications,
// auto-archive and AI. It is opened from the title bar and from the palette. There is no Save
// (NOR-F20-10c): every change is written as it is made, only the setting that changed, into
// `config.jsonc` (the web build keeps that text under `noren.web.config`), with the comments of the
// file in place. The interface follows the file, so nothing reloads.

interface Drawing {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: string;
  cursorBlink: boolean;
  scrollback: number;
}

interface Hook {
  configSaves(): number;
  failConfigSaves(message: string | null): void;
  setConfig(text: string | null): void;
  terminalDrawing(): Drawing | undefined;
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

const WEB_STATE_KEY = "noren.web.state";

const body = (page: Page) => page.locator(".app-body");
const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const tab = (page: Page, name: string) =>
  page
    .getByRole("tree", { name: "Tabs", exact: true })
    .getByRole("treeitem", { name, exact: true });
const radio = (screen: Locator, name: string) => screen.getByRole("radio", { name, exact: true });
const checkbox = (screen: Locator, name: string) =>
  screen.getByRole("switch", { name, exact: true });
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
  test("the button in the title bar opens it, and Escape closes it with what was chosen already written", async ({
    page,
  }) => {
    await start(page);
    const screen = await openSettings(page);
    await expect(screen.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    for (const name of [
      "Appearance",
      "Terminal options",
      "Profiles",
      "Shortcuts",
      "Notifications",
      "Auto-archive",
      "AI",
    ]) {
      await expect(screen.getByRole("region", { name, exact: true })).toBeVisible();
    }
    // The screen has no Save and no Cancel: what is chosen is written there and then.
    await expect(screen.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(screen.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await radio(screen, "Right").check();
    await expect.poll(() => saves(page)).toBe(1);
    expect(await configText(page)).toContain('"position": "right"');
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await saves(page)).toBe(1);
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
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

    await closeSettings(page);
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
    await closeSettings(page);

    await page.locator('[data-nr-part="pane"]:visible').click();
    await page.keyboard.press("Control+Alt+Comma");
    await expect(settingsScreen(page)).toBeVisible();
  });
});

test.describe("writing as it is changed", () => {
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
    await expect.poll(() => saves(page)).toBe(1);
    await checkbox(screen, "Pane headers").check();
    await expect.poll(() => saves(page)).toBe(2);
    await closeSettings(page);

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
    // One write for each change, and closing the screen had nothing more to write.
    expect(await saves(page)).toBe(2);
  });

  test("opening the screen twice keeps both changes and every comment", async ({ page }) => {
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

  test("a screen nobody touched writes nothing, and a change put back is written back, as it was", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await quiet(page);
    expect(await saves(page)).toBe(0);
    // The choice the file already has is not a change: nothing is written for it.
    await radio(screen, "Left").check();
    await quiet(page);
    expect(await saves(page)).toBe(0);

    await radio(screen, "Right").check();
    await expect.poll(() => saves(page)).toBe(1);
    await radio(screen, "Left").check();
    await expect.poll(() => saves(page)).toBe(2);
    // The second write undid the first: the file is exactly what it was.
    expect(await configText(page)).toBe(COMMENTED);

    await checkbox(screen, "System notifications").uncheck();
    await expect.poll(() => saves(page)).toBe(3);
    expect(await configText(page)).toContain('"enabled": false');
    await closeSettings(page);
    expect(await saves(page)).toBe(3);
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

  test("a number is read from its box and written when the typing pauses, and Enter in the box writes it now", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await expect(widthBox(screen)).toHaveValue("200");
    await widthBox(screen).fill("260");
    // The window shows the number as it is typed; the file has it a moment later.
    await expect.poll(() => saves(page)).toBe(1);
    expect(await configText(page)).toContain('"width": 260');
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(260);

    // Enter does not wait for the pause, and it does not close the screen.
    await widthBox(screen).fill("270");
    await page.keyboard.press("Enter");
    await expect.poll(() => saves(page)).toBe(2);
    await expect(settingsScreen(page)).toBeVisible();
    expect(await configText(page)).toContain('"width": 270');
    expect(await configText(page)).toContain("// I like it on the left");
  });

  test("a number out of its range is refused where it is typed, and nothing is written for it", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await widthBox(screen).fill("9000");
    await expect(widthBox(screen)).toHaveAttribute("aria-invalid", "true");
    await expect(screen).toContainText("Whole pixels, from 180 to 480.");
    await quiet(page);
    expect(await saves(page)).toBe(0);
    await widthBox(screen).fill("two hundred");
    await quiet(page);
    expect(await saves(page)).toBe(0);

    const seconds = screen.getByRole("textbox", { name: "Long command limit (seconds)" });
    await seconds.fill("-3");
    await expect(screen).toContainText("A number of seconds, zero or more.");
    await quiet(page);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBe(COMMENTED);

    // Back inside the range the reason goes and the number is written, one box and then the other.
    await widthBox(screen).fill("300");
    await expect.poll(() => saves(page)).toBe(1);
    await expect(widthBox(screen)).not.toHaveAttribute("aria-invalid", "true");
    expect(await configText(page)).toContain('"width": 300');
    expect(await configText(page)).not.toContain("longCommandSeconds");
    await seconds.fill("45.5");
    await expect.poll(() => saves(page)).toBe(2);
    await closeSettings(page);
    expect(await configText(page)).toContain('"width": 300');
    expect(await configText(page)).toContain('"longCommandSeconds": 45.5');
  });

  test("closing with Escape right after typing does not lose the number", async ({ page }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await widthBox(screen).fill("310");
    // No pause: the screen goes while the number is still waiting for its moment.
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await configText(page)).toContain('"width": 310');
    await expect.poll(async () => (await sidebar(page).boundingBox())?.width).toBe(310);

    const again = await openSettings(page);
    await expect(widthBox(again)).toHaveValue("310");
  });

  test("a click outside the screen and the X close it, with what was typed written", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    let screen = await openSettings(page);
    await widthBox(screen).fill("320");
    await page.mouse.click(2, 2);
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await configText(page)).toContain('"width": 320');

    screen = await openSettings(page);
    await widthBox(screen).fill("330");
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await configText(page)).toContain('"width": 330');

    // A click inside the screen does not close it.
    screen = await openSettings(page);
    await screen.getByRole("heading", { name: "Settings", exact: true }).click();
    await expect(screen).toBeVisible();
  });
});

test.describe("when the file cannot be written", () => {
  test("a write that fails says why, keeps the screen and the change, and the next try works", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves("disk full"));
    const screen = await openSettings(page);
    await radio(screen, "Right").check();

    await expect(screen.locator('[data-nr-part="settings-failure"]')).toContainText(
      "Could not write config.jsonc: disk full",
    );
    await expect(screen).toBeVisible();
    await expect(radio(screen, "Right")).toBeChecked();
    // The window shows the change as a preview while the screen is open (NOR-F20-10b); the file, which is
    // what failed to be written, still has what it had.
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    expect(await configText(page)).toBe(COMMENTED);

    // Closing tries again; with the disk still refusing, the screen stays (the person has not lost the
    // change without knowing it) and says so, and the next close lets go of it.
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(screen).toBeVisible();
    await expect(screen.locator('[data-nr-part="settings-failure"]')).toBeVisible();

    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves(null));
    await closeSettings(page);
    await expect(body(page)).toHaveAttribute("data-nr-side", "right");
    expect(await configText(page)).toContain('"position": "right"');
  });

  test("a screen closed twice while the disk refuses lets the change go, and the file is as it was", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves("disk full"));
    const screen = await openSettings(page);
    await radio(screen, "Right").check();
    await expect(screen.locator('[data-nr-part="settings-failure"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(screen).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
    expect(await configText(page)).toBe(COMMENTED);
    await expect(body(page)).toHaveAttribute("data-nr-side", "left");
  });

  test("a file with a mistake is not edited: the screen says where and writes nothing", async ({
    page,
  }) => {
    const broken = '{\n  "appearance": {\n    "sidebar": { "position": "middle" }\n  }\n}\n';
    await start(page, broken);
    const screen = await openSettings(page);
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toContainText("line 3");
    await radio(screen, "Right").check();
    await quiet(page);
    expect(await saves(page)).toBe(0);
    // Closing does not lose the change without a word: the screen stays once, with the notice.
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(screen).toBeVisible();
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(settingsScreen(page)).toHaveCount(0);
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

  test("a mistake in the file that comes while the screen is open holds the writes until it is fixed", async ({
    page,
  }) => {
    await start(page, COMMENTED);
    const screen = await openSettings(page);
    await radio(screen, "Right").check();
    await expect.poll(() => saves(page)).toBe(1);
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig('{ "appearance": { "density": "wide" } }'),
    );
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toBeVisible();
    await checkbox(screen, "Pane headers").check();
    await quiet(page);
    expect(await saves(page)).toBe(1);

    // Fixed, the next change writes again.
    await page.evaluate(() =>
      (window as HookWindow).__norenTest?.setConfig(
        '{ "appearance": { "sidebar": { "position": "right" } } }',
      ),
    );
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toHaveCount(0);
    await radio(screen, "Compact").check();
    await expect.poll(() => saves(page)).toBe(2);
    expect(await configText(page)).toContain('"density": "compact"');
    // The change made while the file was broken was kept, and goes with it.
    expect(await configText(page)).toContain('"paneHeaders": true');
  });
});

// The Terminal, Profiles and Auto-archive sections: each one writes its own settings into the file
// the same way as the first sections, with the comments of the file in place.

const drawing = (page: Page): Promise<Drawing | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.terminalDrawing());

const section = (screen: Locator, name: string) =>
  screen.getByRole("region", { name, exact: true });
const textbox = (scope: Locator, name: string) => scope.getByRole("textbox", { name, exact: true });

const TERMINAL_FILE = `// My Noren settings, keep this line.
{
  "terminal": {
    "font": { "size": 16 }, // my size
    /* the cursor */
    "cursor": { "style": "bar" },
  },
  "notifications": { "enabled": true }, // quiet
}
`;

test.describe("the Terminal section", () => {
  test("changes the terminal the moment it is written, and the file keeps its comments", async ({
    page,
  }) => {
    await start(page, TERMINAL_FILE);
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(16);
    expect((await drawing(page))?.cursorStyle).toBe("bar");
    await markPage(page);

    const screen = await openSettings(page);
    const terminal = section(screen, "Terminal options");
    // The screen shows what the file says, and the defaults for what it does not.
    await expect(textbox(terminal, "Font size (px)")).toHaveValue("16");
    await expect(radio(terminal, "Bar")).toBeChecked();
    await expect(textbox(terminal, "Scrollback (lines)")).toHaveValue("10000");
    // Four ways to react to the bell are a drop-down list, with the chosen one showing.
    const bell = terminal.getByRole("combobox", {
      name: "When a program rings the bell",
      exact: true,
    });
    await expect(bell).toHaveValue("none");
    await expect(bell.locator("option:checked")).toHaveText("Only mark the tab");

    await textbox(terminal, "Font size (px)").fill("20");
    await radio(terminal, "Underline").check();
    await checkbox(terminal, "Cursor blinks").uncheck();
    await textbox(terminal, "Scrollback (lines)").fill("500");
    await bell.selectOption({ label: "Flash and beep" });
    // The font comes from the list of monospaced fonts the backend has.
    await terminal
      .getByRole("combobox", { name: "Installed font", exact: true })
      .selectOption("Consolas");
    await expect(textbox(terminal, "Font list")).toHaveValue("Consolas, monospace");
    await closeSettings(page);

    // The terminal that was already running follows the file: no reload, the tab is still the one.
    await expect
      .poll(() => drawing(page))
      .toMatchObject({
        fontSize: 20,
        cursorStyle: "underline",
        cursorBlink: false,
        scrollback: 500,
        fontFamily: "Consolas, monospace",
      });
    expect(await samePage(page)).toBe(true);
    await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");

    const text = (await configText(page)) ?? "";
    for (const comment of [
      "// My Noren settings, keep this line.",
      "// my size",
      "/* the cursor */",
      "// quiet",
    ]) {
      expect(text).toContain(comment);
    }
    expect(text).toContain('"size": 20');
    expect(text).toContain('"family": "Consolas, monospace"');
    expect(text).toContain('"style": "underline"');
    expect(text).toContain('"blink": false');
    expect(text).toContain('"scrollback": 500');
    expect(text).toContain('"bell": "both"');
    expect(text).not.toContain('"size": 16');
    // Written as it went (a choice at once, a number when the typing paused), not all at the end.
    expect(await saves(page)).toBeGreaterThan(1);
  });

  test("a value the schema refuses is shown where it is typed and nothing is written for it", async ({
    page,
  }) => {
    await start(page, TERMINAL_FILE);
    const screen = await openSettings(page);
    const terminal = section(screen, "Terminal options");
    const size = textbox(terminal, "Font size (px)");
    await size.fill("500");
    await expect(size).toHaveAttribute("aria-invalid", "true");
    await expect(terminal).toContainText("A number of pixels from 6 to 72.");
    await textbox(terminal, "Line height (1 to 3)").fill("0.5");
    await expect(terminal).toContainText("A number from 1 to 3.");
    await textbox(terminal, "Scrollback (lines)").fill("ten");
    await expect(terminal).toContainText("A whole number of lines, from 0 to 100000.");
    await textbox(terminal, "Font list").fill("url(http://example.com/a.woff)");
    await expect(textbox(terminal, "Font list")).toHaveAttribute("aria-invalid", "true");
    await quiet(page);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBe(TERMINAL_FILE);
    expect((await drawing(page))?.fontSize).toBe(16);

    // Each box that becomes a value the schema takes is written, and the others go on waiting.
    await size.fill("18");
    await expect.poll(() => saves(page)).toBe(1);
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(18);
    await expect(size).not.toHaveAttribute("aria-invalid", "true");
    await expect(textbox(terminal, "Scrollback (lines)")).toHaveAttribute("aria-invalid", "true");
    await textbox(terminal, "Line height (1 to 3)").fill("1.5");
    await expect.poll(() => saves(page)).toBe(2);
    await textbox(terminal, "Scrollback (lines)").fill("2000");
    await expect.poll(() => saves(page)).toBe(3);
    await textbox(terminal, "Font list").fill("Fira Code, monospace");
    await expect.poll(() => saves(page)).toBe(4);
    await closeSettings(page);
    expect(await saves(page)).toBe(4);

    const text = (await configText(page)) ?? "";
    expect(text).toContain('"size": 18');
    expect(text).toContain('"lineHeight": 1.5');
    expect(text).toContain('"scrollback": 2000');
    expect(text).toContain('"family": "Fira Code, monospace"');
    expect(text).toContain("// my size");
    expect(text).toContain("/* the cursor */");
  });
});

const PROFILES_FILE = `// My Noren settings, keep this line.
{
  /* my shells */
  "profiles": [
    // the first one
    { "id": "dev", "name": "Dev Shell", "program": "pwsh.exe", "args": ["-NoLogo"] }, // keep
    {
      "id": "ops",
      "name": "Ops",
      "program": "bash", // the program
    },
  ],
  "notifications": { "enabled": true }, // quiet
}
`;

const profile = (screen: Locator, name: string) =>
  section(screen, "Profiles").getByRole("group", { name, exact: true });
const argsBox = (scope: Locator) => textbox(scope, "Arguments (one per line)");
const addProfile = (screen: Locator) =>
  section(screen, "Profiles").getByRole("button", { name: "Add profile", exact: true });

/** The titles of the profile entries of the palette; the palette is closed again. */
async function profileTitles(page: Page): Promise<string[]> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  const titles = await palette.locator('[data-nr-kind="profile"] .palette-title').allTextContents();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  return titles;
}

test.describe("the Profiles section", () => {
  test("lists the profiles of the file, and adds one, keeping the comments", async ({ page }) => {
    await start(page, PROFILES_FILE);
    const screen = await openSettings(page);
    await expect(textbox(profile(screen, "Dev Shell"), "Program")).toHaveValue("pwsh.exe");
    await expect(argsBox(profile(screen, "Dev Shell"))).toHaveValue("-NoLogo");
    await expect(textbox(profile(screen, "Ops"), "Program")).toHaveValue("bash");

    await addProfile(screen).click();
    const fresh = profile(screen, "New profile 3");
    await textbox(fresh, "Name").fill("Build Box");
    await textbox(fresh, "Program").fill("cmd.exe");
    await argsBox(fresh).fill("/k\nvcvars64.bat");
    await textbox(fresh, "Start folder").fill("D:\\build");
    await closeSettings(page);

    const text = (await configText(page)) ?? "";
    for (const comment of [
      "// My Noren settings, keep this line.",
      "/* my shells */",
      "// the first one",
      "// keep",
      "// the program",
      "// quiet",
    ]) {
      expect(text).toContain(comment);
    }
    expect(text).toContain('"id": "build-box"');
    expect(text).toContain('"args": ["/k", "vcvars64.bat"]');
    expect(text).toContain('"cwd": "D:\\\\build"');
    // The palette lists it with no reload.
    await expect.poll(() => profileTitles(page)).toContain("New Build Box tab");
  });

  test("edits the name, the program, the arguments and the folder of a profile", async ({
    page,
  }) => {
    await start(page, PROFILES_FILE);
    const screen = await openSettings(page);
    const ops = profile(screen, "Ops");
    await textbox(ops, "Program").fill("fish");
    await argsBox(ops).fill("-l");
    await textbox(ops, "Start folder").fill("/srv");
    // The name is last: the box is named for the profile of the file, which has the new name once
    // it is written.
    await textbox(ops, "Name").fill("Operations");
    await expect(profile(screen, "Operations")).toBeVisible();
    await closeSettings(page);

    const text = (await configText(page)) ?? "";
    expect(text).toContain('"name": "Operations"');
    expect(text).toContain('"program": "fish", // the program');
    expect(text).toContain('"args": ["-l"]');
    expect(text).toContain('"cwd": "/srv"');
    expect(text).toContain('"id": "ops"');
    expect(text).toContain("// the first one");
    expect(text).toContain("// keep");
    await expect.poll(() => profileTitles(page)).toContain("New Operations tab");
    expect(await profileTitles(page)).not.toContain("New Ops tab");
  });

  test("removes a profile and nothing else", async ({ page }) => {
    await start(page, PROFILES_FILE);
    await expect.poll(() => profileTitles(page)).toContain("New Dev Shell tab");
    const screen = await openSettings(page);
    await profile(screen, "Dev Shell")
      .getByRole("button", { name: "Remove profile", exact: true })
      .click();
    // It cannot be taken back (there is no Cancel), so the screen asks first.
    const ask = page.getByRole("alertdialog", { name: "Remove this profile?", exact: true });
    await expect(ask).toContainText("“Dev Shell” is taken out of config.jsonc.");
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(profile(screen, "Dev Shell")).toBeVisible();
    await quiet(page);
    expect(await saves(page)).toBe(0);

    await profile(screen, "Dev Shell")
      .getByRole("button", { name: "Remove profile", exact: true })
      .click();
    await ask.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(profile(screen, "Dev Shell")).toHaveCount(0);
    await expect.poll(() => saves(page)).toBe(1);
    await closeSettings(page);

    const text = (await configText(page)) ?? "";
    expect(text).not.toContain('"dev"');
    expect(text).toContain('"id": "ops"');
    for (const comment of [
      "// My Noren settings, keep this line.",
      "/* my shells */",
      "// quiet",
    ]) {
      expect(text).toContain(comment);
    }
    await expect.poll(() => profileTitles(page)).not.toContain("New Dev Shell tab");
    expect(await profileTitles(page)).toContain("New Ops tab");
  });

  test("a profile with no name or program is refused on the screen and nothing is written for it", async ({
    page,
  }) => {
    await start(page, PROFILES_FILE);
    const screen = await openSettings(page);
    await addProfile(screen).click();
    const fresh = profile(screen, "New profile 3");
    await textbox(fresh, "Name").fill("Half done");
    await expect(textbox(fresh, "Program")).toHaveAttribute("aria-invalid", "true");
    await quiet(page);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBe(PROFILES_FILE);

    // Valid now, but a new profile is written when the person leaves its row: its id is made from its
    // name, which is not final while the row has the keyboard.
    await textbox(fresh, "Program").fill("zsh");
    await quiet(page);
    expect(await saves(page)).toBe(0);
    const opsProgram = textbox(profile(screen, "Ops"), "Program");
    await opsProgram.fill("   ");
    await expect(opsProgram).toHaveAttribute("aria-invalid", "true");
    await expect.poll(() => saves(page)).toBe(1);
    expect(await configText(page)).toContain('"id": "half-done"');
    expect(await configText(page)).toContain('"program": "zsh"');

    // The row that is not valid is not written, and the rest of the file is as it was.
    await quiet(page);
    expect(await saves(page)).toBe(1);
    await closeSettings(page);
    const text = (await configText(page)) ?? "";
    expect(text).toContain('"program": "bash", // the program');
    expect(text).toContain('"name": "Half done"');
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain("/* my shells */");
  });
});

const ARCHIVE_FILE = `// My Noren settings, keep this line.
{
  // Keep tabs a while.
  "archive": { "enabled": true }, // on
  "notifications": { "enabled": true },
}
`;

test.describe("the Auto-archive section", () => {
  test("writes the switch and the hours, keeping the comments", async ({ page }) => {
    await start(page, ARCHIVE_FILE);
    const screen = await openSettings(page);
    const archive = section(screen, "Auto-archive");
    await expect(checkbox(archive, "Archive idle tabs")).toBeChecked();
    await expect(textbox(archive, "Archive after (hours)")).toHaveValue("12");

    await checkbox(archive, "Archive idle tabs").uncheck();
    await textbox(archive, "Archive after (hours)").fill("0.5");
    await closeSettings(page);

    expect(await configText(page)).toBe(
      ARCHIVE_FILE.replace(
        '"enabled": true }, // on',
        '"enabled": false, "afterHours": 0.5 }, // on',
      ),
    );
    // Opened again, the screen shows what was saved.
    const again = section(await openSettings(page), "Auto-archive");
    await expect(checkbox(again, "Archive idle tabs")).not.toBeChecked();
    await expect(textbox(again, "Archive after (hours)")).toHaveValue("0.5");
    await closeSettings(page);
  });

  test("hours that are not above zero are refused where they are typed", async ({ page }) => {
    await start(page, ARCHIVE_FILE);
    const screen = await openSettings(page);
    const archive = section(screen, "Auto-archive");
    const hours = textbox(archive, "Archive after (hours)");
    for (const text of ["0", "-2", "soon"]) {
      await hours.fill(text);
      await expect(hours).toHaveAttribute("aria-invalid", "true");
      await expect(archive).toContainText("A number of hours above zero.");
    }
    await quiet(page);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBe(ARCHIVE_FILE);
    await hours.fill("2");
    await expect.poll(() => saves(page)).toBe(1);
    await closeSettings(page);
    expect(await configText(page)).toBe(
      ARCHIVE_FILE.replace('"enabled": true }, // on', '"enabled": true, "afterHours": 2 }, // on'),
    );
  });
});

const AI_FILE = `// My Noren settings, keep this line.
{
  "notifications": { "enabled": true }, // quiet
  // The AI stays off until I say so.
  "ai": {
    "providers": [
      { "id": "work", "kind": "openai-compatible", "baseUrl": "https://llm.example.com/v1", "model": "big" },
    ],
  },
}
`;

test.describe("the AI section", () => {
  test("turns the AI on and sets the model of Ask, keeping the comments", async ({ page }) => {
    await start(page, AI_FILE);
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    await expect(checkbox(ai, "Turn the AI on")).not.toBeChecked();
    const provider = ai.getByLabel("Ask provider", { exact: true });
    // The providers to pick from are Ollama and the ones the file lists.
    await expect(provider.locator("option")).toHaveText(["No provider", "Ollama", "work"]);

    await checkbox(ai, "Turn the AI on").check();
    await expect.poll(() => saves(page)).toBe(1);
    // A provider with no model is not a default yet: nothing is written until the model is typed.
    await provider.selectOption("ollama");
    await quiet(page);
    expect(await saves(page)).toBe(1);
    await textbox(ai, "Ask model").fill("llama3");
    await expect.poll(() => saves(page)).toBe(2);
    await closeSettings(page);

    const text = await configText(page);
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain('"notifications": { "enabled": true }, // quiet');
    expect(text).toContain("// The AI stays off until I say so.");
    expect(text).toContain('"id": "work"');
    expect(text).toMatch(/"enabled": true/);
    expect(text).toMatch(/"ask": \{[^}]*"provider": "ollama"[^}]*"model": "llama3"/);
    expect(text).not.toContain('"explain"');
    expect(text).not.toContain('"command"');
    expect(await saves(page)).toBe(2);

    // Opened again, the screen shows what was saved.
    const again = section(await openSettings(page), "AI");
    await expect(checkbox(again, "Turn the AI on")).toBeChecked();
    await expect(again.getByLabel("Ask provider", { exact: true })).toHaveValue("ollama");
    await expect(textbox(again, "Ask model")).toHaveValue("llama3");
    await expect(again.getByLabel("Explain provider", { exact: true })).toHaveValue("");
    await closeSettings(page);
  });

  test("a provider with no model is refused where it is typed, and nothing is written for it", async ({
    page,
  }) => {
    await start(page, AI_FILE);
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    await ai.getByLabel("Explain provider", { exact: true }).selectOption("work");
    const model = textbox(ai, "Explain model");
    await expect(model).toHaveAttribute("aria-invalid", "true");
    await expect(ai).toContainText("Type the model to use with this provider");
    await quiet(page);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBe(AI_FILE);

    // With a model the pair is a default of the file, and it is written.
    await model.fill("big");
    await expect(model).not.toHaveAttribute("aria-invalid", "true");
    await expect.poll(() => saves(page)).toBe(1);
    expect(await configText(page)).toMatch(
      /"explain": \{[^}]*"provider": "work"[^}]*"model": "big"/,
    );
    // Emptied again, the model is refused once more, and the file keeps the pair it has.
    await model.fill("");
    await expect(model).toHaveAttribute("aria-invalid", "true");
    await quiet(page);
    expect(await saves(page)).toBe(1);
    await closeSettings(page);
    expect(await configText(page)).toMatch(
      /"explain": \{[^}]*"provider": "work"[^}]*"model": "big"/,
    );
  });

  test("emptying a function takes it out of the file and leaves the rest", async ({ page }) => {
    const file = AI_FILE.replace(
      "  ],\n  },",
      `  ],
    "enabled": true,
    "defaults": {
      "ask": { "provider": "work", "model": "big" }, // the big one
      "command": { "provider": "ollama", "model": "llama3" },
    },
  },`,
    );
    await start(page, file);
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    await expect(ai.getByLabel("Ask provider", { exact: true })).toHaveValue("work");
    await ai.getByLabel("Command provider", { exact: true }).selectOption("");
    await textbox(ai, "Command model").fill("");
    await closeSettings(page);

    const text = await configText(page);
    expect(text).not.toContain('"command"');
    expect(text).toContain('"ask": { "provider": "work", "model": "big" }, // the big one');
    expect(text).toContain("// The AI stays off until I say so.");
    expect(text).toContain('"enabled": true');
  });
});

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

// The settings screen: appearance and layout, terminal, profiles, shortcuts, notifications,
// auto-archive and AI. It is opened from the
// title bar and from the palette, edits are a draft until Save, and Save writes only the settings
// that changed into `config.jsonc` (the web build keeps that text under `noren.web.config`), with
// the comments of the file in place. The interface follows the file, so nothing reloads.

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
    for (const name of [
      "Appearance",
      "Terminal",
      "Profiles",
      "Shortcuts",
      "Notifications",
      "Auto-archive",
      "AI",
    ]) {
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
  test("changes the terminal the moment it is saved, and the file keeps its comments", async ({
    page,
  }) => {
    await start(page, TERMINAL_FILE);
    await expect.poll(async () => (await drawing(page))?.fontSize).toBe(16);
    expect((await drawing(page))?.cursorStyle).toBe("bar");
    await markPage(page);

    const screen = await openSettings(page);
    const terminal = section(screen, "Terminal");
    // The screen shows what the file says, and the defaults for what it does not.
    await expect(textbox(terminal, "Font size (px)")).toHaveValue("16");
    await expect(radio(terminal, "Bar")).toBeChecked();
    await expect(textbox(terminal, "Scrollback (lines)")).toHaveValue("10000");
    await expect(radio(terminal, "Only mark the tab")).toBeChecked();

    await textbox(terminal, "Font size (px)").fill("20");
    await radio(terminal, "Underline").check();
    await checkbox(terminal, "Cursor blinks").uncheck();
    await textbox(terminal, "Scrollback (lines)").fill("500");
    await radio(terminal, "Flash and beep").check();
    // The font comes from the list of monospaced fonts the backend has.
    await terminal
      .getByRole("combobox", { name: "Installed font", exact: true })
      .selectOption("Consolas");
    await expect(textbox(terminal, "Font list")).toHaveValue("Consolas, monospace");
    await saveSettings(page);

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
    expect(await saves(page)).toBe(1);
  });

  test("a value the schema refuses is shown where it is typed and nothing is written", async ({
    page,
  }) => {
    await start(page, TERMINAL_FILE);
    const screen = await openSettings(page);
    const terminal = section(screen, "Terminal");
    const size = textbox(terminal, "Font size (px)");
    await size.fill("500");
    await expect(size).toHaveAttribute("aria-invalid", "true");
    await expect(terminal).toContainText("A number of pixels from 6 to 72.");
    await expect(saveButton(screen)).toBeDisabled();

    await size.fill("18");
    await textbox(terminal, "Line height (1 to 3)").fill("0.5");
    await expect(terminal).toContainText("A number from 1 to 3.");
    await textbox(terminal, "Scrollback (lines)").fill("ten");
    await expect(terminal).toContainText("A whole number of lines, from 0 to 100000.");
    await textbox(terminal, "Font list").fill("url(http://example.com/a.woff)");
    await expect(textbox(terminal, "Font list")).toHaveAttribute("aria-invalid", "true");
    await expect(saveButton(screen)).toBeDisabled();

    await textbox(terminal, "Line height (1 to 3)").fill("1.5");
    await textbox(terminal, "Scrollback (lines)").fill("2000");
    await textbox(terminal, "Font list").fill("Fira Code, monospace");
    await expect(saveButton(screen)).toBeEnabled();
    await cancelSettings(page);
    expect(await saves(page)).toBe(0);
    expect(await configText(page)).toBe(TERMINAL_FILE);
    expect((await drawing(page))?.fontSize).toBe(16);
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
    await saveSettings(page);

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
    await textbox(ops, "Name").fill("Operations");
    await textbox(ops, "Program").fill("fish");
    await argsBox(ops).fill("-l");
    await textbox(ops, "Start folder").fill("/srv");
    await saveSettings(page);

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
    await expect(profile(screen, "Dev Shell")).toHaveCount(0);
    await saveSettings(page);

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

  test("a profile with no name or program is refused on the screen and nothing is written", async ({
    page,
  }) => {
    await start(page, PROFILES_FILE);
    const screen = await openSettings(page);
    await addProfile(screen).click();
    const fresh = profile(screen, "New profile 3");
    await textbox(fresh, "Name").fill("Half done");
    await expect(textbox(fresh, "Program")).toHaveAttribute("aria-invalid", "true");
    await expect(saveButton(screen)).toBeDisabled();
    await textbox(fresh, "Program").fill("zsh");
    await expect(saveButton(screen)).toBeEnabled();
    const opsProgram = textbox(profile(screen, "Ops"), "Program");
    await opsProgram.fill("   ");
    await expect(opsProgram).toHaveAttribute("aria-invalid", "true");
    await expect(saveButton(screen)).toBeDisabled();
    await cancelSettings(page);
    expect(await configText(page)).toBe(PROFILES_FILE);
    expect(await saves(page)).toBe(0);
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
    await saveSettings(page);

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
    await cancelSettings(page);
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
      await expect(saveButton(screen)).toBeDisabled();
    }
    await hours.fill("2");
    await expect(saveButton(screen)).toBeEnabled();
    await cancelSettings(page);
    expect(await configText(page)).toBe(ARCHIVE_FILE);
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
    await provider.selectOption("ollama");
    await textbox(ai, "Ask model").fill("llama3");
    await expect(saveButton(screen)).toBeEnabled();
    await saveSettings(page);

    const text = await configText(page);
    expect(text).toContain("// My Noren settings, keep this line.");
    expect(text).toContain('"notifications": { "enabled": true }, // quiet');
    expect(text).toContain("// The AI stays off until I say so.");
    expect(text).toContain('"id": "work"');
    expect(text).toMatch(/"enabled": true/);
    expect(text).toMatch(/"ask": \{[^}]*"provider": "ollama"[^}]*"model": "llama3"/);
    expect(text).not.toContain('"explain"');
    expect(text).not.toContain('"command"');
    expect(await saves(page)).toBe(1);

    // Opened again, the screen shows what was saved.
    const again = section(await openSettings(page), "AI");
    await expect(checkbox(again, "Turn the AI on")).toBeChecked();
    await expect(again.getByLabel("Ask provider", { exact: true })).toHaveValue("ollama");
    await expect(textbox(again, "Ask model")).toHaveValue("llama3");
    await expect(again.getByLabel("Explain provider", { exact: true })).toHaveValue("");
    await cancelSettings(page);
  });

  test("a provider with no model is refused where it is typed, and nothing is written", async ({
    page,
  }) => {
    await start(page, AI_FILE);
    const screen = await openSettings(page);
    const ai = section(screen, "AI");
    await ai.getByLabel("Explain provider", { exact: true }).selectOption("work");
    const model = textbox(ai, "Explain model");
    await expect(model).toHaveAttribute("aria-invalid", "true");
    await expect(ai).toContainText("Type the model to use with this provider");
    await expect(saveButton(screen)).toBeDisabled();

    await model.fill("big");
    await expect(model).not.toHaveAttribute("aria-invalid", "true");
    await expect(saveButton(screen)).toBeEnabled();
    await model.fill("");
    await expect(saveButton(screen)).toBeDisabled();
    await cancelSettings(page);
    expect(await configText(page)).toBe(AI_FILE);
    expect(await saves(page)).toBe(0);
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
    await saveSettings(page);

    const text = await configText(page);
    expect(text).not.toContain('"command"');
    expect(text).toContain('"ask": { "provider": "work", "model": "big" }, // the big one');
    expect(text).toContain("// The AI stays off until I say so.");
    expect(text).toContain('"enabled": true');
  });
});

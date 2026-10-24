import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  JSON_SETTINGS,
  KEY_VALUE_LAGOON,
  NOT_A_SCHEME,
  PLIST_BINARY,
  PLIST_LAGOON,
  PLIST_MISSING_COLOR,
} from "../packages/model/src/import-fixtures";
import { configText, seedConfig, withoutAlpha } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// "Import color scheme..." in the palette: the person picks a file, the importers read it by what
// is in it (an XML property list, JSON with comments, or `key = value` text, with or without an
// extension), each scheme is written as a file of the themes folder (the web build keeps those
// under `noren.web.themes`) and joins the list of themes, the global theme and the theme of a
// space included. A file that is not a scheme warns and writes nothing.

interface Hook {
  configSaves(): number;
  paneIds(): string[];
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

/** Key of the theme files of the user in the browser storage, in the web build. */
const WEB_THEMES_KEY = "noren.web.themes";

// The colors of the themes used below. "Lagoon" is the scheme of the fixtures
// (packages/model/src/import-fixtures.ts); the interface colors of an imported theme are derived
// from its terminal colors, and its text and accent come out as the scheme's own.
const DUSK = { bg: "#14161b", terminal: "rgb(20, 22, 27)" };
const LAGOON = {
  bg: "#101820",
  text: "#d6e2ee",
  accent: "#5aa3e8",
  terminal: "rgb(16, 24, 32)",
};

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
/** The background of the terminal on screen (xterm sets it on its scrollable element). */
const terminalBackground = (page: Page): Promise<string> =>
  page
    .evaluate(() => {
      const visible = [...document.querySelectorAll<HTMLElement>(".xterm-scrollable-element")].find(
        (element) => element.getClientRects().length > 0 && element.offsetParent !== null,
      );
      return visible === undefined ? "" : getComputedStyle(visible).backgroundColor;
    })
    .then(withoutAlpha);

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
/** The file input the action clicks; always in the page, hidden. */
const fileInput = (page: Page): Locator =>
  page.locator('input[type="file"][data-nr-part="scheme-file"]');

const savedThemes = (page: Page): Promise<Record<string, string> | null> =>
  page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as Record<string, string>);
  }, WEB_THEMES_KEY);

const saves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? 0);

async function start(page: Page, config: string | null = null): Promise<void> {
  if (config !== null) await seedConfig(page, config);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  // Marks this document: it is gone if the page reloads.
  await page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
}

async function openPalette(page: Page): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
}

/** Runs "Import color scheme..." from the palette and answers the file picker with `file`. */
async function importThrough(page: Page, file: { name: string; text: string }): Promise<void> {
  // Heard from before the palette opens: Playwright turns the interception of the picker on
  // asynchronously, and a picker opened by the Enter that is already on its way would be missed.
  const chooser = page.waitForEvent("filechooser");
  await openPalette(page);
  await box(page).fill(">import color scheme");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first().locator(".palette-title")).toHaveText(
    "Import color scheme...",
  );
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await (
    await chooser
  ).setFiles({
    name: file.name,
    mimeType: "application/octet-stream",
    buffer: Buffer.from(file.text, "utf8"),
  });
}

/** Types in the palette until exactly one theme entry is listed (the first one is highlighted). */
async function findTheme(page: Page, text: string): Promise<void> {
  await openPalette(page);
  await box(page).fill(`>${text}`);
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "theme");
}

async function expectLagoon(page: Page): Promise<void> {
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(LAGOON.bg);
  expect(await rootVar(page, "--nr-text")).toBe(LAGOON.text);
  expect(await rootVar(page, "--nr-accent")).toBe(LAGOON.accent);
  await expect.poll(() => terminalBackground(page)).toBe(LAGOON.terminal);
}

test.use({ colorScheme: "dark" });

test("importing a plist color scheme from the palette adds it to the list of themes, and applying it changes the colors", async ({
  page,
}) => {
  await start(page);
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK.bg);

  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toHaveText(
    'Imported color scheme "Lagoon". Pick it with "Theme: Lagoon" in the command palette.',
  );
  // Importing is not applying: the window is as it was.
  expect(await rootVar(page, "--nr-bg")).toBe(DUSK.bg);

  // The theme is a file of the themes folder, valid and with an id that is a slug of its name.
  const files = await savedThemes(page);
  expect(Object.keys(files ?? {})).toEqual(["lagoon"]);
  const written = JSON.parse(files?.["lagoon"] ?? "null") as {
    id: string;
    name: string;
    kind: string;
    terminal: { background: string; ansi: string[] };
  };
  expect(written).toMatchObject({ id: "lagoon", name: "Lagoon", kind: "dark" });
  expect(written.terminal.background).toBe(LAGOON.bg);
  expect(written.terminal.ansi).toHaveLength(16);

  // It is on the list of themes, after the built-in ones, and highlighting it previews it.
  await openPalette(page);
  await box(page).fill(">theme");
  const titles = await palette(page)
    .locator('[data-nr-kind="theme"] .palette-title')
    .allTextContents();
  expect(titles).toEqual([
    "Theme: Noren Dusk",
    "Theme: Noren Paper",
    "Theme: Noren Nightshade",
    "Theme: Noren Fjord",
    "Theme: Noren Midnight",
    "Theme: Noren Meadow",
    "Theme: Noren Dune",
    "Theme: Noren Oat",
    "Theme: Lagoon",
    "Follow system theme",
  ]);
  await box(page).fill(">theme: lagoon");
  await expect(options(page)).toHaveCount(1);
  await expectLagoon(page);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();

  // Applied: it is the global theme, written to the file, with no reload.
  await expectLagoon(page);
  expect(await configText(page)).toContain('"theme": "lagoon"');
  expect(await page.evaluate(() => (window as HookWindow).__stillHere)).toBe(true);

  // And it is still the theme after a reload: the file, and the theme file, are kept.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  await expectLagoon(page);
});

test("importing writes nothing to config.jsonc", async ({ page }) => {
  await start(page, '// mine\n{ "notifications": { "enabled": true } }\n');
  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon"');
  expect(await saves(page)).toBe(0);
  expect(await configText(page)).toBe('// mine\n{ "notifications": { "enabled": true } }\n');
});

test("a file that is not a scheme warns and writes nothing", async ({ page }) => {
  await start(page);

  await importThrough(page, { name: "Broken.itermcolors", text: PLIST_MISSING_COLOR });
  await expect(notice(page)).toHaveText(
    'Could not import "Broken.itermcolors": "Ansi 3 Color" is missing',
  );
  expect(await savedThemes(page)).toBeNull();

  await importThrough(page, { name: "notes.txt", text: NOT_A_SCHEME });
  await expect(notice(page)).toContainText(
    'Could not import "notes.txt": This file is not a color scheme',
  );
  expect(await savedThemes(page)).toBeNull();

  await importThrough(page, { name: "binary.itermcolors", text: PLIST_BINARY });
  await expect(notice(page)).toContainText("binary property list");
  expect(await savedThemes(page)).toBeNull();

  // Nothing was added to the list, and the window is as it was.
  await openPalette(page);
  await box(page).fill(">theme");
  await expect(palette(page).locator('[data-nr-kind="theme"]')).toHaveCount(9);
  expect(await rootVar(page, "--nr-bg")).toBe(DUSK.bg);
  expect(await saves(page)).toBe(0);
});

test("a key = value file with no extension is read by what is in it", async ({ page }) => {
  await start(page);
  await importThrough(page, { name: "lagoon-night", text: KEY_VALUE_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "lagoon-night"');
  expect(Object.keys((await savedThemes(page)) ?? {})).toEqual(["lagoon-night"]);

  await findTheme(page, "theme: lagoon-night");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expectLagoon(page);
});

test("a JSON file with comments imports its valid schemes; a name taken by a built-in theme gets a number", async ({
  page,
}) => {
  await start(page);
  await importThrough(page, { name: "settings.json", text: JSON_SETTINGS });
  await expect(notice(page)).toContainText('Imported 2 color schemes: "Lagoon", "Noren Dusk (2)"');
  await expect(notice(page)).toContainText('Left out: Scheme "Broken": "red" is missing');
  expect(Object.keys((await savedThemes(page)) ?? {}).sort()).toEqual(["lagoon", "noren-dusk-2"]);

  // The built-in theme keeps its own entry; the imported one sits beside it with its own.
  await openPalette(page);
  await box(page).fill(">theme: noren dusk");
  await expect(options(page)).toHaveCount(2);
  const titles = await palette(page).locator(".palette-title").allTextContents();
  expect(titles).toEqual(["Theme: Noren Dusk", "Theme: Noren Dusk (2)"]);
});

test("importing the same file again makes a second theme with a number, and the picker takes the same file twice", async ({
  page,
}) => {
  await start(page);
  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon".');

  // The input is always in the page, so the file can also be given to it directly.
  await expect(fileInput(page)).toHaveCount(1);
  await fileInput(page).setInputFiles({
    name: "Lagoon.itermcolors",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(PLIST_LAGOON, "utf8"),
  });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon (2)"');
  expect(Object.keys((await savedThemes(page)) ?? {}).sort()).toEqual(["lagoon", "lagoon-2"]);
});

test("an imported theme can be the theme of a space, in the menu and by Set theme for this space", async ({
  page,
}) => {
  await start(page);
  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon"');

  // By the palette: the list of the space has the eight themes, the imported one and Use global theme.
  await openPalette(page);
  await box(page).fill(">set theme for this space");
  await expect(options(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette(page).locator('[data-nr-kind="space-theme"]')).toHaveCount(10);
  await box(page).fill("lagoon");
  await expect(options(page)).toHaveCount(1);
  await expectLagoon(page);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expectLagoon(page);
  // It is the theme of the space, not the global one: the file was not written.
  expect(await saves(page)).toBe(0);

  // By the menu of the space.
  await page.getByRole("button", { name: "Main", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Main options", exact: true });
  const labels = (await menu.getByRole("menuitemradio").allTextContents()).map((label) =>
    label.replace(/^[✓\s]+/, "").trim(),
  );
  expect(labels).toEqual([
    "Noren Dusk",
    "Noren Paper",
    "Noren Nightshade",
    "Noren Fjord",
    "Noren Midnight",
    "Noren Meadow",
    "Noren Dune",
    "Noren Oat",
    "Lagoon",
    "Use global theme",
  ]);
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveText(/Lagoon/);
});

test("theme files the user placed are on the list; invalid ones and ones that take a built-in id are ignored", async ({
  page,
}) => {
  // Import one theme through the app, then replace the theme files with a set that has some that
  // must be ignored, and reload: the web build reads the files again at the start.
  await start(page);
  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon"');
  const asTheme = JSON.parse((await savedThemes(page))?.["lagoon"] ?? "null") as Record<
    string,
    unknown
  >;
  const seed = {
    bay: JSON.stringify({ ...asTheme, id: "bay", name: "Bay" }),
    "noren-dusk": JSON.stringify({ ...asTheme, id: "noren-dusk", name: "Not Dusk" }),
    "not-json": "{ this is not json",
    "no-ansi": JSON.stringify({ ...asTheme, id: "no-ansi", terminal: { foreground: "#ffffff" } }),
  };
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
    key: WEB_THEMES_KEY,
    value: JSON.stringify(seed),
  });
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);

  await openPalette(page);
  await box(page).fill(">theme");
  const titles = await palette(page)
    .locator('[data-nr-kind="theme"] .palette-title')
    .allTextContents();
  expect(titles).toEqual([
    "Theme: Noren Dusk",
    "Theme: Noren Paper",
    "Theme: Noren Nightshade",
    "Theme: Noren Fjord",
    "Theme: Noren Midnight",
    "Theme: Noren Meadow",
    "Theme: Noren Dune",
    "Theme: Noren Oat",
    "Theme: Bay",
    "Follow system theme",
  ]);
});

test("the settings file can name a theme of the user as the global theme", async ({ page }) => {
  await start(page);
  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon"');

  // The file names the theme: the window changes to it with no reload, and keeps it after one.
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig('{ "appearance": { "theme": "lagoon" } }\n'),
  );
  await expectLagoon(page);
  await page.reload();
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(LAGOON.bg);
  expect(await rootVar(page, "--nr-text")).toBe(LAGOON.text);
});

test("a theme the settings name applies as soon as the theme exists, and not before", async ({
  page,
}) => {
  await start(page, '{ "appearance": { "theme": "lagoon" } }\n');
  // No theme has that id yet: the system's theme shows.
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK.bg);
  await importThrough(page, { name: "Lagoon.itermcolors", text: PLIST_LAGOON });
  await expect(notice(page)).toContainText('Imported color scheme "Lagoon"');
  await expectLagoon(page);
});

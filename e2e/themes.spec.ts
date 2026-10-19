import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { configText, seedConfig } from "./settings-fixture";

// The global theme: eight built-in themes, picked in the command palette, saved as
// `appearance.theme` in `config.jsonc` (the web build keeps that text under `noren.web.config`)
// with the comments of the file in place, and shown at once with no reload. The theme highlighted
// in the list is a live preview: Escape puts the saved theme back, Enter saves.

interface Hook {
  setConfig(text: string | null): void;
  failConfigSaves(message: string | null): void;
  configSaves(): number;
  paneIds(): string[];
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

// The colors of the themes used below (packages/model/src/builtin-themes.ts).
const DUSK = { bg: "#14161b", text: "#e6e6e6", terminal: "rgb(20, 22, 27)" };
const PAPER = { bg: "#f6f3ec", text: "#23262d", terminal: "rgb(246, 243, 236)" };
const FJORD = { bg: "#2e3440", text: "#d8dee9", terminal: "rgb(46, 52, 64)" };
const NIGHTSHADE = { bg: "#282a36", text: "#f8f8f2", terminal: "rgb(40, 42, 54)" };
const OAT = { bg: "#eff1f5", text: "#4c4f69", terminal: "rgb(239, 241, 245)" };

/** A settings file with comments, as a person writes it. */
const COMMENTED = `// My Noren settings, keep this line.
{
  "appearance": {
    "density": "comfortable", // I like it roomy
  },
  /* quiet */
  "notifications": { "enabled": true },
}
`;

const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
/** The color the terminal paints its background with (xterm sets it on its scrollable element). */
const terminalBackground = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".xterm-scrollable-element");
    return viewport === null ? "" : getComputedStyle(viewport).backgroundColor;
  });

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const themeOptions = (page: Page): Locator => palette(page).locator('[data-nr-kind="theme"]');
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');

async function start(page: Page, file: string | null = COMMENTED): Promise<void> {
  if (file !== null) await seedConfig(page, file);
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
  // Marks this document: it is gone if the page reloads.
  await page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
}

const samePage = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as HookWindow).__stillHere);

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
}

/** Types in the palette until exactly one theme entry is listed, and leaves it highlighted. */
async function findTheme(page: Page, text: string): Promise<void> {
  await box(page).fill(`>${text}`);
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "theme");
}

async function expectTheme(
  page: Page,
  theme: { bg: string; text: string; terminal: string },
): Promise<void> {
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(theme.bg);
  expect(await rootVar(page, "--nr-text")).toBe(theme.text);
  await expect.poll(() => terminalBackground(page)).toBe(theme.terminal);
}

test.use({ colorScheme: "dark" });

test("the palette lists the eight themes and the choice to follow the system", async ({ page }) => {
  await start(page);
  await openPalette(page);
  await box(page).fill(">theme");
  await expect(themeOptions(page)).toHaveCount(9);
  const titles = await themeOptions(page).locator(".palette-title").allTextContents();
  expect(titles).toEqual([
    "Theme: Noren Dusk",
    "Theme: Noren Paper",
    "Theme: Noren Nightshade",
    "Theme: Noren Fjord",
    "Theme: Noren Midnight",
    "Theme: Noren Meadow",
    "Theme: Noren Dune",
    "Theme: Noren Oat",
    "Follow system theme",
  ]);
  // No theme is chosen in the file, so the system is the choice in use, and the list says so.
  await expect(themeOptions(page).first()).not.toContainText("in use");
  await expect(themeOptions(page).last()).toContainText("In use");
});

test("picking a theme changes the colors without a reload and writes appearance.theme, keeping the comments", async ({
  page,
}) => {
  await start(page);
  await expectTheme(page, DUSK);

  await openPalette(page);
  await findTheme(page, "theme: noren fjord");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();

  await expectTheme(page, FJORD);
  expect(await samePage(page)).toBe(true);
  // Only the new setting was added, in the order of the schema (the theme comes first).
  expect(await configText(page)).toBe(`// My Noren settings, keep this line.
{
  "appearance": {
    "theme": "noren-fjord",
    "density": "comfortable", // I like it roomy
  },
  /* quiet */
  "notifications": { "enabled": true },
}
`);

  // The choice is in the file, so it survives a reload and wins over the (dark) system scheme.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBe(1);
  await expectTheme(page, FJORD);
});

test("picking another theme replaces only the value in the file", async ({ page }) => {
  await start(
    page,
    '{ "appearance": { "theme": "noren-fjord" /* mine */, "density": "compact" } }\n',
  );
  await expectTheme(page, FJORD);
  await openPalette(page);
  await findTheme(page, "theme: noren oat");
  await page.keyboard.press("Enter");
  await expectTheme(page, OAT);
  expect(await configText(page)).toBe(
    '{ "appearance": { "theme": "noren-oat" /* mine */, "density": "compact" } }\n',
  );
});

test("the highlighted theme previews at once, and Escape puts the saved theme back without writing", async ({
  page,
}) => {
  await start(page);
  await openPalette(page);
  await findTheme(page, "theme: noren paper");

  // Highlighted but not chosen: the whole window shows it already.
  await expectTheme(page, PAPER);
  expect(await configText(page)).toBe(COMMENTED);
  expect(await page.evaluate(() => (window as HookWindow).__norenTest?.configSaves())).toBe(0);

  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expectTheme(page, DUSK);
  expect(await configText(page)).toBe(COMMENTED);
  expect(await page.evaluate(() => (window as HookWindow).__norenTest?.configSaves())).toBe(0);
  expect(await samePage(page)).toBe(true);
});

test("a click outside the palette also drops the preview", async ({ page }) => {
  await start(page);
  await openPalette(page);
  await findTheme(page, "theme: noren meadow");
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe("#2d353b"); // Noren Meadow
  await page.mouse.click(5, 5);
  await expect(palette(page)).toBeHidden();
  await expectTheme(page, DUSK);
  expect(await configText(page)).toBe(COMMENTED);
});

test("the arrows move the preview from one theme to the next, and the saved one is the one chosen", async ({
  page,
}) => {
  await start(page);
  await openPalette(page);
  await box(page).fill(">theme");
  await expect(themeOptions(page)).toHaveCount(9);
  // The list starts with two actions: "Set theme for this space", highlighted, and "Import color
  // scheme..." (which has the letters of "theme" spread out in its title). They are not themes, so
  // the saved one shows. The first theme (the one in use) comes right after them.
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "action");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(options(page).nth(1)).toHaveAttribute("data-nr-kind", "action");
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK.bg);

  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expectTheme(page, DUSK);

  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await expectTheme(page, DUSK);

  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(3)).toHaveAttribute("aria-selected", "true");
  await expectTheme(page, PAPER);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(5)).toHaveAttribute("aria-selected", "true");
  await expectTheme(page, FJORD);

  await page.keyboard.press("ArrowUp");
  await expectTheme(page, NIGHTSHADE);

  // Nothing was written yet; Enter writes the one highlighted.
  expect(await configText(page)).toBe(COMMENTED);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  expect(await rootVar(page, "--nr-bg")).toBe(NIGHTSHADE.bg);
  expect(await configText(page)).toContain('"theme": "noren-nightshade"');
});

test("moving the highlight to something that is not a theme puts the saved theme back", async ({
  page,
}) => {
  await start(page);
  await openPalette(page);
  await findTheme(page, "theme: noren paper");
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(PAPER.bg);
  await box(page).fill(">new tab");
  await expect(options(page).first()).toContainText("New tab");
  await expectTheme(page, DUSK);
});

test("Follow system theme is written as system and the theme follows the color scheme again", async ({
  page,
}) => {
  await start(page, '{ "appearance": { "theme": "noren-paper" } }\n');
  await expectTheme(page, PAPER);
  await openPalette(page);
  await findTheme(page, "follow system");
  await page.keyboard.press("Enter");
  await expectTheme(page, DUSK);
  expect(await configText(page)).toBe('{ "appearance": { "theme": "system" } }\n');
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(PAPER.bg);
});

test("with no choice in the file nothing is written for Follow system theme", async ({ page }) => {
  await start(page);
  await openPalette(page);
  await findTheme(page, "follow system");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  expect(await configText(page)).toBe(COMMENTED);
  expect(await page.evaluate(() => (window as HookWindow).__norenTest?.configSaves())).toBe(0);
});

test("a change of appearance.theme made in the file shows with no reload", async ({ page }) => {
  await start(page);
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig('{ "appearance": { "theme": "noren-oat" } }'),
  );
  await expectTheme(page, OAT);
  await page.evaluate(() => (window as HookWindow).__norenTest?.setConfig("{}"));
  await expectTheme(page, DUSK);
  // A value that is not a valid id keeps the last good theme and shows the usual notice.
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig('{ "appearance": { "theme": "Not An Id" } }'),
  );
  await expect(page.locator('[data-nr-part="config-notice"]')).toContainText("appearance.theme");
  await expectTheme(page, DUSK);
  expect(await samePage(page)).toBe(true);
});

test("a file with a problem of its own is not edited: the notice says so and the theme stays", async ({
  page,
}) => {
  const broken = '{ "appearance": { "tabs": "sideways" } }\n';
  await start(page, broken);
  await openPalette(page);
  await findTheme(page, "theme: noren fjord");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(notice(page)).toContainText(/settings file/i);
  await expectTheme(page, DUSK);
  expect(await configText(page)).toBe(broken);
});

test("a failed write keeps the saved theme and says why", async ({ page }) => {
  await start(page);
  await page.evaluate(() => (window as HookWindow).__norenTest?.failConfigSaves("disk full"));
  await openPalette(page);
  await findTheme(page, "theme: noren fjord");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText("disk full");
  await expectTheme(page, DUSK);
  expect(await configText(page)).toBe(COMMENTED);
});

test("the choice made before the settings file moves into it once, and the old key goes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("noren.web.config") === null) {
      window.localStorage.setItem("noren.ui.theme", JSON.stringify({ id: "noren-oat" }));
    }
  });
  await seedConfig(page, COMMENTED);
  await start(page, null);
  await expectTheme(page, OAT);
  expect(await configText(page)).toContain('"theme": "noren-oat"');
  expect(await configText(page)).toContain("// I like it roomy");
  expect(await page.evaluate(() => window.localStorage.getItem("noren.ui.theme"))).toBeNull();
});

test("the old choice does not override a theme the file already names", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("noren.ui.theme", JSON.stringify({ id: "noren-oat" }));
  });
  await start(page, '{ "appearance": { "theme": "noren-fjord" } }\n');
  await expectTheme(page, FJORD);
  expect(await configText(page)).toBe('{ "appearance": { "theme": "noren-fjord" } }\n');
  expect(await page.evaluate(() => window.localStorage.getItem("noren.ui.theme"))).toBeNull();
});

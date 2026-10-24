import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { configText, seedConfig, withoutAlpha } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The theme of a space: a space can have its own theme, which shows while it is the active space;
// with none, the global theme (`appearance.theme` of the file, else the system's) shows. It is
// chosen in the menu of the space or by "Set theme for this space" in the palette, and it lives in
// `state.json` (the web build keeps that in the browser storage), not in `config.jsonc`.

interface Hook {
  configSaves(): number;
  paneIds(): string[];
}
type HookWindow = Window & { __norenTest?: Hook; __stillHere?: boolean };

// The colors of the themes used below (packages/model/src/builtin-themes.ts).
const DUSK = { bg: "#14161b", text: "#e6e6e6", terminal: "rgb(20, 22, 27)" };
const PAPER = { bg: "#f6f3ec", text: "#23262d", terminal: "rgb(246, 243, 236)" };
const FJORD = { bg: "#2e3440", text: "#d8dee9", terminal: "rgb(46, 52, 64)" };
const OAT = { bg: "#eff1f5", text: "#4c4f69", terminal: "rgb(239, 241, 245)" };

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

const switcher = (page: Page): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string): Locator =>
  switcher(page).getByRole("button", { name, exact: true });
const menu = (page: Page, spaceName: string): Locator =>
  page.getByRole("menu", { name: `${spaceName} options`, exact: true });
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const box = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });

async function expectTheme(
  page: Page,
  theme: { bg: string; text: string; terminal: string },
): Promise<void> {
  await expect.poll(() => rootVar(page, "--nr-bg")).toBe(theme.bg);
  expect(await rootVar(page, "--nr-text")).toBe(theme.text);
  await expect.poll(() => terminalBackground(page)).toBe(theme.terminal);
}

async function waitForPane(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0))
    .toBeGreaterThan(0);
}

/** Two spaces, "Main" and "Work", with "Work" active. */
async function start(page: Page, file: string | null = null): Promise<void> {
  if (file !== null) await seedConfig(page, file);
  await page.goto("/");
  await waitForPane(page);
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Work");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, "Work")).toHaveAttribute("data-nr-state", "active");
  await page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
}

async function openMenu(page: Page, spaceName: string): Promise<void> {
  await spaceButton(page, spaceName).click({ button: "right" });
  await expect(menu(page, spaceName)).toBeVisible();
}

/** Picks a theme (or "Use global theme") in the menu of a space. */
async function pickInMenu(page: Page, spaceName: string, label: string): Promise<void> {
  await openMenu(page, spaceName);
  await menu(page, spaceName).getByRole("menuitemradio", { name: label, exact: true }).click();
  await expect(menu(page, spaceName)).toBeHidden();
}

/** The label of the option the menu of the space marks as in use. */
async function checkedInMenu(page: Page, spaceName: string): Promise<string> {
  await openMenu(page, spaceName);
  const checked = menu(page, spaceName).locator('[role="menuitemradio"][aria-checked="true"]');
  await expect(checked).toHaveCount(1);
  const label = (await checked.textContent()) ?? "";
  await page.keyboard.press("Escape");
  await expect(menu(page, spaceName)).toBeHidden();
  return label.replace(/^[✓\s]+/, "").trim();
}

async function openPalette(page: Page): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
}

/** Opens the list of "Set theme for this space" from the palette. */
async function openSpaceThemes(page: Page): Promise<void> {
  await openPalette(page);
  await box(page).fill(">set theme for this space");
  await expect(options(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette(page).locator('[data-nr-kind="space-theme"]')).toHaveCount(9);
}

const saves = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.configSaves() ?? 0);

test.use({ colorScheme: "dark" });

test("a theme given to a space shows when it is active, and the other spaces keep the global one", async ({
  page,
}) => {
  await start(page);
  await expectTheme(page, DUSK);

  await pickInMenu(page, "Work", "Noren Paper");
  await expectTheme(page, PAPER);

  // Back to the first space: the global theme (here the system's, dark), the terminals too.
  await spaceButton(page, "Main").click();
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expectTheme(page, DUSK);

  await spaceButton(page, "Work").click();
  await expectTheme(page, PAPER);

  // Without reloading, and nothing went to config.jsonc.
  expect(await page.evaluate(() => (window as HookWindow).__stillHere)).toBe(true);
  expect(await saves(page)).toBe(0);
});

test("Use global theme takes the theme of the space back", async ({ page }) => {
  await start(page);
  await pickInMenu(page, "Work", "Noren Oat");
  await expectTheme(page, OAT);
  expect(await checkedInMenu(page, "Work")).toBe("Noren Oat");

  await pickInMenu(page, "Work", "Use global theme");
  await expectTheme(page, DUSK);
  expect(await checkedInMenu(page, "Work")).toBe("Use global theme");
  expect(await checkedInMenu(page, "Main")).toBe("Use global theme");
});

test("the menu of a space lists the eight themes and Use global theme", async ({ page }) => {
  await start(page);
  await openMenu(page, "Work");
  const labels = await menu(page, "Work").getByRole("menuitemradio").allTextContents();
  expect(labels.map((label) => label.replace(/^[✓\s]+/, "").trim())).toEqual([
    "Noren Dusk",
    "Noren Paper",
    "Noren Nightshade",
    "Noren Fjord",
    "Noren Midnight",
    "Noren Meadow",
    "Noren Dune",
    "Noren Oat",
    "Use global theme",
  ]);
});

test("the theme of a space survives a reload (it is saved in state.json)", async ({ page }) => {
  await start(page);
  await pickInMenu(page, "Work", "Noren Fjord");
  await expectTheme(page, FJORD);

  await page.reload();
  await waitForPane(page);
  await expect(spaceButton(page, "Work")).toHaveAttribute("data-nr-state", "active");
  await expectTheme(page, FJORD);
  await spaceButton(page, "Main").click();
  await expectTheme(page, DUSK);
  expect(await checkedInMenu(page, "Work")).toBe("Noren Fjord");
});

test("a space theme wins over the global theme of the file, which the other spaces follow", async ({
  page,
}) => {
  await start(page, '{ "appearance": { "theme": "noren-paper" } }\n');
  await expectTheme(page, PAPER);
  await pickInMenu(page, "Work", "Noren Fjord");
  await expectTheme(page, FJORD);

  // The global theme changes in the file: the space with its own theme does not move.
  await openPalette(page);
  await box(page).fill(">theme: noren oat");
  await expect(options(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expectTheme(page, FJORD);
  expect(await configText(page)).toContain('"theme": "noren-oat"');

  await spaceButton(page, "Main").click();
  await expectTheme(page, OAT);
});

test("Set theme for this space lists the themes of the space, previews the highlighted one and Enter saves it in the space", async ({
  page,
}) => {
  await start(page);
  await openSpaceThemes(page);

  await box(page).fill("noren fjord");
  await expect(options(page)).toHaveCount(1);
  // Highlighted, not chosen: the whole window shows it already.
  await expectTheme(page, FJORD);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expectTheme(page, FJORD);
  expect(await checkedInMenu(page, "Work")).toBe("Noren Fjord");

  await spaceButton(page, "Main").click();
  await expectTheme(page, DUSK);
  expect(await saves(page)).toBe(0);
});

test("Escape in the list of Set theme for this space puts the theme back and saves nothing", async ({
  page,
}) => {
  await start(page);
  await pickInMenu(page, "Work", "Noren Oat");
  await expectTheme(page, OAT);

  await openSpaceThemes(page);
  await box(page).fill("noren fjord");
  await expect(options(page)).toHaveCount(1);
  await expectTheme(page, FJORD);

  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  await expectTheme(page, OAT);
  expect(await checkedInMenu(page, "Work")).toBe("Noren Oat");

  // A space with no theme of its own goes back to the global one the same way.
  await spaceButton(page, "Main").click();
  await openSpaceThemes(page);
  await box(page).fill("noren paper");
  await expect(options(page)).toHaveCount(1);
  await expectTheme(page, PAPER);
  await page.keyboard.press("Escape");
  await expectTheme(page, DUSK);
  expect(await checkedInMenu(page, "Main")).toBe("Use global theme");
});

test("Use global theme in the palette clears the theme of the space", async ({ page }) => {
  await start(page);
  await pickInMenu(page, "Work", "Noren Paper");
  await expectTheme(page, PAPER);

  await openSpaceThemes(page);
  await box(page).fill("use global theme");
  await expect(options(page)).toHaveCount(1);
  // The preview of "Use global theme" is what the space would show with none.
  await expectTheme(page, DUSK);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expectTheme(page, DUSK);
  expect(await checkedInMenu(page, "Work")).toBe("Use global theme");
});

test("a theme of a later build in state.json falls to the global theme", async ({ page }) => {
  await start(page);
  await pickInMenu(page, "Work", "Noren Paper");
  await expectTheme(page, PAPER);
  // The next page load finds the space naming a theme this build does not have. The old page
  // writes its state when it goes away, so the change is made before the new page starts.
  await page.addInitScript(() => {
    const value = localStorage.getItem("noren.web.state");
    if (value !== null) {
      localStorage.setItem(
        "noren.web.state",
        value.replace(/"themeId":s*"noren-paper"/, '"themeId":"nope"'),
      );
    }
  });
  await page.reload();
  await waitForPane(page);
  await expect(spaceButton(page, "Work")).toHaveAttribute("data-nr-state", "active");
  await expectTheme(page, DUSK);
  expect(await checkedInMenu(page, "Work")).toBe("Use global theme");
});

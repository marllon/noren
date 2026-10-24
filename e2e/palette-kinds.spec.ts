import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";
import { openCommandPalette } from "./palette-fixture";

// The palette entries for shell profiles, recent folders (from OSC 7) and themes.

type Start = { profileId?: string; cwd?: string };
type TestHook = { paneIds(): string[]; sessionStarts(): Start[] };
type TestWindow = Window & { __norenTest?: TestHook };

const DUSK_BG = "#14161b";
const PAPER_BG = "#f6f3ec";

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);
const sessionStarts = (page: Page): Promise<Start[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.sessionStarts() ?? []);
const rootVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

const tabList = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const ofKind = (page: Page, kind: string): Locator =>
  palette(page).locator(`[data-nr-kind="${kind}"]`);

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

async function openPalette(page: Page): Promise<void> {
  await openCommandPalette(page);
  await expect(palette(page)).toBeVisible();
}

/** Types a command into the focused terminal and waits for the next prompt to report back. */
async function typeCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

const SEED_PROFILES = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "pwsh", name: "PowerShell", default: false },
];

test("a profile entry opens a new tab that starts that profile", async ({ page }) => {
  await page.addInitScript((profiles) => {
    window.localStorage.setItem("noren.web.profiles", JSON.stringify(profiles));
  }, SEED_PROFILES);
  await openApp(page);
  await expect(tabList(page).getByRole("treeitem")).toHaveCount(1);

  await openPalette(page);
  // One entry per profile, listed without a prefix and under >.
  await expect(ofKind(page, "profile")).toHaveCount(2);
  await page.keyboard.type(">powershell");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "profile");
  await expect(options(page).first()).toContainText("New PowerShell tab");
  await page.keyboard.press("Enter");

  await expect(palette(page)).toBeHidden();
  await expect(tabList(page).getByRole("treeitem")).toHaveCount(2);
  await expect
    .poll(async () => (await sessionStarts(page)).map((start) => start.profileId))
    .toContain("pwsh");
  // The new tab is the one on screen and holds the keyboard.
  await expect(page.locator("textarea.xterm-helper-textarea:focus")).toHaveCount(1);
});

test("a profile entry also works with the single profile of the machine", async ({ page }) => {
  await openApp(page);
  await openPalette(page);
  await page.keyboard.type("new fake");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "profile");
  await page.keyboard.press("Enter");
  await expect(tabList(page).getByRole("treeitem")).toHaveCount(2);
});

test.describe("themes", () => {
  test.use({ colorScheme: "dark" });

  test("a theme entry applies the theme, survives a reload and Follow system theme undoes it", async ({
    page,
  }) => {
    await openApp(page);
    expect(await rootVar(page, "--nr-bg")).toBe(DUSK_BG);

    await openPalette(page);
    // The eight themes and the choice to follow the system.
    await expect(ofKind(page, "theme")).toHaveCount(9);
    await page.keyboard.type("paper");
    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toHaveAttribute("data-nr-kind", "theme");
    await page.keyboard.press("Enter");
    await expect(palette(page)).toBeHidden();
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(PAPER_BG);
    // The terminal repaints with it too (the page behind is the light theme's).
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(246, 243, 236)",
    );

    // The system stays dark but the choice wins, also after a reload.
    await page.reload();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
    expect(await rootVar(page, "--nr-bg")).toBe(PAPER_BG);

    await page.locator('[data-nr-part="pane"]:visible').click();
    await openPalette(page);
    await expect(options(page).filter({ hasText: "Theme: Noren Paper" })).toContainText("in use");
    await page.keyboard.type("follow system");
    await expect(options(page)).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK_BG);

    await page.reload();
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
    expect(await rootVar(page, "--nr-bg")).toBe(DUSK_BG);
    // Following the system again: it moves with the color scheme.
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(PAPER_BG);
  });

  test("a theme the settings file names but this build does not have follows the system", async ({
    page,
  }) => {
    await seedConfig(page, '{ "appearance": { "theme": "no-such-theme" } }');
    await page.goto("/");
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(DUSK_BG);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => rootVar(page, "--nr-bg")).toBe(PAPER_BG);
  });
});

test("a folder reported by OSC 7 is listed as recent and opens a tab there", async ({ page }) => {
  await openApp(page);
  // The fake shell reports its folder at every prompt (OSC 7).
  await typeCommand(page, "cd /srv/api");
  await typeCommand(page, "cd /srv/web");

  await openPalette(page);
  await page.keyboard.type(">");
  const folders = ofKind(page, "folder");
  // Most recent first: /srv/web, then /srv/api, then the folder the shell started in.
  await expect(folders.nth(0)).toContainText("/srv/web");
  await expect(folders.nth(1)).toContainText("/srv/api");
  await expect(folders).toHaveCount(3);

  await page.keyboard.type("srv api");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute("data-nr-kind", "folder");
  await page.keyboard.press("Enter");

  await expect(palette(page)).toBeHidden();
  await expect(tabList(page).getByRole("treeitem")).toHaveCount(2);
  await expect
    .poll(async () => (await sessionStarts(page)).map((s) => s.cwd))
    .toContain("/srv/api");

  // Reported again, a folder moves to the front instead of repeating; the list survives a reload.
  await page.reload();
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await openPalette(page);
  await page.keyboard.type(">srv");
  await expect(ofKind(page, "folder")).toHaveCount(2);
});

test("a corrupt saved folder list reads as empty and the palette still works", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("noren.ui.recent-folders", "{oops");
  });
  await openApp(page);
  await openPalette(page);
  await page.keyboard.type(">srv");
  await expect(ofKind(page, "folder")).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { openSettings, openShortcutsScreen, seedConfig } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// axe-core on the main screens, in web mode with the in-memory backend: the window with the sidebar
// and a terminal, the command palette, the settings screen and the shortcuts screen, and the window
// with the tabs on top. A violation of any impact fails the test (axe-fixture.ts).

type TestHook = { paneIds(): string[] };
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);

/** The app with the sidebar workspace (pinned tab, group, split tab, a second space) on screen. */
async function openMain(page: Page): Promise<void> {
  await seedSidebarState(page, { split: true, secondSpace: true });
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBeGreaterThan(0);
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
}

test("axe: the main window with the sidebar and a terminal has no axe violation", async ({
  page,
}) => {
  await openMain(page);
  await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "main window");
});

test("axe: the command palette has no axe violation", async ({ page }) => {
  await openMain(page);
  await openCommandPalette(page);
  await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
  await expectNoAxeViolations(page, "palette");
});

test("axe: the settings screen has no axe violation", async ({ page }) => {
  await openMain(page);
  await openSettings(page);
  await expectNoAxeViolations(page, "settings");
});

test("axe: the shortcuts screen has no axe violation", async ({ page }) => {
  await openMain(page);
  await openShortcutsScreen(page);
  await expectNoAxeViolations(page, "shortcuts");
});

test("axe: the window with the tabs on top has no axe violation", async ({ page }) => {
  await seedConfig(page, JSON.stringify({ appearance: { tabs: "top" } }));
  await openMain(page);
  await expect(page.getByRole("tablist", { name: "Tabs", exact: true })).toBeVisible();
  await expectNoAxeViolations(page, "tabs on top");
});

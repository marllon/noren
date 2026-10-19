import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openSettings, openShortcutsScreen, seedConfig } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";

// axe-core on the main screens, in web mode with the in-memory backend: the window with the sidebar
// and a terminal, the command palette, the settings screen and the shortcuts screen, and the window
// with the tabs on top. A serious or critical violation fails the test; the lesser ones (moderate
// and minor) are listed in the test output so they stay visible, but do not fail it.

type TestHook = { paneIds(): string[] };
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);

/** Runs axe on the page and fails with the nodes of every serious or critical violation. */
async function expectNoSeriousViolations(page: Page, screen: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const lesser = violations.filter((v) => v.impact !== "serious" && v.impact !== "critical");
  for (const v of lesser) {
    console.log(`axe ${screen}: ${v.impact ?? "?"} ${v.id} (${v.nodes.length} nodes)`);
  }
  const report = blocking.map(
    (v) =>
      `${v.impact ?? "?"} ${v.id}: ${v.help}\n` +
      v.nodes.map((n) => `    ${n.target.join(" ")}\n    ${n.failureSummary ?? ""}`).join("\n"),
  );
  expect(report, `serious or critical violations on ${screen}`).toEqual([]);
}

/** The app with the sidebar workspace (pinned tab, group, split tab, a second space) on screen. */
async function openMain(page: Page): Promise<void> {
  await seedSidebarState(page, { split: true, secondSpace: true });
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBeGreaterThan(0);
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
}

test("axe: the main window with the sidebar and a terminal has no serious violation", async ({
  page,
}) => {
  await openMain(page);
  await expect(page.getByRole("tree", { name: "Tabs", exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, "main window");
});

test("axe: the command palette has no serious violation", async ({ page }) => {
  await openMain(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
  await expectNoSeriousViolations(page, "palette");
});

test("axe: the settings screen has no serious violation", async ({ page }) => {
  await openMain(page);
  await openSettings(page);
  await expectNoSeriousViolations(page, "settings");
});

test("axe: the shortcuts screen has no serious violation", async ({ page }) => {
  await openMain(page);
  await openShortcutsScreen(page);
  await expectNoSeriousViolations(page, "shortcuts");
});

test("axe: the window with the tabs on top has no serious violation", async ({ page }) => {
  await seedConfig(page, JSON.stringify({ appearance: { tabs: "top" } }));
  await openMain(page);
  await expect(page.getByRole("tablist", { name: "Tabs", exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, "tabs on top");
});

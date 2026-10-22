import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedConfig } from "./settings-fixture";
import { ACTIONS_CWD, ACTIONS_TEXT, seedActionsFile, seedSidebarState } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`. The glass style is the
// default, so the baselines of every other visual test already show it (with Geist); these two show
// the dense style (JetBrains Mono, square corners) in the dark and the light scheme (NOR-F20-17).

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const header = (page: Page) => page.getByRole("region", { name: "Project actions", exact: true });

/** The sidebar of the space "Main" with its actions, in the dense style. Ends on "api", nothing hovered. */
async function openDenseSidebar(page: Page): Promise<void> {
  await seedConfig(page, '{ "appearance": { "style": "dense" } }');
  await seedSidebarState(page, { cwd: ACTIONS_CWD });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect(header(page).getByRole("button", { name: "Start Loop", exact: true })).toBeVisible();
  await expect(tab(page, "api")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-nr-style", "dense");
  // The type is the packaged one before the picture is taken, not the fallback it starts with.
  await page.evaluate(() => document.fonts.load('400 12px "JetBrains Mono"'));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(900, 500);
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual the sidebar in the dense style (${scheme})`, async ({ page }) => {
      await openDenseSidebar(page);
      await expect(page.locator('[data-nr-part="sidebar"]')).toHaveScreenshot(
        `sidebar-dense-${scheme}.png`,
        { animations: "disabled", caret: "hide" },
      );
    });
  });
}

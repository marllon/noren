import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";

// Baselines are per operating system (Windows only, D7): `pnpm e2e:visual`.

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });

/** Loads the saved workspace and makes the tab "build" fail with `exit 2`. Ends on the tab "api". */
async function openSidebar(page: Page): Promise<void> {
  await seedSidebarState(page);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();

  await tab(page, "build").click();
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("exit 2");
  await page.keyboard.press("Enter");
  await expect(tab(page, "build").locator('[data-nr-indicator="failed"]')).toHaveAttribute(
    "title",
    "Exited with code 2",
  );

  // Back to a fixed state: "api" active, no hover, no focus ring.
  await tab(page, "api").click();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(900, 500);
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`@visual the sidebar with folders, branch and indicators (${scheme})`, async ({
      page,
    }) => {
      await openSidebar(page);
      // Only the sidebar: the terminal is never part of a screenshot.
      await expect(page.locator('[data-nr-part="sidebar"]')).toHaveScreenshot(
        `sidebar-${scheme}.png`,
        { animations: "disabled", caret: "hide" },
      );
    });
  });
}

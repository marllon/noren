import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ACTIONS_CWD, ACTIONS_TEXT, seedActionsFile, seedSidebarState } from "./sidebar-fixture";

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

/** Loads the workspace with the split tab "servers" (list expanded). Ends on "api", nothing hovered. */
async function openSplitSidebar(page: Page): Promise<void> {
  await seedSidebarState(page, { split: true });
  await page.goto("/");
  await expect(tab(page, "servers")).toBeVisible();
  await expect(page.getByRole("list", { name: "Panes of servers", exact: true })).toBeVisible();
  await tab(page, "api").click();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(900, 500);
}

const header = (page: Page) => page.getByRole("region", { name: "Project actions", exact: true });

/** Loads the space "Main" with a folder and an `.noren/actions.json`. Ends on "api", nothing hovered. */
async function openActionsSidebar(page: Page): Promise<void> {
  await seedSidebarState(page, { cwd: ACTIONS_CWD });
  await seedActionsFile(page, ACTIONS_CWD, ACTIONS_TEXT);
  await page.goto("/");
  await expect(header(page).getByRole("button", { name: "Start Loop", exact: true })).toBeVisible();
  await expect(tab(page, "api")).toBeVisible();
}

/** Puts the pointer and the focus away so the capture has no hover or focus ring. */
async function settleCapture(page: Page): Promise<void> {
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

    test(`@visual the sidebar with a split tab expanded (${scheme})`, async ({ page }) => {
      await openSplitSidebar(page);
      await expect(page.locator('[data-nr-part="sidebar"]')).toHaveScreenshot(
        `sidebar-split-${scheme}.png`,
        { animations: "disabled", caret: "hide" },
      );
    });

    test(`@visual the sidebar with the space header and its actions (${scheme})`, async ({
      page,
    }) => {
      await openActionsSidebar(page);
      await settleCapture(page);
      await expect(page.locator('[data-nr-part="sidebar"]')).toHaveScreenshot(
        `sidebar-actions-${scheme}.png`,
        { animations: "disabled", caret: "hide" },
      );
    });

    test(`@visual the space header with one action running (${scheme})`, async ({ page }) => {
      await openActionsSidebar(page);
      await header(page).getByRole("button", { name: "Start Dev server", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Run project action", exact: true })
        .getByRole("button", { name: "Run", exact: true })
        .click();
      await expect(
        header(page).getByRole("button", { name: "Stop Dev server", exact: true }),
      ).toBeVisible();
      await settleCapture(page);
      await expect(header(page)).toHaveScreenshot(`space-header-running-${scheme}.png`, {
        animations: "disabled",
        caret: "hide",
      });
    });
  });
}

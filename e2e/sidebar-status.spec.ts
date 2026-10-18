import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const meta = (page: Page, name: string) => tab(page, name).locator('[data-nr-part="item-meta"]');
const indicator = (page: Page, name: string, kind: string) =>
  tab(page, name).locator(`[data-nr-indicator="${kind}"]`);

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
});

test("the second line shows the short folder and the branch, only when there is something to show", async ({
  page,
}) => {
  // The home folder becomes ~; a deep path keeps its last two segments.
  await expect(meta(page, "api").locator('[data-nr-part="item-cwd"]')).toHaveText(
    "~/projects/noren",
  );
  await expect(meta(page, "api").locator('[data-nr-part="item-branch"]')).toHaveText("main");
  await expect(meta(page, "notes")).toHaveText("~");
  await expect(meta(page, "build")).toHaveText("…/noren/release");
  // A Windows path keeps its backslashes.
  await expect(meta(page, "deploy").locator('[data-nr-part="item-cwd"]')).toHaveText(
    "…\\dev\\site",
  );
  // The full folder is in the tooltip.
  await expect(meta(page, "build").locator('[data-nr-part="item-cwd"]')).toHaveAttribute(
    "title",
    "/srv/builds/noren/release",
  );
  // No folder and no branch: no second line at all.
  await expect(meta(page, "scratch")).toHaveCount(0);
  await expect(meta(page, "logs").locator('[data-nr-part="item-branch"]')).toHaveCount(0);

  // The title stays apart from the second line, and names the button.
  await expect(tab(page, "api").locator('[data-nr-part="item-title"]')).toHaveText("api");
});

test("unread and bell are shown from the saved state; the others are not", async ({ page }) => {
  await expect(indicator(page, "logs", "unread")).toHaveAttribute("title", "Unread output");
  await expect(indicator(page, "deploy", "bell")).toHaveAttribute("title", "Bell");
  await expect(list(page).locator("[data-nr-indicator]")).toHaveCount(2);
});

test("exit 2 in a tab shows the error indicator with the code in the tooltip, and it is saved", async ({
  page,
}) => {
  await expect(indicator(page, "build", "failed")).toHaveCount(0);

  await tab(page, "build").click();
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("exit 2");
  await page.keyboard.press("Enter");

  await expect(indicator(page, "build", "failed")).toHaveAttribute("title", "Exited with code 2");
  // Only that tab fails; the description names the code for assistive technology.
  await expect(list(page).locator('[data-nr-indicator="failed"]')).toHaveCount(1);
  await expect(page.locator("#tab-info-i3")).toHaveText(
    "Exited with code 2. Folder …/noren/release",
  );
  await expect(tab(page, "build")).toHaveAttribute("aria-describedby", "tab-info-i3");

  // The status is part of the saved state.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const text = window.localStorage.getItem("noren.web.state") ?? "";
        const state = JSON.parse(text) as {
          spaces: {
            items: Record<string, { layout: { pane: { status: string; exitCode?: number } } }>;
          }[];
        };
        return state.spaces[0]?.items["i3"]?.layout.pane;
      }),
    )
    .toMatchObject({ status: "exited", exitCode: 2 });
});

test("a clean exit (code 0) is not an error", async ({ page }) => {
  await tab(page, "scratch").click();
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __norenTest?: { lines(): string[] } }).__norenTest?.lines() ?? [],
      ),
    )
    .toContainEqual(expect.stringContaining("[Process exited with code 0]"));
  await expect(indicator(page, "scratch", "failed")).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SPLIT_FIXTURE, seedSidebarState } from "./sidebar-fixture";

// A split tab shows a thumbnail of its layout and, expanded, one entry per pane; clicking an entry
// shows the tab and focuses that pane.

type Hook = { focusedPaneId(): string | undefined };

const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.focusedPaneId());

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const thumb = (page: Page, name: string) => tab(page, name).locator('[data-nr-part="item-layout"]');
const panes = (page: Page, name: string) =>
  page.getByRole("list", { name: `Panes of ${name}`, exact: true });
const entries = (page: Page, name: string) =>
  panes(page, name).locator('[data-nr-part="item-pane"]');
const toggle = (page: Page, label: "Show panes" | "Hide panes") =>
  page.getByRole("button", { name: label, exact: true });

const { title, first, second } = SPLIT_FIXTURE;

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page, { split: true });
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
});

test("a tab with two panes shows the thumbnail and one entry per pane", async ({ page }) => {
  await expect(thumb(page, title)).toBeVisible();
  await expect(thumb(page, title)).toHaveAttribute("aria-hidden", "true");
  await expect(thumb(page, title).locator(".item-thumb-cell")).toHaveCount(2);
  await expect(entries(page, title)).toHaveCount(2);
  await expect(entries(page, title).nth(0)).toContainText("/srv/api");
  await expect(entries(page, title).nth(1)).toContainText("/srv/web");
  // Each entry says what its pane is doing.
  await expect(entries(page, title).nth(0).locator('[data-nr-part="item-pane-status"]')).toHaveText(
    /^(idle|running)$/,
  );
  // The pane that has the keyboard is the first one.
  await expect(entries(page, title).nth(0)).toHaveAttribute("aria-current", "true");
  await expect(entries(page, title).nth(1)).not.toHaveAttribute("aria-current", "true");
});

test("clicking the second entry focuses the second pane and marks the entry", async ({ page }) => {
  // The tab "api" is on screen; the click shows the split tab too.
  await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");
  await entries(page, title).nth(1).click();
  await expect(tab(page, title)).toHaveAttribute("aria-current", "true");
  await expect(tab(page, "api")).not.toHaveAttribute("aria-current", "true");
  await expect.poll(() => focusedPaneId(page)).toBe(second);
  await expect(entries(page, title).nth(1)).toHaveAttribute("aria-current", "true");
  await expect(entries(page, title).nth(0)).not.toHaveAttribute("aria-current", "true");

  // Back to the first pane while the tab stays on screen.
  await entries(page, title).nth(0).click();
  await expect.poll(() => focusedPaneId(page)).toBe(first);
  await expect(entries(page, title).nth(0)).toHaveAttribute("aria-current", "true");
});

test("with another tab on screen, an entry shows its tab and focuses the right pane", async ({
  page,
}) => {
  await tab(page, "scratch").click();
  await expect(tab(page, "scratch")).toHaveAttribute("aria-current", "true");
  await entries(page, title).nth(1).click();
  await expect(tab(page, title)).toHaveAttribute("aria-current", "true");
  await expect(tab(page, "scratch")).not.toHaveAttribute("aria-current", "true");
  await expect.poll(() => focusedPaneId(page)).toBe(second);
});

test("Hide panes folds the list away and Show panes brings it back", async ({ page }) => {
  await expect(toggle(page, "Hide panes")).toHaveAttribute("aria-expanded", "true");
  await toggle(page, "Hide panes").click();
  await expect(panes(page, title)).toHaveCount(0);
  await expect(entries(page, title)).toHaveCount(0);
  // The thumbnail stays when the list is folded.
  await expect(thumb(page, title)).toBeVisible();
  await expect(toggle(page, "Show panes")).toHaveAttribute("aria-expanded", "false");
  await toggle(page, "Show panes").click();
  await expect(entries(page, title)).toHaveCount(2);
  await expect(toggle(page, "Hide panes")).toHaveAttribute("aria-expanded", "true");
});

test("a tab with one pane has no thumbnail, no list and no fold button", async ({ page }) => {
  await expect(thumb(page, "api")).toHaveCount(0);
  await expect(panes(page, "api")).toHaveCount(0);
  await expect(list(page).locator('[data-nr-part="item-layout"]')).toHaveCount(1);
  await expect(list(page).locator('[data-nr-part="item-panes"]')).toHaveCount(1);
  // One fold button in the whole tree: the one of the split tab.
  await expect(list(page).locator('[data-nr-part="item-panes-toggle"]')).toHaveCount(1);
});

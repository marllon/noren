import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { seedSidebarState } from "./sidebar-fixture";

// The Favorites bar (global, at the top of the sidebar, always on screen: `favorites-bar.spec.ts`
// holds what it shows when it is empty) and the Pinned list (per space, above the tree). The seeded sidebar: Main with pinned "notes", the group "Work" (api, build, logs),
// "deploy" and "scratch"; the space "Other" with the tab "elsewhere".

const WEB_STATE_KEY = "noren.web.state";

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const grid = (page: Page) => page.locator('[data-nr-part="favorites"]');
const favorite = (page: Page, name: string) =>
  grid(page).getByRole("button", { name, exact: true });
const spaceButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Spaces", exact: true }).getByRole("button", {
    name,
    exact: true,
  });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

/** The saved workspace, as the web backend keeps it. */
async function saved(page: Page): Promise<{
  activeSpaceId: string;
  favorites: string[];
  spaces: { id: string; activeItemId?: string }[];
}> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}");
}

/** Presses on `source` and drags it over the middle of `over`; the caller drops with the mouse. */
async function dragTo(page: Page, source: Locator, over: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await over.boundingBox();
  if (!from || !to) throw new Error("not on screen");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
}

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page, { secondSpace: true });
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
});

test("a favorite made in one space shows in the grid of the others, and a click opens its tab", async ({
  page,
}) => {
  // Nothing is a favorite yet: the bar is on screen all the same, with no tile in it.
  await expect(grid(page)).toBeVisible();
  await expect(grid(page).getByRole("button")).toHaveCount(0);

  await row(page, "scratch").click({ button: "right" });
  await menuItem(page, "Add to favorites").click();
  await expect(favorite(page, "scratch")).toBeVisible();
  await expect(favorite(page, "scratch")).toHaveAttribute("title", "scratch");

  // In the other space the grid is still there, and the tree is that space's own.
  await spaceButton(page, "Other").click();
  await expect(row(page, "elsewhere")).toBeVisible();
  await expect(row(page, "scratch")).toHaveCount(0);
  await expect(favorite(page, "scratch")).toBeVisible();
  await expect(favorite(page, "scratch")).not.toHaveAttribute("aria-current", "true");

  // Clicking it goes back to Main with the tab active.
  await favorite(page, "scratch").click();
  await expect(spaceButton(page, "Main")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "scratch")).toHaveAttribute("aria-current", "true");
  await expect(favorite(page, "scratch")).toHaveAttribute("aria-current", "true");

  // The active space and tab are saved with the workspace, and so is the favorite.
  await expect.poll(async () => (await saved(page)).spaces[0]?.activeItemId).toBe("i6");
  await page.reload();
  await expect(row(page, "scratch")).toHaveAttribute("aria-current", "true");
  await expect(favorite(page, "scratch")).toBeVisible();
  expect((await saved(page)).favorites).toEqual(["i6"]);
});

test("a favorite from another space opens that space and its tab", async ({ page }) => {
  await spaceButton(page, "Other").click();
  await row(page, "elsewhere").click({ button: "right" });
  await menuItem(page, "Add to favorites").click();
  await expect(favorite(page, "elsewhere")).toBeVisible();

  await spaceButton(page, "Main").click();
  await expect(row(page, "api")).toBeVisible();
  await expect(favorite(page, "elsewhere")).toBeVisible();
  await favorite(page, "elsewhere").click();
  await expect(spaceButton(page, "Other")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "elsewhere")).toHaveAttribute("aria-current", "true");
});

test("dragging a tab onto the bar adds it, whether the bar is empty or not", async ({ page }) => {
  // Empty bar: it is the drop place itself, and its tile appears.
  await dragTo(page, row(page, "scratch"), grid(page));
  await expect(grid(page)).toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await expect(favorite(page, "scratch")).toBeVisible();

  // A bar with something in it is the drop place too and lights up while a tab is over it.
  await dragTo(page, row(page, "deploy"), grid(page));
  await expect(grid(page)).toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await expect(favorite(page, "deploy")).toBeVisible();
  await expect(grid(page).getByRole("button")).toHaveCount(2);
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6", "i5"]);
  // The tabs stay in the tree.
  await expect(row(page, "deploy")).toBeVisible();
  await expect(row(page, "scratch")).toBeVisible();
});

test("removing a favorite from its menu takes it off the bar, and the bar stays when empty", async ({
  page,
}) => {
  for (const name of ["scratch", "deploy"]) {
    await row(page, name).click({ button: "right" });
    await menuItem(page, "Add to favorites").click();
  }
  await expect(grid(page).getByRole("button")).toHaveCount(2);

  await favorite(page, "scratch").click({ button: "right" });
  await menuItem(page, "Remove from favorites").click();
  await expect(favorite(page, "scratch")).toHaveCount(0);
  await expect(favorite(page, "deploy")).toBeVisible();
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i5"]);

  await favorite(page, "deploy").click({ button: "right" });
  await menuItem(page, "Remove from favorites").click();
  await expect(grid(page).getByRole("button")).toHaveCount(0);
  await expect(grid(page)).toBeVisible();
  await expect.poll(async () => (await saved(page)).favorites).toEqual([]);
  // The tab itself is untouched.
  await expect(row(page, "scratch")).toBeVisible();
});

test("closing a favorite tab takes it off the bar, which stays", async ({ page }) => {
  await row(page, "scratch").click({ button: "right" });
  await menuItem(page, "Add to favorites").click();
  await expect(favorite(page, "scratch")).toBeVisible();

  await row(page, "scratch").click({ button: "right" });
  await menuItem(page, "Close").click();
  await expect(grid(page).getByRole("button")).toHaveCount(0);
  await expect(grid(page)).toBeVisible();
});

test("the Pinned list is a list of its own above the tree and holds the pinned tabs", async ({
  page,
}) => {
  const pinned = page.getByRole("group", { name: "Pinned", exact: true });
  await expect(pinned.getByRole("treeitem")).toHaveCount(1);
  await expect(pinned.getByRole("treeitem", { name: "notes", exact: true })).toHaveAttribute(
    "data-nr-pinned",
    "true",
  );

  // Pinning another tab puts it in that list; unpinning takes it back to the tree.
  await row(page, "scratch").click({ button: "right" });
  await menuItem(page, "Pin").click();
  await expect(pinned.getByRole("treeitem", { name: "scratch", exact: true })).toBeVisible();
  await row(page, "scratch").click({ button: "right" });
  await menuItem(page, "Unpin").click();
  await expect(pinned.getByRole("treeitem", { name: "scratch", exact: true })).toHaveCount(0);
  await expect(row(page, "scratch")).toBeVisible();
});

test("with nothing pinned the list is gone and a zone over New tab takes the drop", async ({
  page,
}) => {
  await row(page, "notes").click({ button: "right" });
  await menuItem(page, "Unpin").click();
  await expect(page.locator('[data-nr-part="pinned-list"]')).toHaveCount(0);

  const zone = page.locator('[data-nr-part="drop-pinned"]');
  await expect(zone).toBeHidden();
  await dragTo(page, row(page, "scratch"), zone);
  await expect(zone).toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await expect(
    page.getByRole("group", { name: "Pinned", exact: true }).getByRole("treeitem", {
      name: "scratch",
      exact: true,
    }),
  ).toBeVisible();
  await expect(zone).toHaveCount(0);
});

test("axe: the grid with favorites, one of them the tab on screen, has no violation", async ({
  page,
}) => {
  await row(page, "scratch").click({ button: "right" });
  await menuItem(page, "Add to favorites").click();
  await row(page, "deploy").click({ button: "right" });
  await menuItem(page, "Add to favorites").click();
  await row(page, "api").click({ button: "right" });
  await menuItem(page, "Add to favorites").click();
  await expect(grid(page).getByRole("button")).toHaveCount(3);
  await favorite(page, "scratch").click();
  await expect(favorite(page, "scratch")).toHaveAttribute("aria-current", "true");
  await expectNoAxeViolations(page, "favorites grid");
  await spaceButton(page, "Other").click();
  await expect(favorite(page, "scratch")).not.toHaveAttribute("aria-current", "true");
  await expectNoAxeViolations(page, "favorites grid, in another space");
});

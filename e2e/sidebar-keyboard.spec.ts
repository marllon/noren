import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { SPLIT_FIXTURE, seedSidebarState } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// The sidebar is an ARIA tree driven by the keyboard alone: one row is in the Tab order, Up and
// Down walk the rows, Left and Right fold, unfold and go to the parent, Enter activates, F2 renames
// and Delete closes. The keys only act while the focus is inside the tree.

const tree = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
const pane = (page: Page, paneId: string) =>
  tree(page).locator(`[data-nr-part="item-pane"][data-nr-pane="${paneId}"]`);

type Hook = { focusedPaneId(): string | undefined };
const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.focusedPaneId());

/**
 * Puts the keyboard on the tree the way a keyboard user does: the terminal keeps Tab for the shell,
 * so the action "Focus sidebar" is run from the palette.
 */
async function focusTree(page: Page): Promise<void> {
  await openCommandPalette(page);
  await page.getByRole("combobox", { name: "Command palette", exact: true }).fill("Focus sidebar");
  await page.keyboard.press("Enter");
  await expect(tabStops(page)).toBeFocused();
}

/** The treeitems of the tree that are in the Tab order. */
const tabStops = (page: Page): Locator => tree(page).locator('[role="treeitem"][tabindex="0"]');

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page, { split: true });
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
});

test("the tree has one stop in the Tab order: the tab on screen, then the focus leaves", async ({
  page,
}) => {
  await expect(tabStops(page)).toHaveCount(1);
  await expect(tabStops(page)).toHaveAttribute("aria-current", "true");
  await focusTree(page);
  await expect(row(page, "api")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[role="tree"]') != null))
    .toBe(false);
});

test("the rows carry the tree roles: level, size and position, expanded and selected", async ({
  page,
}) => {
  await expect(tree(page)).toHaveAttribute("aria-multiselectable", "true");
  const work = row(page, "Work");
  await expect(work).toHaveAttribute("aria-level", "1");
  await expect(work).toHaveAttribute("aria-expanded", "true");
  // The tree: Work, deploy, servers, scratch.
  await expect(work).toHaveAttribute("aria-setsize", "4");
  await expect(work).toHaveAttribute("aria-posinset", "1");
  const api = row(page, "api");
  await expect(api).toHaveAttribute("aria-level", "2");
  await expect(api).toHaveAttribute("aria-setsize", "3");
  await expect(api).toHaveAttribute("aria-posinset", "1");
  await expect(api).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "build")).toHaveAttribute("aria-selected", "false");
  // A pinned tab is level 1 in the group "Pinned".
  await expect(row(page, "notes")).toHaveAttribute("aria-level", "1");
  await expect(page.getByRole("group", { name: "Pinned", exact: true })).toBeVisible();
  // A split tab folds its pane list; the panes are a level below it.
  const servers = row(page, SPLIT_FIXTURE.title);
  await expect(servers).toHaveAttribute("aria-expanded", "true");
  await expect(pane(page, SPLIT_FIXTURE.first)).toHaveAttribute("aria-level", "2");
  await expect(pane(page, SPLIT_FIXTURE.first)).toHaveAttribute("aria-selected", "true");
  await expect(pane(page, SPLIT_FIXTURE.second)).toHaveAttribute("aria-selected", "false");
  // A tab that does not fold has no aria-expanded.
  await expect(api).not.toHaveAttribute("aria-expanded", /.*/);
});

test("Up, Down, Home and End walk the rows, and the Tab stop follows the focus", async ({
  page,
}) => {
  await focusTree(page);
  await expect(row(page, "api")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "build")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "logs")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "deploy")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "logs")).toBeFocused();
  // Moving the focus does not open a tab: the one on screen is still "api".
  await expect(row(page, "api")).toHaveAttribute("aria-current", "true");
  await expect(tabStops(page)).toHaveCount(1);
  await expect(row(page, "logs")).toHaveAttribute("tabindex", "0");
  await page.keyboard.press("End");
  await expect(row(page, "scratch")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "scratch")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(row(page, "notes")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "notes")).toBeFocused();
});

test("Left and Right fold and unfold a group, go to the parent, go to the first child", async ({
  page,
}) => {
  await focusTree(page);
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Work")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "Work")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "api")).toHaveCount(0);
  await expect(row(page, "Work")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "Work")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "api")).toBeVisible();
  await expect(row(page, "Work")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "api")).toBeFocused();
  // Right on a tab that does not fold does nothing.
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "api")).toBeFocused();
});

test("the panes of a split tab are rows of the tree: fold, unfold, walk, and Enter focuses one", async ({
  page,
}) => {
  const { title, first, second } = SPLIT_FIXTURE;
  await row(page, title).focus();
  await page.keyboard.press("ArrowDown");
  await expect(pane(page, first)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(pane(page, second)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, title)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, title)).toHaveAttribute("aria-expanded", "false");
  await expect(pane(page, first)).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, title)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await expect(pane(page, first)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(pane(page, second)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row(page, title)).toHaveAttribute("aria-current", "true");
  await expect.poll(() => focusedPaneId(page)).toBe(second);
});

test("Enter on a tab shows it and Enter on a group folds it", async ({ page }) => {
  await focusTree(page);
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "build")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row(page, "build")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "api")).not.toHaveAttribute("aria-current", "true");
  await row(page, "Work").focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "Work")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "build")).toHaveCount(0);
});

test("F2 renames the tab with the focus and the focus comes back to it", async ({ page }) => {
  await focusTree(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(row(page, "logs")).toBeFocused();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await expect(field).toBeFocused();
  await page.keyboard.type("journal");
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  await expect(row(page, "journal")).toBeFocused();
  await expect(row(page, "logs")).toHaveCount(0);
  // F2 on a group renames the group.
  await row(page, "Work").focus();
  await page.keyboard.press("F2");
  const groupField = page.getByRole("textbox", { name: "Group name", exact: true });
  await expect(groupField).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(groupField).toBeHidden();
  await expect(row(page, "Work")).toBeVisible();
});

test("Delete closes the tab with the focus and the focus goes to the row below it", async ({
  page,
}) => {
  await row(page, "deploy").focus();
  await page.keyboard.press("Delete");
  await expect(row(page, "deploy")).toHaveCount(0);
  await expect(row(page, SPLIT_FIXTURE.title)).toBeFocused();
  // The last row: the focus goes to the one above.
  await page.keyboard.press("End");
  await expect(row(page, "scratch")).toBeFocused();
  await page.keyboard.press("Delete");
  await expect(row(page, "scratch")).toHaveCount(0);
  await expect(pane(page, SPLIT_FIXTURE.second)).toBeFocused();
});

test("Delete closes every tab of the selection when the tab with the focus is in it", async ({
  page,
}) => {
  await row(page, "api").click();
  await row(page, "logs").click({ modifiers: ["Control"] });
  await expect(row(page, "api")).toHaveAttribute("data-nr-selected", "true");
  await expect(row(page, "logs")).toHaveAttribute("data-nr-selected", "true");
  await row(page, "logs").focus();
  await page.keyboard.press("Delete");
  await expect(row(page, "api")).toHaveCount(0);
  await expect(row(page, "logs")).toHaveCount(0);
  await expect(row(page, "build")).toBeVisible();
  // The tab on screen was closed, so "build" is shown now (and its terminal asks for the keyboard),
  // yet the focus stays in the tree, on the row below the one that was deleted.
  await expect(row(page, "build")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "deploy")).toBeFocused();
});

test("Delete on a group dissolves it and keeps its tabs", async ({ page }) => {
  await row(page, "Work").focus();
  await page.keyboard.press("Delete");
  await expect(row(page, "Work")).toHaveCount(0);
  for (const name of ["api", "build", "logs"]) {
    await expect(row(page, name)).toHaveAttribute("aria-level", "1");
  }
  await expect(row(page, "api")).toBeFocused();
});

test("the tree keys do nothing outside the tree: the terminal and the title bar keep theirs", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("F2");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("textbox", { name: "Tab name", exact: true })).toHaveCount(0);
  await expect(row(page, "api")).toBeVisible();
  await expect(row(page, "deploy")).toBeVisible();
});

test("the focus ring is drawn with the accent of the theme", async ({ page }) => {
  await focusTree(page);
  const ring = await row(page, "api").evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--nr-accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element);
    return {
      accent,
      color: style.outlineColor,
      style: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBe("2px");
  expect(ring.color).toBe(ring.accent);
});

test("with reduced motion the animations of the interface are off", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  const names = await page.evaluate(() =>
    [".tab-list", ".space-layer:not([hidden])"].map((selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).animationName : "missing";
    }),
  );
  expect(names).toEqual(["none", "none"]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  const running = await page.evaluate(
    () => getComputedStyle(document.querySelector(".tab-list") as Element).animationName,
  );
  expect(running).toBe("nr-space-in");
});

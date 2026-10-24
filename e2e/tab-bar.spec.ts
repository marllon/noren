import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { afterAnimations } from "./frames";
import { seedSidebarState } from "./sidebar-fixture";
import {
  GLASS_GAP,
  changeSettings,
  configText,
  openSettings,
  closeSettings,
  seedConfig,
} from "./settings-fixture";

// Top tabs: the tabs of the active space as a bar above the terminal, switched on in the settings
// screen and kept in `config.jsonc` (`appearance.tabs`).

const LAYOUT_KEY = "noren.ui.layout";

const bar = (page: Page) => page.locator('[data-nr-part="tabbar"]');
const barTab = (page: Page, name: string) => bar(page).getByRole("tab", { name, exact: true });
const island = (page: Page) => page.locator('[data-nr-part="island"]');
const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const content = (page: Page) => page.getByRole("region", { name: "Content", exact: true });
const tree = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const treeTab = (page: Page, name: string) =>
  tree(page).getByRole("treeitem", { name, exact: true });
const radio = (screen: Locator, name: string) => screen.getByRole("radio", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
// The bar has its own New tab button; the (hidden) sidebar has another one.
const newTab = (page: Page) =>
  page
    .getByRole("navigation", { name: "Tab bar", exact: true })
    .getByRole("button", { name: "New tab", exact: true });
const header = (page: Page) => island(page).getByRole("tab", { name: "Work", exact: true });

/** The names of the tabs on the bar, left to right (a folded group holds none). */
async function barTabNames(page: Page): Promise<string[]> {
  return bar(page)
    .locator('[data-nr-part="item"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element not on screen");
  return found;
}

/**
 * Starts the page with the tabs on top: a settings file with `appearance.tabs` (and `extra`, the
 * rest of `appearance.sidebar`) that is there before the page loads, and only when there is none.
 */
async function startWithTopTabs(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await seedConfig(page, JSON.stringify({ appearance: { tabs: "top", sidebar: extra } }));
}

/** Waits for the sidebar to stop moving: it slides out when the mode changes. */
async function settled(page: Page): Promise<void> {
  await afterAnimations(page);
}

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page, { secondSpace: true });
});

test("switching to top tabs shows the bar above the terminal, one tab per item in tree order", async ({
  page,
}) => {
  await page.goto("/");
  await expect(treeTab(page, "api")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);

  await changeSettings(page, async (screen) => {
    await radio(screen, "On top").check();
    await expect(radio(screen, "On top")).toBeChecked();
  });
  await settled(page);

  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toHaveAttribute("aria-label", "Tabs");
  // Pinned first, then the tree: the group's tabs, then the loose ones.
  expect(await barTabNames(page)).toEqual(["notes", "api", "build", "logs", "deploy", "scratch"]);

  // Above the terminal and across its width; the sidebar is out of the flow.
  const barBox = await box(bar(page));
  const contentBox = await box(content(page));
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(contentBox.y + 1);
  expect(barBox.y).toBeGreaterThan(0);
  expect(contentBox.x).toBe(GLASS_GAP);
  expect(contentBox.width).toBe((page.viewportSize()?.width ?? 0) - 2 * GLASS_GAP);
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  // The tree is not in the sidebar any more: the list of tabs on screen is the bar.
  await expect(tree(page)).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Tabs", exact: true })).toHaveCount(1);
  await expect(bar(page)).toHaveCount(1);
});

test("clicking a tab on the bar activates it", async ({ page }) => {
  await startWithTopTabs(page);
  await page.goto("/");
  await expect(barTab(page, "api")).toHaveAttribute("aria-current", "true");
  await expect(barTab(page, "api")).toHaveAttribute("data-nr-state", "active");

  await barTab(page, "build").click();
  await expect(barTab(page, "build")).toHaveAttribute("aria-current", "true");
  await expect(barTab(page, "api")).not.toHaveAttribute("aria-current", "true");

  // The pinned tab is on the bar too.
  await barTab(page, "notes").click();
  await expect(barTab(page, "notes")).toHaveAttribute("aria-current", "true");
  await expect(barTab(page, "notes")).toHaveAttribute("data-nr-pinned", "true");
});

test("a group is a colored island that holds its tabs, with its name and count", async ({
  page,
}) => {
  await startWithTopTabs(page);
  await page.goto("/");

  await expect(island(page)).toHaveCount(1);
  const header = island(page).getByRole("tab", { name: "Work", exact: true });
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header.locator('[data-nr-part="group-count"]')).toHaveText("3");
  // The island carries the color of the group and draws it as its border.
  await expect(island(page)).toHaveCSS("--nr-island", "teal");
  const border = await island(page).evaluate((node) => getComputedStyle(node).borderTopColor);
  expect(border).not.toBe("rgba(0, 0, 0, 0)");

  const islandBox = await box(island(page));
  for (const name of ["api", "build", "logs"]) {
    const tabBox = await box(barTab(page, name));
    expect(tabBox.x).toBeGreaterThanOrEqual(islandBox.x);
    expect(tabBox.x + tabBox.width).toBeLessThanOrEqual(islandBox.x + islandBox.width);
  }
  // The loose tabs sit outside it.
  for (const name of ["deploy", "scratch"]) {
    expect((await box(barTab(page, name))).x).toBeGreaterThan(islandBox.x + islandBox.width);
  }
});

test("folding a group hides its tabs and keeps the island with name and count", async ({
  page,
}) => {
  await startWithTopTabs(page);
  await page.goto("/");
  const header = island(page).getByRole("tab", { name: "Work", exact: true });

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(island(page)).toHaveAttribute("data-nr-state", "collapsed");
  for (const name of ["api", "build", "logs"]) await expect(barTab(page, name)).toHaveCount(0);
  await expect(header.locator('[data-nr-part="group-count"]')).toHaveText("3");
  expect(await barTabNames(page)).toEqual(["notes", "deploy", "scratch"]);

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  expect(await barTabNames(page)).toEqual(["notes", "api", "build", "logs", "deploy", "scratch"]);
});

test("the mode stays after a reload, and going back to the sidebar brings the tree back", async ({
  page,
}) => {
  await page.goto("/");
  await changeSettings(page, (screen) => radio(screen, "On top").check());
  await settled(page);
  await expect(bar(page)).toBeVisible();

  await page.reload();
  await expect(bar(page)).toBeVisible();
  await expect(barTab(page, "api")).toBeVisible();
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");

  const screen = await openSettings(page);
  await expect(radio(screen, "On top")).toBeChecked();
  await radio(screen, "In the sidebar").check();
  await closeSettings(page);
  await settled(page);

  await expect(bar(page)).toHaveCount(0);
  await expect(treeTab(page, "api")).toBeVisible();
  await expect(treeTab(page, "scratch")).toBeVisible();
  await expect(sidebar(page)).not.toHaveAttribute("data-nr-state", /.+/);
  const side = await box(sidebar(page));
  const main = await box(content(page));
  expect(side.x).toBe(GLASS_GAP);
  expect(main.x).toBeGreaterThanOrEqual(side.x + side.width);
  // The folded or open state of the group is the same as before.
  await expect(page.getByRole("treeitem", { name: "Work", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.reload();
  await expect(treeTab(page, "api")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
});

test("a layout saved in the browser storage before top tabs existed moves into the file and keeps the tabs in the sidebar", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    if (window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          side: "left",
          width: 260,
          density: "comfortable",
          compact: false,
          keepOpen: false,
        }),
      );
    }
  }, LAYOUT_KEY);
  await page.goto("/");
  await expect(treeTab(page, "api")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  expect((await box(sidebar(page))).width).toBe(260);
  // The width is in the file now, and the old key is gone; only what was not the default moved.
  expect(JSON.parse((await configText(page)) ?? "null")).toEqual({
    appearance: { sidebar: { width: 260 } },
  });
  expect(await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY)).toBeNull();
});

test("the tab menu of the bar closes a tab and renaming works in place", async ({ page }) => {
  await startWithTopTabs(page);
  await page.goto("/");

  await barTab(page, "scratch").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Tab options", exact: true })).toBeVisible();
  // The menu belongs to the bar: the hidden sidebar does not slide in because of it.
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");
  await menuItem(page, "Close").click();
  await expect(barTab(page, "scratch")).toHaveCount(0);

  await barTab(page, "deploy").focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await expect(field).toBeFocused();
  await field.fill("release");
  await page.keyboard.press("Enter");
  await expect(barTab(page, "release")).toBeFocused();
  await expect(barTab(page, "deploy")).toHaveCount(0);

  await header(page).click({ button: "right" });
  await menuItem(page, "Rename").click();
  const groupField = page.getByRole("textbox", { name: "Group name", exact: true });
  await groupField.fill("Backend");
  await page.keyboard.press("Enter");
  await expect(island(page).getByRole("tab", { name: "Backend", exact: true })).toBeVisible();
});

test("the keyboard reaches the bar: arrows move between tabs and group headers, Enter activates", async ({
  page,
}) => {
  await startWithTopTabs(page);
  await page.goto("/");

  // A terminal takes the keyboard when its shell is up and it mounts (on the page's first tab and
  // on any tab shown for the first time), which would pull the focus away from a bar the test
  // already focused: wait for that before taking the keyboard to the bar.
  const terminalInput = page.getByRole("textbox", { name: "Terminal input", exact: true });
  await expect(terminalInput).toBeFocused();
  await barTab(page, "notes").focus();
  await page.keyboard.press("ArrowRight");
  await expect(header(page)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(barTab(page, "api")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(barTab(page, "build")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(barTab(page, "build")).toHaveAttribute("aria-current", "true");

  // Activating a tab sends the focus to its terminal, once the terminal is there; come back to the bar.
  await expect(terminalInput).toBeFocused();
  await barTab(page, "build").focus();
  await page.keyboard.press("End");
  await expect(newTab(page)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(barTab(page, "notes")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(barTab(page, "notes")).toBeFocused();

  // A group header folds with Enter.
  await header(page).focus();
  await page.keyboard.press("Enter");
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");
});

test("the bar has a New tab button", async ({ page }) => {
  await startWithTopTabs(page);
  await page.goto("/");
  await expect(barTab(page, "api")).toBeVisible();
  const before = (await barTabNames(page)).length;
  await newTab(page).click();
  await expect.poll(async () => (await barTabNames(page)).length).toBe(before + 1);
  // The new tab is the one that shows.
  await expect(bar(page).locator('[data-nr-part="item"][aria-current="true"]')).toHaveCount(1);
});

test("spaces stay reachable: the sidebar slides in from the edge and switches the bar", async ({
  page,
}) => {
  await startWithTopTabs(page);
  await page.goto("/");
  await expect(barTab(page, "api")).toBeVisible();
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "hidden");

  await page.mouse.move(2, 400);
  await expect(sidebar(page)).toHaveAttribute("data-nr-state", "revealed");
  const switcher = page.getByRole("navigation", { name: "Spaces", exact: true });
  await expect(switcher).toBeVisible();
  await switcher.getByRole("button", { name: "Other", exact: true }).click();

  await expect.poll(() => barTabNames(page)).toEqual(["elsewhere"]);
  await expect(barTab(page, "elsewhere")).toHaveAttribute("aria-current", "true");
});

test("the settings screen disables compact mode with top tabs, and the bar follows a right-hand sidebar", async ({
  page,
}) => {
  await startWithTopTabs(page, { position: "right" });
  await page.goto("/");
  await expect(barTab(page, "api")).toBeVisible();
  // The bar takes the whole width whichever side the sidebar is on.
  expect((await box(bar(page))).x).toBeLessThan(40);
  const screen = await openSettings(page);
  await expect(screen.getByRole("switch", { name: "Compact mode", exact: true })).toBeDisabled();
  await expect(
    screen.getByRole("switch", { name: "Keep sidebar open", exact: true }),
  ).toBeDisabled();
});

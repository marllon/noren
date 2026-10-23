import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { numberTheTabs } from "./numbered-tabs";

test.beforeEach(numberTheTabs);

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const group = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const itemLabels = (page: Page): Promise<string[]> =>
  list(page).locator('[data-nr-part="item"]').allInnerTexts();
const groupCount = (page: Page, name: string) =>
  group(page, name).locator('[data-nr-part="group-count"]');

const menu = (page: Page, name: string) => page.getByRole("menu", { name, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

async function openTabMenu(page: Page, tabName: string, menuName = "Tab options") {
  await tab(page, tabName).click({ button: "right" });
  await expect(menu(page, menuName)).toBeVisible();
}

/** Renames a tab with a double click, Enter to confirm. */
async function rename(page: Page, from: string, to: string): Promise<void> {
  await tab(page, from).dblclick();
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await field.fill(to);
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
}

async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("groups two tabs from the menu, folds the group, renames group and tab inline, closes from the menu", async ({
  page,
}) => {
  await page.goto("/");
  const newTab = page.getByRole("button", { name: "New tab", exact: true });
  await newTab.click();
  await newTab.click();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);

  // A plain click activates Tab 1; Ctrl+click adds Tab 2 to the selection (the active tab counts).
  await tab(page, "Tab 1").click();
  await tab(page, "Tab 2").click({ modifiers: ["Control"] });
  await expect(tab(page, "Tab 1")).toHaveAttribute("data-nr-selected", "true");
  await expect(tab(page, "Tab 2")).toHaveAttribute("data-nr-selected", "true");
  await expect(tab(page, "Tab 3")).not.toHaveAttribute("data-nr-selected", /.*/);
  // Ctrl+click selects without changing the tab that shows.
  await expect(tab(page, "Tab 1")).toHaveAttribute("aria-current", "true");

  // The menu of a selected tab acts on the whole selection.
  await openTabMenu(page, "Tab 2", "Selected tabs options");
  await expect(menuItem(page, "Rename")).toBeDisabled();
  await menuItem(page, "Add to new group").click();
  await expect(menu(page, "Selected tabs options")).toBeHidden();

  // The new group opens its name field: Escape keeps the default name.
  const groupField = page.getByRole("textbox", { name: "Group name", exact: true });
  await expect(groupField).toBeFocused();
  await expect(groupField).toHaveValue("New group");
  await page.keyboard.press("Escape");
  await expect(groupField).toBeHidden();
  await expect(group(page, "New group")).toBeVisible();
  await expect(groupCount(page, "New group")).toHaveText("2");
  await expect(list(page).locator('[data-nr-selected="true"]')).toHaveCount(0);

  // F2 renames the group; Enter confirms.
  await group(page, "New group").focus();
  await page.keyboard.press("F2");
  await expect(groupField).toBeFocused();
  await groupField.fill("Work");
  await page.keyboard.press("Enter");
  await expect(group(page, "Work")).toBeVisible();
  await expect(group(page, "New group")).toHaveCount(0);
  // The focus goes back to the row that was renamed.
  await expect(group(page, "Work")).toBeFocused();

  // Fold: the count stays, the tabs go away; unfold brings them back.
  await expect(group(page, "Work")).toHaveAttribute("aria-expanded", "true");
  await group(page, "Work").click();
  await expect(group(page, "Work")).toHaveAttribute("aria-expanded", "false");
  await expect(groupCount(page, "Work")).toBeVisible();
  await expect(groupCount(page, "Work")).toHaveText("2");
  await expect(tab(page, "Tab 1")).toHaveCount(0);
  await expect(tab(page, "Tab 2")).toHaveCount(0);
  await expect(tab(page, "Tab 3")).toBeVisible();
  await group(page, "Work").click();
  await expect(group(page, "Work")).toHaveAttribute("aria-expanded", "true");
  await expect(tab(page, "Tab 1")).toBeVisible();
  await expect(tab(page, "Tab 2")).toBeVisible();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);

  // Rename a tab with a double click: Escape cancels, Enter confirms.
  const tabField = page.getByRole("textbox", { name: "Tab name", exact: true });
  await tab(page, "Tab 3").dblclick();
  await expect(tabField).toBeFocused();
  await expect(tabField).toHaveValue("Tab 3");
  await tabField.fill("Nope");
  await page.keyboard.press("Escape");
  await expect(tabField).toBeHidden();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);

  await tab(page, "Tab 3").dblclick();
  await tabField.fill("Build");
  await page.keyboard.press("Enter");
  await expect(tabField).toBeHidden();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2", "Build"]);
  await expect(tab(page, "Build")).toBeFocused();

  // Rename from the menu, too.
  await openTabMenu(page, "Tab 2");
  await menuItem(page, "Rename").click();
  await expect(tabField).toBeFocused();
  await tabField.fill("Logs");
  await page.keyboard.press("Enter");
  expect(await itemLabels(page)).toEqual(["Tab 1", "Logs", "Build"]);

  // Close one tab from the menu: it goes, the active one stays.
  await openTabMenu(page, "Build");
  await menuItem(page, "Close").click();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Logs"]);
  await expect(groupCount(page, "Work")).toHaveText("2");

  // "Close others" keeps the tab and closes the rest, including a tab outside the group.
  await newTab.click();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Logs", "Tab 3"]);
  await openTabMenu(page, "Tab 1");
  await menuItem(page, "Close others").click();
  expect(await itemLabels(page)).toEqual(["Tab 1"]);
  await expect(tab(page, "Tab 1")).toHaveAttribute("aria-current", "true");
  await expect(groupCount(page, "Work")).toHaveText("1");

  // Fold it, reload: the group, its name, its fold and its count come back from state.json.
  await group(page, "Work").click();
  await expect(group(page, "Work")).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(group(page, "Work")).toBeVisible();
  await expect(group(page, "Work")).toHaveAttribute("aria-expanded", "false");
  await expect(groupCount(page, "Work")).toHaveText("1");
  await expect(tab(page, "Tab 1")).toHaveCount(0);
  await group(page, "Work").click();
  await expect(tab(page, "Tab 1")).toHaveAttribute("aria-current", "true");
});

test("Shift+click selects the visible range and the menu then closes them all", async ({
  page,
}) => {
  await page.goto("/");
  const newTab = page.getByRole("button", { name: "New tab", exact: true });
  for (let i = 0; i < 4; i++) await newTab.click();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2", "Tab 3", "Tab 4", "Tab 5"]);

  await tab(page, "Tab 2").click();
  await tab(page, "Tab 4").click({ modifiers: ["Shift"] });
  for (const name of ["Tab 2", "Tab 3", "Tab 4"]) {
    await expect(tab(page, name)).toHaveAttribute("data-nr-selected", "true");
  }
  await expect(list(page).locator('[data-nr-selected="true"]')).toHaveCount(3);

  await openTabMenu(page, "Tab 3", "Selected tabs options");
  await menuItem(page, "Close 3 tabs").click();
  // Untitled tabs are numbered by position, so the last survivor is now "Tab 2".
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2"]);
  await expect(list(page).locator('[data-nr-selected="true"]')).toHaveCount(0);
});

test("pin, favorite and move to another space from the menu", async ({ page }) => {
  await page.goto("/");
  await createSpace(page, "Beta");
  await page.getByRole("button", { name: "Main", exact: true }).click();
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  // Untitled tabs are numbered by position, so give these two names that stay put.
  await rename(page, "Tab 2", "Gamma");
  await rename(page, "Tab 1", "Alpha");
  expect(await itemLabels(page)).toEqual(["Alpha", "Gamma"]);

  // Pin: the tab goes to the top and the menu offers the way back.
  await openTabMenu(page, "Gamma");
  await menuItem(page, "Pin").click();
  await expect(tab(page, "Gamma")).toHaveAttribute("data-nr-pinned", "true");
  expect(await itemLabels(page)).toEqual(["Gamma", "Alpha"]);
  await openTabMenu(page, "Gamma");
  await expect(menuItem(page, "Unpin")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page, "Tab options")).toBeHidden();

  // Favorite: the menu shows the state.
  await openTabMenu(page, "Alpha");
  await menuItem(page, "Add to favorites").click();
  await openTabMenu(page, "Alpha");
  await expect(menuItem(page, "Remove from favorites")).toBeVisible();
  await expect(menuItem(page, "Add to favorites")).toHaveCount(0);

  // Move to another space: the tab leaves this one and shows up there.
  await menuItem(page, "Move to Beta").click();
  expect(await itemLabels(page)).toEqual(["Gamma"]);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  expect(await itemLabels(page)).toEqual(["Tab 1", "Alpha"]);
});

test("the tab menu follows the keyboard: arrows move, Escape closes, Close others is off with one tab", async ({
  page,
}) => {
  await page.goto("/");
  await openTabMenu(page, "Tab 1");
  await expect(menuItem(page, "Close others")).toBeDisabled();
  await expect(menuItem(page, "Add to new group")).toBeEnabled();
  // The first enabled entry has the focus (Rename); arrows wrap around the enabled ones.
  await expect(menuItem(page, "Rename")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItem(page, "Pin")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(menuItem(page, "Close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page, "Tab options")).toBeHidden();

  // An outside click closes it as well, and the tab is still there.
  await openTabMenu(page, "Tab 1");
  await page.mouse.click(600, 200);
  await expect(menu(page, "Tab options")).toBeHidden();
  await expect(tab(page, "Tab 1")).toBeVisible();
});

test("the group menu renames, folds and ungroups", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await tab(page, "Tab 1").click();
  await tab(page, "Tab 2").click({ modifiers: ["Control"] });
  await openTabMenu(page, "Tab 2", "Selected tabs options");
  await menuItem(page, "Add to new group").click();
  await page.keyboard.press("Enter");
  await expect(group(page, "New group")).toBeVisible();

  await group(page, "New group").click({ button: "right" });
  await expect(menu(page, "Group options")).toBeVisible();
  await menuItem(page, "Collapse").click();
  await expect(group(page, "New group")).toHaveAttribute("aria-expanded", "false");

  await group(page, "New group").click({ button: "right" });
  await menuItem(page, "Expand").click();
  await expect(tab(page, "Tab 1")).toBeVisible();

  await group(page, "New group").click({ button: "right" });
  await menuItem(page, "Rename").click();
  await page.getByRole("textbox", { name: "Group name", exact: true }).fill("Shells");
  await page.keyboard.press("Enter");
  await expect(group(page, "Shells")).toBeVisible();

  await group(page, "Shells").click({ button: "right" });
  await menuItem(page, "Ungroup").click();
  await expect(group(page, "Shells")).toHaveCount(0);
  expect(await itemLabels(page)).toEqual(["Tab 1", "Tab 2"]);
});

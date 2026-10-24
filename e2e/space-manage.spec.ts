import { expect, test } from "./test";
import type { Page } from "@playwright/test";

type TestHook = { writeCalls(): number; killedSessions(): number[]; sessionStarts(): unknown[] };
type TestWindow = Window & { __norenTest?: TestHook };

const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? 0);
const killed = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.killedSessions() ?? []);
const startCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.sessionStarts().length ?? 0);

const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });
/** Names of the space buttons, left to right (without "New space" and "Space options"). */
const spaceNames = (page: Page): Promise<string[]> =>
  switcher(page)
    .locator(".space-button:not(.space-add):not(.space-more)")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
const tabs = (page: Page) =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");
const spaceColor = (page: Page): Promise<string> =>
  page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--nr-space-color").trim().toLowerCase(),
  );

const menu = (page: Page, spaceName: string) =>
  page.getByRole("menu", { name: `${spaceName} options`, exact: true });
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Opens the menu of a space with a right click on its icon. */
async function openMenu(page: Page, spaceName: string): Promise<void> {
  await spaceButton(page, spaceName).click({ button: "right" });
  await expect(menu(page, spaceName)).toBeVisible();
}

async function openEditDialog(page: Page, spaceName: string) {
  await openMenu(page, spaceName);
  await menuItem(page, "Edit space…").click();
  const dialog = page.getByRole("dialog", { name: "Edit space", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("renames a space from its menu and the name survives a reload", async ({ page }) => {
  await page.goto("/");
  await createSpace(page, "Alpha");

  const dialog = await openEditDialog(page, "Alpha");
  // The dialog starts with what the space has.
  await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Alpha");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await spaceNames(page)).toEqual(["Main", "Renamed"]);
  await expect(spaceButton(page, "Renamed")).toHaveAttribute("data-nr-state", "active");

  await page.reload();
  await expect(spaceButton(page, "Renamed")).toBeVisible();
  expect(await spaceNames(page)).toEqual(["Main", "Renamed"]);
  await expect(spaceButton(page, "Renamed")).toHaveAttribute("data-nr-state", "active");
});

test("changing the color and the icon (Lucide, then emoji) shows at once and survives a reload", async ({
  page,
}) => {
  await page.goto("/");
  await createSpace(page, "Alpha");
  expect(await spaceColor(page)).toBe("#6b8afd");

  let dialog = await openEditDialog(page, "Alpha");
  await dialog.getByRole("radio", { name: "Coral", exact: true }).check();
  await dialog.getByRole("radio", { name: "Rocket", exact: true }).check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await spaceColor(page)).toBe("#e07a5f");
  await expect(spaceButton(page, "Alpha").locator("svg.lucide-rocket")).toHaveCount(1);

  // The dialog opens with the current choices.
  dialog = await openEditDialog(page, "Alpha");
  await expect(dialog.getByRole("radio", { name: "Coral", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Rocket", exact: true })).toBeChecked();
  await dialog.getByRole("textbox", { name: "Emoji", exact: true }).fill("🦊");
  await expect(dialog.getByRole("radio", { name: "Rocket", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, "Alpha").locator(".space-glyph")).toHaveText("🦊");
  await expect(spaceButton(page, "Alpha").locator("svg")).toHaveCount(0);

  await page.reload();
  await expect(spaceButton(page, "Alpha").locator(".space-glyph")).toHaveText("🦊");
  await expect(spaceButton(page, "Alpha")).toHaveAttribute("data-nr-state", "active");
  expect(await spaceColor(page)).toBe("#e07a5f");

  // Back to a Lucide icon: picking one clears the emoji.
  dialog = await openEditDialog(page, "Alpha");
  await expect(dialog.getByRole("textbox", { name: "Emoji", exact: true })).toHaveValue("🦊");
  await dialog.getByRole("radio", { name: "Server", exact: true }).check();
  await expect(dialog.getByRole("textbox", { name: "Emoji", exact: true })).toHaveValue("");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(spaceButton(page, "Alpha").locator("svg.lucide-server")).toHaveCount(1);
});

test("the edit dialog needs a name, accepts only one emoji and cancels without changes", async ({
  page,
}) => {
  await page.goto("/");
  const dialog = await openEditDialog(page, "Main");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the space a name.");

  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Changed");
  await dialog.getByRole("textbox", { name: "Emoji", exact: true }).fill("ab");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Use a single emoji for the icon.");
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await spaceNames(page)).toEqual(["Main"]);
});

test("deleting asks first: cancel keeps the space, confirm removes it and ends its sessions", async ({
  page,
}) => {
  await page.goto("/");
  await createSpace(page, "Beta");
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(tabs(page)).toHaveCount(2);
  // Main's shell plus the two shells of Beta are running.
  await expect.poll(() => startCount(page)).toBe(3);
  expect(await killed(page)).toEqual([]);

  // Cancel keeps it (through the "..." button, which is for the active space).
  await page.getByRole("button", { name: "Space options", exact: true }).click();
  await expect(menu(page, "Beta")).toBeVisible();
  await menuItem(page, "Delete space…").click();
  const confirm = page.getByRole("alertdialog", { name: "Delete space", exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Delete "Beta"? Its 2 tabs will be closed');
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(await spaceNames(page)).toEqual(["Main", "Beta"]);
  await expect(tabs(page)).toHaveCount(2);
  expect(await killed(page)).toEqual([]);

  // Esc cancels too.
  await openMenu(page, "Beta");
  await menuItem(page, "Delete space…").click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  expect(await spaceNames(page)).toEqual(["Main", "Beta"]);

  // Confirm removes it, activates the other space and ends exactly the two sessions of Beta.
  await openMenu(page, "Beta");
  await menuItem(page, "Delete space…").click();
  await confirm.getByRole("button", { name: "Delete space", exact: true }).click();
  await expect(confirm).toBeHidden();
  expect(await spaceNames(page)).toEqual(["Main"]);
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect(tabs(page)).toHaveCount(1);
  await expect.poll(async () => (await killed(page)).length).toBe(2);
  const ended = await killed(page);
  expect(new Set(ended).size).toBe(2);
  // Still the same after a moment: the terminal views leaving do not end anything twice.
  await page.waitForTimeout(300);
  expect(await killed(page)).toEqual(ended);

  await page.reload();
  await expect(spaceButton(page, "Main")).toBeVisible();
  expect(await spaceNames(page)).toEqual(["Main"]);
});

test("the only space has no delete option; with two, deleting the first activates the other", async ({
  page,
}) => {
  await page.goto("/");
  await openMenu(page, "Main");
  await expect(menuItem(page, "Edit space…")).toBeEnabled();
  await expect(menuItem(page, "Move left")).toBeDisabled();
  await expect(menuItem(page, "Move right")).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete space…", exact: true })).toHaveCount(0);
  // Edit, the two moves, and the background image of the space.
  await expect(page.getByRole("menuitem")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(menu(page, "Main")).toBeHidden();

  await createSpace(page, "Two");
  await spaceButton(page, "Main").click();
  await openMenu(page, "Main");
  await expect(menuItem(page, "Delete space…")).toBeVisible();
  await menuItem(page, "Delete space…").click();
  await page
    .getByRole("alertdialog", { name: "Delete space", exact: true })
    .getByRole("button", { name: "Delete space", exact: true })
    .click();
  expect(await spaceNames(page)).toEqual(["Two"]);
  await expect(spaceButton(page, "Two")).toHaveAttribute("data-nr-state", "active");

  // Back to one space: the option is gone again.
  await openMenu(page, "Two");
  await expect(page.getByRole("menuitem", { name: "Delete space…", exact: true })).toHaveCount(0);
});

test("moves a space left or right from the menu and the order survives a reload", async ({
  page,
}) => {
  await page.goto("/");
  await createSpace(page, "Beta");
  await createSpace(page, "Gamma");
  expect(await spaceNames(page)).toEqual(["Main", "Beta", "Gamma"]);

  await openMenu(page, "Gamma");
  await expect(menuItem(page, "Move right")).toBeDisabled();
  await menuItem(page, "Move left").click();
  await expect(menu(page, "Gamma")).toBeHidden();
  expect(await spaceNames(page)).toEqual(["Main", "Gamma", "Beta"]);

  await openMenu(page, "Main");
  await expect(menuItem(page, "Move left")).toBeDisabled();
  await menuItem(page, "Move right").click();
  expect(await spaceNames(page)).toEqual(["Gamma", "Main", "Beta"]);

  // Moving does not change which space is active, and the shortcuts follow the new order.
  await expect(spaceButton(page, "Gamma")).toHaveAttribute("data-nr-state", "active");
  await page.keyboard.press("Control+Alt+2");
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");

  await page.reload();
  await expect(spaceButton(page, "Main")).toBeVisible();
  expect(await spaceNames(page)).toEqual(["Gamma", "Main", "Beta"]);
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
});

test("the menu opens on the keyboard-friendly button, closes on Esc and outside clicks, and does not reach the terminal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  const before = await writeCalls(page);

  await page.getByRole("button", { name: "Space options", exact: true }).click();
  await expect(menu(page, "Main")).toBeVisible();
  // The first enabled item has the focus; arrows move through the items.
  await expect(menuItem(page, "Edit space…")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page, "Main")).toBeHidden();

  await openMenu(page, "Main");
  await page.mouse.click(600, 200);
  await expect(menu(page, "Main")).toBeHidden();

  await openMenu(page, "Main");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(menuItem(page, "Edit space…")).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await writeCalls(page)).toBe(before);
});

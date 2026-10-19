import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The command palette: Ctrl+Shift+P, tabs of every space, spaces and registry actions, the prefixes
// that limit the list, and the keyboard going back to the terminal when it closes.

type TestHook = { paneIds(): string[]; writeCalls(): number };
type TestWindow = Window & { __norenTest?: TestHook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.paneIds() ?? []);
const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? -1);

const tabList = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => tabList(page).getByRole("button", { name, exact: true });
const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });

const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const options = (page: Page): Locator => palette(page).getByRole("option");
const searchBox = (page: Page): Locator =>
  palette(page).getByRole("combobox", { name: "Command palette", exact: true });
/** The terminal's own input that holds the keyboard right now (none while the palette has it). */
const terminalFocused = (page: Page): Locator =>
  page.locator("textarea.xterm-helper-textarea:focus");

/** The kind (`tab`, `space`, `action`, `profile`, `folder`, `theme`) of every entry listed. */
const kinds = async (page: Page): Promise<string[]> => [
  ...new Set(
    await options(page).evaluateAll((all) => all.map((o) => o.getAttribute("data-nr-kind") ?? "")),
  ),
];

/** Opens the app with the tab "docs-site" in a second space "Other" and the first space on screen. */
async function twoSpaces(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Other");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");
  // Name the only tab of the new space.
  await tab(page, "Tab 1").dblclick();
  const field = page.getByRole("textbox", { name: "Tab name", exact: true });
  await field.fill("docs-site");
  await page.keyboard.press("Enter");
  await expect(field).toBeHidden();
  // Back to the first space, with its terminal holding the keyboard.
  await spaceButton(page, "Main").click();
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await expect(tab(page, "docs-site")).toHaveCount(0);
  await page.locator('[data-nr-part="pane"]:visible').click();
}

test("Ctrl+Shift+P, part of a tab name from another space and Enter switch space and focus the tab", async ({
  page,
}) => {
  await twoSpaces(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(searchBox(page)).toBeFocused();

  await page.keyboard.type("docs-s");
  await expect(options(page)).toHaveCount(1);
  // The entry names the tab, and the space it is in.
  await expect(options(page).first()).toContainText("docs-site");
  await expect(options(page).first()).toContainText("Other");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");
  await expect(tab(page, "docs-site")).toHaveAttribute("aria-current", "true");
  // The keyboard is in that tab's terminal, not left on the closed palette.
  await expect(terminalFocused(page)).toHaveCount(1);
});

test("clicking an entry runs it too, and the active terminal gets the keyboard", async ({
  page,
}) => {
  await twoSpaces(page);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("#oth");
  await expect(options(page)).toHaveCount(1);
  await options(page).first().click();
  await expect(palette(page)).toBeHidden();
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "active");
  await expect(terminalFocused(page)).toHaveCount(1);
});

test("the Split right action run from the palette splits the pane and shows its chord", async ({
  page,
}) => {
  await twoSpaces(page);
  expect(await paneIds(page)).toHaveLength(1);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">split right");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toContainText("Split right");
  await expect(options(page).first().locator("kbd")).toHaveText("Ctrl+Shift+D");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
  await expect(terminalFocused(page)).toHaveCount(1);
});

test("the chord shown follows the preset", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "noren.ui.keybindings",
      JSON.stringify({ preset: "browser", overrides: {} }),
    );
  });
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">new tab");
  await expect(options(page).first().locator("kbd")).toHaveText("Ctrl+T");
});

test("the prefixes > @ # limit the list to actions, tabs or spaces", async ({ page }) => {
  await twoSpaces(page);
  await page.keyboard.press("Control+Shift+P");
  // Nothing typed: every kind is listed.
  await expect
    .poll(() => kinds(page))
    .toEqual(["tab", "space", "action", "profile", "folder", "theme"]);
  await page.keyboard.type(">");
  // Under > the commands: actions, profiles, recent folders and themes.
  await expect.poll(() => kinds(page)).toEqual(["action", "profile", "folder", "theme"]);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  await expect.poll(() => kinds(page)).toEqual(["tab"]);
  // The two tabs of the two spaces.
  await expect(options(page)).toHaveCount(2);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("#");
  await expect.poll(() => kinds(page)).toEqual(["space"]);
  await expect(options(page)).toHaveCount(2);
  await page.keyboard.type("main");
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toContainText("Main");
});

test("text that matches nothing says so", async ({ page }) => {
  await twoSpaces(page);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("zzzzqq");
  await expect(options(page)).toHaveCount(0);
  await expect(palette(page).getByText("No results", { exact: true })).toBeVisible();
});

test("Escape closes the palette without running anything and gives the keyboard back", async ({
  page,
}) => {
  await twoSpaces(page);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type(">split right");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toBeHidden();
  expect(await paneIds(page)).toHaveLength(1);
  await expect(terminalFocused(page)).toHaveCount(1);
  // And it opens again.
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  await expect(searchBox(page)).toHaveValue("");
});

test("no shortcut acts while the palette search box has the keyboard", async ({ page }) => {
  await twoSpaces(page);
  await page.keyboard.press("Control+Shift+P");
  await expect(searchBox(page)).toBeFocused();
  const before = await writeCalls(page);
  await page.keyboard.press("Control+Shift+T");
  await page.keyboard.press("Control+Shift+D");
  await expect(tabList(page).getByRole("button")).toHaveCount(1);
  expect(await paneIds(page)).toHaveLength(1);
  expect(await writeCalls(page)).toBe(before);
  await expect(palette(page)).toBeVisible();
});

test("Open palette is in the shortcuts screen with its chord", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const screen = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(screen).toBeVisible();
  await expect(screen.getByLabel("Shortcut for Open palette", { exact: true })).toHaveText(
    "Ctrl+Shift+P",
  );
  await expect(
    screen.getByRole("button", { name: "Record shortcut for Open palette" }),
  ).toBeVisible();
});

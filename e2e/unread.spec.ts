import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { openShortcutsScreen } from "./settings-fixture";
import { sidebarState } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// A program in a tab that is not on screen rings the bell or sends a notification (OSC 9, OSC 777):
// the tab gets the unread mark, and so do its group and its space in the switcher. Ctrl+Shift+U
// goes to the one that became unread last (in any space) and reading a tab clears its marks.
// The fake shell of web mode has no program that rings, so the test hook writes the bytes to the
// terminal of a pane, as if the program had printed them.

interface Hook {
  sendOutput(paneId: string, text: string): boolean;
}
type HookWindow = Window & { __norenTest?: Hook };

const BEL = "\x07";
const osc = (body: string): string => `\x1b]${body}${BEL}`;

// Key of `state.json` in the browser storage of web mode (apps/desktop/src/web-backend.ts).
const WEB_STATE_KEY = "noren.web.state";

/**
 * The sidebar workspace without its seeded marks, so every mark in a test is one the test caused:
 * space "Main" (tabs api (p2, on screen), build (p3), logs (p4), deploy (p5), scratch (p6) and the
 * pinned notes (p1), api/build/logs in the group "Work") and space "Other" (tab elsewhere, p q1).
 */
async function seed(page: Page): Promise<void> {
  const state = JSON.parse(sidebarState({ secondSpace: true })) as {
    spaces: { items: Record<string, { layout: { pane: { unread: boolean; bell: boolean } } }> }[];
  };
  for (const space of state.spaces) {
    for (const item of Object.values(space.items)) {
      item.layout.pane.unread = false;
      item.layout.pane.bell = false;
    }
  }
  await page.addInitScript(
    ({ key, text }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, text);
    },
    { key: WEB_STATE_KEY, text: JSON.stringify(state) },
  );
}

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string): Locator =>
  list(page).getByRole("treeitem", { name, exact: true });
const group = (page: Page, name: string): Locator =>
  list(page)
    .getByRole("treeitem", { name, exact: true })
    .and(page.locator('[data-nr-part="group"]'));
const space = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "Spaces", exact: true }).getByRole("button", { name });
const mark = (where: Locator, kind: "unread" | "bell"): Locator =>
  where.locator(`[data-nr-indicator="${kind}"]`);
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
/** The title of the tab on screen (read through the title, not the lines under it). */
const shown = (page: Page): Locator =>
  list(page).locator('[data-nr-part="item"][aria-current="true"] [data-nr-part="item-title"]');

/** Writes `text` to the terminal of a pane; waits until the pane has a session to write to. */
async function send(page: Page, paneId: string, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
        { id: paneId, bytes: text },
      ),
    )
    .toBe(true);
}

test.beforeEach(async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");
});

test("a tab in the background that gets OSC 9 shows the badge on its item, its group and its space", async ({
  page,
}) => {
  // Nothing is marked before.
  await expect(page.locator("[data-nr-indicator]")).toHaveCount(0);

  await send(page, "p3", osc("9;Build finished"));
  await expect(mark(tab(page, "build"), "unread")).toHaveCount(1);
  await expect(mark(tab(page, "build"), "bell")).toHaveCount(0);
  await expect(mark(group(page, "Work"), "unread")).toHaveCount(1);
  await expect(mark(space(page, "Main"), "unread")).toHaveCount(1);
  // The other tabs, the other space and the bell are untouched.
  await expect(mark(tab(page, "logs"), "unread")).toHaveCount(0);
  await expect(mark(tab(page, "api"), "unread")).toHaveCount(0);
  await expect(mark(space(page, "Other"), "unread")).toHaveCount(0);
  await expect(mark(space(page, "Main"), "bell")).toHaveCount(0);

  // Words for assistive technology on the tab, the group and the space.
  const words = async (button: Locator): Promise<string> => {
    const id = await button.getAttribute("aria-describedby");
    return id === null ? "" : ((await page.locator(`[id="${id}"]`).textContent()) ?? "");
  };
  expect(await words(tab(page, "build"))).toContain("Unread output");
  expect(await words(group(page, "Work"))).toContain("Unread output");
  expect(await words(space(page, "Main"))).toContain("Unread output");
});

test("a bell and an OSC 777 notification mark a tab too; progress and the folder do not", async ({
  page,
}) => {
  await send(page, "p3", BEL);
  await send(page, "p4", osc("777;notify;Agent;Waiting for you"));
  await send(page, "p5", osc("9;4;1;50") + osc("9;9;/tmp") + osc("0;a title"));
  await expect(mark(tab(page, "build"), "unread")).toHaveCount(1);
  await expect(mark(tab(page, "build"), "bell")).toHaveCount(1);
  await expect(mark(tab(page, "logs"), "unread")).toHaveCount(1);
  await expect(mark(tab(page, "logs"), "bell")).toHaveCount(0);
  await expect(mark(tab(page, "deploy"), "unread")).toHaveCount(0);
  await expect(mark(tab(page, "deploy"), "bell")).toHaveCount(0);
  await expect(mark(group(page, "Work"), "bell")).toHaveCount(1);
  await expect(mark(space(page, "Main"), "bell")).toHaveCount(1);
});

test("a tab in another space marks that space in the switcher", async ({ page }) => {
  await send(page, "q1", osc("9;Done"));
  await expect(mark(space(page, "Other"), "unread")).toHaveCount(1);
  await expect(mark(space(page, "Main"), "unread")).toHaveCount(0);
  // The tabs of the space on screen are untouched.
  await expect(page.locator('[data-nr-part="item"] [data-nr-indicator]')).toHaveCount(0);
});

test("the tab on screen is never marked", async ({ page }) => {
  await send(page, "p2", BEL);
  await send(page, "p2", osc("9;hello"));
  await expect(page.locator("[data-nr-indicator]")).toHaveCount(0);
});

test("Ctrl+Shift+U goes to the tab that became unread last, in any space, and the marks clear", async ({
  page,
}) => {
  await send(page, "p3", osc("9;one"));
  await expect(mark(tab(page, "build"), "unread")).toHaveCount(1);
  // The marks are ordered by the time they were made: leave a moment between them.
  await page.waitForTimeout(30);
  await send(page, "q1", BEL);
  await expect(mark(space(page, "Other"), "unread")).toHaveCount(1);
  await expect(mark(space(page, "Other"), "bell")).toHaveCount(1);

  // The most recent first: the tab of the other space.
  await page.keyboard.press("Control+Shift+U");
  await expect(space(page, "Other")).toHaveAttribute("aria-current", "true");
  await expect(shown(page)).toHaveText("elsewhere");
  await expect(mark(space(page, "Other"), "unread")).toHaveCount(0);
  await expect(mark(space(page, "Other"), "bell")).toHaveCount(0);
  await expect(mark(tab(page, "elsewhere"), "unread")).toHaveCount(0);
  // The older mark is still there.
  await expect(mark(space(page, "Main"), "unread")).toHaveCount(1);

  // Then the older one, back in the first space; its item, group and space all clear.
  await page.keyboard.press("Control+Shift+U");
  await expect(space(page, "Main")).toHaveAttribute("aria-current", "true");
  await expect(shown(page)).toHaveText("build");
  await expect(page.locator("[data-nr-indicator]")).toHaveCount(0);

  // Nothing left: the key says so and stays where it is.
  await page.keyboard.press("Control+Shift+U");
  await expect(notice(page)).toHaveText("Nothing unread");
  await expect(shown(page)).toHaveText("build");
});

test("showing a tab by clicking it clears its marks, and the group and space with it", async ({
  page,
}) => {
  await send(page, "p4", BEL);
  await expect(mark(tab(page, "logs"), "bell")).toHaveCount(1);
  await expect(mark(group(page, "Work"), "unread")).toHaveCount(1);
  await expect(mark(space(page, "Main"), "unread")).toHaveCount(1);

  await tab(page, "logs").click();
  await expect(shown(page)).toHaveText("logs");
  await expect(page.locator("[data-nr-indicator]")).toHaveCount(0);
});

test("the marks are saved with the workspace", async ({ page }) => {
  await send(page, "p5", osc("9;Deploy finished"));
  await expect(mark(tab(page, "deploy"), "unread")).toHaveCount(1);
  // The state is written a moment after the change: wait for it, then reload.
  await expect
    .poll(() =>
      page.evaluate(
        (key) => (window.localStorage.getItem(key) ?? "").includes('"unreadAt"'),
        WEB_STATE_KEY,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(mark(tab(page, "deploy"), "unread")).toHaveCount(1);
  await expect(mark(space(page, "Main"), "unread")).toHaveCount(1);
});

test("the palette and the shortcuts screen list the action on Ctrl+Shift+U", async ({ page }) => {
  const palette = page.locator('[data-nr-part="palette"]');
  const options = palette.getByRole("option");
  // The page gets the keyboard from a click on the pane, and the palette takes it a moment after
  // the shortcut: typing before that goes to the wrong place, and so does Enter before the list is
  // filtered.
  const search = async (): Promise<void> => {
    await page.locator('[data-nr-part="pane"]:visible').first().click();
    await openCommandPalette(page);
    await expect(palette).toBeVisible();
    await expect(palette.getByRole("combobox")).toBeFocused();
    await page.keyboard.type(">last unread");
    await expect(options).toHaveCount(1);
  };

  await search();
  await expect(options.first()).toContainText("Go to last unread tab");
  await expect(options.first().locator("kbd")).toHaveText("Ctrl+Shift+U");

  // Running it from the palette goes to the unread tab.
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await send(page, "p3", osc("9;ready"));
  await expect(mark(tab(page, "build"), "unread")).toHaveCount(1);
  await search();
  await page.keyboard.press("Enter");
  await expect(shown(page)).toHaveText("build");
  await expect(page.locator("[data-nr-indicator]")).toHaveCount(0);

  const screen = await openShortcutsScreen(page);
  await expect(screen.getByLabel("Shortcut for Go to last unread tab", { exact: true })).toHaveText(
    "Ctrl+Shift+U",
  );
});

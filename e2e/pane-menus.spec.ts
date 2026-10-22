import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import {
  changeSettings,
  configText,
  openSettings,
  closeSettings,
  seedConfig,
  settingsScreen,
} from "./settings-fixture";

// Splitting the screen with the mouse (NOR-F20-07a): the menu of a tab offers Split right and Split
// down, a right click in the terminal opens a menu of its own (Copy, Paste, Split right, Split down,
// Close pane, Maximize), copy and paste straight from the right click is a setting
// (`terminal.rightClick`), and the most panes a tab holds is eight by default and a setting too
// (`terminal.maxPanes`). They run on the `FakeBackend` of web mode and read the panes from the
// model through the test hook, never from pixels; the geometry of a split is read from the boxes.

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  selection(): string;
  lines(): string[];
  sendOutput(paneId: string, text: string): boolean;
  split(dir: "row" | "column", paneId?: string): string | undefined;
}
type HookWindow = Window & { __norenTest?: Hook };

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());
const selection = (page: Page): Promise<string> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.selection() ?? "");
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const clipboard = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page: Page, text: string): Promise<void> =>
  page.evaluate((value) => navigator.clipboard.writeText(value), text);

const panes = (page: Page): Locator => page.locator('[data-nr-part="pane"]:visible');
const frame = (page: Page, paneId: string): Locator => page.locator(`[data-pane-id="${paneId}"]`);
const screenOf = (page: Page, paneId: string): Locator =>
  frame(page, paneId).locator(".xterm-screen");
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const tabs = (page: Page): Locator => page.locator('[data-nr-part="item"]');
const tabMenu = (page: Page): Locator =>
  page.getByRole("menu", { name: "Tab options", exact: true });
const terminalMenu = (page: Page): Locator =>
  page.getByRole("menu", { name: "Terminal options", exact: true });
const entry = (menu: Locator, name: string): Locator =>
  menu.getByRole("menuitem", { name, exact: true });
const names = (menu: Locator): Promise<string[]> =>
  menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.textContent ?? ""));

/** The accessible name of the box of the limit: the range is kept together by no-break spaces. */
const LIMIT_BOX = "Panes per tab (2\u00a0to\u00a016)";

const TERMINAL_ITEMS = [
  "Copy",
  "Paste",
  "Split right",
  "Split down",
  "Close pane",
  "Maximize pane",
];

/** Opens the app and waits for the first terminal to have drawn its prompt. */
async function open(page: Page, config?: string): Promise<string> {
  if (config !== undefined) await seedConfig(page, config);
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  const [first] = await paneIds(page);
  if (first === undefined) throw new Error("no pane");
  await expect
    .poll(() => lines(page).then((rows) => rows.some((r) => r.startsWith("fake$"))))
    .toBe(true);
  return first;
}

/** Right click on the screen of a pane. */
async function rightClick(page: Page, paneId: string): Promise<Locator> {
  await screenOf(page, paneId).click({ button: "right", position: { x: 60, y: 30 } });
  const menu = terminalMenu(page);
  await expect(menu).toBeVisible();
  return menu;
}

/** The box of a pane on screen. */
async function boxOf(page: Page, paneId: string) {
  const box = await frame(page, paneId).boundingBox();
  if (!box) throw new Error(`pane ${paneId} is not on screen`);
  return box;
}

test.describe("the menu of a tab", () => {
  test("offers Split right and Split down for one tab, between the groups and the output", async ({
    page,
  }) => {
    await open(page);
    await tabs(page).first().click({ button: "right" });
    const menu = tabMenu(page);
    await expect(menu).toBeVisible();
    const items = await names(menu);
    expect(items).toContain("Split right");
    expect(items).toContain("Split down");
    expect(items.indexOf("Split right")).toBe(items.indexOf("Split down") - 1);
    expect(items.indexOf("Split right")).toBeGreaterThan(items.indexOf("Add to new group"));
    expect(items.indexOf("Split down")).toBeLessThan(items.indexOf("Select command output"));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("Split right puts a second terminal beside the first, in the tab and nowhere else", async ({
    page,
  }) => {
    const first = await open(page);
    await tabs(page).first().click({ button: "right" });
    await entry(tabMenu(page), "Split right").click();
    await expect(tabMenu(page)).toHaveCount(0);

    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);
    expect(ids[0]).toBe(first);
    expect(await focusedPaneId(page)).toBe(ids[1]);
    const [a, b] = await Promise.all(ids.map((id) => boxOf(page, id)));
    if (!a || !b) throw new Error("no boxes");
    expect(b.x).toBeGreaterThan(a.x + a.width / 2);
    expect(Math.abs(b.y - a.y)).toBeLessThan(2);
    await expect(tabs(page)).toHaveCount(1);
  });

  test("Split down stacks the new terminal under the first", async ({ page }) => {
    const first = await open(page);
    await tabs(page).first().click({ button: "right" });
    await entry(tabMenu(page), "Split down").click();

    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);
    expect(ids[0]).toBe(first);
    const [a, b] = await Promise.all(ids.map((id) => boxOf(page, id)));
    if (!a || !b) throw new Error("no boxes");
    expect(b.y).toBeGreaterThan(a.y + a.height / 2);
    expect(Math.abs(b.x - a.x)).toBeLessThan(2);
  });

  test("splitting a tab that is not on screen shows it first", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expect(tabs(page).nth(1)).toHaveAttribute("aria-current", "true");
    await tabs(page).first().click({ button: "right" });
    await entry(tabMenu(page), "Split right").click();
    await expect(tabs(page).first()).toHaveAttribute("aria-current", "true");
    await expect(panes(page)).toHaveCount(2);
  });

  test("offers no split for a selection of several tabs", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await tabs(page).first().click();
    await tabs(page)
      .nth(1)
      .click({ modifiers: ["Control"] });
    await tabs(page).nth(1).click({ button: "right" });
    const menu = tabMenu(page).or(page.getByRole("menu", { name: "Selected tabs options" }));
    await expect(menu.first()).toBeVisible();
    expect(await names(menu.first())).not.toContain("Split right");
    expect(await names(menu.first())).not.toContain("Split down");
  });

  test("at the limit of panes it says so and splits nothing", async ({ page }) => {
    await open(page, '{ "terminal": { "maxPanes": 2 } }');
    await tabs(page).first().click({ button: "right" });
    await entry(tabMenu(page), "Split right").click();
    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);

    await tabs(page).first().click({ button: "right" });
    await entry(tabMenu(page), "Split down").click();
    await expect(notice(page)).toHaveText("A tab holds at most 2 panes.");
    expect(await paneIds(page)).toEqual(ids);
  });

  test("axe: the menu of a tab with the split entries has no axe violation", async ({ page }) => {
    await open(page);
    await tabs(page).first().click({ button: "right" });
    await expect(entry(tabMenu(page), "Split right")).toBeVisible();
    await expectNoAxeViolations(page, "tab menu with the split entries");
  });
});

test.describe("the menu of the terminal", () => {
  test("a right click opens it by default, with the six entries in order, and pastes nothing", async ({
    page,
  }) => {
    const first = await open(page);
    await setClipboard(page, "echo not pasted");
    const menu = await rightClick(page, first);
    expect(await names(menu)).toEqual(TERMINAL_ITEMS);
    // Nothing is selected, and the tab has one pane: those three entries have nothing to act on.
    await expect(entry(menu, "Copy")).toBeDisabled();
    await expect(entry(menu, "Close pane")).toBeDisabled();
    await expect(entry(menu, "Maximize pane")).toBeDisabled();
    await expect(entry(menu, "Paste")).toBeEnabled();
    // The keyboard is on the first entry that can be chosen, and the arrows skip the disabled ones.
    await expect(entry(menu, "Paste")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(entry(menu, "Split right")).toBeFocused();
    await page.keyboard.press("End");
    await expect(entry(menu, "Split down")).toBeFocused();
    await expect(entry(menu, "Split right")).toBeEnabled();
    await expect(entry(menu, "Split down")).toBeEnabled();
    expect((await lines(page)).some((row) => row.includes("not pasted"))).toBe(false);
  });

  test("opens at the pointer and stays inside the window", async ({ page }) => {
    const first = await open(page);
    const menu = await rightClick(page, first);
    const box = await menu.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) throw new Error("no box");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    // A right click at the far corner moves the menu back in.
    await page.keyboard.press("Escape");
    const screenBox = await screenOf(page, first).boundingBox();
    if (!screenBox) throw new Error("no screen");
    await page.mouse.click(screenBox.x + screenBox.width - 4, screenBox.y + screenBox.height - 4, {
      button: "right",
    });
    const corner = await terminalMenu(page).boundingBox();
    if (!corner) throw new Error("no menu");
    expect(corner.x + corner.width).toBeLessThanOrEqual(view.width);
    expect(corner.y + corner.height).toBeLessThanOrEqual(view.height);
  });

  test("Paste puts the clipboard at the prompt, and a paste of several lines still asks first", async ({
    page,
  }) => {
    const first = await open(page);
    await setClipboard(page, "echo from the menu");
    const menu = await rightClick(page, first);
    await entry(menu, "Paste").click();
    await expect(terminalMenu(page)).toHaveCount(0);
    await expect
      .poll(async () => (await lines(page)).includes("fake$ echo from the menu"))
      .toBe(true);

    await setClipboard(page, "echo one\necho two");
    await entry(await rightClick(page, first), "Paste").click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Paste 2 lines?", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test("Copy takes the selection to the clipboard and keeps it selected", async ({ page }) => {
    const first = await open(page);
    await screenOf(page, first).dblclick({ position: { x: 20, y: 6 } });
    await expect.poll(() => selection(page)).not.toBe("");
    const selected = await selection(page);
    await setClipboard(page, "before");
    const menu = await rightClick(page, first);
    await expect(entry(menu, "Copy")).toBeEnabled();
    await expect(entry(menu, "Copy")).toBeFocused();
    await entry(menu, "Copy").click();
    await expect(terminalMenu(page)).toHaveCount(0);
    await expect.poll(() => clipboard(page)).toBe(selected);
    // The menu leaves the selection alone, and the keyboard is the terminal's again.
    expect(await selection(page)).toBe(selected);
    await page.keyboard.type("echo kept");
    await expect.poll(async () => (await lines(page)).includes("fake$ echo kept")).toBe(true);
  });

  test("Escape closes it without a choice and gives the keyboard back to the terminal", async ({
    page,
  }) => {
    const first = await open(page);
    const menu = await rightClick(page, first);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await page.keyboard.type("echo after escape");
    await expect
      .poll(async () => (await lines(page)).includes("fake$ echo after escape"))
      .toBe(true);
    expect(await paneIds(page)).toHaveLength(1);
  });

  test("Split right and Split down split the pane that was clicked, not the focused one", async ({
    page,
  }) => {
    const first = await open(page);
    await entry(await rightClick(page, first), "Split right").click();
    await expect(panes(page)).toHaveCount(2);
    const [, second] = await paneIds(page);
    if (second === undefined) throw new Error("no second pane");
    expect(await focusedPaneId(page)).toBe(second);

    // The second pane has the focus; the menu is opened on the first, and splits the first.
    await entry(await rightClick(page, first), "Split down").click();
    await expect(panes(page)).toHaveCount(3);
    const ids = await paneIds(page);
    expect(ids[0]).toBe(first);
    expect(ids[2]).toBe(second);
    const added = ids[1];
    if (added === undefined) throw new Error("no added pane");
    expect(await focusedPaneId(page)).toBe(added);
    const [a, n] = await Promise.all([boxOf(page, first), boxOf(page, added)]);
    expect(n.y).toBeGreaterThan(a.y + a.height / 2);
    expect(Math.abs(n.x - a.x)).toBeLessThan(2);
  });

  test("Close pane closes the one that was clicked, and the others stay", async ({ page }) => {
    const first = await open(page);
    await entry(await rightClick(page, first), "Split right").click();
    await expect(panes(page)).toHaveCount(2);
    const [, second] = await paneIds(page);
    if (second === undefined) throw new Error("no second pane");

    const menu = await rightClick(page, first);
    await expect(entry(menu, "Close pane")).toBeEnabled();
    await entry(menu, "Close pane").click();
    await expect(panes(page)).toHaveCount(1);
    expect(await paneIds(page)).toEqual([second]);
    expect(await focusedPaneId(page)).toBe(second);
  });

  test("Maximize pane fills the tab with the pane, and the same entry gives it back", async ({
    page,
  }) => {
    const first = await open(page);
    await entry(await rightClick(page, first), "Split right").click();
    await expect(panes(page)).toHaveCount(2);
    const [, second] = await paneIds(page);
    if (second === undefined) throw new Error("no second pane");

    await entry(await rightClick(page, first), "Maximize pane").click();
    await expect(frame(page, first)).toHaveAttribute("data-nr-zoom", "zoomed");
    await expect(frame(page, second)).toHaveAttribute("data-nr-zoom", "hidden");
    expect(await focusedPaneId(page)).toBe(first);
    await expect(panes(page)).toHaveCount(1);

    const menu = await rightClick(page, first);
    expect(await names(menu)).toEqual([
      "Copy",
      "Paste",
      "Split right",
      "Split down",
      "Close pane",
      "Restore pane",
    ]);
    await entry(menu, "Restore pane").click();
    await expect(panes(page)).toHaveCount(2);
    await expect(frame(page, first)).not.toHaveAttribute("data-nr-zoom", /.+/);
  });

  test("at the limit of panes it says so and splits nothing", async ({ page }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 2 } }');
    await entry(await rightClick(page, first), "Split right").click();
    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);
    await entry(await rightClick(page, first), "Split down").click();
    await expect(notice(page)).toHaveText("A tab holds at most 2 panes.");
    expect(await paneIds(page)).toEqual(ids);
    await expect(panes(page)).toHaveCount(2);
  });

  test("axe: the menu of the terminal has no axe violation, with a selection and in a split", async ({
    page,
  }) => {
    const first = await open(page);
    await rightClick(page, first);
    await expectNoAxeViolations(page, "terminal menu");
    await page.keyboard.press("Escape");

    await entry(await rightClick(page, first), "Split right").click();
    await expect(panes(page)).toHaveCount(2);
    // The terminal of the first pane is drawn again when the tab becomes a split and starts blank:
    // the shell says something, a first click gives the pane the focus, then a word is selected.
    await page.evaluate(
      (id) => (window as HookWindow).__norenTest?.sendOutput(id, "\x1b[2J\x1b[Hword here\r\n"),
      first,
    );
    await screenOf(page, first).click({ position: { x: 60, y: 30 } });
    await expect.poll(() => focusedPaneId(page)).toBe(first);
    await screenOf(page, first).dblclick({ position: { x: 20, y: 6 } });
    await expect.poll(() => selection(page)).not.toBe("");
    const menu = await rightClick(page, first);
    await expect(entry(menu, "Copy")).toBeEnabled();
    await expect(entry(menu, "Close pane")).toBeEnabled();
    await expectNoAxeViolations(page, "terminal menu in a split, with a selection");
  });
});

test.describe("copy and paste straight from the right click", () => {
  test("is off by default: the settings screen shows the menu as the choice", async ({ page }) => {
    await open(page);
    const screen = await openSettings(page);
    const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
    // Three long names are a drop-down list: the menu is the value chosen, the others are its options.
    const rightClick = terminal.getByRole("combobox", {
      name: "Right click in the terminal",
      exact: true,
    });
    await expect(rightClick).toHaveValue("menu");
    await expect(rightClick.locator("option:checked")).toHaveText("Open a menu");
    await expect(rightClick.locator("option")).toHaveText([
      "Open a menu",
      "Copy the selection, or paste",
      "Always paste",
    ]);
    await page.keyboard.press("Escape");
  });

  test("the setting copy-or-paste pastes with nothing selected and copies with a selection", async ({
    page,
  }) => {
    const first = await open(page, '{ "terminal": { "rightClick": "copy-or-paste" } }');
    await setClipboard(page, "echo direct");
    await screenOf(page, first).click({ button: "right", position: { x: 60, y: 30 } });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(async () => (await lines(page)).includes("fake$ echo direct")).toBe(true);

    await page.keyboard.press("Control+u");
    await screenOf(page, first).dblclick({ position: { x: 20, y: 6 } });
    await expect.poll(() => selection(page)).not.toBe("");
    const selected = await selection(page);
    await setClipboard(page, "before");
    await screenOf(page, first).click({ button: "right", position: { x: 60, y: 30 } });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(() => clipboard(page)).toBe(selected);
    expect(await selection(page)).toBe("");
  });

  test("the setting paste pastes even with a selection", async ({ page }) => {
    const first = await open(page, '{ "terminal": { "rightClick": "paste" } }');
    await screenOf(page, first).dblclick({ position: { x: 20, y: 6 } });
    await expect.poll(() => selection(page)).not.toBe("");
    await setClipboard(page, "echo always");
    await screenOf(page, first).click({ button: "right", position: { x: 60, y: 30 } });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect
      .poll(async () => (await lines(page)).some((r) => r.includes("echo always")))
      .toBe(true);
  });

  test("a choice made in the settings screen counts at once and is written into the file", async ({
    page,
  }) => {
    const first = await open(page);
    await changeSettings(page, async (screen) => {
      const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
      await terminal
        .getByRole("combobox", { name: "Right click in the terminal", exact: true })
        .selectOption({ label: "Copy the selection, or paste" });
    });
    expect(await configText(page)).toContain('"rightClick": "copy-or-paste"');

    await setClipboard(page, "echo saved");
    await screenOf(page, first).click({ button: "right", position: { x: 60, y: 30 } });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(async () => (await lines(page)).includes("fake$ echo saved")).toBe(true);

    // And back to the menu.
    await changeSettings(page, async (screen) => {
      const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
      await terminal
        .getByRole("combobox", { name: "Right click in the terminal", exact: true })
        .selectOption({ label: "Open a menu" });
    });
    await rightClick(page, first);
  });
});

test.describe("the limit of panes of a tab", () => {
  test("is eight by default: the ninth pane is refused with a notice, by the shortcut and by the menus", async ({
    page,
  }) => {
    const first = await open(page);
    await frame(page, first).click();
    for (let n = 1; n < 8; n++) {
      await page.keyboard.press(n % 2 === 0 ? "Control+Shift+E" : "Control+Shift+D");
      await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(n + 1);
    }
    const ids = await paneIds(page);
    expect(ids).toHaveLength(8);
    await expect(notice(page)).toHaveText("");

    await page.keyboard.press("Control+Shift+D");
    await expect(notice(page)).toHaveText("A tab holds at most 8 panes.");
    expect(await paneIds(page)).toEqual(ids);

    await expect(panes(page)).toHaveCount(8);
    await entry(await rightClick(page, first), "Split right").click();
    await expect(notice(page)).toHaveText("A tab holds at most 8 panes.");
    expect(await paneIds(page)).toEqual(ids);

    await tabs(page).first().click({ button: "right" });
    await entry(tabMenu(page), "Split down").click();
    await expect(notice(page)).toHaveText("A tab holds at most 8 panes.");
    expect(await paneIds(page)).toEqual(ids);
  });

  test("a tab grown to eight panes makes the browser take no WebGL context away from a terminal", async ({
    page,
  }) => {
    // Chromium lets a page hold 16 contexts and takes the oldest away past that; a split draws the
    // pane that was split again, so 8 panes make more than 16 terminals over time. The contexts of the
    // terminals that go are freed at once, so the ones left are all the browser has to count.
    await page.addInitScript(() => {
      const seen = new WeakSet<object>();
      const count = { made: 0, lost: 0 };
      (window as Window & { __gl?: typeof count }).__gl = count;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        const context = (original as (...args: unknown[]) => unknown).call(this, type, ...rest);
        if (type === "webgl2" && context !== null && !seen.has(this)) {
          seen.add(this);
          count.made++;
          // A canvas that is still in the page lost its context to the browser; one that left it was
          // freed by the terminal that drew on it.
          this.addEventListener("webglcontextlost", () => {
            if (this.isConnected) count.lost++;
          });
        }
        return context;
      } as typeof original;
    });
    const first = await open(page);
    await frame(page, first).click();
    for (let n = 1; n < 8; n++) {
      await page.keyboard.press(n % 2 === 0 ? "Control+Shift+E" : "Control+Shift+D");
      await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(n + 1);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1000);
    const count = await page.evaluate(
      () => (window as Window & { __gl?: { made: number; lost: number } }).__gl,
    );
    // More than 16 contexts were made over the splits (so the check can fail), and none was taken away.
    expect(count?.made ?? 0).toBeGreaterThan(16);
    expect(count?.lost).toBe(0);
  });

  test("is the number the file sets: three panes fit, the fourth is refused", async ({ page }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 3 } }');
    await frame(page, first).click();
    await page.keyboard.press("Control+Shift+D");
    await page.keyboard.press("Control+Shift+E");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(3);
    const ids = await paneIds(page);
    await page.keyboard.press("Control+Shift+D");
    await expect(notice(page)).toHaveText("A tab holds at most 3 panes.");
    expect(await paneIds(page)).toEqual(ids);
  });

  test("a larger limit lets a tab hold more than eight", async ({ page }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 10 } }');
    await frame(page, first).click();
    for (let n = 1; n < 10; n++) {
      await page.keyboard.press(n % 2 === 0 ? "Control+Shift+E" : "Control+Shift+D");
      await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(n + 1);
    }
    await expect(panes(page)).toHaveCount(10);
    await page.keyboard.press("Control+Shift+D");
    await expect(notice(page)).toHaveText("A tab holds at most 10 panes.");
  });

  test("a change in the settings screen counts at once, and the file keeps it", async ({
    page,
  }) => {
    const first = await open(page);
    const screen = await openSettings(page);
    const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
    const box = terminal.getByRole("textbox", { name: LIMIT_BOX, exact: true });
    await expect(box).toHaveValue("8");
    await box.fill("2");
    await closeSettings(page);
    expect(await configText(page)).toContain('"maxPanes": 2');

    await frame(page, first).click();
    await page.keyboard.press("Control+Shift+D");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
    await page.keyboard.press("Control+Shift+D");
    await expect(notice(page)).toHaveText("A tab holds at most 2 panes.");
  });

  test("lowering it closes nothing: a tab with more panes keeps them and only refuses to grow", async ({
    page,
  }) => {
    const first = await open(page);
    await frame(page, first).click();
    for (let n = 1; n < 5; n++) {
      await page.keyboard.press("Control+Shift+D");
      await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(n + 1);
    }
    const ids = await paneIds(page);
    await changeSettings(page, async (screen) => {
      const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
      await terminal.getByRole("textbox", { name: LIMIT_BOX, exact: true }).fill("3");
    });
    expect(await paneIds(page)).toEqual(ids);
    await page.keyboard.press("Control+Shift+D");
    await expect(notice(page)).toHaveText("A tab holds at most 3 panes.");
    expect(await paneIds(page)).toEqual(ids);
    // And a reload reads the state with its five panes: it is not sent away for being over the limit.
    await expect.poll(async () => (await configText(page)) ?? "").toContain('"maxPanes": 3');
    await page.waitForTimeout(700);
    await page.reload();
    await expect.poll(() => paneIds(page).then((rows) => rows.length)).toBe(5);
  });

  test("a value out of the range is shown where it is typed and nothing is written for it", async ({
    page,
  }) => {
    await open(page);
    const screen = await openSettings(page);
    const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
    const box = terminal.getByRole("textbox", { name: LIMIT_BOX, exact: true });
    for (const wrong of ["1", "17", "4.5", "many", ""]) {
      await box.fill(wrong);
      await expect(box).toHaveAttribute("aria-invalid", "true");
      await expect(terminal).toContainText("A whole number of panes, from 2 to 16.");
    }
    await page.waitForTimeout(700);
    expect(await configText(page)).toBeNull();
    // A value in the range is written, with no Save to press.
    await box.fill("16");
    await expect(box).not.toHaveAttribute("aria-invalid", "true");
    await expect.poll(async () => (await configText(page)) ?? "").toContain('"maxPanes": 16');
    await page.keyboard.press("Escape");
    await expect(settingsScreen(page)).toHaveCount(0);
  });

  test("a file with a value out of the range is refused with its line, and the default stays", async ({
    page,
  }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 40 } }');
    await expect(page.locator('[data-nr-part="config-notice"]')).toBeVisible();
    await frame(page, first).click();
    for (let n = 1; n < 8; n++) {
      await page.keyboard.press("Control+Shift+D");
      await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(n + 1);
    }
    await page.keyboard.press("Control+Shift+D");
    await expect(notice(page)).toHaveText("A tab holds at most 8 panes.");
  });
});

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { changeSettings, denseOf, seedConfig } from "./settings-fixture";

// The split buttons in the corner of a pane (NOR-F20-07b): two small buttons, Split right and Split
// down, that show while the mouse is over a terminal pane (or the keyboard is on one of them) and
// split that pane, up to `terminal.maxPanes`. They run on the `FakeBackend` of web mode and read the
// panes from the model through the test hook and the geometry from the boxes, never from pixels.
//
// The hover corner is the dense style's. Under the glass style (the default) the two buttons are in the
// header of every terminal pane, always in sight (NOR-F20-18c, e2e/glass-panes.spec.ts); the tests that
// are about the corner itself (out of sight until the mouse is over, its geometry, its place under the
// header of the settings) start from the dense style, and the others (what a button does, the limit, the
// names) run under both.

interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  lines(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());
const lines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);

const panes = (page: Page): Locator => page.locator('[data-nr-part="pane"]:visible');
const frame = (page: Page, paneId: string): Locator => page.locator(`[data-pane-id="${paneId}"]`);
const corner = (page: Page, paneId: string): Locator =>
  frame(page, paneId).locator('[data-nr-part="pane-corner"]');
const splitRight = (page: Page, paneId: string, name = "Split right"): Locator =>
  frame(page, paneId).getByRole("button", { name, exact: true });
const splitDown = (page: Page, paneId: string, name = "Split down"): Locator =>
  frame(page, paneId).getByRole("button", { name, exact: true });
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');

/** Opens the app and waits for the first terminal to have drawn its prompt; `dense` starts from the dense style. */
async function open(page: Page, config?: string, dense = false): Promise<string> {
  if (dense) await seedConfig(page, denseOf(config ?? "{}"));
  else if (config !== undefined) await seedConfig(page, config);
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  const [first] = await paneIds(page);
  if (first === undefined) throw new Error("no pane");
  await expect
    .poll(() => lines(page).then((rows) => rows.some((r) => r.startsWith("fake$"))))
    .toBe(true);
  return first;
}

/** Puts the mouse over a pane, away from its corner. */
async function overPane(page: Page, paneId: string): Promise<void> {
  const box = await boxOf(page, paneId);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

async function boxOf(page: Page, locator: string | Locator) {
  const target = typeof locator === "string" ? frame(page, locator) : locator;
  const box = await target.boundingBox();
  if (!box) throw new Error("not on screen");
  return box;
}

/** Splits with the shortcut until the tab has `count` panes. */
async function growTo(page: Page, first: string, count: number): Promise<void> {
  await frame(page, first).click();
  for (let n = 1; n < count; n++) {
    await page.keyboard.press(n % 2 === 0 ? "Control+Shift+E" : "Control+Shift+D");
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(n + 1);
  }
}

test.describe("the split buttons in the corner of a pane", () => {
  test("are out of sight until the mouse is over the pane, and are named", async ({ page }) => {
    const first = await open(page, undefined, true);
    await page.mouse.move(2, 2);
    await expect(corner(page, first)).toHaveCSS("opacity", "0");
    await overPane(page, first);
    await expect(corner(page, first)).toHaveCSS("opacity", "1");
    await expect(splitRight(page, first)).toBeVisible();
    await expect(splitDown(page, first)).toBeVisible();
    await expect(splitRight(page, first)).toHaveAttribute("title", "Split right");
    await page.mouse.move(2, 2);
    await expect(corner(page, first)).toHaveCSS("opacity", "0");
  });

  test("Split right puts a second terminal beside the pane and gives it the focus", async ({
    page,
  }) => {
    const first = await open(page);
    await overPane(page, first);
    await splitRight(page, first).click();
    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);
    expect(ids[0]).toBe(first);
    expect(await focusedPaneId(page)).toBe(ids[1]);
    const [a, b] = await Promise.all(ids.map((id) => boxOf(page, id)));
    if (!a || !b) throw new Error("no boxes");
    expect(b.x).toBeGreaterThan(a.x + a.width / 2);
    expect(Math.abs(b.y - a.y)).toBeLessThan(2);
    expect(Math.abs(b.height - a.height)).toBeLessThan(2);
  });

  test("Split down stacks the second terminal under the pane", async ({ page }) => {
    const first = await open(page);
    await overPane(page, first);
    await splitDown(page, first).click();
    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);
    expect(ids[0]).toBe(first);
    const [a, b] = await Promise.all(ids.map((id) => boxOf(page, id)));
    if (!a || !b) throw new Error("no boxes");
    expect(b.y).toBeGreaterThan(a.y + a.height / 2);
    expect(Math.abs(b.x - a.x)).toBeLessThan(2);
    expect(Math.abs(b.width - a.width)).toBeLessThan(2);
  });

  test("split the pane they are on, not the one with the focus", async ({ page }) => {
    const first = await open(page);
    await growTo(page, first, 2);
    const [left, right] = await paneIds(page);
    if (left === undefined || right === undefined) throw new Error("no panes");
    expect(await focusedPaneId(page)).toBe(right);
    const rightBefore = await boxOf(page, right);

    // The left pane is not the focused one: its own corner splits it, under it.
    await overPane(page, left);
    await splitDown(page, left).click();
    await expect(panes(page)).toHaveCount(3);
    const ids = await paneIds(page);
    const added = ids.find((id) => id !== left && id !== right);
    if (added === undefined) throw new Error("no new pane");
    const a = await boxOf(page, left);
    const n = await boxOf(page, added);
    const r = await boxOf(page, right);
    expect(n.y).toBeGreaterThan(a.y + a.height / 2);
    expect(Math.abs(n.x - a.x)).toBeLessThan(2);
    // The pane that was not split keeps its column.
    expect(Math.abs(r.x - rightBefore.x)).toBeLessThan(2);
    expect(Math.abs(r.width - rightBefore.width)).toBeLessThan(2);
    expect(await focusedPaneId(page)).toBe(added);
  });

  test("sit in the top right corner and cover nothing of the pane but that corner", async ({
    page,
  }) => {
    const first = await open(page, undefined, true);
    await growTo(page, first, 2);
    for (const id of await paneIds(page)) {
      await overPane(page, id);
      await expect(corner(page, id)).toHaveCSS("opacity", "1");
      const pane = await boxOf(page, id);
      const box = await boxOf(page, corner(page, id));
      const right = await boxOf(page, splitRight(page, id));
      const down = await boxOf(page, splitDown(page, id));
      // Inside the pane, in its top right corner, small, and clear of the scrollbar.
      expect(box.x).toBeGreaterThan(pane.x + pane.width / 2);
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width - 8);
      expect(box.y).toBeGreaterThanOrEqual(pane.y);
      expect(box.y).toBeLessThan(pane.y + 12);
      expect(box.width).toBeLessThan(80);
      expect(box.height).toBeLessThan(40);
      expect(box.width * box.height).toBeLessThan(pane.width * pane.height * 0.05);
      // Side by side, not on top of each other, and each a target a mouse can hit.
      expect(down.x).toBeGreaterThanOrEqual(right.x + right.width);
      expect(Math.abs(down.y - right.y)).toBeLessThan(2);
      expect(right.width).toBeGreaterThanOrEqual(20);
      expect(right.height).toBeGreaterThanOrEqual(20);
    }
  });

  test("show when the keyboard is on one of them, with the mouse far away", async ({ page }) => {
    const first = await open(page, undefined, true);
    await page.mouse.move(2, 2);
    await expect(corner(page, first)).toHaveCSS("opacity", "0");
    await splitRight(page, first).focus();
    await expect(corner(page, first)).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(splitDown(page, first)).toBeFocused();
    await expect(corner(page, first)).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(panes(page)).toHaveCount(2);
    const [a, b] = await Promise.all((await paneIds(page)).map((id) => boxOf(page, id)));
    if (!a || !b) throw new Error("no boxes");
    expect(b.y).toBeGreaterThan(a.y + a.height / 2);
  });

  test("a tab with a pane limit of two: both buttons are off when it holds two", async ({
    page,
  }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 2 } }');
    await overPane(page, first);
    await expect(splitRight(page, first)).toBeEnabled();
    await splitRight(page, first).click();
    await expect(panes(page)).toHaveCount(2);
    for (const id of await paneIds(page)) {
      await expect(splitRight(page, id)).toBeDisabled();
      await expect(splitDown(page, id)).toBeDisabled();
    }
    const ids = await paneIds(page);
    // A click on an off button changes nothing.
    await overPane(page, ids[0] ?? first);
    await splitDown(page, ids[0] ?? first).click({ force: true });
    await page.waitForTimeout(200);
    expect(await paneIds(page)).toEqual(ids);
  });

  test("eight panes fit, then the buttons of all eight are off; closing one turns them on", async ({
    page,
  }) => {
    const first = await open(page);
    await overPane(page, first);
    // Eight panes made only with the buttons of the corners (the one of the last pane each time).
    for (let n = 1; n < 8; n++) {
      const ids = await paneIds(page);
      const last = ids[ids.length - 1];
      if (last === undefined) throw new Error("no pane");
      await overPane(page, last);
      await (n % 2 === 0 ? splitDown(page, last) : splitRight(page, last)).click();
      await expect.poll(() => paneIds(page).then((rows) => rows.length)).toBe(n + 1);
    }
    for (const id of await paneIds(page)) {
      await expect(splitRight(page, id)).toBeDisabled();
      await expect(splitDown(page, id)).toBeDisabled();
    }
    await frame(page, (await paneIds(page))[7] ?? first).click();
    await page.keyboard.press("Control+Shift+W");
    await expect.poll(() => paneIds(page).then((rows) => rows.length)).toBe(7);
    for (const id of await paneIds(page)) await expect(splitRight(page, id)).toBeEnabled();
  });

  test("follow the setting while the app runs: raising the limit turns them on", async ({
    page,
  }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 2 } }');
    await growTo(page, first, 2);
    const ids = await paneIds(page);
    await expect(splitRight(page, ids[0] ?? first)).toBeDisabled();
    await changeSettings(page, async (screen) => {
      const terminal = screen.getByRole("region", { name: "Terminal options", exact: true });
      await terminal
        .getByRole("textbox", { name: "Panes per tab (2 to 16)", exact: true })
        .fill("3");
    });
    await expect(splitRight(page, ids[0] ?? first)).toBeEnabled();
    await overPane(page, ids[0] ?? first);
    await splitRight(page, ids[0] ?? first).click();
    await expect(panes(page)).toHaveCount(3);
    await expect(notice(page)).not.toHaveText(/at most/);
  });

  test("start under the header of the pane when the headers are on", async ({ page }) => {
    const first = await open(page, '{ "appearance": { "paneHeaders": true } }', true);
    await growTo(page, first, 2);
    for (const id of await paneIds(page)) {
      await overPane(page, id);
      const header = await boxOf(page, frame(page, id).locator('[data-nr-part="pane-header"]'));
      const box = await boxOf(page, corner(page, id));
      expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
    }
  });

  test("have the names of the language of the interface", async ({ page }) => {
    const first = await open(page, '{ "language": "pt-BR" }');
    await overPane(page, first);
    await expect(splitRight(page, first, "Dividir à direita")).toBeVisible();
    await expect(splitDown(page, first, "Dividir abaixo")).toBeVisible();
    await splitRight(page, first, "Dividir à direita").click();
    await expect(panes(page)).toHaveCount(2);
  });

  test("axe: the page has no violation with the buttons on screen, on and off", async ({
    page,
  }) => {
    const first = await open(page, '{ "terminal": { "maxPanes": 2 } }', true);
    await overPane(page, first);
    await expect(corner(page, first)).toHaveCSS("opacity", "1");
    await expectNoAxeViolations(page, "a pane with the split buttons on");
    await splitRight(page, first).click();
    await expect(panes(page)).toHaveCount(2);
    const ids = await paneIds(page);
    await overPane(page, ids[0] ?? first);
    await expect(corner(page, ids[0] ?? first)).toHaveCSS("opacity", "1");
    await expectNoAxeViolations(page, "a pane with the split buttons off at the limit");
  });
});

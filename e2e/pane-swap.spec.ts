import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { setPaneHeaders } from "./settings-fixture";
import { numberTheTabs } from "./numbered-tabs";

test.beforeEach(numberTheTabs);

// Dragging a pane's header onto the middle of another pane swaps them; the header also detaches
// a pane into a tab of its own.

type Hook = {
  paneIds(): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
};

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.paneIds() ?? []);

/** Splits the focused pane of the tab on screen to the right. */
const splitRight = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.split("row"));

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const swapZone = (page: Page) => page.locator('[data-nr-part="pane-swap-zone"]');
const joinZone = (page: Page) => page.locator('[data-nr-part="pane-drop-zone"]');
const frame = (page: Page, paneId: string) => page.locator(`[data-pane-id="${paneId}"]`);
const title = (page: Page, paneId: string) => frame(page, paneId).locator(".pane-header-title");
const detach = (page: Page, paneId: string) =>
  frame(page, paneId).getByRole("button", { name: "Detach pane", exact: true });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

/** Turns the "Pane headers" preference on, in the settings screen. */
async function showHeaders(page: Page): Promise<void> {
  await setPaneHeaders(page, true);
}

/** One tab with the headers on; returns its only pane. */
async function oneTab(page: Page): Promise<string> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await showHeaders(page);
  const [first] = await paneIds(page);
  if (first === undefined) throw new Error("no pane");
  return first;
}

/** One tab with two panes side by side; returns them left to right. */
async function twoPanes(page: Page): Promise<[string, string]> {
  const first = await oneTab(page);
  const second = await splitRight(page);
  if (second === undefined) throw new Error("the split was refused");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
  expect(await paneIds(page)).toEqual([first, second]);
  return [first, second];
}

/** Presses on the title of a pane header and drags it to `to`; the caller drops with the mouse. */
async function dragHeaderTo(page: Page, paneId: string, to: { x: number; y: number }) {
  const from = await box(title(page, paneId));
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A first small step crosses the activation distance, then the pointer travels in steps.
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  return { drop: () => page.mouse.up() };
}

const at = (
  b: { x: number; y: number; width: number; height: number },
  fx: number,
  fy: number,
) => ({
  x: b.x + b.width * fx,
  y: b.y + b.height * fy,
});

test("dropping a pane header on the middle of another pane swaps the two", async ({ page }) => {
  const [first, second] = await twoPanes(page);
  const left = await box(frame(page, first));
  const right = await box(frame(page, second));
  expect(left.x).toBeLessThan(right.x);

  const drag = await dragHeaderTo(page, first, at(right, 0.5, 0.5));
  // The swap zone shows in the pane under the pointer, and no join zone does.
  await expect(swapZone(page)).toHaveCount(1);
  await expect(frame(page, second).locator('[data-nr-part="pane-swap-zone"]')).toHaveCount(1);
  await expect(joinZone(page)).toHaveCount(0);
  await drag.drop();

  await expect(swapZone(page)).toHaveCount(0);
  await expect.poll(() => paneIds(page)).toEqual([second, first]);
  const nowFirst = await box(frame(page, first));
  const nowSecond = await box(frame(page, second));
  expect(nowFirst.x).toBeGreaterThan(nowSecond.x);
  expect(Math.abs(nowFirst.y - nowSecond.y)).toBeLessThan(2);
});

test("dropping a pane header on itself, on an edge or outside the panes changes nothing", async ({
  page,
}) => {
  const [first, second] = await twoPanes(page);
  const left = await box(frame(page, first));
  const right = await box(frame(page, second));

  // On its own middle.
  const own = await dragHeaderTo(page, first, at(left, 0.5, 0.5));
  await expect(swapZone(page)).toHaveCount(0);
  await own.drop();
  expect(await paneIds(page)).toEqual([first, second]);

  // On an edge of the other pane: not a swap, and a pane is not joined somewhere else.
  const edge = await dragHeaderTo(page, first, at(right, 0.9, 0.5));
  await expect(swapZone(page)).toHaveCount(0);
  await expect(joinZone(page)).toHaveCount(0);
  await edge.drop();
  expect(await paneIds(page)).toEqual([first, second]);

  // Over the sidebar.
  const side = await box(page.getByRole("complementary", { name: "Sidebar", exact: true }));
  const away = await dragHeaderTo(page, first, at(side, 0.5, 0.5));
  await expect(swapZone(page)).toHaveCount(0);
  await away.drop();
  expect(await paneIds(page)).toEqual([first, second]);
  await expect(row(page, "Tab 1")).toBeVisible();
});

test("Detach pane moves a pane to a new tab right after its tab", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await showHeaders(page);
  // A second tab, so "right after" can be told from "at the end".
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(row(page, "Tab 2")).toBeVisible();
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  const [other] = await paneIds(page);
  await row(page, "Tab 1").click();
  const [first] = await paneIds(page);
  if (other === undefined || first === undefined || other === first) throw new Error("no panes");
  const second = await splitRight(page);
  if (second === undefined) throw new Error("the split was refused");
  await expect.poll(() => paneIds(page)).toEqual([first, second]);

  await detach(page, second).click();

  // The tab keeps one pane; the detached one has a tab of its own between Tab 1 and the old Tab 2.
  await expect.poll(() => paneIds(page)).toEqual([first]);
  await expect(row(page, "Tab 3")).toBeVisible();
  const tab2 = await box(row(page, "Tab 2"));
  const tab3 = await box(row(page, "Tab 3"));
  expect(tab2.y).toBeLessThan(tab3.y);

  await row(page, "Tab 2").click();
  await expect.poll(() => paneIds(page)).toEqual([second]);
  await row(page, "Tab 3").click();
  await expect.poll(() => paneIds(page)).toEqual([other]);
  // The tab it came from has one pane left, so its header has nothing to detach.
  await row(page, "Tab 1").click();
  await expect.poll(() => paneIds(page)).toEqual([first]);
  await expect(detach(page, first)).toHaveCount(0);
});

test("a tab with one pane has no Detach pane button", async ({ page }) => {
  const only = await oneTab(page);
  await expect(frame(page, only).locator('[data-nr-part="pane-header"]')).toBeVisible();
  await expect(detach(page, only)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Detach pane", exact: true })).toHaveCount(0);
});

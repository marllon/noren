import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// Dragging a tab of the sidebar onto a pane of the tab on screen joins the two tabs.

type Hook = {
  paneIds(): string[];
  paneLines(paneId: string): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
};

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.paneIds() ?? []);

const paneLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate(
    (id) =>
      (window as Window & { __norenTest?: Hook }).__norenTest?.paneLines(id) ?? ["no test hook"],
    paneId,
  );

/** Splits the focused pane of the tab on screen to the right. */
const splitRight = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.split("row"));

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const zone = (page: Page) => page.locator('[data-nr-part="pane-drop-zone"]');
const notice = (page: Page) =>
  page.getByRole("status").filter({ hasText: "A tab holds at most 4 panes." });
const frame = (page: Page, paneId: string) => page.locator(`[data-pane-id="${paneId}"]`);

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("not on screen");
  return found;
}

/** Two tabs, "Tab 1" on screen and "Tab 2" beside it in the sidebar; returns the pane of Tab 1. */
async function twoTabs(page: Page): Promise<string> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(row(page, "Tab 2")).toBeVisible();
  await row(page, "Tab 1").click();
  const [first] = await paneIds(page);
  if (first === undefined) throw new Error("no pane");
  await expect
    .poll(async () => (await paneLines(page, first)).some((l) => l.startsWith("fake$")))
    .toBe(true);
  return first;
}

/** Presses on a row and drags it to `to`; the caller drops with the mouse. */
async function dragRowTo(page: Page, name: string, to: { x: number; y: number }) {
  const from = await box(row(page, name));
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A first small step crosses the activation distance, then the pointer travels in steps.
  await page.mouse.move(start.x + 10, start.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  return { drop: () => page.mouse.up() };
}

const SIDES = [
  { name: "right", fx: 0.9, fy: 0.5, dir: "row", side: "after" },
  { name: "left", fx: 0.1, fy: 0.5, dir: "row", side: "before" },
  { name: "top", fx: 0.5, fy: 0.1, dir: "column", side: "before" },
  { name: "bottom", fx: 0.5, fy: 0.9, dir: "column", side: "after" },
] as const;

for (const { name, fx, fy, dir, side } of SIDES) {
  test(`dropping a tab on the ${name} edge of a pane joins it on that side`, async ({ page }) => {
    const first = await twoTabs(page);
    const before = await box(frame(page, first));

    const drag = await dragRowTo(page, "Tab 2", {
      x: before.x + before.width * fx,
      y: before.y + before.height * fy,
    });
    // The zone is on screen while dragging, on the edge under the pointer.
    await expect(zone(page)).toHaveCount(1);
    await expect(zone(page)).toHaveAttribute("data-nr-dir", dir);
    await expect(zone(page)).toHaveAttribute("data-nr-side", side);
    await drag.drop();

    await expect(zone(page)).toHaveCount(0);
    await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(2);
    // The dragged tab left the sidebar; the other one stays and is still on screen.
    await expect(row(page, "Tab 2")).toHaveCount(0);
    await expect(row(page, "Tab 1")).toBeVisible();

    const ids = await paneIds(page);
    const joined = ids.find((id) => id !== first);
    if (joined === undefined) throw new Error("no joined pane");
    const old = await box(frame(page, first));
    const fresh = await box(frame(page, joined));
    if (dir === "row") {
      expect(Math.abs(fresh.y - old.y)).toBeLessThan(2);
      if (side === "after") expect(fresh.x).toBeGreaterThan(old.x + old.width / 2);
      else expect(fresh.x).toBeLessThan(old.x);
    } else {
      expect(Math.abs(fresh.x - old.x)).toBeLessThan(2);
      if (side === "after") expect(fresh.y).toBeGreaterThan(old.y + old.height / 2);
      else expect(fresh.y).toBeLessThan(old.y);
    }
  });
}

test("a tab dropped on a tab with four panes is refused with a notice and stays", async ({
  page,
}) => {
  const first = await twoTabs(page);
  for (let i = 0; i < 3; i++) {
    const id = await splitRight(page);
    if (id === undefined) throw new Error("the split was refused");
  }
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(4);
  const ids = await paneIds(page);
  // Nothing was refused so far, so the notice has no text yet.
  await expect(notice(page)).toHaveCount(0);

  const target = await box(frame(page, first));
  const drag = await dragRowTo(page, "Tab 2", {
    x: target.x + target.width * 0.5,
    y: target.y + target.height * 0.9,
  });
  await expect(zone(page)).toHaveCount(1);
  await drag.drop();

  await expect(notice(page)).toHaveText("A tab holds at most 4 panes.");
  expect(await paneIds(page)).toEqual(ids);
  await expect(row(page, "Tab 2")).toBeVisible();
});

test("the middle of a pane and the tab's own panes take no drop", async ({ page }) => {
  const first = await twoTabs(page);
  const target = await box(frame(page, first));

  // The middle is not a zone.
  const middle = await dragRowTo(page, "Tab 2", {
    x: target.x + target.width * 0.5,
    y: target.y + target.height * 0.5,
  });
  await expect(zone(page)).toHaveCount(0);
  await middle.drop();
  expect(await paneIds(page)).toEqual([first]);
  await expect(row(page, "Tab 2")).toBeVisible();

  // The tab on screen dragged over its own pane changes nothing.
  const own = await dragRowTo(page, "Tab 1", {
    x: target.x + target.width * 0.9,
    y: target.y + target.height * 0.5,
  });
  await expect(zone(page)).toHaveCount(0);
  await own.drop();
  expect(await paneIds(page)).toEqual([first]);
  await expect(row(page, "Tab 1")).toBeVisible();
  await expect(row(page, "Tab 2")).toBeVisible();
});

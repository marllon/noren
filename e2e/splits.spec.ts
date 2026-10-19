import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

type Hook = {
  lines(): string[];
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  paneLines(paneId: string): string[];
  split(dir: "row" | "column", paneId?: string): string | undefined;
};

const panes = (page: Page) => page.locator('[data-nr-part="pane"]:visible');
const separators = (page: Page) =>
  page.locator('[data-nr-part="item-layout"]:visible [role="separator"]');

const paneLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate(
    (id) =>
      (window as Window & { __norenTest?: Hook }).__norenTest?.paneLines(id) ?? ["no test hook"],
    paneId,
  );

const paneIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.paneIds() ?? []);

const focusedPaneId = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as Window & { __norenTest?: Hook }).__norenTest?.focusedPaneId());

/** Splits `paneId` (the focused pane by default) and waits until the new shell shows its prompt. */
async function split(page: Page, dir: "row" | "column", paneId?: string): Promise<string> {
  const id = await page.evaluate(
    ([d, target]) =>
      (window as Window & { __norenTest?: Hook }).__norenTest?.split(
        d as "row" | "column",
        target ?? undefined,
      ),
    [dir, paneId ?? null] as const,
  );
  if (id === undefined) throw new Error("the split was refused");
  await expect
    .poll(async () => (await paneLines(page, id)).some((l) => l.startsWith("fake$")))
    .toBe(true);
  return id;
}

const frame = (page: Page, paneId: string) => page.locator(`[data-pane-id="${paneId}"]`);

/** The element at `index`; the test fails instead of reading past the end. */
function at<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`no element at ${index}`);
  return found;
}

/** Width and height of every shown pane, in layout order, in px. */
const sizesOf = (page: Page): Promise<{ w: number; h: number }[]> =>
  panes(page).evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { w: box.width, h: box.height };
    }),
  );

async function openFirstTab(page: Page): Promise<string> {
  await page.goto("/");
  await expect.poll(() => paneIds(page).then((ids) => ids.length)).toBe(1);
  const [first] = await paneIds(page);
  if (first === undefined) throw new Error("no pane");
  await expect
    .poll(async () => (await paneLines(page, first)).some((l) => l.startsWith("fake$")))
    .toBe(true);
  return first;
}

/** Drags the separator by `dx` and `dy` px, with the pointer going through real moves. */
async function dragSeparator(page: Page, index: number, dx: number, dy: number): Promise<void> {
  const box = await separators(page).nth(index).boundingBox();
  if (!box) throw new Error("the separator has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

test("a tab with three panes shows three terminals, each with its own output", async ({ page }) => {
  const first = await openFirstTab(page);
  const second = await split(page, "row");
  const third = await split(page, "column", second);
  const ids = [first, second, third];
  expect(await paneIds(page)).toEqual(ids);

  await expect(panes(page)).toHaveCount(3);
  await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toHaveCount(3);

  for (const [index, id] of ids.entries()) {
    await frame(page, id).click();
    await page.keyboard.type(`echo word${index}`);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await paneLines(page, id)).includes(`word${index}`)).toBe(true);
  }
  // Each word is in its own terminal and in no other.
  for (const [index, id] of ids.entries()) {
    const lines = await paneLines(page, id);
    for (let other = 0; other < ids.length; other++) {
      const found = lines.some((line) => line.includes(`word${other}`));
      expect(found, `pane ${index} against word${other}`).toBe(other === index);
    }
  }
});

test("dragging a separator changes the proportions and a reload keeps them", async ({ page }) => {
  const first = await openFirstTab(page);
  const second = await split(page, "row");
  await split(page, "column", second);
  const ids = await paneIds(page);
  expect(ids[0]).toBe(first);

  const before = await sizesOf(page);
  const total = at(before, 0).w + at(before, 1).w;
  expect(at(before, 0).w / total).toBeCloseTo(0.5, 1);

  // The vertical separator between the first pane and the right column, then the horizontal one.
  await dragSeparator(page, 0, 160, 0);
  await dragSeparator(page, 1, 0, -150);
  const after = await sizesOf(page);
  expect(at(after, 0).w / total).toBeGreaterThan(0.6);
  expect(at(after, 1).h / (at(after, 1).h + at(after, 2).h)).toBeLessThan(0.35);

  // Both splits are saved with sizes other than the 50/50 they started with (the writer waits a moment).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const text = localStorage.getItem("noren.web.state") ?? "";
        const splits = text.match(/"sizes":\[[^\]]*\]/g) ?? [];
        return splits.length === 2 && splits.every((entry) => entry !== '"sizes":[50,50]');
      }),
    )
    .toBe(true);
  await page.reload();
  await expect(panes(page)).toHaveCount(3);
  expect(await paneIds(page)).toEqual(ids);

  const restored = await sizesOf(page);
  const restoredTotal = at(restored, 0).w + at(restored, 1).w;
  const point = (part: number, whole: number) => (part / whole) * 100;
  // Within one percentage point of what the user left.
  expect(
    Math.abs(point(at(restored, 0).w, restoredTotal) - point(at(after, 0).w, total)),
  ).toBeLessThan(1);
  expect(
    Math.abs(
      point(at(restored, 1).h, at(restored, 1).h + at(restored, 2).h) -
        point(at(after, 1).h, at(after, 1).h + at(after, 2).h),
    ),
  ).toBeLessThan(1);
});

test("clicking a pane moves the visible focus to it", async ({ page }) => {
  const first = await openFirstTab(page);
  // One pane alone has no frame.
  await expect(page.locator("[data-nr-focused]")).toHaveCount(0);

  const second = await split(page, "row");
  const focused = page.locator('[data-nr-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused).toHaveAttribute("data-pane-id", second);
  await expect(frame(page, first)).toHaveAttribute("data-nr-focused", "false");

  await frame(page, first).click();
  await expect(focused).toHaveAttribute("data-pane-id", first);
  await expect(focused).toHaveCount(1);
  expect(await focusedPaneId(page)).toBe(first);
  // The frame is visible: a border in the accent color.
  const border = await focused.evaluate((el) => getComputedStyle(el, "::after").borderTopWidth);
  expect(border).toBe("1px");

  await frame(page, second).click();
  await expect(focused).toHaveAttribute("data-pane-id", second);
  expect(await focusedPaneId(page)).toBe(second);
});

test("the panes and their proportions stay when another tab shows", async ({ page }) => {
  const first = await openFirstTab(page);
  const second = await split(page, "row");
  await frame(page, first).click();
  await page.keyboard.type("echo kept");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await paneLines(page, first)).includes("kept")).toBe(true);
  await dragSeparator(page, 0, 120, 0);
  const before = await sizesOf(page);

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(panes(page)).toHaveCount(1);
  await page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button").nth(0).click();

  await expect(panes(page)).toHaveCount(2);
  expect(await paneIds(page)).toEqual([first, second]);
  expect(await paneLines(page, first)).toContain("kept");
  const after = await sizesOf(page);
  expect(Math.abs(at(after, 0).w - at(before, 0).w)).toBeLessThan(2);
});

const headers = (page: Page) => page.locator('[data-nr-part="pane-header"]');
const itemLayout = (page: Page) => page.locator('[data-nr-part="item-layout"]:visible');

/** Turns the "Pane headers" preference on or off in the Layout control and closes the control. */
async function setPaneHeaders(page: Page, on: boolean): Promise<void> {
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  const box = page.getByRole("checkbox", { name: "Pane headers", exact: true });
  await expect(box).toBeVisible();
  await box.setChecked(on);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Layout", exact: true })).toHaveCount(0);
}

/** Each pane's box as a fraction of the item's box: x, y, width and height, in layout order. */
async function fractionsOf(page: Page): Promise<number[][]> {
  const item = await itemLayout(page).boundingBox();
  if (!item) throw new Error("the item has no box");
  return panes(page).evaluateAll(
    (els, area) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return [
          (box.x - area.x) / area.width,
          (box.y - area.y) / area.height,
          box.width / area.width,
          box.height / area.height,
        ];
      }),
    item,
  );
}

test("pane headers: off by default, on from the Layout control, kept after a reload", async ({
  page,
}) => {
  const first = await openFirstTab(page);
  const second = await split(page, "row");
  const third = await split(page, "column", second);
  await expect(panes(page)).toHaveCount(3);
  await expect(headers(page)).toHaveCount(0);

  await setPaneHeaders(page, true);
  await expect(headers(page)).toHaveCount(3);
  for (const id of [first, second, third]) {
    const header = frame(page, id).locator('[data-nr-part="pane-header"]');
    await expect(header).toBeVisible();
    await expect(header.getByRole("button", { name: "Zoom pane", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Close pane", exact: true })).toBeVisible();
  }

  await page.reload();
  await expect(panes(page)).toHaveCount(3);
  await expect(headers(page)).toHaveCount(3);

  await setPaneHeaders(page, false);
  await expect(headers(page)).toHaveCount(0);
  await page.reload();
  await expect(panes(page)).toHaveCount(3);
  await expect(headers(page)).toHaveCount(0);
});

test("zoom hides the other panes, fills the item and comes back with the same proportions", async ({
  page,
}) => {
  const first = await openFirstTab(page);
  const second = await split(page, "row");
  const third = await split(page, "column", second);
  const ids = [first, second, third];
  await setPaneHeaders(page, true);

  for (const [index, id] of ids.entries()) {
    await frame(page, id).click();
    await page.keyboard.type(`echo word${index}`);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await paneLines(page, id)).includes(`word${index}`)).toBe(true);
  }
  // Proportions other than the 50/50 the splits start with.
  await dragSeparator(page, 0, 120, 0);
  await dragSeparator(page, 1, 0, -90);
  const before = await fractionsOf(page);
  expect(before).toHaveLength(3);

  const zoomButton = (id: string) =>
    frame(page, id).getByRole("button", { name: "Zoom pane", exact: true });
  await zoomButton(second).click();

  await expect(panes(page)).toHaveCount(1);
  await expect(frame(page, second)).toBeVisible();
  await expect(frame(page, first)).toBeHidden();
  await expect(frame(page, third)).toBeHidden();
  const area = await itemLayout(page).boundingBox();
  const zoomed = await frame(page, second).boundingBox();
  if (!area || !zoomed) throw new Error("no box to measure");
  expect(Math.abs(zoomed.width - area.width)).toBeLessThan(3);
  expect(Math.abs(zoomed.height - area.height)).toBeLessThan(3);
  expect(Math.abs(zoomed.x - area.x)).toBeLessThan(3);
  expect(Math.abs(zoomed.y - area.y)).toBeLessThan(3);
  // The echo that was in the zoomed pane is still there, and the hidden ones kept theirs: their
  // terminals were never unmounted.
  for (const [index, id] of ids.entries()) {
    expect(await paneLines(page, id), `pane ${index} while zoomed`).toContain(`word${index}`);
  }
  // Still three terminals in the page (hidden ones are out of the accessibility tree).
  await expect(page.locator('[data-nr-part="pane"] textarea')).toHaveCount(3);

  await frame(page, second).getByRole("button", { name: "Restore pane", exact: true }).click();
  await expect(panes(page)).toHaveCount(3);
  const after = await fractionsOf(page);
  for (const [index, box] of before.entries()) {
    for (const [part, value] of box.entries()) {
      // Within one percentage point of the item.
      expect(
        Math.abs(value - at(after[index] ?? [], part)),
        `pane ${index}, part ${part}`,
      ).toBeLessThan(0.01);
    }
  }
  for (const [index, id] of ids.entries()) {
    expect(await paneLines(page, id), `pane ${index} after the zoom`).toContain(`word${index}`);
  }
});

test("Close pane closes only that pane", async ({ page }) => {
  const first = await openFirstTab(page);
  const second = await split(page, "row");
  const third = await split(page, "column", second);
  await setPaneHeaders(page, true);
  await expect(panes(page)).toHaveCount(3);

  await frame(page, third).getByRole("button", { name: "Close pane", exact: true }).click();
  await expect(panes(page)).toHaveCount(2);
  expect(await paneIds(page)).toEqual([first, second]);
  await expect(headers(page)).toHaveCount(2);

  // A tab with one pane has a header with the title and nothing to zoom or close from it.
  await frame(page, second).getByRole("button", { name: "Close pane", exact: true }).click();
  await expect(panes(page)).toHaveCount(1);
  expect(await paneIds(page)).toEqual([first]);
  await expect(headers(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Close pane", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Zoom pane", exact: true })).toHaveCount(0);
});

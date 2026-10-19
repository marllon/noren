import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";

// The seeded sidebar: pinned "notes", then the group "Work" (api, build, logs), "deploy", "scratch".

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const indicator = (page: Page) => list(page).locator('[data-nr-part="drop-indicator"]');

/** The rows top to bottom as `name@depth`, groups included. */
async function rows(page: Page): Promise<string[]> {
  return list(page)
    .locator("[data-row-id]")
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          `${node.querySelector('[data-nr-part="item-title"], .group-name')?.textContent ?? ""}@${node.getAttribute("data-nr-depth")}`,
      ),
    );
}

/** Where the drop indicator is drawn and how (before, after or inside): `position row`, or empty. */
async function indicatorAt(page: Page): Promise<string> {
  const marks = await indicator(page).evaluateAll((nodes) =>
    nodes.map((node) => {
      const owner = node.closest("li")?.querySelector("[data-row-id]");
      const name = owner?.querySelector('[data-nr-part="item-title"], .group-name')?.textContent;
      return `${node.getAttribute("data-nr-position")} ${name ?? ""}`;
    }),
  );
  return marks.join(",");
}

/** Waits for the one indicator that shows `expected` (the keyboard cursor settles a frame later). */
async function expectIndicator(page: Page, expected: string): Promise<void> {
  await expect.poll(() => indicatorAt(page)).toBe(expected);
}

/** Focuses a row and picks it up with Space; the arrows only count once the move has begun. */
async function pickUp(page: Page, name: string): Promise<void> {
  await row(page, name).focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toBeVisible();
  // The library starts listening for the arrows one timer tick after the pick-up (a person cannot
  // be that fast); a timer queued now runs after it.
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done)));
}

/** Presses on `source`, drags it over `over` (`fraction` of the way down it) and returns the drop. */
async function dragOver(
  page: Page,
  source: Locator,
  over: Locator,
  fraction: number,
): Promise<{ drop(): Promise<void> }> {
  const from = await source.boundingBox();
  const to = await over.boundingBox();
  if (!from || !to) throw new Error("row not on screen");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height * fraction };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // A first small step crosses the activation distance, then the pointer travels in steps.
  await page.mouse.move(start.x, start.y + (end.y > start.y ? 10 : -10), { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 15 });
  return { drop: () => page.mouse.up() };
}

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page);
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
});

const START = ["notes@0", "Work@0", "api@1", "build@1", "logs@1", "deploy@0", "scratch@0"];

test("dragging a tab reorders the tree and the order survives a reload", async ({ page }) => {
  expect(await rows(page)).toEqual(START);

  const hover = await dragOver(page, row(page, "scratch"), row(page, "deploy"), 0.2);
  await expectIndicator(page, "before deploy");
  await hover.drop();
  await expect(indicator(page)).toHaveCount(0);
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "api@1",
    "build@1",
    "logs@1",
    "scratch@0",
    "deploy@0",
  ]);
  // Dropping is not clicking: the active tab stays the same.
  await expect(row(page, "api")).toHaveAttribute("aria-current", "true");

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  expect((await rows(page)).slice(5)).toEqual(["scratch@0", "deploy@0"]);
});

test("a tab dragged onto a grouped tab joins the group, and out of it leaves the group", async ({
  page,
}) => {
  // Into the group, between api and build.
  const into = await dragOver(page, row(page, "deploy"), row(page, "build"), 0.2);
  await expectIndicator(page, "before build");
  await into.drop();
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "api@1",
    "deploy@1",
    "build@1",
    "logs@1",
    "scratch@0",
  ]);
  await expect(row(page, "Work").locator('[data-nr-part="group-count"]')).toHaveText("4");

  await page.reload();
  await expect(row(page, "deploy")).toHaveAttribute("data-nr-depth", "1");

  // Out of the group, below "scratch".
  const out = await dragOver(page, row(page, "api"), row(page, "scratch"), 0.8);
  await expectIndicator(page, "after scratch");
  await out.drop();
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "deploy@1",
    "build@1",
    "logs@1",
    "scratch@0",
    "api@0",
  ]);
  await expect(row(page, "Work").locator('[data-nr-part="group-count"]')).toHaveText("3");

  await page.reload();
  await expect(row(page, "api")).toHaveAttribute("data-nr-depth", "0");
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "deploy@1",
    "build@1",
    "logs@1",
    "scratch@0",
    "api@0",
  ]);
});

test("dropping on the middle of a group header puts the tab inside the group", async ({ page }) => {
  const hover = await dragOver(page, row(page, "scratch"), row(page, "Work"), 0.5);
  await expectIndicator(page, "inside Work");
  await hover.drop();
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "scratch@1",
    "api@1",
    "build@1",
    "logs@1",
    "deploy@0",
  ]);
});

test("dragging a group moves it with its tabs, and a group never lands inside itself", async ({
  page,
}) => {
  // Over its own tab nothing is marked and nothing happens.
  const own = await dragOver(page, row(page, "Work"), row(page, "build"), 0.5);
  await expect(indicator(page)).toHaveCount(0);
  await own.drop();
  expect(await rows(page)).toEqual(START);

  const hover = await dragOver(page, row(page, "Work"), row(page, "scratch"), 0.8);
  await expectIndicator(page, "after scratch");
  await hover.drop();
  expect(await rows(page)).toEqual([
    "notes@0",
    "deploy@0",
    "scratch@0",
    "Work@0",
    "api@1",
    "build@1",
    "logs@1",
  ]);
  await expect(row(page, "Work").locator('[data-nr-part="group-count"]')).toHaveText("3");

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  expect(await rows(page)).toEqual([
    "notes@0",
    "deploy@0",
    "scratch@0",
    "Work@0",
    "api@1",
    "build@1",
    "logs@1",
  ]);
});

test("a short press and move is still a click: nothing is dragged", async ({ page }) => {
  const box = await row(page, "build").boundingBox();
  if (!box) throw new Error("row not on screen");
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 22, box.y + 12);
  await page.mouse.up();
  await expect(row(page, "build")).toHaveAttribute("aria-current", "true");
  expect(await rows(page)).toEqual(START);
});

test("the keyboard picks a tab up with Space, steps through places with the arrows and drops with Space", async ({
  page,
}) => {
  const status = page.locator('[data-nr-part="drop-status"]');
  await pickUp(page, "deploy");
  // Up from "deploy": the end of the group, then between build and logs, then between api and build.
  await page.keyboard.press("ArrowUp");
  await expectIndicator(page, "after logs");
  await expect(status).toHaveText("After logs.");
  await page.keyboard.press("ArrowUp");
  await expectIndicator(page, "after build");
  await page.keyboard.press("ArrowUp");
  await expectIndicator(page, "after api");
  await page.keyboard.press("Space");

  await expect(indicator(page)).toHaveCount(0);
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "api@1",
    "deploy@1",
    "build@1",
    "logs@1",
    "scratch@0",
  ]);
  // Space dropped the tab; it did not click it, and focus is back on it.
  await expect(row(page, "api")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "deploy")).toBeFocused();

  // Down from there: inside the group, then out of it before "scratch", then below "scratch".
  await pickUp(page, "deploy");
  await page.keyboard.press("ArrowDown");
  await expectIndicator(page, "after build");
  await page.keyboard.press("ArrowDown");
  await expectIndicator(page, "after logs");
  await page.keyboard.press("ArrowDown");
  await expectIndicator(page, "before scratch");
  await page.keyboard.press("ArrowDown");
  await expectIndicator(page, "after scratch");
  await page.keyboard.press("Space");
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "api@1",
    "build@1",
    "logs@1",
    "scratch@0",
    "deploy@0",
  ]);

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  expect((await rows(page)).slice(-2)).toEqual(["scratch@0", "deploy@0"]);
});

test("Escape cancels a keyboard move, and the keyboard can move a group too", async ({ page }) => {
  await pickUp(page, "scratch");
  await page.keyboard.press("ArrowUp");
  await expectIndicator(page, "before deploy");
  await page.keyboard.press("Escape");
  await expect(indicator(page)).toHaveCount(0);
  expect(await rows(page)).toEqual(START);
  // Focus comes back to the tab once the move is over.
  await expect(row(page, "scratch")).toBeFocused();

  // A group steps over whole sibling tabs: down from "Work" is after "deploy".
  await pickUp(page, "Work");
  await page.keyboard.press("ArrowDown");
  await expectIndicator(page, "after deploy");
  await page.keyboard.press("Space");
  expect(await rows(page)).toEqual([
    "notes@0",
    "deploy@0",
    "Work@0",
    "api@1",
    "build@1",
    "logs@1",
    "scratch@0",
  ]);
});

test("Enter on a tab still activates it instead of picking it up", async ({ page }) => {
  await row(page, "deploy").focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "deploy")).toHaveAttribute("aria-current", "true");
  await expect(indicator(page)).toHaveCount(0);
  expect(await rows(page)).toEqual(START);
});

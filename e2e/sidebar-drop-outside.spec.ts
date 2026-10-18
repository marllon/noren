import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { seedSidebarState } from "./sidebar-fixture";

// Dropping a tab outside the tree: on the icon of another space, on Pinned and on Favorites.
// The seeded sidebar: pinned "notes", the group "Work" (api, build, logs), "deploy", "scratch", and
// the space "Other" with the tab "elsewhere".

const WEB_STATE_KEY = "noren.web.state";

const list = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("button", { name, exact: true });
const spaceButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Spaces", exact: true }).getByRole("button", {
    name,
    exact: true,
  });
const pinnedZone = (page: Page) => page.locator('[data-nr-part="drop-pinned"]');
const favoritesZone = (page: Page) => page.locator('[data-nr-part="drop-favorites"]');

/** The rows top to bottom as `name@depth`, groups included. */
async function rows(page: Page): Promise<string[]> {
  return list(page)
    .locator("[data-row-id]")
    .evaluateAll((nodes) =>
      nodes.map(
        (node) => `${node.getAttribute("aria-label") ?? ""}@${node.getAttribute("data-nr-depth")}`,
      ),
    );
}

/** The saved workspace, as the web backend keeps it. */
async function saved(page: Page): Promise<{
  activeSpaceId: string;
  favorites: string[];
  spaces: { id: string; pinned: string[]; items: Record<string, unknown> }[];
}> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}");
}

/** Presses on `source` and drags it over the middle of `over`; the caller drops with the mouse. */
async function dragTo(page: Page, source: Locator, over: Locator): Promise<void> {
  const from = await source.boundingBox();
  const to = await over.boundingBox();
  if (!from || !to) throw new Error("not on screen");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
}

/** Focuses a row and picks it up with Space; the arrows only count once the move has begun. */
async function pickUp(page: Page, name: string): Promise<void> {
  await row(page, name).focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toBeVisible();
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done)));
}

test.beforeEach(async ({ page }) => {
  await seedSidebarState(page, { secondSpace: true });
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
});

const START = ["notes@0", "Work@0", "api@1", "build@1", "logs@1", "deploy@0", "scratch@0"];

test("the Pinned and Favorites zones only show while a tab is dragged", async ({ page }) => {
  await expect(pinnedZone(page)).toBeHidden();
  await expect(favoritesZone(page)).toBeHidden();
  await dragTo(page, row(page, "scratch"), row(page, "deploy"));
  await expect(pinnedZone(page)).toBeVisible();
  await expect(favoritesZone(page)).toBeVisible();
  await page.mouse.up();
  await expect(pinnedZone(page)).toBeHidden();
  await expect(favoritesZone(page)).toBeHidden();
});

test("dropping a tab on the icon of another space moves it there and keeps the active space", async ({
  page,
}) => {
  await dragTo(page, row(page, "scratch"), spaceButton(page, "Other"));
  // The icon lights up while the tab is over it; the active space is still Main.
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "drop-target");
  await page.mouse.up();
  await expect(spaceButton(page, "Other")).not.toHaveAttribute("data-nr-state", "drop-target");
  await expect(spaceButton(page, "Main")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "scratch")).toHaveCount(0);
  expect(await rows(page)).toEqual(START.slice(0, -1));

  // The tab is in the other space.
  await spaceButton(page, "Other").click();
  await expect(row(page, "elsewhere")).toBeVisible();
  await expect(row(page, "scratch")).toBeVisible();

  await page.reload();
  await expect(row(page, "elsewhere")).toBeVisible();
  expect(await rows(page)).toEqual(["elsewhere@0", "scratch@0"]);
  await spaceButton(page, "Main").click();
  await expect(row(page, "api")).toBeVisible();
  await expect(row(page, "scratch")).toHaveCount(0);
});

test("a tab dropped on the icon of its own space changes nothing", async ({ page }) => {
  await dragTo(page, row(page, "scratch"), spaceButton(page, "Main"));
  await expect(spaceButton(page, "Main")).toHaveAttribute("data-nr-state", "active");
  await page.mouse.up();
  expect(await rows(page)).toEqual(START);
});

test("dropping a tab on Pinned pins it, and it stays pinned after a reload", async ({ page }) => {
  await dragTo(page, row(page, "scratch"), pinnedZone(page));
  await expect(pinnedZone(page)).toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await expect(row(page, "scratch")).toHaveAttribute("data-nr-pinned", "true");
  expect(await rows(page)).toEqual([
    "notes@0",
    "scratch@0",
    "Work@0",
    "api@1",
    "build@1",
    "logs@1",
    "deploy@0",
  ]);
  await expect.poll(async () => (await saved(page)).spaces[0]?.pinned).toEqual(["i1", "i6"]);

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  await expect(row(page, "scratch")).toHaveAttribute("data-nr-pinned", "true");
  await expect(row(page, "deploy")).not.toHaveAttribute("data-nr-pinned", "true");
});

test("dropping a tab on Favorites makes it a favorite, and it stays one after a reload", async ({
  page,
}) => {
  await dragTo(page, row(page, "scratch"), favoritesZone(page));
  await expect(favoritesZone(page)).toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  await expect.poll(async () => (await saved(page)).favorites).toEqual(["i6"]);
  // A favorite stays where it is; the grid of favorites is a later task.
  expect(await rows(page)).toEqual(START);

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  expect((await saved(page)).favorites).toEqual(["i6"]);

  // A tab that is already a favorite does not light the zone up again.
  await dragTo(page, row(page, "scratch"), favoritesZone(page));
  await expect(favoritesZone(page)).not.toHaveAttribute("data-nr-state", "over");
  await page.mouse.up();
  expect((await saved(page)).favorites).toEqual(["i6"]);
});

test("the keyboard reaches Pinned, Favorites and the other space after the last row", async ({
  page,
}) => {
  const status = page.locator('[data-nr-part="drop-status"]');
  await pickUp(page, "scratch");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Pin this tab.");
  await expect(pinnedZone(page)).toHaveAttribute("data-nr-state", "over");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Add this tab to the favorites.");
  await page.keyboard.press("ArrowDown");
  await expect(status).toHaveText("Move to space Other.");
  await expect(spaceButton(page, "Other")).toHaveAttribute("data-nr-state", "drop-target");
  // Up again goes back to the favorites zone, and Escape drops nothing.
  await page.keyboard.press("ArrowUp");
  await expect(status).toHaveText("Add this tab to the favorites.");
  await page.keyboard.press("Escape");
  expect(await rows(page)).toEqual(START);

  await pickUp(page, "scratch");
  for (const text of ["Pin this tab.", "Add this tab to the favorites.", "Move to space Other."]) {
    await page.keyboard.press("ArrowDown");
    await expect(status).toHaveText(text);
  }
  await page.keyboard.press("Space");
  await expect(row(page, "scratch")).toHaveCount(0);
  await expect(spaceButton(page, "Main")).toHaveAttribute("aria-current", "true");
  await spaceButton(page, "Other").click();
  await expect(row(page, "scratch")).toBeVisible();
});

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

type Start = { profileId?: string; cwd?: string; env?: Record<string, string> };
type TestHook = { writeCalls(): number; sessionStarts(): Start[] };
type TestWindow = Window & { __norenTest?: TestHook };

const writeCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.writeCalls() ?? 0);
const sessionStarts = (page: Page): Promise<Start[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.sessionStarts() ?? []);

const switcher = (page: Page) => page.getByRole("navigation", { name: "Spaces", exact: true });
const spaceButton = (page: Page, name: string) =>
  switcher(page).getByRole("button", { name, exact: true });
const sidebar = (page: Page) => page.locator("aside.sidebar");
const tabs = (page: Page) =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");

async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Puts the pointer over the sidebar, where a horizontal wheel turn means a space gesture. */
async function pointAtSidebar(page: Page): Promise<void> {
  const box = await sidebar(page).boundingBox();
  if (!box) throw new Error("the sidebar has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

/** Lets one wheel gesture end (events are ignored until a short pause) before the next one. */
const endGesture = (page: Page): Promise<void> => page.waitForTimeout(300);

async function expectActive(page: Page, name: string): Promise<void> {
  await expect(spaceButton(page, name)).toHaveAttribute("data-nr-state", "active");
  await expect(switcher(page).locator("button[data-nr-state='active']")).toHaveCount(1);
}

/** Main, Alpha and Beta, with Beta active and the pointer over the sidebar. */
async function threeSpaces(page: Page): Promise<void> {
  await page.goto("/");
  await expect(tabs(page)).toHaveCount(1);
  await createSpace(page, "Alpha");
  await createSpace(page, "Beta");
  await expectActive(page, "Beta");
  await pointAtSidebar(page);
}

test("a horizontal wheel over the sidebar steps to the neighbor space and stops at the ends", async ({
  page,
}) => {
  await threeSpaces(page);
  const writesBefore = await writeCalls(page);

  // Already at the right end: nothing happens.
  await page.mouse.wheel(120, 0);
  await endGesture(page);
  await expectActive(page, "Beta");

  await page.mouse.wheel(-120, 0);
  await expectActive(page, "Alpha");
  await endGesture(page);
  await page.mouse.wheel(-120, 0);
  await expectActive(page, "Main");
  await endGesture(page);

  // Left end: stays.
  await page.mouse.wheel(-120, 0);
  await endGesture(page);
  await expectActive(page, "Main");

  await page.mouse.wheel(120, 0);
  await expectActive(page, "Alpha");
  await endGesture(page);

  // A vertical wheel is not a space gesture.
  await page.mouse.wheel(0, 300);
  await endGesture(page);
  await expectActive(page, "Alpha");

  // The terminal never saw any of it.
  expect(await writeCalls(page)).toBe(writesBefore);
});

test("one gesture moves one space even when the wheel keeps going", async ({ page }) => {
  await threeSpaces(page);
  await page.keyboard.press("Control+Alt+1");
  await expectActive(page, "Main");
  await pointAtSidebar(page);

  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(100, 0);
  await expectActive(page, "Alpha");
  // Give the rest of the events time to land: it must not have gone on to Beta.
  await page.waitForTimeout(150);
  await expectActive(page, "Alpha");
});

test("a small horizontal travel does not switch, and Shift+wheel does", async ({ page }) => {
  await threeSpaces(page);
  await page.mouse.wheel(-20, 0);
  await endGesture(page);
  await expectActive(page, "Beta");

  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Shift");
  await expectActive(page, "Alpha");
});

test("the space change animates, and not under prefers-reduced-motion: reduce", async ({
  page,
}) => {
  const animationNames = (): Promise<{ layer: string; list: string }> =>
    page.evaluate(() => {
      const layer = document.querySelector(".space-layer:not([hidden])");
      const list = document.querySelector(".tab-list");
      if (!layer || !list) throw new Error("no shown space");
      return {
        layer: getComputedStyle(layer).animationName,
        list: getComputedStyle(list).animationName,
      };
    });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await createSpace(page, "Alpha");
  await page.keyboard.press("Control+Alt+1");
  await expectActive(page, "Main");
  expect(await animationNames()).toEqual({ layer: "nr-space-in", list: "nr-space-in" });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Control+Alt+2");
  await expectActive(page, "Alpha");
  expect(await animationNames()).toEqual({ layer: "none", list: "none" });

  // The switch still works, only without the animation.
  await page.keyboard.press("Control+Alt+1");
  await expectActive(page, "Main");
  await expect(tabs(page)).toHaveCount(1);
  expect(await animationNames()).toEqual({ layer: "none", list: "none" });
});

const gitName = (dialog: Locator) => dialog.getByRole("textbox", { name: "Git name", exact: true });
const gitEmail = (dialog: Locator) =>
  dialog.getByRole("textbox", { name: "Git email", exact: true });

async function openEditDialog(page: Page, spaceName: string): Promise<Locator> {
  await spaceButton(page, spaceName).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit space…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit space", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("edits the git identity of a space, it survives a reload and reaches new sessions", async ({
  page,
}) => {
  await page.goto("/");
  await createSpace(page, "Work");

  let dialog = await openEditDialog(page, "Work");
  await expect(gitName(dialog)).toHaveValue("");
  await expect(gitEmail(dialog)).toHaveValue("");
  await gitName(dialog).fill("Ada Lovelace");
  await gitEmail(dialog).fill("ada@example.com");
  await dialog
    .getByRole("textbox", { name: "Environment variables", exact: true })
    .fill("GIT_AUTHOR_NAME=Explicit");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.reload();
  await expectActive(page, "Work");
  dialog = await openEditDialog(page, "Work");
  await expect(gitName(dialog)).toHaveValue("Ada Lovelace");
  await expect(gitEmail(dialog)).toHaveValue("ada@example.com");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();

  // A new tab starts with the identity; the variable set by hand wins over the identity.
  const before = (await sessionStarts(page)).length;
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(async () => (await sessionStarts(page)).length).toBe(before + 1);
  expect((await sessionStarts(page)).at(-1)?.env).toEqual({
    GIT_AUTHOR_NAME: "Explicit",
    GIT_COMMITTER_NAME: "Ada Lovelace",
    GIT_AUTHOR_EMAIL: "ada@example.com",
    GIT_COMMITTER_EMAIL: "ada@example.com",
  });

  // Blank fields clear it, and that survives a reload too.
  dialog = await openEditDialog(page, "Work");
  await gitName(dialog).fill("");
  await gitEmail(dialog).fill("");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expectActive(page, "Work");
  dialog = await openEditDialog(page, "Work");
  await expect(gitName(dialog)).toHaveValue("");
  await expect(gitEmail(dialog)).toHaveValue("");
});

test("a new space can start with a git identity", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Client");
  await gitName(dialog).fill("Ada");
  await gitEmail(dialog).fill("ada@client.test");
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => (await sessionStarts(page)).at(-1)?.env?.["GIT_COMMITTER_EMAIL"])
    .toBe("ada@client.test");
  expect((await sessionStarts(page)).at(-1)?.env).toMatchObject({
    GIT_AUTHOR_NAME: "Ada",
    GIT_COMMITTER_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@client.test",
  });
});

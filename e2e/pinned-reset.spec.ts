import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// A pinned tab remembers where it started (folder and profile of its pane when it was pinned) and
// "Reset" in its menu ends its shell and opens a new one there, whatever the space says now.

type Start = { profileId?: string; cwd?: string; env?: Record<string, string> };
type TestHook = { killedSessions(): number[]; sessionStarts(): Start[] };
type TestWindow = Window & { __norenTest?: TestHook };

const WEB_STATE_KEY = "noren.web.state";

const sessionStarts = (page: Page): Promise<Start[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.sessionStarts() ?? []);
const startCount = async (page: Page): Promise<number> => (await sessionStarts(page)).length;
const killed = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as TestWindow).__norenTest?.killedSessions() ?? []);

const tabs = (page: Page) => page.getByRole("list", { name: "Tabs", exact: true });
const pinnedTab = (page: Page) =>
  page.locator('[data-nr-part="pinned-list"]').locator("[data-nr-pinned]");
const menuItem = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });

/** The saved workspace, as the web backend keeps it. */
async function savedItems(page: Page): Promise<{ origin?: { cwd: string; profileId: string } }[]> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  const state = JSON.parse(text ?? "{}") as {
    spaces?: { items: Record<string, { origin?: { cwd: string; profileId: string } }> }[];
  };
  return (state.spaces ?? []).flatMap((space) => Object.values(space.items));
}

async function createSpaceIn(page: Page, name: string, cwd: string): Promise<void> {
  await page.getByRole("button", { name: "New space", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New space", exact: true });
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await dialog.getByRole("textbox", { name: "Start folder", exact: true }).fill(cwd);
  await dialog.getByRole("button", { name: "Create space", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function setFolder(page: Page, spaceName: string, cwd: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Spaces", exact: true })
    .getByRole("button", { name: spaceName, exact: true })
    .click({ button: "right" });
  await menuItem(page, "Edit space…").click();
  const dialog = page.getByRole("dialog", { name: "Edit space", exact: true });
  await dialog.getByRole("textbox", { name: "Start folder", exact: true }).fill(cwd);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("Reset on a pinned tab ends its shell and starts a new one in the folder it was pinned in", async ({
  page,
}) => {
  await page.goto("/");
  await expect.poll(() => startCount(page)).toBe(1);
  await createSpaceIn(page, "Alpha", "/work/a");
  await expect.poll(() => startCount(page)).toBe(2);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect.poll(() => startCount(page)).toBe(3);

  // Pin the second tab: nothing offers Reset before that.
  await tabs(page).getByRole("button").nth(1).click({ button: "right" });
  await expect(menuItem(page, "Pin")).toBeVisible();
  await expect(menuItem(page, "Reset")).toHaveCount(0);
  await menuItem(page, "Pin").click();
  await expect(pinnedTab(page)).toHaveCount(1);

  // The space moves on to another folder; the pinned tab remembers the first one.
  await setFolder(page, "Alpha", "/work/b");
  expect(await killed(page)).toEqual([]);

  await pinnedTab(page).click({ button: "right" });
  await menuItem(page, "Reset").click();

  await expect.poll(() => startCount(page)).toBe(4);
  expect(await killed(page)).toHaveLength(1);
  const starts = await sessionStarts(page);
  expect(starts[3]).toEqual({ cwd: "/work/a" });
  expect(starts.some((start) => start.cwd === "/work/b")).toBe(false);
  await expect(pinnedTab(page)).toHaveCount(1);

  // The origin is saved; after a reload Reset still goes back to the same folder.
  await expect
    .poll(async () => (await savedItems(page)).filter((item) => item.origin).length)
    .toBe(1);
  await page.reload();
  await expect(pinnedTab(page)).toHaveCount(1);
  await expect.poll(() => startCount(page)).toBeGreaterThan(0);
  const before = await startCount(page);
  await pinnedTab(page).click({ button: "right" });
  await menuItem(page, "Reset").click();
  await expect.poll(() => startCount(page)).toBe(before + 1);
  expect((await sessionStarts(page)).at(-1)).toEqual({ cwd: "/work/a" });
  expect(await killed(page)).toHaveLength(1);

  // Unpinned, the tab has no origin: the menu no longer offers Reset.
  await pinnedTab(page).click({ button: "right" });
  await menuItem(page, "Unpin").click();
  await expect(pinnedTab(page)).toHaveCount(0);
  await tabs(page).getByRole("button").nth(1).click({ button: "right" });
  await expect(menuItem(page, "Pin")).toBeVisible();
  await expect(menuItem(page, "Reset")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await savedItems(page)).filter((item) => item.origin).length)
    .toBe(0);
});

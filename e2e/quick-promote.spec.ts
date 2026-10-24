import { expect, test } from "./test";
import type { Page } from "@playwright/test";

// A shell the quick window opened is promoted to a tab of the main window without restarting it.
// The window itself, the events and the move of the output on the Rust side are checked by
// `noren --smoke-quick`; what is here is the page of the main window, in a real browser with the
// in-memory backend: the tab made around a session that no tab started, the terminal that takes
// its output and its size, and what closing that tab does to the session.

interface Hook {
  lines(): string[];
  paneIds(): string[];
  viewport(): { top: number; rows: number };
  killedSessions(): number[];
  sessionStarts(): unknown[];
  startDetachedSession(): Promise<number>;
  promoteSession(id: number): Promise<{ ok: boolean; itemId?: string; reason?: string }>;
  sessionSize(id: number): { cols: number; rows: number } | undefined;
  sessionResizes(id: number): { cols: number; rows: number }[];
}
type HookWindow = Window & { __norenTest?: Hook };

const hook = (page: Page) => ({
  lines: () => page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []),
  paneIds: () => page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []),
  viewportRows: () => page.evaluate(() => (window as HookWindow).__norenTest?.viewport().rows ?? 0),
  killed: () => page.evaluate(() => (window as HookWindow).__norenTest?.killedSessions() ?? []),
  starts: () => page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts() ?? []),
  detached: () =>
    page.evaluate(() => (window as HookWindow).__norenTest?.startDetachedSession() ?? 0),
  promote: (id: number) =>
    page.evaluate((n) => (window as HookWindow).__norenTest?.promoteSession(n), id),
  size: (id: number) =>
    page.evaluate((n) => (window as HookWindow).__norenTest?.sessionSize(n), id),
  resizes: (id: number) =>
    page.evaluate((n) => (window as HookWindow).__norenTest?.sessionResizes(n) ?? [], id),
});

const tabs = (page: Page) =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem");

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await expect
    .poll(async () => (await hook(page).lines()).some((line) => line.startsWith("fake$")))
    .toBe(true);
}

test("a shell no tab started becomes the active tab, with the output it already printed", async ({
  page,
}) => {
  await open(page);
  const before = await hook(page).paneIds();
  await expect(tabs(page)).toHaveCount(1);

  const id = await hook(page).detached();
  // It printed its first prompt before any terminal listened; the tab finds it there.
  const result = await hook(page).promote(id);

  expect(result?.ok).toBe(true);
  await expect(tabs(page)).toHaveCount(2);
  const after = await hook(page).paneIds();
  expect(after).toHaveLength(1);
  expect(after).not.toEqual(before);
  await expect
    .poll(async () => (await hook(page).lines()).some((line) => line.startsWith("fake$")))
    .toBe(true);

  // It is the same shell: it answers what is typed in the new tab. Two shells were started in all
  // (the first tab's and the detached one); promoting started none.
  await page.keyboard.type("echo from-the-quick-window");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await hook(page).lines()).includes("from-the-quick-window"))
    .toBe(true);
  expect(await hook(page).starts()).toHaveLength(2);
  expect(await hook(page).killed()).toEqual([]);
});

test("the shell takes the size of the view it came into, not the one of the window it left", async ({
  page,
}) => {
  await open(page);
  const id = await hook(page).detached();
  expect(await hook(page).size(id)).toEqual({ cols: 80, rows: 24 });

  await hook(page).promote(id);

  await expect.poll(async () => (await hook(page).resizes(id)).length).toBeGreaterThan(0);
  const size = await hook(page).size(id);
  expect(size?.rows).toBe(await hook(page).viewportRows());
  // The view of this window is wider than the 80 columns the shell had.
  expect(size?.cols).toBeGreaterThan(80);
});

test("the same session is not promoted twice, and a session that is gone is refused", async ({
  page,
}) => {
  await open(page);
  const id = await hook(page).detached();
  expect((await hook(page).promote(id))?.ok).toBe(true);

  const again = await hook(page).promote(id);
  expect(again).toMatchObject({ ok: false, reason: "a tab already shows that session" });
  const gone = await hook(page).promote(9999);
  expect(gone).toMatchObject({ ok: false, reason: "unknown session 9999" });
  await expect(tabs(page)).toHaveCount(2);
});

test("closing the promoted tab ends its shell like any other tab", async ({ page }) => {
  await open(page);
  const id = await hook(page).detached();
  await hook(page).promote(id);
  await expect(tabs(page)).toHaveCount(2);

  await page.keyboard.press("Control+Shift+W");

  await expect(tabs(page)).toHaveCount(1);
  expect(await hook(page).killed()).toEqual([id]);
});

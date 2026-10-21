import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { clicksReachThePage, seedSidebarState, sidebarState } from "./sidebar-fixture";

// The sidebar of a window besides the main one (NOR-F15-04c): the page of a window draws the tabs of
// its space with the main window's own tree, and asks the main window to open a tab (a new shell,
// started by the main window and then taken over by the window), to close one (its shell ends) and
// to put the tabs in order. The main window checks every request and stays the only one that owns
// the workspace and writes `state.json`. A browser has no second window, so `/?window-preview` draws
// each one as a panel beside the app on the same backend and the same events (see
// window-drag.spec.ts); what the panels cannot say is in `noren --smoke-window`.
//
// The seeded sidebar: pinned "notes", the group "Work" (api, build, logs - "logs" is unread),
// "deploy" (bell), "scratch"; the main window shows "api".

interface Hook {
  paneIds(): string[];
  lines(): string[];
  sessionStarts(): unknown[];
  killedSessions(): number[];
}
interface WindowsHook {
  windows(): string[];
  lines(windowId: string, paneId?: string): string[];
  closeByPerson(windowId: string): void;
  ask(windowId: string, action: unknown): void;
}
type HookWindow = Window & { __norenTest?: Hook; __norenWindows?: WindowsHook };

const WEB_STATE_KEY = "noren.web.state";

// The sidebar of the main window: a window panel has a tree with the same name of its own.
const list = (page: Page) =>
  page.locator('[data-nr-part="sidebar"]').getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const panels = (page: Page): Locator => page.locator('[data-nr-part="window-preview"]');
const panelRow = (panel: Locator, name: string): Locator =>
  panel.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem", {
    name,
    exact: true,
  });
const newTabButton = (panel: Locator): Locator =>
  panel.getByRole("button", { name: "New tab", exact: true });
const xterms = (panel: Locator): Locator =>
  panel.locator('[data-nr-part="window-terminal"] .xterm');

/** The titles of the tabs the sidebar of a panel lists, top to bottom. */
const titles = (panel: Locator): Promise<string[]> =>
  panel.locator('[data-nr-part="item-title"]').allTextContents();

interface SavedItem {
  title?: string;
  layout: { kind: string; pane?: { id: string; unread?: boolean; bell?: boolean } };
  focusedPaneId?: string;
}
interface Saved {
  activeSpaceId: string;
  windows?: { id: string; spaceId: string; returnSpaceId?: string }[];
  spaces: {
    id: string;
    name: string;
    pinned: string[];
    activeItemId?: string;
    tree: { kind: string; id: string }[];
    items: Record<string, SavedItem>;
  }[];
}

/** The saved workspace, as the web backend keeps it. */
async function saved(page: Page): Promise<Saved> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}") as Saved;
}

/** The space a window shows, in the saved workspace. */
async function windowSpace(page: Page, windowId: string): Promise<Saved["spaces"][number]> {
  // The state is written a moment after it changes (the writer waits to batch the changes).
  let found: Saved["spaces"][number] | undefined;
  await expect
    .poll(async () => {
      const state = await saved(page);
      const window = state.windows?.find((w) => w.id === windowId);
      found = state.spaces.find((s) => s.id === window?.spaceId);
      return found !== undefined;
    })
    .toBe(true);
  if (found === undefined) throw new Error(`no space for window ${windowId}`);
  return found;
}

const sessionStarts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? -1);
const killedSessions = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.killedSessions() ?? []);
const mainLines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const windowIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenWindows?.windows() ?? []);
const windowLines = (page: Page, windowId: string, paneId?: string): Promise<string[]> =>
  page.evaluate(([id, pane]) => (window as HookWindow).__norenWindows?.lines(id, pane) ?? [], [
    windowId,
    paneId,
  ] as const);
const ask = (page: Page, windowId: string, action: unknown): Promise<void> =>
  page.evaluate(([id, body]) => (window as HookWindow).__norenWindows?.ask(id, body), [
    windowId,
    action,
  ] as const);

/** Presses on a tab of the main sidebar, drags it out of the page and lets go there. */
async function dragOut(page: Page, name: string): Promise<void> {
  const from = await row(page, name).boundingBox();
  if (!from) throw new Error(`${name} is not on screen`);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(-60, start.y + 20, { steps: 20 });
  await page.mouse.up();
}

async function open(page: Page): Promise<void> {
  await seedSidebarState(page, { secondSpace: true });
  await page.goto("/?window-preview");
  await expect(row(page, "api")).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0),
    )
    .toBeGreaterThan(0);
}

/** Opens the app, drags "scratch" out to a window and waits for its terminal. */
async function openWithWindow(page: Page): Promise<{ panel: Locator; windowId: string }> {
  await open(page);
  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(xterms(panel)).toHaveCount(1);
  const [windowId] = await windowIds(page);
  if (windowId === undefined) throw new Error("the window was expected");
  return { panel, windowId };
}

/** Presses New tab in the window and waits for the tab and its terminal. */
async function addTab(panel: Locator, tabs: number): Promise<void> {
  await newTabButton(panel).click();
  await expect(panel.locator('[data-nr-part="item"]')).toHaveCount(tabs);
  await expect(xterms(panel)).toHaveCount(tabs);
}

test("the window draws the sidebar of its space: the tabs, the one on screen marked, and a button for a new tab", async ({
  page,
}) => {
  const { panel } = await openWithWindow(page);
  const sidebar = panel.getByRole("complementary", { name: "Window sidebar", exact: true });
  await expect(sidebar).toBeVisible();
  await expect(panelRow(panel, "scratch")).toHaveAttribute("aria-current", "true");
  await expect(newTabButton(panel)).toBeVisible();
  expect(await titles(panel)).toEqual(["scratch"]);
  // The tab strip of the first version is gone: the sidebar is the way to tell the tabs apart.
  await expect(panel.getByRole("tablist")).toHaveCount(0);
});

test("New tab in the window opens a shell of its own in the space of the window, and the saved state has it", async ({
  page,
}) => {
  const { panel, windowId } = await openWithWindow(page);
  const starts = await sessionStarts(page);
  // Once the state has the window, the main window's space is as it will stay.
  await windowSpace(page, windowId);
  const mainBefore = (await saved(page)).spaces.find((s) => s.id === "s1");

  await addTab(panel, 2);
  // A shell was started for it: one more, and it is the one the window shows.
  expect(await sessionStarts(page)).toBe(starts + 1);
  const second = panel.locator('[data-nr-part="item"]').nth(1);
  await expect(second).toHaveAttribute("aria-current", "true");
  await expect(panelRow(panel, "scratch")).not.toHaveAttribute("aria-current", "true");

  // The workspace has the tab in the space of the window, as the tab that space shows ...
  await expect
    .poll(async () => Object.keys((await windowSpace(page, windowId)).items).length)
    .toBe(2);
  const space = await windowSpace(page, windowId);
  const added = space.tree.map((node) => node.id).find((id) => id !== "i6");
  if (added === undefined) throw new Error("the new tab was expected in the space of the window");
  expect(space.activeItemId).toBe(added);
  const paneId = space.items[added]?.layout.pane?.id;
  if (paneId === undefined) throw new Error("the new tab has a pane");
  // ... and the space of the main window did not change.
  const mainAfter = (await saved(page)).spaces.find((s) => s.id === "s1");
  expect(mainAfter?.tree).toEqual(mainBefore?.tree);
  expect(Object.keys(mainAfter?.items ?? {})).toEqual(Object.keys(mainBefore?.items ?? {}));

  // The shell answers in the window: what was typed goes to it and what it says comes back.
  await xterms(panel).nth(1).click();
  await page.keyboard.type("echo from-the-new-tab");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await windowLines(page, windowId, paneId)).includes("from-the-new-tab"))
    .toBe(true);
  // The tab it left alone was not touched.
  expect(await killedSessions(page)).toEqual([]);
});

test("a new tab of the window shows the prompt its shell printed before the window took it over", async ({
  page,
}) => {
  const { panel, windowId } = await openWithWindow(page);
  await addTab(panel, 2);
  await expect
    .poll(async () => Object.keys((await windowSpace(page, windowId)).items).length)
    .toBe(2);
  const space = await windowSpace(page, windowId);
  const added = space.tree.map((node) => node.id).find((id) => id !== "i6") ?? "";
  const paneId = space.items[added]?.layout.pane?.id;
  // The shell printed its prompt when the main window started it, before the page of the window
  // drew a terminal for it: the daemon keeps that, and the window shows it.
  await expect
    .poll(async () =>
      (await windowLines(page, windowId, paneId)).some((line) => line.includes("fake$")),
    )
    .toBe(true);
});

test("the terminal a tab brings to the window shows what its shell printed before, and shows it again back in the main window", async ({
  page,
}) => {
  await open(page);
  await row(page, "scratch").click();
  await page.keyboard.type("echo said-before-the-drag");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await mainLines(page)).includes("said-before-the-drag"))
    .toBe(true);

  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(xterms(panel)).toHaveCount(1);
  const [windowId = ""] = await windowIds(page);
  // The terminal of the window is a new one, and it is not blank: it shows what the shell said.
  await expect
    .poll(async () => (await windowLines(page, windowId)).includes("said-before-the-drag"))
    .toBe(true);
  const lines = await windowLines(page, windowId);
  expect(lines.filter((line) => line === "said-before-the-drag")).toHaveLength(1);

  // What is said in the window is kept too when the tab goes home.
  await xterms(panel).first().click();
  await page.keyboard.type("echo said-in-the-window");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await windowLines(page, windowId)).includes("said-in-the-window"))
    .toBe(true);
  await panel.getByRole("button", { name: "Close window", exact: true }).click();
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "scratch")).toBeVisible();
  await expect
    .poll(async () => {
      const home = await mainLines(page);
      return [home.includes("said-before-the-drag"), home.includes("said-in-the-window")];
    })
    .toEqual([true, true]);
});

test("closing a tab of the window with the menu ends its shell, and the other tab keeps working", async ({
  page,
}) => {
  const { panel, windowId } = await openWithWindow(page);
  await addTab(panel, 2);
  await expect
    .poll(async () => Object.keys((await windowSpace(page, windowId)).items).length)
    .toBe(2);

  // The menu of the second tab (right click) offers to close it.
  await panel.locator('[data-nr-part="item"]').nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(panel.locator('[data-nr-part="item"]')).toHaveCount(1);
  await expect(xterms(panel)).toHaveCount(1);
  await expect(panelRow(panel, "scratch")).toHaveAttribute("aria-current", "true");
  // One shell ended, in the backend, and the workspace dropped the tab.
  await expect.poll(async () => (await killedSessions(page)).length).toBe(1);
  await expect
    .poll(async () => Object.keys((await windowSpace(page, windowId)).items))
    .toEqual(["i6"]);

  // The tab that is left is the shell that was in the window all along.
  await xterms(panel).first().click();
  await page.keyboard.type("echo still-here");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await windowLines(page, windowId)).includes("still-here"))
    .toBe(true);
  expect((await killedSessions(page)).length).toBe(1);
  // The window is still open: it had another tab.
  await expect(panels(page)).toHaveCount(1);
});

test("Delete on a tab of the window closes it too", async ({ page }) => {
  const { panel, windowId } = await openWithWindow(page);
  await addTab(panel, 2);
  await panel.locator('[data-nr-part="item"]').nth(1).focus();
  await page.keyboard.press("Delete");
  await expect(panel.locator('[data-nr-part="item"]')).toHaveCount(1);
  await expect.poll(async () => (await killedSessions(page)).length).toBe(1);
  await expect
    .poll(async () => Object.keys((await windowSpace(page, windowId)).items))
    .toEqual(["i6"]);
});

test("closing the last tab of the window closes the window and the space made for it", async ({
  page,
}) => {
  const { panel } = await openWithWindow(page);
  await panelRow(panel, "scratch").focus();
  await page.keyboard.press("Delete");
  await expect(panels(page)).toHaveCount(0);
  // Its shell ended, no window is left, and the space made for the window is gone with it.
  await expect.poll(async () => (await killedSessions(page)).length).toBe(1);
  await expect.poll(async () => (await saved(page)).windows).toBeUndefined();
  expect((await saved(page)).spaces.map((s) => s.id)).toEqual(["s1", "s2"]);
  // The tab did not go back to the main window: it was closed.
  await expect(row(page, "scratch")).toHaveCount(0);
});

test("dragging a tab of the window up or down in its sidebar changes the order and starts or ends nothing", async ({
  page,
}) => {
  const { panel, windowId } = await openWithWindow(page);
  await addTab(panel, 2);
  await addTab(panel, 3);
  await expect
    .poll(async () => Object.keys((await windowSpace(page, windowId)).items).length)
    .toBe(3);
  const before = (await windowSpace(page, windowId)).tree.map((node) => node.id);
  const starts = await sessionStarts(page);
  const killed = await killedSessions(page);
  const items = panel.locator('[data-nr-part="item"]');
  const last = await items.nth(2).boundingBox();
  const first = await items.nth(0).boundingBox();
  if (!last || !first) throw new Error("the tabs are not on screen");

  // The last tab is let go on the top half of the first one: it goes first.
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width / 2, last.y - 10, { steps: 4 });
  await page.mouse.move(first.x + first.width / 2, first.y + 2, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(async () => (await windowSpace(page, windowId)).tree.map((node) => node.id))
    .toEqual([before[2], before[0], before[1]]);
  // The sidebar shows the same order, and the tabs are the same shells.
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute("data-row-id", before[2] ?? "");
  expect(await sessionStarts(page)).toBe(starts);
  expect(await killedSessions(page)).toEqual(killed);
  await expect(panels(page)).toHaveCount(1);
  await clicksReachThePage(page);
});

test("a window cannot ask for another window's tabs, another space, a window that is not there, or what it may not do", async ({
  page,
}) => {
  await open(page);
  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  await dragOut(page, "deploy");
  await expect(panels(page)).toHaveCount(2);
  const [first = "", second = ""] = await windowIds(page);
  const mine = await windowSpace(page, first);
  const theirs = await windowSpace(page, second);
  expect(Object.keys(mine.items)).toEqual(["i6"]);
  expect(Object.keys(theirs.items)).toEqual(["i5"]);
  const starts = await sessionStarts(page);
  const snapshot = async () => JSON.stringify(await saved(page));
  const before = await snapshot();

  const wrong: [string, unknown][] = [
    // The first window asks about the tabs and the space of the second, and of the main window.
    [first, { type: "item/close", itemId: "i5" }],
    [first, { type: "item/close", itemId: "i1" }],
    [first, { type: "item/create", spaceId: theirs.id }],
    [first, { type: "item/create", spaceId: "s1" }],
    [first, { type: "item/move", itemId: "i5", placement: { to: "tree", index: 0 } }],
    [first, { type: "space/set-active-item", spaceId: theirs.id, itemId: "i5" }],
    // Something that is not a window of the workspace.
    ["nope", { type: "item/close", itemId: "i6" }],
    ["nope", { type: "item/create", spaceId: mine.id }],
    // What a window may not do at all.
    [first, { type: "space/delete", spaceId: mine.id, items: { mode: "close" } }],
    [first, { type: "window/close", windowId: second }],
    [first, { type: "item/pin", itemId: "i6" }],
    [first, { type: "item/move", itemId: "i6", placement: { to: "tree", groupId: "g1" } }],
    [first, { type: "item/move", itemId: "i6", placement: { to: "tree", index: -3 } }],
    [first, { type: "item/close" }],
    [first, null],
  ];
  for (const [windowId, action] of wrong) await ask(page, windowId, action);
  // A request that is fine goes through behind them, which also shows the others were heard.
  await ask(page, first, { type: "item/create", spaceId: mine.id });
  await expect.poll(async () => Object.keys((await windowSpace(page, first)).items).length).toBe(2);
  await expect(xterms(panels(page).first())).toHaveCount(2);

  expect(await sessionStarts(page)).toBe(starts + 1);
  expect(await killedSessions(page)).toEqual([]);
  const after = JSON.parse(await snapshot()) as Saved;
  const unchanged = JSON.parse(before) as Saved;
  // Only the first window's space gained its tab: everything else is as it was.
  expect(after.windows).toEqual(unchanged.windows);
  for (const space of after.spaces) {
    if (space.id === mine.id) continue;
    expect(space, space.id).toEqual(unchanged.spaces.find((s) => s.id === space.id));
  }
  expect(await windowIds(page)).toEqual([first, second]);
});

test("the tab a window shows is read: an unread tab that moves there loses its mark", async ({
  page,
}) => {
  await open(page);
  // "logs" has output nobody has seen: its mark is in the sidebar of the main window.
  await expect(row(page, "logs").locator('[data-nr-indicator="unread"]')).toBeVisible();
  await dragOut(page, "logs");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(panelRow(panel, "logs")).toHaveAttribute("aria-current", "true");
  await expect(panel.locator('[data-nr-indicator="unread"]')).toHaveCount(0);
  await expect(panel.locator('[data-nr-indicator="bell"]')).toHaveCount(0);
  const [windowId = ""] = await windowIds(page);
  const pane = (await windowSpace(page, windowId)).items["i4"]?.layout.pane;
  expect(pane?.unread ?? false).toBe(false);
  expect(pane?.bell ?? false).toBe(false);
});

test("a tab behind the one a window shows keeps its mark until the window shows it", async ({
  page,
}) => {
  // A saved window of the user with two tabs, the second one unread and with a bell.
  const state = JSON.parse(sidebarState({ secondSpace: true })) as Saved & {
    spaces: { items: Record<string, SavedItem> }[];
  };
  const other = state.spaces.find((s) => s.id === "s2");
  if (other === undefined) throw new Error("the second space is in the fixture");
  const seen = other.items["j1"];
  if (seen === undefined) throw new Error("the tab is in the fixture");
  other.items["j2"] = {
    ...seen,
    id: "j2",
    title: "waiting",
    layout: {
      kind: "pane",
      pane: {
        id: "q2",
        type: "terminal",
        profileId: "default",
        status: "idle",
        unread: true,
        bell: true,
      },
    } as SavedItem["layout"],
    focusedPaneId: "q2",
  } as SavedItem;
  other.tree.push({ kind: "item", id: "j2" });
  state.windows = [{ id: "w1", spaceId: "s2" }];
  await page.addInitScript(
    ({ key, text }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, text);
    },
    { key: WEB_STATE_KEY, text: JSON.stringify(state) },
  );
  await page.goto("/?window-preview");
  await expect(row(page, "api")).toBeVisible();
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(panelRow(panel, "elsewhere")).toHaveAttribute("aria-current", "true");
  // The tab behind has its marks; the window does not show it.
  await expect(panelRow(panel, "waiting").locator('[data-nr-indicator="unread"]')).toBeVisible();
  await expect(panelRow(panel, "waiting").locator('[data-nr-indicator="bell"]')).toBeVisible();

  // Showing it in the window reads it.
  await panelRow(panel, "waiting").click();
  await expect(panelRow(panel, "waiting")).toHaveAttribute("aria-current", "true");
  await expect(panel.locator('[data-nr-indicator="unread"]')).toHaveCount(0);
  await expect(panel.locator('[data-nr-indicator="bell"]')).toHaveCount(0);
  await expect
    .poll(async () => (await windowSpace(page, "w1")).items["j2"]?.layout.pane?.unread ?? false)
    .toBe(false);
  expect((await windowSpace(page, "w1")).items["j2"]?.layout.pane?.bell ?? false).toBe(false);
});

test("axe: a window with the sidebar of its space, a second tab and an unread one has no violation", async ({
  page,
}) => {
  const { panel } = await openWithWindow(page);
  await addTab(panel, 2);
  await expectNoAxeViolations(page, "window with its sidebar");
});

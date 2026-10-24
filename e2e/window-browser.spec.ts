import { expect, test } from "./test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { clicksReachThePage } from "./sidebar-fixture";
import { openCommandPalette } from "./palette-fixture";

// The browser pane in a window besides the main one (NOR-F15-04e). A tab with a browser pane goes to
// a window by dragging it out or by "Move tab to new window", and the page of the window draws the
// address bar and the area of the pane. The web view itself is a native child of the window, and the
// page of a window can call no command about a web view (its capability has none), so the main
// window opens it for the window, with the bounds the page of that window measured and sent
// (`window-browser`, `window-browser-result`), after checking that the request is the window's own.
// A browser has no second window, so `/?window-preview` draws each one as a panel beside the app on
// the same fake backend and the same events, with a backend for the panel that refuses the four web
// view calls as the real window does (see window-drag.spec.ts): a web view that exists for a panel
// was opened by the main window. `browserViews` says which window each web view is a child of. What
// the panels cannot say (the real native child, its parent in Tauri, the page that cannot reach the
// app) is in `noren --smoke-window`.
//
// The seeded main window ("Main"), the first tab on screen:
//   plain     a terminal
//   web       a terminal and a browser pane (WEB_URL)
//   solo      a browser pane alone (SOLO_URL)
//   stay      a terminal and a browser pane (STAY_URL), the tab that is never moved
//   other     a terminal and a browser pane (OTHER_URL), for a second window

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface View {
  paneId: string;
  url: string;
  bounds: Bounds;
  windowId?: string;
}
interface Hook {
  paneIds(): string[];
  browserViews(): View[];
  browserCalls(): { method: string; paneId: string }[];
}
interface WindowsHook {
  windows(): string[];
  closeByPerson(windowId: string): void;
  browse(windowId: string, body: unknown): void;
  browserReplies(): unknown[];
}
type HookWindow = Window & { __norenTest?: Hook; __norenWindows?: WindowsHook };

const WEB_STATE_KEY = "noren.web.state";
const WEB_URL = "https://example.com/a";
const SOLO_URL = "https://example.org/b";
const STAY_URL = "https://example.net/main";
const OTHER_URL = "https://example.org/other";

interface PaneSeed {
  id: string;
  kind: "terminal" | "browser";
  url?: string;
}
interface TabSeed {
  id: string;
  title: string;
  panes: PaneSeed[];
}
const TABS: TabSeed[] = [
  { id: "i1", title: "plain", panes: [{ id: "p1", kind: "terminal" }] },
  {
    id: "i2",
    title: "web",
    panes: [
      { id: "p2", kind: "terminal" },
      { id: "p3", kind: "browser", url: WEB_URL },
    ],
  },
  { id: "i3", title: "solo", panes: [{ id: "p4", kind: "browser", url: SOLO_URL }] },
  {
    id: "i4",
    title: "stay",
    panes: [
      { id: "p5", kind: "terminal" },
      { id: "p6", kind: "browser", url: STAY_URL },
    ],
  },
  {
    id: "i5",
    title: "other",
    panes: [
      { id: "p7", kind: "terminal" },
      { id: "p8", kind: "browser", url: OTHER_URL },
    ],
  },
];

function paneJson(seed: PaneSeed): Record<string, unknown> {
  const common = { id: seed.id, profileId: "default", status: "idle", unread: false, bell: false };
  return seed.kind === "browser"
    ? { ...common, type: "browser", url: seed.url }
    : { ...common, type: "terminal" };
}

function savedState(): string {
  const items = Object.fromEntries(
    TABS.map((tab) => {
      const panes = tab.panes.map((pane) => ({ kind: "pane" as const, pane: paneJson(pane) }));
      const layout =
        panes.length === 1
          ? panes[0]
          : {
              kind: "split",
              dir: "row",
              sizes: panes.map(() => 100 / panes.length),
              children: panes,
            };
      return [
        tab.id,
        {
          id: tab.id,
          title: tab.title,
          titleLocked: true,
          layout,
          focusedPaneId: tab.panes[0]?.id,
          lastActivityAt: 1,
        },
      ];
    }),
  );
  return JSON.stringify({
    version: 2,
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
    spaces: [
      {
        id: "s1",
        name: "Main",
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: false,
        pinned: [],
        tree: TABS.map((tab) => ({ kind: "item", id: tab.id })),
        items,
        activeItemId: "i1",
      },
    ],
  });
}

/** Puts the saved workspace in the browser storage before the page loads (once). */
async function seed(page: Page): Promise<void> {
  await page.addInitScript(
    ({ stateKey, state }) => {
      if (window.localStorage.getItem(stateKey) !== null) return;
      window.localStorage.setItem(stateKey, state);
    },
    { stateKey: WEB_STATE_KEY, state: savedState() },
  );
}

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
const areaIn = (scope: Locator): Locator => scope.locator('[data-nr-part="browser-view"]');
const addressIn = (scope: Locator): Locator =>
  scope.getByRole("textbox", { name: "Address", exact: true });
const problemIn = (scope: Locator): Locator => scope.locator('[data-nr-part="browser-problem"]');

const views = (page: Page): Promise<View[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.browserViews() ?? []);
const calls = (page: Page): Promise<{ method: string; paneId: string }[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.browserCalls() ?? []);
const windowIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenWindows?.windows() ?? []);
const replies = (
  page: Page,
): Promise<{ windowId: string; request: number; ok?: boolean; failed?: string }[]> =>
  page.evaluate(
    () =>
      ((window as HookWindow).__norenWindows?.browserReplies() ?? []) as {
        windowId: string;
        request: number;
        ok?: boolean;
        failed?: string;
      }[],
  );
const browse = (page: Page, windowId: string, body: unknown): Promise<void> =>
  page.evaluate(([id, fields]) => (window as HookWindow).__norenWindows?.browse(id, fields), [
    windowId,
    body,
  ] as const);

/** The web view of one pane, or `undefined` when it has none. (The main window shows another tab when one leaves, and opens that tab's web view.) */
const viewOf = async (page: Page, paneId: string): Promise<View | undefined> =>
  (await views(page)).find((v) => v.paneId === paneId);
/** Whose child the web view of a pane is: a window id, `null` for the main window, `undefined` when the pane has none. */
const parentOf = async (page: Page, paneId: string): Promise<string | null | undefined> => {
  const view = await viewOf(page, paneId);
  return view === undefined ? undefined : (view.windowId ?? null);
};

interface SavedPane {
  id: string;
  type: string;
  url?: string;
}
/** The panes of a tab in the saved workspace, wherever the tab is. */
async function savedPanes(page: Page, itemId: string): Promise<SavedPane[]> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  const state = JSON.parse(text ?? "{}") as {
    spaces: {
      items: Record<
        string,
        { layout: { kind: string; pane?: SavedPane; children?: { pane?: SavedPane }[] } }
      >;
    }[];
  };
  for (const space of state.spaces) {
    const item = space.items[itemId];
    if (item === undefined) continue;
    return item.layout.kind === "pane"
      ? [item.layout.pane].filter((p): p is SavedPane => p !== undefined)
      : (item.layout.children ?? []).flatMap((c) => (c.pane === undefined ? [] : [c.pane]));
  }
  return [];
}

/** A web view that is out of sight has no area; one in sight has the area of its pane. */
const isHidden = (bounds: Bounds): boolean => bounds.width === 0 || bounds.height === 0;

/** Where the area of the pane is on the page, rounded as the pane rounds it. */
async function areaBounds(area: Locator): Promise<Bounds> {
  const box = await area.boundingBox();
  if (box === null) throw new Error("the area of the browser pane is not on screen");
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/** The requests of each page that failed (an asset the page did not get), for `expectOnArea` to say. */
const failedRequests = new WeakMap<Page, string[]>();

function watchRequests(page: Page): void {
  const failed: string[] = [];
  failedRequests.set(page, failed);
  page.on("requestfailed", (request) => {
    failed.push(`${request.url()} ${request.failure()?.errorText ?? ""}`.trim());
  });
}

/**
 * What a page that never got its stylesheet looks like here: the area of a browser
 * pane is a block with nothing in it, so it has no height and no web view is ever laid on it. The
 * failure says so, with the requests that failed, so it is not read as a layout that did not settle.
 */
async function pageFacts(page: Page, paneId: string, scope: Locator): Promise<string> {
  const rules = await page
    .evaluate(() =>
      [...document.styleSheets].reduce((n, sheet) => {
        try {
          return n + sheet.cssRules.length;
        } catch {
          return n;
        }
      }, 0),
    )
    .catch(() => -1);
  const where = await areaBounds(areaIn(scope).first()).catch((error: unknown) => String(error));
  const view = await viewOf(page, paneId).catch(() => undefined);
  return JSON.stringify({
    styleRules: rules,
    failedRequests: failedRequests.get(page) ?? [],
    area: where,
    view: view ?? null,
  });
}

/** The web view sits exactly on the area of the pane in `scope`, wherever the layout has put it by now. */
async function expectOnArea(page: Page, paneId: string, scope: Locator): Promise<void> {
  const message = `the web view of ${paneId} is on the area of its pane`;
  try {
    await expect
      .poll(
        async () => {
          const where = await areaBounds(areaIn(scope).first());
          const view = (await views(page)).find((v) => v.paneId === paneId);
          return (
            view !== undefined &&
            !isHidden(where) &&
            JSON.stringify(view.bounds) === JSON.stringify(where)
          );
        },
        { message },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(`${message}: ${await pageFacts(page, paneId, scope)}`, { cause: error });
  }
}

/** Presses on a tab of the main sidebar, drags it out of the page and lets go there. */
async function dragOut(page: Page, name: string): Promise<void> {
  await row(page, name).scrollIntoViewIfNeeded();
  const from = await row(page, name).boundingBox();
  if (!from) throw new Error(`${name} is not on screen`);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(-60, start.y + 20, { steps: 20 });
  await page.mouse.up();
  await clicksReachThePage(page);
}

async function open(page: Page): Promise<void> {
  watchRequests(page);
  await seed(page);
  await page.goto("/?window-preview");
  await expect(row(page, "plain")).toBeVisible();
  await expect
    .poll(
      async () =>
        await page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0),
    )
    .toBeGreaterThan(0);
}

/** Drags a tab out and waits for the panel of its window. */
async function dragToPanel(page: Page, name: string): Promise<Locator> {
  const before = await panels(page).count();
  await dragOut(page, name);
  await expect(panels(page)).toHaveCount(before + 1);
  return panels(page).nth(before);
}

/** Shows a tab of the main window (a pane that was never seen has no web view yet). */
async function show(page: Page, name: string): Promise<void> {
  await clicksReachThePage(page);
  await row(page, name).click();
  await expect(row(page, name)).toHaveAttribute("aria-current", "true");
}

test("a tab with a browser pane dragged out opens its web view as a child of the window, on the area the window measured", async ({
  page,
}) => {
  await open(page);
  // In the main window the web view is the main window's own child.
  await show(page, "web");
  await expect.poll(() => parentOf(page, "p3")).toBeNull();

  const panel = await dragToPanel(page, "web");
  const [windowId] = await windowIds(page);
  expect(windowId).toBeTruthy();
  await expect(row(page, "web")).toHaveCount(0);
  // The main window let go of its web view, and the one that exists is the window's: the pane, the
  // page of the pane, and a window that is the one asking.
  await expect.poll(() => parentOf(page, "p3")).toBe(windowId);
  expect((await viewOf(page, "p3"))?.url).toBe(WEB_URL);
  expect((await views(page)).filter((v) => v.paneId === "p3")).toHaveLength(1);
  // On the area that the page of the window measured: its own pane, not the area the pane had in
  // the main window.
  await expectOnArea(page, "p3", panel);
  await expect(addressIn(panel)).toHaveValue(WEB_URL);
  await expect(problemIn(panel)).toHaveCount(0);
  // The terminal of the tab came along, beside the pane.
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(1);
  // The main window answered the page of the window, and nothing else did.
  const answers = await replies(page);
  expect(answers.length).toBeGreaterThanOrEqual(2);
  expect(answers.every((a) => a.windowId === windowId && a.ok === true)).toBe(true);
});

test("Move tab to new window does the same for a tab that is only a browser pane", async ({
  page,
}) => {
  await open(page);
  await show(page, "solo");
  await openCommandPalette(page);
  await page.keyboard.type("Move tab to new");
  await page.keyboard.press("Enter");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  const [windowId] = await windowIds(page);
  await expect(row(page, "solo")).toHaveCount(0);
  await expect(panelRow(panel, "solo")).toBeVisible();
  await expect.poll(() => parentOf(page, "p4")).toBe(windowId);
  expect((await viewOf(page, "p4"))?.url).toBe(SOLO_URL);
  await expectOnArea(page, "p4", panel);
  await expect(panel.locator('[data-nr-part="window-terminal"]')).toHaveCount(0);
});

test("an address typed in the bar of the window is carried out by the main window", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  const [windowId] = await windowIds(page);
  await expectOnArea(page, "p3", panel);
  const before = (await calls(page)).filter((c) => c.method === "navigateBrowserPane").length;

  await addressIn(panel).fill("https://example.net/next");
  await addressIn(panel).press("Enter");
  // The pane of the workspace holds the address now, and the web view went there, still the
  // window's child and still on its area.
  await expect
    .poll(async () => (await savedPanes(page, "i2")).find((p) => p.id === "p3")?.url)
    .toBe("https://example.net/next");
  await expect.poll(async () => (await viewOf(page, "p3"))?.url).toBe("https://example.net/next");
  expect(await parentOf(page, "p3")).toBe(windowId);
  expect((await calls(page)).filter((c) => c.method === "navigateBrowserPane")).toHaveLength(
    before + 1,
  );
  await expectOnArea(page, "p3", panel);
  await expect(addressIn(panel)).toHaveValue("https://example.net/next");
  await expect(problemIn(panel)).toHaveCount(0);

  // An address the pane may not show is said in the window and goes nowhere.
  await addressIn(panel).fill("javascript:alert(1)");
  await addressIn(panel).press("Enter");
  await expect(problemIn(panel)).toHaveText("Only http and https addresses can be shown.");
  expect((await viewOf(page, "p3"))?.url).toBe("https://example.net/next");
  expect((await calls(page)).filter((c) => c.method === "navigateBrowserPane")).toHaveLength(
    before + 1,
  );
  expect((await savedPanes(page, "i2")).find((p) => p.id === "p3")?.url).toBe(
    "https://example.net/next",
  );
});

test("a call that is not the window's own is ignored: another window, another space, another pane, bad bounds, bad addresses", async ({
  page,
}) => {
  await open(page);
  const web = await dragToPanel(page, "web");
  const other = await dragToPanel(page, "other");
  const [first, second] = await windowIds(page);
  if (first === undefined || second === undefined) throw new Error("two windows were expected");
  await expectOnArea(page, "p3", web);
  await expectOnArea(page, "p8", other);
  const otherBefore = await viewOf(page, "p8");
  // (The main window opens the web view of whatever tab it shows by itself; these two panes are the
  // windows', so a call about either is the page's.)
  const callsAbout = async (): Promise<{ method: string; paneId: string }[]> =>
    (await calls(page)).filter((c) => c.paneId === "p3" || c.paneId === "p8");
  const callsBefore = (await callsAbout()).length;
  const answered = (await replies(page)).length;

  const place = { x: 3, y: 4, width: 321, height: 123 };
  const own = { request: 9001, op: "bounds", itemId: "i2", paneId: "p3", bounds: place };
  for (const [windowId, body] of [
    // A pane of the other window's space, and the other way round.
    [first, { ...own, itemId: "i5", paneId: "p8" }],
    [second, { ...own }],
    // A pane of the main window (a tab that stayed there).
    [first, { ...own, itemId: "i4", paneId: "p6" }],
    // A terminal, a pane that does not exist, a tab that does not exist.
    [first, { ...own, paneId: "p2" }],
    [first, { ...own, paneId: "ghost" }],
    [first, { ...own, itemId: "ghost" }],
    // The wrong tab for a pane that is the window's.
    [first, { ...own, itemId: "i5" }],
    // Bounds the backend would not take, and an operation that is not one of the four.
    [first, { ...own, bounds: { ...place, width: -1 } }],
    [first, { ...own, bounds: { ...place, height: 99999 } }],
    [first, { ...own, bounds: { ...place, x: "3" } }],
    [first, { ...own, bounds: null }],
    [first, { ...own, op: "reparent" }],
    [first, { ...own, op: "eval", url: "javascript:alert(1)" }],
    // Addresses the pane may not show.
    [first, { ...own, op: "navigate", url: "javascript:alert(1)" }],
    [first, { ...own, op: "navigate", url: "file:///C:/Windows/win.ini" }],
    [first, { ...own, op: "open", url: "http://tauri.localhost/", bounds: place }],
    // A window that is not one, and a number that is not a request.
    ["main", { ...own }],
    ["window-ghost", { ...own }],
    [first, { ...own, request: 0 }],
    [first, { ...own, request: "7" }],
  ] as const) {
    await browse(page, windowId, body);
  }
  // The right one, last: when it is answered the wrong ones before it were heard and passed over.
  await browse(page, first, own);
  await expect.poll(async () => (await replies(page)).length).toBe(answered + 1);
  expect((await replies(page)).slice(answered)).toEqual([
    { windowId: first, request: 9001, ok: true },
  ]);
  // The only change is the right one's: the web view of the window moved and none else did. (The
  // hook lists the calls that open, go to a page and close a web view, and none of those was made.)
  expect((await viewOf(page, "p3"))?.bounds).toEqual(place);
  expect((await viewOf(page, "p3"))?.url).toBe(WEB_URL);
  expect(await parentOf(page, "p3")).toBe(first);
  expect(await viewOf(page, "p8")).toEqual(otherBefore);
  expect((await callsAbout()).slice(callsBefore)).toEqual([]);

  // An address that was the pane's a moment ago and is not any more is refused with a reason,
  // so the page does not wait for an answer.
  const asked = (await replies(page)).length;
  await browse(page, first, {
    request: 9002,
    op: "navigate",
    itemId: "i2",
    paneId: "p3",
    url: "https://example.org/else",
  });
  await expect.poll(async () => (await replies(page)).length).toBe(asked + 1);
  expect((await replies(page)).at(-1)).toEqual({
    windowId: first,
    request: 9002,
    failed: "the pane is at another address now",
  });
  expect((await viewOf(page, "p3"))?.url).toBe(WEB_URL);
  expect((await callsAbout()).slice(callsBefore)).toEqual([]);
});

test("the web view of a tab that is not on screen in the window is out of sight, and comes back with the tab", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  const [windowId] = await windowIds(page);
  await expectOnArea(page, "p3", panel);
  // A new tab takes the screen: the pane has no area to be laid on, so its web view has none.
  await panel.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(2);
  await expect
    .poll(async () => {
      const view = await viewOf(page, "p3");
      return view !== undefined && isHidden(view.bounds);
    })
    .toBe(true);
  // Still a child of the window, still at its page.
  expect(await parentOf(page, "p3")).toBe(windowId);
  // Showing the tab again lays it on its area again.
  await panelRow(panel, "web").click();
  await expect(panelRow(panel, "web")).toHaveAttribute("aria-current", "true");
  await expectOnArea(page, "p3", panel);
  expect((await viewOf(page, "p3"))?.url).toBe(WEB_URL);
});

test("closing the tab in the window closes its web view", async ({ page }) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  await expectOnArea(page, "p3", panel);
  await panelRow(panel, "web").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect.poll(() => viewOf(page, "p3")).toBeUndefined();
  // That was the last tab of the window, so the window is closed too.
  await expect(panels(page)).toHaveCount(0);
  expect((await views(page)).filter((v) => v.windowId !== undefined)).toEqual([]);
});

test("closing the tab with the browser pane while the window has another tab closes its web view and keeps the window", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  await expectOnArea(page, "p3", panel);
  // A second tab, so the window stays when the first is closed (a window with no tab closes).
  await panel.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(2);
  await panelRow(panel, "web").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(panelRow(panel, "web")).toHaveCount(0);
  // Nobody asked the main window for this: the pane left the window and the web view went with it.
  await expect.poll(() => viewOf(page, "p3")).toBeUndefined();
  await expect(panels(page)).toHaveCount(1);
  expect((await views(page)).filter((v) => v.windowId !== undefined)).toEqual([]);
});

test("the person closes the window: the tab is back in the main window and its web view opens there, with no web view left for the window", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  const [windowId] = await windowIds(page);
  await expectOnArea(page, "p3", panel);
  expect(await parentOf(page, "p3")).toBe(windowId);

  await page.evaluate(
    (id) => (window as HookWindow).__norenWindows?.closeByPerson(id as string),
    windowId,
  );
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "web")).toBeVisible();
  // The tab shows again in the main window (it was the one the window showed): its web view is the
  // main window's own, laid on the area of the pane in the page, and nothing is left for the window.
  await expect(row(page, "web")).toHaveAttribute("aria-current", "true");
  const main = page.locator('[data-nr-part="item-view"]:not([hidden])');
  await expect.poll(() => parentOf(page, "p3")).toBeNull();
  await expectOnArea(page, "p3", main);
  expect((await viewOf(page, "p3"))?.url).toBe(WEB_URL);
  expect((await views(page)).filter((v) => v.windowId !== undefined)).toEqual([]);
});

test("the tab comes back with the address it was taken to in the window", async ({ page }) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  const [windowId] = await windowIds(page);
  await expectOnArea(page, "p3", panel);
  await addressIn(panel).fill("https://example.net/moved");
  await addressIn(panel).press("Enter");
  await expect.poll(async () => (await viewOf(page, "p3"))?.url).toBe("https://example.net/moved");
  await page.evaluate(
    (id) => (window as HookWindow).__norenWindows?.closeByPerson(id as string),
    windowId,
  );
  await expect(panels(page)).toHaveCount(0);
  const main = page.locator('[data-nr-part="item-view"]:not([hidden])');
  await expect.poll(() => parentOf(page, "p3")).toBeNull();
  expect((await viewOf(page, "p3"))?.url).toBe("https://example.net/moved");
  await expect(addressIn(main)).toHaveValue("https://example.net/moved");
});

test("the window comes back after a reload and opens its web view again as its own child", async ({
  page,
}) => {
  await open(page);
  const panel = await dragToPanel(page, "web");
  const [windowId] = await windowIds(page);
  await expectOnArea(page, "p3", panel);
  await page.reload();
  await expect(row(page, "plain")).toBeVisible();
  await expect(panels(page)).toHaveCount(1);
  await expect.poll(() => parentOf(page, "p3")).toBe(windowId);
  expect((await views(page)).filter((v) => v.paneId === "p3")).toHaveLength(1);
  await expectOnArea(page, "p3", panels(page).first());
});

test("two windows each keep the web view of their own pane, and the tab that stayed keeps the main window's", async ({
  page,
}) => {
  await open(page);
  const web = await dragToPanel(page, "web");
  const other = await dragToPanel(page, "other");
  const [first, second] = await windowIds(page);
  await show(page, "stay");
  const parents = async (): Promise<(string | null | undefined)[]> => [
    await parentOf(page, "p3"),
    await parentOf(page, "p6"),
    await parentOf(page, "p8"),
  ];
  await expect.poll(parents).toEqual([first, null, second]);
  await expectOnArea(page, "p3", web);
  await expectOnArea(page, "p8", other);
  // Closing one window takes only its web view; the tab comes back to the main window, which opens
  // the pane again as its own child, and the other window keeps its own.
  await page.evaluate(
    (id) => (window as HookWindow).__norenWindows?.closeByPerson(id as string),
    first,
  );
  await expect(panels(page)).toHaveCount(1);
  await expect.poll(parents).toEqual([null, null, second]);
});

test("axe: a window with a browser pane has no violation", async ({ page }) => {
  await open(page);
  await show(page, "web");
  const panel = await dragToPanel(page, "web");
  await expect(addressIn(panel)).toHaveValue(WEB_URL);
  await expectNoAxeViolations(page, "window with a browser pane");
});

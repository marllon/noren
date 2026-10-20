import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { clicksReachThePage, seedSidebarState } from "./sidebar-fixture";

// A tab dragged out of the window (NOR-F15-04b): letting go of a tab beyond the edge of the page
// makes a window with a space of its own and takes the tab there; the page of that window draws the
// tabs and the splits of its space from the state the main window sends it, and closing the window
// gives the tab back. A browser has no second window to draw, so `/?window-preview` draws each one as
// a panel beside the app, on the same backend and the same events, as `?quick-preview` does for the
// quick terminal. What the panels cannot say (the real native window, its capability, the order of
// the Rust side) is in `noren --smoke-window`, which also sends a real page the same state event.
//
// The seeded sidebar: pinned "notes", the group "Work" (api, build, logs), "deploy", "scratch", and
// with `split` the tab "servers" with two panes.

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
}
type HookWindow = Window & { __norenTest?: Hook; __norenWindows?: WindowsHook };

const WEB_STATE_KEY = "noren.web.state";

// The sidebar of the main window: a window panel has a tree with the same name of its own.
const list = (page: Page) =>
  page.locator('[data-nr-part="sidebar"]').getByRole("tree", { name: "Tabs", exact: true });
const row = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const spaceButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Spaces", exact: true }).getByRole("button", {
    name,
    exact: true,
  });
const panels = (page: Page): Locator => page.locator('[data-nr-part="window-preview"]');
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
/** The row of a tab in the sidebar of a window (its tree of tabs is the main window's own). */
const windowRow = (panel: Locator, name: string): Locator =>
  panel
    .getByRole("tree", { name: "Tabs", exact: true })
    .getByRole("treeitem", { name, exact: true });

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

interface Saved {
  activeSpaceId: string;
  windows?: { id: string; spaceId: string; returnSpaceId?: string }[];
  spaces: {
    id: string;
    name: string;
    pinned: string[];
    activeItemId?: string;
    tree: { kind: string; id: string }[];
    items: Record<string, { layout: { kind: string }; focusedPaneId?: string }>;
  }[];
}

/** The saved workspace, as the web backend keeps it. */
async function saved(page: Page): Promise<Saved> {
  const text = await page.evaluate((key) => window.localStorage.getItem(key), WEB_STATE_KEY);
  return JSON.parse(text ?? "{}") as Saved;
}

const paneCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds().length ?? 0);
const mainLines = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []);
const sessionStarts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? -1);
const killedSessions = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.killedSessions() ?? []);

const windowIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as HookWindow).__norenWindows?.windows() ?? []);
const windowLines = (page: Page, windowId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenWindows?.lines(id) ?? [], windowId);

/**
 * Presses on a tab of the sidebar, drags it out of the page and lets go there: the pointer is left
 * `past` pixels beyond the left edge (the margin of the page is 8).
 */
async function dragOut(page: Page, name: string, past = 60): Promise<void> {
  const from = await row(page, name).boundingBox();
  if (!from) throw new Error(`${name} is not on screen`);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10, { steps: 3 });
  await page.mouse.move(-past, start.y + 20, { steps: 20 });
  await page.mouse.up();
}

async function open(page: Page, options: { split?: boolean } = {}): Promise<void> {
  await seedSidebarState(page, { secondSpace: true, ...options });
  await page.goto("/?window-preview");
  await expect(row(page, "api")).toBeVisible();
  await expect.poll(() => paneCount(page)).toBeGreaterThan(0);
}

const START = ["notes@0", "Work@0", "api@1", "build@1", "logs@1", "deploy@0", "scratch@0"];

test("letting go of a tab beyond the edge of the page makes a window that shows the tab", async ({
  page,
}) => {
  await open(page);
  await expect(panels(page)).toHaveCount(0);
  await dragOut(page, "scratch");

  // The window is there, named after the tab, with the tab drawn in its tab strip and a terminal.
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(panel.locator('[data-nr-part="window-title"]')).toHaveText("scratch");
  const tab = windowRow(panel, "scratch");
  await expect(tab).toHaveAttribute("aria-current", "true");
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toBeVisible();

  // The tab left the space it came from; the main window is on the same space with the rest.
  await expect(row(page, "scratch")).toHaveCount(0);
  expect(await rows(page)).toEqual(START.slice(0, -1));
  // The space made for the window is not one the main window lists: only Main and Other are.
  await expect(spaceButton(page, "Main")).toBeVisible();
  await expect(spaceButton(page, "Other")).toBeVisible();
  await expect(spaceButton(page, "scratch")).toHaveCount(0);

  // The workspace remembers it: a window on a space of its own, which holds the tab and says where
  // the tab came from; the main window is still on the first space.
  await expect.poll(async () => (await saved(page)).windows?.length).toBe(1);
  const state = await saved(page);
  const window = state.windows?.[0];
  expect(window?.returnSpaceId).toBe("s1");
  const made = state.spaces.find((s) => s.id === window?.spaceId);
  expect(made?.name).toBe("scratch");
  expect(Object.keys(made?.items ?? {})).toEqual(["i6"]);
  expect(state.spaces.find((s) => s.id === "s1")?.tree.map((n) => n.id)).not.toContain("i6");
  expect(state.activeSpaceId).toBe("s1");
});

test("the shell of the tab is the same one in the window: nothing is started or ended", async ({
  page,
}) => {
  await open(page);
  // Work in the tab first, so the shell has something to show for it.
  await row(page, "scratch").click();
  await page.keyboard.type("echo before-the-drag");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await mainLines(page)).includes("before-the-drag")).toBe(true);
  const starts = await sessionStarts(page);

  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toBeVisible();

  // The terminal of the tab is drawn by the page of the window and by no other: the main window
  // does not draw the space the window shows, or it would take the output of the shell back.
  await expect(page.locator('[data-nr-part="pane"][data-pane-id="p6"]')).toHaveCount(1);
  await expect(panel.locator('[data-nr-part="pane"][data-pane-id="p6"]')).toHaveCount(1);

  // No shell was started or ended by the move.
  expect(await sessionStarts(page)).toBe(starts);
  expect(await killedSessions(page)).toEqual([]);

  // What is typed in the window goes to the shell, and its answer comes back to the window.
  await panel.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("echo from-the-window");
  await page.keyboard.press("Enter");
  const id = (await windowIds(page))[0] ?? "";
  await expect
    .poll(async () => (await windowLines(page, id)).includes("from-the-window"))
    .toBe(true);
  // The tab the main window shows now is another one: the answer did not go there.
  expect(await mainLines(page)).not.toContain("from-the-window");
});

test("a tab with a split opens the window with the split", async ({ page }) => {
  await open(page, { split: true });
  await expect(row(page, "servers")).toBeVisible();
  await dragOut(page, "servers");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  // Both panes of the tab are drawn in the window, side by side, each with its terminal.
  await expect(panel.locator('[data-nr-part="pane"]')).toHaveCount(2);
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(2);
  await expect(panel.locator(".split-group")).toHaveCount(1);
  await expect.poll(async () => (await saved(page)).windows?.length).toBe(1);
  const state = await saved(page);
  const made = state.spaces.find((s) => s.id === state.windows?.[0]?.spaceId);
  expect(made?.items["i7"]?.layout.kind).toBe("split");
});

test("a tab let go inside the page, even close to the edge, stays where it is", async ({
  page,
}) => {
  await open(page);
  // Within the margin of the edge: still the page.
  await dragOut(page, "scratch", 4);
  await clicksReachThePage(page);
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "scratch")).toBeVisible();
  expect((await saved(page)).windows).toBeUndefined();
});

test("Move tab to new window in the palette takes the tab on screen to a window too", async ({
  page,
}) => {
  await open(page);
  await row(page, "build").click();
  await page.keyboard.press("Control+Shift+P");
  const palette = page.locator('[data-nr-part="palette"]');
  await expect(palette).toBeVisible();
  await page.keyboard.type("Move tab to new");
  const option = palette.getByRole("option", { name: /Move tab to new window/ });
  await expect(option).toHaveCount(1);
  await page.keyboard.press("Enter");

  await expect(panels(page)).toHaveCount(1);
  await expect(panels(page).first().locator('[data-nr-part="window-title"]')).toHaveText("build");
  await expect(row(page, "build")).toHaveCount(0);
  expect(await rows(page)).toEqual([
    "notes@0",
    "Work@0",
    "api@1",
    "logs@1",
    "deploy@0",
    "scratch@0",
  ]);
  // The main window shows another tab of the same space now.
  await expect(list(page).locator('[aria-current="true"]')).toHaveCount(1);
});

test("closing the window gives the tab back to the space it came from, with the same shell", async ({
  page,
}) => {
  await open(page);
  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  const starts = await sessionStarts(page);
  await expect(
    panels(page).first().locator('[data-nr-part="window-terminal"] .xterm'),
  ).toBeVisible();

  // The person closes the window with the button of its frame.
  await panels(page).first().getByRole("button", { name: "Close window", exact: true }).click();
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "scratch")).toBeVisible();
  expect(await rows(page)).toEqual(START);
  // The space made for the window went with it, and the state says so.
  await expect(spaceButton(page, "scratch")).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).windows).toBeUndefined();
  expect((await saved(page)).spaces.map((s) => s.id)).toEqual(["s1", "s2"]);

  // The shell never restarted, and it answers in the main window now.
  expect(await sessionStarts(page)).toBe(starts);
  expect(await killedSessions(page)).toEqual([]);
  // The tab the window showed is the one the main window shows now.
  await expect(row(page, "scratch")).toHaveAttribute("aria-current", "true");
  await page.locator('[data-nr-part="pane"]:visible').click();
  await page.keyboard.type("echo back-home");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await mainLines(page)).includes("back-home")).toBe(true);
});

test("the window comes back after a reload, with its tab, and the tab stays out of the main window", async ({
  page,
}) => {
  await open(page);
  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  const [before] = await windowIds(page);
  await expect.poll(async () => (await saved(page)).windows?.length).toBe(1);

  await page.reload();
  await expect(row(page, "api")).toBeVisible();
  // The window is opened again from the saved state, the same one, with a terminal for its tab.
  await expect(panels(page)).toHaveCount(1);
  expect(await windowIds(page)).toEqual([before]);
  const panel = panels(page).first();
  await expect(panel.locator('[data-nr-part="window-title"]')).toHaveText("scratch");
  await expect(windowRow(panel, "scratch")).toHaveAttribute("aria-current", "true");
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toBeVisible();
  await expect(row(page, "scratch")).toHaveCount(0);
  expect(await rows(page)).toEqual(START.slice(0, -1));

  // The shell of the tab answers in the window.
  await panel.getByRole("textbox", { name: "Terminal input", exact: true }).focus();
  await page.keyboard.type("echo after-reload");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await windowLines(page, before ?? "")).includes("after-reload"))
    .toBe(true);

  // And closing it after the reload still gives the tab back.
  await panel.getByRole("button", { name: "Close window", exact: true }).click();
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "scratch")).toBeVisible();
  expect(await rows(page)).toEqual(START);
});

test("a page that cannot show a window gives the tabs of the saved windows back to the main window", async ({
  page,
}) => {
  await open(page);
  await dragOut(page, "scratch");
  await expect(panels(page)).toHaveCount(1);
  await expect.poll(async () => (await saved(page)).windows?.length).toBe(1);
  // The same state in a browser without the preview: there is nowhere to put the window, and the
  // tab must not be left out of sight in a space nobody shows.
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "scratch")).toBeVisible();
  expect(await rows(page)).toEqual(START);
  await expect.poll(async () => (await saved(page)).windows).toBeUndefined();
});

test("a tab with a browser pane stays in the main window and says why", async ({ page }) => {
  await page.addInitScript(
    ({ key }) => {
      if (window.localStorage.getItem(key) !== null) return;
      const pane = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        profileId: "default",
        status: "idle",
        unread: false,
        bell: false,
        ...extra,
      });
      const space = {
        id: "s1",
        name: "Main",
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: true,
        pinned: [],
        tree: [
          { kind: "item", id: "i1" },
          { kind: "item", id: "i2" },
        ],
        items: {
          i1: {
            id: "i1",
            title: "plain",
            titleLocked: true,
            layout: { kind: "pane", pane: pane("p1", { type: "terminal" }) },
            focusedPaneId: "p1",
            lastActivityAt: 1,
          },
          i2: {
            id: "i2",
            title: "with web",
            titleLocked: true,
            layout: {
              kind: "split",
              dir: "row",
              sizes: [50, 50],
              children: [
                { kind: "pane", pane: pane("p2", { type: "terminal" }) },
                {
                  kind: "pane",
                  pane: pane("p3", { type: "browser", url: "https://example.com/" }),
                },
              ],
            },
            focusedPaneId: "p2",
            lastActivityAt: 1,
          },
        },
        activeItemId: "i1",
      };
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          activeSpaceId: "s1",
          favorites: [],
          closed: [],
          archive: [],
          spaces: [space],
        }),
      );
    },
    { key: WEB_STATE_KEY },
  );
  await page.goto("/?window-preview");
  await expect(row(page, "with web")).toBeVisible();
  await dragOut(page, "with web");
  await expect(notice(page)).toHaveText("A tab with a browser pane stays in the main window.");
  await expect(panels(page)).toHaveCount(0);
  await expect(row(page, "with web")).toBeVisible();
  expect((await saved(page)).windows).toBeUndefined();

  // The palette command says the same, for the tab on screen: the click that shows it must not be
  // one the drag library swallows right after a drop.
  await clicksReachThePage(page);
  await row(page, "with web").click();
  await expect(row(page, "with web")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Move tab to new");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("A tab with a browser pane stays in the main window.");
  await expect(panels(page)).toHaveCount(0);
});

test("in a browser without a second window, dragging out does nothing and the palette says why", async ({
  page,
}) => {
  await seedSidebarState(page, { secondSpace: true });
  await page.goto("/");
  await expect(row(page, "api")).toBeVisible();
  await dragOut(page, "scratch");
  await clicksReachThePage(page);
  await expect(row(page, "scratch")).toBeVisible();
  expect((await saved(page)).windows).toBeUndefined();

  await row(page, "build").click();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Move tab to new");
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("Other windows need the desktop app.");
  await expect(row(page, "build")).toBeVisible();
});

test("Portuguese: the notice and the palette command are in the language of the page", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "pt-BR" });
  const page = await context.newPage();
  await seedSidebarState(page, { secondSpace: true });
  await page.goto("/");
  await expect(
    page.locator('[data-nr-part="item-title"]').filter({ hasText: "api" }),
  ).toBeVisible();
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Levar a aba");
  await expect(
    page.locator('[data-nr-part="palette"]').getByRole("option", {
      name: /Levar a aba para uma janela nova/,
    }),
  ).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText("As outras janelas precisam do app de desktop.");
  await context.close();
});

test("what the window asks for is carried out by the main window: another tab, a focused pane", async ({
  page,
}) => {
  // A saved state with a window that holds two tabs, the second one split in two.
  await page.addInitScript(
    ({ key }) => {
      if (window.localStorage.getItem(key) !== null) return;
      const pane = (id: string) => ({
        kind: "pane",
        pane: {
          id,
          type: "terminal",
          profileId: "default",
          status: "idle",
          unread: false,
          bell: false,
        },
      });
      const space = (id: string, name: string, items: Record<string, unknown>, tree: string[]) => ({
        id,
        name,
        icon: "terminal",
        color: "#6b8afd",
        modIds: [],
        defaults: { env: {} },
        aiEnabled: true,
        saveScrollback: true,
        pinned: [],
        tree: tree.map((itemId) => ({ kind: "item", id: itemId })),
        items,
        activeItemId: tree[0],
      });
      const tab = (id: string, title: string, layout: unknown, focused: string) => ({
        id,
        title,
        titleLocked: true,
        layout,
        focusedPaneId: focused,
        lastActivityAt: 1,
      });
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 2,
          activeSpaceId: "s1",
          favorites: [],
          closed: [],
          archive: [],
          windows: [{ id: "win1", spaceId: "s3", returnSpaceId: "s1" }],
          spaces: [
            space("s1", "Main", { a: tab("a", "home", pane("pa"), "pa") }, ["a"]),
            space(
              "s3",
              "Out",
              {
                w1: tab("w1", "one", pane("pw1"), "pw1"),
                w2: tab(
                  "w2",
                  "two",
                  {
                    kind: "split",
                    dir: "row",
                    sizes: [50, 50],
                    children: [pane("pw2"), pane("pw3")],
                  },
                  "pw2",
                ),
              },
              ["w1", "w2"],
            ),
          ],
        }),
      );
    },
    { key: WEB_STATE_KEY },
  );
  await page.goto("/?window-preview");
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(panel.locator('[data-nr-part="item"]')).toHaveCount(2);
  await expect(windowRow(panel, "one")).toHaveAttribute("aria-current", "true");
  // Every tab keeps its terminals mounted; the one on screen is the first.
  await expect(panel.locator('[data-nr-part="window-terminal"] .xterm')).toHaveCount(3);
  await expect(panel.locator('[data-nr-part="window-item"][data-nr-item="w2"]')).toBeHidden();

  // Pressing the other tab asks the main window to show it: the saved state says so, and the
  // page, which draws what it is sent, shows it.
  await windowRow(panel, "two").click();
  await expect(windowRow(panel, "two")).toHaveAttribute("aria-current", "true");
  await expect(panel.locator('[data-nr-part="window-item"][data-nr-item="w2"]')).toBeVisible();
  await expect(panel.locator('[data-nr-part="window-item"][data-nr-item="w1"]')).toBeHidden();
  await expect
    .poll(async () => (await saved(page)).spaces.find((s) => s.id === "s3")?.activeItemId)
    .toBe("w2");

  // Pressing the other pane of the split focuses it.
  await panel.locator('[data-nr-part="pane"][data-pane-id="pw3"]').click();
  await expect(panel.locator('[data-nr-part="pane"][data-pane-id="pw3"]')).toHaveAttribute(
    "data-nr-focused",
    "true",
  );
  await expect
    .poll(
      async () => (await saved(page)).spaces.find((s) => s.id === "s3")?.items["w2"]?.focusedPaneId,
    )
    .toBe("pw3");
});

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { expectNoAxeViolations } from "./axe-fixture";
import { openSettings, seedConfig, settingsScreen } from "./settings-fixture";

// The browser pane (NOR-F15-01b). Ctrl+click on an address in the output opens a pane beside the
// terminal with an address bar; the page itself is a native web view laid over the window, which web
// mode does not have, so these tests run on the `FakeBackend`, which keeps the web views in memory
// (`browserViews`: the pane, the page and where the view is) and records every call about them
// (`browserCalls`). What they hold: the bar, which addresses are refused and with what words, the
// pane after a reload, and the life of the web view (opened when the pane is first seen, following
// its area, out of sight with no area while the pane is not seen or a dialog covers it, closed when
// the pane, the tab or the space goes away). What a screen would show of the stacking, and the
// repainting of a real engine, needs a visible window and is not here.

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Hook {
  paneIds(): string[];
  focusedPaneId(): string | undefined;
  sendOutput(paneId: string, text: string): boolean;
  split(dir: "row" | "column", paneId?: string): string | undefined;
  openedLinks(): string[];
  browserViews(): { paneId: string; url: string; bounds: Bounds }[];
  browserCalls(): { method: string; paneId: string }[];
  sessionStarts(): unknown[];
  advanceClock(ms: number): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_STATE_KEY = "noren.web.state";
const CLEAR = "\x1b[2J\x1b[H";
const PAGE = "https://example.com/docs?a=1";
const OTHER = "https://example.org/next";

const linkDialog = (page: Page) => page.getByRole("alertdialog", { name: "Open link" });
const browserPane = (page: Page) => page.locator('[data-nr-part="browser-pane"]');
const area = (page: Page) => page.locator('[data-nr-part="browser-view"]');
const address = (page: Page) => page.getByRole("textbox", { name: "Address", exact: true });
const problem = (page: Page) => page.locator('[data-nr-part="browser-problem"]');
const tabList = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
/** The tabs of the sidebar (the panes of a split tab are rows too, and are not these). */
const tabs = (page: Page) => tabList(page).locator('[data-nr-part="item"]');
const spaceButton = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Spaces", exact: true })
    .getByRole("button", { name, exact: true });

const views = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.browserViews() ?? []);
const calls = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.browserCalls() ?? []);
const callsOf = async (page: Page, method: string): Promise<number> =>
  (await calls(page)).filter((call) => call.method === method).length;
const paneIds = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.paneIds() ?? []);
const openedLinks = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.openedLinks() ?? []);
const shells = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? 0);
const savedState = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key) ?? "", WEB_STATE_KEY);

/** A web view that is out of sight has no area; one in sight has the area of its pane. */
const isHidden = (bounds: Bounds): boolean => bounds.width === 0 || bounds.height === 0;

async function start(page: Page): Promise<string> {
  await page.goto("/");
  await expect.poll(async () => (await paneIds(page)).length).toBe(1);
  const [id = ""] = await paneIds(page);
  expect(id).not.toBe("");
  return id;
}

async function print(page: Page, paneId: string, text: string): Promise<void> {
  const sent = await page.evaluate(
    ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
    { id: paneId, bytes: CLEAR + text },
  );
  expect(sent).toBe(true);
}

/** Clicks the first row of the terminal on screen, `x` pixels from its left edge. */
async function clickFirstRow(page: Page, x: number, withCtrl: boolean): Promise<void> {
  const screen = page.locator(".xterm-screen:visible").first();
  const box = await screen.boundingBox();
  if (box === null) throw new Error("the terminal is not on screen");
  const rows = 24;
  const y = box.y + box.height / rows / 2;
  if (withCtrl) await page.keyboard.down("Control");
  try {
    await page.mouse.move(box.x + x - 10, y);
    await page.mouse.move(box.x + x, y);
    await page.mouse.click(box.x + x, y);
  } finally {
    if (withCtrl) await page.keyboard.up("Control");
  }
}

/** Prints `PAGE` in the terminal and Ctrl+clicks it: a browser pane opens beside the terminal. */
async function openPane(page: Page, paneId: string, url: string = PAGE): Promise<void> {
  await print(page, paneId, `docs: ${url} end`);
  await clickFirstRow(page, 90, true);
  await expect(browserPane(page)).toBeVisible();
  await expect.poll(async () => (await views(page)).length).toBe(1);
}

/** Where the area of the pane is on the page, rounded as the pane rounds it. */
async function areaBounds(page: Page): Promise<Bounds> {
  const box = await area(page).boundingBox();
  if (box === null) throw new Error("the area of the browser pane is not on screen");
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/** The web view of the only browser pane. */
async function theView(page: Page) {
  const [view] = await views(page);
  if (view === undefined) throw new Error("no web view");
  return view;
}

/** The web view sits exactly on the area of the pane, wherever the layout has put it by now. */
async function expectInSight(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const where = await areaBounds(page);
        const view = (await theView(page)).bounds;
        return !isHidden(where) && JSON.stringify(view) === JSON.stringify(where);
      },
      { message: "the web view is on the area of its pane" },
    )
    .toBe(true);
}

async function expectOutOfSight(page: Page): Promise<void> {
  await expect.poll(async () => isHidden((await theView(page)).bounds)).toBe(true);
}

async function submit(page: Page, text: string): Promise<void> {
  await address(page).fill(text);
  await address(page).press("Enter");
}

test.describe("opening a page from the output", () => {
  test("Ctrl+click on an address opens a pane beside the terminal, with the page in its bar", async ({
    page,
  }) => {
    const id = await start(page);
    expect(await shells(page)).toBe(1);
    await openPane(page, id);

    // Beside the terminal: two panes, the terminal on the left, the page on the right.
    await expect(browserPane(page)).toHaveCount(1);
    await expect(address(page)).toHaveValue(PAGE);
    const terminal = await page.locator(`[data-pane-id="${id}"]`).boundingBox();
    const bar = await browserPane(page).boundingBox();
    if (terminal === null || bar === null) throw new Error("a pane is not on screen");
    expect(bar.x).toBeGreaterThanOrEqual(terminal.x + terminal.width - 1);

    // The web view is where the area under the bar is, and shows the page.
    expect((await theView(page)).url).toBe(PAGE);
    await expectInSight(page);
    // The page is in the model, so in state.json.
    await expect.poll(() => savedState(page)).toContain(`"type":"browser"`);
    expect(await savedState(page)).toContain(`"url":"${PAGE}"`);
    // No shell for it, and nothing opened in the system browser or asked.
    expect(await shells(page)).toBe(1);
    expect(await openedLinks(page)).toEqual([]);
    await expect(linkDialog(page)).toHaveCount(0);
    // The person was typing in the terminal and still is.
    const focused = await page.evaluate(() => (window as HookWindow).__norenTest?.focusedPaneId());
    expect(focused).toBe(id);
  });

  test("a click without Ctrl still asks, and opens no pane", async ({ page }) => {
    const id = await start(page);
    await print(page, id, `docs: ${PAGE} end`);
    await clickFirstRow(page, 90, false);
    await expect(linkDialog(page)).toBeVisible();
    await expect(linkDialog(page)).toContainText(PAGE);
    await expect(browserPane(page)).toHaveCount(0);
    expect(await views(page)).toEqual([]);

    await linkDialog(page).getByRole("button", { name: "Open", exact: true }).click();
    expect(await openedLinks(page)).toEqual([PAGE]);
    await expect(browserPane(page)).toHaveCount(0);
  });

  test("Ctrl+click on a link a program declares opens the real address, not the label", async ({
    page,
  }) => {
    const id = await start(page);
    await print(page, id, "\x1b]8;;https://example.org/real\x07click me please\x1b]8;;\x07");
    await clickFirstRow(page, 40, true);
    await expect(browserPane(page)).toBeVisible();
    await expect(address(page)).toHaveValue("https://example.org/real");
    await expect.poll(async () => (await theView(page)).url).toBe("https://example.org/real");
    await expect(linkDialog(page)).toHaveCount(0);
  });

  test("Ctrl+click on a link that is not http or https opens nothing and asks nothing", async ({
    page,
  }) => {
    const id = await start(page);
    for (const target of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)"]) {
      await print(page, id, `\x1b]8;;${target}\x07click me please\x1b]8;;\x07`);
      await clickFirstRow(page, 40, true);
    }
    await expect(browserPane(page)).toHaveCount(0);
    await expect(linkDialog(page)).toHaveCount(0);
    expect(await views(page)).toEqual([]);
  });

  test("Ctrl+click on an address of the app's own is not shown in a pane: it asks, as any link does", async ({
    page,
  }) => {
    const id = await start(page);
    await print(page, id, "docs: http://tauri.localhost/ end");
    await clickFirstRow(page, 90, true);
    await expect(linkDialog(page)).toBeVisible();
    await expect(browserPane(page)).toHaveCount(0);
    expect(await views(page)).toEqual([]);
  });

  test("a tab that is full says so and opens nothing", async ({ page }) => {
    // The limit of the settings (`terminal.maxPanes`) is four here; the default is eight.
    await seedConfig(page, '{ "terminal": { "maxPanes": 4 } }');
    const id = await start(page);
    for (let panes = 1; panes < 4; panes++) {
      await page.evaluate(() => (window as HookWindow).__norenTest?.split("row"));
      await expect.poll(async () => (await paneIds(page)).length).toBe(panes + 1);
    }
    await print(page, id, "https://e.co/a");
    await clickFirstRow(page, 30, true);
    await expect(page.locator('[data-nr-part="pane-notice"]')).toHaveText(
      "A tab holds at most 4 panes.",
    );
    await expect(browserPane(page)).toHaveCount(0);
    await expect(linkDialog(page)).toHaveCount(0);
    expect(await views(page)).toEqual([]);
  });
});

test.describe("the address bar", () => {
  test("Enter takes the pane to the address typed, in the web view, the model and state.json", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);

    await submit(page, `  ${OTHER}  `);
    await expect.poll(async () => (await theView(page)).url).toBe(OTHER);
    await expect(address(page)).toHaveValue(OTHER);
    await expect.poll(() => savedState(page)).toContain(`"url":"${OTHER}"`);
    expect(await savedState(page)).not.toContain(`"url":"${PAGE}"`);
    await expect(problem(page)).toHaveCount(0);
    // The same web view went there: it was not closed and opened again.
    expect(await callsOf(page, "openBrowserPane")).toBe(1);
    // The keyboard is still in the field: Enter is not a way out of it.
    await expect(address(page)).toBeFocused();
  });

  for (const [what, text] of [
    ["a file", "file:///C:/Windows/win.ini"],
    ["a script", "javascript:alert(1)"],
  ] as const) {
    test(`${what} is refused with the reason, and the pane stays where it was`, async ({
      page,
    }) => {
      const id = await start(page);
      await openPane(page, id);

      await submit(page, text);
      await expect(problem(page)).toHaveText("Only http and https addresses can be shown.");
      await expect(address(page)).toHaveAttribute("aria-invalid", "true");
      await expect(address(page)).toHaveValue(text);
      // Nothing moved: not the web view, not the model, not the file.
      expect((await theView(page)).url).toBe(PAGE);
      expect(await callsOf(page, "navigateBrowserPane")).toBe(0);
      await expect.poll(() => savedState(page)).toContain(`"url":"${PAGE}"`);
      expect(await savedState(page)).not.toContain(text);

      // Typing an address it may show takes the reason away and goes there.
      await submit(page, OTHER);
      await expect(problem(page)).toHaveCount(0);
      await expect(address(page)).toHaveAttribute("aria-invalid", "false");
      await expect.poll(async () => (await theView(page)).url).toBe(OTHER);
    });
  }

  test("an address of the app's own, one with a user name and an empty one are refused with their reasons", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    const reasons: [string, string][] = [
      [
        "http://tauri.localhost/",
        "That address belongs to the app itself and cannot be shown here.",
      ],
      [
        "https://good.example@evil.example/",
        "The address has a user name or password before the host.",
      ],
      ["", "The address is empty or too long."],
      ["example.com", "Only http and https addresses can be shown."],
    ];
    for (const [text, reason] of reasons) {
      await submit(page, text);
      await expect(problem(page)).toHaveText(reason);
    }
    expect(await callsOf(page, "navigateBrowserPane")).toBe(0);
    expect((await theView(page)).url).toBe(PAGE);
  });

  test("the words of the reason and of the bar are in Portuguese when the language is", async ({
    page,
  }) => {
    await seedConfig(page, '{ "language": "pt-BR" }');
    const id = await start(page);
    await print(page, id, `docs: ${PAGE} end`);
    await clickFirstRow(page, 90, true);
    await expect(browserPane(page)).toBeVisible();
    await expect(browserPane(page)).toHaveAttribute("aria-label", "Página web");
    const bar = page.getByRole("textbox", { name: "Endereço", exact: true });
    await bar.fill("file:///C:/x");
    await bar.press("Enter");
    await expect(problem(page)).toHaveText("Só endereços http e https podem ser mostrados.");
  });
});

test.describe("after a reload", () => {
  test("the pane is back with the page it was at, and its web view opens again", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    await submit(page, OTHER);
    await expect.poll(() => savedState(page)).toContain(`"url":"${OTHER}"`);

    await page.reload();
    await expect(browserPane(page)).toBeVisible();
    await expect(address(page)).toHaveValue(OTHER);
    await expect.poll(async () => (await views(page)).map((view) => view.url)).toEqual([OTHER]);
    await expectInSight(page);
    // One shell for the terminal; none for the page.
    expect(await shells(page)).toBe(1);
  });
});

test.describe("the web view follows its pane", () => {
  test("is not opened until the pane is seen, and follows the area when the window changes", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    expect(await callsOf(page, "openBrowserPane")).toBe(1);
    await expectInSight(page);
    const before = await areaBounds(page);

    await page.setViewportSize({ width: 900, height: 600 });
    await expect.poll(async () => (await areaBounds(page)).width).toBeLessThan(before.width);
    await expectInSight(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectInSight(page);
  });

  test("follows a pane that moves without changing its size", async ({ page }) => {
    const id = await start(page);
    await openPane(page, id);
    await expectInSight(page);
    const before = await areaBounds(page);

    // Nothing resizes (a resize observer sees nothing); the area is only pushed to the right.
    await page.addStyleTag({
      content: '[data-nr-part="browser-pane"] { position: relative; left: 9px; }',
    });
    await expect.poll(async () => (await theView(page)).bounds.x).toBe(before.x + 9);
    expect(await areaBounds(page)).toEqual({ ...before, x: before.x + 9 });
    await expectInSight(page);
  });

  test("steps out of sight in another tab and comes back where it was, without a new page", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    const where = await areaBounds(page);

    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expectOutOfSight(page);
    expect((await theView(page)).url).toBe(PAGE);

    await tabs(page).first().click();
    await expectInSight(page);
    expect(await areaBounds(page)).toEqual(where);
    // Hidden and shown, never closed or opened again.
    expect(await callsOf(page, "openBrowserPane")).toBe(1);
    expect((await views(page)).map((view) => view.paneId)).toHaveLength(1);
  });

  test("steps out of sight in another space and comes back", async ({ page }) => {
    const id = await start(page);
    await openPane(page, id);

    await page.getByRole("button", { name: "New space", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New space", exact: true });
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Other");
    await dialog.getByRole("button", { name: "Create space", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expectOutOfSight(page);

    await spaceButton(page, "Main").click();
    await expectInSight(page);
    expect(await callsOf(page, "openBrowserPane")).toBe(1);
  });

  test("steps out of sight while another pane of the tab is zoomed, and comes back", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    // The terminal has the keyboard: zooming takes the whole tab for it.
    await page.keyboard.press("Control+Shift+Z");
    await expectOutOfSight(page);
    await page.keyboard.press("Control+Shift+Z");
    await expectInSight(page);
  });

  test("steps out of sight under a dialog or a menu, and comes back when it closes", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);

    // The command palette.
    await page.keyboard.press("Control+Shift+P");
    await expect(page.locator('[data-nr-part="palette"]')).toBeVisible();
    await expectOutOfSight(page);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-nr-part="palette"]')).toHaveCount(0);
    await expectInSight(page);

    // The settings screen.
    await openSettings(page);
    await expectOutOfSight(page);
    await settingsScreen(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expectInSight(page);

    // A menu.
    await tabs(page).first().click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expectOutOfSight(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expectInSight(page);

    // The question every link asks, which is a dialog too.
    await print(page, id, "docs: https://example.net/ end");
    await clickFirstRow(page, 90, false);
    await expect(linkDialog(page)).toBeVisible();
    await expectOutOfSight(page);
    await linkDialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    await expectInSight(page);
    // Never closed on the way.
    expect(await callsOf(page, "openBrowserPane")).toBe(1);
  });
});

test.describe("the web view goes with its pane", () => {
  /** The tab with a terminal and a page, and a second tab that has the screen. */
  async function twoTabs(page: Page): Promise<void> {
    const id = await start(page);
    await openPane(page, id);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expectOutOfSight(page);
  }

  test("closing the tab that holds the pane closes the web view", async ({ page }) => {
    await twoTabs(page);
    // The first tab has no name of its own yet: it is the one that is not selected.
    const first = tabs(page).first();
    await first.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect.poll(() => views(page)).toEqual([]);
    await expect(browserPane(page)).toHaveCount(0);
  });

  test("closing the pane closes the web view and leaves the terminal", async ({ page }) => {
    await seedConfig(page, '{ "appearance": { "paneHeaders": true } }');
    const id = await start(page);
    await openPane(page, id);
    await browserPane(page)
      .locator("xpath=ancestor::*[@data-nr-part='pane']")
      .getByRole("button", { name: "Close pane", exact: true })
      .click();
    await expect(browserPane(page)).toHaveCount(0);
    await expect.poll(() => views(page)).toEqual([]);
    expect(await paneIds(page)).toEqual([id]);
  });

  test("closing the space that holds the pane closes the web view", async ({ page }) => {
    const id = await start(page);
    await print(page, id, `docs: ${PAGE} end`);
    // A second space to land on, then back to open the pane in the first.
    await page.getByRole("button", { name: "New space", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New space", exact: true });
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Other");
    await dialog.getByRole("button", { name: "Create space", exact: true }).click();
    await expect(dialog).toBeHidden();
    await spaceButton(page, "Main").click();
    await clickFirstRow(page, 90, true);
    await expect(browserPane(page)).toBeVisible();
    await expect.poll(async () => (await views(page)).length).toBe(1);

    // Delete "Main" with its tabs: its web view has to go.
    await spaceButton(page, "Main").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete space…", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete space", exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Delete space", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect.poll(() => views(page)).toEqual([]);
    await expect(browserPane(page)).toHaveCount(0);
  });

  test("an archived tab closes its web view, and restoring it opens it again", async ({ page }) => {
    await seedConfig(page, '{ "archive": { "afterHours": 1 } }');
    const id = await start(page);
    await openPane(page, id);
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs(page)).toHaveCount(2);
    await expectOutOfSight(page);

    // Past the hour the tab nobody uses is archived; the one on screen stays.
    await page.evaluate(() => (window as HookWindow).__norenTest?.advanceClock(62 * 60 * 1000));
    await expect(tabs(page)).toHaveCount(1);
    await expect.poll(() => views(page)).toEqual([]);

    await page.keyboard.press("Control+Alt+Shift+L");
    const library = page.getByRole("dialog", { name: "Library", exact: true });
    await expect(library).toBeVisible();
    await library.getByRole("button", { name: /^Restore / }).click();
    await expect(library).toBeHidden();
    await expect(browserPane(page)).toBeVisible();
    await expect.poll(async () => (await views(page)).map((view) => view.url)).toEqual([PAGE]);
    await expectInSight(page);
  });

  test("a tab closed and reopened gets its web view back, on the same page", async ({ page }) => {
    await twoTabs(page);
    await tabs(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close", exact: true }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect.poll(() => views(page)).toEqual([]);

    await page.keyboard.press("Control+Alt+Shift+T");
    await expect(browserPane(page)).toBeVisible();
    await expect.poll(async () => (await views(page)).map((view) => view.url)).toEqual([PAGE]);
  });
});

test.describe("accessibility", () => {
  test("axe: a browser pane open, and one with a reason showing, have no violation", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    await expect(address(page)).toBeVisible();
    await expectNoAxeViolations(page, "browser pane");
    await submit(page, "file:///C:/x");
    await expect(problem(page)).toBeVisible();
    await expectNoAxeViolations(page, "browser pane, with a reason");
  });

  test("the bar is reached with the keyboard and named for assistive technology", async ({
    page,
  }) => {
    const id = await start(page);
    await openPane(page, id);
    const group: Locator = page.getByRole("group", { name: "Web page", exact: true });
    await expect(group).toBeVisible();
    await address(page).focus();
    await expect(address(page)).toBeFocused();
    await submit(page, "file:///C:/x");
    // The reason is read out, and the field points at it.
    await expect(problem(page)).toHaveAttribute("role", "alert");
    const described = await address(page).getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    await expect(page.locator(`[id="${described ?? ""}"]`)).toHaveText(
      "Only http and https addresses can be shown.",
    );
  });
});

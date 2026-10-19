import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SPLIT_FIXTURE, seedSidebarState } from "./sidebar-fixture";

// The peek of a tab: the pointer rests on a tab of the sidebar for 400 ms and a tooltip beside it
// shows the last 15 lines of its terminal, as plain text. Leaving the tab, Escape, a click and a
// drag close it, and none opens during a drag. The 400 ms themselves, and every other rule of when
// it opens and closes, are held by the unit tests of `PeekController`; here is what only a real
// layout shows (where it sits, that the pointer goes through it, that it takes no focus).

interface Hook {
  paneLines(paneId: string): string[];
  sendOutput(paneId: string, text: string): boolean;
  setConfig(text: string | null): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const list = (page: Page) => page.getByRole("tree", { name: "Tabs", exact: true });
const tab = (page: Page, name: string) => list(page).getByRole("treeitem", { name, exact: true });
const tooltip = (page: Page) => page.getByRole("tooltip");
const peekLines = (page: Page) => tooltip(page).locator('[data-nr-part="peek-line"]');

// api is p2 and build is p3 (see `sidebarState`).
const API = "p2";
const BUILD = "p3";

/** Where the pointer rests when it is not on a tab: the middle of the terminal. */
const AWAY = { x: 700, y: 300 };

/** Opens the app on the seeded sidebar (`split` adds the tab with two panes). */
async function open(page: Page, options: { split?: boolean } = {}): Promise<void> {
  await seedSidebarState(page, options);
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
}

async function send(page: Page, paneId: string, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
        { id: paneId, bytes: text },
      ),
    )
    .toBe(true);
}

const terminalLines = (page: Page, paneId: string): Promise<string[]> =>
  page.evaluate((id) => (window as HookWindow).__norenTest?.paneLines(id) ?? [], paneId);

/** Waits until a line of the terminal of a pane contains `text`. */
async function waitForText(page: Page, paneId: string, text: string): Promise<void> {
  await expect
    .poll(async () => (await terminalLines(page, paneId)).some((line) => line.includes(text)))
    .toBe(true);
}

/** Prints `count` numbered lines in the terminal of a pane and waits until the last one is there. */
async function print(page: Page, paneId: string, count: number): Promise<void> {
  const numbered = Array.from({ length: count }, (_, i) => `out ${String(i + 1).padStart(2, "0")}`);
  await send(page, paneId, `${numbered.join("\r\n")}\r\n`);
  await waitForText(page, paneId, numbered[count - 1] ?? "");
}

test("resting the pointer on a tab shows the last 15 lines of its terminal beside it, and leaving hides them", async ({
  page,
}) => {
  await open(page);
  await print(page, API, 30);
  const expected = (await terminalLines(page, API))
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-15);
  expect(expected).toHaveLength(15);
  expect(expected).toContain("out 30");

  await expect(tooltip(page)).toHaveCount(0);
  const before = Date.now();
  await tab(page, "api").hover();
  await expect(tooltip(page)).toBeVisible();
  // Not before the pointer has rested for 400 ms (the timer only ever waits at least that long).
  expect(Date.now() - before).toBeGreaterThanOrEqual(395);

  await expect(peekLines(page)).toHaveText(expected);
  await expect(peekLines(page)).toHaveCount(15);
  await expect(tooltip(page)).not.toContainText("out 01");

  // The tab is described by the tooltip while it is up.
  await expect(tooltip(page)).toHaveAttribute("id", "peek-i2");
  expect(await tab(page, "api").getAttribute("aria-describedby")).toContain("peek-i2");

  await page.mouse.move(AWAY.x, AWAY.y);
  await expect(tooltip(page)).toHaveCount(0);
  expect((await tab(page, "api").getAttribute("aria-describedby")) ?? "").not.toContain("peek-");
});

test("it sits next to the tab inside the window, does not catch the pointer and does not take the focus", async ({
  page,
}) => {
  await open(page);
  await print(page, API, 30);
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      return `${element?.tagName ?? ""}.${element?.getAttribute("aria-label") ?? ""}`;
    });
  const focusBefore = await focused();

  await tab(page, "api").hover();
  await expect(tooltip(page)).toBeVisible();

  const box = await tooltip(page).boundingBox();
  const anchor = await tab(page, "api").boundingBox();
  const viewport = page.viewportSize();
  if (!box || !anchor || !viewport) throw new Error("nothing on screen");
  // On the side that faces the terminal (the sidebar is on the left), clear of the tab.
  expect(box.x).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

  // The pointer goes through it, so what is under it can still be clicked.
  expect(await tooltip(page).evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="tooltip"]') !== null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hit).toBe(false);
  // Nothing in it can be focused, and the focus stayed where it was.
  await expect(tooltip(page).locator("a, button, input, textarea, [tabindex]")).toHaveCount(0);
  expect(await focused()).toBe(focusBefore);
});

test("on the right the tooltip opens to the left of the tab", async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.setConfig(
      '{ "appearance": { "sidebar": { "position": "right" } } }',
    ),
  );
  await expect(page.locator(".app-body")).toHaveAttribute("data-nr-side", "right");
  await print(page, API, 5);
  await tab(page, "api").hover();
  await expect(tooltip(page)).toBeVisible();
  const box = await tooltip(page).boundingBox();
  const anchor = await tab(page, "api").boundingBox();
  if (!box || !anchor) throw new Error("nothing on screen");
  expect(box.x + box.width).toBeLessThanOrEqual(anchor.x);
  expect(box.x).toBeGreaterThanOrEqual(0);
});

test("output with markup shows as text and runs nothing", async ({ page }) => {
  await open(page);
  await send(
    page,
    BUILD,
    '<img src=x onerror="window.__pwned=1">\r\n<b>bold</b> <script>window.__pwned=2</script>\r\n',
  );
  await waitForText(page, BUILD, "<b>bold</b>");

  await tab(page, "build").hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText('<img src=x onerror="window.__pwned=1">');
  await expect(tooltip(page)).toContainText("<b>bold</b> <script>window.__pwned=2</script>");
  await expect(tooltip(page).locator("img, b, script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBe(
    undefined,
  );
});

test("colors and escape sequences in the output show as plain text", async ({ page }) => {
  await open(page);
  await send(
    page,
    BUILD,
    "before\x1b]0;hijacked\x07\x1b]52;c;ZWNobw==\x07 after\r\ncolor \x1b[31mred\x1b[0m end\r\n",
  );
  await waitForText(page, BUILD, "color red end");
  await tab(page, "build").hover();
  await expect(tooltip(page)).toBeVisible();
  await expect(tooltip(page)).toContainText("before after");
  await expect(tooltip(page)).toContainText("color red end");
  await expect(tooltip(page)).not.toContainText("hijacked");
  await expect(tooltip(page)).not.toContainText("\x1b");
});

test("a split tab shows its focused pane", async ({ page }) => {
  await open(page, { split: true });
  await send(page, SPLIT_FIXTURE.first, "from the first pane\r\n");
  await send(page, SPLIT_FIXTURE.second, "from the second pane\r\n");
  await waitForText(page, SPLIT_FIXTURE.first, "from the first pane");
  await waitForText(page, SPLIT_FIXTURE.second, "from the second pane");
  await tab(page, SPLIT_FIXTURE.title).hover();
  await expect(tooltip(page)).toBeVisible();
  // The first pane is the focused one of the seeded tab.
  await expect(tooltip(page)).toContainText("from the first pane");
  await expect(tooltip(page)).not.toContainText("from the second pane");
});

test("escape closes it, and it does not come back while the pointer stays still", async ({
  page,
}) => {
  await open(page);
  await tab(page, "api").hover();
  await expect(tooltip(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip(page)).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(tooltip(page)).toHaveCount(0);
});

test("a click closes it", async ({ page }) => {
  await open(page);
  await tab(page, "build").hover();
  await expect(tooltip(page)).toBeVisible();
  await page.mouse.down();
  await expect(tooltip(page)).toHaveCount(0);
  await page.mouse.up();
  await expect(tab(page, "build")).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(700);
  await expect(tooltip(page)).toHaveCount(0);
});

test("picking a tab up with the keyboard closes it, and none opens under a pointer that moves while it is carried", async ({
  page,
}) => {
  await open(page);
  // The pointer rests on the tab while the keyboard picks it up: only the drag can close the peek.
  await tab(page, "api").hover();
  await expect(tooltip(page)).toBeVisible();
  await tab(page, "api").focus();
  await page.keyboard.press("Space");
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toBeVisible();
  await expect(tooltip(page)).toHaveCount(0);

  // The pointer moves onto another tab and rests there longer than the delay: nothing opens.
  const over = await tab(page, "logs").boundingBox();
  if (!over) throw new Error("tab not on screen");
  await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 5 });
  await page.waitForTimeout(800);
  await expect(tooltip(page)).toHaveCount(0);

  // Escape puts the tab back; the pointer moving again then rests on a tab and a peek opens.
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toHaveCount(0);
  await page.mouse.move(over.x + over.width / 2 + 2, over.y + over.height / 2);
  await expect(tooltip(page)).toBeVisible();
});

test("a drag with the pointer closes it and none opens while a tab is carried", async ({
  page,
}) => {
  await open(page);
  await tab(page, "api").hover();
  await expect(tooltip(page)).toBeVisible();

  const from = await tab(page, "api").boundingBox();
  const over = await tab(page, "logs").boundingBox();
  if (!from || !over) throw new Error("tabs not on screen");
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 12, { steps: 3 });
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toBeVisible();
  await expect(tooltip(page)).toHaveCount(0);

  // Carried over another tab and held longer than the delay: nothing opens.
  await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 10 });
  await page.waitForTimeout(800);
  await expect(tooltip(page)).toHaveCount(0);

  // Escape cancels the drag, so the tab stays where it was; then the button is released.
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator('[data-nr-part="drag-ghost"]')).toHaveCount(0);
  await expect(tooltip(page)).toHaveCount(0);

  // After the drag, a peek opens again once the pointer rests on a tab.
  await page.mouse.move(AWAY.x, AWAY.y);
  await tab(page, "logs").hover();
  await expect(tooltip(page)).toBeVisible();
});

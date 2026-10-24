import { expect, test } from "./test";
import type { Page } from "@playwright/test";
import { manyTabsState } from "./many-tabs-fixture";

// NOR-F20-14a: a start with many saved tabs starts and mounts only the tab on screen before the first
// prompt; the shells of the other tabs start in the background once it shows (or at once when their
// tab is opened) and a tab opened later is the same as before: its shell is there, with what it
// printed while the tab was out of sight, and it takes typing. The tests keep the tabs waiting
// (`__norenHoldPending`) to look at the window before their shells start.

interface Hook {
  lines(): string[];
  paneLines(paneId: string): string[];
  sendOutput(paneId: string, text: string): boolean;
  sessionStarts(): { cwd?: string }[];
}
interface PendingHook {
  count(): number;
  release(): void;
}
type HookWindow = Window & {
  __norenTest?: Hook;
  __norenPending?: PendingHook;
  __norenHoldPending?: boolean;
};

const TABS_PER_SPACE = 6;
const STATE_KEY = "noren.web.state";

/** Two spaces of six tabs; the tab on screen in the first space is the fourth, not the first. */
function savedState(): string {
  const state = JSON.parse(manyTabsState(["Alpha", "Beta"], TABS_PER_SPACE)) as {
    spaces: { activeItemId: string }[];
  };
  const first = state.spaces[0];
  if (first) first.activeItemId = "t0-4";
  return JSON.stringify(state);
}

async function open(page: Page, hold: boolean): Promise<void> {
  await page.addInitScript(
    ({ key, value, hold }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      (window as HookWindow).__norenHoldPending = hold;
    },
    { key: STATE_KEY, value: savedState(), hold },
  );
  await page.goto("/");
}

const tab = (page: Page, name: string) =>
  page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem", { name });

const starts = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.sessionStarts().length ?? -1);

const waiting = (page: Page): Promise<number> =>
  page.evaluate(() => (window as HookWindow).__norenPending?.count() ?? -1);

test("only the tab on screen has a shell and a terminal until the others are let go", async ({
  page,
}) => {
  await open(page, true);
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(terminal.locator(".xterm")).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await starts(page)).toBe(1);
  // 12 tabs saved: the one on screen is started, the other 11 wait.
  expect(await waiting(page)).toBe(2 * TABS_PER_SPACE - 1);
  // Every tab is in the sidebar all the same.
  await expect(
    page.getByRole("tree", { name: "Tabs", exact: true }).getByRole("treeitem"),
  ).toHaveCount(TABS_PER_SPACE);

  await page.evaluate(() => (window as HookWindow).__norenPending?.release());
  await expect.poll(() => waiting(page)).toBe(0);
  await expect(page.locator(".xterm")).toHaveCount(2 * TABS_PER_SPACE);
  expect(await starts(page)).toBe(2 * TABS_PER_SPACE);
});

test("with nothing holding them, every tab gets its shell and its terminal after the first prompt", async ({
  page,
}) => {
  await open(page, false);
  await expect(page.locator(".xterm")).toHaveCount(2 * TABS_PER_SPACE);
  expect(await starts(page)).toBe(2 * TABS_PER_SPACE);
  expect(await waiting(page)).toBe(0);
});

test("a tab opened before its turn starts at once, shows its prompt and takes typing", async ({
  page,
}) => {
  await open(page, true);
  await expect(page.locator(".xterm")).toHaveCount(1);

  await tab(page, "Alpha 2").click();
  // Only that tab was let through the queue: its shell started and its terminal mounted.
  await expect(page.locator(".xterm")).toHaveCount(2);
  expect(await starts(page)).toBe(2);
  expect(await waiting(page)).toBe(2 * TABS_PER_SPACE - 2);

  // The shell printed its prompt before the terminal existed: the terminal was given it.
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []))
    .toContain("fake$ ");
  await page.keyboard.type("echo opened-late");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []))
    .toContain("opened-late");
  expect(await waiting(page)).toBe(2 * TABS_PER_SPACE - 2);
});

test("a restored tab that was out of sight shows what its shell printed meanwhile and takes typing", async ({
  page,
}) => {
  await open(page, false);
  await expect(page.locator(".xterm")).toHaveCount(2 * TABS_PER_SPACE);

  // Output arrives for a tab nobody is looking at...
  const paneId = "p0-5";
  expect(
    await page.evaluate(
      (id) => (window as HookWindow).__norenTest?.sendOutput(id, "printed-while-away\r\n"),
      paneId,
    ),
  ).toBe(true);
  // ...and is there when its tab is opened.
  await tab(page, "Alpha 5").click();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []))
    .toContain("fake$ printed-while-away");
  await page.keyboard.type("echo and-typing");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines() ?? []))
    .toContain("and-typing");
});

test("a tab that waited for its turn keeps what is printed to it once it starts", async ({
  page,
}) => {
  await open(page, true);
  await tab(page, "Alpha 6").click();
  await expect(page.locator(".xterm")).toHaveCount(2);
  await page.evaluate(() =>
    (window as HookWindow).__norenTest?.sendOutput("p0-6", "after-start\r\n"),
  );
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.paneLines("p0-6") ?? []))
    .toContain("fake$ after-start");
});

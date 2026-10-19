import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { sidebarState } from "./sidebar-fixture";

// System notifications. The web build has no system to notify: its backend only records what it
// was asked to show (`notifications`) and answers the focus the test gives it (`setWindowFocused`),
// so nothing here ever reaches the desktop. A program that rings, or a command that ends after
// more than 30 s in a tab out of sight, notifies when the window is out of focus (a bell) or the
// tab is not on screen (a long command); the focus of the window silences the bell.

interface Hook {
  sendOutput(paneId: string, text: string): boolean;
  notifications(): { title: string; body: string }[];
  setWindowFocused(focused: boolean): void;
  advanceClock(ms: number): void;
}
type HookWindow = Window & { __norenTest?: Hook };

const BEL = "\x07";
const osc = (body: string): string => `\x1b]${body}${BEL}`;

// Key of `state.json` in the browser storage of web mode (apps/desktop/src/web-backend.ts) and of
// the provisional notification settings (apps/desktop/src/notification-settings.ts).
const WEB_STATE_KEY = "noren.web.state";
const SETTINGS_KEY = "noren.ui.notifications";

/** The sidebar workspace: tab api (p2) is on screen; build (p3) and logs (p4) are in the background. */
async function seed(page: Page, settings?: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, text, settingsKey, settingsText }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, text);
      if (settingsText !== undefined) window.localStorage.setItem(settingsKey, settingsText);
    },
    {
      key: WEB_STATE_KEY,
      text: sidebarState(),
      settingsKey: SETTINGS_KEY,
      settingsText: settings === undefined ? undefined : JSON.stringify(settings),
    },
  );
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

const focus = (page: Page, focused: boolean): Promise<void> =>
  page.evaluate((value) => (window as HookWindow).__norenTest?.setWindowFocused(value), focused);
const advance = (page: Page, ms: number): Promise<void> =>
  page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);
const notifications = (page: Page) =>
  page.evaluate(() => (window as HookWindow).__norenTest?.notifications() ?? []);

/** Runs a command that lasts `seconds` on the clock of the fake shell, as the integration reports it. */
async function runCommand(page: Page, paneId: string, line: string, seconds: number, exit = 0) {
  await send(page, paneId, osc(`633;E;${line}`) + osc("133;C"));
  await advance(page, seconds * 1000);
  await send(page, paneId, osc(`133;D;${exit}`));
}

test.describe("with the default settings", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "api", exact: true })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  test("a notification from a background tab while the window is in focus marks the tab and stays out of the system", async ({
    page,
  }) => {
    await send(page, "p3", osc("9;Build finished"));
    await expect(page.locator('[data-nr-indicator="unread"]')).not.toHaveCount(0);
    // A later event that does notify is the barrier: it arrives after the first one was handled.
    await focus(page, false);
    await send(page, "p4", osc("9;Second"));
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(await notifications(page)).toEqual([{ title: "logs", body: "Second" }]);
  });

  test("a bell, OSC 9 and OSC 777 notify while the window is out of focus, and a bell in a loop gives one", async ({
    page,
  }) => {
    await focus(page, false);
    await send(page, "p3", BEL);
    await send(page, "p3", BEL);
    await send(page, "p3", BEL);
    await send(page, "p4", osc("9;Build finished"));
    await send(page, "p4", osc("777;notify;Agent;Waiting for you"));
    await expect.poll(() => notifications(page)).toHaveLength(3);
    expect(await notifications(page)).toEqual([
      { title: "build", body: "Bell" },
      { title: "logs", body: "Build finished" },
      { title: "Agent", body: "Waiting for you" },
    ]);
  });

  test("the progress bar and the folder sequences never notify", async ({ page }) => {
    await focus(page, false);
    await send(page, "p3", osc("9;4;1;50") + osc("9;9;/tmp") + osc("0;a title"));
    await send(page, "p4", osc("9;barrier"));
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(await notifications(page)).toEqual([{ title: "logs", body: "barrier" }]);
  });

  test("a command of 31 s that ends in a tab out of sight notifies; 29 s and a tab on screen do not", async ({
    page,
  }) => {
    await runCommand(page, "p3", "make", 29);
    await runCommand(page, "p2", "make", 120);
    await runCommand(page, "p3", "make all", 31);
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(await notifications(page)).toEqual([
      { title: "Command finished in build", body: "make all finished after 31s" },
    ]);
  });

  test("a failed long command says so, and one in the tab on screen notifies if the window is out of focus", async ({
    page,
  }) => {
    await runCommand(page, "p4", "deploy", 95, 2);
    await focus(page, false);
    await runCommand(page, "p2", "make", 40);
    await expect.poll(() => notifications(page)).toHaveLength(2);
    expect(await notifications(page)).toEqual([
      { title: "Command failed in logs", body: "deploy failed (exit 2) after 1m 35s" },
      { title: "Command finished in api", body: "make finished after 40s" },
    ]);
  });
});

test.describe("with the settings off or changed", () => {
  test("turned off, nothing is sent", async ({ page }) => {
    await seed(page, { enabled: false });
    await page.goto("/");
    await focus(page, false);
    await send(page, "p3", BEL);
    await runCommand(page, "p4", "make", 120);
    expect(await notifications(page)).toEqual([]);
  });

  test("a shorter limit notifies a shorter command", async ({ page }) => {
    await seed(page, { longCommandSeconds: 5 });
    await page.goto("/");
    await runCommand(page, "p3", "make", 6);
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(await notifications(page)).toEqual([
      { title: "Command finished in build", body: "make finished after 6s" },
    ]);
  });
});

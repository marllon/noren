import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { sidebarState } from "./sidebar-fixture";
import {
  GLASS_GAP,
  closeSettings,
  changeSettings,
  configText,
  openSettings,
} from "./settings-fixture";

// The settings file `config.jsonc`. The web build has no file system: its backend keeps the text
// of the file under `noren.web.config` in the browser storage, and the test hook `setConfig`
// replaces that text the way an editor saving the file would, which the app is watching. Nothing
// here reloads the page unless the test says so.

interface Hook {
  setConfig(text: string | null): void;
  sendOutput(paneId: string, text: string): boolean;
  notifications(): { title: string; body: string }[];
  setWindowFocused(focused: boolean): void;
  advanceClock(ms: number): void;
}
type HookWindow = Window & {
  __norenTest?: Hook;
  __stillHere?: boolean;
  __norenPending?: { count(): number };
};

const WEB_STATE_KEY = "noren.web.state";
const WEB_CONFIG_KEY = "noren.web.config";
const NOTIFICATIONS_KEY = "noren.ui.notifications";

const RIGHT = '{ "appearance": { "sidebar": { "position": "right" } } }';
const LEFT = '{ "appearance": { "sidebar": { "position": "left" } } }';
/** The value of `position` is on line 3. */
const MISTAKE = `{
  "appearance": {
    "sidebar": { "position": "middle" }
  }
}`;

const body = (page: Page) => page.locator(".app-body");
const sidebar = (page: Page) => page.locator('[data-nr-part="sidebar"]');
const notice = (page: Page) => page.locator('[data-nr-part="config-notice"]');
const tab = (page: Page, name: string) =>
  page
    .getByRole("tree", { name: "Tabs", exact: true })
    .getByRole("treeitem", { name, exact: true });
const handle = (page: Page) => page.getByRole("separator", { name: "Resize sidebar", exact: true });

/** Starts the app with a workspace and, when given, a settings file already on disk. */
async function open(page: Page, file?: string, provisional?: Record<string, unknown>) {
  await page.addInitScript(
    ({ stateKey, state, configKey, config, notificationsKey, notifications }) => {
      if (window.localStorage.getItem(stateKey) === null)
        window.localStorage.setItem(stateKey, state);
      // Only the first load: a reload finds the file as the test left it.
      if (config !== undefined && window.localStorage.getItem(configKey) === null) {
        window.localStorage.setItem(configKey, config);
      }
      if (notifications !== undefined && window.localStorage.getItem(notificationsKey) === null) {
        window.localStorage.setItem(notificationsKey, notifications);
      }
    },
    {
      stateKey: WEB_STATE_KEY,
      state: sidebarState(),
      configKey: WEB_CONFIG_KEY,
      config: file,
      notificationsKey: NOTIFICATIONS_KEY,
      notifications: provisional === undefined ? undefined : JSON.stringify(provisional),
    },
  );
  await page.goto("/");
  await expect(tab(page, "api")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenTest !== undefined))
    .toBe(true);
  // The tabs out of sight get their shells in the background (NOR-F20-14a); a test sends output to one.
  await expect
    .poll(() => page.evaluate(() => (window as HookWindow).__norenPending?.count() ?? 0))
    .toBe(0);
}

/** Replaces the text of the file, as another program saving it would. */
const setConfig = (page: Page, text: string | null): Promise<void> =>
  page.evaluate((value) => (window as HookWindow).__norenTest?.setConfig(value), text);

/** Marks this page load, to tell afterwards that nothing reloaded it. */
const markPage = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as HookWindow).__stillHere = true;
  });
const samePage = (page: Page): Promise<boolean | undefined> =>
  page.evaluate(() => (window as HookWindow).__stillHere);

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("element not on screen");
  return found;
}

/** The sidebar sits against the left or the right edge of the window (one gap of the glass style from it), and the body says so. */
async function expectSide(page: Page, side: "left" | "right"): Promise<void> {
  await expect(body(page)).toHaveAttribute("data-nr-side", side);
  await expect
    .poll(async () => {
      const at = await box(sidebar(page));
      return side === "left" ? at.x : (page.viewportSize()?.width ?? 0) - (at.x + at.width);
    })
    .toBe(GLASS_GAP);
}

const radio = (screen: Locator, name: string) => screen.getByRole("radio", { name, exact: true });

test.describe("a change of the file applies without a restart", () => {
  test("appearance.sidebar.position moves the sidebar, and moves it back", async ({ page }) => {
    await open(page);
    await expectSide(page, "left");
    await markPage(page);

    await setConfig(page, RIGHT);
    await expectSide(page, "right");
    await setConfig(page, LEFT);
    await expectSide(page, "left");
    await setConfig(page, RIGHT);
    await expectSide(page, "right");

    // The page was never reloaded, and the tab that was open is still the one on screen.
    expect(await samePage(page)).toBe(true);
    await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");
    await expect(notice(page)).toHaveCount(0);
  });

  test("comments and trailing commas are part of the format and raise no complaint", async ({
    page,
  }) => {
    await open(page);
    await setConfig(
      page,
      `// My Noren settings.
{
  /* The sidebar lives on the right. */
  "appearance": {
    "sidebar": { "position": "right", "width": 260, },
    "density": "compact", // tight rows
  },
}
`,
    );
    await expectSide(page, "right");
    await expect(body(page)).toHaveAttribute("data-nr-density", "compact");
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "260");
    expect((await box(sidebar(page))).width).toBe(260);
    await expect(notice(page)).toHaveCount(0);
  });

  test("the other appearance settings apply too: tabs on top, compact mode and pane headers", async ({
    page,
  }) => {
    await open(page);
    await setConfig(page, '{ "appearance": { "tabs": "top" } }');
    await expect(page.locator('[data-nr-part="tabbar"]')).toBeVisible();
    await setConfig(
      page,
      '{ "appearance": { "tabs": "sidebar", "sidebar": { "compact": true }, "paneHeaders": true } }',
    );
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "auto-hide");
    // Every tab keeps its panes mounted, the ones of the tabs out of sight hidden.
    await expect(page.locator('[data-nr-part="pane-header"]:visible')).toHaveCount(1);
    await setConfig(page, "{}");
    await expect(body(page)).toHaveAttribute("data-nr-sidebar-mode", "docked");
    await expect(page.locator('[data-nr-part="pane-header"]')).toHaveCount(0);
  });

  test("removing the file puts the defaults back", async ({ page }) => {
    await open(page, RIGHT);
    await expectSide(page, "right");
    await setConfig(page, null);
    await expectSide(page, "left");
    await expect(notice(page)).toHaveCount(0);
  });
});

test.describe("a file with a mistake", () => {
  test("shows a notice with the line, keeps the settings and does not get in the way", async ({
    page,
  }) => {
    await open(page, RIGHT);
    await expectSide(page, "right");
    await markPage(page);

    await setConfig(page, MISTAKE);

    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toHaveAttribute("role", "alert");
    await expect(notice(page)).toContainText("last valid settings stay in use");
    const problem = page.locator('[data-nr-part="config-notice-error"]');
    await expect(problem).toContainText("line 3");
    await expect(problem).toContainText("appearance.sidebar.position");
    // The sidebar stays where the last valid file put it.
    await expectSide(page, "right");

    // Not blocking: the app still answers while the notice is up.
    await tab(page, "logs").click();
    await expect(tab(page, "logs")).toHaveAttribute("aria-current", "true");
    expect(await samePage(page)).toBe(true);
  });

  test("names the line of a syntax error and of an unknown setting", async ({ page }) => {
    await open(page);
    const problem = page.locator('[data-nr-part="config-notice-error"]');

    await setConfig(page, '{\n  "appearance": {\n    "tabs": \n  }\n}');
    await expect(problem).toContainText("line 4");
    await expect(problem).toContainText(/value expected/i);

    await setConfig(page, '{\n  "appearance": {\n    "sidebar": { "postion": "right" }\n  }\n}');
    await expect(problem).toContainText("line 3");
    await expect(problem).toContainText('Unknown setting "postion"');
    await expectSide(page, "left");
  });

  test("says how many more problems there are", async ({ page }) => {
    await open(page);
    await setConfig(
      page,
      '{\n  "appearance": { "density": "tight", "tabs": "below" },\n  "notifications": { "enabled": 1 }\n}',
    );
    await expect(page.locator('[data-nr-part="config-notice-error"]')).toContainText("line 2");
    await expect(notice(page)).toContainText("2 more problems");
  });

  test("goes away when the file is fixed, and the fix applies", async ({ page }) => {
    await open(page);
    await setConfig(page, MISTAKE);
    await expect(notice(page)).toBeVisible();
    await setConfig(page, RIGHT);
    await expect(notice(page)).toHaveCount(0);
    await expectSide(page, "right");
  });

  test("can be dismissed, and a new mistake brings it back", async ({ page }) => {
    await open(page);
    await setConfig(page, MISTAKE);
    await expect(notice(page)).toBeVisible();
    await notice(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(notice(page)).toHaveCount(0);

    await setConfig(page, MISTAKE.replace("middle", "center"));
    await expect(notice(page)).toBeVisible();
    await expect(page.locator('[data-nr-part="config-notice-error"]')).toContainText("line 3");
  });

  test("a file that is wrong from the start leaves the defaults and shows the notice", async ({
    page,
  }) => {
    await open(page, MISTAKE);
    await expect(notice(page)).toBeVisible();
    await expect(page.locator('[data-nr-part="config-notice-error"]')).toContainText("line 3");
    await expectSide(page, "left");

    await setConfig(page, RIGHT);
    await expect(notice(page)).toHaveCount(0);
    await expectSide(page, "right");
  });

  test("a file that is not JSON at all is refused with its line", async ({ page }) => {
    await open(page, RIGHT);
    await setConfig(page, "appearance: right");
    await expect(page.locator('[data-nr-part="config-notice-error"]')).toContainText("line 1");
    await expectSide(page, "right");
  });
});

test.describe("what the file decides", () => {
  test("the settings of the file at the start are in force from the first frame, and after a reload", async ({
    page,
  }) => {
    await open(page, '{ "appearance": { "sidebar": { "position": "right", "width": 300 } } }');
    await expectSide(page, "right");
    expect((await box(sidebar(page))).width).toBe(300);

    await page.reload();
    await expect(tab(page, "api")).toBeVisible();
    await expectSide(page, "right");
    expect((await box(sidebar(page))).width).toBe(300);
  });

  test("the settings screen shows what the file says, and a handle drag writes the width into it", async ({
    page,
  }) => {
    await open(page, '{ "appearance": { "sidebar": { "position": "right", "width": 240 } } }');
    const screen = await openSettings(page);
    await expect(radio(screen, "Right")).toBeChecked();
    await expect(screen.getByRole("textbox", { name: "Sidebar width (px)" })).toHaveValue("240");
    // Density is not in the file: the screen shows the default.
    await expect(radio(screen, "Comfortable")).toBeChecked();
    await closeSettings(page);

    // Nothing in the file is out of reach of the handle now: it saves the width where it is.
    await expect(handle(page)).not.toHaveAttribute("aria-disabled", "true");
    const at = await box(handle(page));
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.x + at.width / 2 - 80, at.y + at.height / 2, { steps: 5 });
    await page.mouse.up();
    expect((await box(sidebar(page))).width).toBe(320);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", "320");
    await expect.poll(() => configText(page)).toContain('"width": 320');
    expect(await configText(page)).toContain('"position": "right"');
  });

  test("the screen follows the file, and keeps only what is still being typed", async ({
    page,
  }) => {
    await open(page, RIGHT);
    const screen = await openSettings(page);
    await expect(radio(screen, "Right")).toBeChecked();
    // A choice is written at once, so it is the file's, not a draft.
    await radio(screen, "Compact").check();
    await expect.poll(() => configText(page)).toContain('"density": "compact"');
    // A number the file would refuse is the one thing the screen holds that the file does not have.
    const width = screen.getByRole("textbox", { name: "Sidebar width (px)" });
    await width.fill("9999");

    // Another program edits the file while the screen is open.
    await setConfig(page, '{ "appearance": { "sidebar": { "position": "left" } } }');
    await expectSide(page, "left");
    await expect(radio(screen, "Left")).toBeChecked();
    // What the person chose was written, and the other program wrote over it: the file is the truth.
    await expect(radio(screen, "Comfortable")).toBeChecked();
    await expect(width).toHaveValue("9999");
    await closeSettings(page);
    await expect(body(page)).toHaveAttribute("data-nr-density", "comfortable");
    expect(await configText(page)).toContain('"position": "left"');
  });

  test("a setting the file leaves out is the default, not an earlier choice", async ({ page }) => {
    await open(page);
    await changeSettings(page, (screen) => radio(screen, "Compact").check());
    await expect(body(page)).toHaveAttribute("data-nr-density", "compact");
    await setConfig(page, RIGHT);
    await expectSide(page, "right");
    // The file says nothing about density now, so it is the default again.
    await expect(body(page)).toHaveAttribute("data-nr-density", "comfortable");
  });

  test("the handle waits while the file has a mistake, and the screen will not write over it", async ({
    page,
  }) => {
    await open(page, MISTAKE);
    await expect(handle(page)).toHaveAttribute("aria-disabled", "true");
    const screen = await openSettings(page);
    await expect(screen.locator('[data-nr-part="settings-file-problem"]')).toContainText("line 3");
    await radio(screen, "Right").check();
    await page.waitForTimeout(700);
    expect(await configText(page)).toBe(MISTAKE);
    // The change is kept by the screen, so closing it does not lose it without a word: the first
    // close stays with the notice, the second lets go.
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect(screen).toBeVisible();
    await closeSettings(page);
    expect(await configText(page)).toBe(MISTAKE);
    // Fixed from outside, everything answers again.
    await setConfig(page, "{}");
    await expect(handle(page)).not.toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("notifications from the file", () => {
  const send = (page: Page, paneId: string, text: string) =>
    page.evaluate(
      ({ id, bytes }) => (window as HookWindow).__norenTest?.sendOutput(id, bytes) ?? false,
      { id: paneId, bytes: text },
    );
  const notifications = (page: Page) =>
    page.evaluate(() => (window as HookWindow).__norenTest?.notifications() ?? []);
  const unfocus = (page: Page) =>
    page.evaluate(() => (window as HookWindow).__norenTest?.setWindowFocused(false));
  const advance = (page: Page, ms: number) =>
    page.evaluate((by) => (window as HookWindow).__norenTest?.advanceClock(by), ms);

  const BEL = "\x07";
  const osc = (text: string): string => `\x1b]${text}${BEL}`;

  /** A command that lasts `seconds` on the clock of the fake shell, in a tab out of sight (p3). */
  async function longCommand(page: Page, seconds: number): Promise<void> {
    await send(page, "p3", osc("633;E;make") + osc("133;C"));
    await advance(page, seconds * 1000);
    await send(page, "p3", osc("133;D;0"));
  }

  test("the limit of a long command changes with the file, without a restart", async ({ page }) => {
    await open(page);
    await longCommand(page, 6);
    await send(page, "p4", osc("9;barrier"));
    // Nothing yet: 6 s is under the default 30 s, and the window has the focus.
    expect(await notifications(page)).toEqual([]);

    await setConfig(page, '{ "notifications": { "longCommandSeconds": 5 } }');
    await longCommand(page, 6);
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(await notifications(page)).toEqual([
      { title: "Command finished in build", body: "make finished after 6s" },
    ]);
  });

  test("turning them off in the file silences the bell, and turning them back on wakes it", async ({
    page,
  }) => {
    await open(page);
    await unfocus(page);
    await setConfig(page, '{ "notifications": { "enabled": false } }');
    await send(page, "p3", BEL);
    // A second event after the first, to be sure the first was handled.
    await send(page, "p4", osc("9;Second"));
    expect(await notifications(page)).toEqual([]);

    await setConfig(page, '// back on\n{ "notifications": { "enabled": true } }');
    await send(page, "p4", osc("9;Third"));
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(await notifications(page)).toEqual([{ title: "logs", body: "Third" }]);
  });

  test("the file rules over the old key of the browser storage, and the key is dropped", async ({
    page,
  }) => {
    // The storage says 300 s; the file says 5 s, and the file wins.
    await open(page, '{ "notifications": { "longCommandSeconds": 5 } }', {
      longCommandSeconds: 300,
    });
    await longCommand(page, 6);
    await expect.poll(() => notifications(page)).toHaveLength(1);
    expect(JSON.parse((await configText(page)) ?? "null")).toEqual({
      notifications: { longCommandSeconds: 5 },
    });
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), NOTIFICATIONS_KEY),
    ).toBeNull();

    // Without the setting in the file the default answers: 6 s is under its 30 s, the old 300 s is
    // gone. The bell of a window out of focus comes after, as the barrier that shows the command
    // was handled.
    await setConfig(page, "{}");
    await longCommand(page, 6);
    await unfocus(page);
    await send(page, "p4", osc("9;barrier"));
    await expect.poll(() => notifications(page)).toHaveLength(2);
    expect((await notifications(page)).map((n) => n.body)).toEqual([
      "make finished after 6s",
      "barrier",
    ]);
  });

  test("a choice kept in the browser storage before the file existed moves into the file", async ({
    page,
  }) => {
    await open(page, undefined, { enabled: false, longCommandSeconds: 90 });
    expect(JSON.parse((await configText(page)) ?? "null")).toEqual({
      notifications: { enabled: false, longCommandSeconds: 90 },
    });
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), NOTIFICATIONS_KEY),
    ).toBeNull();
    // And it is in force: off, so the bell of a window out of focus says nothing.
    await unfocus(page);
    await send(page, "p3", BEL);
    await send(page, "p4", osc("9;barrier"));
    expect(await notifications(page)).toEqual([]);
  });

  test("the screen turns them off and changes the limit, and the file keeps its comments", async ({
    page,
  }) => {
    await open(
      page,
      '// my notifications\n{\n  "notifications": { "longCommandSeconds": 90 }, // slow\n}\n',
    );
    await changeSettings(page, async (screen) => {
      await screen.getByRole("switch", { name: "System notifications", exact: true }).uncheck();
      await screen
        .getByRole("textbox", { name: "Long command limit (seconds)", exact: true })
        .fill("12.5");
    });
    const text = (await configText(page)) ?? "";
    expect(text).toContain("// my notifications");
    expect(text).toContain("// slow");
    expect(text).toContain('"longCommandSeconds": 12.5');
    expect(text).toContain('"enabled": false');
    await unfocus(page);
    await send(page, "p3", BEL);
    await send(page, "p4", osc("9;barrier"));
    expect(await notifications(page)).toEqual([]);
  });
});

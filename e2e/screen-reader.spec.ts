import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { closeSettings, changeSettings, openSettings, seedConfig } from "./settings-fixture";
import { seedSidebarState } from "./sidebar-fixture";

// Screen reader support (NOR-F20-01a). The option `terminal.screenReaderMode` turns on the
// accessibility tree of xterm (`.xterm-accessibility`) in the terminals that are running, with no
// new session; the key in the settings and the command of the palette flip it. One live region,
// polite and assertive (errors only), says what changed: the tab or the space switched to, a command
// that ended with its exit code, the bell, a shell that ended, the result of Pull and Push.
// What a real screen reader says is not checked here (D19); the text it is given is.

interface Hook {
  paneIds(): string[];
  sendOutput(paneId: string, text: string): boolean;
  focusedSessionId(): number | undefined;
  lines(): string[];
}
type HookWindow = Window & { __norenTest?: Hook };

const WEB_SYNC_KEY = "noren.web.sync";
const REMOTE = "https://example.com/me/noren-settings.git";

const polite = (page: Page): Locator => page.locator('[data-nr-part="announcer-polite"]');
const assertive = (page: Page): Locator => page.locator('[data-nr-part="announcer-assertive"]');
const notice = (page: Page): Locator => page.locator('[data-nr-part="pane-notice"]');
const palette = (page: Page): Locator => page.locator('[data-nr-part="palette"]');
const accessibilityTrees = (page: Page): Locator => page.locator(".xterm-accessibility");
const tab = (page: Page, name: string): Locator =>
  page.getByRole("treeitem", { name, exact: true });

/** The app with the sidebar workspace: tab "api" on screen, "build" and "logs" behind it, a space "Other". */
async function openApp(page: Page, config?: unknown): Promise<void> {
  await seedSidebarState(page, { secondSpace: true });
  if (config !== undefined) await seedConfig(page, JSON.stringify(config));
  await page.goto("/");
  await expect(tab(page, "api")).toHaveAttribute("aria-current", "true");
  await expect(page.locator("textarea.xterm-helper-textarea").first()).toBeAttached();
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

/** Types a command line in the terminal of the focused pane and presses Enter. */
async function run(page: Page, line: string): Promise<void> {
  await page.getByRole("textbox", { name: "Terminal input", exact: true }).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/** Runs the palette command whose title is `title`, found by typing `query`. */
async function runCommand(page: Page, query: string, title: string): Promise<void> {
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Control+Shift+P");
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("combobox", { name: "Command palette", exact: true });
  await expect(box).toBeFocused();
  await box.fill(`>${query}`);
  await expect(palette(page).getByRole("option").first().locator(".palette-title")).toHaveText(
    title,
  );
  await page.keyboard.press("Enter");
  await expect(palette(page)).toBeHidden();
}

const sessionId = (page: Page): Promise<number | undefined> =>
  page.evaluate(() => (window as HookWindow).__norenTest?.focusedSessionId());

test.describe("the screen reader mode of the terminal", () => {
  test("is off by default: xterm builds no accessibility tree", async ({ page }) => {
    await openApp(page);
    await expect(accessibilityTrees(page)).toHaveCount(0);
  });

  test("on in the file: every terminal has the accessibility tree of xterm", async ({ page }) => {
    await openApp(page, { terminal: { screenReaderMode: true } });
    await expect(accessibilityTrees(page).first()).toBeAttached();
    // One tree for each terminal that is open (the three tabs of the space on screen, at least).
    expect(await accessibilityTrees(page).count()).toBeGreaterThanOrEqual(3);
  });

  test("the key in the settings turns it on and off in the running terminals, without a new session", async ({
    page,
  }) => {
    await openApp(page);
    await run(page, "echo before");
    await expect
      .poll(() => page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n")))
      .toContain("before");
    const session = await sessionId(page);
    expect(session).toBeDefined();

    await changeSettings(page, (screen) =>
      screen.getByRole("switch", { name: "Screen reader mode", exact: true }).check(),
    );
    await expect(accessibilityTrees(page).first()).toBeAttached();
    // The same shell goes on: same session, same history.
    expect(await sessionId(page)).toBe(session);
    expect(
      await page.evaluate(() => (window as HookWindow).__norenTest?.lines().join("\n")),
    ).toContain("before");

    await changeSettings(page, (screen) =>
      screen.getByRole("switch", { name: "Screen reader mode", exact: true }).uncheck(),
    );
    await expect(accessibilityTrees(page)).toHaveCount(0);
    expect(await sessionId(page)).toBe(session);
  });

  test("the key shows what the file says, and a hint", async ({ page }) => {
    await openApp(page, { terminal: { screenReaderMode: true } });
    const screen = await openSettings(page);
    await expect(
      screen.getByRole("switch", { name: "Screen reader mode", exact: true }),
    ).toBeChecked();
    await expect(screen).toContainText("Gives a screen reader the text of the terminal");
    await closeSettings(page);
  });

  test("the palette command turns it on and off, and says so", async ({ page }) => {
    await openApp(page);
    await runCommand(page, "screen reader", "Toggle screen reader mode");
    await expect(notice(page)).toHaveText("Screen reader mode is on.");
    await expect(accessibilityTrees(page).first()).toBeAttached();

    await runCommand(page, "screen reader", "Toggle screen reader mode");
    await expect(notice(page)).toHaveText("Screen reader mode is off.");
    await expect(accessibilityTrees(page)).toHaveCount(0);
  });

  test("axe finds no serious or critical violation on the window with the mode on", async ({
    page,
  }) => {
    await openApp(page, { terminal: { screenReaderMode: true } });
    await expect(accessibilityTrees(page).first()).toBeAttached();
    const { violations } = await new AxeBuilder({ page }).analyze();
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const report = blocking.map(
      (v) =>
        `${v.impact ?? "?"} ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target.join(" ")}\n    ${n.failureSummary ?? ""}`).join("\n"),
    );
    expect(report, "serious or critical violations with the screen reader mode on").toEqual([]);
  });
});

test.describe("the announcements", () => {
  test("there is one live region, with a polite and an assertive part, next to the notice line", async ({
    page,
  }) => {
    await openApp(page);
    await expect(page.locator('[data-nr-part="announcer"]')).toHaveCount(1);
    await expect(polite(page)).toHaveAttribute("aria-live", "polite");
    await expect(assertive(page)).toHaveAttribute("aria-live", "assertive");
    await expect(notice(page)).toHaveAttribute("role", "status");
    // It starts empty and says nothing for the tab the window opened on.
    await expect(polite(page)).toHaveText("");
    await expect(assertive(page)).toHaveText("");
  });

  test("switching tab and then space is announced", async ({ page }) => {
    await openApp(page);
    await tab(page, "build").click();
    await expect(polite(page)).toHaveText("Tab build");
    await page.getByRole("button", { name: "Other", exact: true }).click();
    await expect(polite(page)).toHaveText("Space Other, tab elsewhere");
    await expect(assertive(page)).toHaveText("");
  });

  test("a command that ended is announced with its exit code, a failure assertively", async ({
    page,
  }) => {
    await openApp(page);
    await run(page, "echo hello");
    await expect(polite(page)).toHaveText(/^Command finished with exit code 0: .*echo hello$/);
    await expect(assertive(page)).toHaveText("");
    await run(page, "false");
    await expect(assertive(page)).toHaveText(/^Command finished with exit code 1: .*false$/);
  });

  test("the bell is announced with the tab, and fifty bells in a burst are announced once", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      const region = document.querySelector('[data-nr-part="announcer-polite"]');
      const seen: string[] = [];
      (window as unknown as { __seen: string[] }).__seen = seen;
      new MutationObserver(() => seen.push(region?.textContent ?? "")).observe(region as Node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    for (let i = 0; i < 50; i++) await send(page, "p4", "\x07");
    await expect(polite(page)).toHaveText("Bell in logs");
    const spoken = await page.evaluate(() =>
      (window as unknown as { __seen: string[] }).__seen.filter((text) => text !== ""),
    );
    expect(spoken).toEqual(["Bell in logs"]);
  });

  test("a shell that ended is announced with its tab and its code, assertively when it failed", async ({
    page,
  }) => {
    await openApp(page);
    await run(page, "exit 3");
    await expect(assertive(page)).toHaveText("Session ended in api with exit code 3");
  });

  test("the result of Pull is announced: assertively when it failed, politely when it worked", async ({
    page,
  }) => {
    await page.addInitScript(
      ({ key, value }) => {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      },
      {
        key: WEB_SYNC_KEY,
        value: JSON.stringify({ remoteFiles: { "mods/rounded.css": "/* rounded */\n" } }),
      },
    );
    await openApp(page);
    // Nothing connected: the sentence that says where to connect is an error.
    await runCommand(page, "pull settings", "Pull settings");
    const noRemote = "No remote is connected. Connect one in Settings, in the Sync section.";
    await expect(notice(page)).toHaveText(noRemote);
    await expect(assertive(page)).toHaveText(noRemote);
    // The line shows it but does not say it as well: the announcer does, once.
    await expect(notice(page).locator("span[aria-hidden=true]")).toHaveText(noRemote);

    const screen = await openSettings(page);
    const sync = screen.getByRole("region", { name: "Sync", exact: true });
    await sync.getByRole("textbox", { name: "Remote address", exact: true }).fill(REMOTE);
    await sync.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(sync.locator('[data-nr-part="settings-sync-status"]')).toBeVisible();
    await closeSettings(page);

    await runCommand(page, "pull settings", "Pull settings");
    await expect(notice(page)).toHaveText("Pulled 1 file: mods/rounded.css.");
    await expect(polite(page)).toHaveText("Pulled 1 file: mods/rounded.css.");
  });

  test("a notice that is not a sync result is said by the notice line, not by the announcer", async ({
    page,
  }) => {
    await openApp(page);
    await runCommand(page, "reopen closed", "Reopen closed tab");
    await expect(notice(page)).toHaveText("No closed tab to reopen");
    await expect(notice(page).locator("span[aria-hidden=true]")).toHaveCount(0);
    await expect(polite(page)).toHaveText("");
    await expect(assertive(page)).toHaveText("");
  });

  test("axe finds no serious or critical violation with an announcement in the region", async ({
    page,
  }) => {
    await openApp(page);
    await tab(page, "build").click();
    await expect(polite(page)).toHaveText("Tab build");
    const { violations } = await new AxeBuilder({ page }).analyze();
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking.map((v) => v.id)).toEqual([]);
  });
});

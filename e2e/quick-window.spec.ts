import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  closeShortcutsScreen,
  openSettings,
  openShortcutsScreen,
  shortcutsScreen,
} from "./settings-fixture";

// The quick terminal window, drawn as a panel next to the app (`/?quick-preview`): one page, one
// in-memory backend and one bus, as the two windows share the sessions and the events in the real
// app. What it shows: Esc asks the window to hide and the shell stays; "Promote to tab" puts the very
// same session in a tab of the space on screen and hides the window; the global shortcut is listed
// in the shortcuts screen and in the settings and follows the chord the user records. That the
// window really appears, takes the focus and answers the global key is checked by nobody here (it
// would need a visible window): `quick.rs` and `shortcut.rs` hold the order of the steps, and
// `noren --smoke-quick` checks the window and the promotion in the real app, hidden.

interface TestHook {
  lines(): string[];
  focusedSessionId(): number | undefined;
  killedSessions(): number[];
  sessionStarts(): unknown[];
  quickVisible(): boolean;
  quickToggles(): number;
  quickShortcut(): string | null;
  quickShortcutAsks(): (string | null)[];
  failQuickShortcut(reason: string | null): void;
}
interface QuickHook {
  show(): Promise<void>;
  shown(): boolean;
  hideRequests(): number;
  sessions(): number[];
}
type HookWindow = Window & { __norenTest?: TestHook; __norenQuick?: QuickHook };

/** Calls a method of the hook of the app (`window.__norenTest`) in the page. */
const app = <K extends keyof TestHook>(
  page: Page,
  method: K,
  ...args: Parameters<TestHook[K]>
): Promise<ReturnType<TestHook[K]>> =>
  page.evaluate(
    ([name, given]) => {
      const hook = (window as HookWindow).__norenTest as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      return hook[name as string]?.(...(given as unknown[]));
    },
    [method, args] as const,
  ) as Promise<ReturnType<TestHook[K]>>;
/** The same for the hook of the quick window panel (`window.__norenQuick`). */
const quick = <K extends keyof QuickHook>(
  page: Page,
  method: K,
  ...args: Parameters<QuickHook[K]>
): Promise<ReturnType<QuickHook[K]>> =>
  page.evaluate(
    ([name, given]) => {
      const hook = (window as HookWindow).__norenQuick as unknown as Record<
        string,
        (...a: unknown[]) => unknown
      >;
      return hook[name as string]?.(...(given as unknown[]));
    },
    [method, args] as const,
  ) as Promise<ReturnType<QuickHook[K]>>;

const tabs = (page: Page) =>
  page.getByRole("list", { name: "Tabs", exact: true }).getByRole("button");
const panel = (page: Page) => page.locator('[data-nr-part="quick-preview"]');
const promoteButton = (page: Page) => panel(page).locator('[data-nr-part="quick-promote"]');

async function open(page: Page): Promise<void> {
  await page.goto("/?quick-preview");
  // The hooks come with the first render of the app and of the panel.
  await page.waitForFunction(() => {
    const w = window as HookWindow;
    return w.__norenTest !== undefined && w.__norenQuick !== undefined;
  });
  await expect
    .poll(() => app(page, "lines").then((lines) => lines.some((l) => l.startsWith("fake$"))))
    .toBe(true);
  await expect(panel(page)).toHaveAttribute("data-nr-shown", "false");
}

/** What the Rust side does when the shortcut shows the window, then a click so its terminal has the keyboard. */
async function showQuick(page: Page): Promise<void> {
  await quick(page, "show");
  await expect(panel(page)).toHaveAttribute("data-nr-shown", "true");
  await expect.poll(() => quick(page, "sessions").then((ids) => ids.length)).toBe(1);
  await expect(promoteButton(page)).toBeEnabled();
  await panel(page).locator(".terminal-host").click();
}

test("showing the window opens one shell, and Esc asks it to hide while the shell stays", async ({
  page,
}) => {
  await open(page);
  expect(await app(page, "sessionStarts").then((starts) => starts.length)).toBe(1);

  await showQuick(page);
  // One shell for the window, besides the one of the first tab.
  expect(await app(page, "sessionStarts").then((starts) => starts.length)).toBe(2);
  expect(await quick(page, "hideRequests")).toBe(0);

  await page.keyboard.press("Escape");
  await expect.poll(() => quick(page, "hideRequests")).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-nr-shown", "false");

  // Shown again, it is the same shell: nothing was started or ended.
  await quick(page, "show");
  await expect(panel(page)).toHaveAttribute("data-nr-shown", "true");
  expect(await app(page, "sessionStarts").then((starts) => starts.length)).toBe(2);
  expect(await app(page, "killedSessions")).toEqual([]);
  expect(await quick(page, "sessions")).toHaveLength(1);
});

test("Esc in the terminal of the app does not touch the quick window", async ({ page }) => {
  await open(page);
  await showQuick(page);
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Escape");
  // Give a wrong handler time to act.
  await page.waitForTimeout(150);
  expect(await quick(page, "hideRequests")).toBe(0);
  await expect(panel(page)).toHaveAttribute("data-nr-shown", "true");
});

test("Promote to tab puts the same session in a tab of the space on screen and hides the window", async ({
  page,
}) => {
  await open(page);
  await expect(tabs(page)).toHaveCount(1);
  await showQuick(page);
  const [session] = await quick(page, "sessions");
  expect(session).toBeGreaterThan(0);

  await promoteButton(page).click();

  await expect(tabs(page)).toHaveCount(2);
  await expect.poll(() => quick(page, "hideRequests")).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-nr-shown", "false");
  // The new tab is the one on screen and it holds the session the window had.
  await expect.poll(() => app(page, "focusedSessionId")).toBe(session);
  // Nothing was restarted: two shells in all (the first tab's and the window's), none ended, and the
  // shell still answers from its tab.
  expect(await app(page, "sessionStarts").then((starts) => starts.length)).toBe(2);
  expect(await app(page, "killedSessions")).toEqual([]);
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.type("echo promoted-in-place");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => app(page, "lines").then((lines) => lines.includes("promoted-in-place")))
    .toBe(true);
  expect(await app(page, "sessionStarts").then((starts) => starts.length)).toBe(2);

  // The window is empty after a promotion: the next time it shows it opens a new shell.
  await quick(page, "show");
  await expect.poll(() => quick(page, "sessions").then((ids) => ids.length)).toBe(2);
  expect(await app(page, "sessionStarts").then((starts) => starts.length)).toBe(3);
});

test("the promote button waits for a shell", async ({ page }) => {
  await open(page);
  await expect(promoteButton(page)).toBeDisabled();
});

test("the global shortcut is in the shortcuts screen and in the settings, and follows the chord recorded", async ({
  page,
}) => {
  await open(page);
  // Registered at start with the default chord.
  await expect.poll(() => app(page, "quickShortcut")).toBe("Ctrl+Backquote");

  const settings = await openSettings(page);
  await expect(settings.locator('[data-nr-part="quick-shortcut"]')).toHaveText(
    "Quick terminal: Ctrl+` shows and hides it from any program. Change it in Keyboard shortcuts.",
  );
  await settings.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const screen = shortcutsScreen(page);
  await screen.getByRole("textbox", { name: "Search shortcuts" }).fill("quick terminal");
  await expect(
    screen.getByLabel("Shortcut for Show or hide quick terminal", { exact: true }),
  ).toHaveText("Ctrl+`");

  await screen
    .getByRole("button", { name: "Record shortcut for Show or hide quick terminal" })
    .click();
  await page.keyboard.press("Control+Alt+Q");
  await expect(
    screen.getByLabel("Shortcut for Show or hide quick terminal", { exact: true }),
  ).toHaveText("Ctrl+Alt+Q");
  // The system was asked for the new chord, and the old one is not asked for again.
  await expect.poll(() => app(page, "quickShortcut")).toBe("Ctrl+Alt+KeyQ");
  expect(await app(page, "quickShortcutAsks")).toEqual(["Ctrl+Backquote", "Ctrl+Alt+KeyQ"]);
  await closeShortcutsScreen(page);

  // The settings screen shows the new chord too.
  const again = await openSettings(page);
  await expect(again.locator('[data-nr-part="quick-shortcut"]')).toContainText("Ctrl+Alt+Q");
});

test("a chord another program holds is a notice, and the settings say so", async ({ page }) => {
  await open(page);
  await expect.poll(() => app(page, "quickShortcut")).toBe("Ctrl+Backquote");
  await app(page, "failQuickShortcut", "HotKey already registered");

  const screen = await openShortcutsScreen(page);
  await screen.getByRole("textbox", { name: "Search shortcuts" }).fill("quick terminal");
  await screen
    .getByRole("button", { name: "Record shortcut for Show or hide quick terminal" })
    .click();
  await page.keyboard.press("Control+Alt+Q");
  await closeShortcutsScreen(page);

  await expect(page.locator('[data-nr-part="pane-notice"]')).toContainText(
    "The quick terminal shortcut Ctrl+Alt+Q is not available: HotKey already registered",
  );
  // The system still holds the one before.
  expect(await app(page, "quickShortcut")).toBe("Ctrl+Backquote");
  const settings = await openSettings(page);
  await expect(settings.locator('[data-nr-part="quick-shortcut"]')).toContainText(
    "Ctrl+Alt+Q is not available (HotKey already registered)",
  );
});

test("the key inside the window and the palette entry show and hide the quick window", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-nr-part="pane"]:visible').first().click();
  await page.keyboard.press("Control+Backquote");
  await expect.poll(() => app(page, "quickToggles")).toBe(1);
  expect(await app(page, "quickVisible")).toBe(true);

  await page.keyboard.press("Control+Shift+P");
  await page
    .locator('[data-nr-part="palette"]')
    .getByRole("combobox", { name: "Command palette", exact: true })
    .fill("quick terminal");
  await page.keyboard.press("Enter");
  await expect.poll(() => app(page, "quickToggles")).toBe(2);
  expect(await app(page, "quickVisible")).toBe(false);
});

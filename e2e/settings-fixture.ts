import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// Helpers for the tests that use the settings screen: it is the only place the layout, the
// shortcut preset and the notifications are chosen now. There is no Save (NOR-F20-10c): every change
// is written into `config.jsonc` as it is made (the web build keeps that text under
// `noren.web.config`), and closing the screen writes what still waits.

/** Key of the text of `config.jsonc` in the browser storage, in the web build. */
export const WEB_CONFIG_KEY = "noren.web.config";

export const settingsScreen = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Settings", exact: true });

export const shortcutsScreen = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });

/** Opens the settings screen with the button of the title bar. */
export async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const screen = settingsScreen(page);
  await expect(screen).toBeVisible();
  return screen;
}

/** Closes the screen with its X. What was changed is already written (or is, before the screen goes). */
export async function closeSettings(page: Page): Promise<void> {
  const screen = settingsScreen(page);
  await screen.getByRole("button", { name: "Close", exact: true }).click();
  await expect(screen).toHaveCount(0);
}

/**
 * Waits long enough for a write that was due to have happened: a text waits half a second for the next
 * key (leaving its box brings it forward). Only for proving that nothing was written.
 */
export const quiet = (page: Page): Promise<void> => page.waitForTimeout(700);

/** How many times the app asked to write `config.jsonc` (the fake backend counts them). */
export const configSaveCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window as Window & { __norenTest?: { configSaves(): number } }).__norenTest?.configSaves() ??
      -1,
  );

/** Opens the screen, lets `change` touch its controls, and closes it. */
export async function changeSettings(
  page: Page,
  change: (screen: Locator) => Promise<void>,
): Promise<void> {
  const screen = await openSettings(page);
  await change(screen);
  await closeSettings(page);
}

/** Turns the "Pane headers" preference on or off, through the settings screen. */
export async function setPaneHeaders(page: Page, on: boolean): Promise<void> {
  await changeSettings(page, (screen) =>
    screen.getByRole("switch", { name: "Pane headers", exact: true }).setChecked(on),
  );
}

/** Opens the shortcuts screen from the settings screen, which stays open under it. */
export async function openShortcutsScreen(page: Page): Promise<Locator> {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  const screen = shortcutsScreen(page);
  await expect(screen).toBeVisible();
  return screen;
}

/** Closes the shortcuts screen and the settings screen under it. */
export async function closeShortcutsScreen(page: Page): Promise<void> {
  await shortcutsScreen(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(shortcutsScreen(page)).toHaveCount(0);
  await closeSettings(page);
}

/** The text of `config.jsonc` as the web build holds it, `null` when there is no file. */
export const configText = (page: Page): Promise<string | null> =>
  page.evaluate((key) => window.localStorage.getItem(key), WEB_CONFIG_KEY);

/**
 * Seeds the text of `config.jsonc` before the page loads (only on the first load of a test, so a
 * reload finds the file as the app left it). Settings once chosen with the provisional controls
 * are written here too.
 */
export async function seedConfig(page: Page, text: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_CONFIG_KEY, value: text },
  );
}

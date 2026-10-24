import { expect } from "./test";
import type { Locator, Page } from "@playwright/test";

// Helpers for the tests that use the settings screen: it is the only place the layout, the
// shortcut preset and the notifications are chosen now. There is no Save (NOR-F20-10c): every change
// is written into `config.jsonc` as it is made (the web build keeps that text under
// `noren.web.config`), and closing the screen writes what still waits.

/** Key of the text of `config.jsonc` in the browser storage, in the web build. */
export const WEB_CONFIG_KEY = "noren.web.config";

/**
 * The gap of the glass style (the default style) between the cards of the window and around them, in
 * pixels: `--nr-gap` of style-tokens.css. The sidebar is not against the edge of the window under glass,
 * it is this far from it, and so is the terminal.
 */
export const GLASS_GAP = 8;

/**
 * A settings file that chooses the dense style. The tests that are about the machinery of the classic
 * look (a solid window, the opacity numbers of the picture, a sidebar flush with the edge) start from
 * it: the glass style, which is the default, changes those on purpose (NOR-F20-18a) and has its own
 * tests (glass-surfaces.spec.ts).
 */
export const DENSE_CONFIG = '{ "appearance": { "style": "dense" } }';

/**
 * A computed color without its alpha, as `rgb(r, g, b)`. Under the glass style the terminal draws no
 * background of its own (the pane is the glass), so what xterm paints on its element is the color of
 * the theme with an alpha of 0, `rgba(20, 22, 27, 0)`: the tests that ask which theme reached the
 * terminal compare the color, which is the theme's whether the paint is see-through or solid.
 */
export function withoutAlpha(color: string): string {
  const match = /^rgba\((\d+), (\d+), (\d+), [\d.]+\)$/.exec(color);
  return match === null ? color : `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
}

/**
 * `text`, a settings file of the simple kind the tests seed (one root object), with the dense style
 * chosen in its `appearance` (made, if the file has none). A file that already names a style is left as
 * it is. Only for the specs described at `DENSE_CONFIG`.
 */
export function denseOf(text: string): string {
  if (/"style"\s*:/.test(text)) return text;
  const appearance = /"appearance"\s*:\s*\{/;
  if (appearance.test(text)) return text.replace(appearance, '$& "style": "dense",');
  return text.replace("{", '{ "appearance": { "style": "dense" },');
}

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

// Which theme the user picked in the palette. No choice means "follow the system" (the theme the
// operating system's color scheme gives). Pure: `use-theme.ts` keeps the value live.
//
// Provisional storage: the browser's `localStorage` under `noren.ui.theme`, until the settings
// file of NOR-F8-01 takes over.

import { THEMES } from "./theme";

/** Key of the theme choice in the browser storage. */
export const THEME_KEY = "noren.ui.theme";

/** The id of a known theme, or `null` to follow the system. */
export type ThemeChoice = string | null;

/**
 * Reads the saved choice. Anything that is not the id of a known theme (no value, broken JSON,
 * another shape, an id this build does not have) is `null`: follow the system.
 */
export function parseThemeChoice(raw: string | null): ThemeChoice {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>)["id"];
  return typeof id === "string" && THEMES.some((theme) => theme.id === id) ? id : null;
}

/** The part of the browser storage the choice needs (so tests can hand in a plain object). */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The saved choice, or `null` (follow the system) when there is none, the storage is missing or throws. */
export function loadThemeChoice(storage: ThemeStorage | undefined): ThemeChoice {
  try {
    return parseThemeChoice(storage?.getItem(THEME_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Saves the choice (`null` clears it); a storage that refuses is ignored, the choice still applies. */
export function saveThemeChoice(storage: ThemeStorage | undefined, choice: ThemeChoice): void {
  try {
    if (choice === null) storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, JSON.stringify({ id: choice }));
  } catch {
    // The choice only lasts until the page closes.
  }
}

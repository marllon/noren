import { useSyncExternalStore } from "react";
import { THEMES, themeForScheme } from "./theme";
import type { Theme } from "./theme";
import { loadThemeChoice, saveThemeChoice } from "./theme-choice";
import type { ThemeChoice } from "./theme-choice";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const prefersDark = (): boolean => window.matchMedia(DARK_QUERY).matches;

// The theme the user picked, shared by every component that reads the theme. Provisional until the
// settings file (NOR-F8-01) owns it: a change is saved to the browser storage right away.
const listeners = new Set<() => void>();
let choice: ThemeChoice | undefined;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function currentChoice(): ThemeChoice {
  choice ??= loadThemeChoice(storage());
  return choice;
}

function subscribeChoice(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Picks a theme by id, or `null` to follow the system again; saves it and tells the listeners. */
export function setThemeChoice(next: ThemeChoice): void {
  choice = next;
  saveThemeChoice(storage(), next);
  for (const listener of listeners) listener();
}

/** The id of the theme the user picked, or `null` while the theme follows the system. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribeChoice, currentChoice);
}

/**
 * The active theme: the one the user picked in the palette, else the one the operating system's
 * color scheme gives (live). The config (phase 8) will take over the choice.
 */
export function useTheme(): Theme {
  const dark = useSyncExternalStore(subscribeScheme, prefersDark);
  const picked = useThemeChoice();
  return THEMES.find((theme) => theme.id === picked) ?? themeForScheme(dark);
}

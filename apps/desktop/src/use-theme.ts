import { useSyncExternalStore } from "react";
import { themeForScheme } from "./theme";
import type { Theme } from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const prefersDark = (): boolean => window.matchMedia(DARK_QUERY).matches;

/** The active theme; follows `prefers-color-scheme` live until the config chooses one (phase 8). */
export function useTheme(): Theme {
  const dark = useSyncExternalStore(subscribe, prefersDark);
  return themeForScheme(dark);
}

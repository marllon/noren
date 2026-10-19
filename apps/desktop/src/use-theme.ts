import { useSyncExternalStore } from "react";
import { configManager, useConfigState } from "./config-store";
import { THEMES, themeForScheme } from "./theme";
import type { Theme } from "./theme";
import { effectiveThemeChoice, runThemeChoice, themeChoiceOf } from "./theme-choice";
import type { ThemeChoice } from "./theme-choice";
import { activeSpaceOf } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const prefersDark = (): boolean => window.matchMedia(DARK_QUERY).matches;

// The theme the user picked is `appearance.theme` of the settings file (`theme-choice.ts`). On top
// of it there is the preview of the palette: the theme highlighted in the list shows at once,
// without being saved, and goes away when the palette closes. The preview is a value that is
// replaced, never changed, so a view can compare it by identity.
interface Preview {
  readonly choice: ThemeChoice;
}

const listeners = new Set<() => void>();
let preview: Preview | undefined;
/** The `themeId` of the active space (`undefined`: it has none). */
let spaceThemeId: string | undefined;
let stopFollowing: (() => void) | undefined;
/** How many choices are being written; the preview stays until the file has them. */
let writing = 0;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribePreview(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Follows the theme of the active space in `store`: the window shows it while that space is
 * active, so switching space switches the theme (and the terminals) at once. Follows one store at
 * a time; a second call replaces the first.
 */
export function followActiveSpaceTheme(
  store: Pick<WorkspaceStore, "getState" | "subscribe">,
): void {
  stopFollowing?.();
  const read = () => {
    const next = activeSpaceOf(store.getState().workspace).themeId;
    if (next === spaceThemeId) return;
    spaceThemeId = next;
    notify();
  };
  read();
  stopFollowing = store.subscribe(read);
}

/** Stops following the store and forgets the theme of the space, so a test starts from nothing. */
export function resetSpaceTheme(): void {
  stopFollowing?.();
  stopFollowing = undefined;
  spaceThemeId = undefined;
}

/** Shows `choice` (`null`: the system's theme) as the theme of the window, without saving it. */
export function previewTheme(choice: ThemeChoice): void {
  if (preview !== undefined && preview.choice === choice) return;
  preview = { choice };
  notify();
}

/** Drops the preview, so the window shows the saved choice again. Does nothing while a choice is being written. */
export function clearThemePreview(): void {
  if (preview === undefined || writing > 0) return;
  preview = undefined;
  notify();
}

/**
 * Saves `choice` into the file. It shows at once and keeps showing while the file is written, so
 * the window does not flicker back to the old theme; when the write fails the saved choice shows
 * again. Resolves to the notice to show when it did not work, `undefined` otherwise.
 */
export async function chooseTheme(choice: ThemeChoice): Promise<string | undefined> {
  writing += 1;
  preview = { choice };
  notify();
  try {
    return await runThemeChoice(configManager, choice);
  } finally {
    writing -= 1;
    if (writing === 0) {
      preview = undefined;
      notify();
    }
  }
}

/** Forgets the preview, so a test starts from nothing. */
export function resetThemePreview(): void {
  preview = undefined;
  writing = 0;
}

/** The id of the global theme saved in the settings, or `null` while it follows the system. */
export function useThemeChoice(): ThemeChoice {
  return themeChoiceOf(useConfigState().config);
}

/**
 * The active theme: the one being previewed, else the one of the active space, else the one the
 * settings file names, else the one the operating system's color scheme gives (live).
 */
export function useTheme(): Theme {
  const dark = useSyncExternalStore(subscribeScheme, prefersDark);
  const config = useConfigState().config;
  const previewed = useSyncExternalStore(subscribePreview, () => preview);
  const ownId = useSyncExternalStore(subscribePreview, () => spaceThemeId);
  const id = effectiveThemeChoice({ preview: previewed, spaceThemeId: ownId, config });
  return THEMES.find((theme) => theme.id === id) ?? themeForScheme(dark);
}

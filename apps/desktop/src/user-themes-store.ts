import { useSyncExternalStore } from "react";
import { THEMES, parseUserThemes } from "@noren/model";
import type { Backend, Theme } from "@noren/model";

// The themes of the user (the files of `themes/` next to `config.jsonc`) laid on top of the built-in
// ones. `boot.ts` loads them before the first frame, so a space or a global setting that names one
// of them already has it; an import adds to the list. Whatever offers or looks up a theme for the
// window (the palette, the menu of a space, the global theme, the theme of a space) reads the whole
// list from here; `findTheme` of `@noren/model` stays the built-in themes alone, for the code that
// has no business with a theme of the user.

const listeners = new Set<() => void>();
let user: readonly Theme[] = [];
/** The built-in themes, then the user's. Replaced, never changed, so a view compares it by identity. */
let everything: readonly Theme[] = THEMES;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Replaces the themes of the user. */
export function setUserThemes(themes: readonly Theme[]): void {
  user = themes;
  everything = themes.length === 0 ? THEMES : [...THEMES, ...themes];
  notify();
}

/** The themes of the user alone. */
export function getUserThemes(): readonly Theme[] {
  return user;
}

/** Every theme the window can show: the built-in ones, then the user's by name. */
export function allThemes(): readonly Theme[] {
  return everything;
}

/** Adds themes the user just imported (they have ids no other theme has) and keeps the list in order of name. */
export function addUserThemes(themes: readonly Theme[]): void {
  const ids = new Set(themes.map((theme) => theme.id));
  const merged = [...user.filter((theme) => !ids.has(theme.id)), ...themes];
  merged.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id, "en"),
  );
  setUserThemes(merged);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The whole list of themes; the component renders again when it changes. */
export function useAllThemes(): readonly Theme[] {
  return useSyncExternalStore(subscribe, allThemes);
}

/**
 * Reads the theme files of the user from the backend. A file that is not a valid theme is left out
 * and the rest stay. Rejects only when the folder cannot be read; the list stays as it was.
 */
export async function loadUserThemes(backend: Pick<Backend, "listUserThemes">): Promise<void> {
  setUserThemes(parseUserThemes(await backend.listUserThemes()).themes);
}

/** Forgets the themes of the user, so a test starts from nothing. */
export function resetUserThemes(): void {
  setUserThemes([]);
}

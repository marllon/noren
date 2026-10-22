import { useSyncExternalStore } from "react";

// What a screen is trying out before it is saved: the numbers its sliders move. The window shows
// them at once (`windowAppearance` lays them over the settings), and they are forgotten when the
// screen closes, saved or not, so Cancel puts the window back as it was. A value of `null` is a box
// that was emptied ("not set": the default of the window), and `undefined` is a number that is not
// being tried out.

export interface AppearancePreview {
  /** `appearance.window.opacity`: how opaque the panels are. */
  windowOpacity?: number | null | undefined;
  /** `appearance.background.opacity` of the settings file. */
  backgroundOpacity?: number | null | undefined;
  /** `appearance.background.blur` of the settings file. */
  backgroundBlur?: number | null | undefined;
  /** The opacity of the picture of the active space (the dialog of the space). */
  spaceOpacity?: number | null | undefined;
  /** The blur of the picture of the active space. */
  spaceBlur?: number | null | undefined;
}

const KEYS = [
  "windowOpacity",
  "backgroundOpacity",
  "backgroundBlur",
  "spaceOpacity",
  "spaceBlur",
] as const;

let current: AppearancePreview | undefined;
const listeners = new Set<() => void>();

function same(a: AppearancePreview | undefined, b: AppearancePreview | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return KEYS.every((key) => a[key] === b[key]);
}

/** Whether a preview tries out nothing at all. */
function isEmpty(preview: AppearancePreview): boolean {
  return KEYS.every((key) => preview[key] === undefined);
}

/**
 * Shows these numbers in the window until they are replaced or cleared (`undefined`). Nothing is
 * written anywhere; a preview with no number in it is the same as none.
 */
export function setAppearancePreview(next: AppearancePreview | undefined): void {
  const wanted = next !== undefined && isEmpty(next) ? undefined : next;
  if (same(current, wanted)) return;
  current = wanted;
  for (const listener of [...listeners]) listener();
}

/** The preview in force, `undefined` for none. */
export function appearancePreview(): AppearancePreview | undefined {
  return current;
}

/** Calls `listener` whenever the preview changes; returns the function that stops it. */
export function onAppearancePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The preview in force, `undefined` for none; the component renders again when it changes. */
export function useAppearancePreview(): AppearancePreview | undefined {
  return useSyncExternalStore(onAppearancePreview, appearancePreview);
}

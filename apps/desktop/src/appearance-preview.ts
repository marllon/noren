import { useSyncExternalStore } from "react";
import type { TerminalOptions } from "@noren/model";
import type { Layout } from "./layout";

// What a screen is trying out before it is saved: the numbers its sliders move, the picture it chose,
// the layout of the window and the look of the terminal (the settings screen, NOR-F20-08b and
// NOR-F20-10b). The window shows them at once (`windowAppearance` lays the numbers and the picture over
// the settings, the layout and the terminal stores lay theirs over the file), and they are forgotten
// when the screen closes, saved or not, so Cancel puts the window back as it was. A value of `null` is
// a box that was emptied ("not set": the default of the window), and `undefined` is a setting that is
// not being tried out.

export interface AppearancePreview {
  /** `appearance.window.opacity`: how opaque the panels are. */
  windowOpacity?: number | null | undefined;
  /** `appearance.background.opacity` of the settings file. */
  backgroundOpacity?: number | null | undefined;
  /** `appearance.background.blur` of the settings file. */
  backgroundBlur?: number | null | undefined;
  /** `appearance.background.image` of the settings file: a picture that was read (`null`: none at all). */
  backgroundImage?: string | null | undefined;
  /** The opacity of the picture of the active space (the dialog of the space). */
  spaceOpacity?: number | null | undefined;
  /** The blur of the picture of the active space. */
  spaceBlur?: number | null | undefined;
  /** The layout preferences the screen is trying out (the sidebar, the tabs, the pane headers). */
  layout?: Partial<Layout> | undefined;
  /** The options of the terminal the screen is trying out (the font, the cursor). */
  terminal?: Partial<TerminalOptions> | undefined;
}

const KEYS = [
  "windowOpacity",
  "backgroundOpacity",
  "backgroundBlur",
  "backgroundImage",
  "spaceOpacity",
  "spaceBlur",
] as const;

const GROUPS = ["layout", "terminal"] as const;

let current: AppearancePreview | undefined;
const listeners = new Set<() => void>();

function sameFields(
  a: Partial<Record<string, unknown>> | undefined,
  b: Partial<Record<string, unknown>> | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

function same(a: AppearancePreview | undefined, b: AppearancePreview | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    KEYS.every((key) => a[key] === b[key]) && GROUPS.every((key) => sameFields(a[key], b[key]))
  );
}

/** Whether a group says anything: a group with no setting in it tries out nothing. */
const saysSomething = (group: object | undefined): boolean =>
  group !== undefined && Object.values(group).some((value) => value !== undefined);

/** `preview` without the groups that say nothing. */
function withoutEmptyGroups(preview: AppearancePreview): AppearancePreview {
  const { layout, terminal, ...rest } = preview;
  return {
    ...rest,
    ...(saysSomething(layout) ? { layout } : {}),
    ...(saysSomething(terminal) ? { terminal } : {}),
  };
}

/** Whether a preview tries out nothing at all. */
function isEmpty(preview: AppearancePreview): boolean {
  return (
    KEYS.every((key) => preview[key] === undefined) &&
    GROUPS.every((key) => preview[key] === undefined)
  );
}

/**
 * Shows these settings in the window until they are replaced or cleared (`undefined`). Nothing is
 * written anywhere; a preview with nothing in it is the same as none.
 */
export function setAppearancePreview(next: AppearancePreview | undefined): void {
  const clean = next === undefined ? undefined : withoutEmptyGroups(next);
  const wanted = clean !== undefined && isEmpty(clean) ? undefined : clean;
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

import { useSyncExternalStore } from "react";
import type { Config } from "@noren/model";
import { appearancePreview, onAppearancePreview } from "./appearance-preview";
import { configManager } from "./config-store";
import { clampWidth, layoutOf } from "./layout";
import type { Layout } from "./layout";
import { SETTING_PATHS } from "./settings-screen";

// The layout preferences, shared by the shell and the sidebar handle. They are settings of the
// file (`appearance` in config.jsonc): this store only reads them from the settings in force, so a
// change of the file by the settings screen, by the handle or by another program shows at once.
// It adds two things: the width while the handle is dragged (shown right away, written to the file
// when the move ends, so a drag does not save the file at every pixel), and the layout the settings
// screen is trying out before Save (`appearance-preview.ts`), which Cancel takes back.

const listeners = new Set<() => void>();

/** The width the handle is asking for and the file does not have yet. */
let previewWidth: number | undefined;

/** The layout in force, rebuilt when the settings or the previews change. */
let view: Layout | undefined;
let viewConfig: Config | undefined;
let viewPreview: number | undefined;
let viewTrial: Partial<Layout> | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function current(): Layout {
  const config = configManager.state.config;
  const trial = appearancePreview()?.layout;
  if (
    view === undefined ||
    viewConfig !== config ||
    viewPreview !== previewWidth ||
    viewTrial !== trial
  ) {
    // The file, then what the settings screen is trying out, then the width the handle is dragged to.
    const layout = { ...layoutOf(config), ...definedOnly(trial) };
    const next = previewWidth === undefined ? layout : { ...layout, width: previewWidth };
    // The same layout stays the same object, so a slider of another setting does not render the shell.
    if (view === undefined || !sameLayout(view, next)) view = next;
    viewConfig = config;
    viewPreview = previewWidth;
    viewTrial = trial;
  }
  return view;
}

function sameLayout(a: Layout, b: Layout): boolean {
  return (
    a.side === b.side &&
    a.width === b.width &&
    a.density === b.density &&
    a.compact === b.compact &&
    a.keepOpen === b.keepOpen &&
    a.tabs === b.tabs &&
    a.paneHeaders === b.paneHeaders
  );
}

/** The fields of `layout` that say something (a field that is `undefined` is not a field). */
function definedOnly(layout: Partial<Layout> | undefined): Partial<Layout> {
  return Object.fromEntries(
    Object.entries(layout ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<Layout>;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const stopFollowingConfig = configManager.subscribe(onChange);
  const stopFollowingPreview = onAppearancePreview(onChange);
  return () => {
    listeners.delete(onChange);
    stopFollowingConfig();
    stopFollowingPreview();
  };
}

/** The layout in force: the settings file over the defaults, and the width being dragged. */
export function getLayout(): Layout {
  return current();
}

/** Shows `width` (kept in range) as the width of the sidebar, without writing the file. */
export function previewSidebarWidth(width: number): void {
  previewWidth = clampWidth(width);
  notify();
}

/**
 * Writes `width` (kept in range) as `appearance.sidebar.width` in the file. It shows at once; when
 * the file cannot take it (it has a problem, the disk refuses) the width goes back to the one the
 * file has. Never rejects.
 */
export async function saveSidebarWidth(width: number): Promise<void> {
  const target = clampWidth(width);
  previewWidth = target;
  notify();
  await configManager.update([{ path: SETTING_PATHS.width, value: target }]);
  // A newer move may be on its way; its own save ends the preview.
  if (previewWidth === target) {
    previewWidth = undefined;
    notify();
  }
}

/** The layout preferences; the component renders again when any of them changes. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, getLayout);
}

/** Forgets what was read, so a test starts from nothing. */
export function resetLayoutStore(): void {
  previewWidth = undefined;
  view = undefined;
  viewConfig = undefined;
  viewPreview = undefined;
  viewTrial = undefined;
}

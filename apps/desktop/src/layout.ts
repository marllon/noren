// How the window is laid out: which side the sidebar is on, how wide it is, how dense the rows are
// and whether it hides. Pure: the interface applies what this returns and `layout-store.ts` keeps it.
//
// Provisional storage: the browser's `localStorage` under `noren.ui.layout`, until the settings file
// of NOR-F8-01 takes over these preferences.

/** Key of the layout preferences in the browser storage. */
export const LAYOUT_KEY = "noren.ui.layout";

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 200;

/** Pixels one arrow press moves the sidebar edge; Shift moves it by the large step. */
export const WIDTH_STEP = 16;
export const WIDTH_STEP_LARGE = 48;

export type SidebarSide = "left" | "right";
export type Density = "comfortable" | "compact";

export interface Layout {
  side: SidebarSide;
  /** Width of the sidebar in pixels, always within 180 to 480. */
  width: number;
  density: Density;
  /** Compact mode: the sidebar leaves the layout and shows over it when the pointer touches the edge. */
  compact: boolean;
  /** In compact mode, keeps the sidebar open (docked) instead of hiding it. */
  keepOpen: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  side: "left",
  width: DEFAULT_SIDEBAR_WIDTH,
  density: "comfortable",
  compact: false,
  keepOpen: false,
};

/** A width forced into the allowed range and rounded to whole pixels. */
export function clampWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

/**
 * Reads the saved layout. Whatever is missing or invalid (no text, broken JSON, a field of the wrong
 * type) falls back to the default for that field; a width out of range is brought into range.
 */
export function parseLayout(raw: string | null): Layout {
  if (raw === null) return { ...DEFAULT_LAYOUT };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_LAYOUT };
  }
  const saved = value as Record<string, unknown>;
  const side = saved["side"];
  const density = saved["density"];
  const width = saved["width"];
  const compact = saved["compact"];
  const keepOpen = saved["keepOpen"];
  return {
    side: side === "left" || side === "right" ? side : DEFAULT_LAYOUT.side,
    width:
      typeof width === "number" && Number.isFinite(width)
        ? clampWidth(width)
        : DEFAULT_LAYOUT.width,
    density: density === "comfortable" || density === "compact" ? density : DEFAULT_LAYOUT.density,
    compact: typeof compact === "boolean" ? compact : DEFAULT_LAYOUT.compact,
    keepOpen: typeof keepOpen === "boolean" ? keepOpen : DEFAULT_LAYOUT.keepOpen,
  };
}

export function serializeLayout(layout: Layout): string {
  return JSON.stringify(layout);
}

/** The part of the browser storage the layout needs (so tests can hand in a plain object). */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved layout, or the default when there is none, the storage is missing or it throws. */
export function loadLayout(storage: LayoutStorage | undefined): Layout {
  try {
    return parseLayout(storage?.getItem(LAYOUT_KEY) ?? null);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** Saves the layout; a storage that refuses (full, blocked) is ignored, the layout still applies. */
export function saveLayout(storage: LayoutStorage | undefined, layout: Layout): void {
  try {
    storage?.setItem(LAYOUT_KEY, serializeLayout(layout));
  } catch {
    // The preference only lasts until the page closes.
  }
}

/**
 * `docked`: the sidebar takes its column. `auto-hide`: compact mode, the sidebar is out of the
 * layout and shows over it on demand. Keeping it open docks it again.
 */
export type SidebarMode = "docked" | "auto-hide";

export function sidebarMode(layout: Layout): SidebarMode {
  return layout.compact && !layout.keepOpen ? "auto-hide" : "docked";
}

/** The width after the sidebar edge is dragged from `startX` to `currentX` (pixels on screen). */
export function widthAfterDrag(
  startWidth: number,
  startX: number,
  currentX: number,
  side: SidebarSide,
): number {
  const delta = side === "left" ? currentX - startX : startX - currentX;
  return clampWidth(startWidth + delta);
}

/**
 * The width a key on the resize handle asks for, or `undefined` for a key it does not handle. The
 * arrow that points away from the sidebar widens it, the other narrows it; Home and End go to the
 * limits.
 */
export function widthAfterKey(
  width: number,
  key: string,
  side: SidebarSide,
  large: boolean,
): number | undefined {
  const step = large ? WIDTH_STEP_LARGE : WIDTH_STEP;
  const widen = side === "left" ? "ArrowRight" : "ArrowLeft";
  const narrow = side === "left" ? "ArrowLeft" : "ArrowRight";
  if (key === widen) return clampWidth(width + step);
  if (key === narrow) return clampWidth(width - step);
  if (key === "Home") return MIN_SIDEBAR_WIDTH;
  if (key === "End") return MAX_SIDEBAR_WIDTH;
  return undefined;
}

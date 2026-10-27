// The size a terminal may take, whatever the page around it does.
//
// The addon that fits a terminal reads the height and the width of the element that holds it and
// divides by the size of a cell. That is only sound while the element has a size of its own, set by the
// window. If the page loses its stylesheet (a request that failed) the element takes the size of what
// is inside it, and what is inside it is the terminal: each fit makes the terminal taller, the element
// taller, and the next fit still taller, until the canvases are hundreds of thousands of pixels high
// and the page cannot be used. A terminal is never larger than the window it is shown in, so the grid
// is cut to what the window can hold: the loop reaches a fixed point at once, and the worst case is a
// terminal as big as the window instead of one without a limit.

export interface Grid {
  cols: number;
  rows: number;
}

export interface Extent {
  width: number;
  height: number;
}

/** The fewest cells a terminal keeps, as the fit addon has it. */
const MINIMUM: Grid = { cols: 2, rows: 1 };

/**
 * The fewest cells a fit may give a terminal and its session. A host with less room than this has no
 * useful size (a pane folded away, a window minimized): the terminal keeps the size it had, and the
 * pane cuts the picture instead of shrinking the session, which would wrap everything the program
 * writes meanwhile in lines of two columns.
 */
export const USEFUL_MINIMUM: Grid = { cols: 20, rows: 3 };

/** What a fit of the terminal depends on, read when it runs. */
export interface FitConditions {
  /** False while the view is hidden (another tab shows). */
  visible: boolean;
  /** `document.visibilityState` is "hidden": the window is minimized or covered, the page is not shown. */
  documentHidden: boolean;
  /** The size of the element that holds the terminal. */
  host: Extent;
  /** The size of a cell, in pixels (0 when not known). */
  cell: Extent;
  /** The window the terminal is shown in. */
  area: Extent;
}

/**
 * The grid a fit gives the terminal, or `undefined` when the fit must change nothing: the view is
 * hidden, the page is hidden, the host has no size or has less room than `USEFUL_MINIMUM`, or the
 * addon could not tell. The grid it returns is `proposed` cut to the window (see `limitGrid`) and is
 * never smaller than `USEFUL_MINIMUM`.
 */
export function planFit(proposed: Grid | undefined, conditions: FitConditions): Grid | undefined {
  const { visible, documentHidden, host, cell, area } = conditions;
  if (!visible || documentHidden) return undefined;
  if (!(host.width > 0) || !(host.height > 0)) return undefined;
  if (
    proposed === undefined ||
    !Number.isFinite(proposed.cols) ||
    !Number.isFinite(proposed.rows)
  ) {
    return undefined;
  }
  if (proposed.cols < USEFUL_MINIMUM.cols || proposed.rows < USEFUL_MINIMUM.rows) return undefined;
  const limited = limitGrid(proposed, cell, area);
  if (limited.cols < USEFUL_MINIMUM.cols || limited.rows < USEFUL_MINIMUM.rows) return undefined;
  return limited;
}

/**
 * `proposed` cut to the cells that fit in `area` (the window), where a cell is `cell` pixels. A grid
 * that fits is returned as it is; a size that is not known (a cell of 0 pixels, a window not laid out)
 * cuts nothing.
 */
export function limitGrid(proposed: Grid, cell: Extent, area: Extent): Grid {
  const cols = cell.width > 0 && area.width > 0 ? Math.floor(area.width / cell.width) : Infinity;
  const rows =
    cell.height > 0 && area.height > 0 ? Math.floor(area.height / cell.height) : Infinity;
  return {
    cols: Math.max(MINIMUM.cols, Math.min(proposed.cols, cols)),
    rows: Math.max(MINIMUM.rows, Math.min(proposed.rows, rows)),
  };
}

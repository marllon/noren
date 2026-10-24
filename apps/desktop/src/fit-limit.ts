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

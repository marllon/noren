import { findOutputPaths, resolveOutputPath } from "@noren/model";

// The paths of the output of a terminal, as links the person can Ctrl+click. The paths are found by
// `findOutputPaths` (pure, in the model) in the text of the line on screen, which is mapped back to
// the cells of the terminal here, since a wide character takes two cells and a path can wrap onto
// the next row. Nothing here reads a disk: what is underlined is decided by the text and the folder
// of the pane alone, so a mouse passing over the output costs nothing.

/** The cell of a terminal line, as far as this needs to see it (xterm's `IBufferCell`). */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
}

/** A line of the buffer of a terminal (xterm's `IBufferLine`). */
export interface LineLike {
  /** True when the line continues the one above it: the text wrapped at the edge of the screen. */
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): CellLike | undefined;
}

/** The buffer of a terminal (xterm's `IBuffer`). */
export interface BufferLike {
  getLine(y: number): LineLike | undefined;
}

/** A path on screen, with where it is in cells (1-based, the end included, as xterm wants it). */
export interface PathLink {
  /** The text on screen that is the link: the path and its `:line:column`. */
  text: string;
  /** The path as written, which `resolveOutputPath` turns into a full path. */
  path: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
}

/** How many rows a path that wraps may take on each side of the row asked about. */
const MAX_WRAPPED_ROWS = 8;

interface Logical {
  text: string;
  /** For each UTF-16 unit of `text`, the row (0-based) and the column (0-based) of its cell. */
  rows: number[];
  columns: number[];
  /** For each unit, how many cells the character it belongs to takes (one, or two for a wide one). */
  widths: number[];
}

/** The text of the line that `row` is part of, with each unit of it tied to its cell. */
function logicalLine(buffer: BufferLike, row: number): Logical | undefined {
  let first = row;
  while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped === true) {
    first--;
  }
  const logical: Logical = { text: "", rows: [], columns: [], widths: [] };
  for (let y = first; y === first || y - first <= 2 * MAX_WRAPPED_ROWS; y++) {
    const line = buffer.getLine(y);
    if (line === undefined || (y > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell === undefined) break;
      const width = cell.getWidth();
      // The second cell of a wide character holds nothing of its own.
      if (width === 0) continue;
      const chars = cell.getChars() === "" ? " " : cell.getChars();
      for (let unit = 0; unit < chars.length; unit++) {
        logical.text += chars[unit];
        logical.rows.push(y);
        logical.columns.push(x);
        logical.widths.push(width);
      }
    }
  }
  return logical.text === "" ? undefined : logical;
}

/**
 * The links in the text on the screen row `row` (0-based): the paths that this row holds a part of,
 * with a full path to open when there is one. A relative path is a link only where the pane has a
 * folder to read it against (`cwd`); a path that resolves to something a preview never opens (a
 * folder on the network) is still a link, so that the click can say why it opens nothing.
 */
export function pathLinksOfRow(
  buffer: BufferLike,
  row: number,
  cwd: string | undefined,
): PathLink[] {
  const logical = logicalLine(buffer, row);
  if (logical === undefined) return [];
  const links: PathLink[] = [];
  for (const match of findOutputPaths(logical.text)) {
    const resolved = resolveOutputPath(match.path, cwd);
    if (!resolved.ok && resolved.problem === "no-folder") continue;
    const last = match.end - 1;
    const startRow = logical.rows[match.start];
    const endRow = logical.rows[last];
    if (startRow === undefined || endRow === undefined || row < startRow || row > endRow) continue;
    links.push({
      text: logical.text.slice(match.start, match.end),
      path: match.path,
      range: {
        start: { x: (logical.columns[match.start] ?? 0) + 1, y: startRow + 1 },
        end: { x: (logical.columns[last] ?? 0) + (logical.widths[last] ?? 1), y: endRow + 1 },
      },
    });
  }
  return links;
}

import { PEEK_LINES, isScrollbackPaneId, layoutPanes, peekLines } from "@noren/model";
import type { Backend, Item } from "@noren/model";
import { readTerminal } from "./scrollback-service";

// Where the peek of a tab gets its lines: the terminal of its focused pane when that is mounted,
// else the snapshot saved for the pane. Either one is untrusted text (the terminal prints what a
// program sends, the file could have been changed), so it goes through `peekLines`, which keeps
// only printable text and cuts the length: the peek draws plain text.

/**
 * How many lines above the screen the terminal is asked for. The last `PEEK_LINES` lines that hold
 * something are wanted, and blank lines between them do not count, so it asks for more than that
 * but far fewer than the two thousand a snapshot keeps.
 */
const PEEK_SCAN_LINES = 100;

/**
 * The last lines of the focused pane of `item`, in order, as plain text. Empty when the pane has
 * no output, no terminal and no readable snapshot. Never rejects.
 */
export async function peekLinesOfItem(
  backend: Pick<Backend, "loadScrollback">,
  item: Item,
  count: number = PEEK_LINES,
): Promise<string[]> {
  const panes = layoutPanes(item.layout);
  const pane = panes.find((candidate) => candidate.id === item.focusedPaneId) ?? panes[0];
  if (pane === undefined) return [];
  const live = readTerminal(pane.id, PEEK_SCAN_LINES);
  // A mounted terminal already shows the saved output (dimmed, above the new session): it wins.
  if (live !== undefined) return peekLines(live, count);
  if (pane.scrollbackRef === undefined || !isScrollbackPaneId(pane.id)) return [];
  try {
    const saved = await backend.loadScrollback(pane.id);
    return saved === null ? [] : peekLines(saved, count);
  } catch {
    return [];
  }
}

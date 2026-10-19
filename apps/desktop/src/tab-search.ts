// The search over the output of every open tab (Ctrl+Shift+Alt+F). Pure: the shell reads the lines
// of each terminal once, when the search opens, and hands them in; this module only matches them.

import { layoutPanes } from "@noren/model";
import type { Id, Workspace } from "@noren/model";
import { itemTitle } from "./favorites";
import { allTabIds } from "./mru";

/** Most lines listed for one tab. */
export const MAX_HITS_PER_TAB = 50;

/** Most lines listed in all. */
export const MAX_HITS_TOTAL = 500;

/** The text of one terminal, as the buffer holds it (scrollback included). */
export interface SearchPane {
  paneId: Id;
  lines: readonly string[];
}

/** One open tab and the text of each of its panes. */
export interface SearchTab {
  itemId: Id;
  spaceId: Id;
  title: string;
  /** Name of the space the tab is in. */
  space: string;
  spaceColor: string;
  panes: readonly SearchPane[];
}

/** One line of a terminal that holds the text. */
export interface SearchHit {
  paneId: Id;
  /** Row in the buffer, counting from 0 at the top of the scrollback. */
  row: number;
  /** The line, without trailing spaces. */
  text: string;
  /** Where the match starts in `text`, or -1 when it cannot be told (case folding moved it). */
  column: number;
  /** Length of the match in `text`. */
  length: number;
}

export interface TabHits {
  itemId: Id;
  spaceId: Id;
  title: string;
  space: string;
  spaceColor: string;
  hits: SearchHit[];
  /** True when more lines matched than the caps let through. */
  truncated: boolean;
}

/** What a search found: the tabs with a match, and whether any caps cut matches off. */
export interface SearchResults {
  tabs: TabHits[];
  truncated: boolean;
}

export interface SearchLimits {
  perTab: number;
  total: number;
}

export const DEFAULT_LIMITS: SearchLimits = { perTab: MAX_HITS_PER_TAB, total: MAX_HITS_TOTAL };

/**
 * Every open tab of every space with the text of each pane, in the order of the sidebar. `readLines`
 * gives the lines of a pane, or `undefined` when its terminal is not mounted (that pane has no text).
 */
export function collectSearchTabs(
  workspace: Workspace,
  readLines: (paneId: Id) => readonly string[] | undefined,
): SearchTab[] {
  const tabs: SearchTab[] = [];
  for (const itemId of allTabIds(workspace)) {
    const space = workspace.spaces.find((s) => s.items[itemId] !== undefined);
    const item = space?.items[itemId];
    if (space === undefined || item === undefined) continue;
    tabs.push({
      itemId,
      spaceId: space.id,
      title: itemTitle(space, itemId),
      space: space.name,
      spaceColor: space.color,
      panes: layoutPanes(item.layout).map((pane) => ({
        paneId: pane.id,
        lines: readLines(pane.id) ?? [],
      })),
    });
  }
  return tabs;
}

/**
 * The lines that contain `query`, case-insensitively, grouped by tab in the order given (the panes of
 * a tab in layout order, the lines of a pane from the top). A blank query lists nothing, and a tab with
 * no match is left out. At most `limits.perTab` lines per tab and `limits.total` in all; a tab cut
 * short by either is marked `truncated`, and so are the results as a whole. Leading and trailing
 * spaces of the query are ignored. A match never spans two rows, even when the shell wrapped a long
 * line over them.
 */
export function searchTabs(
  tabs: readonly SearchTab[],
  query: string,
  limits: SearchLimits = DEFAULT_LIMITS,
): SearchResults {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { tabs: [], truncated: false };
  const found: TabHits[] = [];
  let total = 0;
  let cut = false;
  for (const tab of tabs) {
    const hits: SearchHit[] = [];
    let truncated = false;
    for (const pane of tab.panes) {
      for (let row = 0; row < pane.lines.length; row++) {
        const text = pane.lines[row] ?? "";
        const lower = text.toLowerCase();
        const at = lower.indexOf(needle);
        if (at < 0) continue;
        if (hits.length >= limits.perTab || total + hits.length >= limits.total) {
          truncated = true;
          break;
        }
        // Folding the case can change the length (some letters become two); then the offset is lost.
        const aligned = lower.length === text.length;
        hits.push({
          paneId: pane.paneId,
          row,
          text,
          column: aligned ? at : -1,
          length: needle.length,
        });
      }
      if (truncated) break;
    }
    cut ||= truncated;
    if (hits.length === 0) continue;
    total += hits.length;
    found.push({
      itemId: tab.itemId,
      spaceId: tab.spaceId,
      title: tab.title,
      space: tab.space,
      spaceColor: tab.spaceColor,
      hits,
      truncated,
    });
  }
  return { tabs: found, truncated: cut };
}

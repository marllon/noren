import { layoutPanes } from "@noren/model";
import type { ClosedItem, Id, Pane, Workspace } from "@noren/model";

// What closing a tab does to the scrollback files. The workspace says it in two lists: the closed
// entries that were not there before (their panes' snapshots are written as the tab closes, from
// the terminals that are still alive) and the panes that left the workspace for good (their files
// go). Both are read by comparing the workspace before and after an action, so no place that closes
// a tab has to know about files.

/** A pane of a tab that has just closed. */
export interface ClosedPane {
  paneId: Id;
  /** The closed item that holds the pane. */
  itemId: Id;
  /** `saveScrollback` of the space the tab was in. */
  spaceSaves: boolean;
  /** The pane records a snapshot file. */
  hasFile: boolean;
}

export interface ClosedChanges {
  /** Panes of the entries that joined the closed stack with this change. */
  closed: ClosedPane[];
  /** Panes that had a snapshot file and are no longer anywhere (open, closed or archived). */
  gone: Id[];
}

function panesOf(entries: readonly ClosedItem[]): Pane[] {
  return entries.flatMap((entry) => layoutPanes(entry.item.layout));
}

/** Every pane id the workspace holds, in open, closed and archived items. */
function heldPaneIds(ws: Workspace): Set<Id> {
  const ids = new Set<Id>();
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) ids.add(pane.id);
    }
  }
  for (const pane of panesOf(ws.closed)) ids.add(pane.id);
  for (const entry of ws.archive) {
    for (const pane of layoutPanes(entry.item.layout)) ids.add(pane.id);
  }
  return ids;
}

/**
 * What the change from `before` to `after` did to the closed stack and to the panes with files. A
 * change that touched neither answers with two empty lists, without walking the whole workspace.
 */
export function closedChanges(before: Workspace, after: Workspace): ClosedChanges {
  const none: ClosedChanges = { closed: [], gone: [] };
  if (before === after) return none;
  const known = new Set(before.closed.map((entry) => entry.item.id));
  const joined = after.closed.filter((entry) => !known.has(entry.item.id));
  const closed: ClosedPane[] = joined.flatMap((entry) => {
    const spaceSaves = before.spaces.find((space) => space.id === entry.spaceId)?.saveScrollback;
    return layoutPanes(entry.item.layout).map((pane) => ({
      paneId: pane.id,
      itemId: entry.item.id,
      spaceSaves: spaceSaves ?? true,
      hasFile: pane.scrollbackRef !== undefined,
    }));
  });

  // Panes with a file in `before` that `after` does not hold: an item pushed out of the stack of
  // 50, the pane of a split that was closed, the pane a reset replaced.
  const withFile: Id[] = [];
  for (const space of before.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        if (pane.scrollbackRef !== undefined) withFile.push(pane.id);
      }
    }
  }
  for (const pane of panesOf(before.closed)) {
    if (pane.scrollbackRef !== undefined) withFile.push(pane.id);
  }
  if (withFile.length === 0) return { closed, gone: [] };
  const held = heldPaneIds(after);
  return { closed, gone: withFile.filter((id) => !held.has(id)) };
}

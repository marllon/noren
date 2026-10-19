import { layoutPanes } from "@noren/model";
import type { Id, Item, Pane, Workspace } from "@noren/model";

// What closing or archiving a tab does to the scrollback files. The workspace says it in two lists:
// the closed or archived entries that were not there before (their panes' snapshots are written as
// the tab leaves its space, from the terminals that are still alive) and the panes that left the
// workspace for good (their files go). Both are read by comparing the workspace before and after an
// action, so no place that closes, archives or deletes a tab has to know about files.

/** A pane of a tab that has just closed or been archived. */
export interface ClosedPane {
  paneId: Id;
  /** The closed or archived item that holds the pane. */
  itemId: Id;
  /** `saveScrollback` of the space the tab was in. */
  spaceSaves: boolean;
  /** The pane records a snapshot file. */
  hasFile: boolean;
}

export interface ClosedChanges {
  /** Panes of the entries that joined the closed stack or the archive with this change. */
  closed: ClosedPane[];
  /** Panes that had a snapshot file and are no longer anywhere (open, closed or archived). */
  gone: Id[];
}

function panesOf(entries: readonly { item: Item }[]): Pane[] {
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
  for (const pane of panesOf(ws.archive)) ids.add(pane.id);
  return ids;
}

/**
 * What the change from `before` to `after` did to the closed stack, the archive and the panes with
 * files. A change that touched none of them answers with two empty lists, without walking the whole
 * workspace.
 */
export function closedChanges(before: Workspace, after: Workspace): ClosedChanges {
  const none: ClosedChanges = { closed: [], gone: [] };
  if (before === after) return none;
  const known = new Set(before.closed.map((entry) => entry.item.id));
  const knownArchived = new Set(before.archive.map((entry) => entry.item.id));
  const joined = [
    ...after.closed.filter((entry) => !known.has(entry.item.id)),
    ...after.archive.filter((entry) => !knownArchived.has(entry.item.id)),
  ];
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
  // 50, deleted from the library, the pane of a split that was closed, the pane a reset replaced.
  const withFile: Id[] = [];
  for (const space of before.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        if (pane.scrollbackRef !== undefined) withFile.push(pane.id);
      }
    }
  }
  for (const pane of [...panesOf(before.closed), ...panesOf(before.archive)]) {
    if (pane.scrollbackRef !== undefined) withFile.push(pane.id);
  }
  if (withFile.length === 0) return { closed, gone: [] };
  const held = heldPaneIds(after);
  return { closed, gone: withFile.filter((id) => !held.has(id)) };
}

import { layoutPanes } from "./sessions";
import { spaceItemIds } from "./tree";
import type { Id, Item, LayoutNode, Pane, Space, Workspace } from "./types";
import { spaceIsShown } from "./windows";

// What the user can see, and what happened where they were not looking: the rules for the unread
// and bell marks of a pane. Pure; the reducer and the interface share them.

/** A pane of the workspace, with the space and item that hold it. */
export interface PaneTarget {
  spaceId: Id;
  itemId: Id;
  paneId: Id;
}

/** The item a space shows: its active item, else (a hand-edited file) its first one. */
export function shownItem(space: Space): Item | undefined {
  const chosen = space.activeItemId;
  if (chosen !== undefined && Object.hasOwn(space.items, chosen)) return space.items[chosen];
  const first = spaceItemIds(space)[0];
  return first === undefined ? undefined : space.items[first];
}

/** The panes the user sees on screen: the zoomed one, else every pane of the layout. */
export function visiblePanes(item: Item): Pane[] {
  const panes = layoutPanes(item.layout);
  if (item.zoomedPaneId === undefined) return panes;
  const zoomed = panes.filter((pane) => pane.id === item.zoomedPaneId);
  return zoomed.length > 0 ? zoomed : panes;
}

/**
 * Whether the pane is on screen now: in the item a space shows (the active space in the main window,
 * or the space of another window), and not hidden by zoom.
 */
export function isPaneVisible(ws: Workspace, spaceId: Id, itemId: Id, paneId: Id): boolean {
  if (!spaceIsShown(ws, spaceId)) return false;
  const space = ws.spaces.find((s) => s.id === spaceId);
  const item = space && shownItem(space);
  return (
    item !== undefined && item.id === itemId && visiblePanes(item).some((p) => p.id === paneId)
  );
}

/** Whether the pane has anything to clear. */
export function isMarked(pane: Pane): boolean {
  return pane.unread || pane.bell;
}

/** Copy of the layout with `change` applied to each pane; the same object when nothing changed. */
export function mapPanes(layout: LayoutNode, change: (pane: Pane) => Pane): LayoutNode {
  if (layout.kind === "pane") {
    const pane = change(layout.pane);
    return pane === layout.pane ? layout : { kind: "pane", pane };
  }
  const children = layout.children.map((child) => mapPanes(child, change));
  return children.some((child, index) => child !== layout.children[index])
    ? { ...layout, children }
    : layout;
}

/** The pane without its unread and bell marks. */
export function withoutMarks(pane: Pane): Pane {
  if (!isMarked(pane) && pane.unreadAt === undefined) return pane;
  const next: Pane = { ...pane, unread: false, bell: false };
  delete next.unreadAt;
  return next;
}

/**
 * The unread pane that became unread last, in any space: where Ctrl+Shift+U goes. Panes marked at
 * the same time (and old saved ones, which have no time) are told apart by their place: the first
 * in space order, then sidebar order, then layout order. `undefined` when nothing is unread. A
 * pane that has only a bell counts as unread (the bell sets both marks).
 */
export function lastUnread(ws: Workspace): PaneTarget | undefined {
  let best: { target: PaneTarget; at: number } | undefined;
  for (const space of ws.spaces) {
    for (const itemId of spaceItemIds(space)) {
      const item = space.items[itemId];
      if (!item) continue;
      for (const pane of layoutPanes(item.layout)) {
        if (!isMarked(pane)) continue;
        const at = pane.unreadAt ?? 0;
        if (best === undefined || at > best.at) {
          best = { target: { spaceId: space.id, itemId, paneId: pane.id }, at };
        }
      }
    }
  }
  return best?.target;
}

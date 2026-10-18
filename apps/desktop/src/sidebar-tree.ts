import { MAX_GROUP_DEPTH, findItemSlot, treeItemIds } from "@noren/model";
import type { GroupNode, Id, Node, Space } from "@noren/model";
import { spaceItemIds } from "./workspace-store";

/** A row of the sidebar as it shows: pinned items first, then the tree with open groups expanded. */
export type TreeRow =
  | { kind: "item"; id: Id; depth: number; pinned: boolean }
  | { kind: "group"; group: GroupNode; depth: number; count: number };

/** Items a group holds, nested groups included. */
export function groupItemCount(group: GroupNode): number {
  return group.children.reduce(
    (total, child) => total + (child.kind === "item" ? 1 : groupItemCount(child)),
    0,
  );
}

function treeRows(nodes: readonly Node[], depth: number): TreeRow[] {
  return nodes.flatMap((node): TreeRow[] => {
    if (node.kind === "item") return [{ kind: "item", id: node.id, depth, pinned: false }];
    const header: TreeRow = {
      kind: "group",
      group: node,
      depth,
      count: groupItemCount(node),
    };
    return node.collapsed ? [header] : [header, ...treeRows(node.children, depth + 1)];
  });
}

/** What the sidebar lists, top to bottom. Items inside a collapsed group are left out. */
export function visibleRows(space: Space): TreeRow[] {
  return [
    ...space.pinned.map((id): TreeRow => ({ kind: "item", id, depth: 0, pinned: true })),
    ...treeRows(space.tree, 0),
  ];
}

/** Ids of the items on screen, in the order the user sees them. */
export function visibleItemIds(rows: readonly TreeRow[]): Id[] {
  return rows.flatMap((row) => (row.kind === "item" ? [row.id] : []));
}

/** The tabs the user selected with Ctrl/Shift+click, and where the next Shift+click starts. */
export interface Selection {
  ids: Id[];
  anchor?: Id;
}

export const NO_SELECTION: Selection = { ids: [] };

export interface ClickModifiers {
  /** Ctrl, or Cmd on macOS. */
  toggle: boolean;
  shift: boolean;
}

/**
 * The selection after a click on tab `clicked`. `order` is the visible order of the tabs and
 * `activeId` the tab that shows, which counts as selected when a selection starts.
 *
 * - plain click: nothing is selected (the tab just activates) and the click is the new anchor;
 * - Ctrl/Cmd+click: toggles the tab (a first toggle keeps the active tab selected);
 * - Shift+click: selects the visible range from the anchor to the tab, in the order shown
 *   (with Ctrl/Cmd it adds that range to what was selected).
 *
 * The result keeps only visible tabs, in visible order.
 */
export function clickSelection(
  current: Selection,
  order: readonly Id[],
  clicked: Id,
  modifiers: ClickModifiers,
  activeId: Id | undefined,
): Selection {
  const clickedAt = order.indexOf(clicked);
  if (clickedAt < 0) return NO_SELECTION;
  const kept = current.ids.filter((id) => order.includes(id));
  const sorted = (ids: Iterable<Id>): Id[] => {
    const wanted = new Set(ids);
    return order.filter((id) => wanted.has(id));
  };

  if (modifiers.shift) {
    const start = current.anchor ?? activeId;
    const startAt = start === undefined ? -1 : order.indexOf(start);
    if (start === undefined || startAt < 0) return { ids: [clicked], anchor: clicked };
    const range = order.slice(Math.min(startAt, clickedAt), Math.max(startAt, clickedAt) + 1);
    return {
      ids: sorted(modifiers.toggle ? [...kept, ...range] : range),
      anchor: start,
    };
  }
  if (modifiers.toggle) {
    const base = kept.length > 0 || activeId === undefined ? kept : [activeId];
    const next = new Set(base);
    if (next.has(clicked)) next.delete(clicked);
    else next.add(clicked);
    return { ids: sorted(next), anchor: clicked };
  }
  return { ids: [], anchor: clicked };
}

/** The selection limited to what is on screen, in visible order. */
export function visibleSelection(selection: Selection, order: readonly Id[]): Id[] {
  const wanted = new Set(selection.ids);
  return order.filter((id) => wanted.has(id));
}

/**
 * The tabs a context menu opened on `clicked` acts on: the whole selection when the tab is part of
 * it, otherwise just that tab.
 */
export function menuTargets(selected: readonly Id[], clicked: Id): Id[] {
  return selected.length > 1 && selected.includes(clicked) ? [...selected] : [clicked];
}

/** What the tab menu offers for a set of tabs of one space. */
export interface ItemMenuModel {
  single: boolean;
  /** Every target is pinned (so the menu offers "Unpin"). */
  allPinned: boolean;
  /** Every target is a favorite (so the menu offers to remove them). */
  allFavorite: boolean;
  /** The targets can become a group: tree items only, and the group fits the nesting limit. */
  canGroup: boolean;
  /** Tabs of the space that are neither targets nor pinned: what "Close others" closes. */
  others: Id[];
}

export function itemMenuModel(
  space: Space,
  favorites: readonly Id[],
  targets: readonly Id[],
): ItemMenuModel {
  const wanted = new Set(targets);
  // The group takes the place of the first target in tree order, as the reducer does.
  const inTree = treeItemIds(space.tree).filter((id) => wanted.has(id));
  const first = inTree[0];
  const slot = first === undefined ? undefined : findItemSlot(space.tree, first);
  return {
    single: targets.length === 1,
    allPinned: targets.length > 0 && targets.every((id) => space.pinned.includes(id)),
    allFavorite: targets.length > 0 && targets.every((id) => favorites.includes(id)),
    canGroup:
      slot !== undefined && slot.parentDepth < MAX_GROUP_DEPTH && inTree.length === wanted.size,
    others: spaceItemIds(space).filter((id) => !wanted.has(id) && !space.pinned.includes(id)),
  };
}

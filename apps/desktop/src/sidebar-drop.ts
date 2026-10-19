import { layoutPanes } from "@noren/model";
import type { Action, Id, Node, Space } from "@noren/model";
import type { TreeRow } from "./sidebar-tree";

// Where a dragged tab or group lands in the sidebar tree. Everything here is pure: the drag layer
// only measures the pointer and asks, and the answer is an `Action` for the reducer.

/** What is being dragged. Pinned tabs sit still: they are not draggable. */
export interface DragSource {
  kind: "item" | "group";
  id: Id;
}

export type DropEdge = "before" | "after" | "inside";

/** A place in the tree and the row that shows the indicator for it. */
export interface DropTarget {
  /** The row the indicator is drawn on. */
  rowId: Id;
  edge: DropEdge;
  /** The group whose children list receives the node; undefined is the top level. */
  groupId: Id | undefined;
  /** Insertion point in that list, counted with the dragged node still in it. */
  index: number;
}

interface Entry {
  node: Node;
  parentId: Id | undefined;
  index: number;
  /** Ancestor groups, outer first. */
  chain: Id[];
}

function indexTree(
  nodes: readonly Node[],
  parentId: Id | undefined,
  chain: Id[],
  out: Map<Id, Entry>,
): Map<Id, Entry> {
  nodes.forEach((node, index) => {
    out.set(node.id, { node, parentId, index, chain });
    if (node.kind === "group") indexTree(node.children, node.id, [...chain, node.id], out);
  });
  return out;
}

/** Final position of the node in the target list, after it left its old spot. */
function finalIndex(from: Entry, target: DropTarget): number {
  if (target.groupId !== from.parentId) return target.index;
  return target.index > from.index ? target.index - 1 : target.index;
}

function isNoop(from: Entry, target: DropTarget): boolean {
  return target.groupId === from.parentId && finalIndex(from, target) === from.index;
}

const edgeOf = (fraction: number): "before" | "after" => (fraction < 0.5 ? "before" : "after");

function itemTarget(over: Entry, fraction: number): DropTarget {
  const { node } = over;
  if (node.kind === "item") {
    const edge = edgeOf(fraction);
    return {
      rowId: node.id,
      edge,
      groupId: over.parentId,
      index: over.index + (edge === "after" ? 1 : 0),
    };
  }
  // On a group header: the edges place the tab beside the group, the middle puts it inside.
  if (fraction < 0.25) {
    return { rowId: node.id, edge: "before", groupId: over.parentId, index: over.index };
  }
  if (fraction > 0.75 && node.collapsed) {
    return { rowId: node.id, edge: "after", groupId: over.parentId, index: over.index + 1 };
  }
  return {
    rowId: node.id,
    edge: "inside",
    groupId: node.id,
    index: node.collapsed ? node.children.length : 0,
  };
}

/** The last row on screen that belongs to `rowId` (itself, or the end of its open group). */
function lastRowOf(rows: readonly TreeRow[], rowId: Id): Id {
  const idOf = (row: TreeRow): Id => (row.kind === "group" ? row.group.id : row.id);
  const start = rows.findIndex((row) => idOf(row) === rowId);
  const first = rows[start];
  if (!first) return rowId;
  let last = first;
  for (const row of rows.slice(start + 1)) {
    if (row.depth <= first.depth) break;
    last = row;
  }
  return idOf(last);
}

function groupTarget(
  rows: readonly TreeRow[],
  entries: ReadonlyMap<Id, Entry>,
  source: Entry,
  over: Entry,
  fraction: number,
): DropTarget | undefined {
  // A group keeps its parent: it only changes place among its siblings.
  const path = [...over.chain, over.node.id];
  const refId = path.find((id) => entries.get(id)?.parentId === source.parentId);
  const ref = refId === undefined ? undefined : entries.get(refId);
  if (refId === undefined || !ref) return undefined;
  const edge = refId === over.node.id ? edgeOf(fraction) : "after";
  return {
    rowId: edge === "before" ? refId : lastRowOf(rows, refId),
    edge,
    groupId: source.parentId,
    index: ref.index + (edge === "after" ? 1 : 0),
  };
}

function actionFor(source: DragSource, from: Entry, target: DropTarget): Action {
  const index = finalIndex(from, target);
  if (source.kind === "item") {
    return {
      type: "item/move",
      itemId: source.id,
      placement: {
        to: "tree",
        ...(target.groupId !== undefined ? { groupId: target.groupId } : {}),
        index,
      },
    };
  }
  return {
    type: "group/move",
    groupId: source.id,
    ...(target.groupId !== undefined ? { parentGroupId: target.groupId } : {}),
    index,
  };
}

/**
 * The place a drop over row `overId` means, when the pointer is `fraction` (0 top, 1 bottom) of the
 * way down that row; undefined when dropping there would change nothing or is not allowed.
 *
 * - over a tab: the upper half is before it, the lower half after it, in the list it belongs to
 *   (so a tab dropped beside a grouped tab joins that group, and beside a loose one leaves it);
 * - over a group header: the upper quarter is before the group, the lower quarter after it (only
 *   when it is folded), the rest is inside it (at the top of an open group, at the end of a folded);
 * - a dragged group only moves among its siblings: a row deeper inside a sibling group means
 *   "after that group". It never goes inside itself or nests into another group by dragging.
 */
export function resolveDrop(
  space: Space,
  rows: readonly TreeRow[],
  source: DragSource,
  overId: Id,
  fraction: number,
): DropTarget | undefined {
  const entries = indexTree(space.tree, undefined, [], new Map());
  const from = entries.get(source.id);
  const over = entries.get(overId);
  if (!from || !over || overId === source.id || over.chain.includes(source.id)) return undefined;
  const target =
    source.kind === "item"
      ? itemTarget(over, fraction)
      : groupTarget(rows, entries, from, over, fraction);
  return target && !isNoop(from, target) ? target : undefined;
}

/** The action that carries out a drop, or undefined when the target is unknown or a no-op. */
export function dropAction(
  space: Space,
  source: DragSource,
  target: DropTarget,
): Action | undefined {
  const entries = indexTree(space.tree, undefined, [], new Map());
  const from = entries.get(source.id);
  if (!from || isNoop(from, target)) return undefined;
  return actionFor(source, from, target);
}

/** A drop place the keyboard can step to, with the spot on the row that resolves to it. */
export interface DropSlot {
  rowId: Id;
  fraction: number;
  target: DropTarget;
}

const PROBES = [0.1, 0.5, 0.9] as const;

/**
 * Every distinct place the dragged node could go, top to bottom, found by probing each row near
 * its top, middle and bottom with `resolveDrop` (so the keyboard and the pointer share one rule).
 */
export function dropSlots(space: Space, rows: readonly TreeRow[], source: DragSource): DropSlot[] {
  const slots: DropSlot[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind === "item" && row.pinned) continue;
    const rowId = row.kind === "group" ? row.group.id : row.id;
    for (const fraction of PROBES) {
      const target = resolveDrop(space, rows, source, rowId, fraction);
      if (!target) continue;
      const key = `${target.groupId ?? ""}|${target.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ rowId, fraction, target });
    }
  }
  return slots;
}

// Drops outside the tree: on the icon of another space, on the Pinned zone or on the Favorites zone.

/** Prefix of the droppable id of a space icon; the rest is the space id. */
export const SPACE_DROP_PREFIX = "space:";
export const PINNED_DROP_ID = "zone:pinned";
export const FAVORITES_DROP_ID = "zone:favorites";

/** A place outside the tree where a tab can be dropped. */
export type OutsideDrop =
  { kind: "space"; spaceId: Id } | { kind: "pinned" } | { kind: "favorites" };

/** The droppable id of an outside place (the inverse of `outsideOf`). */
export function outsideId(drop: OutsideDrop): string {
  if (drop.kind === "space") return `${SPACE_DROP_PREFIX}${drop.spaceId}`;
  return drop.kind === "pinned" ? PINNED_DROP_ID : FAVORITES_DROP_ID;
}

/** The outside place a droppable id stands for; undefined for a row of the tree. */
export function outsideOf(id: string): OutsideDrop | undefined {
  if (id === PINNED_DROP_ID) return { kind: "pinned" };
  if (id === FAVORITES_DROP_ID) return { kind: "favorites" };
  return id.startsWith(SPACE_DROP_PREFIX)
    ? { kind: "space", spaceId: id.slice(SPACE_DROP_PREFIX.length) }
    : undefined;
}

/**
 * The action that carries out dropping a tab outside the tree, or undefined when nothing would
 * change (same space, already pinned, already a favorite) or the source is not a tab.
 *
 * - on another space: the tab goes to the end of that space's tree (the active space stays);
 * - on Pinned: the tab is pinned in its own space;
 * - on Favorites: the tab becomes a favorite (global, it stays where it is).
 */
export function outsideAction(
  spaces: readonly Space[],
  favorites: readonly Id[],
  source: DragSource,
  drop: OutsideDrop,
): Action | undefined {
  if (source.kind !== "item") return undefined;
  const home = spaces.find((space) => Object.hasOwn(space.items, source.id));
  if (!home) return undefined;
  switch (drop.kind) {
    case "space":
      return drop.spaceId !== home.id && spaces.some((space) => space.id === drop.spaceId)
        ? { type: "item/move", itemId: source.id, spaceId: drop.spaceId }
        : undefined;
    case "pinned":
      return home.pinned.includes(source.id) ? undefined : { type: "item/pin", itemId: source.id };
    case "favorites":
      return favorites.includes(source.id)
        ? undefined
        : { type: "item/favorite", itemId: source.id };
  }
}

// Drops on a pane of the tab on screen: the tab joins that tab, beside the pane.

/** Prefix of the droppable id of a pane; the rest is the pane id. */
export const PANE_DROP_PREFIX = "pane:";

/** The droppable id of a pane (the inverse of `paneOf`). */
export const paneDropId = (paneId: Id): string => `${PANE_DROP_PREFIX}${paneId}`;

/** The pane a droppable id stands for; undefined for anything else. */
export function paneOf(id: string): Id | undefined {
  return id.startsWith(PANE_DROP_PREFIX) ? id.slice(PANE_DROP_PREFIX.length) : undefined;
}

/** Which side of a pane the dropped tab lands on, as the split it makes. */
export interface PaneZone {
  dir: "row" | "column";
  side: "before" | "after";
}

/** A drop on one zone of a pane. */
export interface PaneDrop extends PaneZone {
  paneId: Id;
}

/**
 * How deep into the pane (a fraction of its width or height, counted from the nearest edge) the
 * pointer still means "beside this pane". The middle is left alone for the swap (NOR-F5-02c).
 */
export const PANE_EDGE_BAND = 0.3;

/**
 * The zone of a pane the pointer is over: the nearest edge decides (left and right are a row split,
 * top and bottom a column split; before is left or top). The middle of the pane is no zone, and a
 * tie between a vertical and a horizontal edge goes to the horizontal one.
 */
export function paneZone(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
): PaneZone | undefined {
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const x = Math.min(1, Math.max(0, (point.x - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (point.y - rect.top) / rect.height));
  const edges: { depth: number; zone: PaneZone }[] = [
    { depth: x, zone: { dir: "row", side: "before" } },
    { depth: 1 - x, zone: { dir: "row", side: "after" } },
    { depth: y, zone: { dir: "column", side: "before" } },
    { depth: 1 - y, zone: { dir: "column", side: "after" } },
  ];
  let nearest = edges[0];
  for (const edge of edges) if (nearest && edge.depth < nearest.depth) nearest = edge;
  return nearest && nearest.depth < PANE_EDGE_BAND ? nearest.zone : undefined;
}

/**
 * Whether a tab can be dropped on the panes of `targetItemId`: only a tab other than the one on
 * screen (dropping a tab on its own panes changes nothing); groups are not tabs.
 */
export function canDropOnPane(source: DragSource, targetItemId: Id | undefined): boolean {
  return source.kind === "item" && targetItemId !== undefined && source.id !== targetItemId;
}

/** The action that joins the dragged tab into `targetItemId`, beside the pane of the drop. */
export function paneDropAction(
  source: DragSource,
  targetItemId: Id,
  drop: PaneDrop,
): Action | undefined {
  if (!canDropOnPane(source, targetItemId)) return undefined;
  return {
    type: "item/join",
    itemId: source.id,
    targetItemId,
    targetPaneId: drop.paneId,
    dir: drop.dir,
    side: drop.side,
  };
}

/** The panes the target tab would hold after the join: more than `maxPanes` and the model refuses. */
export function joinedPaneCount(space: Space, sourceId: Id, targetItemId: Id): number | undefined {
  const source = space.items[sourceId];
  const target = space.items[targetItemId];
  if (!source || !target) return undefined;
  return layoutPanes(source.layout).length + layoutPanes(target.layout).length;
}

/** What the notice says when a join would pass the pane limit. */
export const paneLimitNotice = (maxPanes: number): string =>
  `A tab holds at most ${maxPanes} panes.`;

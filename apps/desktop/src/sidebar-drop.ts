import type { Action, Id, Node, Space } from "@noren/model";
import type { TreeRow } from "./sidebar-tree";

// Where a dragged tab or group lands in the sidebar tree. Everything here is pure: the drag layer
// only measures the pointer and asks, and the answer is an `Action` for the reducer.

/** What is being dragged. Pinned tabs are not draggable yet (they belong to NOR-F4-04b). */
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

import type { GroupNode, Id, Node } from "./types";

// Pure helpers over the sidebar tree (`Space.tree`). None of them mutates its input.

/** Item ids in visual (depth-first) order. */
export function treeItemIds(nodes: readonly Node[]): Id[] {
  return nodes.flatMap((node) => (node.kind === "item" ? [node.id] : treeItemIds(node.children)));
}

/** Every group, outer before inner. */
export function treeGroups(nodes: readonly Node[]): GroupNode[] {
  return nodes.flatMap((node) =>
    node.kind === "group" ? [node, ...treeGroups(node.children)] : [],
  );
}

export interface GroupLocation {
  group: GroupNode;
  /** 1 for a top-level group. */
  depth: number;
}

export function findGroup(
  nodes: readonly Node[],
  groupId: Id,
  depth = 1,
): GroupLocation | undefined {
  for (const node of nodes) {
    if (node.kind !== "group") continue;
    if (node.id === groupId) return { group: node, depth };
    const inner = findGroup(node.children, groupId, depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

export interface ItemSlot {
  /** The group holding the item; undefined at the top level. */
  parentId: Id | undefined;
  /** Depth of that group (0 at the top level). */
  parentDepth: number;
  index: number;
}

export function findItemSlot(
  nodes: readonly Node[],
  itemId: Id,
  parentId?: Id,
  parentDepth = 0,
): ItemSlot | undefined {
  for (const [index, node] of nodes.entries()) {
    if (node.kind === "item") {
      if (node.id === itemId) return { parentId, parentDepth, index };
      continue;
    }
    const inner = findItemSlot(node.children, itemId, node.id, parentDepth + 1);
    if (inner) return inner;
  }
  return undefined;
}

/** Tree without the item nodes in `ids`. */
export function removeItemNodes(nodes: readonly Node[], ids: ReadonlySet<Id>): Node[] {
  return nodes.flatMap((node): Node[] => {
    if (node.kind === "item") return ids.has(node.id) ? [] : [node];
    return [{ ...node, children: removeItemNodes(node.children, ids) }];
  });
}

/** Tree with `update` applied to one group; undefined when the group does not exist. */
export function updateGroup(
  nodes: readonly Node[],
  groupId: Id,
  update: (group: GroupNode) => GroupNode,
): Node[] | undefined {
  let found = false;
  const walk = (list: readonly Node[]): Node[] =>
    list.map((node): Node => {
      if (node.kind === "item" || found) return node;
      if (node.id === groupId) {
        found = true;
        return update(node);
      }
      return { ...node, children: walk(node.children) };
    });
  const result = walk(nodes);
  return found ? result : undefined;
}

/**
 * Tree with `edit` applied to the child list of a group (the top level when `groupId` is absent).
 * Undefined when the group does not exist or `edit` gives up by returning undefined.
 */
export function editChildren(
  nodes: readonly Node[],
  groupId: Id | undefined,
  edit: (children: readonly Node[]) => Node[] | undefined,
): Node[] | undefined {
  if (groupId === undefined) return edit(nodes);
  let edited: Node[] | undefined;
  const result = updateGroup(nodes, groupId, (group) => {
    edited = edit(group.children);
    return edited ? { ...group, children: edited } : group;
  });
  return edited ? result : undefined;
}

/** Tree where the group is replaced, in place, by its children. */
export function replaceGroupWithChildren(nodes: readonly Node[], groupId: Id): Node[] {
  return nodes.flatMap((node): Node[] => {
    if (node.kind === "item") return [node];
    if (node.id === groupId) return node.children;
    return [{ ...node, children: replaceGroupWithChildren(node.children, groupId) }];
  });
}

export function insertAt<T>(list: readonly T[], index: number, value: T): T[] {
  return [...list.slice(0, index), value, ...list.slice(index)];
}

/**
 * Position inside a list of `length` entries: `fallback` when absent, clamped to `0..length`,
 * undefined for a value that is not an integer.
 */
export function resolveIndex(
  index: number | undefined,
  length: number,
  fallback: number,
): number | undefined {
  if (index === undefined) return fallback;
  if (!Number.isInteger(index)) return undefined;
  return Math.min(Math.max(index, 0), length);
}

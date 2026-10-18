import type { GroupNode, Id, Node, Space } from "@noren/model";
import { groupItemCount } from "./sidebar-tree";

/**
 * What the top tab bar shows: a tab per item and a group as an island that holds its own nodes.
 * A collapsed group keeps its header (name and count) and holds no nodes.
 */
export type BarNode =
  | { kind: "item"; id: Id; pinned: boolean }
  | { kind: "group"; group: GroupNode; count: number; nodes: BarNode[] };

function treeNodes(nodes: readonly Node[]): BarNode[] {
  return nodes.map((node): BarNode => {
    if (node.kind === "item") return { kind: "item", id: node.id, pinned: false };
    return {
      kind: "group",
      group: node,
      count: groupItemCount(node),
      nodes: node.collapsed ? [] : treeNodes(node.children),
    };
  });
}

/** The bar of a space: pinned tabs first, then the tree, in the same order as the sidebar. */
export function barNodes(space: Space): BarNode[] {
  return [
    ...space.pinned.map((id): BarNode => ({ kind: "item", id, pinned: true })),
    ...treeNodes(space.tree),
  ];
}

/** The tabs on the bar, left to right (the same as the visible rows of the sidebar). */
export function barItemIds(nodes: readonly BarNode[]): Id[] {
  return nodes.flatMap((node) => (node.kind === "item" ? [node.id] : barItemIds(node.nodes)));
}

/**
 * Which control a key moves the focus to inside the bar: Left and Right step to the neighbor (and
 * stop at the ends), Home and End jump to the ends. `undefined` for any other key.
 */
export function barFocusTarget(key: string, current: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === "ArrowRight") return Math.min(count - 1, current + 1);
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

import { layoutPanes } from "./sessions";
import type { Id, LayoutNode, Pane, SplitNode } from "./types";

// Pure helpers over a layout tree (`Item.layout`). None of them mutates its input.

export type SplitDir = SplitNode["dir"];
/** Which side of the target pane the new content goes on. */
export type Side = "before" | "after";

export function countPanes(layout: LayoutNode): number {
  return layoutPanes(layout).length;
}

export function findPane(layout: LayoutNode, paneId: Id): Pane | undefined {
  return layoutPanes(layout).find((pane) => pane.id === paneId);
}

/** Sizes scaled to sum 100; undefined unless every entry is finite and positive (and the scale holds). */
export function normalizeSizes(sizes: readonly number[]): number[] | undefined {
  if (sizes.length === 0 || sizes.some((size) => !Number.isFinite(size) || !(size > 0))) {
    return undefined;
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total) || !(total > 0)) return undefined;
  const scaled = sizes.map((size) => (size / total) * 100);
  return scaled.every((size) => Number.isFinite(size) && size > 0) ? scaled : undefined;
}

/**
 * Layout with `content` placed beside the pane `targetId`, on the given side, in a split of `dir`.
 * When the pane already sits in a split of the same direction, `content` becomes one more child
 * and takes half of the pane's size; otherwise the pane is wrapped in a new 50/50 split.
 * Undefined when the pane is not in the layout.
 */
export function insertBeside(
  layout: LayoutNode,
  targetId: Id,
  dir: SplitDir,
  side: Side,
  content: LayoutNode,
): LayoutNode | undefined {
  if (layout.kind === "pane") {
    if (layout.pane.id !== targetId) return undefined;
    return {
      kind: "split",
      dir,
      sizes: [50, 50],
      children: side === "before" ? [content, layout] : [layout, content],
    };
  }
  for (const [index, child] of layout.children.entries()) {
    if (layout.dir === dir && child.kind === "pane" && child.pane.id === targetId) {
      const size = layout.sizes[index];
      if (size === undefined) return undefined;
      const at = side === "before" ? index : index + 1;
      return {
        ...layout,
        children: [...layout.children.slice(0, at), content, ...layout.children.slice(at)],
        // Halving is exact in floating point, so the sum stays 100.
        sizes: [
          ...layout.sizes.slice(0, index),
          size / 2,
          size / 2,
          ...layout.sizes.slice(index + 1),
        ],
      };
    }
    const inner = insertBeside(child, targetId, dir, side, content);
    if (inner) {
      return { ...layout, children: layout.children.map((c, i) => (i === index ? inner : c)) };
    }
  }
  return undefined;
}

/**
 * Layout without the pane; the tree collapses: a split left with one child becomes that child, and
 * the freed space goes to the siblings in proportion. Undefined when the pane is not in the layout
 * or is the whole layout (there is nothing left to show).
 */
export function removePane(layout: LayoutNode, paneId: Id): LayoutNode | undefined {
  if (layout.kind === "pane") return undefined;
  const at = layout.children.findIndex((c) => c.kind === "pane" && c.pane.id === paneId);
  if (at >= 0) {
    const children = layout.children.filter((_, i) => i !== at);
    const only = children[0];
    if (children.length === 1 && only) return only;
    const sizes = normalizeSizes(layout.sizes.filter((_, i) => i !== at));
    return sizes ? { ...layout, children, sizes } : undefined;
  }
  for (const [index, child] of layout.children.entries()) {
    const inner = removePane(child, paneId);
    if (inner) {
      return { ...layout, children: layout.children.map((c, i) => (i === index ? inner : c)) };
    }
  }
  return undefined;
}

/** Layout with the two panes in each other's place; sizes stay with the positions. */
export function swapPanes(layout: LayoutNode, a: Pane, b: Pane): LayoutNode {
  if (layout.kind === "pane") {
    if (layout.pane.id === a.id) return { kind: "pane", pane: b };
    if (layout.pane.id === b.id) return { kind: "pane", pane: a };
    return layout;
  }
  return { ...layout, children: layout.children.map((child) => swapPanes(child, a, b)) };
}

/** Child indices from the root to every split, root first (`[]` is the root split). */
export function splitPaths(layout: LayoutNode, prefix: readonly number[] = []): number[][] {
  if (layout.kind === "pane") return [];
  return [
    [...prefix],
    ...layout.children.flatMap((child, index) => splitPaths(child, [...prefix, index])),
  ];
}

export function splitAt(layout: LayoutNode, path: readonly number[]): SplitNode | undefined {
  let node: LayoutNode | undefined = layout;
  for (const index of path) {
    if (node?.kind !== "split" || !Number.isInteger(index)) return undefined;
    node = node.children[index];
  }
  return node?.kind === "split" ? node : undefined;
}

/** Layout with the sizes of the split at `path` replaced; undefined when `path` names no split. */
export function setSplitSizes(
  layout: LayoutNode,
  path: readonly number[],
  sizes: number[],
): LayoutNode | undefined {
  if (layout.kind !== "split") return undefined;
  const [head, ...rest] = path;
  if (head === undefined) return { ...layout, sizes };
  const child = layout.children[head];
  const inner = child && setSplitSizes(child, rest, sizes);
  return inner
    ? { ...layout, children: layout.children.map((c, i) => (i === head ? inner : c)) }
    : undefined;
}

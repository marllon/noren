import { layoutPanes } from "@noren/model";
import type { Id, LayoutNode, SplitNode } from "@noren/model";

/** Panels smaller than this (percent of their split) cannot be dragged any smaller. */
export const MIN_PANEL_PERCENT = 10;

/** Two size lists closer than this (percentage points) are the same layout. */
export const SIZE_TOLERANCE = 0.1;

/** First pane in layout order: the name a nested split borrows for its panel. */
function firstPaneId(node: LayoutNode): Id {
  return layoutPanes(node)[0]?.id ?? "";
}

/**
 * Id of the panel a child takes inside its split. Stable while the child stays where it is, so the
 * panel library keeps the size it learned; different for every child of one split.
 */
export function childPanelId(child: LayoutNode): string {
  return child.kind === "pane" ? `pane-${child.pane.id}` : `split-${firstPaneId(child)}`;
}

/** Changes whenever the panels of one split change (direction, children or their order). */
export function splitKey(node: SplitNode): string {
  return `${node.dir}:${node.children.map(childPanelId).join(",")}`;
}

/** Layout the panel library starts from: panel id to percentage, as the model stores it. */
export function sizesToLayout(node: SplitNode): Record<string, number> {
  const layout: Record<string, number> = {};
  node.children.forEach((child, index) => {
    layout[childPanelId(child)] = node.sizes[index] ?? 0;
  });
  return layout;
}

/**
 * The sizes of a split, in child order, from the layout the panel library reports. Undefined when
 * a panel is missing or a value is not a positive number (the library is mid-change).
 */
export function layoutToSizes(
  node: SplitNode,
  layout: Readonly<Record<string, number>>,
): number[] | undefined {
  const sizes: number[] = [];
  for (const child of node.children) {
    const size = layout[childPanelId(child)];
    if (size === undefined || !Number.isFinite(size) || size <= 0) return undefined;
    sizes.push(size);
  }
  return sizes;
}

/** Percentage points a keyboard resize moves a separator. */
export const RESIZE_STEP = 5;

/** The splits that hold a pane, root first, each with the path to it and the child on the way down. */
function ancestorsOf(
  node: LayoutNode,
  paneId: Id,
  path: number[] = [],
): { split: SplitNode; path: number[]; index: number }[] | undefined {
  if (node.kind === "pane") return node.pane.id === paneId ? [] : undefined;
  for (const [index, child] of node.children.entries()) {
    const below = ancestorsOf(child, paneId, [...path, index]);
    if (below) return [{ split: node, path, index }, ...below];
  }
  return undefined;
}

/**
 * New sizes for a keyboard resize: the separator of the pane's nearest split on the arrow's axis
 * moves one step toward the arrow. It is the separator on the arrow's side of the pane, or, when the
 * pane is at that edge of its split, the one on the other side. The step is cut short so neither
 * neighbor drops under `MIN_PANEL_PERCENT`. Undefined when there is no such split or no room.
 */
export function keyboardResize(
  layout: LayoutNode,
  paneId: Id,
  direction: "left" | "right" | "up" | "down",
  step: number = RESIZE_STEP,
): { path: number[]; sizes: number[] } | undefined {
  const axis = direction === "left" || direction === "right" ? "row" : "column";
  const forward = direction === "right" || direction === "down";
  const owner = ancestorsOf(layout, paneId)
    ?.reverse()
    .find((entry) => entry.split.dir === axis);
  if (!owner) return undefined;
  const { split, path, index } = owner;
  // The separator sits between children `before` and `before + 1`.
  const last = split.children.length - 1;
  let before: number;
  if (forward) before = index < last ? index : index - 1;
  else before = index > 0 ? index - 1 : index;
  const left = split.sizes[before];
  const right = split.sizes[before + 1];
  if (left === undefined || right === undefined) return undefined;
  const room = forward ? right - MIN_PANEL_PERCENT : left - MIN_PANEL_PERCENT;
  const delta = Math.min(step, room);
  if (!(delta > 0)) return undefined;
  const sizes = [...split.sizes];
  sizes[before] = left + (forward ? delta : -delta);
  sizes[before + 1] = right + (forward ? -delta : delta);
  return { path, sizes };
}

/** True when the two lists differ by more than `tolerance` anywhere (or have another length). */
export function sizesDiffer(
  a: readonly number[],
  b: readonly number[],
  tolerance: number = SIZE_TOLERANCE,
): boolean {
  return (
    a.length !== b.length || a.some((size, index) => Math.abs(size - (b[index] ?? NaN)) > tolerance)
  );
}

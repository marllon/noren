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

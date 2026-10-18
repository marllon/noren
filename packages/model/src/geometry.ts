import type { Id, LayoutNode } from "./types";

// Where the panes of a layout sit on screen, from the split sizes alone (no DOM involved).

/** A pane's rectangle in percent of the item area: 0..100 on both axes. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Direction = "left" | "right" | "up" | "down";

/** Slack for the floating-point sums of the sizes. */
const EPSILON = 1e-6;

/** Rectangle of every pane of the layout, in layout order. */
export function layoutRects(layout: LayoutNode, area: Rect = { x: 0, y: 0, w: 100, h: 100 }) {
  const rects = new Map<Id, Rect>();
  const walk = (node: LayoutNode, rect: Rect): void => {
    if (node.kind === "pane") {
      rects.set(node.pane.id, rect);
      return;
    }
    let offset = 0;
    node.children.forEach((child, index) => {
      const share = ((node.sizes[index] ?? 0) / 100) * (node.dir === "row" ? rect.w : rect.h);
      walk(
        child,
        node.dir === "row"
          ? { x: rect.x + offset, y: rect.y, w: share, h: rect.h }
          : { x: rect.x, y: rect.y + offset, w: rect.w, h: share },
      );
      offset += share;
    });
  };
  walk(layout, area);
  return rects;
}

/**
 * The pane that sits next to `paneId` in the given direction: among the panes that start where it
 * ends and share some of its edge, the closest one, then the one sharing the most of the edge, then
 * the first in layout order. Undefined when nothing lies that way (focus does not wrap around) or
 * the pane is not in the layout.
 */
export function neighborPane(layout: LayoutNode, paneId: Id, direction: Direction): Id | undefined {
  const rects = layoutRects(layout);
  const from = rects.get(paneId);
  if (!from) return undefined;

  // Along the move (`near`/`far` edges) and across it (`start`/`end` of the shared edge).
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  const along = (r: Rect): [number, number] => (horizontal ? [r.x, r.x + r.w] : [r.y, r.y + r.h]);
  const across = (r: Rect): [number, number] => (horizontal ? [r.y, r.y + r.h] : [r.x, r.x + r.w]);

  const [fromStart, fromEnd] = along(from);
  const [fromCrossStart, fromCrossEnd] = across(from);

  let best: { id: Id; gap: number; overlap: number } | undefined;
  for (const [id, rect] of rects) {
    if (id === paneId) continue;
    const [start, end] = along(rect);
    const gap = forward ? start - fromEnd : fromStart - end;
    if (gap < -EPSILON) continue;
    const [crossStart, crossEnd] = across(rect);
    const overlap = Math.min(fromCrossEnd, crossEnd) - Math.max(fromCrossStart, crossStart);
    if (!(overlap > EPSILON)) continue;
    if (
      !best ||
      gap < best.gap - EPSILON ||
      (Math.abs(gap - best.gap) <= EPSILON && overlap > best.overlap + EPSILON)
    ) {
      best = { id, gap, overlap };
    }
  }
  return best?.id;
}

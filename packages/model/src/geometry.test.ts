import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { layoutRects, neighborPane, type Direction } from "./geometry";
import { arbWorkspace } from "./arbitraries";
import { layoutPanes } from "./sessions";
import { pane } from "./test-helpers";
import type { LayoutNode } from "./types";

const leaf = (id: string): LayoutNode => ({ kind: "pane", pane: pane(id) });
const split = (dir: "row" | "column", sizes: number[], ...children: LayoutNode[]): LayoutNode => ({
  kind: "split",
  dir,
  sizes,
  children,
});

const DIRECTIONS: Direction[] = ["left", "right", "up", "down"];

describe("layoutRects", () => {
  it("a single pane fills the area", () => {
    expect([...layoutRects(leaf("a"))]).toEqual([["a", { x: 0, y: 0, w: 100, h: 100 }]]);
  });

  it("a row lines the panes up left to right, a column top to bottom", () => {
    const row = layoutRects(split("row", [25, 75], leaf("a"), leaf("b")));
    expect(row.get("a")).toEqual({ x: 0, y: 0, w: 25, h: 100 });
    expect(row.get("b")).toEqual({ x: 25, y: 0, w: 75, h: 100 });
    const column = layoutRects(split("column", [40, 60], leaf("a"), leaf("b")));
    expect(column.get("a")).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(column.get("b")).toEqual({ x: 0, y: 40, w: 100, h: 60 });
  });

  it("nests: a split inside a split divides its parent's share", () => {
    const rects = layoutRects(
      split("row", [50, 50], leaf("a"), split("column", [30, 70], leaf("b"), leaf("c"))),
    );
    expect(rects.get("a")).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(rects.get("b")).toEqual({ x: 50, y: 0, w: 50, h: 30 });
    expect(rects.get("c")).toEqual({ x: 50, y: 30, w: 50, h: 70 });
  });

  it("comes out in layout order", () => {
    const layout = split(
      "row",
      [50, 50],
      split("column", [50, 50], leaf("a"), leaf("b")),
      leaf("c"),
    );
    expect([...layoutRects(layout).keys()]).toEqual(["a", "b", "c"]);
  });
});

describe("neighborPane", () => {
  // a | b over c in a 2x2 grid with unequal columns:   +----+------+
  //                                                    | a  |  b   |
  //                                                    +----+--+---+
  //                                                    | c     | d |
  //                                                    +-------+---+
  const grid = split(
    "column",
    [50, 50],
    split("row", [30, 70], leaf("a"), leaf("b")),
    split("row", [70, 30], leaf("c"), leaf("d")),
  );

  it("finds the pane across the edge", () => {
    expect(neighborPane(grid, "a", "right")).toBe("b");
    expect(neighborPane(grid, "b", "left")).toBe("a");
    expect(neighborPane(grid, "a", "down")).toBe("c");
    expect(neighborPane(grid, "d", "up")).toBe("b");
    expect(neighborPane(grid, "d", "left")).toBe("c");
  });

  it("among several neighbors takes the one sharing the most of the edge", () => {
    // Down from b (x 30..100): c covers 30..70 (40), d covers 70..100 (30).
    expect(neighborPane(grid, "b", "down")).toBe("c");
    // Up from c (x 0..70): a covers 0..30 (30), b covers 30..70 (40).
    expect(neighborPane(grid, "c", "up")).toBe("b");
  });

  it("on a tie takes the first in layout order", () => {
    const tie = split("row", [50, 50], leaf("a"), split("column", [50, 50], leaf("b"), leaf("c")));
    expect(neighborPane(tie, "a", "right")).toBe("b");
  });

  it("is undefined at the edge: focus does not wrap around", () => {
    expect(neighborPane(grid, "a", "left")).toBeUndefined();
    expect(neighborPane(grid, "a", "up")).toBeUndefined();
    expect(neighborPane(grid, "d", "right")).toBeUndefined();
    expect(neighborPane(grid, "d", "down")).toBeUndefined();
  });

  it("is undefined for a lone pane and for a pane that is not in the layout", () => {
    for (const direction of DIRECTIONS) {
      expect(neighborPane(leaf("a"), "a", direction)).toBeUndefined();
      expect(neighborPane(grid, "ghost", direction)).toBeUndefined();
    }
  });

  it("a diagonal pane is not a neighbor", () => {
    const diagonal = split(
      "row",
      [50, 50],
      split("column", [50, 50], leaf("a"), leaf("b")),
      split("column", [50, 50], leaf("c"), leaf("d")),
    );
    expect(neighborPane(diagonal, "a", "right")).toBe("c");
    expect(neighborPane(diagonal, "a", "down")).toBe("b");
    expect(neighborPane(diagonal, "d", "left")).toBe("b");
    expect(neighborPane(diagonal, "d", "up")).toBe("c");
  });

  it("property: moving one way and back lands on a pane that touches the start", () => {
    const opposite: Record<Direction, Direction> = {
      left: "right",
      right: "left",
      up: "down",
      down: "up",
    };
    fc.assert(
      fc.property(arbWorkspace(), (ws) => {
        for (const space of ws.spaces) {
          for (const item of Object.values(space.items)) {
            for (const start of layoutPanes(item.layout)) {
              for (const direction of DIRECTIONS) {
                const there = neighborPane(item.layout, start.id, direction);
                if (there === undefined) continue;
                expect(there).not.toBe(start.id);
                // The way back exists: the neighbor also has a neighbor on the opposite side.
                expect(neighborPane(item.layout, there, opposite[direction])).toBeDefined();
              }
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

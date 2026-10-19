import type { LayoutNode, Pane, SplitNode } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  childPanelId,
  keyboardResize,
  layoutToSizes,
  sizesDiffer,
  sizesToLayout,
  splitKey,
} from "./split-layout";

function pane(id: string): Pane {
  return { id, type: "terminal", profileId: "p", status: "running", unread: false, bell: false };
}

const leaf = (id: string): LayoutNode => ({ kind: "pane", pane: pane(id) });

function split(dir: "row" | "column", sizes: number[], ...children: LayoutNode[]): SplitNode {
  return { kind: "split", dir, sizes, children };
}

describe("childPanelId", () => {
  it("names a pane by its id and a nested split by its first pane", () => {
    expect(childPanelId(leaf("a"))).toBe("pane-a");
    expect(childPanelId(split("column", [50, 50], leaf("b"), leaf("c")))).toBe("split-b");
  });

  it("differs for every child of one split", () => {
    const node = split(
      "row",
      [20, 30, 50],
      leaf("a"),
      split("column", [50, 50], leaf("b"), leaf("c")),
      leaf("d"),
    );
    const ids = node.children.map(childPanelId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("splitKey", () => {
  it("changes with the direction, the children and their order", () => {
    const base = split("row", [50, 50], leaf("a"), leaf("b"));
    expect(splitKey(base)).toBe(splitKey(split("row", [30, 70], leaf("a"), leaf("b"))));
    expect(splitKey(base)).not.toBe(splitKey(split("column", [50, 50], leaf("a"), leaf("b"))));
    expect(splitKey(base)).not.toBe(splitKey(split("row", [50, 50], leaf("b"), leaf("a"))));
    expect(splitKey(base)).not.toBe(
      splitKey(split("row", [34, 33, 33], leaf("a"), leaf("b"), leaf("c"))),
    );
  });
});

describe("sizesToLayout and layoutToSizes", () => {
  const node = split("row", [20, 30, 50], leaf("a"), leaf("b"), leaf("c"));

  it("maps the sizes of the model to panel ids", () => {
    expect(sizesToLayout(node)).toEqual({ "pane-a": 20, "pane-b": 30, "pane-c": 50 });
  });

  it("reads the sizes back in child order, whatever the order of the map", () => {
    expect(layoutToSizes(node, { "pane-c": 50, "pane-a": 20, "pane-b": 30 })).toEqual([20, 30, 50]);
  });

  it("gives up when a panel is missing or a value is not a positive number", () => {
    expect(layoutToSizes(node, { "pane-a": 50, "pane-b": 50 })).toBeUndefined();
    expect(layoutToSizes(node, { "pane-a": 50, "pane-b": 0, "pane-c": 50 })).toBeUndefined();
    expect(
      layoutToSizes(node, { "pane-a": 50, "pane-b": Number.NaN, "pane-c": 50 }),
    ).toBeUndefined();
  });
});

describe("keyboardResize", () => {
  // a | (b over c): the root row splits 60/40, the right column 50/50.
  const nested = split("row", [60, 40], leaf("a"), split("column", [50, 50], leaf("b"), leaf("c")));

  it("moves the separator on the arrow's side of the pane", () => {
    expect(keyboardResize(nested, "a", "right")).toEqual({ path: [], sizes: [65, 35] });
    expect(keyboardResize(nested, "b", "down")).toEqual({ path: [1], sizes: [55, 45] });
  });

  it("moves the other separator when the pane is at that edge", () => {
    // `a` has no neighbor on its left: the separator still moves left, so `a` shrinks.
    expect(keyboardResize(nested, "a", "left")).toEqual({ path: [], sizes: [55, 45] });
    // `c` is the last child of its column: the separator above it moves up.
    expect(keyboardResize(nested, "c", "down")).toEqual({ path: [1], sizes: [55, 45] });
    expect(keyboardResize(nested, "c", "up")).toEqual({ path: [1], sizes: [45, 55] });
  });

  it("uses the nearest split on the axis of the arrow", () => {
    // `b` sits in the column; its horizontal arrows reach the root row.
    expect(keyboardResize(nested, "b", "left")).toEqual({ path: [], sizes: [55, 45] });
    expect(keyboardResize(nested, "b", "right")).toEqual({ path: [], sizes: [65, 35] });
    // `a` has no split on the vertical axis.
    expect(keyboardResize(nested, "a", "up")).toBeUndefined();
  });

  it("cuts the step short at the minimum and gives up without room", () => {
    const tight = split("row", [87, 13], leaf("a"), leaf("b"));
    expect(keyboardResize(tight, "a", "right")).toEqual({ path: [], sizes: [90, 10] });
    const full = split("row", [90, 10], leaf("a"), leaf("b"));
    expect(keyboardResize(full, "a", "right")).toBeUndefined();
    expect(keyboardResize(full, "a", "left")).toEqual({ path: [], sizes: [85, 15] });
  });

  it("is undefined for a single pane or a pane that is not there", () => {
    expect(keyboardResize(leaf("a"), "a", "right")).toBeUndefined();
    expect(keyboardResize(nested, "ghost", "right")).toBeUndefined();
  });

  it("keeps the sizes summing to 100", () => {
    const result = keyboardResize(
      split("row", [30, 30, 40], leaf("a"), leaf("b"), leaf("c")),
      "b",
      "right",
    );
    expect(result?.sizes).toEqual([30, 35, 35]);
  });
});

describe("sizesDiffer", () => {
  it("ignores differences under the tolerance", () => {
    expect(sizesDiffer([50, 50], [50.05, 49.95])).toBe(false);
    expect(sizesDiffer([50, 50], [51, 49])).toBe(true);
  });

  it("treats another length as different", () => {
    expect(sizesDiffer([50, 50], [100])).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  findPane,
  insertBeside,
  normalizeSizes,
  removePane,
  setSplitSizes,
  splitAt,
  splitPaths,
  swapPanes,
} from "./layout";
import { layoutPanes } from "./sessions";
import { deepFreeze, pane } from "./test-helpers";
import type { LayoutNode } from "./types";

const leaf = (id: string): LayoutNode => ({ kind: "pane", pane: pane(id) });
const split = (dir: "row" | "column", sizes: number[], ...children: LayoutNode[]): LayoutNode => ({
  kind: "split",
  dir,
  sizes,
  children,
});

function show(layout: LayoutNode): string {
  if (layout.kind === "pane") return layout.pane.id;
  return `${layout.dir}(${layout.children.map((c, i) => `${String(layout.sizes[i])}:${show(c)}`).join(" ")})`;
}

describe("normalizeSizes", () => {
  it("scales to 100", () => {
    expect(normalizeSizes([1, 3])).toEqual([25, 75]);
    expect(normalizeSizes([5])).toEqual([100]);
  });

  it("rejects empty, non-positive and non-finite input", () => {
    for (const sizes of [
      [],
      [0, 1],
      [-1, 2],
      [Number.NaN],
      [Infinity, 1],
      [Number.MIN_VALUE, Number.MAX_VALUE],
    ]) {
      expect(normalizeSizes(sizes)).toBeUndefined();
    }
  });
});

describe("insertBeside", () => {
  it("wraps a lone pane in a 50/50 split", () => {
    const layout = deepFreeze(leaf("a"));
    expect(show(must(insertBeside(layout, "a", "row", "after", leaf("b"))))).toBe("row(50:a 50:b)");
    expect(show(must(insertBeside(layout, "a", "column", "before", leaf("b"))))).toBe(
      "column(50:b 50:a)",
    );
  });

  it("adds a sibling in a split of the same direction", () => {
    const layout = deepFreeze(split("row", [40, 60], leaf("a"), leaf("b")));
    expect(show(must(insertBeside(layout, "a", "row", "after", leaf("c"))))).toBe(
      "row(20:a 20:c 60:b)",
    );
    expect(show(must(insertBeside(layout, "b", "row", "before", leaf("c"))))).toBe(
      "row(40:a 30:c 30:b)",
    );
  });

  it("is undefined for a pane that is not there", () => {
    expect(insertBeside(leaf("a"), "z", "row", "after", leaf("b"))).toBeUndefined();
    expect(
      insertBeside(split("row", [50, 50], leaf("a"), leaf("b")), "z", "row", "after", leaf("c")),
    ).toBeUndefined();
  });
});

describe("removePane", () => {
  it("collapses a split left with one child, at any depth", () => {
    const layout = deepFreeze(
      split("row", [50, 50], leaf("a"), split("column", [20, 80], leaf("b"), leaf("c"))),
    );
    expect(show(must(removePane(layout, "b")))).toBe("row(50:a 50:c)");
    expect(show(must(removePane(layout, "a")))).toBe("column(20:b 80:c)");
  });

  it("is undefined for a lone pane or a pane that is not there", () => {
    expect(removePane(leaf("a"), "a")).toBeUndefined();
    expect(removePane(split("row", [50, 50], leaf("a"), leaf("b")), "z")).toBeUndefined();
  });
});

describe("swapPanes", () => {
  it("trades the two panes and nothing else", () => {
    const layout = deepFreeze(
      split("row", [30, 70], leaf("a"), split("column", [50, 50], leaf("b"), leaf("c"))),
    );
    const a = must(findPane(layout, "a"));
    const c = must(findPane(layout, "c"));
    const swapped = swapPanes(layout, a, c);
    expect(show(swapped)).toBe("row(30:c 70:column(50:b 50:a))");
    expect(layoutPanes(swapped).map((p) => p.id)).toEqual(["c", "b", "a"]);
  });
});

describe("splitPaths, splitAt and setSplitSizes", () => {
  const layout = deepFreeze(
    split("row", [50, 50], leaf("a"), split("column", [30, 70], leaf("b"), leaf("c"))),
  );

  it("lists every split by its path, root first", () => {
    expect(splitPaths(layout)).toEqual([[], [1]]);
    expect(splitPaths(leaf("a"))).toEqual([]);
  });

  it("finds a split by path", () => {
    expect(splitAt(layout, [])).toBe(layout);
    expect(splitAt(layout, [1])?.dir).toBe("column");
    expect(splitAt(layout, [0])).toBeUndefined();
    expect(splitAt(layout, [2])).toBeUndefined();
    expect(splitAt(layout, [1, 0])).toBeUndefined();
  });

  it("replaces the sizes of one split and leaves the rest", () => {
    expect(show(must(setSplitSizes(layout, [1], [10, 90])))).toBe("row(50:a 50:column(10:b 90:c))");
    expect(show(must(setSplitSizes(layout, [], [20, 80])))).toBe("row(20:a 80:column(30:b 70:c))");
    expect(setSplitSizes(layout, [0], [1, 1])).toBeUndefined();
    expect(setSplitSizes(leaf("a"), [], [1])).toBeUndefined();
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

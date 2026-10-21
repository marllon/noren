import type { GroupNode } from "@noren/model";
import { describe, expect, it } from "vitest";
import type { TreeRow } from "./sidebar-tree";
import { buildNav, focusAfterRemoval, treeKeyAction } from "./tree-keys";
import type { NavEntry, SplitPanes } from "./tree-keys";

const group = (id: string, collapsed = false): GroupNode => ({
  kind: "group",
  id,
  name: id,
  color: "#fff",
  collapsed,
  children: [],
});
const groupRow = (id: string, depth: number, collapsed = false): TreeRow => ({
  kind: "group",
  group: group(id, collapsed),
  depth,
  count: 0,
});
const itemRow = (id: string, depth: number, pinned = false): TreeRow => ({
  kind: "item",
  id,
  depth,
  pinned,
});

/** pinned: P; tree: a, group G { b, group H { c }, d }, folded group F, split tab s (panes s1 s2), e */
const ROWS: TreeRow[] = [
  itemRow("P", 0, true),
  itemRow("a", 0),
  groupRow("G", 0),
  itemRow("b", 1),
  groupRow("H", 1),
  itemRow("c", 2),
  itemRow("d", 1),
  groupRow("F", 0, true),
  itemRow("s", 0),
  itemRow("e", 0),
];
const panes = (itemId: string): SplitPanes | undefined =>
  itemId === "s" ? { paneIds: ["s1", "s2"], expanded: true } : undefined;

const nav = buildNav(ROWS, panes);
const byKey = (key: string): NavEntry => {
  const entry = nav.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no row ${key}`);
  return entry;
};
const keys = (entries: readonly NavEntry[]) => entries.map((entry) => entry.key);

describe("buildNav", () => {
  it("lists the rows in the order shown, with the panes of an open split tab under it", () => {
    expect(keys(nav)).toEqual([
      "i:P",
      "i:a",
      "g:G",
      "i:b",
      "g:H",
      "i:c",
      "i:d",
      "g:F",
      "i:s",
      "p:s1",
      "p:s2",
      "i:e",
    ]);
  });

  it("gives each row its level, one more under a group or a split tab", () => {
    expect(nav.map((entry) => entry.level)).toEqual([1, 1, 1, 2, 2, 3, 2, 1, 1, 2, 2, 1]);
  });

  it("names the parent of a row: its group, its split tab, or nothing at the top", () => {
    expect(byKey("i:P").parentKey).toBeUndefined();
    expect(byKey("i:a").parentKey).toBeUndefined();
    expect(byKey("i:b").parentKey).toBe("g:G");
    expect(byKey("i:c").parentKey).toBe("g:H");
    expect(byKey("g:H").parentKey).toBe("g:G");
    expect(byKey("i:d").parentKey).toBe("g:G");
    expect(byKey("i:e").parentKey).toBeUndefined();
    expect(byKey("p:s2").parentKey).toBe("i:s");
  });

  it("marks groups and split tabs as expanded or not, and leaves plain tabs and panes out", () => {
    expect(byKey("g:G").expanded).toBe(true);
    expect(byKey("g:F").expanded).toBe(false);
    expect(byKey("i:s").expanded).toBe(true);
    expect(byKey("i:a").expanded).toBeUndefined();
    expect(byKey("p:s1").expanded).toBeUndefined();
  });

  it("counts the siblings of a row: pinned tabs apart from the tree, panes under their tab", () => {
    expect(byKey("i:P")).toMatchObject({ setSize: 1, posInSet: 1 });
    // Top of the tree: a, G, F, s, e.
    expect(byKey("i:a")).toMatchObject({ setSize: 5, posInSet: 1 });
    expect(byKey("g:F")).toMatchObject({ setSize: 5, posInSet: 3 });
    expect(byKey("i:e")).toMatchObject({ setSize: 5, posInSet: 5 });
    // Inside G: b, H, d.
    expect(byKey("g:H")).toMatchObject({ setSize: 3, posInSet: 2 });
    expect(byKey("i:d")).toMatchObject({ setSize: 3, posInSet: 3 });
    expect(byKey("i:c")).toMatchObject({ setSize: 1, posInSet: 1 });
    expect(byKey("p:s2")).toMatchObject({ setSize: 2, posInSet: 2 });
  });

  it("leaves the panes out of a folded split tab and marks it collapsed", () => {
    const folded = buildNav(ROWS, (id) =>
      id === "s" ? { paneIds: ["s1", "s2"], expanded: false } : undefined,
    );
    expect(keys(folded)).not.toContain("p:s1");
    expect(folded.find((entry) => entry.key === "i:s")?.expanded).toBe(false);
  });

  it("is empty for no rows", () => {
    expect(buildNav([], panes)).toEqual([]);
  });
});

describe("treeKeyAction", () => {
  const press = (current: string, key: string) => treeKeyAction(nav, current, key);

  it("moves the focus one row with Down and Up, and stays at the ends", () => {
    expect(press("i:a", "ArrowDown")).toEqual({ type: "focus", key: "g:G" });
    expect(press("g:G", "ArrowUp")).toEqual({ type: "focus", key: "i:a" });
    expect(press("i:e", "ArrowDown")).toBeUndefined();
    expect(press("i:P", "ArrowUp")).toBeUndefined();
  });

  it("goes through the panes of a split tab as rows of the tree", () => {
    expect(press("i:s", "ArrowDown")).toEqual({ type: "focus", key: "p:s1" });
    expect(press("p:s2", "ArrowDown")).toEqual({ type: "focus", key: "i:e" });
  });

  it("jumps to the first and the last row with Home and End", () => {
    expect(press("i:d", "Home")).toEqual({ type: "focus", key: "i:P" });
    expect(press("i:d", "End")).toEqual({ type: "focus", key: "i:e" });
  });

  it("unfolds a folded group with Right, and goes into an open one", () => {
    expect(press("g:F", "ArrowRight")).toEqual({ type: "expand", key: "g:F" });
    expect(press("g:G", "ArrowRight")).toEqual({ type: "focus", key: "i:b" });
    expect(press("i:s", "ArrowRight")).toEqual({ type: "focus", key: "p:s1" });
  });

  it("does nothing with Right on a row that cannot fold, or on an open group with no child", () => {
    expect(press("i:a", "ArrowRight")).toBeUndefined();
    expect(press("p:s1", "ArrowRight")).toBeUndefined();
    const empty = buildNav([groupRow("E", 0), itemRow("z", 0)], () => undefined);
    expect(treeKeyAction(empty, "g:E", "ArrowRight")).toBeUndefined();
  });

  it("folds an open group with Left, and goes to the parent from anything else", () => {
    expect(press("g:G", "ArrowLeft")).toEqual({ type: "collapse", key: "g:G" });
    expect(press("i:s", "ArrowLeft")).toEqual({ type: "collapse", key: "i:s" });
    expect(press("i:b", "ArrowLeft")).toEqual({ type: "focus", key: "g:G" });
    expect(press("i:c", "ArrowLeft")).toEqual({ type: "focus", key: "g:H" });
    expect(press("p:s2", "ArrowLeft")).toEqual({ type: "focus", key: "i:s" });
    expect(press("g:F", "ArrowLeft")).toBeUndefined();
    expect(press("i:a", "ArrowLeft")).toBeUndefined();
  });

  it("ignores other keys and a row that is not in the tree", () => {
    expect(press("i:a", "Enter")).toBeUndefined();
    expect(press("i:a", "F2")).toBeUndefined();
    expect(press("i:a", "x")).toBeUndefined();
    expect(press("i:gone", "ArrowDown")).toBeUndefined();
  });
});

describe("focusAfterRemoval", () => {
  it("goes to the row below the one that left", () => {
    expect(focusAfterRemoval(nav, "i:a", new Set(["i:a"]))).toBe("g:G");
  });

  it("goes to the row above when the last one left", () => {
    expect(focusAfterRemoval(nav, "i:e", new Set(["i:e"]))).toBe("p:s2");
  });

  it("skips every row that leaves together", () => {
    expect(focusAfterRemoval(nav, "i:a", new Set(["i:a", "g:G"]))).toBe("i:b");
    expect(focusAfterRemoval(nav, "i:e", new Set(["i:e", "i:s", "p:s1", "p:s2"]))).toBe("g:F");
  });

  it("is undefined when nothing stays or the row is unknown", () => {
    const only = buildNav([itemRow("a", 0)], () => undefined);
    expect(focusAfterRemoval(only, "i:a", new Set(["i:a"]))).toBeUndefined();
    expect(focusAfterRemoval(nav, "i:gone", new Set())).toBeUndefined();
  });
});

describe("the entries of a live group", () => {
  /** group L { entries e1 e2, tab t }, then tab z; a folded live group F with an entry. */
  const liveRows: TreeRow[] = [
    groupRow("L", 0),
    itemRow("t", 1),
    groupRow("F", 0, true),
    itemRow("z", 0),
  ];
  const liveOf = (groupId: string): string[] =>
    groupId === "L" ? ["e1", "e2"] : groupId === "F" ? ["f1"] : [];
  const withLive = buildNav(liveRows, () => undefined, liveOf);
  const at = (key: string): NavEntry => {
    const found = withLive.find((entry) => entry.key === key);
    if (!found) throw new Error(`no row ${key}`);
    return found;
  };

  it("puts them right after the group, before its tabs, and none under a folded group", () => {
    expect(keys(withLive)).toEqual(["g:L", "l:L:e1", "l:L:e2", "i:t", "g:F", "i:z"]);
    expect(at("l:L:e1")).toMatchObject({
      kind: "entry",
      id: "e1",
      level: 2,
      setSize: 2,
      posInSet: 1,
      parentKey: "g:L",
      expanded: undefined,
    });
    expect(at("l:L:e2")).toMatchObject({ posInSet: 2 });
  });

  it("leaves the numbering of the tabs as it was without them", () => {
    const without = buildNav(liveRows, () => undefined);
    const tabs = (entries: readonly NavEntry[]) =>
      entries.filter((entry) => entry.kind !== "entry");
    expect(tabs(withLive)).toEqual(tabs(without));
    expect(at("i:t")).toMatchObject({ setSize: 1, posInSet: 1, level: 2 });
  });

  it("draws no entry when the caller gives none", () => {
    expect(keys(buildNav(liveRows, () => undefined))).toEqual(["g:L", "i:t", "g:F", "i:z"]);
  });

  it("walks into them with the arrows and back to the group with Left", () => {
    const press = (current: string, key: string) => treeKeyAction(withLive, current, key);
    expect(press("g:L", "ArrowRight")).toEqual({ type: "focus", key: "l:L:e1" });
    expect(press("l:L:e1", "ArrowDown")).toEqual({ type: "focus", key: "l:L:e2" });
    expect(press("l:L:e2", "ArrowDown")).toEqual({ type: "focus", key: "i:t" });
    expect(press("l:L:e2", "ArrowLeft")).toEqual({ type: "focus", key: "g:L" });
    expect(press("l:L:e1", "ArrowRight")).toBeUndefined();
  });
});

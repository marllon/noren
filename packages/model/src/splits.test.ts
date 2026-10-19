import { describe, expect, it } from "vitest";
import type { Action, ReducerContext } from "./actions";
import { checkInvariants } from "./invariants";
import { reduce, reduceStrict } from "./reducer";
import { layoutPanes, liveSessionIds } from "./sessions";
import { applyChecked, deepFreeze, pane, testContext } from "./test-helpers";
import { treeItemIds } from "./tree";
import type { GroupNode, Id, Item, LayoutNode, Space, Workspace } from "./types";

const leaf = (id: string, sessionId?: string): LayoutNode => ({
  kind: "pane",
  pane: { ...pane(id, sessionId), cwd: `/work/${id}` },
});

const split = (dir: "row" | "column", sizes: number[], ...children: LayoutNode[]): LayoutNode => ({
  kind: "split",
  dir,
  sizes,
  children,
});

const item = (id: string, layout: LayoutNode, focusedPaneId: string): Item => ({
  id,
  titleLocked: false,
  layout,
  focusedPaneId,
  lastActivityAt: 0,
});

/**
 * s1 "Main": pinned [a]; tree [ group g { b }, c ]; s2 "Work": tree [ d ]. Every pane has a session.
 *   a: p1
 *   b: row 40/60 [p2, p3], focus p2
 *   c: row 50/50 [p4, column 30/70 [p5, p6]], focus p4
 *   d: p7
 * favorites [a, d]; nothing closed; s1 active.
 */
function fixture(): Workspace {
  const g: GroupNode = {
    kind: "group",
    id: "g",
    name: "group",
    color: "teal",
    collapsed: false,
    children: [{ kind: "item", id: "b" }],
  };
  const main: Space = {
    id: "s1",
    name: "Main",
    icon: "terminal",
    color: "#6b8afd",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: ["a"],
    tree: [g, { kind: "item", id: "c" }],
    items: {
      a: item("a", leaf("p1", "x1"), "p1"),
      b: item("b", split("row", [40, 60], leaf("p2", "x2"), leaf("p3", "x3")), "p2"),
      c: item(
        "c",
        split(
          "row",
          [50, 50],
          leaf("p4", "x4"),
          split("column", [30, 70], leaf("p5", "x5"), leaf("p6", "x6")),
        ),
        "p4",
      ),
    },
  };
  const work: Space = {
    id: "s2",
    name: "Work",
    icon: "folder",
    color: "teal",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: [],
    tree: [{ kind: "item", id: "d" }],
    items: { d: item("d", leaf("p7", "x7"), "p7") },
  };
  return {
    version: 2,
    spaces: [main, work],
    activeSpaceId: "s1",
    favorites: ["a", "d"],
    closed: [],
    archive: [],
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const itemOf = (ws: Workspace, id: Id): Item =>
  must(ws.spaces.flatMap((space) => Object.values(space.items)).find((it) => it.id === id));
const spaceOf = (ws: Workspace, id: Id): Space => must(ws.spaces.find((s) => s.id === id));
const hasItem = (ws: Workspace, id: Id): boolean =>
  ws.spaces.some((space) => Object.hasOwn(space.items, id));
const paneIds = (it: Item): Id[] => layoutPanes(it.layout).map((p) => p.id);

/** Layout as text: `p1`, `row(40:p2 60:p3)`; panes and nesting in order. */
function show(layout: LayoutNode): string {
  if (layout.kind === "pane") return layout.pane.id;
  const parts = layout.children.map((child, i) => `${String(layout.sizes[i])}:${show(child)}`);
  return `${layout.dir}(${parts.join(" ")})`;
}

const sessionsLost = (before: Workspace, after: Workspace): Id[] =>
  [...liveSessionIds(before)].filter((id) => !liveSessionIds(after).has(id)).sort();

/** Same action, the invalid way: the very same workspace comes back. */
function expectUnchanged(ws: Workspace, action: Action, ctx?: ReducerContext): void {
  const frozen = deepFreeze(ws);
  const { ctx: fresh } = testContext();
  expect(reduceStrict(frozen, action, ctx ?? fresh)).toBe(frozen);
  expect(reduce(frozen, action, ctx ?? fresh)).toBe(frozen);
}

const withMax = (maxPanes: number): ReducerContext => ({ ...testContext().ctx, maxPanes });

describe("split fixture", () => {
  it("is a valid workspace", () => {
    expect(checkInvariants(fixture())).toEqual([]);
  });
});

describe("pane/split", () => {
  it("splits a tab into two panes: the new one is after, focused and inherits profile and cwd", () => {
    const next = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "a",
      paneId: "p1",
      dir: "row",
      side: "after",
    });
    const a = itemOf(next, "a");
    expect(show(a.layout)).toBe("row(50:p1 50:n1)");
    expect(a.focusedPaneId).toBe("n1");
    const created = must(layoutPanes(a.layout)[1]);
    expect(created).toMatchObject({
      id: "n1",
      type: "terminal",
      profileId: "bash",
      cwd: "/work/p1",
      status: "idle",
      unread: false,
      bell: false,
    });
    // A fresh pane has no session yet: the app starts one.
    expect(created.sessionId).toBeUndefined();
    expect(sessionsLost(fixture(), next)).toEqual([]);
    // The item stays where it is.
    expect(spaceOf(next, "s1").pinned).toEqual(["a"]);
  });

  it("puts the new pane before when asked, in a column too", () => {
    const next = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "a",
      paneId: "p1",
      dir: "column",
      side: "before",
    });
    expect(show(itemOf(next, "a").layout)).toBe("column(50:n1 50:p1)");
  });

  it("takes the given profile and cwd instead of the split pane's", () => {
    const next = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "a",
      paneId: "p1",
      dir: "row",
      side: "after",
      profileId: "pwsh",
      cwd: "C:\\Projects",
    });
    expect(layoutPanes(itemOf(next, "a").layout)[1]).toMatchObject({
      profileId: "pwsh",
      cwd: "C:\\Projects",
    });
  });

  it("a blank cwd falls back to the split pane's; a blank profile is invalid", () => {
    const base = {
      type: "pane/split",
      itemId: "a",
      paneId: "p1",
      dir: "row",
      side: "after",
    } as const;
    const next = applyChecked(fixture(), { ...base, cwd: "  " });
    expect(layoutPanes(itemOf(next, "a").layout)[1]).toMatchObject({ cwd: "/work/p1" });
    expectUnchanged(fixture(), { ...base, profileId: "  " });
  });

  it("adds a sibling when the split has the same direction, taking half of that pane's size", () => {
    const next = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "b",
      paneId: "p2",
      dir: "row",
      side: "after",
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(20:p2 20:n1 60:p3)");
    const before = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "b",
      paneId: "p3",
      dir: "row",
      side: "before",
    });
    expect(show(itemOf(before, "b").layout)).toBe("row(40:p2 30:n1 30:p3)");
  });

  it("wraps the pane in a new split when the direction differs, keeping the other sizes", () => {
    const next = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "b",
      paneId: "p3",
      dir: "column",
      side: "after",
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(40:p2 60:column(50:p3 50:n1))");
  });

  it("splits a deep pane", () => {
    const next = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "c",
      paneId: "p5",
      dir: "column",
      side: "after",
    });
    expect(show(itemOf(next, "c").layout)).toBe("row(50:p4 50:column(15:p5 15:n1 70:p6))");
  });

  it("ends zoom, since the new pane takes focus", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p3" });
    expect(itemOf(zoomed, "b").zoomedPaneId).toBe("p3");
    const next = applyChecked(zoomed, {
      type: "pane/split",
      itemId: "b",
      paneId: "p3",
      dir: "row",
      side: "after",
    });
    expect(itemOf(next, "b").zoomedPaneId).toBeUndefined();
    expect("zoomedPaneId" in itemOf(next, "b")).toBe(false);
  });

  it("does not pass maxPanes (default 4): the same workspace comes back", () => {
    const four = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "c",
      paneId: "p4",
      dir: "column",
      side: "after",
    });
    expect(paneIds(itemOf(four, "c"))).toHaveLength(4);
    expectUnchanged(four, {
      type: "pane/split",
      itemId: "c",
      paneId: "p6",
      dir: "row",
      side: "after",
    });
  });

  it("respects a configured maxPanes", () => {
    const action: Action = {
      type: "pane/split",
      itemId: "b",
      paneId: "p2",
      dir: "row",
      side: "after",
    };
    expectUnchanged(fixture(), action, withMax(2));
    const three = reduceStrict(deepFreeze(fixture()), action, withMax(3));
    expect(paneIds(itemOf(three, "b"))).toHaveLength(3);
    expect(checkInvariants(three, { maxPanes: 3 })).toEqual([]);
    // A larger limit lets an item grow past 4.
    let grown = fixture();
    const ctx = withMax(6);
    for (let n = 0; n < 4; n++) {
      grown = reduceStrict(grown, { ...action, paneId: "p2" }, ctx);
    }
    expect(paneIds(itemOf(grown, "b"))).toHaveLength(6);
    expect(checkInvariants(grown, { maxPanes: 6 })).toEqual([]);
  });

  it("an invalid maxPanes falls back to the default", () => {
    const action: Action = {
      type: "pane/split",
      itemId: "b",
      paneId: "p2",
      dir: "row",
      side: "after",
    };
    for (const maxPanes of [0, -1, 2.5, Number.NaN]) {
      const next = reduceStrict(deepFreeze(fixture()), action, withMax(maxPanes));
      expect(paneIds(itemOf(next, "b"))).toHaveLength(3);
    }
  });

  it("is invalid for an unknown item or pane, a pane of another item, or a bad direction", () => {
    const base = {
      type: "pane/split",
      itemId: "b",
      paneId: "p2",
      dir: "row",
      side: "after",
    } as const;
    expectUnchanged(fixture(), { ...base, itemId: "ghost" });
    expectUnchanged(fixture(), { ...base, paneId: "ghost" });
    expectUnchanged(fixture(), { ...base, paneId: "p1" });
    expectUnchanged(fixture(), { ...base, dir: "diagonal" } as unknown as Action);
    expectUnchanged(fixture(), { ...base, side: "middle" } as unknown as Action);
  });

  it("does not collide with ids already used, closed items included", () => {
    const ws = fixture();
    ws.closed.push({ item: item("n1", leaf("n2"), "n2"), spaceId: "s1", closedAt: 1 });
    const next = applyChecked(ws, {
      type: "pane/split",
      itemId: "a",
      paneId: "p1",
      dir: "row",
      side: "after",
    });
    expect(itemOf(next, "a").focusedPaneId).toBe("n3");
  });
});

describe("pane/close", () => {
  it("collapses a split of two into the remaining pane", () => {
    const next = applyChecked(fixture(), { type: "pane/close", itemId: "b", paneId: "p3" });
    expect(show(itemOf(next, "b").layout)).toBe("p2");
    expect(itemOf(next, "b").focusedPaneId).toBe("p2");
    expect(sessionsLost(fixture(), next)).toEqual(["x3"]);
  });

  it("moves focus to the previous pane, or to the next one when it was the first", () => {
    const first = applyChecked(fixture(), { type: "pane/close", itemId: "b", paneId: "p2" });
    expect(itemOf(first, "b").focusedPaneId).toBe("p3");
    const last = applyChecked(
      applyChecked(fixture(), { type: "pane/focus", itemId: "b", paneId: "p3" }),
      { type: "pane/close", itemId: "b", paneId: "p3" },
    );
    expect(itemOf(last, "b").focusedPaneId).toBe("p2");
  });

  it("keeps focus when another pane is closed", () => {
    const next = applyChecked(fixture(), { type: "pane/close", itemId: "c", paneId: "p6" });
    expect(itemOf(next, "c").focusedPaneId).toBe("p4");
  });

  it("collapses a nested split into its remaining pane", () => {
    const next = applyChecked(fixture(), { type: "pane/close", itemId: "c", paneId: "p5" });
    expect(show(itemOf(next, "c").layout)).toBe("row(50:p4 50:p6)");
  });

  it("closing the first child lets a split take its place as the whole layout", () => {
    const next = applyChecked(fixture(), { type: "pane/close", itemId: "c", paneId: "p4" });
    expect(show(itemOf(next, "c").layout)).toBe("column(30:p5 70:p6)");
    expect(itemOf(next, "c").focusedPaneId).toBe("p5");
  });

  it("gives the freed space to the siblings in proportion", () => {
    const three = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "b",
      paneId: "p2",
      dir: "row",
      side: "after",
    });
    expect(show(itemOf(three, "b").layout)).toBe("row(20:p2 20:n1 60:p3)");
    const next = applyChecked(three, { type: "pane/close", itemId: "b", paneId: "n1" });
    expect(show(itemOf(next, "b").layout)).toBe("row(25:p2 75:p3)");
  });

  it("ends zoom when the zoomed pane closes, keeps it when another one does", () => {
    const four = applyChecked(
      applyChecked(fixture(), {
        type: "pane/split",
        itemId: "b",
        paneId: "p2",
        dir: "row",
        side: "after",
      }),
      { type: "pane/zoom", itemId: "b", paneId: "p3" },
    );
    expect(itemOf(four, "b").zoomedPaneId).toBe("p3");
    const other = applyChecked(four, { type: "pane/close", itemId: "b", paneId: "n1" });
    expect(itemOf(other, "b").zoomedPaneId).toBe("p3");
    const same = applyChecked(four, { type: "pane/close", itemId: "b", paneId: "p3" });
    expect("zoomedPaneId" in itemOf(same, "b")).toBe(false);
  });

  it("ends zoom when a single pane is left", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    const next = applyChecked(zoomed, { type: "pane/close", itemId: "b", paneId: "p3" });
    expect("zoomedPaneId" in itemOf(next, "b")).toBe(false);
  });

  it("closing the only pane is item/close", () => {
    const viaPane = applyChecked(fixture(), { type: "pane/close", itemId: "a", paneId: "p1" });
    const viaItem = applyChecked(fixture(), { type: "item/close", itemId: "a" });
    expect(viaPane).toEqual(viaItem);
    expect(hasItem(viaPane, "a")).toBe(false);
    expect(viaPane.closed.map((entry) => entry.item.id)).toEqual(["a"]);
    expect(sessionsLost(fixture(), viaPane)).toEqual(["x1"]);
    // The closed item keeps no session.
    expect(layoutPanes(must(viaPane.closed[0]).item.layout)[0]?.sessionId).toBeUndefined();
  });

  it("leaves no orphan session: only the closed pane's session goes", () => {
    const next = applyChecked(fixture(), { type: "pane/close", itemId: "c", paneId: "p5" });
    expect(sessionsLost(fixture(), next)).toEqual(["x5"]);
    const remaining = layoutPanes(itemOf(next, "c").layout).flatMap((p) => p.sessionId ?? []);
    expect(remaining).toEqual(["x4", "x6"]);
  });

  it("is invalid for an unknown item or pane", () => {
    expectUnchanged(fixture(), { type: "pane/close", itemId: "ghost", paneId: "p2" });
    expectUnchanged(fixture(), { type: "pane/close", itemId: "b", paneId: "ghost" });
    expectUnchanged(fixture(), { type: "pane/close", itemId: "b", paneId: "p1" });
  });
});

describe("pane/detach", () => {
  it("moves the pane, session included, to a new item right after the origin in its group", () => {
    const next = applyChecked(fixture(), { type: "pane/detach", itemId: "b", paneId: "p3" });
    expect(show(itemOf(next, "b").layout)).toBe("p2");
    const detached = itemOf(next, "n1");
    expect(show(detached.layout)).toBe("p3");
    expect(detached.focusedPaneId).toBe("p3");
    expect(detached.titleLocked).toBe(false);
    expect(detached.lastActivityAt).toBe(1000);
    expect(layoutPanes(detached.layout)[0]?.sessionId).toBe("x3");
    const group = must(spaceOf(next, "s1").tree[0]);
    expect(group.kind === "group" && group.children).toEqual([
      { kind: "item", id: "b" },
      { kind: "item", id: "n1" },
    ]);
    // Nothing is orphaned or ended: the session lives on in the new item.
    expect(sessionsLost(fixture(), next)).toEqual([]);
    expect(next.favorites).toEqual(["a", "d"]);
  });

  it("lands right after a top-level origin", () => {
    const next = applyChecked(fixture(), { type: "pane/detach", itemId: "c", paneId: "p6" });
    expect(treeItemIds(spaceOf(next, "s1").tree)).toEqual(["b", "c", "n1"]);
    expect(show(itemOf(next, "c").layout)).toBe("row(50:p4 50:p5)");
  });

  it("a pinned origin keeps its pin: the new item opens at the top of the tree", () => {
    const pinnedSplit = applyChecked(fixture(), {
      type: "pane/split",
      itemId: "a",
      paneId: "p1",
      dir: "row",
      side: "after",
    });
    const next = applyChecked(pinnedSplit, { type: "pane/detach", itemId: "a", paneId: "p1" });
    const space = spaceOf(next, "s1");
    expect(space.pinned).toEqual(["a"]);
    expect(treeItemIds(space.tree)).toEqual(["n2", "b", "c"]);
    expect(show(itemOf(next, "a").layout)).toBe("n1");
  });

  it("moves the origin's focus and ends its zoom when it was the detached pane", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    const next = applyChecked(zoomed, { type: "pane/detach", itemId: "b", paneId: "p2" });
    expect(itemOf(next, "b").focusedPaneId).toBe("p3");
    expect("zoomedPaneId" in itemOf(next, "b")).toBe(false);
  });

  it("is invalid for a tab with one pane, and for an unknown item or pane", () => {
    expectUnchanged(fixture(), { type: "pane/detach", itemId: "a", paneId: "p1" });
    expectUnchanged(fixture(), { type: "pane/detach", itemId: "ghost", paneId: "p1" });
    expectUnchanged(fixture(), { type: "pane/detach", itemId: "b", paneId: "ghost" });
  });
});

describe("item/join", () => {
  it("merges a tab beside a pane; the source item leaves the space and the favorites", () => {
    const next = applyChecked(fixture(), {
      type: "item/join",
      itemId: "a",
      targetItemId: "b",
      targetPaneId: "p3",
      dir: "row",
      side: "after",
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(40:p2 30:p3 30:p1)");
    expect(itemOf(next, "b").focusedPaneId).toBe("p1");
    expect(hasItem(next, "a")).toBe(false);
    expect(spaceOf(next, "s1").pinned).toEqual([]);
    expect(next.favorites).toEqual(["d"]);
    // Joining is not closing: nothing goes to the closed stack and no session ends.
    expect(next.closed).toEqual([]);
    expect(sessionsLost(fixture(), next)).toEqual([]);
    expect(liveSessionIds(next)).toEqual(liveSessionIds(fixture()));
  });

  it("wraps the target pane in a new split when the direction differs, on the chosen side", () => {
    const next = applyChecked(fixture(), {
      type: "item/join",
      itemId: "a",
      targetItemId: "b",
      targetPaneId: "p2",
      dir: "column",
      side: "before",
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(40:column(50:p1 50:p2) 60:p3)");
  });

  it("nests a whole split as one child, keeping its sizes and focus", () => {
    const focused = applyChecked(fixture(), { type: "pane/focus", itemId: "b", paneId: "p3" });
    const next = applyChecked(focused, {
      type: "item/join",
      itemId: "b",
      targetItemId: "a",
      targetPaneId: "p1",
      dir: "column",
      side: "after",
    });
    expect(show(itemOf(next, "a").layout)).toBe("column(50:p1 50:row(40:p2 60:p3))");
    expect(itemOf(next, "a").focusedPaneId).toBe("p3");
    expect(treeItemIds(spaceOf(next, "s1").tree)).toEqual(["c"]);
    expect(hasItem(next, "b")).toBe(false);
  });

  it("works across spaces", () => {
    const next = applyChecked(fixture(), {
      type: "item/join",
      itemId: "d",
      targetItemId: "b",
      targetPaneId: "p2",
      dir: "row",
      side: "before",
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(20:p7 20:p2 60:p3)");
    expect(spaceOf(next, "s2").tree).toEqual([]);
    expect(spaceOf(next, "s2").items).toEqual({});
    expect(next.favorites).toEqual(["a"]);
    expect(liveSessionIds(next)).toEqual(liveSessionIds(fixture()));
  });

  it("ends the target's zoom", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    const next = applyChecked(zoomed, {
      type: "item/join",
      itemId: "a",
      targetItemId: "b",
      targetPaneId: "p2",
      dir: "row",
      side: "after",
    });
    expect("zoomedPaneId" in itemOf(next, "b")).toBe(false);
  });

  it("does not pass maxPanes", () => {
    const action: Action = {
      type: "item/join",
      itemId: "c",
      targetItemId: "b",
      targetPaneId: "p2",
      dir: "row",
      side: "after",
    };
    // 3 + 2 panes against the default of 4.
    expectUnchanged(fixture(), action);
    expectUnchanged(fixture(), action, withMax(4));
    const next = reduceStrict(deepFreeze(fixture()), action, withMax(5));
    expect(paneIds(itemOf(next, "b"))).toEqual(["p2", "p4", "p5", "p6", "p3"]);
    expect(checkInvariants(next, { maxPanes: 5 })).toEqual([]);
  });

  it("is invalid for itself, unknown items or panes, and a bad direction", () => {
    const base = {
      type: "item/join",
      itemId: "a",
      targetItemId: "b",
      targetPaneId: "p2",
      dir: "row",
      side: "after",
    } as const;
    expectUnchanged(fixture(), { ...base, targetItemId: "a", targetPaneId: "p1" });
    expectUnchanged(fixture(), { ...base, itemId: "ghost" });
    expectUnchanged(fixture(), { ...base, targetItemId: "ghost" });
    expectUnchanged(fixture(), { ...base, targetPaneId: "ghost" });
    expectUnchanged(fixture(), { ...base, targetPaneId: "p1" });
    expectUnchanged(fixture(), { ...base, dir: "x" } as unknown as Action);
    expectUnchanged(fixture(), { ...base, side: "x" } as unknown as Action);
  });
});

describe("pane/resize", () => {
  it("normalizes the sizes to 100", () => {
    const next = applyChecked(fixture(), {
      type: "pane/resize",
      itemId: "b",
      path: [],
      sizes: [1, 3],
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(25:p2 75:p3)");
    const arbitrary = applyChecked(fixture(), {
      type: "pane/resize",
      itemId: "b",
      path: [],
      sizes: [30, 30],
    });
    expect(show(itemOf(arbitrary, "b").layout)).toBe("row(50:p2 50:p3)");
  });

  it("resizes a nested split by its path and leaves the others alone", () => {
    const next = applyChecked(fixture(), {
      type: "pane/resize",
      itemId: "c",
      path: [1],
      sizes: [60, 20],
    });
    expect(show(itemOf(next, "c").layout)).toBe("row(50:p4 50:column(75:p5 25:p6))");
  });

  it("keeps panes, focus and sessions", () => {
    const next = applyChecked(fixture(), {
      type: "pane/resize",
      itemId: "b",
      path: [],
      sizes: [70, 30],
    });
    expect(paneIds(itemOf(next, "b"))).toEqual(["p2", "p3"]);
    expect(itemOf(next, "b").focusedPaneId).toBe("p2");
    expect(sessionsLost(fixture(), next)).toEqual([]);
  });

  it("is invalid for the wrong count, non-positive or non-finite sizes, and a bad path", () => {
    const base: Extract<Action, { type: "pane/resize" }> = {
      type: "pane/resize",
      itemId: "b",
      path: [],
      sizes: [1, 1],
    };
    expectUnchanged(fixture(), { ...base, sizes: [1] });
    expectUnchanged(fixture(), { ...base, sizes: [1, 1, 1] });
    expectUnchanged(fixture(), { ...base, sizes: [0, 1] });
    expectUnchanged(fixture(), { ...base, sizes: [-1, 2] });
    expectUnchanged(fixture(), { ...base, sizes: [Number.NaN, 1] });
    expectUnchanged(fixture(), { ...base, sizes: [Infinity, 1] });
    expectUnchanged(fixture(), { ...base, sizes: [Number.MIN_VALUE, Number.MAX_VALUE] });
    expectUnchanged(fixture(), { ...base, path: [0] }); // a pane, not a split
    expectUnchanged(fixture(), { ...base, path: [5] });
    expectUnchanged(fixture(), { ...base, path: [-1] });
    expectUnchanged(fixture(), { ...base, path: [0.5] });
    expectUnchanged(fixture(), { ...base, itemId: "a", sizes: [1] }); // a tab has no split
    expectUnchanged(fixture(), { ...base, itemId: "ghost" });
    expectUnchanged(fixture(), { ...base, path: "x" } as unknown as Action);
  });

  it("the same proportions change nothing", () => {
    expectUnchanged(fixture(), { type: "pane/resize", itemId: "b", path: [], sizes: [40, 60] });
    expectUnchanged(fixture(), { type: "pane/resize", itemId: "b", path: [], sizes: [2, 3] });
  });
});

describe("pane/zoom", () => {
  it("zooms a pane and focuses it, then toggles back", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p3" });
    expect(itemOf(zoomed, "b")).toMatchObject({ zoomedPaneId: "p3", focusedPaneId: "p3" });
    // Same pane again, or no pane at all: back to the layout.
    const back = applyChecked(zoomed, { type: "pane/zoom", itemId: "b", paneId: "p3" });
    expect("zoomedPaneId" in itemOf(back, "b")).toBe(false);
    const viaDefault = applyChecked(zoomed, { type: "pane/zoom", itemId: "b" });
    expect(viaDefault).toEqual(back);
    // The layout itself is untouched.
    expect(show(itemOf(back, "b").layout)).toBe("row(40:p2 60:p3)");
  });

  it("zooms the focused pane by default", () => {
    const next = applyChecked(fixture(), { type: "pane/zoom", itemId: "c" });
    expect(itemOf(next, "c").zoomedPaneId).toBe("p4");
  });

  it("zooming another pane moves the zoom", () => {
    const first = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    const next = applyChecked(first, { type: "pane/zoom", itemId: "b", paneId: "p3" });
    expect(itemOf(next, "b")).toMatchObject({ zoomedPaneId: "p3", focusedPaneId: "p3" });
  });

  it("is invalid for a tab with one pane, and for an unknown item or pane", () => {
    expectUnchanged(fixture(), { type: "pane/zoom", itemId: "a" });
    expectUnchanged(fixture(), { type: "pane/zoom", itemId: "a", paneId: "p1" });
    expectUnchanged(fixture(), { type: "pane/zoom", itemId: "ghost" });
    expectUnchanged(fixture(), { type: "pane/zoom", itemId: "b", paneId: "ghost" });
    expectUnchanged(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p1" });
  });
});

describe("pane/swap", () => {
  it("trades two panes; the sizes stay with the positions", () => {
    const next = applyChecked(fixture(), {
      type: "pane/swap",
      itemId: "b",
      paneId: "p2",
      otherPaneId: "p3",
    });
    expect(show(itemOf(next, "b").layout)).toBe("row(40:p3 60:p2)");
    // Focus follows the pane, not the position.
    expect(itemOf(next, "b").focusedPaneId).toBe("p2");
    expect(sessionsLost(fixture(), next)).toEqual([]);
    // The panes keep their sessions.
    expect(layoutPanes(itemOf(next, "b").layout).map((p) => p.sessionId)).toEqual(["x3", "x2"]);
  });

  it("swaps panes at different depths", () => {
    const next = applyChecked(fixture(), {
      type: "pane/swap",
      itemId: "c",
      paneId: "p4",
      otherPaneId: "p6",
    });
    expect(show(itemOf(next, "c").layout)).toBe("row(50:p6 50:column(30:p5 70:p4))");
  });

  it("keeps the zoom on the pane that was zoomed", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p3" });
    const next = applyChecked(zoomed, {
      type: "pane/swap",
      itemId: "b",
      paneId: "p2",
      otherPaneId: "p3",
    });
    expect(itemOf(next, "b").zoomedPaneId).toBe("p3");
  });

  it("is invalid for the same pane, unknown panes, panes of another item, or an unknown item", () => {
    expectUnchanged(fixture(), { type: "pane/swap", itemId: "b", paneId: "p2", otherPaneId: "p2" });
    expectUnchanged(fixture(), { type: "pane/swap", itemId: "b", paneId: "p2", otherPaneId: "x" });
    expectUnchanged(fixture(), { type: "pane/swap", itemId: "b", paneId: "x", otherPaneId: "p2" });
    expectUnchanged(fixture(), { type: "pane/swap", itemId: "b", paneId: "p2", otherPaneId: "p1" });
    expectUnchanged(fixture(), {
      type: "pane/swap",
      itemId: "ghost",
      paneId: "p2",
      otherPaneId: "p3",
    });
  });
});

describe("pane/focus", () => {
  it("focuses a pane", () => {
    const next = applyChecked(fixture(), { type: "pane/focus", itemId: "b", paneId: "p3" });
    expect(itemOf(next, "b").focusedPaneId).toBe("p3");
  });

  it("brings the layout back when another pane is focused under zoom", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    const next = applyChecked(zoomed, { type: "pane/focus", itemId: "b", paneId: "p3" });
    expect(itemOf(next, "b").focusedPaneId).toBe("p3");
    expect("zoomedPaneId" in itemOf(next, "b")).toBe(false);
  });

  it("changes nothing when the pane is already focused (and the zoomed one)", () => {
    expectUnchanged(fixture(), { type: "pane/focus", itemId: "b", paneId: "p2" });
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    expectUnchanged(zoomed, { type: "pane/focus", itemId: "b", paneId: "p2" });
  });

  it("is invalid for an unknown item or pane", () => {
    expectUnchanged(fixture(), { type: "pane/focus", itemId: "ghost", paneId: "p2" });
    expectUnchanged(fixture(), { type: "pane/focus", itemId: "b", paneId: "ghost" });
    expectUnchanged(fixture(), { type: "pane/focus", itemId: "b", paneId: "p1" });
  });
});

describe("pane/focus-direction", () => {
  const move = (ws: Workspace, itemId: Id, direction: "left" | "right" | "up" | "down") =>
    applyChecked(ws, { type: "pane/focus-direction", itemId, direction });

  it("moves focus by the geometry of the layout", () => {
    const right = move(fixture(), "b", "right");
    expect(itemOf(right, "b").focusedPaneId).toBe("p3");
    expect(itemOf(move(right, "b", "left"), "b").focusedPaneId).toBe("p2");
  });

  it("prefers the neighbor that shares the most of the edge", () => {
    // From p4 (the full left half) to the right: p6 covers 70% of the edge, p5 only 30%.
    const toP6 = move(fixture(), "c", "right");
    expect(itemOf(toP6, "c").focusedPaneId).toBe("p6");
    expect(itemOf(move(toP6, "c", "up"), "c").focusedPaneId).toBe("p5");
    expect(itemOf(move(move(toP6, "c", "up"), "c", "down"), "c").focusedPaneId).toBe("p6");
    expect(itemOf(move(toP6, "c", "left"), "c").focusedPaneId).toBe("p4");
  });

  it("does nothing at an edge (no wrap-around) or across the wrong axis", () => {
    const pFirst = { type: "pane/focus-direction", itemId: "b" } as const;
    expectUnchanged(fixture(), { ...pFirst, direction: "left" });
    expectUnchanged(fixture(), { ...pFirst, direction: "up" });
    expectUnchanged(fixture(), { ...pFirst, direction: "down" });
    expectUnchanged(fixture(), { type: "pane/focus-direction", itemId: "a", direction: "right" });
  });

  it("brings the layout back from zoom", () => {
    const zoomed = applyChecked(fixture(), { type: "pane/zoom", itemId: "b", paneId: "p2" });
    const next = move(zoomed, "b", "right");
    expect(itemOf(next, "b").focusedPaneId).toBe("p3");
    expect("zoomedPaneId" in itemOf(next, "b")).toBe(false);
  });

  it("is invalid for an unknown item or direction", () => {
    expectUnchanged(fixture(), {
      type: "pane/focus-direction",
      itemId: "ghost",
      direction: "left",
    });
    expectUnchanged(fixture(), {
      type: "pane/focus-direction",
      itemId: "b",
      direction: "north",
    } as unknown as Action);
  });
});

describe("splits and sessions", () => {
  it("a sequence of splits and closes ends exactly the sessions of the panes closed", () => {
    let ws = fixture();
    const start = fixture();
    const steps: Action[] = [
      { type: "pane/split", itemId: "a", paneId: "p1", dir: "row", side: "after" },
      { type: "pane/split", itemId: "a", paneId: "n1", dir: "column", side: "after" },
      { type: "pane/close", itemId: "c", paneId: "p4" },
      { type: "pane/detach", itemId: "b", paneId: "p2" },
      {
        type: "item/join",
        itemId: "d",
        targetItemId: "a",
        targetPaneId: "n2",
        dir: "row",
        side: "after",
      },
      { type: "pane/close", itemId: "a", paneId: "p1" },
    ];
    const { ctx } = testContext();
    for (const step of steps) {
      ws = reduceStrict(deepFreeze(ws), step, ctx);
      expect(checkInvariants(ws)).toEqual([]);
    }
    expect(sessionsLost(start, ws)).toEqual(["x1", "x4"]);
    expect([...liveSessionIds(ws)].sort()).toEqual(["x2", "x3", "x5", "x6", "x7"]);
  });
});

describe("pane/set-status", () => {
  const paneOf = (ws: Workspace, itemId: Id, paneId: Id) =>
    must(layoutPanes(itemOf(ws, itemId).layout).find((p) => p.id === paneId));

  it("marks the pane as exited with its code, leaving the other panes and the sessions alone", () => {
    const next = applyChecked(fixture(), {
      type: "pane/set-status",
      itemId: "b",
      paneId: "p3",
      status: "exited",
      exitCode: 2,
    });
    expect(paneOf(next, "b", "p3")).toMatchObject({
      status: "exited",
      exitCode: 2,
      sessionId: "x3",
    });
    expect(paneOf(next, "b", "p2")).toEqual(paneOf(fixture(), "b", "p2"));
    expect(show(itemOf(next, "b").layout)).toBe("row(40:p2 60:p3)");
    expect(sessionsLost(fixture(), next)).toEqual([]);
  });

  it("a zero code is kept", () => {
    const next = applyChecked(fixture(), {
      type: "pane/set-status",
      itemId: "a",
      paneId: "p1",
      status: "exited",
      exitCode: 0,
    });
    expect(paneOf(next, "a", "p1").exitCode).toBe(0);
  });

  it("drops the code when the status is not exited", () => {
    const exited = applyChecked(fixture(), {
      type: "pane/set-status",
      itemId: "a",
      paneId: "p1",
      status: "exited",
      exitCode: 2,
    });
    const running = applyChecked(exited, {
      type: "pane/set-status",
      itemId: "a",
      paneId: "p1",
      status: "running",
      exitCode: 5,
    });
    expect(paneOf(running, "a", "p1").status).toBe("running");
    expect(paneOf(running, "a", "p1")).not.toHaveProperty("exitCode");
  });

  it("changes nothing when the pane is unknown or the value is the same", () => {
    const base = { type: "pane/set-status", status: "running" } as const;
    expectUnchanged(fixture(), { ...base, itemId: "ghost", paneId: "p1" });
    expectUnchanged(fixture(), { ...base, itemId: "a", paneId: "ghost" });
    // p1 of another item.
    expectUnchanged(fixture(), { ...base, itemId: "b", paneId: "p1" });
    // Already running (the status of the test panes).
    expectUnchanged(fixture(), { ...base, itemId: "a", paneId: "p1" });
    expectUnchanged(fixture(), {
      type: "pane/set-status",
      itemId: "a",
      paneId: "p1",
      status: "bogus",
    } as unknown as Action);
  });
});

describe("pane/set-location", () => {
  const paneOf = (ws: Workspace, itemId: Id, paneId: Id) =>
    must(layoutPanes(itemOf(ws, itemId).layout).find((p) => p.id === paneId));
  const move = (itemId: Id, paneId: Id, cwd: string | undefined, gitBranch?: string): Action => ({
    type: "pane/set-location",
    itemId,
    paneId,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(gitBranch !== undefined ? { gitBranch } : {}),
  });

  it("sets the folder and the branch of the pane, leaving the other panes and the sessions alone", () => {
    const next = applyChecked(fixture(), move("b", "p3", "/proj", "main"));
    expect(paneOf(next, "b", "p3")).toMatchObject({
      cwd: "/proj",
      gitBranch: "main",
      sessionId: "x3",
      status: "running",
    });
    expect(paneOf(next, "b", "p2")).toEqual(paneOf(fixture(), "b", "p2"));
    expect(show(itemOf(next, "b").layout)).toBe("row(40:p2 60:p3)");
    expect(sessionsLost(fixture(), next)).toEqual([]);
  });

  it("moving out of a repository clears the branch and keeps the new folder", () => {
    const inRepo = applyChecked(fixture(), move("a", "p1", "/proj", "main"));
    const out = applyChecked(inRepo, move("a", "p1", "/tmp"));
    expect(paneOf(out, "a", "p1").cwd).toBe("/tmp");
    expect(paneOf(out, "a", "p1")).not.toHaveProperty("gitBranch");
  });

  it("a new folder without a branch does not keep the branch of the old one", () => {
    const inRepo = applyChecked(fixture(), move("a", "p1", "/proj", "main"));
    const other = applyChecked(inRepo, move("a", "p1", "/elsewhere"));
    expect(paneOf(other, "a", "p1")).not.toHaveProperty("gitBranch");
  });

  it("a branch change in the same folder is a change", () => {
    const first = applyChecked(fixture(), move("a", "p1", "/proj", "main"));
    const second = applyChecked(first, move("a", "p1", "/proj", "feature/x"));
    expect(paneOf(second, "a", "p1")).toMatchObject({ cwd: "/proj", gitBranch: "feature/x" });
  });

  it("is a no-op when the pane already has the folder and the branch", () => {
    const first = applyChecked(fixture(), move("a", "p1", "/proj", "main"));
    expect(reduce(first, move("a", "p1", "/proj", "main"), testContext().ctx)).toBe(first);
    const bare = applyChecked(fixture(), move("a", "p1", "/proj"));
    expect(reduce(bare, move("a", "p1", "/proj"), testContext().ctx)).toBe(bare);
  });

  it("does not touch the item's other fields, the status or the activity time", () => {
    const next = applyChecked(fixture(), move("a", "p1", "/proj", "main"));
    const before = itemOf(fixture(), "a");
    const after = itemOf(next, "a");
    expect({ ...after, layout: undefined }).toEqual({ ...before, layout: undefined });
    expect(paneOf(next, "a", "p1").status).toBe(paneOf(fixture(), "a", "p1").status);
  });

  it("changes nothing when the pane is unknown or the folder is blank", () => {
    expectUnchanged(fixture(), move("ghost", "p1", "/proj", "main"));
    expectUnchanged(fixture(), move("a", "ghost", "/proj", "main"));
    // p1 belongs to another item.
    expectUnchanged(fixture(), move("b", "p1", "/proj", "main"));
    expectUnchanged(fixture(), move("a", "p1", ""));
    expectUnchanged(fixture(), move("a", "p1", "   ", "main"));
    expectUnchanged(fixture(), {
      type: "pane/set-location",
      itemId: "a",
      paneId: "p1",
      cwd: 7,
    } as unknown as Action);
    expectUnchanged(fixture(), {
      type: "pane/set-location",
      itemId: "a",
      paneId: "p1",
      cwd: "/proj",
      gitBranch: 7,
    } as unknown as Action);
  });

  it("without a folder it keeps the pane's own folder, and sets or clears only the branch", () => {
    const start = applyChecked(fixture(), move("a", "p1", "/proj"));
    const branched = applyChecked(start, move("a", "p1", undefined, "main"));
    expect(paneOf(branched, "a", "p1")).toMatchObject({ cwd: "/proj", gitBranch: "main" });
    const cleared = applyChecked(branched, move("a", "p1", undefined));
    expect(paneOf(cleared, "a", "p1").cwd).toBe("/proj");
    expect(paneOf(cleared, "a", "p1")).not.toHaveProperty("gitBranch");
  });

  it("without a folder, a pane that has none stays without one", () => {
    const created = applyChecked(fixture(), { type: "item/create", spaceId: "s1" });
    const space = must(created.spaces.find((s) => s.id === "s1"));
    const fresh = must(space.items[must(space.activeItemId)]);
    const freshPane = must(layoutPanes(fresh.layout)[0]);
    expect(freshPane).not.toHaveProperty("cwd");

    const next = applyChecked(created, move(fresh.id, freshPane.id, undefined, "dev"));
    expect(paneOf(next, fresh.id, freshPane.id)).toMatchObject({ gitBranch: "dev" });
    expect(paneOf(next, fresh.id, freshPane.id)).not.toHaveProperty("cwd");
  });

  it("without a folder and without a branch on a pane that has no branch changes nothing", () => {
    expectUnchanged(fixture(), move("a", "p1", undefined));
  });

  it("a blank branch counts as none", () => {
    const next = applyChecked(fixture(), move("a", "p1", "/proj", "   "));
    expect(paneOf(next, "a", "p1").cwd).toBe("/proj");
    expect(paneOf(next, "a", "p1")).not.toHaveProperty("gitBranch");
  });

  it("does not trim the folder, like the other paths of the model", () => {
    const next = applyChecked(fixture(), move("a", "p1", "/with space/ ", "main"));
    expect(paneOf(next, "a", "p1").cwd).toBe("/with space/ ");
  });
});

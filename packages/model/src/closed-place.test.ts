import { describe, expect, it } from "vitest";
import type { ReducerContext } from "./actions";
import { createEmptySpace, createPane, createTab } from "./factories";
import { reduce } from "./reducer";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import { treeItemIds } from "./tree";
import {
  MAX_CLOSED,
  type ClosedItem,
  type Id,
  type Item,
  type Node,
  type Workspace,
} from "./types";

// Closing an item records where it sat; reopening puts it back there when the slot still exists.

const tab = (id: string, cwd = "/home"): Item =>
  createTab(id, createPane(`p-${id}`, "bash", cwd), 5);

/**
 * s1 "Main": pinned [a, b]; tree [ c, g1 { d, e, g2 { f } }, h ]
 * s2 "Work": tree [ w1, w2 ]; s1 is active.
 */
function fixture(): Workspace {
  const main = createEmptySpace("s1", "Main", { cwd: "/main" });
  const work = createEmptySpace("s2", "Work");
  const g2: Node = {
    kind: "group",
    id: "g2",
    name: "inner",
    color: "red",
    collapsed: false,
    children: [{ kind: "item", id: "f" }],
  };
  const g1: Node = {
    kind: "group",
    id: "g1",
    name: "outer",
    color: "teal",
    collapsed: false,
    children: [{ kind: "item", id: "d" }, { kind: "item", id: "e" }, g2],
  };
  const ids = ["a", "b", "c", "d", "e", "f", "h"];
  return {
    version: 2,
    spaces: [
      {
        ...main,
        pinned: ["a", "b"],
        tree: [{ kind: "item", id: "c" }, g1, { kind: "item", id: "h" }],
        items: Object.fromEntries(ids.map((id) => [id, tab(id)])),
        activeItemId: "c",
      },
      {
        ...work,
        tree: [
          { kind: "item", id: "w1" },
          { kind: "item", id: "w2" },
        ],
        items: { w1: tab("w1"), w2: tab("w2") },
        activeItemId: "w1",
      },
    ],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  };
}

const shape = (nodes: readonly Node[]): unknown[] =>
  nodes.map((node) => (node.kind === "item" ? node.id : { [node.id]: shape(node.children) }));

const space = (ws: Workspace, id: Id) => {
  const found = ws.spaces.find((s) => s.id === id);
  if (!found) throw new Error(`no space ${id}`);
  return found;
};

const close = (ws: Workspace, itemId: Id, ctx: ReducerContext = testContext().ctx): Workspace =>
  applyChecked(ws, { type: "item/close", itemId }, ctx);
const reopen = (ws: Workspace, itemId?: Id, ctx: ReducerContext = testContext().ctx): Workspace =>
  applyChecked(ws, { type: "item/reopen", ...(itemId !== undefined ? { itemId } : {}) }, ctx);

describe("closing an item records where it sat", () => {
  it("a tree item at the top level: no group and its position", () => {
    const next = close(fixture(), "h");
    expect(next.closed.at(-1)?.place).toEqual({ list: "tree", index: 2 });
  });

  it("an item in a group: the group and the position inside it", () => {
    const next = close(fixture(), "e");
    expect(next.closed.at(-1)?.place).toEqual({ list: "tree", groupId: "g1", index: 1 });
    const inner = close(fixture(), "f");
    expect(inner.closed.at(-1)?.place).toEqual({ list: "tree", groupId: "g2", index: 0 });
  });

  it("a pinned item: the position among the pinned", () => {
    const next = close(fixture(), "b");
    expect(next.closed.at(-1)?.place).toEqual({ list: "pinned", index: 1 });
  });

  it("an item that closes with its space has no place", () => {
    const next = applyChecked(
      fixture(),
      { type: "space/delete", spaceId: "s2", items: { mode: "close" } },
      testContext().ctx,
    );
    expect(next.closed).toHaveLength(2);
    for (const entry of next.closed) expect(entry).not.toHaveProperty("place");
  });
});

describe("reopening puts the item back where it was", () => {
  it("at the top level of the tree, between its old neighbors", () => {
    const closed = close(fixture(), "c");
    expect(shape(space(closed, "s1").tree)[0]).toEqual({ g1: expect.anything() as unknown });
    const back = reopen(closed);
    expect(shape(space(back, "s1").tree)).toEqual(shape(fixture().spaces[0]?.tree ?? []));
    expect(back.closed).toEqual([]);
  });

  it("in its group, at its position, also a group nested one level down", () => {
    for (const id of ["d", "e", "f"]) {
      const back = reopen(close(fixture(), id));
      expect(shape(space(back, "s1").tree)).toEqual(shape(fixture().spaces[0]?.tree ?? []));
    }
  });

  it("among the pinned items, at its position, keeping the origin it had", () => {
    const ws = fixture();
    const pinnedB: Item = { ...tab("b", "/b"), origin: { cwd: "/b", profileId: "bash" } };
    const withOrigin: Workspace = {
      ...ws,
      spaces: ws.spaces.map((s) =>
        s.id === "s1" ? { ...s, items: { ...s.items, b: pinnedB } } : s,
      ),
    };
    const back = reopen(close(withOrigin, "a"));
    expect(space(back, "s1").pinned).toEqual(["a", "b"]);
    const closedB = close(withOrigin, "b");
    const backB = reopen(closedB);
    expect(space(backB, "s1").pinned).toEqual(["a", "b"]);
    expect(space(backB, "s1").items["b"]?.origin).toEqual({ cwd: "/b", profileId: "bash" });
    expect(treeItemIds(space(backB, "s1").tree)).not.toContain("b");
  });

  it("a pinned item that had no origin gets one from its pane", () => {
    const ws = fixture();
    const entry: ClosedItem = {
      item: tab("z", "/zed"),
      spaceId: "s1",
      closedAt: 1,
      place: { list: "pinned", index: 0 },
    };
    const back = reopen({ ...ws, closed: [entry] });
    expect(space(back, "s1").pinned).toEqual(["z", "a", "b"]);
    expect(space(back, "s1").items["z"]?.origin).toEqual({ cwd: "/zed", profileId: "bash" });
  });

  it("the same space even when another one is active", () => {
    const closed = close(fixture(), "w2");
    const elsewhere = applyChecked(closed, { type: "space/activate", spaceId: "s1" });
    const back = reopen(elsewhere);
    expect(shape(space(back, "s2").tree)).toEqual(["w1", "w2"]);
    expect(space(back, "s1").items["w2"]).toBeUndefined();
  });

  it("a position past the end of the list goes to the end", () => {
    const closed = close(fixture(), "h");
    const shorter = applyChecked(closed, { type: "item/close", itemId: "c" });
    const back = reopen(shorter, "h");
    expect(shape(space(back, "s1").tree).at(-1)).toBe("h");
  });

  it("three items closed, then reopened newest first, each at its own place", () => {
    const { ctx } = testContext();
    let ws = fixture();
    for (const id of ["c", "e", "h"]) ws = close(ws, id, ctx);
    expect(ws.closed.map((entry) => entry.item.id)).toEqual(["c", "e", "h"]);
    for (let n = 0; n < 3; n += 1) ws = reopen(ws, undefined, ctx);
    expect(shape(space(ws, "s1").tree)).toEqual(shape(fixture().spaces[0]?.tree ?? []));
    expect(ws.closed).toEqual([]);
  });
});

describe("reopening when the old slot is gone", () => {
  it("a group that was dissolved sends the item to the end of the tree of its space", () => {
    for (const id of ["d", "e"]) {
      const closed = close(fixture(), id);
      const dissolved = applyChecked(closed, { type: "group/ungroup", groupId: "g1" });
      const back = reopen(dissolved, id);
      expect(shape(space(back, "s1").tree).at(-1)).toBe(id);
    }
  });

  it("a deleted space sends the item to the end of the tree of the active space", () => {
    const closed = close(fixture(), "w1");
    const gone = applyChecked(closed, {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "close" },
    });
    const back = reopen(gone, "w1");
    expect(shape(space(back, "s1").tree).at(-1)).toBe("w1");
    expect(back.spaces).toHaveLength(1);
  });

  it("an item with no place (an old state) goes to the end of the tree of its space", () => {
    const ws = fixture();
    const entry: ClosedItem = { item: tab("z"), spaceId: "s2", closedAt: 1 };
    const back = reopen({ ...ws, closed: [entry] });
    expect(shape(space(back, "s2").tree).at(-1)).toBe("z");
  });

  it("a position that is not a whole number cannot block the reopen", () => {
    const ws = fixture();
    const entry: ClosedItem = {
      item: tab("z"),
      spaceId: "s1",
      closedAt: 1,
      place: { list: "tree", index: Number.NaN },
    };
    const back = reopen({ ...ws, closed: [entry] });
    expect(shape(space(back, "s1").tree).at(-1)).toBe("z");
  });

  it("a place that points into a group of another space goes to the end of the tree", () => {
    const ws = fixture();
    const entry: ClosedItem = {
      item: tab("z"),
      spaceId: "s2",
      closedAt: 1,
      place: { list: "tree", groupId: "g1", index: 0 },
    };
    const back = reopen({ ...ws, closed: [entry] });
    expect(shape(space(back, "s2").tree)).toEqual(["w1", "w2", "z"]);
  });
});

describe("a reopened pane starts clean", () => {
  it("forgets the exit code and the command of the shell that ended", () => {
    const ws = fixture();
    const old = tab("z");
    const dead: Item = {
      ...old,
      layout: {
        kind: "pane",
        pane: {
          ...createPane("p-z", "bash", "/zed"),
          status: "exited",
          exitCode: 2,
          runningCommand: { text: "make" },
        },
      },
    };
    const back = reopen({ ...ws, closed: [{ item: dead, spaceId: "s1", closedAt: 1 }] });
    expect(space(back, "s1").items["z"]?.layout).toEqual({
      kind: "pane",
      pane: createPane("p-z", "bash", "/zed"),
    });
  });
});

describe("the stack of closed items", () => {
  const closeMany = (count: number): Workspace => {
    const { ctx } = testContext();
    const base = fixture();
    const spaceOne = space(base, "s1");
    const extra = Array.from({ length: count }, (_, n) => `x${n}`);
    const filled: Workspace = {
      ...base,
      spaces: base.spaces.map((s) =>
        s.id === "s1"
          ? {
              ...spaceOne,
              tree: [...spaceOne.tree, ...extra.map((id): Node => ({ kind: "item", id }))],
              items: { ...spaceOne.items, ...Object.fromEntries(extra.map((id) => [id, tab(id)])) },
            }
          : s,
      ),
    };
    return extra.reduce((ws, id) => close(ws, id, ctx), filled);
  };

  it("keeps at most 50 and drops the oldest", () => {
    const ws = closeMany(MAX_CLOSED + 5);
    expect(ws.closed).toHaveLength(MAX_CLOSED);
    expect(ws.closed[0]?.item.id).toBe("x5");
    expect(ws.closed.at(-1)?.item.id).toBe(`x${MAX_CLOSED + 4}`);
  });

  it("the oldest one that stayed still knows its place", () => {
    const ws = closeMany(MAX_CLOSED + 1);
    expect(ws.closed[0]?.place).toBeDefined();
  });

  it("reopening 50 in a row brings back the newest first and leaves the stack empty", () => {
    let ws = closeMany(MAX_CLOSED + 2);
    const order: string[] = [];
    while (ws.closed.length > 0) {
      order.push(ws.closed.at(-1)?.item.id ?? "");
      ws = reopen(ws);
    }
    expect(order).toHaveLength(MAX_CLOSED);
    expect(order[0]).toBe(`x${MAX_CLOSED + 1}`);
    expect(order.at(-1)).toBe("x2");
  });

  it("an item that is not in the stack any more cannot be reopened", () => {
    const ws = closeMany(MAX_CLOSED + 1);
    expect(reduce(ws, { type: "item/reopen", itemId: "x0" }, testContext().ctx)).toBe(ws);
  });
});

describe("a closed item and its snapshot note", () => {
  it("pane/set-scrollback reaches the panes of a closed item", () => {
    const closed = close(fixture(), "c");
    const noted = applyChecked(closed, {
      type: "pane/set-scrollback",
      itemId: "c",
      paneId: "p-c",
      ref: "p-c.txt",
    });
    const pane = noted.closed[0]?.item.layout;
    expect(pane).toMatchObject({ kind: "pane", pane: { scrollbackRef: "p-c.txt" } });
    const back = reopen(noted);
    expect(space(back, "s1").items["c"]?.layout).toMatchObject({
      pane: { scrollbackRef: "p-c.txt" },
    });
    const cleared = applyChecked(noted, {
      type: "pane/set-scrollback",
      itemId: "c",
      paneId: "p-c",
    });
    expect(cleared.closed[0]?.item.layout).not.toHaveProperty("pane.scrollbackRef");
  });

  it("an unknown closed item or pane changes nothing", () => {
    const closed = close(fixture(), "c");
    const same = reduce(
      closed,
      { type: "pane/set-scrollback", itemId: "nope", paneId: "p-c", ref: "x.txt" },
      testContext().ctx,
    );
    expect(same).toBe(closed);
    const other = reduce(
      closed,
      { type: "pane/set-scrollback", itemId: "c", paneId: "nope", ref: "x.txt" },
      testContext().ctx,
    );
    expect(other).toBe(closed);
  });
});

describe("the place in state.json", () => {
  const withPlace = (place: unknown): string => {
    const ws = close(fixture(), "e");
    const entry = { ...ws.closed[0], place };
    return JSON.stringify({ ...JSON.parse(serializeWorkspace(ws)), closed: [entry] });
  };

  it("survives a round trip", () => {
    const ws = close(fixture(), "e");
    const parsed = parseState(serializeWorkspace(ws));
    expect(parsed.ok && parsed.workspace.closed[0]?.place).toEqual({
      list: "tree",
      groupId: "g1",
      index: 1,
    });
  });

  it("a file from before the field still loads, with no place", () => {
    const ws = close(fixture(), "e");
    const raw = JSON.parse(serializeWorkspace(ws)) as { closed: Record<string, unknown>[] };
    for (const entry of raw.closed) delete entry["place"];
    const parsed = parseState(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.workspace.closed[0]).not.toHaveProperty("place");
  });

  it.each([
    ["a list that is neither", { list: "x", index: 0 }],
    ["a negative position", { list: "tree", index: -1 }],
    ["a fractional position", { list: "tree", index: 1.5 }],
    ["a position that is a string", { list: "tree", index: "1" }],
    ["a group that is not text", { list: "tree", groupId: 3, index: 0 }],
    ["no position", { list: "pinned" }],
    ["something that is not an object", "tree"],
  ])("refuses %s", (_name, place) => {
    const parsed = parseState(withPlace(place));
    expect(parsed.ok).toBe(false);
  });
});

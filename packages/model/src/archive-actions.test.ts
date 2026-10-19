import { describe, expect, it } from "vitest";
import type { ReducerContext } from "./actions";
import { createEmptySpace, createPane, createTab } from "./factories";
import { reduce } from "./reducer";
import { layoutPanes, liveSessionIds } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import { treeItemIds } from "./tree";
import type { ArchivedItem, Id, Item, Node, Workspace } from "./types";

// The archive: an open item goes in with the slot it leaves (like a closed one), comes back there,
// and can be forgotten for good.

const tab = (id: string, cwd = "/home"): Item =>
  createTab(id, createPane(`p-${id}`, "bash", cwd), 5);

/**
 * s1 "Main": pinned [a, b]; tree [ c, g1 { d, e }, h ]; favorite c
 * s2 "Work": tree [ w1, w2 ]; s1 is active.
 */
function fixture(): Workspace {
  const main = createEmptySpace("s1", "Main", { cwd: "/main" });
  const work = createEmptySpace("s2", "Work");
  const g1: Node = {
    kind: "group",
    id: "g1",
    name: "outer",
    color: "teal",
    collapsed: false,
    children: [
      { kind: "item", id: "d" },
      { kind: "item", id: "e" },
    ],
  };
  const ids = ["a", "b", "c", "d", "e", "h"];
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
    favorites: ["c"],
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

const archive = (ws: Workspace, itemId: Id, ctx: ReducerContext = testContext().ctx) =>
  applyChecked(ws, { type: "item/archive", itemId }, ctx);
const restore = (ws: Workspace, itemId: Id, ctx: ReducerContext = testContext().ctx) =>
  applyChecked(ws, { type: "archive/restore", itemId }, ctx);

describe("item/archive", () => {
  it("moves the item to the archive with its space, the moment and the slot it left", () => {
    const next = archive(fixture(), "e");
    expect(space(next, "s1").items["e"]).toBeUndefined();
    expect(treeItemIds(space(next, "s1").tree)).not.toContain("e");
    expect(next.archive).toHaveLength(1);
    expect(next.archive[0]).toMatchObject({
      spaceId: "s1",
      archivedAt: 1000,
      place: { list: "tree", groupId: "g1", index: 1 },
    });
    expect(next.archive[0]?.item.id).toBe("e");
    // It is archived, not closed.
    expect(next.closed).toEqual([]);
  });

  it("records the position among the pinned items too", () => {
    const next = archive(fixture(), "b");
    expect(next.archive[0]?.place).toEqual({ list: "pinned", index: 1 });
  });

  it("takes the item off the favorites", () => {
    const next = archive(fixture(), "c");
    expect(next.favorites).toEqual([]);
  });

  it("drops the sessions of its panes, and the archive holds none", () => {
    const ws = fixture();
    const live: Workspace = {
      ...ws,
      spaces: ws.spaces.map((s) =>
        s.id === "s1"
          ? {
              ...s,
              items: {
                ...s.items,
                h: createTab("h", { ...createPane("p-h", "bash", "/h"), sessionId: "7" }, 5),
              },
            }
          : s,
      ),
    };
    expect([...liveSessionIds(live)]).toEqual(["7"]);
    const next = archive(live, "h");
    expect(liveSessionIds(next).size).toBe(0);
    for (const entry of next.archive) {
      for (const pane of layoutPanes(entry.item.layout)) expect(pane.sessionId).toBeUndefined();
    }
  });

  it("hands the active item of its space to the neighbor", () => {
    const next = archive(fixture(), "c");
    expect(space(next, "s1").activeItemId).not.toBe("c");
    expect(space(next, "s1").activeItemId).toBeDefined();
  });

  it("an unknown item, or one already archived, changes nothing", () => {
    const ws = fixture();
    const { ctx } = testContext();
    expect(reduce(ws, { type: "item/archive", itemId: "nope" }, ctx)).toBe(ws);
    const archived = archive(ws, "h", ctx);
    expect(reduce(archived, { type: "item/archive", itemId: "h" }, ctx)).toBe(archived);
  });

  it("has no size limit: sixty items stay", () => {
    const { ctx } = testContext();
    const base = fixture();
    const extra = Array.from({ length: 60 }, (_, n) => `x${n}`);
    const filled: Workspace = {
      ...base,
      spaces: base.spaces.map((s) =>
        s.id === "s1"
          ? {
              ...s,
              tree: [...s.tree, ...extra.map((id): Node => ({ kind: "item", id }))],
              items: { ...s.items, ...Object.fromEntries(extra.map((id) => [id, tab(id)])) },
            }
          : s,
      ),
    };
    const ws = extra.reduce((acc, id) => archive(acc, id, ctx), filled);
    expect(ws.archive).toHaveLength(60);
  });
});

describe("archive/restore", () => {
  it("puts the item back in its group, at its position, and makes it the active one", () => {
    const back = restore(archive(fixture(), "e"), "e");
    expect(shape(space(back, "s1").tree)).toEqual(shape(fixture().spaces[0]?.tree ?? []));
    expect(back.archive).toEqual([]);
    expect(space(back, "s1").activeItemId).toBe("e");
  });

  it("puts a pinned item back among the pinned ones with an origin", () => {
    const back = restore(archive(fixture(), "a"), "a");
    expect(space(back, "s1").pinned).toEqual(["a", "b"]);
    expect(space(back, "s1").items["a"]?.origin).toEqual({ cwd: "/home", profileId: "bash" });
  });

  it("goes to the space it came from even when another one is active", () => {
    const archived = archive(fixture(), "w2");
    expect(archived.activeSpaceId).toBe("s1");
    const back = restore(archived, "w2");
    expect(shape(space(back, "s2").tree)).toEqual(["w1", "w2"]);
    expect(space(back, "s1").items["w2"]).toBeUndefined();
  });

  it("a group that was dissolved sends it to the end of the tree of its space", () => {
    const archived = archive(fixture(), "d");
    const dissolved = applyChecked(archived, { type: "group/ungroup", groupId: "g1" });
    const back = restore(dissolved, "d");
    expect(shape(space(back, "s1").tree).at(-1)).toBe("d");
  });

  it("a deleted space sends it to the end of the tree of the active one", () => {
    const archived = archive(fixture(), "w1");
    const gone = applyChecked(archived, {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "close" },
    });
    const back = restore(gone, "w1");
    expect(shape(space(back, "s1").tree).at(-1)).toBe("w1");
  });

  it("an entry with no place (nothing recorded it) goes to the end of the tree of its space", () => {
    const entry: ArchivedItem = { item: tab("z", "/zed"), spaceId: "s2", archivedAt: 1 };
    const back = restore({ ...fixture(), archive: [entry] }, "z");
    expect(shape(space(back, "s2").tree)).toEqual(["w1", "w2", "z"]);
  });

  it("comes back clean: no session, no exit code, no command of the old shell", () => {
    const dead: Item = {
      ...tab("z", "/zed"),
      layout: {
        kind: "pane",
        pane: {
          ...createPane("p-z", "bash", "/zed"),
          status: "exited",
          exitCode: 2,
          runningCommand: { text: "make" },
          sessionId: "9",
        },
      },
    };
    const entry: ArchivedItem = { item: dead, spaceId: "s1", archivedAt: 1 };
    const back = restore({ ...fixture(), archive: [entry] }, "z");
    expect(space(back, "s1").items["z"]?.layout).toEqual({
      kind: "pane",
      pane: createPane("p-z", "bash", "/zed"),
    });
    expect(liveSessionIds(back).size).toBe(0);
  });

  it("starts the idle clock again: the restored item is active now", () => {
    const { ctx, clock } = testContext();
    const archived = archive(fixture(), "h", ctx);
    clock.advance(5000);
    const back = restore(archived, "h", ctx);
    expect(space(back, "s1").items["h"]?.lastActivityAt).toBe(6000);
  });

  it("an item that is not in the archive changes nothing, closed ones included", () => {
    const { ctx } = testContext();
    const closed = applyChecked(fixture(), { type: "item/close", itemId: "h" }, ctx);
    expect(reduce(closed, { type: "archive/restore", itemId: "h" }, ctx)).toBe(closed);
    const ws = fixture();
    expect(reduce(ws, { type: "archive/restore", itemId: "nope" }, ctx)).toBe(ws);
  });

  it("restores several in any order, each in its own slot", () => {
    const { ctx } = testContext();
    let ws = fixture();
    for (const id of ["c", "e", "h"]) ws = archive(ws, id, ctx);
    expect(ws.archive.map((entry) => entry.item.id)).toEqual(["c", "e", "h"]);
    for (const id of ["h", "c", "e"]) ws = restore(ws, id, ctx);
    expect(shape(space(ws, "s1").tree)).toEqual(shape(fixture().spaces[0]?.tree ?? []));
    expect(ws.archive).toEqual([]);
  });
});

describe("archive/delete and closed/delete", () => {
  it("archive/delete forgets one archived item and keeps the others", () => {
    const { ctx } = testContext();
    const two = archive(archive(fixture(), "h", ctx), "e", ctx);
    const next = applyChecked(two, { type: "archive/delete", itemId: "h" }, ctx);
    expect(next.archive.map((entry) => entry.item.id)).toEqual(["e"]);
    expect(next.closed).toEqual(two.closed);
  });

  it("closed/delete takes one entry off the closed stack and keeps the archive", () => {
    const { ctx } = testContext();
    const closed = applyChecked(fixture(), { type: "item/close", itemId: "h" }, ctx);
    const both = archive(closed, "e", ctx);
    const next = applyChecked(both, { type: "closed/delete", itemId: "h" }, ctx);
    expect(next.closed).toEqual([]);
    expect(next.archive).toHaveLength(1);
  });

  it("each only touches its own list", () => {
    const { ctx } = testContext();
    const closed = applyChecked(fixture(), { type: "item/close", itemId: "h" }, ctx);
    const both = archive(closed, "e", ctx);
    expect(reduce(both, { type: "archive/delete", itemId: "h" }, ctx)).toBe(both);
    expect(reduce(both, { type: "closed/delete", itemId: "e" }, ctx)).toBe(both);
    expect(reduce(both, { type: "archive/delete", itemId: "nope" }, ctx)).toBe(both);
    expect(reduce(both, { type: "closed/delete", itemId: "nope" }, ctx)).toBe(both);
  });

  it("an id that is not text changes nothing and never throws", () => {
    const ws = archive(fixture(), "h");
    for (const type of ["archive/delete", "closed/delete", "archive/restore"] as const) {
      const action = { type, itemId: 3 } as unknown as Parameters<typeof reduce>[1];
      expect(reduce(ws, action, testContext().ctx)).toBe(ws);
    }
  });
});

describe("a snapshot note on an archived item", () => {
  it("pane/set-scrollback reaches the panes of an archived item", () => {
    const archived = archive(fixture(), "h");
    const noted = applyChecked(archived, {
      type: "pane/set-scrollback",
      itemId: "h",
      paneId: "p-h",
      ref: "p-h.txt",
    });
    expect(noted.archive[0]?.item.layout).toMatchObject({
      kind: "pane",
      pane: { scrollbackRef: "p-h.txt" },
    });
    const back = restore(noted, "h");
    expect(space(back, "s1").items["h"]?.layout).toMatchObject({
      pane: { scrollbackRef: "p-h.txt" },
    });
    const cleared = applyChecked(noted, {
      type: "pane/set-scrollback",
      itemId: "h",
      paneId: "p-h",
    });
    expect(cleared.archive[0]?.item.layout).not.toHaveProperty("pane.scrollbackRef");
  });

  it("an unknown archived item or pane changes nothing", () => {
    const archived = archive(fixture(), "h");
    const ctx = testContext().ctx;
    const unknownItem = {
      type: "pane/set-scrollback",
      itemId: "nope",
      paneId: "p-h",
      ref: "x.txt",
    } as const;
    expect(reduce(archived, unknownItem, ctx)).toBe(archived);
    const unknownPane = { ...unknownItem, itemId: "h", paneId: "nope" } as const;
    expect(reduce(archived, unknownPane, ctx)).toBe(archived);
  });
});

describe("the archive in state.json", () => {
  const withPlace = (place: unknown): string => {
    const ws = archive(fixture(), "e");
    const entry = { ...ws.archive[0], place };
    return JSON.stringify({ ...JSON.parse(serializeWorkspace(ws)), archive: [entry] });
  };

  it("survives a round trip, the place included", () => {
    const ws = archive(fixture(), "e");
    const parsed = parseState(serializeWorkspace(ws));
    expect(parsed.ok && parsed.workspace.archive[0]?.place).toEqual({
      list: "tree",
      groupId: "g1",
      index: 1,
    });
    expect(parsed.ok && parsed.workspace.archive[0]?.archivedAt).toBe(1000);
  });

  it("a file from before the archive had a place still loads, with none", () => {
    const ws = archive(fixture(), "e");
    const raw = JSON.parse(serializeWorkspace(ws)) as { archive: Record<string, unknown>[] };
    for (const entry of raw.archive) delete entry["place"];
    const parsed = parseState(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.workspace.archive[0]).not.toHaveProperty("place");
  });

  it("a file with an empty archive (every file so far) loads as it did", () => {
    const parsed = parseState(serializeWorkspace(fixture()));
    expect(parsed.ok && parsed.workspace.archive).toEqual([]);
  });

  it("the archived item has a pane that restores after a reload of the file", () => {
    const ws = archive(fixture(), "e");
    const parsed = parseState(serializeWorkspace(ws));
    if (!parsed.ok) throw new Error(parsed.reason);
    const back = restore(parsed.workspace, "e");
    expect(shape(space(back, "s1").tree)).toEqual(shape(fixture().spaces[0]?.tree ?? []));
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
    expect(parseState(withPlace(place)).ok).toBe(false);
  });

  it("refuses an archived entry without its time", () => {
    const raw = JSON.parse(serializeWorkspace(archive(fixture(), "e"))) as {
      archive: Record<string, unknown>[];
    };
    for (const entry of raw.archive) delete entry["archivedAt"];
    expect(parseState(JSON.stringify(raw)).ok).toBe(false);
  });
});

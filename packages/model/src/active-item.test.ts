import { describe, expect, it } from "vitest";
import { createDefaultWorkspace } from "./default-workspace";
import { createEmptySpace, createPane, createTab } from "./factories";
import { checkInvariants } from "./invariants";
import { reduceStrict } from "./reducer";
import { applyChecked, deepFreeze, testContext } from "./test-helpers";
import type { Id, Workspace } from "./types";

const tab = (itemId: Id, paneId: Id) => createTab(itemId, createPane(paneId, "bash"), 0);

/**
 * s1 "Main": pinned [a]; tree [ g { b, c }, d ]; active c.
 * s2 "Work": tree [ e, f ]; active e.
 * s3 "Empty": no items. s1 is the active space; closed holds `z` from s1.
 */
function fixture(): Workspace {
  const main = createEmptySpace("s1", "Main");
  const work = createEmptySpace("s2", "Work");
  return {
    version: 2,
    spaces: [
      {
        ...main,
        pinned: ["a"],
        tree: [
          {
            kind: "group",
            id: "g",
            name: "group",
            color: "teal",
            collapsed: false,
            children: [
              { kind: "item", id: "b" },
              { kind: "item", id: "c" },
            ],
          },
          { kind: "item", id: "d" },
        ],
        items: { a: tab("a", "pa"), b: tab("b", "pb"), c: tab("c", "pc"), d: tab("d", "pd") },
        activeItemId: "c",
      },
      {
        ...work,
        tree: [
          { kind: "item", id: "e" },
          { kind: "item", id: "f" },
        ],
        items: { e: tab("e", "pe"), f: tab("f", "pf") },
        activeItemId: "e",
      },
      createEmptySpace("s3", "Empty"),
    ],
    activeSpaceId: "s1",
    favorites: [],
    closed: [{ item: tab("z", "pz"), spaceId: "s1", closedAt: 1 }],
    archive: [],
  };
}

const activeOf = (ws: Workspace, spaceId: Id): Id | undefined =>
  ws.spaces.find((space) => space.id === spaceId)?.activeItemId;

describe("the fixture", () => {
  it("is valid", () => {
    expect(checkInvariants(fixture())).toEqual([]);
  });
});

describe("space/set-active-item", () => {
  it("chooses the item of that space only", () => {
    const next = applyChecked(fixture(), {
      type: "space/set-active-item",
      spaceId: "s1",
      itemId: "a",
    });
    expect(activeOf(next, "s1")).toBe("a");
    expect(activeOf(next, "s2")).toBe("e");
  });

  it("works on a space that is not the active one", () => {
    const next = applyChecked(fixture(), {
      type: "space/set-active-item",
      spaceId: "s2",
      itemId: "f",
    });
    expect(activeOf(next, "s2")).toBe("f");
    expect(next.activeSpaceId).toBe("s1");
  });

  it("changes nothing for the item already active, a foreign item or an unknown id", () => {
    const ws = fixture();
    const { ctx } = testContext();
    const noop = (spaceId: Id, itemId: Id) =>
      reduceStrict(deepFreeze(ws), { type: "space/set-active-item", spaceId, itemId }, ctx);
    expect(noop("s1", "c")).toBe(ws);
    expect(noop("s1", "e")).toBe(ws);
    expect(noop("s1", "ghost")).toBe(ws);
    expect(noop("ghost", "a")).toBe(ws);
    expect(noop("s3", "a")).toBe(ws);
  });
});

describe("the active item follows item/create", () => {
  it("makes the new item active in the space it lands in", () => {
    const next = applyChecked(fixture(), { type: "item/create" });
    const space = next.spaces[0];
    const created = Object.keys(space?.items ?? {}).find(
      (id) => !["a", "b", "c", "d"].includes(id),
    );
    expect(created).toBeDefined();
    expect(activeOf(next, "s1")).toBe(created);
  });

  it("does so in a space that is not the active one, leaving the others alone", () => {
    const next = applyChecked(fixture(), { type: "item/create", spaceId: "s2" });
    expect(activeOf(next, "s2")).not.toBe("e");
    expect(next.spaces[1]?.items[activeOf(next, "s2") ?? ""]).toBeDefined();
    expect(activeOf(next, "s1")).toBe("c");
  });

  it("gives an empty space its first item, also when it is pinned", () => {
    const next = applyChecked(fixture(), {
      type: "item/create",
      spaceId: "s3",
      placement: { to: "pinned" },
    });
    const space = next.spaces[2];
    expect(space?.pinned).toHaveLength(1);
    expect(space?.activeItemId).toBe(space?.pinned[0]);
  });
});

describe("the active item follows item/close", () => {
  const close = (ws: Workspace, itemId: Id) => applyChecked(ws, { type: "item/close", itemId });
  const choose = (ws: Workspace, itemId: Id) =>
    applyChecked(ws, { type: "space/set-active-item", spaceId: "s1", itemId });

  it("stays when another item closes", () => {
    const ws = fixture();
    const next = close(ws, "d");
    expect(activeOf(next, "s1")).toBe("c");
  });

  it("goes to the next item in sidebar order (pinned, then the tree)", () => {
    // Order: a, b, c, d.
    expect(activeOf(close(choose(fixture(), "a"), "a"), "s1")).toBe("b");
    expect(activeOf(close(fixture(), "c"), "s1")).toBe("d");
  });

  it("goes to the previous item when the closed one was the last", () => {
    expect(activeOf(close(choose(fixture(), "d"), "d"), "s1")).toBe("c");
  });

  it("ends with none when the only item closes", () => {
    const next = close(close(fixture(), "e"), "f");
    const space = next.spaces[1];
    expect(space?.items).toEqual({});
    expect(space).not.toHaveProperty("activeItemId");
  });

  it("follows a pane/close that takes the only pane and so the item", () => {
    const next = applyChecked(fixture(), { type: "pane/close", itemId: "c", paneId: "pc" });
    expect(activeOf(next, "s1")).toBe("d");
  });

  it("walks the whole way down as items close", () => {
    let ws = choose(fixture(), "a");
    const seen: (Id | undefined)[] = [];
    for (const id of ["a", "b", "c", "d"]) {
      ws = close(ws, activeOf(ws, "s1") ?? id);
      seen.push(activeOf(ws, "s1"));
    }
    expect(seen).toEqual(["b", "c", "d", undefined]);
  });
});

describe("the active item follows item/reopen", () => {
  it("makes the reopened item active in the space it returns to", () => {
    const next = applyChecked(fixture(), { type: "item/reopen" });
    expect(activeOf(next, "s1")).toBe("z");
    expect(next.closed).toEqual([]);
  });

  it("returns to the active space when the original one is gone", () => {
    const ws = applyChecked(fixture(), {
      type: "space/delete",
      spaceId: "s1",
      items: { mode: "close" },
    });
    // s1 is deleted; the closed stack now holds its items too.
    const next = applyChecked(ws, { type: "item/reopen", itemId: "z" });
    expect(activeOf(next, ws.activeSpaceId)).toBe("z");
  });
});

describe("the active item follows item/move", () => {
  it("leaves the source with a neighbor when the active item moves out", () => {
    const next = applyChecked(fixture(), { type: "item/move", itemId: "c", spaceId: "s2" });
    expect(activeOf(next, "s1")).toBe("d");
    // The arriving item does not take over the target.
    expect(activeOf(next, "s2")).toBe("e");
  });

  it("leaves the source alone when another item moves out", () => {
    const next = applyChecked(fixture(), { type: "item/move", itemId: "a", spaceId: "s2" });
    expect(activeOf(next, "s1")).toBe("c");
  });

  it("gives an empty target its first item", () => {
    const next = applyChecked(fixture(), { type: "item/move", itemId: "e", spaceId: "s3" });
    expect(activeOf(next, "s3")).toBe("e");
    expect(activeOf(next, "s2")).toBe("f");
  });

  it("keeps the active item when it moves inside its space", () => {
    const next = applyChecked(fixture(), {
      type: "item/move",
      itemId: "c",
      placement: { to: "pinned" },
    });
    expect(activeOf(next, "s1")).toBe("c");
  });

  it("keeps it across pin, unpin and grouping", () => {
    let ws = applyChecked(fixture(), { type: "item/pin", itemId: "c" });
    ws = applyChecked(ws, { type: "item/unpin", itemId: "c" });
    ws = applyChecked(ws, { type: "group/create-from-selection", itemIds: ["d"], name: "n" });
    expect(activeOf(ws, "s1")).toBe("c");
  });
});

describe("the active item follows space/delete and item/join", () => {
  it("keeps the target active item when the items of a deleted space move in", () => {
    const next = applyChecked(fixture(), {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "move", targetSpaceId: "s1" },
    });
    expect(activeOf(next, "s1")).toBe("c");
    expect(next.spaces.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("gives an empty target the first of the moved items", () => {
    const next = applyChecked(fixture(), {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "move", targetSpaceId: "s3" },
    });
    expect(activeOf(next, "s3")).toBe("e");
  });

  it("leaves other spaces alone when a space is deleted with its items closed", () => {
    const next = applyChecked(fixture(), {
      type: "space/delete",
      spaceId: "s1",
      items: { mode: "close" },
    });
    expect(activeOf(next, "s2")).toBe("e");
  });

  it("makes the target of a join active and finds a neighbor for the merged item", () => {
    const next = applyChecked(fixture(), {
      type: "item/join",
      itemId: "c",
      targetItemId: "a",
      targetPaneId: "pa",
      dir: "row",
      side: "after",
    });
    expect(activeOf(next, "s1")).toBe("a");
  });

  it("finds a neighbor in the source space of a join across spaces", () => {
    const ws = applyChecked(fixture(), {
      type: "space/set-active-item",
      spaceId: "s2",
      itemId: "f",
    });
    const next = applyChecked(ws, {
      type: "item/join",
      itemId: "f",
      targetItemId: "a",
      targetPaneId: "pa",
      dir: "column",
      side: "before",
    });
    expect(activeOf(next, "s2")).toBe("e");
    expect(activeOf(next, "s1")).toBe("a");
  });
});

describe("a space without an active item", () => {
  it("gets its first item the next time the space changes", () => {
    const ws = fixture();
    const legacy: Workspace = {
      ...ws,
      spaces: ws.spaces.map((space) => {
        const rest = { ...space };
        delete rest.activeItemId;
        return rest;
      }),
    };
    const next = applyChecked(legacy, { type: "item/rename", itemId: "b", title: "x" });
    expect(activeOf(next, "s1")).toBe("a");
    // A space the action did not touch stays as it was.
    expect(activeOf(next, "s2")).toBeUndefined();
  });

  it("keeps the default workspace active on its tab", () => {
    const ws = createDefaultWorkspace();
    const space = ws.spaces[0];
    expect(space?.activeItemId).toBe(Object.keys(space?.items ?? {})[0]);
  });
});

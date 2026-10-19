import { describe, expect, it } from "vitest";
import { ManualClock, reduce } from "@noren/model";
import type { Action, Id, Workspace } from "@noren/model";
import { closedChanges } from "./closed-scrollback";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";

// What a change of the workspace does to the scrollback files: which panes joined the closed stack
// and which panes (with a file) are gone for good.

function workspace(options: { spaceSaves?: boolean; refs?: boolean } = {}): Workspace {
  const ref = options.refs !== false;
  return {
    version: 2,
    spaces: [
      fixtureSpace(
        "s1",
        [
          fixtureTab("a", fixturePane("pa", { cwd: "/srv", ref })),
          fixtureTab("b", fixturePane("pb", { cwd: "/srv", ref })),
        ],
        options.spaceSaves ?? true,
      ),
    ],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  };
}

/** A workspace of `count` tabs t0.. with a file each, in one space. */
function crowded(count: number): Workspace {
  const ids: Id[] = Array.from({ length: count }, (_, n) => `t${n}`);
  return {
    version: 2,
    spaces: [
      fixtureSpace(
        "s1",
        ids.map((id) => fixtureTab(id, fixturePane(`p${id}`, { ref: true }))),
      ),
      fixtureSpace("s2", []),
    ],
    activeSpaceId: "s2",
    favorites: [],
    closed: [],
    archive: [],
  };
}

let counter = 0;
const ctx = { newId: () => `n${++counter}`, clock: new ManualClock() };
const apply = (ws: Workspace, action: Action): Workspace => reduce(ws, action, ctx);
const split = (ws: Workspace): Workspace =>
  apply(ws, { type: "pane/split", itemId: "a", paneId: "pa", dir: "row", side: "after" });

describe("closedChanges", () => {
  it("lists the panes of a tab that closed, with what its space and its pane say", () => {
    const before = workspace();
    const after = apply(before, { type: "item/close", itemId: "a" });
    expect(closedChanges(before, after)).toEqual({
      closed: [{ paneId: "pa", itemId: "a", spaceSaves: true, hasFile: true }],
      gone: [],
    });
  });

  it("carries the setting of the space the tab was in, and whether the pane has a file", () => {
    const before = workspace({ spaceSaves: false, refs: false });
    const after = apply(before, { type: "item/close", itemId: "b" });
    expect(closedChanges(before, after).closed).toEqual([
      { paneId: "pb", itemId: "b", spaceSaves: false, hasFile: false },
    ]);
  });

  it("lists every pane of a split tab", () => {
    const before = split(workspace());
    const after = apply(before, { type: "item/close", itemId: "a" });
    expect(closedChanges(before, after).closed.map((pane) => pane.itemId)).toEqual(["a", "a"]);
  });

  it("lists the tabs that close with their space, and still sees the setting of the space", () => {
    const two: Workspace = {
      ...workspace({ spaceSaves: false }),
      spaces: [...workspace({ spaceSaves: false }).spaces, fixtureSpace("s2", [])],
    };
    const after = apply(two, { type: "space/delete", spaceId: "s1", items: { mode: "close" } });
    const changes = closedChanges(two, after);
    expect(changes.closed.map((pane) => pane.paneId).sort()).toEqual(["pa", "pb"]);
    expect(changes.closed.every((pane) => !pane.spaceSaves)).toBe(true);
    expect(changes.gone).toEqual([]);
  });

  it("says nothing about a tab that reopens: it is not new to the stack and its files stay", () => {
    const closed = apply(workspace(), { type: "item/close", itemId: "a" });
    const after = apply(closed, { type: "item/reopen" });
    expect(after).not.toBe(closed);
    expect(closedChanges(closed, after)).toEqual({ closed: [], gone: [] });
  });

  it("says nothing about a tab that is renamed or moves to another space", () => {
    const before: Workspace = {
      ...workspace(),
      spaces: [...workspace().spaces, fixtureSpace("s2", [])],
    };
    const moved = apply(before, { type: "item/move", itemId: "a", spaceId: "s2" });
    expect(moved).not.toBe(before);
    expect(closedChanges(before, moved)).toEqual({ closed: [], gone: [] });
    const renamed = apply(before, { type: "item/rename", itemId: "a", title: "x" });
    expect(renamed).not.toBe(before);
    expect(closedChanges(before, renamed)).toEqual({ closed: [], gone: [] });
  });

  it("returns nothing for the very same workspace", () => {
    const ws = workspace();
    expect(closedChanges(ws, ws)).toEqual({ closed: [], gone: [] });
  });

  it("lists the pane of a split that was closed: its file has nowhere left to be", () => {
    const before = split(workspace());
    const after = apply(before, { type: "pane/close", itemId: "a", paneId: "pa" });
    expect(after).not.toBe(before);
    expect(closedChanges(before, after)).toEqual({ closed: [], gone: ["pa"] });
  });

  describe("the stack of 50", () => {
    it("closing 51 tabs one after another drops the oldest one on the last, and only its file", () => {
      let ws = crowded(51);
      for (let n = 0; n < 50; n += 1) {
        const next = apply(ws, { type: "item/close", itemId: `t${n}` });
        expect(closedChanges(ws, next).gone).toEqual([]);
        ws = next;
      }
      expect(ws.closed).toHaveLength(50);
      const after = apply(ws, { type: "item/close", itemId: "t50" });
      expect(after.closed).toHaveLength(50);
      expect(after.closed[0]?.item.id).toBe("t1");
      expect(closedChanges(ws, after).gone).toEqual(["pt0"]);
    });

    it("a space that closes more tabs than the stack holds drops the oldest files at once", () => {
      const full = crowded(52);
      const after = apply(full, { type: "space/delete", spaceId: "s1", items: { mode: "close" } });
      expect(after.closed).toHaveLength(50);
      const changes = closedChanges(full, after);
      // The 50 newest are in the stack; the two oldest are gone for good.
      expect(changes.closed).toHaveLength(50);
      expect(changes.gone.sort()).toEqual(["pt0", "pt1"]);
    });

    it("a tab pushed out of the stack by a reopen of another one keeps nothing to remove", () => {
      const full = crowded(51);
      let ws = full;
      for (let n = 0; n < 50; n += 1) ws = apply(ws, { type: "item/close", itemId: `t${n}` });
      const after = apply(ws, { type: "item/reopen", itemId: "t10" });
      expect(closedChanges(ws, after)).toEqual({ closed: [], gone: [] });
    });
  });
});

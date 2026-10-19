import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import type { Id, Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  PANE_EDGE_BAND,
  canDropOnPane,
  joinedPaneCount,
  paneDropAction,
  paneDropId,
  paneLimitNotice,
  paneOf,
  paneZone,
} from "./sidebar-drop";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };
const RECT = { left: 100, top: 50, width: 400, height: 200 };

/** The zone for a point given as a fraction of the pane's width and height. */
const zoneAt = (fx: number, fy: number) =>
  paneZone(RECT, { x: RECT.left + fx * RECT.width, y: RECT.top + fy * RECT.height });

describe("pane drop ids", () => {
  it("round-trip the pane id and ignore other droppables", () => {
    expect(paneOf(paneDropId("p7"))).toBe("p7");
    expect(paneOf("zone:pinned")).toBeUndefined();
    expect(paneOf("space:s1")).toBeUndefined();
    expect(paneOf("n3")).toBeUndefined();
  });
});

describe("paneZone", () => {
  it("maps each edge to the split it makes", () => {
    expect(zoneAt(0.05, 0.5)).toEqual({ dir: "row", side: "before" });
    expect(zoneAt(0.95, 0.5)).toEqual({ dir: "row", side: "after" });
    expect(zoneAt(0.5, 0.05)).toEqual({ dir: "column", side: "before" });
    expect(zoneAt(0.5, 0.95)).toEqual({ dir: "column", side: "after" });
  });

  it("leaves the middle of the pane without a zone (that is for the swap)", () => {
    expect(zoneAt(0.5, 0.5)).toBeUndefined();
    expect(zoneAt(PANE_EDGE_BAND + 0.01, 0.5)).toBeUndefined();
    expect(zoneAt(0.5, 1 - PANE_EDGE_BAND - 0.01)).toBeUndefined();
  });

  it("picks the nearest edge in a corner, and the horizontal one on a tie", () => {
    expect(zoneAt(0.1, 0.2)).toEqual({ dir: "row", side: "before" });
    expect(zoneAt(0.2, 0.1)).toEqual({ dir: "column", side: "before" });
    expect(zoneAt(0.9, 0.8)).toEqual({ dir: "row", side: "after" });
    expect(zoneAt(0.8, 0.9)).toEqual({ dir: "column", side: "after" });
    expect(zoneAt(0.1, 0.1)).toEqual({ dir: "row", side: "before" });
  });

  it("clamps a point just outside the rectangle and refuses an empty one", () => {
    expect(paneZone(RECT, { x: RECT.left - 5, y: RECT.top + 100 })).toEqual({
      dir: "row",
      side: "before",
    });
    expect(paneZone({ ...RECT, width: 0 }, { x: 100, y: 100 })).toBeUndefined();
    expect(paneZone({ ...RECT, height: 0 }, { x: 100, y: 100 })).toBeUndefined();
  });
});

describe("dropping a tab on a pane", () => {
  /** A store with two tabs `[a, b]`; `a` is active and has one pane, so does `b`. */
  async function openStore() {
    const backend = new FakeBackend();
    const newId = createSequentialIds("n");
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    store.getState().newTab();
    const space = (): Space => activeSpaceOf(store.getState().workspace);
    const ids = spaceItemIds(space()) as [Id, Id];
    store.getState().activateItem(ids[0]);
    const panesOf = (id: Id) =>
      layoutPanes(space().items[id]?.layout ?? ({ kind: "pane" } as never));
    return { store, space, ids, panesOf };
  }

  it("only a tab other than the one on screen can be dropped", () => {
    expect(canDropOnPane({ kind: "item", id: "b" }, "a")).toBe(true);
    expect(canDropOnPane({ kind: "item", id: "a" }, "a")).toBe(false);
    expect(canDropOnPane({ kind: "group", id: "g" }, "a")).toBe(false);
    expect(canDropOnPane({ kind: "item", id: "b" }, undefined)).toBe(false);
    expect(
      paneDropAction({ kind: "item", id: "a" }, "a", { paneId: "p", dir: "row", side: "after" }),
    ).toBeUndefined();
  });

  it("joins the tab beside the pane, with the dir and side of the zone", async () => {
    const { store, space, ids, panesOf } = await openStore();
    const [a, b] = ids;
    const target = panesOf(a)[0];
    const action = paneDropAction({ kind: "item", id: b }, a, {
      paneId: target?.id ?? "",
      dir: "column",
      side: "before",
    });
    expect(action).toEqual({
      type: "item/join",
      itemId: b,
      targetItemId: a,
      targetPaneId: target?.id,
      dir: "column",
      side: "before",
    });
    store.getState().dispatch(action ?? ({ type: "item/join" as never } as never));
    expect(spaceItemIds(space())).toEqual([a]);
    expect(panesOf(a)).toHaveLength(2);
    // The joined pane sits before (above) the one dropped on.
    expect(panesOf(a)[1]?.id).toBe(target?.id);
  });

  it("counts the panes the join would make, so the limit can be checked first", async () => {
    const { space, ids } = await openStore();
    const [a, b] = ids;
    expect(joinedPaneCount(space(), b, a)).toBe(2);
    expect(joinedPaneCount(space(), b, "missing")).toBeUndefined();
    expect(paneLimitNotice(4)).toBe("A tab holds at most 4 panes.");
  });
});

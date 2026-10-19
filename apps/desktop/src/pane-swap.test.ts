import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import type { Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  inPaneCenter,
  paneDragId,
  paneDragOf,
  paneDropId,
  paneOf,
  paneSwapAction,
  paneZone,
  swapTarget,
} from "./sidebar-drop";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };
const RECT = { left: 100, top: 50, width: 400, height: 200 };

/** A point given as a fraction of the pane's width and height. */
const at = (fx: number, fy: number) => ({
  x: RECT.left + fx * RECT.width,
  y: RECT.top + fy * RECT.height,
});

describe("pane drag ids", () => {
  it("round-trip the pane id and never mix with the drop ids", () => {
    expect(paneDragOf(paneDragId("p7"))).toBe("p7");
    expect(paneDragOf(paneDropId("p7"))).toBeUndefined();
    expect(paneOf(paneDragId("p7"))).toBeUndefined();
    expect(paneDragOf("n3")).toBeUndefined();
  });
});

describe("inPaneCenter", () => {
  it("is the part of the pane that paneZone leaves without a zone", () => {
    expect(inPaneCenter(RECT, at(0.5, 0.5))).toBe(true);
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.35, 0.65],
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.1],
      [0.5, 0.9],
      [0.2, 0.2],
      [0.69, 0.69],
    ] as const) {
      expect(inPaneCenter(RECT, at(fx, fy))).toBe(paneZone(RECT, at(fx, fy)) === undefined);
    }
  });

  it("is false on every edge band, outside the pane and in an empty rectangle", () => {
    expect(inPaneCenter(RECT, at(0.05, 0.5))).toBe(false);
    expect(inPaneCenter(RECT, at(0.95, 0.5))).toBe(false);
    expect(inPaneCenter(RECT, at(0.5, 0.05))).toBe(false);
    expect(inPaneCenter(RECT, at(0.5, 0.95))).toBe(false);
    expect(inPaneCenter(RECT, { x: RECT.left - 20, y: RECT.top + 100 })).toBe(false);
    expect(inPaneCenter(RECT, { x: RECT.left + 200, y: RECT.top + 500 })).toBe(false);
    expect(inPaneCenter({ ...RECT, width: 0 }, { x: 100, y: 100 })).toBe(false);
    expect(inPaneCenter({ ...RECT, height: 0 }, { x: 100, y: 100 })).toBe(false);
  });
});

describe("swapTarget", () => {
  it("is the pane under the pointer when the pointer is in its middle", () => {
    expect(swapTarget("a", "b", RECT, at(0.5, 0.5))).toBe("b");
  });

  it("does nothing on an edge of another pane, nor on the pane's own middle", () => {
    expect(swapTarget("a", "b", RECT, at(0.9, 0.5))).toBeUndefined();
    expect(swapTarget("a", "b", RECT, at(0.5, 0.1))).toBeUndefined();
    expect(swapTarget("a", "a", RECT, at(0.5, 0.5))).toBeUndefined();
  });
});

describe("swapping two panes of the tab on screen", () => {
  async function openStore() {
    const backend = new FakeBackend();
    const newId = createSequentialIds("n");
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
    const space = (): Space => activeSpaceOf(store.getState().workspace);
    const [itemId] = spaceItemIds(space());
    if (itemId === undefined) throw new Error("no tab");
    const idsOf = () => layoutPanes(space().items[itemId]?.layout ?? ({ kind: "pane" } as never));
    const [first] = idsOf();
    if (!first) throw new Error("no pane");
    store.getState().dispatch({
      type: "pane/split",
      itemId,
      paneId: first.id,
      dir: "row",
      side: "after",
    });
    return { store, itemId, order: () => idsOf().map((pane) => pane.id) };
  }

  it("builds the pane/swap action, and none for a pane dropped on itself", () => {
    expect(paneSwapAction("t", "a", "b")).toEqual({
      type: "pane/swap",
      itemId: "t",
      paneId: "a",
      otherPaneId: "b",
    });
    expect(paneSwapAction("t", "a", "a")).toBeUndefined();
  });

  it("reverses the order of the two panes and keeps their number", async () => {
    const { store, itemId, order } = await openStore();
    const before = order();
    expect(before).toHaveLength(2);
    const [a, b] = before as [string, string];
    const action = paneSwapAction(itemId, a, b);
    if (!action) throw new Error("no action");
    store.getState().dispatch(action);
    expect(order()).toEqual([b, a]);
  });
});

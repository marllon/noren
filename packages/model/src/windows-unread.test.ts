import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID, createEmptySpace, createPane, createTab } from "./factories";
import { layoutPanes } from "./sessions";
import { applyChecked, testContext } from "./test-helpers";
import type { Space, Workspace } from "./types";
import { isMarked } from "./unread";

// Unread marks are read per window (finding 241): the tab a window shows is on screen there, as the
// tab of the main window is on its own, so showing a tab in a window reads it. The property test of
// the reducer (`reducer.property.test.ts`) holds the same rule over random sequences of actions.

/** A space with one tab (item `i<n>`, pane `p<n>`, session `x<n>`) per number given. */
function space(id: string, ...tabs: number[]): Space {
  const base = createEmptySpace(id, `Space ${id}`);
  const items = Object.fromEntries(
    tabs.map((n) => [
      `i${n}`,
      createTab(`i${n}`, { ...createPane(`p${n}`, DEFAULT_PROFILE_ID), sessionId: `x${n}` }, n),
    ]),
  );
  const first = tabs[0];
  return {
    ...base,
    items,
    tree: tabs.map((n) => ({ kind: "item" as const, id: `i${n}` })),
    ...(first !== undefined ? { activeItemId: `i${first}` } : {}),
  };
}

/** The main window shows A (tabs 1, 2 and 5); window `w` shows B (tabs 3 and 4). */
function workspace(): Workspace {
  return {
    version: 2,
    spaces: [space("sA", 1, 2, 5), space("sB", 3, 4)],
    activeSpaceId: "sA",
    favorites: [],
    closed: [],
    archive: [],
    windows: [{ id: "w", spaceId: "sB" }],
  };
}

/** The panes of a tab, in layout order. */
function panesOf(ws: Workspace, spaceId: string, itemId: string) {
  const item = ws.spaces.find((s) => s.id === spaceId)?.items[itemId];
  if (item === undefined) throw new Error(`no tab ${itemId} in ${spaceId}`);
  return layoutPanes(item.layout);
}

function firstPane(ws: Workspace, spaceId: string, itemId: string) {
  const pane = panesOf(ws, spaceId, itemId)[0];
  if (pane === undefined) throw new Error(`no pane in ${itemId}`);
  return pane;
}

describe("unread marks of the tab a window shows", () => {
  it("a tab that was marked is read when it moves into a window and becomes the one it shows", () => {
    const { ctx } = testContext();
    // Tab 2 is not on screen in the main window (it shows tab 1), so output in it marks it.
    let ws = applyChecked(
      workspace(),
      { type: "pane/notify", itemId: "i2", paneId: "p2", bell: true },
      ctx,
    );
    expect(isMarked(firstPane(ws, "sA", "i2"))).toBe(true);
    ws = applyChecked(ws, { type: "window/move-item", itemId: "i2", windowId: "w" }, ctx);
    const pane = firstPane(ws, "sB", "i2");
    expect(pane.unread).toBe(false);
    expect(pane.bell).toBe(false);
    expect(pane.unreadAt).toBeUndefined();
  });

  it("showing a marked tab in the window reads it, and the tabs it does not show stay marked", () => {
    const { ctx } = testContext();
    // The window shows tab 3: tab 4 is somewhere nobody looks, so it is marked.
    let ws = applyChecked(workspace(), { type: "pane/notify", itemId: "i4", paneId: "p4" }, ctx);
    expect(firstPane(ws, "sB", "i4").unread).toBe(true);
    ws = applyChecked(ws, { type: "space/set-active-item", spaceId: "sB", itemId: "i4" }, ctx);
    expect(firstPane(ws, "sB", "i4").unread).toBe(false);
    // Tab 3 now sits behind: it is marked when something happens in it.
    ws = applyChecked(ws, { type: "pane/notify", itemId: "i3", paneId: "p3" }, ctx);
    expect(firstPane(ws, "sB", "i3").unread).toBe(true);
    // A tab the main window does not show is left alone by the window reading its own.
    ws = applyChecked(ws, { type: "pane/notify", itemId: "i2", paneId: "p2" }, ctx);
    expect(firstPane(ws, "sA", "i2").unread).toBe(true);
    ws = applyChecked(ws, { type: "space/set-active-item", spaceId: "sB", itemId: "i3" }, ctx);
    expect(firstPane(ws, "sA", "i2").unread).toBe(true);
  });

  it("output in the tab a window shows marks nothing, and the main window reads its own tab as before", () => {
    const { ctx } = testContext();
    let ws = applyChecked(
      workspace(),
      { type: "pane/notify", itemId: "i3", paneId: "p3", bell: true },
      ctx,
    );
    expect(isMarked(firstPane(ws, "sB", "i3"))).toBe(false);
    ws = applyChecked(ws, { type: "pane/notify", itemId: "i2", paneId: "p2" }, ctx);
    expect(firstPane(ws, "sA", "i2").unread).toBe(true);
    ws = applyChecked(ws, { type: "space/set-active-item", spaceId: "sA", itemId: "i2" }, ctx);
    expect(firstPane(ws, "sA", "i2").unread).toBe(false);
  });

  it("the pane a zoom hides in the window stays marked until the zoom ends", () => {
    const { ctx } = testContext();
    let ws = applyChecked(
      workspace(),
      { type: "pane/split", itemId: "i3", paneId: "p3", dir: "row", side: "after" },
      ctx,
    );
    const second = panesOf(ws, "sB", "i3")[1];
    expect(second).toBeDefined();
    const hiddenId = second?.id ?? "";
    ws = applyChecked(ws, { type: "pane/zoom", itemId: "i3", paneId: "p3" }, ctx);
    // The second pane is hidden by the zoom, so output in it marks it.
    ws = applyChecked(ws, { type: "pane/notify", itemId: "i3", paneId: hiddenId }, ctx);
    expect(panesOf(ws, "sB", "i3").find((pane) => pane.id === hiddenId)?.unread).toBe(true);
    // The zoom ends: the pane is on screen again, and read.
    ws = applyChecked(ws, { type: "pane/zoom", itemId: "i3", paneId: "p3" }, ctx);
    expect(panesOf(ws, "sB", "i3").every((pane) => !pane.unread)).toBe(true);
  });
});

import { FakeBackend, createSequentialIds, restoreWorkspace } from "@noren/model";
import type { Id, Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  NO_SELECTION,
  clickSelection,
  groupItemCount,
  itemMenuModel,
  menuTargets,
  visibleItemIds,
  visibleRows,
  visibleSelection,
} from "./sidebar-tree";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };
const PLAIN = { toggle: false, shift: false };
const CTRL = { toggle: true, shift: false };
const SHIFT = { toggle: false, shift: true };

/** A store with `count` tabs in the active space. */
async function openStore(count: number) {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  for (let i = 1; i < count; i++) store.getState().newTab();
  const space = (): Space => activeSpaceOf(store.getState().workspace);
  return { store, space, ids: () => spaceItemIds(space()) };
}

describe("visibleRows", () => {
  it("lists pinned tabs first, then the tree; a collapsed group hides its tabs but counts them", async () => {
    const { store, space, ids } = await openStore(5);
    const [a, b, c, d, e] = ids() as [Id, Id, Id, Id, Id];
    store.getState().dispatch({ type: "item/pin", itemId: e });
    const groupId = store.getState().groupItems([b, c], "Work");
    expect(groupId).toBeDefined();

    expect(
      visibleRows(space()).map((row) => (row.kind === "item" ? row.id : row.group.name)),
    ).toEqual([e, a, "Work", b, c, d]);
    expect(visibleRows(space()).map((row) => row.depth)).toEqual([0, 0, 0, 1, 1, 0]);

    store
      .getState()
      .dispatch({ type: "group/set-collapsed", groupId: groupId ?? "", collapsed: true });
    const rows = visibleRows(space());
    expect(rows.map((row) => (row.kind === "item" ? row.id : row.group.name))).toEqual([
      e,
      a,
      "Work",
      d,
    ]);
    const header = rows.find((row) => row.kind === "group");
    expect(header?.kind === "group" && header.count).toBe(2);
    expect(visibleItemIds(rows)).toEqual([e, a, d]);
    expect(rows[0]).toMatchObject({ kind: "item", pinned: true });
    expect(rows[1]).toMatchObject({ kind: "item", pinned: false });
  });

  it("counts the tabs of nested groups", async () => {
    const { store, space, ids } = await openStore(2);
    const [a, b] = ids() as [Id, Id];
    store.getState().groupItems([a, b], "Outer");
    store.getState().groupItems([b], "Inner");
    const outer = space().tree.find((node) => node.kind === "group");
    expect(outer?.kind === "group" && groupItemCount(outer)).toBe(2);
  });
});

describe("clickSelection", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("a plain click selects nothing and becomes the anchor", () => {
    const next = clickSelection({ ids: ["a", "b"], anchor: "a" }, order, "c", PLAIN, "a");
    expect(next).toEqual({ ids: [], anchor: "c" });
  });

  it("Ctrl+click toggles; the first toggle keeps the active tab selected", () => {
    let selection = clickSelection(NO_SELECTION, order, "c", CTRL, "a");
    expect(selection).toEqual({ ids: ["a", "c"], anchor: "c" });
    selection = clickSelection(selection, order, "e", CTRL, "a");
    expect(selection.ids).toEqual(["a", "c", "e"]);
    selection = clickSelection(selection, order, "c", CTRL, "a");
    expect(selection.ids).toEqual(["a", "e"]);
  });

  it("Ctrl+click on the active tab alone starts an empty selection", () => {
    expect(clickSelection(NO_SELECTION, order, "a", CTRL, "a").ids).toEqual([]);
  });

  it("Shift+click selects the range from the anchor in the order shown, either direction", () => {
    expect(clickSelection({ ids: [], anchor: "b" }, order, "d", SHIFT, "a")).toEqual({
      ids: ["b", "c", "d"],
      anchor: "b",
    });
    expect(clickSelection({ ids: [], anchor: "d" }, order, "b", SHIFT, "a").ids).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("Shift+click without an anchor starts from the active tab", () => {
    expect(clickSelection(NO_SELECTION, order, "c", SHIFT, "a")).toEqual({
      ids: ["a", "b", "c"],
      anchor: "a",
    });
  });

  it("Shift+click follows the visible order, not the order of the ids", () => {
    // Tabs hidden in a collapsed group are not in `order`, so the range skips them.
    const visible = ["pinned", "x", "y", "z"];
    expect(
      clickSelection({ ids: [], anchor: "pinned" }, visible, "y", SHIFT, "pinned").ids,
    ).toEqual(["pinned", "x", "y"]);
  });

  it("Ctrl+Shift+click adds the range to the selection", () => {
    const next = clickSelection(
      { ids: ["a"], anchor: "c" },
      order,
      "e",
      { toggle: true, shift: true },
      "a",
    );
    expect(next.ids).toEqual(["a", "c", "d", "e"]);
  });

  it("Shift+click with no usable anchor selects just the tab", () => {
    expect(clickSelection({ ids: [], anchor: "gone" }, order, "c", SHIFT, undefined)).toEqual({
      ids: ["c"],
      anchor: "c",
    });
  });

  it("a click on a tab that is not on screen changes nothing", () => {
    expect(clickSelection({ ids: ["a"], anchor: "a" }, order, "zzz", CTRL, "a")).toEqual(
      NO_SELECTION,
    );
  });

  it("drops selected tabs that are no longer visible", () => {
    expect(visibleSelection({ ids: ["a", "x", "c"] }, order)).toEqual(["a", "c"]);
    expect(clickSelection({ ids: ["a", "x"], anchor: "a" }, order, "c", CTRL, "a").ids).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("menuTargets", () => {
  it("acts on the whole selection when the clicked tab is in it", () => {
    expect(menuTargets(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("acts on the clicked tab alone otherwise", () => {
    expect(menuTargets(["a", "b"], "c")).toEqual(["c"]);
    expect(menuTargets(["a"], "a")).toEqual(["a"]);
    expect(menuTargets([], "a")).toEqual(["a"]);
  });
});

describe("itemMenuModel", () => {
  it("flags pinned, favorite, groupable and what 'close others' would close", async () => {
    const { store, space, ids } = await openStore(4);
    const [a, b, c, d] = ids() as [Id, Id, Id, Id];
    store.getState().dispatch({ type: "item/pin", itemId: d });
    store.getState().dispatch({ type: "item/favorite", itemId: b });
    const favorites = () => store.getState().workspace.favorites;

    const one = itemMenuModel(space(), favorites(), [b]);
    expect(one).toMatchObject({
      single: true,
      allPinned: false,
      allFavorite: true,
      canGroup: true,
    });
    // The pinned tab is never closed by "close others".
    expect(one.others).toEqual([a, c]);

    const pinned = itemMenuModel(space(), favorites(), [d]);
    expect(pinned).toMatchObject({ allPinned: true, canGroup: false });
    expect(pinned.others).toEqual([a, b, c]);

    const two = itemMenuModel(space(), favorites(), [a, b]);
    expect(two).toMatchObject({ single: false, allFavorite: false, canGroup: true });
    expect(itemMenuModel(space(), favorites(), [a, d]).canGroup).toBe(false);
  });

  it("does not offer a group where the nesting limit is reached", async () => {
    const { store, space, ids } = await openStore(2);
    const [a, b] = ids() as [Id, Id];
    store.getState().groupItems([a, b], "Outer");
    const outer = space().tree[0];
    if (outer?.kind !== "group") throw new Error("expected a group");
    store.getState().dispatch({ type: "group/create", name: "Inner", parentGroupId: outer.id });
    store.getState().dispatch({
      type: "item/move",
      itemId: a,
      placement: { to: "tree", groupId: innerId(space()) },
    });
    expect(itemMenuModel(space(), [], [a]).canGroup).toBe(false);
    expect(itemMenuModel(space(), [], [b]).canGroup).toBe(true);
  });
});

function innerId(space: Space): Id {
  const outer = space.tree[0];
  if (outer?.kind !== "group") throw new Error("expected a group");
  const inner = outer.children.find((node) => node.kind === "group");
  if (inner?.kind !== "group") throw new Error("expected a nested group");
  return inner.id;
}

import { FakeBackend, createSequentialIds, restoreWorkspace } from "@noren/model";
import type { Action, Id, Node, Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  FAVORITES_DROP_ID,
  PINNED_DROP_ID,
  SPACE_DROP_PREFIX,
  dropAction,
  dropSlots,
  outsideAction,
  outsideId,
  outsideOf,
  resolveDrop,
} from "./sidebar-drop";
import type { DragSource } from "./sidebar-drop";
import { visibleRows } from "./sidebar-tree";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };

/** The tree as nested ids: a tab stays its id, a group becomes `{ id: [...] }`. */
function shape(nodes: readonly Node[]): unknown[] {
  return nodes.map((node) =>
    node.kind === "item" ? node.id : { [node.id]: shape(node.children) },
  );
}

/** A store with five tabs in the tree (ids a..e in the comments below). */
async function openStore() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  for (let i = 1; i < 5; i++) store.getState().newTab();
  const space = (): Space => activeSpaceOf(store.getState().workspace);
  const ids = spaceItemIds(space()) as [Id, Id, Id, Id, Id];
  const rows = () => visibleRows(space());
  /** Drops `source` over row `overId` at `fraction` and returns the resulting tree. */
  const drop = (source: DragSource, overId: Id, fraction: number): unknown[] | undefined => {
    const target = resolveDrop(space(), rows(), source, overId, fraction);
    const action = target && dropAction(space(), source, target);
    if (!action) return undefined;
    store.getState().dispatch(action);
    return shape(space().tree);
  };
  const resolve = (source: DragSource, overId: Id, fraction: number) =>
    resolveDrop(space(), rows(), source, overId, fraction);
  return { store, space, rows, ids, drop, resolve };
}

const item = (id: Id): DragSource => ({ kind: "item", id });
const group = (id: Id): DragSource => ({ kind: "group", id });

describe("resolveDrop for a tab over another tab", () => {
  it("drops before or after it, by the half of the row", async () => {
    const { ids, resolve } = await openStore();
    const [a, b, c] = ids;
    expect(resolve(item(c), a, 0.2)).toEqual({
      rowId: a,
      edge: "before",
      groupId: undefined,
      index: 0,
    });
    expect(resolve(item(c), a, 0.8)).toMatchObject({ rowId: a, edge: "after", index: 1 });
    expect(resolve(item(a), b, 0.8)).toMatchObject({ edge: "after", index: 2 });
  });

  it("reorders the tree, counting positions after the tab left its old spot", async () => {
    const { ids, drop } = await openStore();
    const [a, b, c, d, e] = ids;
    expect(drop(item(a), c, 0.8)).toEqual([b, c, a, d, e]);
    expect(drop(item(e), b, 0.2)).toEqual([e, b, c, a, d]);
    expect(drop(item(d), b, 0.8)).toEqual([e, b, d, c, a]);
  });

  it("does nothing when the tab would stay where it is", async () => {
    const { ids, resolve } = await openStore();
    const [a, b, c] = ids;
    expect(resolve(item(b), b, 0.5)).toBeUndefined();
    expect(resolve(item(b), c, 0.2)).toBeUndefined();
    expect(resolve(item(b), a, 0.8)).toBeUndefined();
  });

  it("ignores rows that are not in the tree, such as a pinned tab or an unknown one", async () => {
    const { ids, store, resolve } = await openStore();
    const [a, b] = ids;
    store.getState().dispatch({ type: "item/pin", itemId: a });
    expect(resolve(item(b), a, 0.5)).toBeUndefined();
    expect(resolve(item(b), "nope", 0.5)).toBeUndefined();
    expect(resolve(item("nope"), b, 0.5)).toBeUndefined();
  });
});

describe("a tab joining and leaving a group", () => {
  /** Tree: a, G{b, c}, d, e. */
  async function withGroup() {
    const context = await openStore();
    const [a, b, c, d, e] = context.ids;
    const groupId = context.store.getState().groupItems([b, c], "Work");
    if (groupId === undefined) throw new Error("no group");
    return { ...context, a, b, c, d, e, groupId };
  }

  it("drops on the middle of an open group header at the top of the group", async () => {
    const { a, b, c, d, e, groupId, drop, resolve } = await withGroup();
    expect(resolve(item(a), groupId, 0.5)).toMatchObject({ edge: "inside", groupId, index: 0 });
    expect(drop(item(a), groupId, 0.5)).toEqual([{ [groupId]: [a, b, c] }, d, e]);
  });

  it("drops beside a grouped tab to join the group at that spot", async () => {
    const { a, b, c, d, e, groupId, drop } = await withGroup();
    expect(drop(item(a), c, 0.2)).toEqual([{ [groupId]: [b, a, c] }, d, e]);
  });

  it("drops beside a loose tab to leave the group", async () => {
    const { a, b, c, d, e, groupId, drop } = await withGroup();
    expect(drop(item(b), d, 0.8)).toEqual([a, { [groupId]: [c] }, d, b, e]);
  });

  it("puts a tab at the end of a folded group when dropped on its header", async () => {
    const { a, b, c, d, e, groupId, store, drop } = await withGroup();
    store.getState().dispatch({ type: "group/set-collapsed", groupId, collapsed: true });
    expect(drop(item(a), groupId, 0.5)).toEqual([{ [groupId]: [b, c, a] }, d, e]);
  });

  it("drops on the edges of a header to go beside the group", async () => {
    const { a, b, e, groupId, store, resolve } = await withGroup();
    expect(resolve(item(b), groupId, 0.1)).toMatchObject({
      edge: "before",
      groupId: undefined,
      index: 1,
    });
    // The lower edge of an open group header is still inside it; a folded group has an "after".
    expect(resolve(item(a), groupId, 0.9)).toMatchObject({ edge: "inside" });
    store.getState().dispatch({ type: "group/set-collapsed", groupId, collapsed: true });
    expect(resolve(item(e), groupId, 0.9)).toMatchObject({ edge: "after", index: 2 });
  });
});

describe("a group moving among its siblings", () => {
  /** Tree: F{a, b}, c, S{d, e}. */
  async function twoGroups() {
    const context = await openStore();
    const [a, b, c, d, e] = context.ids;
    const first = context.store.getState().groupItems([a, b], "First");
    const second = context.store.getState().groupItems([d, e], "Second");
    if (first === undefined || second === undefined) throw new Error("no group");
    return { ...context, a, b, c, d, e, first, second };
  }

  it("reorders top-level groups by the half of the header", async () => {
    const { first, second, a, b, c, d, e, drop } = await twoGroups();
    expect(drop(group(second), first, 0.2)).toEqual([{ [second]: [d, e] }, { [first]: [a, b] }, c]);
    expect(drop(group(second), c, 0.8)).toEqual([{ [first]: [a, b] }, c, { [second]: [d, e] }]);
  });

  it("treats anything inside another open group as after that group", async () => {
    const { first, second, a, b, c, d, e, drop, resolve } = await twoGroups();
    expect(resolve(group(first), d, 0.1)).toMatchObject({
      rowId: e,
      edge: "after",
      groupId: undefined,
      index: 3,
    });
    expect(drop(group(first), d, 0.1)).toEqual([c, { [second]: [d, e] }, { [first]: [a, b] }]);
  });

  it("anchors the line under the last visible row of an open group", async () => {
    const { first, second, e, resolve } = await twoGroups();
    expect(resolve(group(first), second, 0.8)).toMatchObject({ rowId: e, edge: "after" });
  });

  it("never drops a group on itself or on its own tabs", async () => {
    const { first, a, resolve } = await twoGroups();
    expect(resolve(group(first), first, 0.5)).toBeUndefined();
    expect(resolve(group(first), a, 0.5)).toBeUndefined();
  });

  it("builds a group move action with the parent only when it has one", async () => {
    const { first, c, space, resolve } = await twoGroups();
    const target = resolve(group(first), c, 0.8);
    expect(target && dropAction(space(), group(first), target)).toEqual({
      type: "group/move",
      groupId: first,
      index: 1,
    });
  });
});

describe("dropSlots", () => {
  it("lists each distinct place top to bottom, without the no-ops", async () => {
    const { ids, space, rows, resolve } = await openStore();
    const [a, , c, d, e] = ids;
    const slots = dropSlots(space(), rows(), item(c));
    expect(slots.map((slot) => slot.target.index)).toEqual([0, 1, 4, 5]);
    expect(slots.map((slot) => slot.rowId)).toEqual([a, a, d, e]);
    // The spot of a slot resolves back to it: the keyboard and the pointer agree.
    for (const slot of slots) {
      expect(resolve(item(c), slot.rowId, slot.fraction)).toEqual(slot.target);
    }
  });

  it("offers the inside of a group and the places in it", async () => {
    const { ids, space, rows, store } = await openStore();
    const [a, b, c] = ids;
    const groupId = store.getState().groupItems([b, c], "Work");
    const places = dropSlots(space(), rows(), item(a)).map((slot) => [
      slot.target.groupId,
      slot.target.index,
    ]);
    expect(places).toContainEqual([groupId, 0]);
    expect(places).toContainEqual([groupId, 1]);
    expect(places).toContainEqual([groupId, 2]);
  });
});

describe("drops outside the tree", () => {
  /** Two spaces: the first holds five tabs, the second one tab; the first stays active. */
  async function twoSpaces() {
    const opened = await openStore();
    opened.store.getState().createSpace({ name: "Other" });
    const [first, second] = opened.store.getState().workspace.spaces as [Space, Space];
    opened.store.getState().activateSpace(first.id);
    const action = (source: Id, drop: Parameters<typeof outsideAction>[3]) => {
      const { workspace } = opened.store.getState();
      return outsideAction(
        workspace.spaces,
        workspace.favorites,
        { kind: "item", id: source },
        drop,
      );
    };
    return { ...opened, first: first.id, second: second.id, action };
  }

  it("maps droppable ids to places and back", () => {
    expect(outsideOf(`${SPACE_DROP_PREFIX}s2`)).toEqual({ kind: "space", spaceId: "s2" });
    expect(outsideOf(PINNED_DROP_ID)).toEqual({ kind: "pinned" });
    expect(outsideOf(FAVORITES_DROP_ID)).toEqual({ kind: "favorites" });
    expect(outsideOf("i1")).toBeUndefined();
    for (const drop of [
      { kind: "space", spaceId: "s9" },
      { kind: "pinned" },
      { kind: "favorites" },
    ] as const) {
      expect(outsideOf(outsideId(drop))).toEqual(drop);
    }
  });

  it("moves a tab to another space, which stays inactive", async () => {
    const { store, ids, first, second, action } = await twoSpaces();
    const [a] = ids;
    const move = action(a, { kind: "space", spaceId: second });
    expect(move).toEqual({ type: "item/move", itemId: a, spaceId: second });
    store.getState().dispatch(move as Action);
    const { workspace } = store.getState();
    expect(workspace.activeSpaceId).toBe(first);
    expect(workspace.spaces.find((s) => s.id === first)?.items[a]).toBeUndefined();
    expect(workspace.spaces.find((s) => s.id === second)?.items[a]).toBeDefined();
  });

  it("does nothing when the tab already lives in the target space", async () => {
    const { ids, first, action } = await twoSpaces();
    expect(action(ids[0], { kind: "space", spaceId: first })).toBeUndefined();
    expect(action(ids[0], { kind: "space", spaceId: "missing" })).toBeUndefined();
  });

  it("pins a tab, and does nothing for one that is already pinned", async () => {
    const { store, ids, space, action } = await twoSpaces();
    const [a] = ids;
    const pin = action(a, { kind: "pinned" });
    expect(pin).toEqual({ type: "item/pin", itemId: a });
    store.getState().dispatch(pin as Action);
    expect(space().pinned).toEqual([a]);
    expect(action(a, { kind: "pinned" })).toBeUndefined();
  });

  it("favorites a tab, and does nothing for one that is already a favorite", async () => {
    const { store, ids, action } = await twoSpaces();
    const [a] = ids;
    const favorite = action(a, { kind: "favorites" });
    expect(favorite).toEqual({ type: "item/favorite", itemId: a });
    store.getState().dispatch(favorite as Action);
    expect(store.getState().workspace.favorites).toEqual([a]);
    expect(action(a, { kind: "favorites" })).toBeUndefined();
  });

  it("only tabs go outside the tree", async () => {
    const { store, ids, second } = await twoSpaces();
    const groupId = store.getState().groupItems([ids[1], ids[2]], "Work");
    const { workspace } = store.getState();
    for (const drop of [
      { kind: "space", spaceId: second },
      { kind: "pinned" },
      { kind: "favorites" },
    ] as const) {
      expect(
        outsideAction(
          workspace.spaces,
          workspace.favorites,
          { kind: "group", id: groupId ?? "" },
          drop,
        ),
      ).toBeUndefined();
    }
  });
});

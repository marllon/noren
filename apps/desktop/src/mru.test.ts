import { FakeBackend, createSequentialIds, restoreWorkspace } from "@noren/model";
import { describe, expect, it } from "vitest";
import {
  allTabIds,
  currentTabId,
  previewLines,
  pruneMru,
  stepIndex,
  switcherOrder,
  touchMru,
  trackMru,
} from "./mru";
import type { MruList } from "./mru";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };

/** A store with the tabs a, b, c in "Main" (c on screen) and the tab d in "Other". */
async function openStore() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const { newTab, dispatch } = store.getState();
  newTab();
  newTab();
  const main = activeSpaceOf(store.getState().workspace);
  const [a, b, c] = spaceItemIds(main) as [string, string, string];
  dispatch({ type: "item/rename", itemId: a, title: "a" });
  dispatch({ type: "item/rename", itemId: b, title: "b" });
  dispatch({ type: "item/rename", itemId: c, title: "c" });
  store.getState().createSpace({ name: "Other" });
  const other = activeSpaceOf(store.getState().workspace);
  const d = spaceItemIds(other)[0] as string;
  store.getState().activateSpace(main.id);
  return { store, main, other, a, b, c, d };
}

/** Follows the store like the shell does: the list after each change of the workspace. */
function follow(store: Awaited<ReturnType<typeof openStore>>["store"]) {
  const state = { list: [] as MruList };
  state.list = trackMru(state.list, store.getState().workspace);
  store.subscribe((next) => {
    state.list = trackMru(state.list, next.workspace);
  });
  return state;
}

describe("touchMru and pruneMru", () => {
  it("moves a tab to the front and keeps the rest in order", () => {
    expect(touchMru(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touchMru(["a", "b", "c"], "a")).toEqual(["a", "b", "c"]);
  });

  it("puts a tab the list did not hold at the front", () => {
    expect(touchMru(["a"], "z")).toEqual(["z", "a"]);
  });

  it("does not change the list it is given", () => {
    const list: MruList = ["a", "b"];
    touchMru(list, "b");
    expect(list).toEqual(["a", "b"]);
  });

  it("drops the tabs that are not open", () => {
    expect(pruneMru(["a", "b", "c"], new Set(["a", "c"]))).toEqual(["a", "c"]);
  });
});

describe("following the workspace", () => {
  it("lists the tab on screen first, then the others by recent use", async () => {
    const { store, a, b, c } = await openStore();
    const mru = follow(store);
    expect(mru.list[0]).toBe(c);
    store.getState().activateItem(a);
    store.getState().activateItem(b);
    expect(mru.list.slice(0, 3)).toEqual([b, a, c]);
    expect(switcherOrder(mru.list, store.getState().workspace).slice(0, 3)).toEqual([b, a, c]);
  });

  it("activating the same tab again changes nothing", async () => {
    const { store, a, b } = await openStore();
    const mru = follow(store);
    store.getState().activateItem(a);
    store.getState().activateItem(b);
    const before = mru.list;
    store.getState().activateItem(b);
    expect(mru.list).toBe(before);
  });

  it("activating an older tab again moves it back to the front, once", async () => {
    const { store, a, b, c } = await openStore();
    const mru = follow(store);
    store.getState().activateItem(b);
    store.getState().activateItem(a);
    store.getState().activateItem(b);
    expect(mru.list.slice(0, 3)).toEqual([b, a, c]);
    expect(mru.list.filter((id) => id === b)).toHaveLength(1);
  });

  it("a closed tab drops out", async () => {
    const { store, a, b, c } = await openStore();
    const mru = follow(store);
    store.getState().activateItem(a);
    store.getState().closeItems([b]);
    expect(mru.list).not.toContain(b);
    expect(switcherOrder(mru.list, store.getState().workspace)).not.toContain(b);
    expect(mru.list).toContain(c);
  });

  it("follows the tabs of every space", async () => {
    const { store, main, other, a, d } = await openStore();
    const mru = follow(store);
    store.getState().activateItem(a);
    // To the tab of another space the way the switcher does: choose it, then show its space.
    store.getState().dispatch({ type: "space/set-active-item", spaceId: other.id, itemId: d });
    store.getState().dispatch({ type: "space/activate", spaceId: other.id });
    expect(currentTabId(store.getState().workspace)).toBe(d);
    expect(mru.list.slice(0, 2)).toEqual([d, a]);
    store.getState().dispatch({ type: "space/activate", spaceId: main.id });
    expect(mru.list[0]).toBe(a);
    expect(mru.list[1]).toBe(d);
  });

  it("a tab nobody looked at comes after the used ones, in sidebar order", async () => {
    const { store, a, b, c, d } = await openStore();
    // A list that knows only the tab on screen: the rest follow the sidebar, space by space.
    const order = switcherOrder([c], store.getState().workspace);
    expect(order).toEqual([c, a, b, d]);
    expect(allTabIds(store.getState().workspace)).toEqual([a, b, c, d]);
  });

  it("a tab that is not on screen is not first even if it was used last", async () => {
    const { store, a, b, c } = await openStore();
    expect(switcherOrder([a, b, c], store.getState().workspace)[0]).toBe(c);
  });
});

describe("stepIndex", () => {
  it("walks down and wraps at the end", () => {
    expect(stepIndex(3, 0, 1)).toBe(1);
    expect(stepIndex(3, 2, 1)).toBe(0);
  });

  it("walks up and wraps at the start", () => {
    expect(stepIndex(3, 2, -1)).toBe(1);
    expect(stepIndex(3, 0, -1)).toBe(2);
  });

  it("stays at 0 for an empty list", () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});

describe("previewLines", () => {
  it("keeps the last non-empty lines, oldest first", () => {
    const lines = ["one", "", "two", "   ", "three", "four", "five", "six", "seven", "", ""];
    expect(previewLines(lines)).toEqual(["three", "four", "five", "six", "seven"]);
    expect(previewLines(lines, 2)).toEqual(["six", "seven"]);
  });

  it("returns what there is when there are fewer lines", () => {
    expect(previewLines(["", "only", ""])).toEqual(["only"]);
    expect(previewLines([])).toEqual([]);
  });
});

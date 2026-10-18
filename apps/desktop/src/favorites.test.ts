import { FakeBackend, createSequentialIds, restoreWorkspace } from "@noren/model";
import type { Id, Space } from "@noren/model";
import { describe, expect, it } from "vitest";
import { itemTitle, resolveFavorites, titleInitial } from "./favorites";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

const clock = { now: () => 1000 };

/** A store with "Main" (three tabs) and a second space "Other" (one tab); Main is active. */
async function openStore() {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({ backend, workspace: restored.workspace, newId, clock });
  const main = activeSpaceOf(store.getState().workspace).id;
  store.getState().newTab();
  store.getState().newTab();
  store.getState().createSpace({ name: "Other" });
  const other = activeSpaceOf(store.getState().workspace).id;
  store.getState().activateSpace(main);
  const spaces = () => store.getState().workspace.spaces;
  const mainSpace = (): Space => activeSpaceOf(store.getState().workspace);
  const mainIds = spaceItemIds(mainSpace()) as [Id, Id, Id];
  const otherIds = spaceItemIds(spaces().find((space) => space.id === other) ?? mainSpace()) as [
    Id,
  ];
  return { store, spaces, mainSpace, main, other, mainIds, otherIds };
}

describe("resolveFavorites", () => {
  it("returns each favorite with its owner space, in the order it was added", async () => {
    const { spaces, main, other, mainIds, otherIds } = await openStore();
    const resolved = resolveFavorites(spaces(), [otherIds[0], mainIds[1]]);
    expect(resolved.map((favorite) => [favorite.id, favorite.spaceId])).toEqual([
      [otherIds[0], other],
      [mainIds[1], main],
    ]);
    expect(resolved[0]).toMatchObject({ spaceName: "Other" });
    expect(resolved[0]?.spaceColor).toBe(spaces().find((s) => s.id === other)?.color);
  });

  it("uses the title, or the placeholder counted in the order of the owner space", async () => {
    const { store, spaces, mainIds } = await openStore();
    store.getState().dispatch({ type: "item/rename", itemId: mainIds[0], title: "api" });
    const resolved = resolveFavorites(spaces(), [mainIds[0], mainIds[2]]);
    expect(resolved.map((favorite) => [favorite.title, favorite.initial])).toEqual([
      ["api", "A"],
      ["Tab 3", "T"],
    ]);
  });

  it("leaves out ids no space holds and repeated ids", async () => {
    const { spaces, mainIds } = await openStore();
    const resolved = resolveFavorites(spaces(), ["gone", mainIds[0], "also-gone", mainIds[0]]);
    expect(resolved.map((favorite) => favorite.id)).toEqual([mainIds[0]]);
    expect(resolveFavorites(spaces(), [])).toEqual([]);
  });

  it("follows a tab moved to another space and drops one that was closed", async () => {
    const { store, spaces, other, mainIds } = await openStore();
    const { dispatch } = store.getState();
    dispatch({ type: "item/favorite", itemId: mainIds[0] });
    dispatch({ type: "item/favorite", itemId: mainIds[1] });
    dispatch({ type: "item/move", itemId: mainIds[0], spaceId: other });
    dispatch({ type: "item/close", itemId: mainIds[1] });
    // The closed id is fed back in on purpose: a stale file may still list it.
    const resolved = resolveFavorites(spaces(), [
      ...store.getState().workspace.favorites,
      mainIds[1],
    ]);
    expect(resolved.map((favorite) => [favorite.id, favorite.spaceId])).toEqual([
      [mainIds[0], other],
    ]);
  });
});

describe("itemTitle", () => {
  it("numbers an untitled tab from 1 in the order of its space", async () => {
    const { mainSpace, mainIds } = await openStore();
    expect(itemTitle(mainSpace(), mainIds[0])).toBe("Tab 1");
    expect(itemTitle(mainSpace(), mainIds[2])).toBe("Tab 3");
  });
});

describe("titleInitial", () => {
  it("takes the first letter or digit in upper case", () => {
    expect(titleInitial("deploy")).toBe("D");
    expect(titleInitial("  ~/dev/site")).toBe("D");
    expect(titleInitial("3d-print")).toBe("3");
    expect(titleInitial("épico")).toBe("É");
  });

  it("falls back to the first character, then to a question mark", () => {
    expect(titleInitial("---")).toBe("-");
    expect(titleInitial("   ")).toBe("?");
  });
});

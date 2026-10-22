import { FakeBackend, createSequentialIds, layoutPanes, restoreWorkspace } from "@noren/model";
import type { Id } from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeItemIdOf, activeSpaceOf, createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStoreOptions } from "./workspace-store";

// The most panes a tab holds (`terminal.maxPanes`): the store gives it to the reducer at every action,
// as a number or as the function the app uses to read the settings, so a change counts at once.

const clock = { now: () => 1000 };

async function openStore(maxPanes?: WorkspaceStoreOptions["maxPanes"]) {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({
    backend,
    workspace: restored.workspace,
    newId,
    clock,
    ...(maxPanes !== undefined ? { maxPanes } : {}),
  });
  const itemId = activeItemIdOf(store.getState());
  if (itemId === undefined) throw new Error("no tab");
  return { store, itemId };
}

/** Splits the focused pane of the tab until the store refuses, up to `tries` times; returns the panes it holds. */
function splitUntilRefused(
  store: Awaited<ReturnType<typeof openStore>>["store"],
  itemId: Id,
  tries = 40,
): number {
  for (let n = 0; n < tries; n++) {
    const item = activeSpaceOf(store.getState().workspace).items[itemId];
    if (!item) throw new Error("the tab is gone");
    const before = store.getState().workspace;
    store.getState().dispatch({
      type: "pane/split",
      itemId,
      paneId: item.focusedPaneId,
      dir: n % 2 === 0 ? "row" : "column",
      side: "after",
    });
    if (store.getState().workspace === before) break;
  }
  const last = activeSpaceOf(store.getState().workspace).items[itemId];
  return last ? layoutPanes(last.layout).length : -1;
}

describe("the limit of panes of a tab, in the store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is eight panes when the store is given no limit", async () => {
    const { store, itemId } = await openStore();
    expect(splitUntilRefused(store, itemId)).toBe(8);
  });

  it("is the number the store is given", async () => {
    const { store, itemId } = await openStore(3);
    expect(splitUntilRefused(store, itemId)).toBe(3);
  });

  it("is asked of the function at every action, so a change of the settings counts at once", async () => {
    const limit = { now: 2 };
    const { store, itemId } = await openStore(() => limit.now);
    expect(splitUntilRefused(store, itemId)).toBe(2);
    limit.now = 5;
    expect(splitUntilRefused(store, itemId)).toBe(5);
    limit.now = 16;
    expect(splitUntilRefused(store, itemId)).toBe(16);
    // Lowered again, nothing is closed: the tab keeps its panes and only refuses to grow.
    limit.now = 4;
    expect(splitUntilRefused(store, itemId)).toBe(16);
  });
});

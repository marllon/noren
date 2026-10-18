import {
  FakeBackend,
  STATE_SAVE_DELAY_MS,
  createDefaultWorkspace,
  createSequentialIds,
  liveSessionIds,
  parseState,
  restoreWorkspace,
} from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_ITEMS_KEY,
  activeItemIdOf,
  activeSpaceOf,
  createWorkspaceStore,
  sessionStartOptions,
  spaceItemIds,
} from "./workspace-store";
import type { UiStorage } from "./workspace-store";

class MemoryStorage implements UiStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const clock = { now: () => 1000 };

async function openStore(backend: FakeBackend, storage?: UiStorage) {
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({
    backend,
    workspace: restored.workspace,
    newId,
    clock,
    ...(storage ? { uiStorage: storage } : {}),
  });
  return { store, restored };
}

describe("workspace store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts from the restored workspace: 1 space, 1 tab, active", async () => {
    const { store, restored } = await openStore(new FakeBackend());
    const state = store.getState();
    expect(restored.source).toBe("fresh");
    expect(state.workspace.spaces).toHaveLength(1);
    const space = state.workspace.spaces[0];
    expect(space && spaceItemIds(space)).toHaveLength(1);
    expect(activeItemIdOf(state)).toBe(space && spaceItemIds(space)[0]);
  });

  it("a new tab goes through the reducer, becomes active and schedules one save", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    expect(backend.callsTo("saveState")).toHaveLength(0);

    store.getState().newTab();
    store.getState().newTab();

    const state = store.getState();
    const space = state.workspace.spaces[0];
    if (!space) throw new Error("no space");
    const ids = spaceItemIds(space);
    expect(ids).toHaveLength(3);
    expect(activeItemIdOf(state)).toBe(ids[2]);

    // Debounced: nothing written yet, then a single write with the newest workspace.
    expect(backend.callsTo("saveState")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
    expect(backend.callsTo("saveState")).toHaveLength(1);
    const saved = parseState(backend.stateContent ?? "");
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      const savedSpace = saved.workspace.spaces[0];
      expect(savedSpace && spaceItemIds(savedSpace)).toEqual(ids);
    }
  });

  it("flush writes the pending state without waiting", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    store.getState().newTab();
    await store.getState().flush();
    expect(backend.callsTo("saveState")).toHaveLength(1);
  });

  it("restoring the saved state brings back the same tabs in the same order", async () => {
    const backend = new FakeBackend();
    const first = await openStore(backend);
    first.store.getState().newTab();
    first.store.getState().newTab();
    await first.store.getState().flush();
    const before = first.store.getState().workspace.spaces[0];

    const second = await openStore(backend);
    const after = second.store.getState().workspace.spaces[0];
    expect(second.restored.source).toBe("saved");
    expect(before && after && spaceItemIds(after)).toEqual(before && spaceItemIds(before));
  });

  it("activating a tab changes only the active tab and is kept in the ui storage", async () => {
    const backend = new FakeBackend();
    const storage = new MemoryStorage();
    const { store } = await openStore(backend, storage);
    store.getState().newTab();
    const space = store.getState().workspace.spaces[0];
    if (!space) throw new Error("no space");
    const [first] = spaceItemIds(space);
    if (first === undefined) throw new Error("no tab");

    store.getState().activateItem(first);
    expect(activeItemIdOf(store.getState())).toBe(first);
    expect(backend.callsTo("saveState")).toHaveLength(0);
    expect(JSON.parse(storage.values.get(ACTIVE_ITEMS_KEY) ?? "{}")).toEqual({ [space.id]: first });

    // A new store over the same storage picks the choice up again.
    const again = createWorkspaceStore({
      backend,
      workspace: store.getState().workspace,
      uiStorage: storage,
    });
    expect(activeItemIdOf(again.getState())).toBe(first);
  });

  it("an active tab that no longer exists falls back to the first one", () => {
    const storage = new MemoryStorage();
    storage.setItem(ACTIVE_ITEMS_KEY, JSON.stringify({ id1: "gone" }));
    const store = createWorkspaceStore({
      backend: new FakeBackend(),
      workspace: createDefaultWorkspace(),
      uiStorage: storage,
    });
    expect(activeItemIdOf(store.getState())).toBe("id2");
  });

  it("closing a tab ends its session", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    const space = store.getState().workspace.spaces[0];
    const itemId = space && spaceItemIds(space)[0];
    if (itemId === undefined) throw new Error("no tab");
    const [sessionId] = liveSessionIds(store.getState().workspace);
    expect(sessionId).toBeDefined();

    store.getState().dispatch({ type: "item/close", itemId });

    expect(liveSessionIds(store.getState().workspace).size).toBe(0);
    expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual([Number(sessionId)]);
  });

  it("attachSession records the session of a new pane and kills one for a pane that is gone", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    store.getState().newTab();
    const space = store.getState().workspace.spaces[0];
    const created = space && spaceItemIds(space)[1];
    const item = space && created !== undefined ? space.items[created] : undefined;
    if (!item) throw new Error("no new tab");

    store.getState().attachSession(item.focusedPaneId, "77");
    expect(liveSessionIds(store.getState().workspace).has("77")).toBe(true);

    store.getState().attachSession("no-such-pane", "78");
    expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual([78]);
  });

  it("an action the reducer rejects changes and saves nothing", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    const before = store.getState().workspace;
    store.getState().dispatch({ type: "item/close", itemId: "missing" });
    expect(store.getState().workspace).toBe(before);
    await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS * 2);
    expect(backend.callsTo("saveState")).toHaveLength(0);
  });

  describe("spaces", () => {
    it("createSpace makes the space active with a first tab that has the space's defaults", async () => {
      const backend = new FakeBackend();
      const { store } = await openStore(backend);
      store.getState().createSpace({
        name: "Work",
        icon: "briefcase",
        color: "#e07a5f",
        cwd: "/srv/work",
        profileId: "fake",
        env: { STAGE: "work" },
      });

      const state = store.getState();
      expect(state.workspace.spaces.map((s) => s.name)).toHaveLength(2);
      const space = activeSpaceOf(state.workspace);
      expect(space).toMatchObject({
        name: "Work",
        icon: "briefcase",
        color: "#e07a5f",
        defaults: { cwd: "/srv/work", profileId: "fake", env: { STAGE: "work" } },
      });
      const ids = spaceItemIds(space);
      expect(ids).toHaveLength(1);
      expect(activeItemIdOf(state)).toBe(ids[0]);
    });

    it("a session started in a new tab uses the cwd, env and profile of the active space", async () => {
      const backend = new FakeBackend();
      const { store } = await openStore(backend);
      store.getState().createSpace({ name: "A", cwd: "/a", env: { WHO: "a" } });
      store.getState().createSpace({
        name: "B",
        cwd: "/b",
        profileId: "fake",
        env: { WHO: "b" },
      });
      store.getState().newTab();

      const space = activeSpaceOf(store.getState().workspace);
      expect(space.name).toBe("B");
      const newest = spaceItemIds(space).at(-1);
      const item = newest === undefined ? undefined : space.items[newest];
      const pane = item && item.layout.kind === "pane" ? item.layout.pane : undefined;
      if (!pane) throw new Error("no pane");
      expect(sessionStartOptions(space, pane)).toEqual({
        profileId: "fake",
        cwd: "/b",
        env: { WHO: "b" },
      });

      // The other space keeps its own; the first space has no defaults to add.
      const a = store.getState().workspace.spaces.find((s) => s.name === "A");
      const first = store.getState().workspace.spaces[0];
      const aPane = a && Object.values(a.items)[0]?.layout;
      expect(aPane && aPane.kind === "pane" && sessionStartOptions(a, aPane.pane)).toEqual({
        cwd: "/a",
        env: { WHO: "a" },
      });
      expect(first && Object.keys(first.defaults.env)).toEqual([]);
    });

    it("leaves the default profile and an empty env out of the start options", async () => {
      const { store } = await openStore(new FakeBackend());
      const space = activeSpaceOf(store.getState().workspace);
      const item = Object.values(space.items)[0];
      const pane = item && item.layout.kind === "pane" ? item.layout.pane : undefined;
      if (!pane) throw new Error("no pane");
      expect(sessionStartOptions(space, pane)).toEqual({});
    });

    it("activateSpaceAt switches by position and ignores positions that do not exist", async () => {
      const { store } = await openStore(new FakeBackend());
      const firstId = store.getState().workspace.activeSpaceId;
      store.getState().createSpace({ name: "Two" });
      store.getState().createSpace({ name: "Three" });
      expect(activeSpaceOf(store.getState().workspace).name).toBe("Three");

      store.getState().activateSpaceAt(0);
      expect(store.getState().workspace.activeSpaceId).toBe(firstId);
      store.getState().activateSpaceAt(1);
      expect(activeSpaceOf(store.getState().workspace).name).toBe("Two");
      store.getState().activateSpaceAt(8);
      store.getState().activateSpaceAt(-1);
      expect(activeSpaceOf(store.getState().workspace).name).toBe("Two");
      store.getState().activateSpace("missing");
      expect(activeSpaceOf(store.getState().workspace).name).toBe("Two");
    });

    it("an invalid new space (blank name) changes nothing", async () => {
      const { store } = await openStore(new FakeBackend());
      const before = store.getState().workspace;
      store.getState().createSpace({ name: "  " });
      expect(store.getState().workspace).toBe(before);
    });
  });
});

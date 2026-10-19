import {
  FakeBackend,
  PaneLocationTracker,
  STATE_SAVE_DELAY_MS,
  createDefaultWorkspace,
  createSequentialIds,
  layoutPanes,
  liveSessionIds,
  parseState,
  restoreWorkspace,
} from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeItemIdOf,
  activeSpaceOf,
  createWorkspaceStore,
  sessionStartOptions,
  spaceItemIds,
} from "./workspace-store";

const clock = { now: () => 1000 };

async function openStore(backend: FakeBackend) {
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const store = createWorkspaceStore({
    backend,
    workspace: restored.workspace,
    newId,
    clock,
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

  it("a new tab with options starts with that profile and folder, the rest from the space", async () => {
    const { store } = await openStore(new FakeBackend());
    store.getState().createSpace({ name: "Work", profileId: "pwsh", cwd: "/work" });
    store.getState().newTab({ profileId: "bash" });
    store.getState().newTab({ cwd: "/other" });
    store.getState().newTab();
    const space = activeSpaceOf(store.getState().workspace);
    const starts = spaceItemIds(space)
      .slice(1)
      .map((id) => {
        const item = space.items[id];
        const pane = item && layoutPanes(item.layout)[0];
        return pane && sessionStartOptions(space, pane);
      });
    expect(starts).toEqual([
      { profileId: "bash", cwd: "/work" },
      { profileId: "pwsh", cwd: "/other" },
      { profileId: "pwsh", cwd: "/work" },
    ]);
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

  it("activating a tab is saved in the workspace, and a restore brings it back", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    store.getState().newTab();
    const space = store.getState().workspace.spaces[0];
    if (!space) throw new Error("no space");
    const [first] = spaceItemIds(space);
    if (first === undefined) throw new Error("no tab");
    expect(activeItemIdOf(store.getState())).not.toBe(first);

    store.getState().activateItem(first);
    expect(activeItemIdOf(store.getState())).toBe(first);
    expect(store.getState().workspace.spaces[0]?.activeItemId).toBe(first);
    await store.getState().flush();

    const saved = parseState(backend.stateContent ?? "");
    expect(saved.ok && saved.workspace.spaces[0]?.activeItemId).toBe(first);
    const again = await openStore(backend);
    expect(activeItemIdOf(again.store.getState())).toBe(first);
  });

  it("activating an unknown tab, or the tab already active, changes nothing", async () => {
    const { store } = await openStore(new FakeBackend());
    const before = store.getState().workspace;
    store.getState().activateItem("ghost");
    store.getState().activateItem(activeItemIdOf(store.getState()) ?? "");
    expect(store.getState().workspace).toBe(before);
  });

  it("an active tab missing from the workspace falls back to the first one", () => {
    const ws = createDefaultWorkspace();
    const space = ws.spaces[0];
    if (!space) throw new Error("no space");
    const rest = { ...space };
    delete rest.activeItemId;
    const store = createWorkspaceStore({
      backend: new FakeBackend(),
      workspace: { ...ws, spaces: [rest] },
    });
    expect(activeItemIdOf(store.getState())).toBe(spaceItemIds(space)[0]);
  });

  it("each space keeps its own active tab when switching between them", async () => {
    const { store } = await openStore(new FakeBackend());
    store.getState().newTab();
    store.getState().createSpace({ name: "Two" });
    store.getState().newTab();
    const two = activeItemIdOf(store.getState());
    store.getState().activateSpaceAt(0);
    const mainFirst = spaceItemIds(activeSpaceOf(store.getState().workspace))[0];
    store.getState().activateItem(mainFirst ?? "");
    store.getState().activateSpaceAt(1);
    expect(activeItemIdOf(store.getState())).toBe(two);
    store.getState().activateSpaceAt(0);
    expect(activeItemIdOf(store.getState())).toBe(mainFirst);
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

  it("resetting a pinned tab ends its session and the new pane starts in the origin, which is saved", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    const spaceId = activeSpaceOf(store.getState().workspace).id;
    store.getState().editSpace(spaceId, { cwd: "/a" });
    store.getState().newTab();
    const itemId = spaceItemIds(activeSpaceOf(store.getState().workspace))[1];
    if (itemId === undefined) throw new Error("no new tab");
    const paneOf = () => {
      const item = activeSpaceOf(store.getState().workspace).items[itemId];
      const found = item && layoutPanes(item.layout)[0];
      if (!found) throw new Error("no pane");
      return found;
    };
    const old = paneOf();
    store.getState().attachSession(old.id, "41");
    store.getState().dispatch({ type: "item/pin", itemId });
    store.getState().editSpace(spaceId, { cwd: "/b" });

    store.getState().dispatch({ type: "item/reset", itemId });

    const fresh = paneOf();
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.sessionId).toBeUndefined();
    expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual([41]);
    const space = activeSpaceOf(store.getState().workspace);
    expect(sessionStartOptions(space, fresh).cwd).toBe("/a");
    expect(space.items[itemId]?.origin).toEqual({ cwd: "/a", profileId: "default" });

    await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
    const saved = parseState(backend.stateContent ?? "");
    const savedItem = saved.ok ? saved.workspace.spaces[0]?.items[itemId] : undefined;
    expect(savedItem?.origin).toEqual({ cwd: "/a", profileId: "default" });
  });

  it("a shell that ends marks its pane as exited with the code, and the state is saved", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    const space = store.getState().workspace.spaces[0];
    const item = space && Object.values(space.items)[0];
    const pane = item && layoutPanes(item.layout)[0];
    if (!item || !pane?.sessionId) throw new Error("no pane with a session");
    expect(pane.status).toBe("idle");

    await backend.write(Number(pane.sessionId), "exit 2\r");

    const after = store.getState().workspace.spaces[0]?.items[item.id];
    const exited = after && layoutPanes(after.layout)[0];
    expect(exited).toMatchObject({ status: "exited", exitCode: 2, sessionId: pane.sessionId });
    await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
    const saved = parseState(backend.stateContent ?? "");
    const savedItem = saved.ok ? saved.workspace.spaces[0]?.items[item.id] : undefined;
    expect(savedItem && layoutPanes(savedItem.layout)[0]).toMatchObject({
      status: "exited",
      exitCode: 2,
    });
  });

  it("a session no pane holds (a closed tab) changes nothing when it ends", async () => {
    const backend = new FakeBackend();
    const { store } = await openStore(backend);
    const space = store.getState().workspace.spaces[0];
    const itemId = space && spaceItemIds(space)[0];
    if (itemId === undefined) throw new Error("no tab");
    const [sessionId] = liveSessionIds(store.getState().workspace);
    store.getState().dispatch({ type: "item/close", itemId });
    const before = store.getState().workspace;
    await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
    const saves = backend.callsTo("saveState").length;

    // Closing the tab killed the session; the exit that follows finds no pane to mark.
    expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual([Number(sessionId)]);
    expect(store.getState().workspace).toBe(before);
    await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
    expect(backend.callsTo("saveState")).toHaveLength(saves);
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

    describe("sessionStartOptions with a git identity", () => {
      const paneOf = (space: ReturnType<typeof activeSpaceOf>) => {
        const item = Object.values(space.items)[0];
        const pane = item && item.layout.kind === "pane" ? item.layout.pane : undefined;
        if (!pane) throw new Error("no pane");
        return pane;
      };
      const identity = { name: "Ada Lovelace", email: "ada@example.com" };

      it("adds the author and committer variables to the environment", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().editSpace(store.getState().workspace.activeSpaceId, {
          gitIdentity: identity,
          env: { WHO: "a" },
        });
        const space = activeSpaceOf(store.getState().workspace);
        expect(sessionStartOptions(space, paneOf(space))).toEqual({
          env: {
            GIT_AUTHOR_NAME: "Ada Lovelace",
            GIT_COMMITTER_NAME: "Ada Lovelace",
            GIT_AUTHOR_EMAIL: "ada@example.com",
            GIT_COMMITTER_EMAIL: "ada@example.com",
            WHO: "a",
          },
        });
      });

      it("works without any other variable and leaves out a blank name or email", async () => {
        const { store } = await openStore(new FakeBackend());
        const id = store.getState().workspace.activeSpaceId;
        store.getState().editSpace(id, { gitIdentity: { name: "", email: "ada@example.com" } });
        const space = activeSpaceOf(store.getState().workspace);
        expect(sessionStartOptions(space, paneOf(space)).env).toEqual({
          GIT_AUTHOR_EMAIL: "ada@example.com",
          GIT_COMMITTER_EMAIL: "ada@example.com",
        });
      });

      it("lets a variable set explicitly on the space win, ignoring case", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().editSpace(store.getState().workspace.activeSpaceId, {
          gitIdentity: identity,
          env: { GIT_AUTHOR_NAME: "Explicit", git_committer_email: "me@example.com" },
        });
        const space = activeSpaceOf(store.getState().workspace);
        expect(sessionStartOptions(space, paneOf(space)).env).toEqual({
          GIT_AUTHOR_NAME: "Explicit",
          git_committer_email: "me@example.com",
          GIT_COMMITTER_NAME: "Ada Lovelace",
          GIT_AUTHOR_EMAIL: "ada@example.com",
        });
      });

      it("leaves the variables out once the identity is cleared", async () => {
        const { store } = await openStore(new FakeBackend());
        const id = store.getState().workspace.activeSpaceId;
        store.getState().editSpace(id, { gitIdentity: identity });
        store.getState().editSpace(id, { gitIdentity: { name: "", email: "" } });
        const space = activeSpaceOf(store.getState().workspace);
        expect(sessionStartOptions(space, paneOf(space))).toEqual({});
      });
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

    const names = (store: Awaited<ReturnType<typeof openStore>>["store"]) =>
      store.getState().workspace.spaces.map((s) => s.name);

    /** Starts a session for every pane of a space that has none; returns the ids it used. */
    const attachSessions = (
      store: Awaited<ReturnType<typeof openStore>>["store"],
      spaceName: string,
      firstId: number,
    ): string[] => {
      const space = store.getState().workspace.spaces.find((s) => s.name === spaceName);
      if (!space) throw new Error("no space");
      return Object.values(space.items).map((item, at) => {
        const sessionId = String(firstId + at);
        store.getState().attachSession(item.focusedPaneId, sessionId);
        return sessionId;
      });
    };

    describe("editSpace", () => {
      it("renames, recolors and re-icons the space and schedules one save", async () => {
        const backend = new FakeBackend();
        const { store } = await openStore(backend);
        const id = store.getState().workspace.activeSpaceId;
        store.getState().editSpace(id, { name: "  Home  ", color: "#4caf7d", icon: "🏠" });

        expect(activeSpaceOf(store.getState().workspace)).toMatchObject({
          name: "Home",
          color: "#4caf7d",
          icon: "🏠",
        });
        await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
        expect(backend.callsTo("saveState")).toHaveLength(1);
        const saved = parseState(backend.stateContent ?? "");
        expect(saved.ok && saved.workspace.spaces[0]).toMatchObject({ name: "Home", icon: "🏠" });
      });

      it("changes the start folder and replaces the environment; a blank folder clears it", async () => {
        const { store } = await openStore(new FakeBackend());
        const id = store.getState().workspace.activeSpaceId;
        store.getState().editSpace(id, { cwd: "/srv/a", env: { A: "1", B: "2" } });
        expect(activeSpaceOf(store.getState().workspace).defaults).toMatchObject({
          cwd: "/srv/a",
          env: { A: "1", B: "2" },
        });

        store.getState().editSpace(id, { cwd: "", env: { C: "3" } });
        const defaults = activeSpaceOf(store.getState().workspace).defaults;
        expect(defaults.cwd).toBeUndefined();
        expect(defaults.env).toEqual({ C: "3" });
      });

      it("sets the git identity, keeps it across other edits and clears it with blank fields", async () => {
        const backend = new FakeBackend();
        const { store } = await openStore(backend);
        const id = store.getState().workspace.activeSpaceId;
        const identity = { name: "Ada Lovelace", email: "ada@example.com" };
        store.getState().editSpace(id, { gitIdentity: identity });
        expect(activeSpaceOf(store.getState().workspace).defaults.gitIdentity).toEqual(identity);

        store.getState().editSpace(id, { cwd: "/srv/a" });
        expect(activeSpaceOf(store.getState().workspace).defaults.gitIdentity).toEqual(identity);

        await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
        const saved = parseState(backend.stateContent ?? "");
        expect(saved.ok && saved.workspace.spaces[0]?.defaults.gitIdentity).toEqual(identity);

        store.getState().editSpace(id, { gitIdentity: { name: "", email: "  " } });
        expect("gitIdentity" in activeSpaceOf(store.getState().workspace).defaults).toBe(false);
      });

      it("createSpace with a git identity stores it on the new space", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().createSpace({
          name: "Work",
          gitIdentity: { name: "Ada", email: "ada@example.com" },
        });
        const space = activeSpaceOf(store.getState().workspace);
        expect(space.name).toBe("Work");
        expect(space.defaults.gitIdentity).toEqual({ name: "Ada", email: "ada@example.com" });
        expect(spaceItemIds(space)).toHaveLength(1);
      });

      it("a blank name, an unknown space or no change leaves the workspace as it was", async () => {
        const backend = new FakeBackend();
        const { store } = await openStore(backend);
        const before = store.getState().workspace;
        const space = activeSpaceOf(before);
        store.getState().editSpace(space.id, { name: "   " });
        store.getState().editSpace("missing", { name: "X", color: "#000000" });
        store.getState().editSpace(space.id, { name: space.name, color: space.color });
        store.getState().editSpace(space.id, {});
        expect(store.getState().workspace).toBe(before);
        await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS * 2);
        expect(backend.callsTo("saveState")).toHaveLength(0);
      });
    });

    describe("deleteSpace", () => {
      it("ends the live sessions of the space, activates another and keeps the other sessions", async () => {
        const backend = new FakeBackend();
        const { store } = await openStore(backend);
        const [mainSession] = [...liveSessionIds(store.getState().workspace)];
        store.getState().createSpace({ name: "Work" });
        store.getState().newTab();
        const started = attachSessions(store, "Work", 91);
        expect(started).toHaveLength(2);
        const work = activeSpaceOf(store.getState().workspace);

        expect(store.getState().deleteSpace(work.id)).toBe(true);

        expect(names(store)).toEqual(["Main"]);
        expect(activeSpaceOf(store.getState().workspace).name).toBe("Main");
        expect(backend.callsTo("kill").map((call) => call.args[0])).toEqual(started.map(Number));
        expect([...liveSessionIds(store.getState().workspace)]).toEqual([mainSession]);
      });

      it("deleting another space keeps the active one and its active tab", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().createSpace({ name: "Two" });
        store.getState().createSpace({ name: "Three" });
        const two = store.getState().workspace.spaces[1];
        const three = activeItemIdOf(store.getState());
        if (!two) throw new Error("no space");

        store.getState().deleteSpace(two.id);

        expect(names(store)).toEqual(["Main", "Three"]);
        expect(activeSpaceOf(store.getState().workspace).name).toBe("Three");
        expect(activeItemIdOf(store.getState())).toBe(three);
      });

      it("deleting the active space activates a neighbor", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().createSpace({ name: "Two" });
        store.getState().createSpace({ name: "Three" });
        store.getState().activateSpaceAt(1);
        store.getState().deleteSpace(activeSpaceOf(store.getState().workspace).id);
        expect(names(store)).toEqual(["Main", "Three"]);
        expect(activeSpaceOf(store.getState().workspace).name).toBe("Three");
      });

      it("refuses the last space: nothing changes, no session ends, nothing is saved", async () => {
        const backend = new FakeBackend();
        const { store } = await openStore(backend);
        const before = store.getState().workspace;
        expect(store.getState().deleteSpace(before.activeSpaceId)).toBe(false);
        expect(store.getState().workspace).toBe(before);
        expect(backend.callsTo("kill")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS * 2);
        expect(backend.callsTo("saveState")).toHaveLength(0);
      });

      it("an unknown space is not deleted", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().createSpace({ name: "Two" });
        expect(store.getState().deleteSpace("missing")).toBe(false);
        expect(names(store)).toEqual(["Main", "Two"]);
      });
    });

    describe("moveSpace", () => {
      it("moves a space to a position; the active space does not change", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().createSpace({ name: "Two" });
        store.getState().createSpace({ name: "Three" });
        const active = store.getState().workspace.activeSpaceId;
        const [first] = store.getState().workspace.spaces;
        if (!first) throw new Error("no space");

        store.getState().moveSpace(first.id, 2);
        expect(names(store)).toEqual(["Two", "Three", "Main"]);
        store.getState().moveSpace(first.id, 1);
        expect(names(store)).toEqual(["Two", "Main", "Three"]);
        expect(store.getState().workspace.activeSpaceId).toBe(active);
      });

      it("clamps the position and ignores a move that changes nothing or an unknown space", async () => {
        const { store } = await openStore(new FakeBackend());
        store.getState().createSpace({ name: "Two" });
        const [first] = store.getState().workspace.spaces;
        if (!first) throw new Error("no space");
        store.getState().moveSpace(first.id, 99);
        expect(names(store)).toEqual(["Two", "Main"]);

        const before = store.getState().workspace;
        store.getState().moveSpace(first.id, 1);
        store.getState().moveSpace("missing", 0);
        expect(store.getState().workspace).toBe(before);
      });
    });

    it("an invalid new space (blank name) changes nothing", async () => {
      const { store } = await openStore(new FakeBackend());
      const before = store.getState().workspace;
      store.getState().createSpace({ name: "  " });
      expect(store.getState().workspace).toBe(before);
    });
  });

  describe("tree actions", () => {
    async function openTabs(count: number) {
      const backend = new FakeBackend();
      const { store } = await openStore(backend);
      for (let i = 1; i < count; i++) store.getState().newTab();
      const ids = () => spaceItemIds(activeSpaceOf(store.getState().workspace));
      return { store, ids };
    }

    it("groupItems makes the group where the first tab was and returns its id", async () => {
      const { store, ids } = await openTabs(4);
      const [a, b, c, d] = ids();
      if (!a || !b || !c || !d) throw new Error("expected 4 tabs");

      const groupId = store.getState().groupItems([b, c], "Work");

      const space = activeSpaceOf(store.getState().workspace);
      expect(space.tree.map((node) => node.kind)).toEqual(["item", "group", "item"]);
      const group = space.tree[1];
      expect(group).toMatchObject({ kind: "group", id: groupId, name: "Work", collapsed: false });
      expect(group?.kind === "group" && group.children.map((node) => node.id)).toEqual([b, c]);
      expect(ids()).toEqual([a, b, c, d]);
    });

    it("groupItems returns undefined and changes nothing for tabs that cannot be grouped", async () => {
      const { store, ids } = await openTabs(2);
      const [a, b] = ids();
      if (!a || !b) throw new Error("expected 2 tabs");
      store.getState().dispatch({ type: "item/pin", itemId: a });
      const before = store.getState().workspace;

      expect(store.getState().groupItems([a, b], "Work")).toBeUndefined();
      expect(store.getState().groupItems([b], "  ")).toBeUndefined();
      expect(store.getState().groupItems([], "Work")).toBeUndefined();
      expect(store.getState().workspace).toBe(before);
    });

    it("closeItems closes each tab, ends its session and moves the active tab to the neighbor", async () => {
      const { store, ids } = await openTabs(3);
      const [a, b, c] = ids();
      if (!a || !b || !c) throw new Error("expected 3 tabs");
      store.getState().attachSession(
        (() => {
          const space = activeSpaceOf(store.getState().workspace);
          const layout = space.items[b]?.layout;
          if (layout?.kind !== "pane") throw new Error("expected a pane");
          return layout.pane.id;
        })(),
        "77",
      );
      store.getState().activateItem(b);

      store.getState().closeItems([b, c]);

      expect(ids()).toEqual([a]);
      expect(activeItemIdOf(store.getState())).toBe(a);
    });

    it("closeOthers keeps the chosen tabs and the pinned ones, and the first chosen tab is active", async () => {
      const { store, ids } = await openTabs(5);
      const [a, b, c, d, e] = ids();
      if (!a || !b || !c || !d || !e) throw new Error("expected 5 tabs");
      store.getState().dispatch({ type: "item/pin", itemId: e });
      store.getState().activateItem(a);

      store.getState().closeOthers([c, d]);

      // Pinned tabs come first in the sidebar order.
      expect(ids()).toEqual([e, c, d]);
      expect(activeItemIdOf(store.getState())).toBe(c);
    });

    it("closeOthers with an unknown tab changes nothing", async () => {
      const { store } = await openTabs(3);
      const before = store.getState().workspace;
      store.getState().closeOthers(["missing"]);
      store.getState().closeOthers([]);
      expect(store.getState().workspace).toBe(before);
    });
  });

  describe("pane location", () => {
    async function openOne(backend: FakeBackend) {
      const { store } = await openStore(backend);
      const space = activeSpaceOf(store.getState().workspace);
      const item = space.items[spaceItemIds(space)[0] ?? ""];
      const pane = item && layoutPanes(item.layout)[0];
      if (!item || !pane) throw new Error("no pane");
      const paneNow = () => {
        const now = activeSpaceOf(store.getState().workspace).items[item.id];
        const found = now && layoutPanes(now.layout).find((p) => p.id === pane.id);
        if (!found) throw new Error("the pane is gone");
        return found;
      };
      return { store, itemId: item.id, paneId: pane.id, paneNow };
    }

    it("setPaneLocation puts the folder and the branch on the pane and schedules a save", async () => {
      const backend = new FakeBackend();
      const { store, paneId, paneNow } = await openOne(backend);
      store.getState().setPaneLocation(paneId, { cwd: "/proj", gitBranch: "main" });
      expect(paneNow()).toMatchObject({ cwd: "/proj", gitBranch: "main" });

      await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
      const saved = parseState(backend.stateContent ?? "");
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        const savedItem = Object.values(activeSpaceOf(saved.workspace).items)[0];
        const pane = savedItem && layoutPanes(savedItem.layout)[0];
        expect(pane).toMatchObject({ cwd: "/proj", gitBranch: "main" });
      }
    });

    it("the same location again changes nothing and saves nothing", async () => {
      const backend = new FakeBackend();
      const { store, paneId } = await openOne(backend);
      store.getState().setPaneLocation(paneId, { cwd: "/proj", gitBranch: "main" });
      await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS);
      const saves = backend.callsTo("saveState").length;
      const before = store.getState().workspace;

      store.getState().setPaneLocation(paneId, { cwd: "/proj", gitBranch: "main" });
      await vi.advanceTimersByTimeAsync(STATE_SAVE_DELAY_MS * 2);
      expect(store.getState().workspace).toBe(before);
      expect(backend.callsTo("saveState")).toHaveLength(saves);
    });

    it("a folder without a branch takes the branch away", async () => {
      const { store, paneId, paneNow } = await openOne(new FakeBackend());
      store.getState().setPaneLocation(paneId, { cwd: "/proj", gitBranch: "main" });
      store.getState().setPaneLocation(paneId, { cwd: "/tmp" });
      expect(paneNow().cwd).toBe("/tmp");
      expect(paneNow()).not.toHaveProperty("gitBranch");
    });

    it("finds a pane that moved to another tab, and ignores one that is gone", async () => {
      const { store, itemId, paneId } = await openOne(new FakeBackend());
      store.getState().dispatch({ type: "pane/split", itemId, paneId, dir: "row", side: "after" });
      const item = activeSpaceOf(store.getState().workspace).items[itemId];
      const other = item && layoutPanes(item.layout).find((p) => p.id !== paneId);
      if (!other) throw new Error("no second pane");
      store.getState().dispatch({ type: "pane/detach", itemId, paneId: other.id });

      store.getState().setPaneLocation(other.id, { cwd: "/moved", gitBranch: "dev" });
      const space = activeSpaceOf(store.getState().workspace);
      const holder = Object.values(space.items).find(
        (it) => it.id !== itemId && layoutPanes(it.layout).some((p) => p.id === other.id),
      );
      const moved = holder && layoutPanes(holder.layout).find((p) => p.id === other.id);
      expect(moved).toMatchObject({ cwd: "/moved", gitBranch: "dev" });

      const before = store.getState().workspace;
      store.getState().setPaneLocation("no-such-pane", { cwd: "/x" });
      expect(store.getState().workspace).toBe(before);
    });

    it("the output of a session drives the folder and branch of its pane, as the app wires it", async () => {
      const backend = new FakeBackend({
        gitRepos: { "/proj": { branch: "main", detached: false } },
        home: "/home/fake",
      });
      const { store, paneId, paneNow } = await openOne(backend);
      const id = await backend.createSession({ cols: 80, rows: 24 });
      store.getState().attachSession(paneId, String(id));
      const tracker = new PaneLocationTracker({
        gitInfo: (folder) => backend.gitInfo(folder),
        onLocation: (location) => store.getState().setPaneLocation(paneId, location),
      });
      backend.onOutput(id, (bytes) => tracker.feed(bytes));
      const type = async (line: string) => {
        await backend.write(id, `${line}\r`);
        await vi.advanceTimersByTimeAsync(0);
      };
      await vi.advanceTimersByTimeAsync(0);
      // The folder the shell starts in is not one the pane chose: it is not recorded.
      expect(paneNow()).not.toHaveProperty("cwd");
      expect(paneNow()).not.toHaveProperty("gitBranch");

      await type("cd /proj");
      expect(paneNow()).toMatchObject({ cwd: "/proj", gitBranch: "main", sessionId: String(id) });

      // The branch changes under the shell's feet; the next prompt notices.
      backend.setGitRepo("/proj", { branch: "feature/x", detached: false });
      expect(paneNow().gitBranch).toBe("main");
      await type("true");
      expect(paneNow().gitBranch).toBe("feature/x");

      await type("cd src");
      expect(paneNow()).toMatchObject({ cwd: "/proj/src", gitBranch: "feature/x" });
      await type("cd /");
      expect(paneNow().cwd).toBe("/");
      expect(paneNow()).not.toHaveProperty("gitBranch");
    });
  });
});

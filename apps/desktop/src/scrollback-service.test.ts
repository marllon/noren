import { beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, ManualClock, createDefaultWorkspace, layoutPanes } from "@noren/model";
import type { Pane, Workspace } from "@noren/model";
import { configManager } from "./config-store";
import {
  clearStaleSnapshots,
  currentScrollbackSaver,
  hasTerminalSnapshot,
  registerTerminalSnapshot,
  scrollbackClock,
  startScrollback,
} from "./scrollback-service";
import { createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

// The pieces together: the clock, the terminals, the workspace and the files. The window closing is
// simulated by calling the listeners the service added.

type Listener = () => void;

function events() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener: (type: string, listener: unknown) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as Listener]);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    count: (type: string) => (listeners.get(type) ?? []).length,
  } as const;
}

function firstPane(workspace: Workspace): Pane {
  const space = workspace.spaces[0];
  const item = space && Object.values(space.items)[0];
  const pane = item && layoutPanes(item.layout)[0];
  if (!pane) throw new Error("no pane");
  return pane;
}

function setup(options: { config?: string | null; spaceSaves?: boolean } = {}) {
  const clock = new ManualClock();
  const backend = new FakeBackend({ clock, config: options.config ?? null });
  const base = createDefaultWorkspace();
  const workspace: Workspace = {
    ...base,
    spaces: base.spaces.map((space) => ({ ...space, saveScrollback: options.spaceSaves ?? true })),
  };
  const store: WorkspaceStore = createWorkspaceStore({ backend, workspace });
  const window = events();
  return { clock, backend, store, window, pane: firstPane(workspace) };
}

beforeEach(() => {
  currentScrollbackSaver()?.stop();
  configManager.stop();
  configManager.apply(null);
});

describe("startScrollback", () => {
  it("saves the pane a minute after it printed, and notes in the workspace that it has a file", async () => {
    const { clock, backend, store, window, pane } = setup();
    registerTerminalSnapshot(pane.id, () => "line one\r\nline two");
    const saver = startScrollback({ store, backend, clock, events: window });
    saver.noteActivity(pane.id);

    clock.advance(60_000);
    await saver.flush();
    expect(backend.scrollbackFiles).toEqual({ [pane.id]: "line one\nline two" });
    expect(firstPane(store.getState().workspace).scrollbackRef).toBe(`${pane.id}.txt`);
  });

  it("saves when the window closes, before the state is written, so the note is in the state", async () => {
    const { clock, backend, store, window, pane } = setup();
    registerTerminalSnapshot(pane.id, () => "closing text");
    const saver = startScrollback({ store, backend, clock, events: window });
    saver.noteActivity(pane.id);

    // The listeners of the closing, in the order they were added: the saver's first.
    expect(window.count("beforeunload")).toBe(1);
    expect(window.count("pagehide")).toBe(1);
    window.fire("beforeunload");
    // The write was started and the note made in the same turn, before anything is waited for.
    expect(backend.callsTo("saveScrollback")).toHaveLength(1);
    expect(firstPane(store.getState().workspace).scrollbackRef).toBe(`${pane.id}.txt`);
    // So the state written next already has it.
    await store.getState().flush();
    expect(backend.stateContent).toContain(`${pane.id}.txt`);
    await saver.flush();
    expect(backend.scrollbackFiles).toEqual({ [pane.id]: "closing text" });
  });

  it("writes nothing for a space that never saves", async () => {
    const { clock, backend, store, window, pane } = setup({ spaceSaves: false });
    registerTerminalSnapshot(pane.id, () => "secret");
    const saver = startScrollback({ store, backend, clock, events: window });
    saver.noteActivity(pane.id);
    clock.advance(60_000);
    window.fire("beforeunload");
    await saver.flush();
    expect(backend.callsTo("saveScrollback")).toEqual([]);
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
    expect(backend.scrollbackFiles).toEqual({});
  });

  it("writes nothing when the setting of the app says never", async () => {
    const { clock, backend, store, window, pane } = setup({
      config: '{ "terminal": { "saveScrollback": false } }',
    });
    await configManager.start(backend);
    registerTerminalSnapshot(pane.id, () => "secret");
    const saver = startScrollback({ store, backend, clock, events: window });
    saver.noteActivity(pane.id);
    clock.advance(60_000);
    window.fire("pagehide");
    await saver.flush();
    expect(backend.callsTo("saveScrollback")).toEqual([]);
    expect(backend.scrollbackFiles).toEqual({});
  });

  it("removes the files at once when the setting is turned off, and takes the note off the pane", async () => {
    const { clock, backend, store, window, pane } = setup();
    await configManager.start(backend);
    registerTerminalSnapshot(pane.id, () => "kept for now");
    const saver = startScrollback({ store, backend, clock, events: window });
    saver.noteActivity(pane.id);
    clock.advance(60_000);
    await saver.flush();
    expect(Object.keys(backend.scrollbackFiles)).toEqual([pane.id]);

    backend.setConfig('{ "terminal": { "saveScrollback": false } }');
    await saver.flush();
    expect(backend.scrollbackFiles).toEqual({});
    expect(firstPane(store.getState().workspace).scrollbackRef).toBeUndefined();

    // Back on: the pane is saved again when it prints.
    backend.setConfig('{ "terminal": { "saveScrollback": true } }');
    saver.noteActivity(pane.id);
    await saver.flush();
    expect(Object.keys(backend.scrollbackFiles)).toEqual([pane.id]);
  });

  it("forgets the terminal of a pane that is no longer in the workspace", async () => {
    const { clock, backend, store, window, pane } = setup();
    registerTerminalSnapshot(pane.id, () => "open");
    registerTerminalSnapshot("closed-pane", () => "closed");
    const saver = startScrollback({ store, backend, clock, events: window });
    expect(hasTerminalSnapshot("closed-pane")).toBe(true);
    await saver.flush();
    expect(hasTerminalSnapshot("closed-pane")).toBe(false);
    expect(hasTerminalSnapshot(pane.id)).toBe(true);
    // And the one that closed was never saved.
    saver.noteActivity("closed-pane");
    await saver.flush();
    expect(backend.callsTo("saveScrollback")).toEqual([]);
  });

  it("uses the clock of the fake shell in web mode and the real one otherwise", () => {
    const fake = new FakeBackend();
    expect(scrollbackClock(fake)).toBe(fake.clock);
    const other = { ...fake } as unknown as Parameters<typeof scrollbackClock>[0];
    expect(scrollbackClock(other)).not.toBe(fake.clock);
  });
});

describe("clearStaleSnapshots", () => {
  it("removes the file and the note of a pane the settings no longer allow", async () => {
    const { backend, store, pane } = setup();
    const itemId = Object.keys(store.getState().workspace.spaces[0]?.items ?? {})[0] ?? "";
    store.getState().dispatch({
      type: "pane/set-scrollback",
      itemId,
      paneId: pane.id,
      ref: `${pane.id}.txt`,
    });
    backend.setScrollback(pane.id, "old");
    await clearStaleSnapshots(store, backend, [{ paneId: pane.id, itemId, remove: true }]);
    expect(backend.scrollbackFiles).toEqual({});
    expect(firstPane(store.getState().workspace).scrollbackRef).toBeUndefined();
  });

  it("takes the note off a pane whose file is gone without asking the backend to remove anything", async () => {
    const { backend, store, pane } = setup();
    const itemId = Object.keys(store.getState().workspace.spaces[0]?.items ?? {})[0] ?? "";
    store.getState().dispatch({
      type: "pane/set-scrollback",
      itemId,
      paneId: pane.id,
      ref: `${pane.id}.txt`,
    });
    await clearStaleSnapshots(store, backend, [{ paneId: pane.id, itemId, remove: false }]);
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
    expect(firstPane(store.getState().workspace).scrollbackRef).toBeUndefined();
  });

  it("keeps the note when the file cannot be removed, so the next start tries again", async () => {
    const { backend, store, pane } = setup();
    const itemId = Object.keys(store.getState().workspace.spaces[0]?.items ?? {})[0] ?? "";
    store.getState().dispatch({
      type: "pane/set-scrollback",
      itemId,
      paneId: pane.id,
      ref: `${pane.id}.txt`,
    });
    backend.setScrollback(pane.id, "old");
    backend.setScrollbackFailure(new Error("locked"));
    const errors: unknown[] = [];
    await clearStaleSnapshots(
      store,
      backend,
      [{ paneId: pane.id, itemId, remove: true }],
      (error) => errors.push(error),
    );
    expect(errors).toHaveLength(1);
    expect(firstPane(store.getState().workspace).scrollbackRef).toBe(`${pane.id}.txt`);
    expect(backend.scrollbackFiles).toEqual({ [pane.id]: "old" });
  });
});

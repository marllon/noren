import { beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, ManualClock, layoutPanes, treeItemIds } from "@noren/model";
import type { Id, Item, Workspace } from "@noren/model";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";
import { configManager } from "./config-store";
import { reopenClosed } from "./reopen-closed";
import { restoredScrollbackOf, setRestoredScrollback } from "./scrollback-restore";
import {
  currentScrollbackSaver,
  registerTerminalSnapshot,
  startScrollback,
} from "./scrollback-service";
import { createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

// A tab that closes keeps its scrollback, one that leaves the stack of closed tabs takes its file
// with it, and reopening shows the old output again: the pieces together, over the fake backend.

const noEvents = { addEventListener: () => undefined };

/** Lets the writes that the closing starts after the action finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tab(name: string, options: { ref?: boolean } = {}): Item {
  return fixtureTab(`i-${name}`, fixturePane(`p-${name}`, { cwd: `/srv/${name}`, ...options }));
}

interface Setup {
  backend: FakeBackend;
  store: WorkspaceStore;
}

function setup(workspace: Workspace, options: { config?: string } = {}): Setup {
  const clock = new ManualClock();
  const backend = new FakeBackend({ clock, config: options.config ?? null });
  const store = createWorkspaceStore({ backend, workspace });
  startScrollback({ store, backend, clock, events: noEvents });
  return { backend, store };
}

function workspaceOf(items: readonly Item[], saves = true): Workspace {
  return {
    version: 2,
    spaces: [fixtureSpace("s1", items, saves)],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  };
}

/** What each tab's terminal would serialize: `<name> output`. */
function giveTerminals(items: readonly Item[]): void {
  for (const item of items) {
    for (const pane of layoutPanes(item.layout)) {
      registerTerminalSnapshot(pane.id, () => `${pane.id} output`);
    }
  }
}

const treeOf = (store: WorkspaceStore, spaceId = "s1"): Id[] => {
  const space = store.getState().workspace.spaces.find((s) => s.id === spaceId);
  return space ? treeItemIds(space.tree) : [];
};

beforeEach(() => {
  currentScrollbackSaver()?.stop();
  configManager.stop();
  configManager.apply(null);
  setRestoredScrollback(new Map());
});

describe("closing a tab", () => {
  it("writes the snapshot of each of its panes at once, and notes the file in the closed entry", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));

    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();

    // No minute has passed and nothing printed since: closing is what saved it.
    expect(backend.scrollbackFiles).toEqual({ "p-a": "p-a output" });
    const entry = store.getState().workspace.closed[0];
    expect(entry && layoutPanes(entry.item.layout)[0]?.scrollbackRef).toBe("p-a.txt");
  });

  it("keeps the older file when the terminal has nothing to say (empty or already gone)", async () => {
    const items = [tab("a", { ref: true }), tab("b")];
    giveTerminals([items[1] as Item]);
    registerTerminalSnapshot("p-a", () => {
      throw new Error("the terminal is disposed");
    });
    const { backend, store } = setup(workspaceOf(items));
    backend.setScrollback("p-a", "from a minute ago");

    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();
    expect(backend.scrollbackFiles).toEqual({ "p-a": "from a minute ago" });
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
  });

  it("writes nothing for a space that never saves, and removes the file it had", async () => {
    const items = [tab("a", { ref: true }), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items, false));
    backend.setScrollback("p-a", "left by a time the space saved");

    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();
    expect(backend.callsTo("saveScrollback")).toEqual([]);
    expect(backend.scrollbackFiles).toEqual({});
    const entry = store.getState().workspace.closed[0];
    expect(entry && layoutPanes(entry.item.layout)[0]?.scrollbackRef).toBeUndefined();
  });

  it("writes nothing when the setting of the app says never", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const config = '{ "terminal": { "saveScrollback": false } }';
    const { backend, store } = setup(workspaceOf(items), { config });
    await configManager.start(backend);

    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();
    expect(backend.callsTo("saveScrollback")).toEqual([]);
    expect(backend.scrollbackFiles).toEqual({});
  });

  it("saves every pane of a split tab", async () => {
    const split: Item = {
      ...tab("a"),
      layout: {
        kind: "split",
        dir: "row",
        sizes: [50, 50],
        children: [
          { kind: "pane", pane: fixturePane("p-a1", { cwd: "/x" }) },
          { kind: "pane", pane: fixturePane("p-a2", { cwd: "/y" }) },
        ],
      },
      focusedPaneId: "p-a1",
    };
    giveTerminals([split]);
    const { backend, store } = setup(workspaceOf([split, tab("b")]));

    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();
    expect(Object.keys(backend.scrollbackFiles).sort()).toEqual(["p-a1", "p-a2"]);
  });
});

describe("the stack of closed tabs", () => {
  it("the 51st closed tab removes the file of the oldest and no other", async () => {
    const items = Array.from({ length: 52 }, (_, n) => tab(`t${n}`, { ref: true }));
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));
    for (const item of items) backend.setScrollback(layoutPanes(item.layout)[0]?.id ?? "", "old");

    for (const item of items.slice(0, 50)) {
      store.getState().dispatch({ type: "item/close", itemId: item.id });
    }
    await settle();
    expect(store.getState().workspace.closed).toHaveLength(50);
    expect(backend.callsTo("deleteScrollback")).toEqual([]);

    store.getState().dispatch({ type: "item/close", itemId: "i-t50" });
    await settle();
    expect(store.getState().workspace.closed).toHaveLength(50);
    expect(backend.callsTo("deleteScrollback").map((call) => call.args[0])).toEqual(["p-t0"]);
    expect(backend.scrollbackFiles["p-t0"]).toBeUndefined();
    expect(backend.scrollbackFiles["p-t1"]).toBe("p-t1 output");
    expect(backend.scrollbackFiles["p-t50"]).toBe("p-t50 output");
    // The tab that is still open and the one pushed out of nothing are not touched.
    expect(backend.scrollbackFiles["p-t51"]).toBe("old");
  });

  it("the file of a tab that is reopened is not removed", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));
    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();
    store.getState().dispatch({ type: "item/reopen" });
    await settle();
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
    expect(backend.scrollbackFiles["p-a"]).toBe("p-a output");
  });

  it("the file of a pane of a split that was closed is removed", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));
    backend.setScrollback("p-a", "text");
    store
      .getState()
      .dispatch({ type: "pane/set-scrollback", itemId: "i-a", paneId: "p-a", ref: "p-a.txt" });
    store.getState().dispatch({
      type: "pane/split",
      itemId: "i-a",
      paneId: "p-a",
      dir: "row",
      side: "after",
    });
    store.getState().dispatch({ type: "pane/close", itemId: "i-a", paneId: "p-a" });
    await settle();
    expect(backend.scrollbackFiles).toEqual({});
  });
});

describe("reopenClosed", () => {
  const options = (store: WorkspaceStore, backend: FakeBackend, itemId?: Id) => ({
    store,
    backend,
    enabled: () => true,
    now: () => new Date(2026, 9, 19, 9, 30).getTime(),
    ...(itemId !== undefined ? { itemId } : {}),
  });

  it("puts the tab back in its place, shows its old output dimmed under the marker, and makes the space active", async () => {
    const items = [tab("a"), tab("b"), tab("c")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));
    store.getState().dispatch({ type: "item/close", itemId: "i-b" });
    await settle();
    expect(treeOf(store)).toEqual(["i-a", "i-c"]);

    expect(await reopenClosed(options(store, backend))).toBe(true);
    expect(treeOf(store)).toEqual(["i-a", "i-b", "i-c"]);
    expect(store.getState().workspace.closed).toEqual([]);
    const text = restoredScrollbackOf("p-b") ?? "";
    expect(text).toContain("p-b output");
    expect(text).toContain("session restored 2026-10-19 09:30");
    // Dimmed (SGR 2), as at the start of the app.
    expect(text).toContain("\x1b[2m");
    // The pane keeps its folder and has no session: the view starts a new shell in it.
    const back = store.getState().workspace.spaces[0]?.items["i-b"];
    const pane = back && layoutPanes(back.layout)[0];
    expect(pane?.cwd).toBe("/srv/b");
    expect(pane?.sessionId).toBeUndefined();
  });

  it("answers false, and changes nothing, when nothing is closed", async () => {
    const { backend, store } = setup(workspaceOf([tab("a")]));
    const before = store.getState().workspace;
    expect(await reopenClosed(options(store, backend))).toBe(false);
    expect(store.getState().workspace).toBe(before);
  });

  it("two reopens in a row bring back the two tabs closed last, newest first", async () => {
    const items = [tab("a"), tab("b"), tab("c"), tab("d")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));
    for (const id of ["i-b", "i-c", "i-d"])
      store.getState().dispatch({ type: "item/close", itemId: id });
    await settle();

    const results = await Promise.all([
      reopenClosed(options(store, backend)),
      reopenClosed(options(store, backend)),
    ]);
    expect(results).toEqual([true, true]);
    expect(treeOf(store)).toEqual(["i-a", "i-c", "i-d"]);
    expect(store.getState().workspace.closed.map((entry) => entry.item.id)).toEqual(["i-b"]);
  });

  it("reopens a given tab, and not the newest, when asked", async () => {
    const items = [tab("a"), tab("b"), tab("c")];
    giveTerminals(items);
    const { backend, store } = setup(workspaceOf(items));
    for (const id of ["i-a", "i-b"]) store.getState().dispatch({ type: "item/close", itemId: id });
    await settle();
    expect(await reopenClosed(options(store, backend, "i-a"))).toBe(true);
    expect(treeOf(store)).toEqual(["i-a", "i-c"]);
    expect(await reopenClosed(options(store, backend, "i-a"))).toBe(false);
  });

  it("shows nothing for a space that never saves, removes the file, and still brings the tab back", async () => {
    // The space saved when the tab closed; the setting changed while it was closed.
    const closedTab = tab("a", { ref: true });
    const workspace: Workspace = {
      ...workspaceOf([tab("b")], false),
      closed: [{ item: closedTab, spaceId: "s1", closedAt: 1 }],
    };
    const { backend, store } = setup(workspace);
    backend.setScrollback("p-a", "kept while the space saved");

    expect(await reopenClosed(options(store, backend))).toBe(true);
    expect(restoredScrollbackOf("p-a")).toBeUndefined();
    expect(backend.scrollbackFiles["p-a"]).toBeUndefined();
    expect(treeOf(store)).toEqual(["i-b", "i-a"]);
    const back = store.getState().workspace.spaces[0]?.items["i-a"];
    expect(back && layoutPanes(back.layout)[0]?.scrollbackRef).toBeUndefined();
  });

  it("shows nothing when the setting of the app says never", async () => {
    const closedTab = tab("a", { ref: true });
    const workspace: Workspace = {
      ...workspaceOf([tab("b")]),
      closed: [{ item: closedTab, spaceId: "s1", closedAt: 1 }],
    };
    const { backend, store } = setup(workspace);
    backend.setScrollback("p-a", "kept");
    expect(await reopenClosed({ ...options(store, backend), enabled: () => false })).toBe(true);
    expect(restoredScrollbackOf("p-a")).toBeUndefined();
    expect(backend.scrollbackFiles["p-a"]).toBeUndefined();
  });

  it("brings the tab back without the old output when its file is gone, and forgets the note", async () => {
    // The note says there is a file; there is none.
    const workspace: Workspace = {
      ...workspaceOf([tab("b")]),
      closed: [{ item: tab("a", { ref: true }), spaceId: "s1", closedAt: 1 }],
    };
    const { backend, store } = setup(workspace);
    expect(await reopenClosed(options(store, backend))).toBe(true);
    expect(restoredScrollbackOf("p-a")).toBeUndefined();
    const back = store.getState().workspace.spaces[0]?.items["i-a"];
    expect(back && layoutPanes(back.layout)[0]?.scrollbackRef).toBeUndefined();
  });

  it("a snapshot that cannot be read does not stop the tab from coming back", async () => {
    const closedTab = tab("a", { ref: true });
    const workspace: Workspace = {
      ...workspaceOf([tab("b")]),
      closed: [{ item: closedTab, spaceId: "s1", closedAt: 1 }],
    };
    const { backend, store } = setup(workspace);
    const failing = {
      loadScrollback: () => Promise.reject(new Error("the disk is gone")),
      deleteScrollback: () => Promise.resolve(),
    };
    expect(await reopenClosed({ ...options(store, backend), backend: failing })).toBe(true);
    expect(treeOf(store)).toEqual(["i-b", "i-a"]);
    expect(restoredScrollbackOf("p-a")).toBeUndefined();
    // The note stays, so the next start tries again.
    const back = store.getState().workspace.spaces[0]?.items["i-a"];
    expect(back && layoutPanes(back.layout)[0]?.scrollbackRef).toBe("p-a.txt");
  });
});

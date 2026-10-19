import { beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, ManualClock, layoutPanes, treeItemIds } from "@noren/model";
import type { Id, Item, Workspace } from "@noren/model";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";
import { closedChanges } from "./closed-scrollback";
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

// A tab put in the archive keeps its scrollback, restoring it shows the old output again, and
// deleting it takes the file with it: the pieces together, over the fake backend.

const noEvents = { addEventListener: () => undefined };

/** Lets the writes that archiving starts after the action finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tab(name: string, options: { ref?: boolean } = {}): Item {
  return fixtureTab(`i-${name}`, fixturePane(`p-${name}`, { cwd: `/srv/${name}`, ...options }));
}

function setup(items: readonly Item[], saves = true, archive: Workspace["archive"] = []) {
  const clock = new ManualClock();
  const backend = new FakeBackend({ clock, config: null });
  const workspace: Workspace = {
    version: 2,
    spaces: [fixtureSpace("s1", items, saves)],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive,
  };
  const store = createWorkspaceStore({ backend, workspace });
  startScrollback({ store, backend, clock, events: noEvents });
  return { backend, store };
}

function giveTerminals(items: readonly Item[]): void {
  for (const item of items) {
    for (const pane of layoutPanes(item.layout)) {
      registerTerminalSnapshot(pane.id, () => `${pane.id} output`);
    }
  }
}

const treeOf = (store: WorkspaceStore): Id[] => {
  const space = store.getState().workspace.spaces[0];
  return space ? treeItemIds(space.tree) : [];
};

const restoreOptions = (store: WorkspaceStore, backend: FakeBackend, itemId: Id) => ({
  store,
  backend,
  enabled: () => true,
  now: () => new Date(2026, 9, 19, 9, 30).getTime(),
  itemId,
  from: "archive" as const,
});

beforeEach(() => {
  currentScrollbackSaver()?.stop();
  configManager.stop();
  configManager.apply(null);
  setRestoredScrollback(new Map());
});

describe("archiving a tab", () => {
  it("writes the snapshot of its panes as it leaves, and notes the file in the archive entry", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(items);

    store.getState().dispatch({ type: "item/archive", itemId: "i-a" });
    await settle();

    expect(backend.scrollbackFiles).toEqual({ "p-a": "p-a output" });
    const entry = store.getState().workspace.archive[0];
    expect(entry && layoutPanes(entry.item.layout)[0]?.scrollbackRef).toBe("p-a.txt");
  });

  it("writes nothing for a space that never saves, and removes the file it had", async () => {
    const items = [tab("a", { ref: true }), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(items, false);
    backend.setScrollback("p-a", "left by a time the space saved");

    store.getState().dispatch({ type: "item/archive", itemId: "i-a" });
    await settle();
    expect(backend.callsTo("saveScrollback")).toEqual([]);
    expect(backend.scrollbackFiles).toEqual({});
  });

  it("the file stays through the archive: nothing is removed while the tab sits there", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(items);
    store.getState().dispatch({ type: "item/archive", itemId: "i-a" });
    await settle();
    store.getState().dispatch({ type: "item/archive", itemId: "i-b" });
    await settle();
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
    expect(Object.keys(backend.scrollbackFiles).sort()).toEqual(["p-a", "p-b"]);
  });
});

describe("restoring an archived tab", () => {
  it("puts the tab back in its place, shows its old output dimmed under the marker, in its folder", async () => {
    const items = [tab("a"), tab("b"), tab("c")];
    giveTerminals(items);
    const { backend, store } = setup(items);
    store.getState().dispatch({ type: "item/archive", itemId: "i-b" });
    await settle();
    expect(treeOf(store)).toEqual(["i-a", "i-c"]);

    expect(await reopenClosed(restoreOptions(store, backend, "i-b"))).toBe(true);
    expect(treeOf(store)).toEqual(["i-a", "i-b", "i-c"]);
    expect(store.getState().workspace.archive).toEqual([]);
    const text = restoredScrollbackOf("p-b") ?? "";
    expect(text).toContain("p-b output");
    expect(text).toContain("session restored 2026-10-19 09:30");
    expect(text).toContain("\x1b[2m");
    const back = store.getState().workspace.spaces[0]?.items["i-b"];
    const pane = back && layoutPanes(back.layout)[0];
    expect(pane?.cwd).toBe("/srv/b");
    expect(pane?.sessionId).toBeUndefined();
    // The tab is the one on screen.
    expect(store.getState().workspace.spaces[0]?.activeItemId).toBe("i-b");
    // The file is still where it was: the tab that is open again owns it.
    await settle();
    expect(backend.callsTo("deleteScrollback")).toEqual([]);
    expect(backend.scrollbackFiles["p-b"]).toBe("p-b output");
  });

  it("answers false and changes nothing for a tab that is not archived, a closed one included", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(items);
    store.getState().dispatch({ type: "item/close", itemId: "i-b" });
    await settle();
    const before = store.getState().workspace;
    expect(await reopenClosed(restoreOptions(store, backend, "i-b"))).toBe(false);
    expect(await reopenClosed(restoreOptions(store, backend, "nope"))).toBe(false);
    expect(store.getState().workspace).toBe(before);
    // Asking the archive for "the last one" has no meaning: it needs an item.
    const { store: s, backend: b, enabled, now, from } = restoreOptions(store, backend, "i-b");
    expect(await reopenClosed({ store: s, backend: b, enabled, now, from })).toBe(false);
  });

  it("a closed tab still comes back from the closed stack when asked by its id", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(items);
    store.getState().dispatch({ type: "item/close", itemId: "i-b" });
    await settle();
    const closedOptions = { ...restoreOptions(store, backend, "i-b"), from: "closed" as const };
    expect(await reopenClosed(closedOptions)).toBe(true);
    expect(treeOf(store)).toEqual(["i-a", "i-b"]);
  });

  it("shows nothing when the setting of the app says never, removes the file, and still restores the tab", async () => {
    const archived = tab("a", { ref: true });
    const { backend, store } = setup([tab("b")], true, [
      { item: archived, spaceId: "s1", archivedAt: 1 },
    ]);
    backend.setScrollback("p-a", "kept");
    const options = { ...restoreOptions(store, backend, "i-a"), enabled: () => false };
    expect(await reopenClosed(options)).toBe(true);
    expect(restoredScrollbackOf("p-a")).toBeUndefined();
    expect(backend.scrollbackFiles["p-a"]).toBeUndefined();
    expect(treeOf(store)).toEqual(["i-b", "i-a"]);
  });

  it("brings the tab back without the old output when its file is gone", async () => {
    const { backend, store } = setup([tab("b")], true, [
      { item: tab("a", { ref: true }), spaceId: "s1", archivedAt: 1 },
    ]);
    expect(await reopenClosed(restoreOptions(store, backend, "i-a"))).toBe(true);
    expect(restoredScrollbackOf("p-a")).toBeUndefined();
    const back = store.getState().workspace.spaces[0]?.items["i-a"];
    expect(back && layoutPanes(back.layout)[0]?.scrollbackRef).toBeUndefined();
  });
});

describe("deleting from the library", () => {
  it("an archived tab takes its file with it, and no other", async () => {
    const items = [tab("a"), tab("b"), tab("c")];
    giveTerminals(items);
    const { backend, store } = setup(items);
    store.getState().dispatch({ type: "item/archive", itemId: "i-a" });
    store.getState().dispatch({ type: "item/archive", itemId: "i-b" });
    await settle();
    expect(Object.keys(backend.scrollbackFiles).sort()).toEqual(["p-a", "p-b"]);

    store.getState().dispatch({ type: "archive/delete", itemId: "i-a" });
    await settle();
    expect(backend.callsTo("deleteScrollback").map((call) => call.args[0])).toEqual(["p-a"]);
    expect(Object.keys(backend.scrollbackFiles)).toEqual(["p-b"]);
    expect(store.getState().workspace.archive.map((e) => e.item.id)).toEqual(["i-b"]);
  });

  it("a closed tab takes its file with it too", async () => {
    const items = [tab("a"), tab("b")];
    giveTerminals(items);
    const { backend, store } = setup(items);
    store.getState().dispatch({ type: "item/close", itemId: "i-a" });
    await settle();
    expect(backend.scrollbackFiles["p-a"]).toBe("p-a output");

    store.getState().dispatch({ type: "closed/delete", itemId: "i-a" });
    await settle();
    expect(backend.scrollbackFiles).toEqual({});
    expect(store.getState().workspace.closed).toEqual([]);
  });

  it("every pane of a split tab goes", async () => {
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
    const { backend, store } = setup([split, tab("b")]);
    store.getState().dispatch({ type: "item/archive", itemId: "i-a" });
    await settle();
    expect(Object.keys(backend.scrollbackFiles).sort()).toEqual(["p-a1", "p-a2"]);
    store.getState().dispatch({ type: "archive/delete", itemId: "i-a" });
    await settle();
    expect(backend.scrollbackFiles).toEqual({});
  });
});

describe("closedChanges and the archive", () => {
  const space = (items: readonly Item[]): Workspace => ({
    version: 2,
    spaces: [fixtureSpace("s1", items)],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  });

  it("an item that joins the archive is a pane to write, like a closed one", () => {
    const before = space([tab("a", { ref: true }), tab("b")]);
    const entry = { item: tab("a", { ref: true }), spaceId: "s1", archivedAt: 5 };
    const after: Workspace = { ...before, archive: [entry] };
    expect(closedChanges(before, after)).toEqual({
      closed: [{ paneId: "p-a", itemId: "i-a", spaceSaves: true, hasFile: true }],
      gone: [],
    });
  });

  it("a pane that leaves the archive for good is gone, and one that is restored is not", () => {
    const archived = { item: tab("a", { ref: true }), spaceId: "s1", archivedAt: 5 };
    const before: Workspace = { ...space([tab("b")]), archive: [archived] };
    const deleted: Workspace = { ...before, archive: [] };
    expect(closedChanges(before, deleted).gone).toEqual(["p-a"]);
    const restored: Workspace = { ...space([tab("b"), archived.item]), archive: [] };
    expect(closedChanges(before, restored).gone).toEqual([]);
  });

  it("an entry that stays in the archive is not written again", () => {
    const archived = { item: tab("a", { ref: true }), spaceId: "s1", archivedAt: 5 };
    const before: Workspace = { ...space([tab("b")]), archive: [archived] };
    const after: Workspace = { ...before, favorites: [] };
    expect(closedChanges(before, after)).toEqual({ closed: [], gone: [] });
  });
});

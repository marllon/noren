import {
  FakeBackend,
  ManualClock,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
  treeGroups,
} from "@noren/model";
import type { Id, LiveEntry, NewTabRouting, Space } from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveEntriesOf, startLiveGroups, stopLiveGroups } from "./live-groups-service";
import { createWorkspaceStore, spaceItemIds } from "./workspace-store";

// Opening an entry of a live group (NOR-F17-04a): one tab per entry, found again by its key, made
// in the group whatever the routing rules say, with the folder of the entry and its command handed
// to the shell once it starts. The updater that fills the entries runs on a manual clock here.

const clock = { now: () => 1000 };

interface Rig {
  store: ReturnType<typeof createWorkspaceStore>;
  backend: FakeBackend;
  entries: { current: LiveEntry[] };
  started: { paneId: Id; sessionId: Id; command: string }[];
  groupId: Id;
  space(): Space;
  tabsOf(key: string): Id[];
}

async function openRig(routing?: () => NewTabRouting | undefined): Promise<Rig> {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const entries = { current: [] as LiveEntry[] };
  const started: Rig["started"] = [];
  const store = createWorkspaceStore({
    backend,
    workspace: restored.workspace,
    newId,
    clock,
    liveEntries: () => entries.current,
    onStartCommand: (paneId, sessionId, command) => started.push({ paneId, sessionId, command }),
    ...(routing !== undefined ? { routing } : {}),
  });
  store.getState().dispatch({
    type: "group/create",
    name: "Worktrees",
    live: { source: "worktrees", folder: "/work/repo" },
  });
  const space = (): Space => {
    const found = store.getState().workspace.spaces[0];
    if (found === undefined) throw new Error("no space");
    return found;
  };
  const group = treeGroups(space().tree)[0];
  if (group === undefined) throw new Error("no group");
  const tabsOf = (key: string): Id[] =>
    Object.values(space().items)
      .filter((item) => item.liveKey === key)
      .map((item) => item.id);
  return { store, backend, entries, started, groupId: group.id, space, tabsOf };
}

describe("openLiveEntry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes a tab in the group on the first open and only shows it after that", async () => {
    const rig = await openRig();
    rig.entries.current = [
      { key: "/work/repo", label: "main", cwd: "/work/repo" },
      { key: "/work/repo-dev", label: "dev", cwd: "/work/repo-dev" },
    ];
    const { store } = rig;
    const before = Object.keys(rig.space().items).length;

    store.getState().openLiveEntry(rig.groupId, "/work/repo-dev");
    const [tab] = rig.tabsOf("/work/repo-dev");
    expect(tab).toBeDefined();
    expect(Object.keys(rig.space().items)).toHaveLength(before + 1);
    expect(rig.space().activeItemId).toBe(tab);
    const item = rig.space().items[tab ?? ""];
    expect(item && layoutPanes(item.layout)[0]?.cwd).toBe("/work/repo-dev");
    const group = treeGroups(rig.space().tree).find((g) => g.id === rig.groupId);
    expect(group?.children.some((c) => c.kind === "item" && c.id === tab)).toBe(true);

    // Another tab takes the focus; opening the entry again shows the same tab and makes none.
    store.getState().newTab();
    expect(rig.space().activeItemId).not.toBe(tab);
    store.getState().openLiveEntry(rig.groupId, "/work/repo-dev");
    expect(rig.space().activeItemId).toBe(tab);
    expect(rig.tabsOf("/work/repo-dev")).toEqual([tab]);
    expect(Object.keys(rig.space().items)).toHaveLength(before + 2);
  });

  it("goes into the group even when a routing rule would send the tab elsewhere", async () => {
    const rig = await openRig(() => ({
      rules: [{ cwd: "/work/**", space: "Elsewhere" }],
      context: { platform: "unix", home: "/home/ana" },
    }));
    rig.entries.current = [{ key: "k", label: "k", cwd: "/work/repo-k" }];
    rig.store.getState().openLiveEntry(rig.groupId, "k");
    expect(rig.store.getState().workspace.spaces).toHaveLength(1);
    expect(rig.tabsOf("k")).toHaveLength(1);
  });

  it("leaves the cwd to the space when the entry has none", async () => {
    const rig = await openRig();
    rig.entries.current = [{ key: "h", label: "host", cwd: "" }];
    rig.store.getState().openLiveEntry(rig.groupId, "h");
    const item = rig.space().items[rig.tabsOf("h")[0] ?? ""];
    expect(item && layoutPanes(item.layout)[0]?.cwd).toBe(rig.space().defaults.cwd);
  });

  it("keeps a tab when its entry goes away, and still shows it", async () => {
    const rig = await openRig();
    rig.entries.current = [{ key: "a", label: "a", cwd: "/work/a" }];
    rig.store.getState().openLiveEntry(rig.groupId, "a");
    const tabs = Object.keys(rig.space().items).length;
    rig.entries.current = [];
    rig.store.getState().newTab();
    rig.store.getState().openLiveEntry(rig.groupId, "a");
    expect(rig.space().activeItemId).toBe(rig.tabsOf("a")[0]);
    expect(Object.keys(rig.space().items)).toHaveLength(tabs + 1);
  });

  it("changes nothing for a key with no tab and no entry, an unknown group and a group that is not live", async () => {
    const rig = await openRig();
    const before = rig.store.getState().workspace;
    rig.store.getState().openLiveEntry(rig.groupId, "nothing");
    rig.store.getState().openLiveEntry("nope", "nothing");
    rig.entries.current = [{ key: "a", label: "a", cwd: "/work/a" }];
    rig.store.getState().dispatch({ type: "group/set-live", groupId: rig.groupId });
    const plain = rig.store.getState().workspace;
    rig.store.getState().openLiveEntry(rig.groupId, "a");
    expect(rig.store.getState().workspace).toBe(plain);
    expect(plain).not.toBe(before);
  });

  it("hands the command of the entry over once, when the shell of the tab starts", async () => {
    const rig = await openRig();
    rig.entries.current = [
      { key: "web", label: "web", cwd: "", command: "ssh web" },
      { key: "plain", label: "plain", cwd: "/work/plain" },
    ];
    rig.store.getState().openLiveEntry(rig.groupId, "web");
    expect(rig.started).toEqual([]);
    const item = rig.space().items[rig.tabsOf("web")[0] ?? ""];
    const paneId = item && layoutPanes(item.layout)[0]?.id;
    expect(paneId).toBeDefined();
    rig.store.getState().attachSession(paneId ?? "", "7");
    expect(rig.started).toEqual([{ paneId, sessionId: "7", command: "ssh web" }]);
    // The same pane attached again (a restore) does not type it again.
    rig.store.getState().attachSession(paneId ?? "", "7");
    expect(rig.started).toHaveLength(1);

    // An entry with no command hands nothing over.
    rig.store.getState().openLiveEntry(rig.groupId, "plain");
    const plain = rig.space().items[rig.tabsOf("plain")[0] ?? ""];
    rig.store.getState().attachSession(plain ? (layoutPanes(plain.layout)[0]?.id ?? "") : "", "8");
    expect(rig.started).toHaveLength(1);
  });

  it("does not hand a command over for a tab that closed before its shell started", async () => {
    const rig = await openRig();
    rig.entries.current = [{ key: "web", label: "web", cwd: "", command: "ssh web" }];
    rig.store.getState().openLiveEntry(rig.groupId, "web");
    const tab = rig.tabsOf("web")[0] ?? "";
    const item = rig.space().items[tab];
    const paneId = item && layoutPanes(item.layout)[0]?.id;
    rig.store.getState().closeItems([tab]);
    rig.store.getState().attachSession(paneId ?? "", "9");
    expect(rig.started).toEqual([]);
  });

  it("shows the space of the group when another one was active", async () => {
    const rig = await openRig();
    const { store } = rig;
    const firstSpace = rig.space().id;
    store.getState().createSpace({ name: "Other" });
    expect(store.getState().workspace.activeSpaceId).not.toBe(firstSpace);
    rig.entries.current = [{ key: "a", label: "a", cwd: "/work/a" }];
    store.getState().openLiveEntry(rig.groupId, "a");
    expect(store.getState().workspace.activeSpaceId).toBe(firstSpace);
    expect(rig.tabsOf("a")).toHaveLength(1);
  });
});

describe("the live groups service", () => {
  afterEach(() => {
    stopLiveGroups();
  });

  it("asks the worktrees of the group on a manual clock and feeds openLiveEntry", async () => {
    const backend = new FakeBackend();
    backend.setGitRepo("/work/repo", { branch: "main", detached: false });
    const newId = createSequentialIds("n");
    const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
    const store = createWorkspaceStore({
      backend,
      workspace: restored.workspace,
      newId,
      clock,
      liveEntries: liveEntriesOf,
    });
    store.getState().dispatch({
      type: "group/create",
      name: "Worktrees",
      live: { source: "worktrees", folder: "/work/repo" },
    });
    const manual = new ManualClock();
    const groups = startLiveGroups({ store, backend, clock: manual });
    await groups.idle();
    const groupId = treeGroups(store.getState().workspace.spaces[0]?.tree ?? [])[0]?.id ?? "";
    expect(liveEntriesOf(groupId).map((e) => e.label)).toEqual(["main"]);

    await backend.createWorktree("/work/repo", "dev");
    expect(liveEntriesOf(groupId)).toHaveLength(1);
    manual.advance(10_000);
    await groups.idle();
    expect(liveEntriesOf(groupId).map((e) => e.label)).toEqual(["main", "dev"]);

    store.getState().openLiveEntry(groupId, "/work/repo-dev");
    const space = store.getState().workspace.spaces[0];
    const made = Object.values(space?.items ?? {}).find(
      (item) => item.liveKey === "/work/repo-dev",
    );
    expect(made && layoutPanes(made.layout)[0]?.cwd).toBe("/work/repo-dev");
    expect(spaceItemIds(space as Space)).toContain(made?.id);

    stopLiveGroups();
    expect(liveEntriesOf(groupId)).toEqual([]);
  });
});

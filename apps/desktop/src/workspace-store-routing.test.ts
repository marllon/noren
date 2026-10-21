import {
  FakeBackend,
  createSequentialIds,
  layoutPanes,
  restoreWorkspace,
  treeGroups,
} from "@noren/model";
import type { Id, NewTabRouting, RoutingRule, Space } from "@noren/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSpaceOf, createWorkspaceStore, spaceItemIds } from "./workspace-store";

// The new tabs of the window follow `routing.rules` (NOR-F17-03c): the first rule that matches the
// folder and the profile of the tab names the space (and the group) it goes to.

const clock = { now: () => 1000 };
const UNIX = { platform: "unix", home: "/home/ana" } as const;

interface Rig {
  store: ReturnType<typeof createWorkspaceStore>;
  /** The rules the store asks for; the test changes them. */
  rules: { current: RoutingRule[] | undefined };
  asked: { count: number };
  space(name: string): Space;
}

/** Spaces "Home" (the first), "Work" (a group "Api" with a tab in it) and "Play"; Home is active. */
async function openRig(
  routing: "rules" | "none" | "throws" = "rules",
  rules: RoutingRule[] | undefined = [],
): Promise<Rig> {
  const backend = new FakeBackend();
  const newId = createSequentialIds("n");
  const restored = await restoreWorkspace(backend, { defaults: { newId, clock } });
  const state = { current: rules };
  const asked = { count: 0 };
  const getter = (): NewTabRouting | undefined => {
    asked.count++;
    if (routing === "throws") throw new Error("settings unreadable");
    return { rules: state.current, context: UNIX };
  };
  const store = createWorkspaceStore({
    backend,
    workspace: restored.workspace,
    newId,
    clock,
    ...(routing !== "none" ? { routing: getter } : {}),
  });
  const space = (name: string): Space => {
    const found = store.getState().workspace.spaces.find((s) => s.name === name);
    if (found === undefined) throw new Error(`no space ${name}`);
    return found;
  };
  const home = store.getState().workspace.spaces[0];
  if (home === undefined) throw new Error("no first space");
  store.getState().editSpace(home.id, { name: "Home" });
  store.getState().createSpace({ name: "Work", profileId: "pwsh", cwd: "/work" });
  const first = spaceItemIds(activeSpaceOf(store.getState().workspace))[0];
  if (first === undefined) throw new Error("no first tab");
  store.getState().groupItems([first], "Api");
  store.getState().createSpace({ name: "Play" });
  store.getState().activateSpace(home.id);
  asked.count = 0;
  return { store, rules: state, asked, space };
}

/** The ids of the items of a space, in sidebar order. */
const itemsOf = (space: Space): Id[] => spaceItemIds(space);

/** The active tab of a space (the newest one, after a new tab) and the group it sits in, if any. */
function newest(space: Space): { id: Id; group: Id | undefined } {
  const id = space.activeItemId ?? "";
  const group = treeGroups(space.tree).find((g) =>
    g.children.some((child) => child.kind === "item" && child.id === id),
  );
  return { id, group: group?.id };
}

describe("new tabs of the window and routing.rules", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a rule by folder takes the tab to another space and makes it the active one", async () => {
    const rig = await openRig("rules", [{ cwd: "/work/**", space: "Work" }]);
    const { store, space } = rig;
    const homeBefore = itemsOf(space("Home")).length;
    const workBefore = itemsOf(space("Work")).length;
    store.getState().newTab({ cwd: "/work/api" });
    const state = store.getState().workspace;
    expect(state.activeSpaceId).toBe(space("Work").id);
    expect(itemsOf(space("Home"))).toHaveLength(homeBefore);
    const work = space("Work");
    expect(itemsOf(work)).toHaveLength(workBefore + 1);
    const made = work.items[work.activeItemId ?? ""];
    expect(made && layoutPanes(made.layout)[0]?.cwd).toBe("/work/api");
    expect(itemsOf(work)).toContain(work.activeItemId);
  });

  it("a rule by command takes the tab by the profile it asks for", async () => {
    const rig = await openRig("rules", [{ command: "^bash$", space: "Play" }]);
    rig.store.getState().newTab({ profileId: "bash" });
    expect(rig.store.getState().workspace.activeSpaceId).toBe(rig.space("Play").id);
    const play = rig.space("Play");
    const made = play.items[play.activeItemId ?? ""];
    expect(made && layoutPanes(made.layout)[0]?.profileId).toBe("bash");
  });

  it("without a profile in the call, the profile of the active space is what the rule is asked", async () => {
    const rig = await openRig("rules", [{ command: "^pwsh$", space: "Play" }]);
    const { store, space } = rig;
    // Home has the default profile: no match.
    store.getState().newTab();
    expect(store.getState().workspace.activeSpaceId).toBe(space("Home").id);
    // Work's default profile is pwsh: from there the rule matches, and the tab goes to Play.
    store.getState().activateSpace(space("Work").id);
    store.getState().newTab();
    expect(store.getState().workspace.activeSpaceId).toBe(space("Play").id);
  });

  it("without a folder in the call, the start folder of the active space is what the rule is asked", async () => {
    const rig = await openRig("rules", [{ cwd: "/work", space: "Play" }]);
    const { store, space } = rig;
    store.getState().activateSpace(space("Work").id);
    store.getState().newTab();
    expect(store.getState().workspace.activeSpaceId).toBe(space("Play").id);
  });

  it("a rule with a group puts the tab in that group", async () => {
    const rig = await openRig("rules", [{ cwd: "/work/**", space: "Work", group: "Api" }]);
    const { store, space } = rig;
    const api = treeGroups(space("Work").tree).find((g) => g.name === "Api");
    expect(api).toBeDefined();
    store.getState().newTab({ cwd: "/work/x" });
    const work = space("Work");
    expect(store.getState().workspace.activeSpaceId).toBe(work.id);
    const made = newest(work);
    expect(made.group).toBe(api?.id);
    expect(treeGroups(work.tree).find((g) => g.id === api?.id)?.children).toHaveLength(2);
  });

  it("a rule with a group in the active space puts the tab in the group without changing space", async () => {
    const rig = await openRig("rules", [{ command: ".*", space: "Work", group: "Api" }]);
    const { store, space } = rig;
    store.getState().activateSpace(space("Work").id);
    store.getState().newTab();
    expect(store.getState().workspace.activeSpaceId).toBe(space("Work").id);
    expect(newest(space("Work")).group).toBe(treeGroups(space("Work").tree)[0]?.id);
  });

  it("a rule whose space or group is not there is skipped: the next rule, else the active space", async () => {
    const rig = await openRig("rules", [
      { cwd: "/work/**", space: "Gone" },
      { cwd: "/work/**", space: "Work", group: "Gone" },
      { cwd: "/work/**", space: "Play" },
    ]);
    const { store, space } = rig;
    store.getState().newTab({ cwd: "/work/a" });
    expect(store.getState().workspace.activeSpaceId).toBe(space("Play").id);
    rig.rules.current = [{ cwd: "/work/**", space: "Gone" }];
    store.getState().activateSpace(space("Home").id);
    const homeBefore = itemsOf(space("Home")).length;
    store.getState().newTab({ cwd: "/work/a" });
    expect(store.getState().workspace.activeSpaceId).toBe(space("Home").id);
    expect(itemsOf(space("Home"))).toHaveLength(homeBefore + 1);
  });

  it("a tab that no rule matches goes to the active space, as before", async () => {
    const rig = await openRig("rules", [{ cwd: "/work/**", space: "Work" }]);
    const { store, space } = rig;
    const homeBefore = itemsOf(space("Home")).length;
    store.getState().newTab({ cwd: "/elsewhere" });
    expect(store.getState().workspace.activeSpaceId).toBe(space("Home").id);
    expect(itemsOf(space("Home"))).toHaveLength(homeBefore + 1);
    expect(newest(space("Home")).group).toBeUndefined();
  });

  it("without a routing option, or with no rules, the tab goes to the active space", async () => {
    for (const rig of [await openRig("none"), await openRig("rules", undefined), await openRig()]) {
      const homeBefore = itemsOf(rig.space("Home")).length;
      rig.store.getState().newTab({ cwd: "/work/a" });
      expect(rig.store.getState().workspace.activeSpaceId).toBe(rig.space("Home").id);
      expect(itemsOf(rig.space("Home"))).toHaveLength(homeBefore + 1);
    }
  });

  it("a routing getter that throws counts as no rules, and the tab is still made", async () => {
    const rig = await openRig("throws");
    const homeBefore = itemsOf(rig.space("Home")).length;
    expect(() => rig.store.getState().newTab({ cwd: "/work/a" })).not.toThrow();
    expect(rig.asked.count).toBe(1);
    expect(rig.store.getState().workspace.activeSpaceId).toBe(rig.space("Home").id);
    expect(itemsOf(rig.space("Home"))).toHaveLength(homeBefore + 1);
  });

  it("the rules are read at every new tab", async () => {
    const rig = await openRig("rules", [{ cwd: "/p/**", space: "Play" }]);
    const { store, space } = rig;
    store.getState().newTab({ cwd: "/p/1" });
    expect(store.getState().workspace.activeSpaceId).toBe(space("Play").id);
    store.getState().activateSpace(space("Home").id);
    rig.rules.current = [{ cwd: "/p/**", space: "Work" }];
    store.getState().newTab({ cwd: "/p/2" });
    expect(store.getState().workspace.activeSpaceId).toBe(space("Work").id);
    store.getState().activateSpace(space("Home").id);
    rig.rules.current = [];
    store.getState().newTab({ cwd: "/p/3" });
    expect(store.getState().workspace.activeSpaceId).toBe(space("Home").id);
    expect(rig.asked.count).toBe(3);
  });

  it("adoptSession takes the session into the active space, whatever the rules say", async () => {
    const rig = await openRig("rules", [{ command: ".*", space: "Play" }]);
    const { store, space } = rig;
    const id = store.getState().adoptSession("77");
    expect(id).toBeDefined();
    expect(rig.asked.count).toBe(0);
    expect(store.getState().workspace.activeSpaceId).toBe(space("Home").id);
    expect(id !== undefined && space("Home").items[id]).toBeTruthy();
  });

  it("the first tab of a new space stays in that space, whatever the rules say", async () => {
    const rig = await openRig("rules", [{ cwd: "/**", space: "Play" }]);
    const { store, space } = rig;
    const playBefore = itemsOf(space("Play")).length;
    store.getState().createSpace({ name: "Fresh", cwd: "/fresh" });
    expect(rig.asked.count).toBe(0);
    const fresh = space("Fresh");
    expect(store.getState().workspace.activeSpaceId).toBe(fresh.id);
    expect(itemsOf(fresh)).toHaveLength(1);
    expect(itemsOf(space("Play"))).toHaveLength(playBefore);
  });
});

import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock";
import { createDefaultWorkspace } from "./default-workspace";
import { FAKE_DOCKER_CONTAINERS, FAKE_SSH_HOSTS, FakeBackend } from "./fake-backend";
import { checkInvariants } from "./invariants";
import {
  LIVE_REFRESH_INTERVAL_MS,
  LiveGroups,
  findLiveItem,
  isLiveSource,
  liveGroupsOf,
  liveSourceProblem,
  planOpenLiveEntry,
  worktreeEntry,
  dockerEntry,
  dockerSource,
  liveSourcesOf,
  sshEntry,
  sshSource,
  worktreesSource,
} from "./live-groups";
import type { LiveEntry, LiveSources } from "./live-groups";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import { treeGroups } from "./tree";
import type { Id, LiveSource, Workspace } from "./types";

const WORKTREES: LiveSource = { source: "worktrees", folder: "/work/repo" };

function entry(key: string, extra: Partial<LiveEntry> = {}): LiveEntry {
  return { key, label: `label ${key}`, cwd: `/work/${key}`, ...extra };
}

/** The default workspace with a live group on `live` in the active space; returns it and the group id. */
function withLiveGroup(live: LiveSource = WORKTREES): { ws: Workspace; groupId: Id } {
  const { ctx } = testContext();
  const ws = applyChecked(
    createDefaultWorkspace(),
    { type: "group/create", name: "Live", live },
    ctx,
  );
  const [groupId] = [...liveGroupsOf(ws).keys()];
  if (groupId === undefined) throw new Error("the live group was not made");
  return { ws, groupId };
}

/** A source the test steers: what it answers now, and how many times it was asked. */
function fakeSource() {
  const state = { entries: [] as LiveEntry[], failure: undefined as string | undefined, calls: 0 };
  const sources: LiveSources = {
    worktrees: () => {
      state.calls += 1;
      return state.failure === undefined
        ? Promise.resolve(state.entries.map((e) => ({ ...e })))
        : Promise.reject(new Error(state.failure));
    },
  };
  return { state, sources };
}

function updaterOn(
  ws: () => Workspace,
  sources: LiveSources,
  onError?: (id: Id, e: unknown) => void,
) {
  const clock = new ManualClock();
  const groups = new LiveGroups({
    clock,
    workspace: ws,
    sources,
    ...(onError !== undefined ? { onError } : {}),
  });
  return { clock, groups };
}

describe("live source", () => {
  it("accepts the three sources and refuses the rest", () => {
    expect(isLiveSource({ source: "worktrees", folder: "/x" })).toBe(true);
    expect(isLiveSource({ source: "ssh" })).toBe(true);
    expect(isLiveSource({ source: "docker" })).toBe(true);
    expect(liveSourceProblem({ source: "worktrees", folder: " " })).toContain("folder");
    expect(liveSourceProblem({ source: "worktrees" })).toContain("folder");
    expect(liveSourceProblem({ source: "podman" })).toContain("source");
    expect(liveSourceProblem(null)).toBeDefined();
    expect(liveSourceProblem("worktrees")).toBeDefined();
  });
});

describe("the groups of the reducer", () => {
  it("makes a live group, and no group at all for a source it refuses", () => {
    const { ws, groupId } = withLiveGroup();
    const group = treeGroups(ws.spaces[0]?.tree ?? []).find((g) => g.id === groupId);
    expect(group?.live).toEqual(WORKTREES);
    const { ctx } = testContext();
    const refused = applyChecked(
      createDefaultWorkspace(),
      { type: "group/create", name: "Bad", live: { source: "worktrees", folder: "" } },
      ctx,
    );
    expect(liveGroupsOf(refused).size).toBe(0);
    expect(refused.spaces[0]?.tree).toEqual(createDefaultWorkspace().spaces[0]?.tree);
  });

  it("turns a group live and back with group/set-live", () => {
    const { ctx } = testContext();
    let ws = applyChecked(createDefaultWorkspace(), { type: "group/create", name: "G" }, ctx);
    const id = treeGroups(ws.spaces[0]?.tree ?? [])[0]?.id ?? "";
    ws = applyChecked(ws, { type: "group/set-live", groupId: id, live: { source: "docker" } }, ctx);
    expect(liveGroupsOf(ws).get(id)).toEqual({ source: "docker" });
    // The same source again, and a source it refuses, change nothing.
    expect(
      applyChecked(ws, { type: "group/set-live", groupId: id, live: { source: "docker" } }, ctx),
    ).toBe(ws);
    expect(
      applyChecked(
        ws,
        { type: "group/set-live", groupId: id, live: { source: "worktrees", folder: "" } },
        ctx,
      ),
    ).toBe(ws);
    ws = applyChecked(ws, { type: "group/set-live", groupId: id }, ctx);
    expect(liveGroupsOf(ws).size).toBe(0);
    expect(applyChecked(ws, { type: "group/set-live", groupId: id }, ctx)).toBe(ws);
  });

  it("keeps liveKey on a tab made with it", () => {
    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    const next = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId }, liveKey: "/work/repo-a" },
      ctx,
    );
    expect(findLiveItem(next, groupId, "/work/repo-a")).toBeDefined();
    expect(findLiveItem(next, groupId, "/work/other")).toBeUndefined();
    // Blank is no key.
    const blank = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId }, liveKey: " " },
      ctx,
    );
    expect(
      Object.values(blank.spaces[0]?.items ?? {}).some((item) => item.liveKey !== undefined),
    ).toBe(false);
  });
});

describe("state.json", () => {
  it("keeps live and liveKey through saving and reading", () => {
    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    const next = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId }, liveKey: "/work/repo-a" },
      ctx,
    );
    const text = serializeWorkspace(next);
    expect(text).toContain('"live":{"source":"worktrees","folder":"/work/repo"}');
    expect(text).toContain('"liveKey":"/work/repo-a"');
    const read = parseState(text);
    if (!read.ok) throw new Error(read.reason);
    expect(read.migratedFrom).toBeUndefined();
    expect(liveGroupsOf(read.workspace).get(groupId)).toEqual(WORKTREES);
    expect(findLiveItem(read.workspace, groupId, "/work/repo-a")).toBeDefined();
    expect(serializeWorkspace(read.workspace)).toBe(text);
  });

  it("still reads a file written before live groups, with no live and no liveKey", () => {
    const read = parseState(serializeWorkspace(createDefaultWorkspace()));
    expect(read.ok).toBe(true);
    const text = serializeWorkspace(withLiveGroup().ws);
    const old = JSON.parse(text) as { spaces: { tree: Record<string, unknown>[] }[] };
    for (const node of old.spaces[0]?.tree ?? []) delete node["live"];
    const plain = parseState(JSON.stringify(old));
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(liveGroupsOf(plain.workspace).size).toBe(0);
  });

  it("refuses a live group with a source it does not know, and a blank liveKey", () => {
    const text = serializeWorkspace(withLiveGroup().ws);
    const bad = JSON.parse(text) as { spaces: { tree: { live: unknown }[] }[] };
    const group = bad.spaces[0]?.tree.find((node) => node.live !== undefined);
    if (group) group.live = { source: "podman" };
    const result = parseState(JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("live-source-invalid");

    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    const made = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId }, liveKey: "k" },
      ctx,
    );
    const blank = JSON.parse(
      serializeWorkspace(made).replace('"liveKey":"k"', '"liveKey":""'),
    ) as unknown;
    const refused = parseState(JSON.stringify(blank));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("live-key-invalid");
  });

  it("flags the invariants of a live group that was broken by hand", () => {
    const { ws, groupId } = withLiveGroup();
    const broken = JSON.parse(JSON.stringify(ws)) as Workspace;
    const space = broken.spaces[0];
    const group = space?.tree.find((node) => node.id === groupId);
    if (group?.kind === "group") group.live = { source: "worktrees", folder: "" };
    expect(checkInvariants(broken).map((v) => v.code)).toContain("live-source-invalid");
  });
});

describe("LiveGroups", () => {
  it("asks at the start and then at every interval, and keeps the entries per group", async () => {
    const { ws, groupId } = withLiveGroup();
    const { state, sources } = fakeSource();
    state.entries = [entry("a")];
    const { clock, groups } = updaterOn(() => ws, sources);
    expect(groups.entries(groupId)).toEqual([]);

    groups.start();
    await groups.idle();
    expect(state.calls).toBe(1);
    expect(groups.entries(groupId)).toEqual([entry("a")]);

    clock.advance(LIVE_REFRESH_INTERVAL_MS - 1);
    await groups.idle();
    expect(state.calls).toBe(1);
    clock.advance(1);
    await groups.idle();
    expect(state.calls).toBe(2);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(state.calls).toBe(3);
    groups.stop();
    clock.advance(LIVE_REFRESH_INTERVAL_MS * 3);
    await groups.idle();
    expect(state.calls).toBe(3);
    expect(clock.pending).toBe(0);
  });

  it("picks up a new entry and drops one that went away, telling the subscribers", async () => {
    const { ws, groupId } = withLiveGroup();
    const { state, sources } = fakeSource();
    state.entries = [entry("a"), entry("b")];
    const { clock, groups } = updaterOn(() => ws, sources);
    let heard = 0;
    groups.subscribe(() => {
      heard += 1;
    });
    groups.start();
    await groups.idle();
    expect(heard).toBe(1);

    state.entries = [entry("a"), entry("b"), entry("c", { command: "ssh c" })];
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.key)).toEqual(["a", "b", "c"]);
    expect(groups.entries(groupId)[2]?.command).toBe("ssh c");
    expect(heard).toBe(2);

    state.entries = [entry("b")];
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.key)).toEqual(["b"]);
    expect(heard).toBe(3);

    // The same answer again is not news, and keeps the very same list.
    const list = groups.entries(groupId);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId)).toBe(list);
    expect(heard).toBe(3);
    groups.stop();
  });

  it("keeps the last list when the source fails, records the error, and recovers", async () => {
    const { ws, groupId } = withLiveGroup();
    const { state, sources } = fakeSource();
    state.entries = [entry("a")];
    const errors: [Id, string][] = [];
    const { clock, groups } = updaterOn(
      () => ws,
      sources,
      (id, e) => {
        errors.push([id, (e as Error).message]);
      },
    );
    groups.start();
    await groups.idle();
    expect(groups.error(groupId)).toBeUndefined();

    state.failure = "git is not installed";
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId)).toEqual([entry("a")]);
    expect(groups.error(groupId)).toBe("git is not installed");
    expect(errors).toEqual([[groupId, "git is not installed"]]);

    state.failure = undefined;
    state.entries = [entry("a"), entry("b")];
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.error(groupId)).toBeUndefined();
    expect(groups.entries(groupId)).toHaveLength(2);
    groups.stop();
  });

  it("reports a failure before any answer, with no entries", async () => {
    const { ws, groupId } = withLiveGroup();
    const { state, sources } = fakeSource();
    state.failure = "boom";
    const { groups } = updaterOn(() => ws, sources);
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId)).toEqual([]);
    expect(groups.error(groupId)).toBe("boom");
    groups.stop();
  });

  it("reports a group whose source the app has no way to ask", async () => {
    const { ws, groupId } = withLiveGroup({ source: "docker" });
    const { sources } = fakeSource();
    const { groups } = updaterOn(() => ws, sources);
    await groups.refresh();
    expect(groups.error(groupId)).toContain("docker");
  });

  it("stops asking for a group that was removed or is no longer live", async () => {
    const { ws, groupId } = withLiveGroup();
    const { state, sources } = fakeSource();
    state.entries = [entry("a")];
    let current = ws;
    const { clock, groups } = updaterOn(() => current, sources);
    groups.start();
    await groups.idle();
    expect(state.calls).toBe(1);

    const { ctx } = testContext();
    current = applyChecked(ws, { type: "group/set-live", groupId }, ctx);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(state.calls).toBe(1);
    expect(groups.entries(groupId)).toEqual([]);

    current = applyChecked(ws, { type: "group/set-live", groupId, live: WORKTREES }, ctx);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(state.calls).toBe(2);

    current = applyChecked(current, { type: "group/ungroup", groupId }, ctx);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(state.calls).toBe(2);
    expect(groups.entries(groupId)).toEqual([]);
    groups.stop();
  });

  it("drops the entries of a group pointed at another folder, and ignores an answer that arrives late", async () => {
    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    let current = ws;
    let release: (entries: LiveEntry[]) => void = () => undefined;
    let calls = 0;
    const sources: LiveSources = {
      worktrees: (live) => {
        calls += 1;
        if (live.folder === "/work/repo" && calls === 1) {
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve([entry("other")]);
      },
    };
    const { groups } = updaterOn(() => current, sources);
    const first = groups.refresh();
    // While the first answer is on its way, the group is removed.
    current = applyChecked(ws, { type: "group/ungroup", groupId }, ctx);
    release([entry("late")]);
    await first;
    expect(groups.entries(groupId)).toEqual([]);
    expect(groups.error(groupId)).toBeUndefined();

    current = applyChecked(
      withLiveGroup().ws,
      { type: "group/set-live", groupId: groupId, live: WORKTREES },
      ctx,
    );
    await groups.refresh();
    expect(groups.entries(groupId).map((e) => e.key)).toEqual(["other"]);
    current = applyChecked(
      current,
      { type: "group/set-live", groupId, live: { source: "worktrees", folder: "/work/two" } },
      ctx,
    );
    const before = calls;
    await groups.refresh();
    expect(calls).toBe(before + 1);
  });

  it("does not ask a group twice at once", async () => {
    const { ws } = withLiveGroup();
    let calls = 0;
    let release: () => void = () => undefined;
    const sources: LiveSources = {
      worktrees: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = () => resolve([]);
        });
      },
    };
    const { groups } = updaterOn(() => ws, sources);
    const a = groups.refresh();
    const b = groups.refresh();
    expect(calls).toBe(1);
    release();
    await Promise.all([a, b]);
  });

  it("drops blank and repeated keys from an answer", async () => {
    const { ws, groupId } = withLiveGroup();
    const sources: LiveSources = {
      worktrees: () =>
        Promise.resolve([
          entry("a"),
          entry("a", { label: "again" }),
          entry(""),
          entry("b", { label: "" }),
        ]),
    };
    const { groups } = updaterOn(() => ws, sources);
    await groups.refresh();
    expect(groups.entries(groupId)).toEqual([entry("a")]);
  });

  it("stops one subscriber without losing the others, and never throws from a subscriber", async () => {
    const { ws } = withLiveGroup();
    const { state, sources } = fakeSource();
    state.entries = [entry("a")];
    const { groups } = updaterOn(() => ws, sources);
    let heard = 0;
    groups.subscribe(() => {
      throw new Error("bad subscriber");
    });
    const stop = groups.subscribe(() => {
      heard += 1;
    });
    await groups.refresh();
    expect(heard).toBe(1);
    stop();
    state.entries = [entry("b")];
    await groups.refresh();
    expect(heard).toBe(1);
  });
});

describe("opening an entry", () => {
  it("makes a tab for an entry once and then only focuses it", () => {
    const { ws, groupId } = withLiveGroup();
    const entries = [entry("a"), entry("b")];
    const first = planOpenLiveEntry(ws, groupId, "a", entries);
    expect(first).toEqual({ kind: "create", spaceId: ws.spaces[0]?.id, entry: entries[0] });

    const { ctx } = testContext();
    const made = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId }, cwd: "/work/a", liveKey: "a" },
      ctx,
    );
    const second = planOpenLiveEntry(made, groupId, "a", entries);
    expect(second?.kind).toBe("focus");
    // The other entry still gets its own tab.
    expect(planOpenLiveEntry(made, groupId, "b", entries)?.kind).toBe("create");
  });

  it("focuses the tab of an entry that is no longer listed, and does nothing for an unknown one", () => {
    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    const made = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId }, liveKey: "gone" },
      ctx,
    );
    expect(planOpenLiveEntry(made, groupId, "gone", [])?.kind).toBe("focus");
    expect(planOpenLiveEntry(made, groupId, "never", [])).toBeUndefined();
  });

  it("does nothing for a group that is gone or is not live", () => {
    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    expect(planOpenLiveEntry(ws, "nope", "a", [entry("a")])).toBeUndefined();
    const plain = applyChecked(ws, { type: "group/set-live", groupId }, ctx);
    expect(planOpenLiveEntry(plain, groupId, "a", [entry("a")])).toBeUndefined();
  });

  it("looks only in its own group", () => {
    const { ws, groupId } = withLiveGroup();
    const { ctx } = testContext();
    const second = applyChecked(ws, { type: "group/create", name: "Two", live: WORKTREES }, ctx);
    const other = [...liveGroupsOf(second).keys()].find((id) => id !== groupId) ?? "";
    const made = applyChecked(
      second,
      { type: "item/create", placement: { to: "tree", groupId: other }, liveKey: "a" },
      ctx,
    );
    expect(planOpenLiveEntry(made, groupId, "a", [entry("a")])?.kind).toBe("create");
    expect(planOpenLiveEntry(made, other, "a", [])?.kind).toBe("focus");
  });
});

describe("the worktrees source", () => {
  it("lists the worktrees of the folder through the backend, labelled by branch", async () => {
    const fake = new FakeBackend();
    fake.setGitRepo("/work/repo", { branch: "main", detached: false });
    await fake.createWorktree("/work/repo", "feature/login");
    const list = await worktreesSource(fake)({ source: "worktrees", folder: "/work/repo/src" });
    expect(list).toEqual([
      { key: "/work/repo", label: "main", cwd: "/work/repo" },
      { key: "/work/repo-feature-login", label: "feature/login", cwd: "/work/repo-feature-login" },
    ]);
  });

  it("follows the repository: a new worktree shows at the next round, a removed one goes", async () => {
    const fake = new FakeBackend();
    fake.setGitRepo("/work/repo", { branch: "main", detached: false });
    const { ws, groupId } = withLiveGroup();
    const { clock, groups } = updaterOn(() => ws, { worktrees: worktreesSource(fake) });
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["main"]);

    await fake.createWorktree("/work/repo", "dev");
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["main", "dev"]);

    await fake.removeWorktree("/work/repo", "/work/repo-dev");
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["main"]);
    groups.stop();
  });

  it("keeps the list and reports the error for a folder that is in no repository", async () => {
    const fake = new FakeBackend();
    fake.setGitRepo("/work/repo", { branch: "main", detached: false });
    const { ws, groupId } = withLiveGroup({ source: "worktrees", folder: "/tmp/none" });
    const { groups } = updaterOn(() => ws, { worktrees: worktreesSource(fake) });
    await groups.refresh();
    expect(groups.entries(groupId)).toEqual([]);
    expect(groups.error(groupId)).toContain("not inside a git repository");
  });

  it("names a detached worktree by its commit and falls back to the folder", () => {
    const base = { path: "/w/x", main: false, locked: false };
    expect(
      worktreeEntry({ ...base, branch: null, head: "abcdef123456", detached: true }).label,
    ).toBe("detached abcdef1");
    expect(worktreeEntry({ ...base, branch: null, head: null, detached: true }).label).toBe("x");
  });
});

describe("the ssh source", () => {
  const SSH: LiveSource = { source: "ssh" };

  it("makes one entry per host that types ssh <host> in the folder of the space", async () => {
    const fake = new FakeBackend();
    fake.setSshHosts(["web-1", "db.internal"]);
    const list = await sshSource(fake)(SSH);
    expect(list).toEqual([
      { key: "web-1", label: "web-1", cwd: "", command: "ssh web-1" },
      { key: "db.internal", label: "db.internal", cwd: "", command: "ssh db.internal" },
    ]);
    expect(fake.callsTo("listSshHosts")).toHaveLength(1);
  });

  it("lists the fixture hosts of the fake backend until a test says others", async () => {
    const fake = new FakeBackend();
    expect((await sshSource(fake)(SSH)).map((e) => e.label)).toEqual(FAKE_SSH_HOSTS);
    fake.setSshHosts([]);
    expect(await sshSource(fake)(SSH)).toEqual([]);
  });

  it("leaves out a name that is not safe to type, even if the backend hands it over", async () => {
    const fake = new FakeBackend();
    fake.setSshHosts(["ok", "a;rm -rf x", "web *", "$(id)", "-oProxyCommand=x", "-v", "", "q'q"]);
    expect((await sshSource(fake)(SSH)).map((e) => e.command)).toEqual(["ssh ok"]);
    expect(sshEntry("a b")).toBeUndefined();
    expect(sshEntry("host*")).toBeUndefined();
    expect(sshEntry("-J")).toBeUndefined();
    expect(sshEntry("a".repeat(256))).toBeUndefined();
    expect(sshEntry("build_box.local-2")).toMatchObject({ command: "ssh build_box.local-2" });
  });

  it("asks at the start and at every interval, and follows the hosts", async () => {
    const fake = new FakeBackend();
    fake.setSshHosts(["a"]);
    const { ws, groupId } = withLiveGroup(SSH);
    const { clock, groups } = updaterOn(() => ws, { ssh: sshSource(fake) });
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["a"]);
    fake.setSshHosts(["a", "b"]);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.command)).toEqual(["ssh a", "ssh b"]);
    groups.stop();
  });

  it("keeps the last list and reports the error when the config cannot be read", async () => {
    const fake = new FakeBackend();
    fake.setSshHosts(["a", "b"]);
    const { ws, groupId } = withLiveGroup(SSH);
    const { clock, groups } = updaterOn(() => ws, { ssh: sshSource(fake) });
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId)).toHaveLength(2);

    fake.setSshHosts([], "could not read config: access denied");
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["a", "b"]);
    expect(groups.error(groupId)).toBe("could not read config: access denied");

    fake.setSshHosts(["c"]);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["c"]);
    expect(groups.error(groupId)).toBeUndefined();
    groups.stop();
  });

  it("is one of the sources the app has", async () => {
    const fake = new FakeBackend();
    const sources = liveSourcesOf(fake);
    expect(Object.keys(sources).sort()).toEqual(["docker", "ssh", "worktrees"]);
  });
});

describe("the docker source", () => {
  const DOCKER: LiveSource = { source: "docker" };

  it("makes one entry per container that types docker exec -it <name> sh in the folder of the space", async () => {
    const fake = new FakeBackend();
    fake.setDockerContainers(["web-app", "db_1"]);
    const list = await dockerSource(fake)(DOCKER);
    expect(list).toEqual([
      { key: "web-app", label: "web-app", cwd: "", command: "docker exec -it web-app sh" },
      { key: "db_1", label: "db_1", cwd: "", command: "docker exec -it db_1 sh" },
    ]);
    expect(fake.callsTo("listDockerContainers")).toHaveLength(1);
  });

  it("lists the fixture containers of the fake backend until a test says others", async () => {
    const fake = new FakeBackend();
    expect((await dockerSource(fake)(DOCKER)).map((e) => e.label)).toEqual(FAKE_DOCKER_CONTAINERS);
    fake.setDockerContainers([]);
    expect(await dockerSource(fake)(DOCKER)).toEqual([]);
  });

  it("leaves out a name that is not safe to type, even if the backend hands it over", async () => {
    const fake = new FakeBackend();
    fake.setDockerContainers(["ok", "a;rm -rf x", "web *", "$(id)", "-v", "_x", ".x", "", "q'q"]);
    expect((await dockerSource(fake)(DOCKER)).map((e) => e.command)).toEqual([
      "docker exec -it ok sh",
    ]);
    expect(dockerEntry("a b")).toBeUndefined();
    expect(dockerEntry("host*")).toBeUndefined();
    expect(dockerEntry("-J")).toBeUndefined();
    expect(dockerEntry("_x")).toBeUndefined();
    expect(dockerEntry("a".repeat(256))).toBeUndefined();
    expect(dockerEntry("a".repeat(255))).toBeDefined();
    expect(dockerEntry("api.v2-1_x")).toMatchObject({ command: "docker exec -it api.v2-1_x sh" });
  });

  it("follows the running containers by round, and none is an empty list", async () => {
    const fake = new FakeBackend();
    fake.setDockerContainers(["a"]);
    const { ws, groupId } = withLiveGroup(DOCKER);
    const { clock, groups } = updaterOn(() => ws, { docker: dockerSource(fake) });
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["a"]);
    fake.setDockerContainers(["a", "b"]);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.command)).toEqual([
      "docker exec -it a sh",
      "docker exec -it b sh",
    ]);
    fake.setDockerContainers([]);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId)).toEqual([]);
    expect(groups.error(groupId)).toBeUndefined();
    groups.stop();
  });

  it("keeps the last list and reports the error when docker fails", async () => {
    const fake = new FakeBackend();
    fake.setDockerContainers(["a", "b"]);
    const { ws, groupId } = withLiveGroup(DOCKER);
    const { clock, groups } = updaterOn(() => ws, { docker: dockerSource(fake) });
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId)).toHaveLength(2);

    fake.setDockerContainers([], "docker not found");
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["a", "b"]);
    expect(groups.error(groupId)).toBe("docker not found");

    fake.setDockerContainers(["c"]);
    clock.advance(LIVE_REFRESH_INTERVAL_MS);
    await groups.idle();
    expect(groups.entries(groupId).map((e) => e.label)).toEqual(["c"]);
    expect(groups.error(groupId)).toBeUndefined();
    groups.stop();
  });

  it("is an empty group with the error recorded when docker is not installed from the start", async () => {
    const fake = new FakeBackend();
    fake.setDockerContainers([], "docker not found");
    const { ws, groupId } = withLiveGroup(DOCKER);
    const { groups } = updaterOn(() => ws, { docker: dockerSource(fake) });
    groups.start();
    await groups.idle();
    expect(groups.entries(groupId)).toEqual([]);
    expect(groups.error(groupId)).toBe("docker not found");
    groups.stop();
  });
});

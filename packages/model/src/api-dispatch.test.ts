/// <reference types="node" />
import { readFileSync } from "node:fs";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import {
  API_DEFAULT_READ_LINES,
  API_ERROR_CODES,
  API_LIMITS,
  API_MAX_READ_BYTES,
  API_METHODS,
  dispatchApiCall,
  parseApiCall,
} from "./api-dispatch";
import type { ApiCall, ApiHost, ApiNotification, ApiOutcome, ApiRouting } from "./api-dispatch";
import type { Backend } from "./backend";
import { createDefaultWorkspace } from "./default-workspace";
import { createBrowserPane } from "./factories";
import { FakeBackend } from "./fake-backend";
import { createSequentialIds } from "./ids";
import { checkInvariants } from "./invariants";
import type { RoutingRule } from "./routing";
import { layoutPanes } from "./sessions";
import { TerminalTail } from "./terminal-tail";
import { applyChecked, testContext } from "./test-helpers";
import { treeGroups } from "./tree";
import type { Id, LayoutNode, Space, Workspace } from "./types";

// The dispatcher of the local API (NOR-F17-01b; `notify` and the session ids NOR-F17-02a): each method against a workspace that
// goes through the real reducer (with the invariants checked at every step) and a `FakeBackend`.

interface Rig {
  host: ApiHost;
  backend: FakeBackend;
  tail: TerminalTail;
  workspace(): Workspace;
  set(ws: Workspace): void;
  apply(action: Action): void;
  /** The pane ids `attachSession` was told about, with their sessions. */
  attached: [Id, Id][];
  /** What the host was asked to show with `notify`. */
  notified: ApiNotification[];
}

interface RigOptions {
  workspace?: Workspace;
  maxPanes?: number;
  profiles?: { id: string; name: string; default: boolean }[];
  /** Runs inside `createSession`, after the shell exists and before it is handed back. */
  whileStarting?: (rig: Rig) => void;
  /** What the notifier of the host answers; `true` (shown) when left out. */
  shows?: boolean | Promise<boolean> | (() => never);
  /** The routing rules of the host; none when left out. */
  routing?: () => ApiRouting | undefined;
}

function rig(options: RigOptions = {}): Rig {
  let ws = options.workspace ?? createDefaultWorkspace({ newId: createSequentialIds("w") });
  const { ctx } = testContext();
  const backend = new FakeBackend({
    profiles: options.profiles ?? [
      { id: "fake", name: "Fake", default: true },
      { id: "zsh", name: "Zsh", default: false },
    ],
  });
  const tail = new TerminalTail();
  const attached: [Id, Id][] = [];
  const notified: ApiNotification[] = [];
  const self: Rig = {
    backend,
    tail,
    attached,
    notified,
    workspace: () => ws,
    set: (next) => {
      ws = next;
    },
    apply: (action) => {
      ws = applyChecked(ws, action, ctx);
    },
    host: {
      workspace: () => ws,
      dispatch: (action) => {
        ws = applyChecked(ws, action, ctx);
      },
      attachSession: (paneId, sessionId) => {
        attached.push([paneId, sessionId]);
        ws = withSession(ws, paneId, sessionId);
      },
      backend: {
        createSession: async (o) => {
          const id = await backend.createSession(o);
          backend.onOutput(id, (bytes) => tail.feed(id, bytes));
          options.whileStarting?.(self);
          return id;
        },
        write: (id, data) => backend.write(id, data),
        kill: (id) => backend.kill(id),
      },
      readLines: (id, count) => tail.read(id, count),
      notify: (notification) => {
        notified.push(notification);
        const shows = options.shows ?? true;
        return typeof shows === "function" ? shows() : shows;
      },
      ...(options.maxPanes !== undefined ? { maxPanes: options.maxPanes } : {}),
      ...(options.routing !== undefined ? { routing: options.routing } : {}),
    },
  };
  return self;
}

function withSession(ws: Workspace, paneId: Id, sessionId: Id): Workspace {
  const put = (layout: LayoutNode): LayoutNode =>
    layout.kind === "split"
      ? { ...layout, children: layout.children.map(put) }
      : layout.pane.id === paneId
        ? { kind: "pane", pane: { ...layout.pane, sessionId } }
        : layout;
  return {
    ...ws,
    spaces: ws.spaces.map((space) => ({
      ...space,
      items: Object.fromEntries(
        Object.entries(space.items).map(([id, item]) => [
          id,
          { ...item, layout: put(item.layout) },
        ]),
      ),
    })),
  };
}

const call = (method: ApiCall["method"], params: object = {}): ApiCall =>
  ({ method, params }) as ApiCall;

async function run(r: Rig, method: ApiCall["method"], params: object = {}): Promise<ApiOutcome> {
  return dispatchApiCall(call(method, params), r.host);
}

function resultOf(outcome: ApiOutcome): Record<string, unknown> {
  if (!("result" in outcome)) throw new Error(`expected a result, got ${JSON.stringify(outcome)}`);
  return outcome.result as Record<string, unknown>;
}

function errorOf(outcome: ApiOutcome): { code: string; message: string } {
  if (!("error" in outcome)) throw new Error(`expected an error, got ${JSON.stringify(outcome)}`);
  return outcome.error;
}

/** Makes a tab through the API and gives its ids. */
async function newTab(r: Rig, space: Id, extra: object = {}) {
  const result = resultOf(await run(r, "items.create", { space, ...extra }));
  return result as { space: Id; item: Id; terminal: Id; session: string };
}

const writes = (r: Rig): unknown[] => r.backend.callsTo("write").map((c) => c.args[1]);
const created = (r: Rig) => r.backend.callsTo("createSession").map((c) => c.args[0]);

function mainSpace(r: Rig): Space {
  const space = r.workspace().spaces[0];
  if (!space) throw new Error("no space");
  return space;
}

describe("spaces.list", () => {
  it("lists every space with its tabs and panes, a terminal being named by its pane id", async () => {
    const r = rig();
    const outcome = resultOf(await run(r, "spaces.list"));
    expect(outcome).toEqual({
      spaces: [
        {
          id: "w1",
          name: "Main",
          active: true,
          items: [
            {
              id: "w2",
              pinned: false,
              active: true,
              focused: "w3",
              panes: [
                {
                  id: "w3",
                  type: "terminal",
                  status: "idle",
                  profile: "default",
                  session: null,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("shows the session, the folder and the title a pane or tab has, and a pinned tab", async () => {
    const r = rig();
    const tab = await newTab(r, "w1", { cwd: "/work" });
    r.apply({ type: "item/rename", itemId: tab.item, title: "Build" });
    r.apply({ type: "item/pin", itemId: tab.item });
    const spaces = resultOf(await run(r, "spaces.list")).spaces as {
      items: { id: string; title?: string; pinned: boolean; active: boolean; panes: unknown[] }[];
    }[];
    const listed = spaces[0]?.items.find((i) => i.id === tab.item);
    expect(listed).toMatchObject({ title: "Build", pinned: true, active: true });
    expect(listed?.panes).toEqual([
      {
        id: tab.terminal,
        type: "terminal",
        status: "idle",
        profile: "default",
        cwd: "/work",
        session: "1",
      },
    ]);
  });

  it("marks the space the person is in as active, whatever order the spaces are in", async () => {
    const r = rig();
    r.apply({ type: "space/create", name: "Second" });
    const spaces = resultOf(await run(r, "spaces.list")).spaces as {
      name: string;
      active: boolean;
    }[];
    expect(spaces.map((s) => [s.name, s.active])).toEqual([
      ["Main", false],
      ["Second", true],
    ]);
  });

  it("changes nothing and starts nothing", async () => {
    const r = rig();
    const before = r.workspace();
    await run(r, "spaces.list");
    expect(r.workspace()).toBe(before);
    expect(r.backend.calls).toHaveLength(0);
  });
});

describe("spaces.create", () => {
  it("makes a space without showing it, and says its id", async () => {
    const r = rig();
    const result = resultOf(await run(r, "spaces.create", { name: "  Ops  " }));
    expect(result.name).toBe("Ops");
    const ws = r.workspace();
    expect(ws.spaces.map((s) => s.name)).toEqual(["Main", "Ops"]);
    expect(ws.spaces[1]?.id).toBe(result.space);
    expect(ws.activeSpaceId).toBe("w1");
    expect(ws.spaces[1]?.items).toEqual({});
    expect(r.backend.calls).toHaveLength(0);
  });

  it("two spaces with the same name are two spaces", async () => {
    const r = rig();
    const a = resultOf(await run(r, "spaces.create", { name: "Same" }));
    const b = resultOf(await run(r, "spaces.create", { name: "Same" }));
    expect(a.space).not.toBe(b.space);
    expect(r.workspace().spaces).toHaveLength(3);
  });

  it("refuses a blank name, a name that is too long and anything extra", async () => {
    const r = rig();
    const before = r.workspace();
    for (const params of [
      {},
      { name: "" },
      { name: "   " },
      { name: 5 },
      { name: "a\nb" },
      { name: "x".repeat(API_LIMITS.nameChars + 1) },
      { name: "ok", color: "red" },
    ]) {
      expect(errorOf(await run(r, "spaces.create", params)).code).toBe("invalid_params");
    }
    expect(r.workspace()).toBe(before);
  });
});

describe("items.create", () => {
  it("starts a shell and puts it in a new tab of the space, which becomes the tab it shows", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    expect(tab).toEqual({ space: "w1", item: tab.item, terminal: tab.terminal, session: "1" });
    expect(created(r)).toEqual([{ cols: 80, rows: 24 }]);
    const space = mainSpace(r);
    expect(space.activeItemId).toBe(tab.item);
    expect(space.tree.map((n) => n.id)).toEqual(["w2", tab.item]);
    const pane = layoutPanes(space.items[tab.item]?.layout as LayoutNode)[0];
    expect(pane).toMatchObject({ id: tab.terminal, type: "terminal", sessionId: "1" });
    expect(r.backend.session(1)?.alive).toBe(true);
    expect(checkInvariants(r.workspace())).toEqual([]);
  });

  it("starts the shell with the profile, folder and environment the call and the space name", async () => {
    const r = rig();
    r.apply({
      type: "space/set-defaults",
      spaceId: "w1",
      profileId: "zsh",
      cwd: "/space",
      env: { A: "1" },
      gitIdentity: { name: "Ana", email: "ana@example.com" },
    });
    await newTab(r, "w1");
    expect(created(r)[0]).toEqual({
      profileId: "zsh",
      cwd: "/space",
      env: {
        GIT_AUTHOR_NAME: "Ana",
        GIT_COMMITTER_NAME: "Ana",
        GIT_AUTHOR_EMAIL: "ana@example.com",
        GIT_COMMITTER_EMAIL: "ana@example.com",
        A: "1",
      },
      cols: 80,
      rows: 24,
    });
    const own = await newTab(r, "w1", { cwd: "/own", profile: "fake" });
    expect(created(r)[1]).toMatchObject({ profileId: "fake", cwd: "/own" });
    const pane = layoutPanes(mainSpace(r).items[own.item]?.layout as LayoutNode)[0];
    expect(pane).toMatchObject({ profileId: "fake", cwd: "/own" });
  });

  it("leaves the default profile to the backend, as the app does", async () => {
    const r = rig();
    await newTab(r, "w1", { profile: "default" });
    expect(created(r)[0]).toEqual({ cols: 80, rows: 24 });
  });

  it("starts the shell at the size the host gives", async () => {
    const r = rig();
    const sized: ApiHost = { ...r.host, size: { cols: 132, rows: 43 } };
    await dispatchApiCall(call("items.create", { space: "w1" }), sized);
    expect(created(r)[0]).toEqual({ cols: 132, rows: 43 });
  });

  it("answers not_found for a space that is not there, and starts no shell for it", async () => {
    const r = rig();
    const before = r.workspace();
    const error = errorOf(await run(r, "items.create", { space: "nope" }));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain('"nope"');
    expect(r.backend.callsTo("createSession")).toHaveLength(0);
    expect(r.workspace()).toBe(before);
  });

  it("answers failed when the shell does not start, and changes nothing", async () => {
    const r = rig();
    const before = r.workspace();
    const error = errorOf(await run(r, "items.create", { space: "w1", profile: "missing" }));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("missing");
    expect(r.workspace()).toBe(before);
    expect(r.attached).toEqual([]);
  });

  it("ends the shell and says so when the space is gone by the time the shell is up", async () => {
    const r = rig({
      whileStarting: (self) =>
        self.apply({ type: "space/delete", spaceId: "w1", items: { mode: "close" } }),
    });
    r.apply({ type: "space/create", name: "Other", activate: false });
    const error = errorOf(await run(r, "items.create", { space: "w1" }));
    expect(error.code).toBe("failed");
    expect(r.backend.callsTo("kill").map((c) => c.args[0])).toEqual([1]);
    expect(r.backend.session(1)?.alive).toBe(false);
  });

  it("refuses parameters that do not fit, with no shell started", async () => {
    const r = rig();
    for (const params of [
      { cwd: "" },
      { space: "" },
      { space: 1 },
      { space: "w1", cwd: "" },
      { space: "w1", cwd: "a\0b" },
      { space: "w1", profile: 5 },
      { space: "w1", extra: true },
      { space: "x".repeat(API_LIMITS.idChars + 1) },
    ]) {
      expect(errorOf(await run(r, "items.create", params)).code).toBe("invalid_params");
    }
    expect(r.backend.callsTo("createSession")).toHaveLength(0);
  });
});

describe("items.create without a space (routing rules)", () => {
  const UNIX = { platform: "unix", home: "/home/ana" } as const;
  const rules = (list: RoutingRule[]): (() => ApiRouting) => {
    return () => ({ rules: list, context: UNIX });
  };

  /** Main (w1, the active one) plus Work and Play, with a group "Api" in Work. */
  function routed(options: RigOptions = {}): Rig & { work: Id; play: Id; api: Id } {
    const r = rig(options);
    r.apply({ type: "space/create", name: "Work", activate: false });
    r.apply({ type: "space/create", name: "Play", activate: false });
    const work = r.workspace().spaces.find((s) => s.name === "Work")?.id as Id;
    const play = r.workspace().spaces.find((s) => s.name === "Play")?.id as Id;
    r.apply({ type: "group/create", spaceId: work, name: "Api" });
    const api = treeGroups(r.workspace().spaces.find((s) => s.id === work)?.tree ?? [])[0]
      ?.id as Id;
    return Object.assign(r, { work, play, api });
  }

  const withRules = (r: Rig, list: RoutingRule[]): ApiHost => ({ ...r.host, routing: rules(list) });
  const inSpace = (r: Rig, id: Id): Space => {
    const space = r.workspace().spaces.find((s) => s.id === id);
    if (!space) throw new Error(`no space ${id}`);
    return space;
  };

  it("goes to the active space when the host has no rules", async () => {
    const r = routed();
    const tab = resultOf(await run(r, "items.create", { cwd: "/code/api" }));
    expect(tab.space).toBe("w1");
    expect(tab).not.toHaveProperty("group");
    expect(mainSpace(r).activeItemId).toBe(tab.item);
  });

  it("goes to the active space when there are no rules or none matches", async () => {
    const r = routed();
    r.apply({ type: "space/activate", spaceId: r.play });
    for (const routing of [
      undefined,
      (): ApiRouting => ({ rules: undefined, context: UNIX }),
      rules([]),
      rules([{ cwd: "/code/**", space: "Work" }]),
    ]) {
      const host: ApiHost = { ...r.host, ...(routing !== undefined ? { routing } : {}) };
      const tab = resultOf(await dispatchApiCall(call("items.create", { cwd: "/tmp" }), host));
      expect(tab.space).toBe(r.play);
    }
    expect(inSpace(r, r.work).tree.every((n) => n.kind === "group")).toBe(true);
  });

  it("goes to the space of the first rule that matches the folder", async () => {
    const r = routed();
    const host = withRules(r, [
      { cwd: "/code/**", space: "Work" },
      { cwd: "/code/play/**", space: "Play" },
    ]);
    const tab = resultOf(
      await dispatchApiCall(call("items.create", { cwd: "/code/play/x" }), host),
    );
    expect(tab.space).toBe(r.work);
    expect(inSpace(r, r.work).activeItemId).toBe(tab.item);
    expect(created(r)[0]).toMatchObject({ cwd: "/code/play/x" });
    expect(checkInvariants(r.workspace())).toEqual([]);
  });

  it("goes by the folder the space it falls to would have used, when the call gives none", async () => {
    const r = routed();
    r.apply({ type: "space/set-defaults", spaceId: "w1", cwd: "/home/ana/notes" });
    const host = withRules(r, [{ cwd: "~/notes", space: "Play" }]);
    const tab = resultOf(await dispatchApiCall(call("items.create"), host));
    expect(tab.space).toBe(r.play);
  });

  it("goes by the profile the call names, or the default one when it names none", async () => {
    const r = routed();
    const host = withRules(r, [
      { command: "^zsh$", space: "Play" },
      { command: "^default$", space: "Work" },
    ]);
    const named = resultOf(await dispatchApiCall(call("items.create", { profile: "zsh" }), host));
    expect(named.space).toBe(r.play);
    const plain = resultOf(await dispatchApiCall(call("items.create"), host));
    expect(plain.space).toBe(r.work);
    const other = resultOf(await dispatchApiCall(call("items.create", { profile: "fake" }), host));
    expect(other.space).toBe("w1");
  });

  it("needs both parts of a rule that has a folder and a command", async () => {
    const r = routed();
    const host = withRules(r, [{ cwd: "/code/**", command: "^zsh$", space: "Work" }]);
    const one = await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host);
    expect(resultOf(one).space).toBe("w1");
    const both = await dispatchApiCall(
      call("items.create", { cwd: "/code/a", profile: "zsh" }),
      host,
    );
    expect(resultOf(both).space).toBe(r.work);
  });

  it("puts the tab in the group the rule names, and says which", async () => {
    const r = routed();
    const host = withRules(r, [{ cwd: "/code/api", space: "Work", group: "Api" }]);
    const tab = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/api" }), host));
    expect(tab).toMatchObject({ space: r.work, group: r.api, session: "1" });
    const group = treeGroups(inSpace(r, r.work).tree).find((g) => g.id === r.api);
    expect(group?.children.map((n) => n.id)).toEqual([tab.item]);
    expect(inSpace(r, r.work).activeItemId).toBe(tab.item);
    expect(checkInvariants(r.workspace())).toEqual([]);
  });

  it("puts the tab at the top of the space when the rule names no group", async () => {
    const r = routed();
    const host = withRules(r, [{ cwd: "/code/api", space: "Work" }]);
    const tab = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/api" }), host));
    expect(inSpace(r, r.work).tree.map((n) => n.id)).toContain(tab.item);
    expect(treeGroups(inSpace(r, r.work).tree).find((g) => g.id === r.api)?.children).toEqual([]);
    expect(tab).not.toHaveProperty("group");
  });

  it("falls to the active space when the space or the group of a rule is not there", async () => {
    const r = routed();
    const host = withRules(r, [
      { cwd: "/code/**", space: "Gone" },
      { cwd: "/code/**", space: "Work", group: "Gone" },
    ]);
    const tab = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host));
    expect(tab.space).toBe("w1");
    expect(tab).not.toHaveProperty("group");
    // A rule further down that does match is used, as the rules are tried in order.
    const second = withRules(r, [
      { cwd: "/code/**", space: "Gone" },
      { cwd: "/code/**", space: "Play" },
    ]);
    const next = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/a" }), second));
    expect(next.space).toBe(r.play);
  });

  it("ignores the rules when the call names a space", async () => {
    const r = routed();
    const host = withRules(r, [{ cwd: "/code/**", space: "Work", group: "Api" }]);
    const tab = resultOf(
      await dispatchApiCall(call("items.create", { space: r.play, cwd: "/code/a" }), host),
    );
    expect(tab.space).toBe(r.play);
    expect(tab).not.toHaveProperty("group");
    expect(inSpace(r, r.work).tree.every((n) => n.kind === "group")).toBe(true);
  });

  it("reads the rules at every call, so a change of the settings counts at once", async () => {
    const r = routed();
    let current: RoutingRule[] = [];
    const host: ApiHost = { ...r.host, routing: () => ({ rules: current, context: UNIX }) };
    const first = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host));
    current = [{ cwd: "/code/**", space: "Play" }];
    const second = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host));
    current = [];
    const third = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host));
    expect([first.space, second.space, third.space]).toEqual(["w1", r.play, "w1"]);
  });

  it("makes the tab in the active space when the rules cannot be read", async () => {
    const r = routed();
    const host: ApiHost = {
      ...r.host,
      routing: () => {
        throw new Error("settings broke");
      },
    };
    const tab = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host));
    expect(tab.space).toBe("w1");
  });

  it("starts the shell with the defaults of the space the rule picked", async () => {
    const r = routed();
    r.apply({ type: "space/set-defaults", spaceId: r.work, profileId: "zsh", cwd: "/work" });
    const host = withRules(r, [{ cwd: "/code/**", space: "Work" }]);
    await dispatchApiCall(call("items.create", { cwd: "/code/a" }), host);
    expect(created(r)[0]).toMatchObject({ profileId: "zsh", cwd: "/code/a" });
    const none = routed();
    none.apply({ type: "space/set-defaults", spaceId: none.work, profileId: "zsh", cwd: "/work" });
    await dispatchApiCall(
      call("items.create", { profile: "fake" }),
      withRules(none, [{ command: "^fake$", space: "Work" }]),
    );
    expect(created(none)[0]).toMatchObject({ profileId: "fake", cwd: "/work" });
  });

  it("puts the tab at the top of the space when the group went while the shell started", async () => {
    const r = routed({
      whileStarting: (self) => {
        const groups = self.workspace().spaces.flatMap((s) => treeGroups(s.tree));
        for (const group of groups) self.apply({ type: "group/ungroup", groupId: group.id });
      },
    });
    const host = withRules(r, [{ cwd: "/code/api", space: "Work", group: "Api" }]);
    const tab = resultOf(await dispatchApiCall(call("items.create", { cwd: "/code/api" }), host));
    expect(tab.space).toBe(r.work);
    expect(tab).not.toHaveProperty("group");
    expect(inSpace(r, r.work).tree.map((n) => n.id)).toEqual([tab.item]);
    expect(checkInvariants(r.workspace())).toEqual([]);
  });
});

describe("splits.create", () => {
  it("splits the pane in focus to the right and hands the new pane its own shell", async () => {
    const r = rig();
    const tab = await newTab(r, "w1", { cwd: "/work" });
    const result = resultOf(await run(r, "splits.create", { item: tab.item, direction: "right" }));
    expect(result.item).toBe(tab.item);
    // The session is the number of the shell of the new pane, as the app publishes it.
    expect(result.session).toBe("2");
    const item = mainSpace(r).items[tab.item];
    expect(item?.layout).toMatchObject({ kind: "split", dir: "row" });
    expect(item?.focusedPaneId).toBe(result.terminal);
    expect(layoutPanes(item?.layout as LayoutNode).map((p) => p.id)).toEqual([
      tab.terminal,
      result.terminal,
    ]);
    // The shell of the new pane starts where the pane it was split from is.
    expect(created(r)[1]).toMatchObject({ cwd: "/work" });
    expect(r.attached).toEqual([[result.terminal, "2"]]);
    const panes = layoutPanes(item?.layout as LayoutNode);
    expect(panes.map((p) => p.sessionId)).toEqual(["1", "2"]);
    expect(checkInvariants(r.workspace())).toEqual([]);
  });

  it("splits downwards into a column", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    await run(r, "splits.create", { item: tab.item, direction: "down" });
    expect(mainSpace(r).items[tab.item]?.layout).toMatchObject({ kind: "split", dir: "column" });
  });

  it("takes the profile and folder of the call over those of the pane", async () => {
    const r = rig();
    const tab = await newTab(r, "w1", { cwd: "/work" });
    const result = resultOf(
      await run(r, "splits.create", {
        item: tab.item,
        direction: "down",
        cwd: "/else",
        profile: "zsh",
      }),
    );
    expect(created(r)[1]).toMatchObject({ cwd: "/else", profileId: "zsh" });
    const pane = layoutPanes(mainSpace(r).items[tab.item]?.layout as LayoutNode).find(
      (p) => p.id === result.terminal,
    );
    expect(pane).toMatchObject({ cwd: "/else", profileId: "zsh" });
  });

  it("splits the pane that has focus when the tab has several", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    await run(r, "splits.create", { item: tab.item, direction: "right" });
    r.apply({ type: "pane/focus", itemId: tab.item, paneId: tab.terminal });
    const third = resultOf(await run(r, "splits.create", { item: tab.item, direction: "down" }));
    const layout = mainSpace(r).items[tab.item]?.layout;
    // The new pane went below the first one, not below the one on the right.
    expect(layout).toMatchObject({
      kind: "split",
      dir: "row",
      children: [{ kind: "split", dir: "column" }, { kind: "pane" }],
    });
    expect(mainSpace(r).items[tab.item]?.focusedPaneId).toBe(third.terminal);
  });

  it("answers not_found for a tab that is not there, and starts no shell", async () => {
    const r = rig();
    const before = r.workspace();
    const error = errorOf(await run(r, "splits.create", { item: "ghost", direction: "right" }));
    expect(error.code).toBe("not_found");
    expect(r.backend.callsTo("createSession")).toHaveLength(0);
    expect(r.workspace()).toBe(before);
  });

  it("refuses a split over the most panes a tab may hold, before a shell is started", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    for (let n = 0; n < 3; n++) {
      resultOf(await run(r, "splits.create", { item: tab.item, direction: "right" }));
    }
    const shells = r.backend.callsTo("createSession").length;
    const error = errorOf(await run(r, "splits.create", { item: tab.item, direction: "right" }));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("4");
    expect(r.backend.callsTo("createSession")).toHaveLength(shells);

    const small = rig({ maxPanes: 2 });
    const one = await newTab(small, "w1");
    resultOf(await run(small, "splits.create", { item: one.item, direction: "down" }));
    expect(
      errorOf(await run(small, "splits.create", { item: one.item, direction: "down" })).code,
    ).toBe("failed");
  });

  it("answers failed when the shell does not start, and ends the shell when the tab is gone", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const before = r.workspace();
    const bad = await run(r, "splits.create", {
      item: tab.item,
      direction: "right",
      profile: "nope",
    });
    expect(errorOf(bad).code).toBe("failed");
    expect(r.workspace()).toBe(before);

    const racing = rig({
      whileStarting: (self) => {
        if (self.backend.callsTo("createSession").length === 2) {
          self.apply({ type: "item/close", itemId: "w2" });
        }
      },
    });
    const keep = await newTab(racing, "w1");
    expect(keep.item).not.toBe("w2");
    const gone = await run(racing, "splits.create", { item: "w2", direction: "right" });
    expect(errorOf(gone).code).toBe("not_found");
    expect(racing.backend.callsTo("kill")).toHaveLength(1);
  });

  it("refuses parameters that do not fit", async () => {
    const r = rig();
    for (const params of [
      {},
      { item: "w2" },
      { item: "w2", direction: "left" },
      { item: "w2", direction: 1 },
      { item: "w2", direction: "right", extra: 1 },
      { direction: "right" },
    ]) {
      expect(errorOf(await run(r, "splits.create", params)).code).toBe("invalid_params");
    }
    expect(r.backend.callsTo("createSession")).toHaveLength(0);
  });
});

describe("terminal.send", () => {
  it("writes the text as it is and nothing more: no Enter is added (D8)", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const result = resultOf(
      await run(r, "terminal.send", { terminal: tab.terminal, text: "rm -rf build" }),
    );
    expect(writes(r)).toEqual(["rm -rf build"]);
    expect(result).toEqual({ terminal: tab.terminal, bytes: 12 });
  });

  it("presses the keys by name, after the text, in one write", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    await run(r, "terminal.send", { terminal: tab.terminal, text: "ls", keys: ["Enter"] });
    await run(r, "terminal.send", { terminal: tab.terminal, keys: ["Ctrl+C"] });
    await run(r, "terminal.send", { terminal: tab.terminal, keys: ["Up", "Up", "Enter"] });
    await run(r, "terminal.send", { terminal: tab.terminal, text: "ä€", keys: ["Alt+b", "F5"] });
    expect(writes(r)).toEqual(["ls\r", "\x03", "\x1b[A\x1b[A\r", "ä€\x1bb\x1b[15~"]);
  });

  it("counts the bytes it wrote, not the characters", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const result = resultOf(
      await run(r, "terminal.send", { terminal: tab.terminal, text: "é€😀" }),
    );
    expect(result.bytes).toBe(2 + 3 + 4);
  });

  it("sends the text as typed, with its own line breaks and control characters", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const text = "a\r\nb\x1b[A\t";
    await run(r, "terminal.send", { terminal: tab.terminal, text });
    expect(writes(r)).toEqual([text]);
  });

  it("answers invalid_params for a key it does not know and writes nothing, not even the text", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const error = errorOf(
      await run(r, "terminal.send", {
        terminal: tab.terminal,
        text: "ls",
        keys: ["Enter", "Hyper+Q", "Tab"],
      }),
    );
    expect(error.code).toBe("invalid_params");
    expect(error.message).toContain("Hyper+Q");
    expect(r.backend.callsTo("write")).toHaveLength(0);
    for (const keys of [
      ["Meta"],
      ["Ctrl+Shift+C"],
      ["F13"],
      ["Shift+1"],
      ["Ctrl+1"],
      ["Ctrl+Enter"],
    ]) {
      expect(errorOf(await run(r, "terminal.send", { terminal: tab.terminal, keys })).code).toBe(
        "invalid_params",
      );
    }
    expect(r.backend.callsTo("write")).toHaveLength(0);
  });

  it("answers not_found for a terminal that is not there (a tab or a space id is not one)", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    for (const terminal of ["ghost", tab.item, "w1"]) {
      const error = errorOf(await run(r, "terminal.send", { terminal, text: "x" }));
      expect(error.code).toBe("not_found");
    }
    expect(r.backend.callsTo("write")).toHaveLength(0);
  });

  it("answers failed for a pane that is no terminal, one with no shell yet and one whose shell exited", async () => {
    const r = rig();
    // w3, the pane of the first tab, has no shell yet.
    expect(errorOf(await run(r, "terminal.send", { terminal: "w3", text: "x" }))).toMatchObject({
      code: "failed",
      message: expect.stringContaining("no shell"),
    });

    const tab = await newTab(r, "w1");
    r.apply({
      type: "pane/set-status",
      itemId: tab.item,
      paneId: tab.terminal,
      status: "exited",
      exitCode: 0,
    });
    expect(
      errorOf(await run(r, "terminal.send", { terminal: tab.terminal, text: "x" })),
    ).toMatchObject({
      code: "failed",
      message: expect.stringContaining("exited"),
    });

    const ws = r.workspace();
    const space = ws.spaces[0] as Space;
    const item = space.items[tab.item];
    if (!item) throw new Error("no item");
    r.set({
      ...ws,
      spaces: [
        {
          ...space,
          items: {
            ...space.items,
            [item.id]: {
              ...item,
              layout: { kind: "pane", pane: createBrowserPane("web", "https://example.com") },
            },
          },
        },
      ],
    });
    expect(errorOf(await run(r, "terminal.send", { terminal: "web", text: "x" }))).toMatchObject({
      code: "failed",
      message: expect.stringContaining("not a terminal"),
    });
    expect(r.backend.callsTo("write")).toHaveLength(0);
  });

  it("answers failed when the shell is gone from the backend", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    await r.backend.kill(1);
    const error = errorOf(await run(r, "terminal.send", { terminal: tab.terminal, text: "x" }));
    expect(error.code).toBe("failed");
  });

  it("refuses parameters that do not fit", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const terminal = tab.terminal;
    for (const params of [
      {},
      { terminal },
      { terminal, text: "" },
      { terminal, keys: [] },
      { terminal, keys: "Enter" },
      { terminal, keys: [1] },
      { terminal, keys: ["a b"] },
      { terminal, keys: ["x".repeat(API_LIMITS.keyChars + 1)] },
      { terminal, keys: Array.from({ length: API_LIMITS.sendKeys + 1 }, () => "a") },
      { terminal, text: "x".repeat(API_LIMITS.sendTextBytes + 1) },
      { terminal, text: 5 },
      { terminal, text: "x", extra: 1 },
    ]) {
      expect(errorOf(await run(r, "terminal.send", params)).code).toBe("invalid_params");
    }
    expect(r.backend.callsTo("write")).toHaveLength(0);
    // The limits are inclusive.
    const exact = "x".repeat(API_LIMITS.sendTextBytes);
    expect("result" in (await run(r, "terminal.send", { terminal, text: exact }))).toBe(true);
  });
});

describe("terminal.read", () => {
  it("gives the last lines the terminal printed as plain text, the open prompt included", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    r.backend.sendOutput(1, "\x1b[32mone\x1b[0m\r\ntwo\r\nthree\r\n");
    const result = resultOf(await run(r, "terminal.read", { terminal: tab.terminal }));
    expect(result).toEqual({
      terminal: tab.terminal,
      lines: ["fake$ one", "two", "three"],
      truncated: false,
    });
  });

  it("gives only as many lines as asked, the newest ones", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    r.backend.sendOutput(1, "a\r\nb\r\nc\r\nd\r\n");
    const result = resultOf(await run(r, "terminal.read", { terminal: tab.terminal, lines: 2 }));
    expect(result.lines).toEqual(["c", "d"]);
    const one = resultOf(await run(r, "terminal.read", { terminal: tab.terminal, lines: 1 }));
    expect(one.lines).toEqual(["d"]);
    const wide = resultOf(await run(r, "terminal.read", { terminal: tab.terminal, lines: 10_000 }));
    expect((wide.lines as string[]).length).toBe(4);
  });

  it("asks for a hundred lines when it is not told", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const asked: number[] = [];
    const host: ApiHost = {
      ...r.host,
      readLines: (_id, count) => {
        asked.push(count);
        return [];
      },
    };
    await dispatchApiCall(call("terminal.read", { terminal: tab.terminal }), host);
    await dispatchApiCall(call("terminal.read", { terminal: tab.terminal, lines: 7 }), host);
    expect(asked).toEqual([API_DEFAULT_READ_LINES, 7]);
    expect(API_DEFAULT_READ_LINES).toBe(100);
  });

  it("refuses lines outside the limit, and reads nothing", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    let reads = 0;
    const host: ApiHost = {
      ...r.host,
      readLines: () => {
        reads++;
        return [];
      },
    };
    for (const lines of [0, -1, 1.5, API_LIMITS.readLines + 1, 1e9, "5", Number.NaN, true]) {
      const outcome = await dispatchApiCall(
        call("terminal.read", { terminal: tab.terminal, lines }),
        host,
      );
      expect(errorOf(outcome).code).toBe("invalid_params");
    }
    expect(reads).toBe(0);
    const edge = await dispatchApiCall(
      call("terminal.read", { terminal: tab.terminal, lines: API_LIMITS.readLines }),
      host,
    );
    expect("result" in edge).toBe(true);
  });

  it("keeps the newest lines and says so when the answer would pass the limit", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const big = "x".repeat(API_MAX_READ_BYTES / 2 - 100);
    const host: ApiHost = { ...r.host, readLines: () => ["old", big, big, big] };
    const result = resultOf(
      await dispatchApiCall(call("terminal.read", { terminal: tab.terminal, lines: 4 }), host),
    );
    expect((result.lines as string[]).length).toBe(2);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(API_MAX_READ_BYTES + 200);
  });

  it("counts a line in bytes, not characters", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const wide = "€".repeat(Math.floor(API_MAX_READ_BYTES / 3) - 10);
    const host: ApiHost = { ...r.host, readLines: () => [wide, wide] };
    const result = resultOf(
      await dispatchApiCall(call("terminal.read", { terminal: tab.terminal }), host),
    );
    expect(result.lines).toEqual([wide]);
    expect(result.truncated).toBe(true);
  });

  it("takes an asynchronous reader, and trusts a reader that gives more than was asked no further", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const host: ApiHost = {
      ...r.host,
      readLines: async () => ["1", "2", "3", "4"],
    };
    const result = resultOf(
      await dispatchApiCall(call("terminal.read", { terminal: tab.terminal, lines: 2 }), host),
    );
    expect(result.lines).toEqual(["3", "4"]);
  });

  it("answers failed when the reader fails", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const host: ApiHost = {
      ...r.host,
      readLines: () => Promise.reject(new Error("no buffer\nfor you")),
    };
    const error = errorOf(
      await dispatchApiCall(call("terminal.read", { terminal: tab.terminal }), host),
    );
    expect(error).toEqual({
      code: "failed",
      message: "the output could not be read: no buffer for you",
    });
  });

  it("answers not_found, or failed, for what is not a terminal with a shell", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    expect(errorOf(await run(r, "terminal.read", { terminal: "ghost" })).code).toBe("not_found");
    expect(errorOf(await run(r, "terminal.read", { terminal: tab.item })).code).toBe("not_found");
    expect(errorOf(await run(r, "terminal.read", { terminal: "w3" })).code).toBe("failed");
  });

  it("reads a shell that has exited: what it printed is still there", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    r.backend.sendOutput(1, "bye\r\n");
    r.apply({
      type: "pane/set-status",
      itemId: tab.item,
      paneId: tab.terminal,
      status: "exited",
      exitCode: 1,
    });
    const result = resultOf(await run(r, "terminal.read", { terminal: tab.terminal }));
    expect(result.lines).toEqual(["fake$ bye"]);
  });

  it("refuses parameters that do not fit", async () => {
    const r = rig();
    for (const params of [{}, { terminal: "" }, { terminal: "w3", to: 5 }, { terminal: 5 }]) {
      expect(errorOf(await run(r, "terminal.read", params)).code).toBe("invalid_params");
    }
  });
});

describe("notify", () => {
  it("asks the host to show the notification and says whether it was shown", async () => {
    const r = rig();
    expect(resultOf(await run(r, "notify", { title: "Build done" }))).toEqual({ shown: true });
    expect(r.notified).toEqual([{ title: "Build done" }]);
  });

  it("hands over the body and the pane of the terminal it is about, and names the terminal in the answer", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const result = resultOf(
      await run(r, "notify", { title: "Tests", body: "all green", terminal: tab.terminal }),
    );
    expect(result).toEqual({ shown: true, terminal: tab.terminal });
    expect(r.notified).toEqual([{ title: "Tests", body: "all green", paneId: tab.terminal }]);
  });

  it("answers shown: false when the host did not show it (settings off, held back, refused)", async () => {
    for (const shows of [false, Promise.resolve(false)]) {
      const r = rig({ shows });
      expect(resultOf(await run(r, "notify", { title: "Quiet" }))).toEqual({ shown: false });
      expect(r.notified).toHaveLength(1);
    }
    // A notifier that throws or rejects is no error of the call: the system did not show it.
    const throwing = rig({
      shows: () => {
        throw new Error("the system refused");
      },
    });
    expect(resultOf(await run(throwing, "notify", { title: "Refused" }))).toEqual({
      shown: false,
    });
    const rejecting = rig({ shows: Promise.reject(new Error("the system refused")) });
    expect(resultOf(await run(rejecting, "notify", { title: "Refused" }))).toEqual({
      shown: false,
    });
  });

  it("answers shown: false when the host has no notifier", async () => {
    const r = rig();
    const bare: ApiHost = { ...r.host };
    delete bare.notify;
    const outcome = await dispatchApiCall(call("notify", { title: "Nobody" }), bare);
    expect(resultOf(outcome)).toEqual({ shown: false });
  });

  it("answers not_found for a terminal that is not there, and shows nothing", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    for (const terminal of ["ghost", tab.item, "w1", "constructor", "__proto__"]) {
      const error = errorOf(await run(r, "notify", { title: "Lost", terminal }));
      expect(error.code, terminal).toBe("not_found");
    }
    expect(r.notified).toEqual([]);
  });

  it("answers failed for a pane that is no terminal, and shows nothing", async () => {
    const r = rig();
    const ws = r.workspace();
    const space = ws.spaces[0] as Space;
    const item = Object.values(space.items)[0];
    if (!item) throw new Error("no item");
    r.set({
      ...ws,
      spaces: [
        {
          ...space,
          items: {
            ...space.items,
            [item.id]: {
              ...item,
              layout: { kind: "pane", pane: createBrowserPane("web", "https://example.com") },
            },
          },
        },
      ],
    });
    expect(errorOf(await run(r, "notify", { title: "Page", terminal: "web" }))).toMatchObject({
      code: "failed",
      message: expect.stringContaining("not a terminal"),
    });
    expect(r.notified).toEqual([]);
  });

  it("refuses an empty, blank, too long or multi-line title, a body that is too long, and anything extra", async () => {
    const r = rig();
    const bad: object[] = [
      {},
      { title: "" },
      { title: "   " },
      { title: 5 },
      { title: "a\nb" },
      { title: "x".repeat(API_LIMITS.notifyTitleChars + 1) },
      { title: "ok", body: "" },
      { title: "ok", body: 7 },
      { title: "ok", body: "x".repeat(API_LIMITS.notifyBodyChars + 1) },
      { title: "ok", terminal: "" },
      { title: "ok", sound: true },
    ];
    for (const params of bad) {
      expect(errorOf(await run(r, "notify", params)).code, JSON.stringify(params)).toBe(
        "invalid_params",
      );
    }
    expect(r.notified).toEqual([]);
    // The limits themselves are good.
    const edge = {
      title: "t".repeat(API_LIMITS.notifyTitleChars),
      body: "b".repeat(API_LIMITS.notifyBodyChars),
    };
    expect(resultOf(await run(r, "notify", edge))).toEqual({ shown: true });
  });
});

describe("a call that does not fit", () => {
  it("is an error answer and never a throw", async () => {
    const r = rig();
    const cases: [unknown, string][] = [
      [null, "invalid_request"],
      [undefined, "invalid_request"],
      [5, "invalid_request"],
      ["spaces.list", "invalid_request"],
      [[], "invalid_request"],
      [{}, "invalid_request"],
      [{ method: 5 }, "invalid_request"],
      [{ method: "spaces.list", extra: 1 }, "invalid_request"],
      [{ method: "files.delete", params: {} }, "unknown_method"],
      [{ method: "Spaces.List" }, "unknown_method"],
      [{ method: "spaces.list", params: [] }, "invalid_params"],
      [{ method: "spaces.list", params: "x" }, "invalid_params"],
      [{ method: "spaces.list", params: { x: 1 } }, "invalid_params"],
    ];
    for (const [value, code] of cases) {
      const outcome = await dispatchApiCall(value as ApiCall, r.host);
      expect(errorOf(outcome).code, JSON.stringify(value)).toBe(code);
    }
    expect(r.backend.calls).toHaveLength(0);
  });

  it("accepts a call whose params are absent or null where there are none to give", async () => {
    const r = rig();
    for (const value of [{ method: "spaces.list" }, { method: "spaces.list", params: null }]) {
      expect("result" in (await dispatchApiCall(value as ApiCall, r.host))).toBe(true);
    }
  });

  it("is never taken for a tab, a space or a terminal by a name that is on Object.prototype", async () => {
    const r = rig();
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(errorOf(await run(r, "splits.create", { item: id, direction: "right" })).code).toBe(
        "not_found",
      );
      expect(errorOf(await run(r, "items.create", { space: id })).code).toBe("not_found");
      expect(errorOf(await run(r, "terminal.send", { terminal: id, text: "x" })).code).toBe(
        "not_found",
      );
      expect(errorOf(await run(r, "terminal.read", { terminal: id })).code).toBe("not_found");
    }
  });
});

describe("a host that breaks", () => {
  it("is an internal error answer, whatever fails and wherever", async () => {
    const r = rig();
    const tab = await newTab(r, "w1");
    const boom = () => {
      throw new Error("boom");
    };
    const calls: ApiCall[] = [
      call("spaces.list"),
      call("spaces.create", { name: "x" }),
      call("items.create", { space: "w1" }),
      call("splits.create", { item: tab.item, direction: "right" }),
      call("terminal.send", { terminal: tab.terminal, text: "x" }),
      call("terminal.read", { terminal: tab.terminal }),
      call("notify", { title: "x", terminal: tab.terminal }),
    ];
    for (const c of calls) {
      const outcome = await dispatchApiCall(c, { ...r.host, workspace: boom });
      expect(errorOf(outcome).code, c.method).toBe("internal");
      expect(errorOf(outcome).message).toContain("boom");
    }
    // The ones that change the workspace also break when the change cannot be made, and a shell
    // they started for it does not stay behind.
    for (const c of calls.slice(1, 4)) {
      const shells = r.backend.callsTo("createSession").length;
      const kills = r.backend.callsTo("kill").length;
      const outcome = await dispatchApiCall(c, { ...r.host, dispatch: boom });
      expect(errorOf(outcome).code, c.method).toBe("internal");
      const started = r.backend.callsTo("createSession").length - shells;
      expect(r.backend.callsTo("kill").length - kills, c.method).toBe(started);
    }
  });

  it("shows a rejection that is no Error, and an empty one, as a sentence", async () => {
    const r = rig();
    const host = (reject: unknown): ApiHost => ({
      ...r.host,
      backend: {
        ...r.host.backend,
        createSession: () => Promise.reject(reject),
      } as Pick<Backend, "createSession" | "write" | "kill">,
    });
    const text = errorOf(
      await dispatchApiCall(call("items.create", { space: "w1" }), host("plain text")),
    );
    expect(text.message).toBe("the shell did not start: plain text");
    const empty = errorOf(
      await dispatchApiCall(call("items.create", { space: "w1" }), host(new Error(""))),
    );
    expect(empty.message).toBe("the shell did not start: no reason given");
    const long = errorOf(
      await dispatchApiCall(call("items.create", { space: "w1" }), host("y".repeat(500))),
    );
    expect(long.message.length).toBeLessThan(260);
  });
});

describe("a long run of calls", () => {
  it("never breaks the workspace, never answers internal, and every answer is a result or an error", async () => {
    const intent = fc.record({
      kind: fc.constantFrom(...API_METHODS),
      pick: fc.nat(50),
      bogus: fc.boolean(),
      text: fc.string({ maxLength: 20 }),
      cwd: fc.option(fc.constantFrom("/a", "/b"), { nil: undefined }),
      down: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(intent, { maxLength: 25 }), async (intents) => {
        const r = rig();
        for (const i of intents) {
          const ws = r.workspace();
          const spaces = ws.spaces.map((s) => s.id);
          const items = ws.spaces.flatMap((s) => Object.keys(s.items));
          const panes = ws.spaces.flatMap((s) =>
            Object.values(s.items).flatMap((it) => layoutPanes(it.layout).map((p) => p.id)),
          );
          const pickFrom = (list: string[]) =>
            i.bogus || list.length === 0 ? "bogus" : (list[i.pick % list.length] as string);
          const byMethod = {
            "spaces.list": {},
            "spaces.create": {
              name: i.text.trim() === "" ? "S" : i.text.replace(/\p{Cc}/gu, "") || "S",
            },
            "items.create": { space: pickFrom(spaces), ...(i.cwd ? { cwd: i.cwd } : {}) },
            "splits.create": { item: pickFrom(items), direction: i.down ? "down" : "right" },
            "terminal.send": { terminal: pickFrom(panes), text: i.text || "x" },
            "terminal.read": { terminal: pickFrom(panes), lines: 1 + (i.pick % 5) },
            notify: {
              title: i.text.trim() === "" ? "T" : i.text.replace(/\p{Cc}/gu, "") || "T",
              ...(i.pick % 2 === 0 ? { terminal: pickFrom(panes) } : {}),
            },
          } as const;
          const outcome = await dispatchApiCall(call(i.kind, byMethod[i.kind]), r.host);
          const keys = Object.keys(outcome);
          expect(keys.length).toBe(1);
          if ("error" in outcome) {
            expect(API_ERROR_CODES).toContain(outcome.error.code);
            expect(outcome.error.code).not.toBe("internal");
          }
          expect(checkInvariants(r.workspace())).toEqual([]);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("answers anything it is given with a result or an error and never rejects", async () => {
    const r = rig();
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const outcome = await dispatchApiCall(value as ApiCall, r.host);
        expect(Object.keys(outcome)).toHaveLength(1);
      }),
      { numRuns: 300 },
    );
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...API_METHODS), fc.jsonValue(), async (method, params) => {
        const outcome = await dispatchApiCall({ method, params } as ApiCall, r.host);
        expect(Object.keys(outcome)).toHaveLength(1);
        if ("error" in outcome) expect(outcome.error.code).not.toBe("internal");
      }),
      { numRuns: 300 },
    );
  });
});

describe("parseApiCall", () => {
  it("reads a call of each method into the form the server hands over", () => {
    const cases: ApiCall[] = [
      { method: "spaces.list", params: {} },
      { method: "spaces.create", params: { name: "Work" } },
      { method: "items.create", params: { space: "s1", cwd: "/tmp" } },
      { method: "splits.create", params: { item: "i1", direction: "down" } },
      {
        method: "terminal.send",
        params: { terminal: "t1", text: "ls\r", keys: ["Ctrl+C", "Enter"] },
      },
      { method: "terminal.read", params: { terminal: "t1", lines: 50 } },
      { method: "notify", params: { title: "Done" } },
      { method: "notify", params: { title: "Done", body: "all green", terminal: "t1" } },
    ];
    for (const c of cases) expect(parseApiCall(c)).toEqual({ ok: true, call: c });
  });

  it("drops a null the way the server drops an absent field", () => {
    const parsed = parseApiCall({
      method: "items.create",
      params: { space: "s", cwd: null, profile: null },
    });
    expect(parsed).toEqual({ ok: true, call: { method: "items.create", params: { space: "s" } } });
    const none = parseApiCall({ method: "items.create", params: { space: null } });
    expect(none).toEqual({ ok: true, call: { method: "items.create", params: {} } });
    expect(parseApiCall({ method: "items.create" })).toEqual({
      ok: true,
      call: { method: "items.create", params: {} },
    });
  });

  it("counts the length of a line in characters and of a text in bytes", () => {
    const name = "€".repeat(API_LIMITS.nameChars);
    expect(parseApiCall({ method: "spaces.create", params: { name } }).ok).toBe(true);
    const text = "€".repeat(Math.floor(API_LIMITS.sendTextBytes / 3));
    expect(parseApiCall({ method: "terminal.send", params: { terminal: "t", text } }).ok).toBe(
      true,
    );
    const over = "€".repeat(Math.floor(API_LIMITS.sendTextBytes / 3) + 1);
    expect(
      parseApiCall({ method: "terminal.send", params: { terminal: "t", text: over } }).ok,
    ).toBe(false);
  });
});

// The dispatcher mirrors `crates/noren-core/src/api/protocol.rs`. Nothing there is changed by this
// task; this test reads the file so the two cannot drift apart unnoticed.
describe("the format of the Rust side", () => {
  const rust = readFileSync(
    new URL("../../../crates/noren-core/src/api/protocol.rs", import.meta.url),
    "utf8",
  );

  it("has the same methods, in the same order", () => {
    const body =
      /pub fn name\(self\)[^{]*\{\s*match self \{([\s\S]*?)\n {8}\}/.exec(rust)?.[1] ?? "";
    const names = [...body.matchAll(/=> "([a-z.]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([...API_METHODS]);
  });

  it("has the same error codes", () => {
    const body =
      /pub fn as_str\(self\)[^{]*\{\s*match self \{([\s\S]*?)\n {8}\}/.exec(rust)?.[1] ?? "";
    const codes = [...body.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]);
    expect(codes).toEqual([...API_ERROR_CODES]);
  });

  it("has the same limits", () => {
    const limit = (name: string): number => {
      const expression = new RegExp(`pub const ${name}: \\w+ = ([0-9_ *]+);`).exec(rust)?.[1];
      if (expression === undefined) throw new Error(`no ${name} in protocol.rs`);
      return expression
        .split("*")
        .reduce((product, part) => product * Number(part.replace(/_/g, "").trim()), 1);
    };
    expect(API_LIMITS).toEqual({
      idChars: limit("MAX_ID_CHARS"),
      nameChars: limit("MAX_NAME_CHARS"),
      pathChars: limit("MAX_PATH_CHARS"),
      sendTextBytes: limit("MAX_SEND_TEXT_BYTES"),
      sendKeys: limit("MAX_SEND_KEYS"),
      keyChars: limit("MAX_KEY_CHARS"),
      readLines: limit("MAX_READ_LINES"),
      notifyTitleChars: limit("MAX_NOTIFY_TITLE_CHARS"),
      notifyBodyChars: limit("MAX_NOTIFY_BODY_CHARS"),
    });
  });

  it("has the same parameters for each call", () => {
    const fieldsOf = (variant: string): string[] => {
      const block = new RegExp(`${variant}(?: \\{([^}]*)\\})?,`).exec(
        rust.slice(rust.indexOf("pub enum ApiCall")),
      );
      return [...(block?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1] as string).sort();
    };
    expect(fieldsOf("SpacesList")).toEqual([]);
    expect(fieldsOf("SpacesCreate")).toEqual(["name"]);
    expect(fieldsOf("ItemsCreate")).toEqual(["cwd", "profile", "space"]);
    // The space of items.create is the one optional id: a tab with none is placed by the app.
    expect(rust).toMatch(/ItemsCreate \{\s*space: Option<String>,/);
    expect(fieldsOf("SplitsCreate")).toEqual(["cwd", "direction", "item", "profile"]);
    expect(fieldsOf("TerminalSend")).toEqual(["keys", "terminal", "text"]);
    expect(fieldsOf("TerminalRead")).toEqual(["lines", "terminal"]);
    expect(fieldsOf("Notify")).toEqual(["body", "terminal", "title"]);
  });
});

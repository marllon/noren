import { describe, expect, it } from "vitest";
import type { CreateSessionOptions } from "./backend";
import { createDefaultWorkspace } from "./default-workspace";
import { FakeBackend } from "./fake-backend";
import { checkInvariants } from "./invariants";
import { restoreWorkspace } from "./restore";
import { layoutPanes } from "./sessions";
import { serializeWorkspace } from "./state";
import { STATE_V0_FIXTURE, richWorkspace } from "./state-fixtures";
import { createPane, createTab } from "./factories";
import type { Pane, Workspace } from "./types";

/** The fixtures use the profile "bash"; the fake backend only knows the profiles it is given. */
const BASH = [{ id: "bash", name: "Bash", default: true }];

const allPanes = (ws: Workspace): Pane[] =>
  ws.spaces.flatMap((space) =>
    Object.values(space.items).flatMap((item) => layoutPanes(item.layout)),
  );

const paneById = (ws: Workspace, id: string): Pane => {
  const found = allPanes(ws).find((pane) => pane.id === id);
  if (!found) throw new Error(`no pane ${id}`);
  return found;
};

/** Every session the fake backend started is held by exactly one pane, and nothing else. */
function expectNoOrphans(backend: FakeBackend, ws: Workspace): void {
  const held = allPanes(ws)
    .map((pane) => pane.sessionId)
    .filter((id): id is string => id !== undefined)
    .sort();
  // Failed attempts count as calls but not as sessions: the fake only numbers the ones that started.
  const alive: string[] = [];
  for (let id = 1; id <= backend.callsTo("createSession").length; id++) {
    if (backend.session(id)?.alive) alive.push(String(id));
  }
  expect(held).toEqual(alive.sort());
  expect(new Set(held).size).toBe(held.length);
}

describe("restoreWorkspace with a valid state", () => {
  it("recreates one session per pane in the saved cwd", async () => {
    const saved = richWorkspace();
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const result = await restoreWorkspace(backend);

    expect(result.source).toBe("saved");
    expect(result.failedPaneIds).toEqual([]);
    expect(backend.quarantineCount).toBe(0);
    expect(backend.callsTo("createSession")).toHaveLength(3);

    const cwdOf = (id: string): string | undefined => {
      const sessionId = paneById(result.workspace, id).sessionId;
      return sessionId === undefined ? undefined : backend.session(Number(sessionId))?.cwd;
    };
    expect(cwdOf("p1")).toBe("/work/app");
    expect(cwdOf("p3")).toBe("/work/docs");
    // p2 saved no cwd: it gets the space default.
    expect(cwdOf("p2")).toBe("/work");
    expectNoOrphans(backend, result.workspace);
  });

  it("gives every pane a live session and a clean status", async () => {
    const saved = richWorkspace();
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const { workspace } = await restoreWorkspace(backend);
    for (const pane of allPanes(workspace)) {
      expect(pane.sessionId).toBeDefined();
      expect(backend.session(Number(pane.sessionId))?.alive).toBe(true);
      expect(pane.status).toBe("idle");
      expect(pane).not.toHaveProperty("exitCode");
    }
    expect(checkInvariants(workspace)).toEqual([]);
  });

  it("keeps everything else as saved", async () => {
    const saved = richWorkspace();
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const { workspace } = await restoreWorkspace(backend);
    const strip = (ws: Workspace): unknown =>
      JSON.parse(
        JSON.stringify(ws, (key, value: unknown) =>
          key === "sessionId" || key === "status" ? undefined : value,
        ),
      );
    expect(strip(workspace)).toEqual(strip(saved));
    expect(workspace.activeSpaceId).toBe("s1");
    expect(workspace.favorites).toEqual(["i1"]);
    expect(workspace.closed).toHaveLength(1);
  });

  it("starts nothing for closed items", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const { workspace } = await restoreWorkspace(backend);
    expect(workspace.closed[0]?.item.layout).toMatchObject({
      kind: "pane",
      pane: { id: "p4", cwd: "/old" },
    });
    expect(JSON.stringify(workspace.closed)).not.toContain("sessionId");
  });

  it("uses the profile of the pane, and the backend default for the sentinel profile", async () => {
    const backend = new FakeBackend({
      state: serializeWorkspace(richWorkspace()),
      profiles: [
        { id: "bash", name: "Bash", default: false },
        { id: "zsh", name: "Zsh", default: true },
      ],
    });
    const { workspace } = await restoreWorkspace(backend);
    const profileOf = (id: string): string | undefined =>
      backend.session(Number(paneById(workspace, id).sessionId))?.profileId;
    expect(profileOf("p1")).toBe("bash");
    expect(profileOf("p2")).toBe("zsh");
  });

  it("passes the space env and the requested size", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const { workspace } = await restoreWorkspace(backend, { cols: 120, rows: 40 });
    const session = backend.session(Number(paneById(workspace, "p1").sessionId));
    expect(session).toMatchObject({ cols: 120, rows: 40 });
    expect(session?.env["MODE"]).toBe("dev");
  });

  it("migrates an old file, then recreates its sessions", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: STATE_V0_FIXTURE });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("saved");
    expect(result.migratedFrom).toBe(0);
    expect(result.workspace.version).toBe(2);
    expect(result.workspace.activeSpaceId).toBe("s2");
    expect(backend.quarantineCount).toBe(0);
    const p1 = paneById(result.workspace, "p1");
    expect(backend.session(Number(p1.sessionId))?.cwd).toBe("/work/app");
    // The stale session ids of the file are gone.
    expect(allPanes(result.workspace).every((pane) => !pane.sessionId?.startsWith("old"))).toBe(
      true,
    );
    expectNoOrphans(backend, result.workspace);
  });

  it("does not rewrite the file by itself", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    await restoreWorkspace(backend);
    expect(backend.callsTo("saveState")).toHaveLength(0);
  });
});

describe("restoreWorkspace with no usable state", () => {
  it("uses the default workspace, with a session, when there is no file", async () => {
    const backend = new FakeBackend();
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("fresh");
    expect(result.reason).toBeUndefined();
    expect(backend.quarantineCount).toBe(0);
    expect(backend.callsTo("quarantineState")).toHaveLength(0);
    expect(result.workspace.spaces.map((s) => s.name)).toEqual(["Main"]);
    expect(allPanes(result.workspace)).toHaveLength(1);
    expect(backend.callsTo("createSession")).toHaveLength(1);
    expectNoOrphans(backend, result.workspace);
  });

  const broken: [string, string][] = [
    ["broken JSON", '{"version": 1, "spaces": ['],
    ["empty file", ""],
    ["not an object", "[1, 2]"],
    [
      "future version",
      JSON.stringify({ ...JSON.parse(serializeWorkspace(richWorkspace())), version: 3 }),
    ],
    ["wrong shape", JSON.stringify({ version: 1, spaces: "none" })],
    ["broken invariant", JSON.stringify({ ...createDefaultWorkspace(), activeSpaceId: "ghost" })],
  ];

  it.each(broken)("quarantines and falls back to the default on %s", async (_name, text) => {
    const backend = new FakeBackend({ state: text });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("recovered");
    expect(result.reason).toBeTypeOf("string");
    expect(backend.quarantineCount).toBe(1);
    expect(backend.quarantined).toEqual([text]);
    expect(result.quarantinePath).toBe("state.broken-1.json");
    expect(result.workspace.spaces.map((s) => s.name)).toEqual(["Main"]);
    expect(checkInvariants(result.workspace)).toEqual([]);
    // The broken file stays where it is until the next save replaces it.
    expect(backend.stateContent).toBe(text);
    expect(backend.callsTo("createSession")).toHaveLength(1);
    expectNoOrphans(backend, result.workspace);
  });

  it("starts the default workspace even if the quarantine copy fails", async () => {
    const backend = new FakeBackend({ state: "{" });
    backend.quarantineState = () => Promise.reject(new Error("read-only disk"));
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("recovered");
    expect(result.quarantinePath).toBeUndefined();
    expect(allPanes(result.workspace)).toHaveLength(1);
  });

  it("uses the id source and clock given for the default workspace", async () => {
    let next = 0;
    const backend = new FakeBackend({ state: "{" });
    const { workspace } = await restoreWorkspace(backend, {
      defaults: { newId: () => `u${++next}`, clock: { now: () => 99 } },
    });
    expect(workspace.activeSpaceId).toBe("u1");
    expect(Object.values(workspace.spaces[0]?.items ?? {})[0]?.lastActivityAt).toBe(99);
  });

  it("does not swallow a failure to read the file", async () => {
    const backend = new FakeBackend();
    backend.loadState = () => Promise.reject(new Error("access denied"));
    await expect(restoreWorkspace(backend)).rejects.toThrow("access denied");
    expect(backend.callsTo("createSession")).toHaveLength(0);
  });
});

describe("restoreWorkspace when a shell cannot start", () => {
  /** Rejects sessions in a folder that no longer exists, like the real backend. */
  function pickyBackend(state: string, gone: string): FakeBackend {
    const backend = new FakeBackend({ profiles: BASH, state });
    const create = backend.createSession.bind(backend);
    backend.createSession = (options: CreateSessionOptions) =>
      options.cwd === gone
        ? Promise.reject(new Error(`working directory '${gone}' does not exist or is not a folder`))
        : create(options);
    return backend;
  }

  it("falls back to the default folder when the saved cwd is gone", async () => {
    const backend = pickyBackend(serializeWorkspace(richWorkspace()), "/work/docs");
    const result = await restoreWorkspace(backend);
    expect(result.failedPaneIds).toEqual([]);
    const p3 = paneById(result.workspace, "p3");
    expect(p3.sessionId).toBeDefined();
    expect(p3).not.toHaveProperty("cwd");
    expect(backend.session(Number(p3.sessionId))?.cwd).toBe("/home/fake");
    expect(paneById(result.workspace, "p1").cwd).toBe("/work/app");
    expectNoOrphans(backend, result.workspace);
  });

  it("leaves a pane without a session, as exited, when nothing works", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const create = backend.createSession.bind(backend);
    // p3 fails in its folder and again with the backend defaults; the others start normally.
    backend.createSession = async (options) => {
      if (options.cwd === "/work/docs") throw new Error("no shell");
      if (options.cols === 80 && options.cwd === undefined && options.profileId === undefined) {
        throw new Error("no shell");
      }
      return create(options);
    };
    const result = await restoreWorkspace(backend);
    expect(result.failedPaneIds).toEqual(["p3"]);
    const p3 = paneById(result.workspace, "p3");
    expect(p3.sessionId).toBeUndefined();
    expect(p3.status).toBe("exited");
    expect(paneById(result.workspace, "p1").sessionId).toBeDefined();
    expectNoOrphans(backend, result.workspace);
  });
});

describe("restoreWorkspace and commands", () => {
  it("a command that was running belongs to a shell that is gone; the last command stays", async () => {
    const saved = richWorkspace();
    const pane = paneById(saved, "p1");
    pane.runningCommand = { text: "sleep 100" };
    pane.lastCommand = { text: "ls", exitCode: 0, durationMs: 4 };
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const { workspace } = await restoreWorkspace(backend);
    const restored = paneById(workspace, "p1");
    expect(restored).not.toHaveProperty("runningCommand");
    expect(restored.lastCommand).toEqual({ text: "ls", exitCode: 0, durationMs: 4 });
  });
});

describe("restoreWorkspace and the commands saved with the panes (NOR-F14-03)", () => {
  it("hands back the command each pane was running, for the panes that got a session", async () => {
    const saved = richWorkspace();
    paneById(saved, "p1").runningCommand = { text: "claude --model x" };
    paneById(saved, "p2").runningCommand = {};
    paneById(saved, "p3").runningCommand = { text: "   " };
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const result = await restoreWorkspace(backend);
    expect(result.savedCommands).toEqual([{ paneId: "p1", text: "claude --model x" }]);
    // The new shells carry no command: it belongs to the shell that is gone.
    for (const pane of allPanes(result.workspace))
      expect(pane).not.toHaveProperty("runningCommand");
  });

  it("has no saved command for a pane whose shell could not start, or when nothing was saved", async () => {
    const saved = richWorkspace();
    paneById(saved, "p3").runningCommand = { text: "claude" };
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const create = backend.createSession.bind(backend);
    backend.createSession = (options: CreateSessionOptions) =>
      options.paneId === "p3" ? Promise.reject(new Error("no shell")) : create(options);
    expect((await restoreWorkspace(backend)).savedCommands).toEqual([]);

    const fresh = await restoreWorkspace(new FakeBackend({ profiles: BASH }));
    expect(fresh.savedCommands).toEqual([]);
  });

  it("lists a pane that got its old shell back too, so the plan can leave it alone", async () => {
    const saved = richWorkspace();
    paneById(saved, "p1").runningCommand = { text: "claude" };
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    backend.holdSessionForPane("p1", await backend.createSession({ cols: 80, rows: 24 }));
    const result = await restoreWorkspace(backend);
    expect(result.reattachedPaneIds).toEqual(["p1"]);
    expect(result.savedCommands).toEqual([{ paneId: "p1", text: "claude" }]);
  });

  it("loads a state saved before the option existed: no running command anywhere", async () => {
    const backend = new FakeBackend({
      profiles: BASH,
      state: serializeWorkspace(richWorkspace()),
    });
    const result = await restoreWorkspace(backend);
    expect(result.source).toBe("saved");
    expect(result.savedCommands).toEqual([]);
  });
});

describe("restoreWorkspace and the shells the backend kept (NOR-F14-02b)", () => {
  /** A backend whose session daemon kept a shell for each pane in `kept` (a new session per id). */
  async function backendKeeping(
    ...kept: string[]
  ): Promise<{ backend: FakeBackend; ids: number[] }> {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const ids: number[] = [];
    for (const paneId of kept) {
      const id = await backend.createSession({ cols: 80, rows: 24 });
      backend.holdSessionForPane(paneId, id);
      ids.push(id);
    }
    return { backend, ids };
  }

  it("gives a pane the shell it had, starts a new one for the others, and says which came back", async () => {
    const { backend, ids } = await backendKeeping("p2");
    const started = backend.callsTo("createSession").length;

    const result = await restoreWorkspace(backend);

    expect(result.reattachedPaneIds).toEqual(["p2"]);
    expect(result.failedPaneIds).toEqual([]);
    expect(paneById(result.workspace, "p2").sessionId).toBe(String(ids[0]));
    // Only p1 and p3 started a shell: the kept one was not started again.
    expect(backend.callsTo("createSession")).toHaveLength(started + 2);
    expect(backend.callsTo("reattachSession").map((call) => call.args[0])).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(paneById(result.workspace, "p1").sessionId).not.toBe(String(ids[0]));
    expect(checkInvariants(result.workspace)).toEqual([]);
  });

  it("starts a shell for every pane when the backend kept none", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const result = await restoreWorkspace(backend);
    expect(result.reattachedPaneIds).toEqual([]);
    expect(backend.callsTo("createSession")).toHaveLength(3);
    expectNoOrphans(backend, result.workspace);
  });

  it("tells the backend which pane every new shell is for, also when it falls back", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const create = backend.createSession.bind(backend);
    const asked: unknown[] = [];
    backend.createSession = (options) => {
      asked.push([options.paneId, options.cwd]);
      return options.cwd === "/work/docs" ? Promise.reject(new Error("gone")) : create(options);
    };
    await restoreWorkspace(backend);
    expect(asked).toEqual([
      ["p1", "/work/app"],
      ["p2", "/work"],
      ["p3", "/work/docs"],
      // p3 again, with the defaults of the backend.
      ["p3", undefined],
    ]);
  });

  it("starts a new shell for a pane when the backend cannot say what it kept", async () => {
    const { backend } = await backendKeeping("p1");
    backend.reattachSession = () => Promise.reject(new Error("the daemon would not answer"));
    const result = await restoreWorkspace(backend);
    expect(result.reattachedPaneIds).toEqual([]);
    expect(allPanes(result.workspace).every((pane) => pane.sessionId !== undefined)).toBe(true);
  });

  it("does not give back a shell that ended, and a shell is given back once", async () => {
    const { backend, ids } = await backendKeeping("p1", "p3");
    await backend.kill(ids[0] as number);
    const result = await restoreWorkspace(backend);
    expect(result.reattachedPaneIds).toEqual(["p3"]);
    expect(await backend.reattachSession("p3")).toBeUndefined();
  });

  it("restores a pane that had a shell with a clean state, as for a new one", async () => {
    const saved = richWorkspace();
    const pane = paneById(saved, "p2");
    pane.runningCommand = { text: "sleep 100" };
    pane.lastCommand = { text: "ls", exitCode: 0, durationMs: 4 };
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const id = await backend.createSession({ cols: 80, rows: 24 });
    backend.holdSessionForPane("p2", id);

    const { workspace } = await restoreWorkspace(backend);
    const restored = paneById(workspace, "p2");
    expect(restored.sessionId).toBe(String(id));
    expect(restored.status).toBe("idle");
    expect(restored).not.toHaveProperty("runningCommand");
    expect(restored.lastCommand).toEqual({ text: "ls", exitCode: 0, durationMs: 4 });
  });
});

describe("restoreWorkspace with start: visible (NOR-F20-14a)", () => {
  // richWorkspace: the active space s1 shows the tab i2 (panes p2 and p3); i1 (pane p1) is behind it.
  const visible = { start: "visible" } as const;

  it("starts the shells of the tab on screen only, and lists the others as pending", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const result = await restoreWorkspace(backend, visible);

    expect(backend.callsTo("createSession")).toHaveLength(2);
    expect(backend.callsTo("reattachSession").map((call) => call.args[0])).toEqual(["p2", "p3"]);
    expect(paneById(result.workspace, "p2").sessionId).toBeDefined();
    expect(paneById(result.workspace, "p3").sessionId).toBeDefined();
    const p1 = paneById(result.workspace, "p1");
    expect(p1.sessionId).toBeUndefined();
    expect(p1.status).toBe("idle");
    expect(p1.cwd).toBe("/work/app");
    expect(result.pending.map((pane) => pane.paneId)).toEqual(["p1"]);
    expect(result.failedPaneIds).toEqual([]);
    expect(checkInvariants(result.workspace)).toEqual([]);
  });

  it("starts every shell when asked for all, or when nothing is said", async () => {
    for (const options of [{ start: "all" } as const, {}]) {
      const backend = new FakeBackend({
        profiles: BASH,
        state: serializeWorkspace(richWorkspace()),
      });
      const result = await restoreWorkspace(backend, options);
      expect(backend.callsTo("createSession")).toHaveLength(3);
      expect(result.pending).toEqual([]);
    }
  });

  it("starts a pending pane as the restore would: its folder, its profile, its space's environment", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const result = await restoreWorkspace(backend, visible);
    const started = await (result.pending[0] as NonNullable<(typeof result.pending)[0]>).start();

    expect(started.reattached).toBe(false);
    expect(started.pane.status).toBe("idle");
    const session = backend.session(Number(started.pane.sessionId));
    expect(session?.cwd).toBe("/work/app");
    expect(backend.callsTo("createSession").at(-1)?.args[0]).toMatchObject({
      paneId: "p1",
      env: { MODE: "dev" },
      cols: 80,
      rows: 24,
    });
  });

  it("gives a pending pane the shell the backend kept, and says so", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const id = await backend.createSession({ cols: 80, rows: 24 });
    backend.holdSessionForPane("p1", id);
    const before = backend.callsTo("createSession").length;
    const result = await restoreWorkspace(backend, visible);
    // The kept shell is not asked for at the start: the pane waits.
    expect(result.reattachedPaneIds).toEqual([]);

    const started = await (result.pending[0] as NonNullable<(typeof result.pending)[0]>).start();
    expect(started.reattached).toBe(true);
    expect(started.pane.sessionId).toBe(String(id));
    // Two shells for p2 and p3 at the start, none for p1.
    expect(backend.callsTo("createSession")).toHaveLength(before + 2);
  });

  it("hands back the command a pending pane was running when its shell starts", async () => {
    const saved = richWorkspace();
    paneById(saved, "p1").runningCommand = { text: "claude --continue" };
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const result = await restoreWorkspace(backend, visible);
    // Not before: the pane has no shell to type into yet.
    expect(result.savedCommands).toEqual([]);
    expect(paneById(result.workspace, "p1")).not.toHaveProperty("runningCommand");

    const started = await (result.pending[0] as NonNullable<(typeof result.pending)[0]>).start();
    expect(started.savedCommand).toEqual({ paneId: "p1", text: "claude --continue" });
  });

  it("falls back to the default folder when the folder of a pending pane is gone, and exits one that cannot start", async () => {
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(richWorkspace()) });
    const create = backend.createSession.bind(backend);
    const result = await restoreWorkspace(backend, visible);
    const pane = result.pending[0] as NonNullable<(typeof result.pending)[0]>;

    backend.createSession = (options: CreateSessionOptions) =>
      options.cwd === "/work/app" ? Promise.reject(new Error("gone")) : create(options);
    const moved = await pane.start();
    expect(moved.pane.sessionId).toBeDefined();
    expect(moved.pane).not.toHaveProperty("cwd");

    backend.createSession = () => Promise.reject(new Error("no shell"));
    const failed = await pane.start();
    expect(failed.pane.sessionId).toBeUndefined();
    expect(failed.pane.status).toBe("exited");
    expect(failed).not.toHaveProperty("savedCommand");
  });

  it("starts every tab of a space that a window of its own shows", async () => {
    const saved = richWorkspace();
    const other = saved.spaces[1] as NonNullable<(typeof saved.spaces)[1]>;
    other.items = {
      i5: createTab("i5", createPane("p5", "bash", "/work/one"), 10),
      i6: createTab("i6", createPane("p6", "bash", "/work/two"), 20),
    };
    other.tree = [
      { kind: "item", id: "i5" },
      { kind: "item", id: "i6" },
    ];
    other.activeItemId = "i5";
    saved.windows = [{ id: "win-1", spaceId: "s2" }];
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const result = await restoreWorkspace(backend, visible);

    // p2, p3 (the tab on screen), p5 and p6 (the window's space); only p1 waits.
    expect(result.pending.map((pane) => pane.paneId)).toEqual(["p1"]);
    expect(paneById(result.workspace, "p5").sessionId).toBeDefined();
    expect(paneById(result.workspace, "p6").sessionId).toBeDefined();
  });

  it("shows the first tab of a space whose active tab is gone", async () => {
    const saved = richWorkspace();
    const main = saved.spaces[0] as NonNullable<(typeof saved.spaces)[0]>;
    delete main.activeItemId;
    const backend = new FakeBackend({ profiles: BASH, state: serializeWorkspace(saved) });
    const result = await restoreWorkspace(backend, visible);
    // The pinned tab is the first one: i1 (p1) is the one on screen.
    expect(paneById(result.workspace, "p1").sessionId).toBeDefined();
    expect(result.pending.map((pane) => pane.paneId).sort()).toEqual(["p2", "p3"]);
  });
});

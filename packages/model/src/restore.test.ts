import { describe, expect, it } from "vitest";
import type { CreateSessionOptions } from "./backend";
import { createDefaultWorkspace } from "./default-workspace";
import { FakeBackend } from "./fake-backend";
import { checkInvariants } from "./invariants";
import { restoreWorkspace } from "./restore";
import { layoutPanes } from "./sessions";
import { serializeWorkspace } from "./state";
import { STATE_V0_FIXTURE, richWorkspace } from "./state-fixtures";
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

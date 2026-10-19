import { describe, expect, it } from "vitest";
import { createDefaultWorkspace } from "./default-workspace";
import { checkInvariants } from "./invariants";
import { MIGRATIONS, STATE_VERSION, parseState, serializeWorkspace } from "./state";
import { workspaceWithoutSessions } from "./state";
import { STATE_V0_FIXTURE, STATE_V1_FIXTURE, richWorkspace } from "./state-fixtures";
import type { Workspace } from "./types";

function expectOk(text: string) {
  const result = parseState(text);
  if (!result.ok) throw new Error(`expected a valid state, got: ${result.reason}`);
  return result;
}

function expectRejected(text: string): string {
  const result = parseState(text);
  if (result.ok) throw new Error("expected the state to be rejected");
  return result.reason;
}

/** The rich workspace as plain data, for tests that break one field and serialize the result. */
const plain = () => JSON.parse(serializeWorkspace(richWorkspace()));

describe("serializeWorkspace and parseState", () => {
  it("round-trips the default workspace", () => {
    const ws = createDefaultWorkspace();
    const result = expectOk(serializeWorkspace(ws));
    expect(result.workspace).toEqual(ws);
    expect(result.migratedFrom).toBeUndefined();
  });

  it("round-trips a rich workspace, with sessions left out", () => {
    const ws = richWorkspace();
    const text = serializeWorkspace(ws);
    expect(text).not.toContain("sessionId");
    const result = expectOk(text);
    expect(result.workspace).toEqual(workspaceWithoutSessions(ws));
    expect(checkInvariants(result.workspace)).toEqual([]);
    // A second trip changes nothing.
    expect(serializeWorkspace(result.workspace)).toBe(text);
  });

  it("does not touch the workspace it serializes", () => {
    const ws = richWorkspace();
    serializeWorkspace(ws);
    expect(ws).toEqual(richWorkspace());
  });

  it("writes the current version", () => {
    expect(STATE_VERSION).toBe(2);
    expect(JSON.parse(serializeWorkspace(richWorkspace())).version).toBe(STATE_VERSION);
  });

  it("keeps optional fields that are absent absent", () => {
    const text = serializeWorkspace(createDefaultWorkspace());
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
  });
});

describe("migrations", () => {
  it("has a migration for every version below the current one", () => {
    for (let version = 0; version < STATE_VERSION; version++) {
      expect(MIGRATIONS[version], `from version ${version}`).toBeTypeOf("function");
    }
  });

  it("migrates the version 0 fixture through version 1 to version 2", () => {
    const result = expectOk(STATE_V0_FIXTURE);
    expect(result.migratedFrom).toBe(0);
    const ws = result.workspace;
    expect(ws.version).toBe(2);
    // The first item of each space becomes its active one.
    expect(ws.spaces.map((s) => s.activeItemId)).toEqual(["i1", "i2"]);
    expect(ws.activeSpaceId).toBe("s2");
    expect(ws).not.toHaveProperty("activeSpace");
    expect(ws.favorites).toEqual([]);
    expect(ws.closed).toEqual([]);
    expect(ws.archive).toEqual([]);
    expect(ws.spaces.map((s) => s.name)).toEqual(["Main", "Docs"]);
    expect(ws.spaces[0]).toMatchObject({
      icon: "terminal",
      modIds: [],
      defaults: { env: {} },
      aiEnabled: true,
      saveScrollback: true,
    });
    expect(ws.spaces[1]?.items["i2"]).toMatchObject({ title: "writing", titleLocked: true });
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("keeps what version 0 already had", () => {
    const ws = expectOk(STATE_V0_FIXTURE).workspace;
    const pane = ws.spaces[0]?.items["i1"]?.layout;
    expect(pane).toMatchObject({ kind: "pane", pane: { id: "p1", cwd: "/work/app" } });
  });

  it("migrates the version 1 fixture to version 2, picking the first item of each space", () => {
    const result = expectOk(STATE_V1_FIXTURE);
    expect(result.migratedFrom).toBe(1);
    const ws = result.workspace;
    expect(ws.version).toBe(2);
    // Pinned first, then the tree depth-first; an empty space stays without one.
    expect(ws.spaces.map((s) => s.activeItemId)).toEqual(["i1", "i4", undefined]);
    expect(ws.spaces[2]).not.toHaveProperty("activeItemId");
    expect(ws.activeSpaceId).toBe("s2");
    expect(ws.favorites).toEqual(["i4"]);
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("picks the first tree item when nothing is pinned, going into groups", () => {
    const v1 = JSON.parse(STATE_V1_FIXTURE) as {
      spaces: { pinned: string[]; items: Record<string, unknown> }[];
    };
    // Drop the pinned item of "Main": its first tree item sits inside the group.
    const main = v1.spaces[0];
    if (main) {
      main.pinned = [];
      delete main.items["i1"];
    }
    const ws = expectOk(JSON.stringify(v1)).workspace;
    expect(ws.spaces.map((s) => s.activeItemId)).toEqual(["i2", "i4", undefined]);
  });

  it("keeps an active item a version 1 file already holds", () => {
    const v1 = JSON.parse(STATE_V1_FIXTURE) as { spaces: Record<string, unknown>[] };
    v1.spaces[0] = { ...v1.spaces[0], activeItemId: "i3" };
    expect(expectOk(JSON.stringify(v1)).workspace.spaces[0]?.activeItemId).toBe("i3");
  });

  it("rejects a version 1 file whose migrated active item cannot be valid", () => {
    const v1 = JSON.parse(STATE_V1_FIXTURE) as { spaces: Record<string, unknown>[] };
    v1.spaces[0] = { ...v1.spaces[0], activeItemId: "ghost" };
    expect(expectRejected(JSON.stringify(v1))).toContain("active-item-missing");
  });

  it("chains version 0 to version 2 with the same result as two single steps", () => {
    const step1 = MIGRATIONS[0]?.(JSON.parse(STATE_V0_FIXTURE) as Record<string, unknown>);
    expect(step1?.["version"]).toBe(1);
    const step2 = MIGRATIONS[1]?.(step1 ?? {});
    expect(step2?.["version"]).toBe(2);
    expect(expectOk(STATE_V0_FIXTURE).workspace).toEqual(step2);
  });

  it("saves a migrated state as version 2 and reads it back unchanged", () => {
    const migrated = expectOk(STATE_V0_FIXTURE).workspace;
    const again = expectOk(serializeWorkspace(migrated));
    expect(again.migratedFrom).toBeUndefined();
    expect(again.workspace).toEqual(workspaceWithoutSessions(migrated));
  });

  it("rejects a version 0 file the migration cannot make sense of", () => {
    const v0 = JSON.parse(STATE_V0_FIXTURE) as Record<string, unknown>;
    delete v0["activeSpace"];
    expect(expectRejected(JSON.stringify(v0))).toContain("activeSpaceId");
  });
});

describe("rejected content", () => {
  it("rejects text that is not JSON", () => {
    expect(expectRejected("{ nope")).toContain("not valid JSON");
    expect(expectRejected("")).toContain("not valid JSON");
  });

  it("rejects JSON that is not an object", () => {
    for (const text of ["null", "[]", "42", '"x"', "true"]) {
      expect(expectRejected(text)).toContain("not an object");
    }
  });

  it("rejects a version from the future", () => {
    const state = { ...plain(), version: STATE_VERSION + 1 };
    expect(expectRejected(JSON.stringify(state))).toContain("newer than the supported");
  });

  it("rejects a missing or odd version", () => {
    const withoutVersion = plain();
    delete withoutVersion.version;
    expect(expectRejected(JSON.stringify(withoutVersion))).toContain("version");
    for (const version of ["1", 1.5, -1, null]) {
      expect(expectRejected(JSON.stringify({ ...plain(), version }))).toContain("version");
    }
  });

  it("rejects a missing field", () => {
    const state = plain();
    delete state["spaces"];
    expect(expectRejected(JSON.stringify(state))).toContain("spaces");
  });

  it("rejects a field of the wrong type, naming where", () => {
    const state = plain();
    state["spaces"][0].items.i1.layout.pane.cwd = 7;
    expect(expectRejected(JSON.stringify(state))).toContain(
      "spaces[0].items.i1.layout.pane.cwd: expected a string",
    );
  });

  it("accepts the git branch of a pane and rejects one that is not text", () => {
    const state = plain();
    state["spaces"][0].items.i1.layout.pane.gitBranch = "feature/x";
    const result = expectOk(JSON.stringify(state));
    expect(serializeWorkspace(result.workspace)).toContain('"gitBranch":"feature/x"');
    state["spaces"][0].items.i1.layout.pane.gitBranch = 7;
    expect(expectRejected(JSON.stringify(state))).toContain(
      "spaces[0].items.i1.layout.pane.gitBranch: expected a string",
    );
  });

  it("rejects null where an optional field may only be absent", () => {
    const state = plain();
    state["spaces"][0].themeId = null;
    expect(expectRejected(JSON.stringify(state))).toContain("themeId");
  });

  it("rejects an unknown pane status, node kind and layout kind", () => {
    const status = plain();
    status["spaces"][0].items.i1.layout.pane.status = "sleeping";
    expect(expectRejected(JSON.stringify(status))).toContain("status");

    const node = plain();
    node["spaces"][0].tree[0].kind = "folder";
    expect(expectRejected(JSON.stringify(node))).toContain("tree[0].kind");

    const layout = plain();
    layout["spaces"][0].items.i1.layout.kind = "grid";
    expect(expectRejected(JSON.stringify(layout))).toContain("layout.kind");
  });

  it("rejects an active item that is not a string", () => {
    const state = plain();
    state["spaces"][0].activeItemId = 7;
    expect(expectRejected(JSON.stringify(state))).toContain("activeItemId");
  });

  it("rejects an active item the space does not have", () => {
    const state = plain();
    state["spaces"][0].activeItemId = "i3";
    expect(expectRejected(JSON.stringify(state))).toContain("active-item-missing");
  });

  it("rejects a non-string environment value", () => {
    const state = plain();
    state["spaces"][0].defaults.env.MODE = 1;
    expect(expectRejected(JSON.stringify(state))).toContain("defaults.env.MODE");
  });

  it("rejects groups nested absurdly deep instead of overflowing the stack", () => {
    const state = plain();
    let node: Record<string, unknown> = { kind: "item", id: "i1" };
    for (let depth = 0; depth < 200; depth++) {
      node = {
        kind: "group",
        id: `g${depth}`,
        name: "g",
        color: "c",
        collapsed: false,
        children: [node],
      };
    }
    state["spaces"][0].tree = [node];
    expect(expectRejected(JSON.stringify(state))).toContain("tree");
  });

  it("rejects a state that breaks an invariant", () => {
    const state = plain();
    state["activeSpaceId"] = "nowhere";
    expect(expectRejected(JSON.stringify(state))).toContain("active-space-missing");
  });

  it("rejects split sizes that do not add up to 100", () => {
    const state = plain();
    state["spaces"][0].items.i2.layout.sizes = [10, 10];
    expect(expectRejected(JSON.stringify(state))).toContain("split-sizes-sum");
  });

  it("rejects a pane that appears in two items", () => {
    const state = plain();
    state["spaces"][1].items.i9 = state["spaces"][0].items.i1;
    state["spaces"][1].tree = [{ kind: "item", id: "i9" }];
    expect(expectRejected(JSON.stringify(state))).toContain("invariants broken");
  });

  it("applies maxPanes to the invariants", () => {
    const text = serializeWorkspace(richWorkspace());
    expect(parseState(text, { maxPanes: 2 }).ok).toBe(true);
    expect(parseState(text, { maxPanes: 1 }).ok).toBe(false);
  });

  it("never throws, whatever it is given", () => {
    const ws: Workspace = createDefaultWorkspace();
    const samples = [
      JSON.stringify({ version: 1 }),
      JSON.stringify({ ...ws, spaces: [null] }),
      JSON.stringify({ ...ws, spaces: [[]] }),
      JSON.stringify({ ...ws, spaces: "x" }),
      JSON.stringify({ version: 0, spaces: 3 }),
    ];
    for (const text of samples) expect(parseState(text).ok).toBe(false);
  });
});

describe("commands of a pane in the saved state", () => {
  const withPane = (change: (pane: Record<string, unknown>) => void): string => {
    const data = plain();
    change(data.spaces[0].items.i1.layout.pane as Record<string, unknown>);
    return JSON.stringify(data);
  };

  it("keeps the running command and the last command through a trip", () => {
    const text = withPane((pane) => {
      pane["runningCommand"] = { text: "npm test" };
      pane["lastCommand"] = { text: "ls", exitCode: 0, durationMs: 12 };
    });
    const result = expectOk(text);
    expect(serializeWorkspace(result.workspace)).toContain('"runningCommand"');
    expect(parseState(serializeWorkspace(result.workspace)).ok).toBe(true);
  });

  it("accepts a running command without a text", () => {
    expectOk(withPane((pane) => (pane["runningCommand"] = {})));
  });

  it("rejects a running command that is not an object or has a text that is not a string", () => {
    expect(expectRejected(withPane((pane) => (pane["runningCommand"] = "ls")))).toContain(
      "runningCommand",
    );
    expect(expectRejected(withPane((pane) => (pane["runningCommand"] = { text: 3 })))).toContain(
      "runningCommand",
    );
  });
});

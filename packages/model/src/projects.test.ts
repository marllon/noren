import { describe, expect, it } from "vitest";
import { createDefaultWorkspace, listProjects, mainAction, parseActionsFile } from "./index";
import type { ActionsFileState, Id, ProjectAction, Space, Workspace } from "./index";
import { reduce } from "./reducer";
import { parseState, serializeWorkspace } from "./state";
import { STATE_V0_FIXTURE, STATE_V1_FIXTURE, richWorkspace } from "./state-fixtures";
import { applyChecked, testContext } from "./test-helpers";

// The Projects section of the sidebar: which action a space's one-line block runs, which spaces get
// a block and in what order, and the two flags of a space it keeps (`inProjects`, `projectsOpen`).

const act = (id: string, extra: Partial<ProjectAction> = {}): ProjectAction => ({
  id,
  label: id.toUpperCase(),
  command: id,
  tab: id,
  ...extra,
});

const ok = (...actions: ProjectAction[]): ActionsFileState => ({ status: "ok", actions });

describe("mainAction", () => {
  it("is the action marked main", () => {
    expect(mainAction([act("a"), act("b", { main: true }), act("c")])?.id).toBe("b");
  });

  it("is the first action when none is marked", () => {
    expect(mainAction([act("a"), act("b"), act("c", { main: false })])?.id).toBe("a");
  });

  it("is the first one marked when several are", () => {
    expect(mainAction([act("a"), act("b", { main: true }), act("c", { main: true })])?.id).toBe(
      "b",
    );
  });

  it("is nothing for a file with no action", () => {
    expect(mainAction([])).toBeUndefined();
  });
});

describe('"main" in the actions file', () => {
  const file = (action: object) => JSON.stringify({ actions: [action] });
  const base = { id: "a", label: "A", command: "a", tab: "a" };

  it("is kept when it is a boolean and absent when the file leaves it out", () => {
    const marked = parseActionsFile(file({ ...base, main: true }));
    expect(marked).toEqual({ ok: true, actions: [{ ...base, main: true }] });
    const plain = parseActionsFile(file(base));
    if (!plain.ok) throw new Error(plain.reason);
    expect("main" in (plain.actions[0] ?? {})).toBe(false);
  });

  it("refuses a value that is not true or false, and names it", () => {
    const result = parseActionsFile(file({ ...base, main: "yes" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("actions[0].main");
  });
});

describe("listProjects", () => {
  const { ctx } = testContext();
  function threeSpaces(): Workspace {
    let ws = createDefaultWorkspace({ newId: ctx.newId, clock: ctx.clock });
    ws = reduce(ws, { type: "space/create", name: "Two" }, ctx);
    ws = reduce(ws, { type: "space/create", name: "Three" }, ctx);
    return ws;
  }
  const idsOf = (ws: Workspace): Id[] => ws.spaces.map((space) => space.id);
  const files = (entries: [Id, ActionsFileState][]) => new Map(entries);
  const names = (spaces: readonly Space[], map: ReadonlyMap<Id, ActionsFileState>) =>
    listProjects(spaces, map).map((entry) => entry.space.name);

  it("lists a block for each space with an action, in the order of the spaces", () => {
    const ws = threeSpaces();
    const [a, b, c] = idsOf(ws);
    const map = files([
      [c ?? "", ok(act("x"))],
      [a ?? "", ok(act("y"))],
      [b ?? "", ok(act("z"))],
    ]);
    expect(listProjects(ws.spaces, map).map((entry) => entry.space.id)).toEqual([a, b, c]);
  });

  it("leaves out a space with no file, a missing, invalid or unreadable file, or no action", () => {
    const ws = threeSpaces();
    const [a, b, c] = idsOf(ws);
    expect(names(ws.spaces, files([]))).toEqual([]);
    const map = files([
      [a ?? "", { status: "missing" }],
      [b ?? "", { status: "invalid", reason: "bad" }],
      [c ?? "", { status: "unreadable", reason: "no" }],
    ]);
    expect(listProjects(ws.spaces, map)).toEqual([]);
    expect(listProjects(ws.spaces, files([[a ?? "", ok()]]))).toEqual([]);
  });

  it("leaves out a space that asked to be left out, and lists it again when it is brought back", () => {
    let ws = threeSpaces();
    const [a, b] = idsOf(ws);
    const map = files(idsOf(ws).map((id): [Id, ActionsFileState] => [id, ok(act("x"))]));
    ws = applyChecked(ws, { type: "space/set-in-projects", spaceId: b ?? "", listed: false });
    expect(listProjects(ws.spaces, map).map((entry) => entry.space.id)).not.toContain(b);
    expect(listProjects(ws.spaces, map)).toHaveLength(2);
    ws = applyChecked(ws, { type: "space/set-in-projects", spaceId: b ?? "", listed: true });
    expect(listProjects(ws.spaces, map).map((entry) => entry.space.id)).toContain(b);
    expect(a).toBeDefined();
  });

  it("gives each block its main action, all its actions and whether it is open", () => {
    let ws = threeSpaces();
    const [a, b] = idsOf(ws);
    ws = applyChecked(ws, { type: "space/set-projects-open", spaceId: b ?? "", open: true });
    const map = files([
      [a ?? "", ok(act("one"), act("two"))],
      [b ?? "", ok(act("one"), act("two", { main: true }))],
    ]);
    const entries = listProjects(ws.spaces, map);
    expect(entries.map((entry) => entry.main.id)).toEqual(["one", "two"]);
    expect(entries.map((entry) => entry.actions.length)).toEqual([2, 2]);
    expect(entries.map((entry) => entry.open)).toEqual([false, true]);
  });
});

describe("space/set-in-projects and space/set-projects-open", () => {
  const { ctx } = testContext();
  const start = (): Workspace => createDefaultWorkspace({ newId: ctx.newId, clock: ctx.clock });
  const first = (ws: Workspace): Space => {
    const space = ws.spaces[0];
    if (space === undefined) throw new Error("the workspace has a space");
    return space;
  };

  it("start listed and closed, with neither field written", () => {
    const space = first(start());
    expect("inProjects" in space).toBe(false);
    expect("projectsOpen" in space).toBe(false);
  });

  it("take a space out of the list and bring it back, writing nothing for the default", () => {
    const ws = start();
    const out = applyChecked(ws, {
      type: "space/set-in-projects",
      spaceId: first(ws).id,
      listed: false,
    });
    expect(first(out).inProjects).toBe(false);
    const back = applyChecked(out, {
      type: "space/set-in-projects",
      spaceId: first(ws).id,
      listed: true,
    });
    expect("inProjects" in first(back)).toBe(false);
    expect(first(back)).toEqual(first(ws));
  });

  it("open and close a block, writing nothing for closed", () => {
    const ws = start();
    const open = applyChecked(ws, {
      type: "space/set-projects-open",
      spaceId: first(ws).id,
      open: true,
    });
    expect(first(open).projectsOpen).toBe(true);
    const closed = applyChecked(open, {
      type: "space/set-projects-open",
      spaceId: first(ws).id,
      open: false,
    });
    expect("projectsOpen" in first(closed)).toBe(false);
  });

  it("change only the space they name", () => {
    const ws = applyChecked(start(), { type: "space/create", name: "Second" });
    const [a, b] = ws.spaces;
    const next = applyChecked(ws, {
      type: "space/set-projects-open",
      spaceId: b?.id ?? "",
      open: true,
    });
    expect(next.spaces[0]).toBe(a);
    expect(next.spaces[1]?.projectsOpen).toBe(true);
  });

  it("change nothing for the value the space has, an unknown space or a value that is not a boolean", () => {
    const ws = start();
    const id = first(ws).id;
    expect(applyChecked(ws, { type: "space/set-in-projects", spaceId: id, listed: true })).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-projects-open", spaceId: id, open: false })).toBe(
      ws,
    );
    expect(
      applyChecked(ws, { type: "space/set-in-projects", spaceId: "nope", listed: false }),
    ).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-projects-open", spaceId: "nope", open: true })).toBe(
      ws,
    );
    for (const value of ["false", 0, null, undefined]) {
      const listed = { type: "space/set-in-projects", spaceId: id, listed: value } as never;
      const open = { type: "space/set-projects-open", spaceId: id, open: value } as never;
      expect(reduce(ws, listed, ctx), String(value)).toBe(ws);
      expect(reduce(ws, open, ctx), String(value)).toBe(ws);
    }
  });
});

describe("the Projects flags in state.json", () => {
  const plain = () => JSON.parse(serializeWorkspace(richWorkspace())) as Record<string, unknown>;
  const spacesOf = (data: Record<string, unknown>): Record<string, unknown>[] =>
    data["spaces"] as Record<string, unknown>[];

  it("are kept as saved", () => {
    const data = plain();
    const space = spacesOf(data)[0];
    if (space === undefined) throw new Error("the fixture has a space");
    space["inProjects"] = false;
    space["projectsOpen"] = true;
    const result = parseState(JSON.stringify(data));
    if (!result.ok) throw new Error(result.reason);
    expect(result.workspace.spaces[0]?.inProjects).toBe(false);
    expect(result.workspace.spaces[0]?.projectsOpen).toBe(true);
    expect(serializeWorkspace(result.workspace)).toBe(JSON.stringify(data));
  });

  it("are refused when they are not booleans", () => {
    for (const field of ["inProjects", "projectsOpen"]) {
      for (const value of ["yes", 1, null]) {
        const data = plain();
        const space = spacesOf(data)[0];
        if (space === undefined) throw new Error("the fixture has a space");
        space[field] = value;
        const result = parseState(JSON.stringify(data));
        expect(result.ok, `${field} ${JSON.stringify(value)}`).toBe(false);
        if (!result.ok) expect(result.reason).toContain(field);
      }
    }
  });

  it("are absent from a state saved before the section: it opens as it did, every space listed and closed", () => {
    for (const fixture of [STATE_V0_FIXTURE, STATE_V1_FIXTURE]) {
      expect(fixture).not.toContain("inProjects");
      const result = parseState(fixture);
      if (!result.ok) throw new Error(result.reason);
      for (const space of result.workspace.spaces) {
        expect(space.inProjects).toBeUndefined();
        expect(space.projectsOpen).toBeUndefined();
      }
    }
  });
});

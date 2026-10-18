import { describe, expect, it } from "vitest";
import type { Action, ReducerContext } from "./actions";
import { checkInvariants } from "./invariants";
import { reduce, reduceStrict } from "./reducer";
import { layoutPanes, liveSessionIds } from "./sessions";
import { applyChecked, deepFreeze, pane, testContext } from "./test-helpers";
import {
  MAX_CLOSED,
  type ClosedItem,
  type GroupNode,
  type Id,
  type Item,
  type LayoutNode,
  type Node,
  type Space,
  type SplitNode,
  type Workspace,
} from "./types";

const leaf = (id: string, sessionId?: string): LayoutNode => ({
  kind: "pane",
  pane: pane(id, sessionId),
});

const item = (id: string, layout: LayoutNode, focusedPaneId: string): Item => ({
  id,
  titleLocked: false,
  layout,
  focusedPaneId,
  lastActivityAt: 0,
});

/**
 * Two spaces. Every live pane has a session (x1..x7).
 * s1 "Main": pinned [i1]; tree [ g1 { i2 (split p2 p3), g2 { i3 } }, i4, i5 ]
 * s2 "Work": tree [ i6 ]
 * favorites [i1, i6]; closed [i7 from s1]; s1 is active.
 */
function fixture(): Workspace {
  const split: SplitNode = {
    kind: "split",
    dir: "row",
    sizes: [40, 60],
    children: [leaf("p2", "x2"), leaf("p3", "x3")],
  };
  const g2: GroupNode = {
    kind: "group",
    id: "g2",
    name: "inner",
    color: "red",
    collapsed: false,
    children: [{ kind: "item", id: "i3" }],
  };
  const g1: GroupNode = {
    kind: "group",
    id: "g1",
    name: "outer",
    color: "teal",
    collapsed: false,
    children: [{ kind: "item", id: "i2" }, g2],
  };
  const main: Space = {
    id: "s1",
    name: "Main",
    icon: "terminal",
    color: "#6b8afd",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: ["i1"],
    tree: [g1, { kind: "item", id: "i4" }, { kind: "item", id: "i5" }],
    items: {
      i1: item("i1", leaf("p1", "x1"), "p1"),
      i2: item("i2", split, "p2"),
      i3: item("i3", leaf("p4", "x4"), "p4"),
      i4: item("i4", leaf("p5", "x5"), "p5"),
      i5: item("i5", leaf("p6", "x6"), "p6"),
    },
  };
  const work: Space = {
    id: "s2",
    name: "Work",
    icon: "folder",
    color: "teal",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: [],
    tree: [{ kind: "item", id: "i6" }],
    items: { i6: item("i6", leaf("p7", "x7"), "p7") },
  };
  return {
    version: 1,
    spaces: [main, work],
    activeSpaceId: "s1",
    favorites: ["i1", "i6"],
    closed: [{ item: item("i7", leaf("p8"), "p8"), spaceId: "s1", closedAt: 1 }],
    archive: [],
  };
}

type Shape = string | { [group: string]: Shape[] };

/** Tree as nested ids: items are strings, groups are `{ id: children }`. */
const shape = (nodes: readonly Node[]): Shape[] =>
  nodes.map((node) => (node.kind === "item" ? node.id : { [node.id]: shape(node.children) }));

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const spaceOf = (ws: Workspace, id: Id): Space => must(ws.spaces.find((s) => s.id === id));
const closedIds = (ws: Workspace): Id[] => ws.closed.map((entry) => entry.item.id);
const sessionsOf = (it: Item): Id[] =>
  layoutPanes(it.layout).flatMap((p) => (p.sessionId === undefined ? [] : [p.sessionId]));
const lost = (before: Workspace, after: Workspace): Id[] =>
  [...liveSessionIds(before)].filter((id) => !liveSessionIds(after).has(id)).sort();
const closedSessionFree = (entry: ClosedItem): boolean => sessionsOf(entry.item).length === 0;

/** `count` closed entries c0..c(count-1), oldest first. */
const manyClosed = (count: number): ClosedItem[] =>
  Array.from({ length: count }, (_, n) => ({
    item: item(`c${n}`, leaf(`cp${n}`), `cp${n}`),
    spaceId: "s1",
    closedAt: n,
  }));

/** Reducer context whose ids come from a fixed list. */
const idsFrom = (ids: string[]): ReducerContext => {
  const { ctx } = testContext();
  const queue = [...ids];
  return { ...ctx, newId: () => queue.shift() ?? "exhausted" };
};

describe("fixture", () => {
  it("is a valid workspace", () => {
    expect(checkInvariants(fixture())).toEqual([]);
  });
});

describe("space/create", () => {
  it("appends an empty space and makes it the active one", () => {
    const ws = fixture();
    const next = applyChecked(ws, { type: "space/create", name: "  Notes " });
    expect(next.spaces.map((s) => s.id)).toEqual(["s1", "s2", "n1"]);
    const created = spaceOf(next, "n1");
    expect(created).toMatchObject({
      name: "Notes",
      icon: "terminal",
      pinned: [],
      tree: [],
      items: {},
      defaults: { env: {} },
    });
    expect(next.activeSpaceId).toBe("n1");
  });

  it("keeps the active space with activate: false and stores icon, color and defaults", () => {
    const next = applyChecked(fixture(), {
      type: "space/create",
      name: "Docs",
      icon: "book",
      color: "red",
      profileId: "pwsh",
      cwd: "C:\\docs",
      activate: false,
    });
    expect(next.activeSpaceId).toBe("s1");
    expect(spaceOf(next, "n1")).toMatchObject({
      icon: "book",
      color: "red",
      defaults: { profileId: "pwsh", cwd: "C:\\docs", env: {} },
    });
  });

  it("rejects a blank name, icon or color", () => {
    const ws = fixture();
    const { ctx } = testContext();
    expect(reduceStrict(ws, { type: "space/create", name: "  " }, ctx)).toBe(ws);
    expect(reduceStrict(ws, { type: "space/create", name: "A", icon: " " }, ctx)).toBe(ws);
    expect(reduceStrict(ws, { type: "space/create", name: "A", color: "" }, ctx)).toBe(ws);
  });
});

describe("space/rename", () => {
  it("renames and trims", () => {
    const next = applyChecked(fixture(), { type: "space/rename", spaceId: "s2", name: " Play " });
    expect(spaceOf(next, "s2").name).toBe("Play");
    expect(spaceOf(next, "s1").name).toBe("Main");
  });

  it("returns the same workspace for a blank name, the same name or an unknown space", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "space/rename", spaceId: "s1", name: "" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/rename", spaceId: "s1", name: "Main" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/rename", spaceId: "nope", name: "X" })).toBe(ws);
  });
});

describe("space/set-color and space/set-icon", () => {
  it("changes the color", () => {
    const next = applyChecked(fixture(), { type: "space/set-color", spaceId: "s1", color: "red" });
    expect(spaceOf(next, "s1").color).toBe("red");
  });

  it("changes the icon", () => {
    const next = applyChecked(fixture(), { type: "space/set-icon", spaceId: "s1", icon: "🚀" });
    expect(spaceOf(next, "s1").icon).toBe("🚀");
  });

  it("returns the same workspace for blank, unchanged or unknown input", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "space/set-color", spaceId: "s1", color: " " })).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-color", spaceId: "s1", color: "#6b8afd" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-color", spaceId: "nope", color: "red" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-icon", spaceId: "s1", icon: "" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-icon", spaceId: "s1", icon: "terminal" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/set-icon", spaceId: "nope", icon: "x" })).toBe(ws);
  });
});

describe("space/create with env and space/set-defaults", () => {
  it("creates a space with its own copy of the environment", () => {
    const env = { EDITOR: "vim", NOREN_MODE: "work" };
    const next = applyChecked(fixture(), { type: "space/create", name: "Dev", env });
    expect(spaceOf(next, "n1").defaults.env).toEqual(env);
    expect(spaceOf(next, "n1").defaults.env).not.toBe(env);
  });

  it("refuses an environment with an unusable name or a NUL in a value", () => {
    const ws = fixture();
    const { ctx } = testContext();
    for (const env of [{ "A=B": "x" }, { "": "x" }, { "A B": "x" }, { A: "x\u0000y" }]) {
      expect(reduceStrict(ws, { type: "space/create", name: "Dev", env }, ctx)).toBe(ws);
    }
  });

  it("sets profile, folder and environment, and the next item of the space uses them", () => {
    const ws = applyChecked(fixture(), {
      type: "space/set-defaults",
      spaceId: "s2",
      profileId: "pwsh",
      cwd: "C:\\work",
      env: { TOKEN: "abc" },
    });
    expect(spaceOf(ws, "s2").defaults).toEqual({
      profileId: "pwsh",
      cwd: "C:\\work",
      env: { TOKEN: "abc" },
    });
    const { ctx } = testContext();
    const withTab = applyChecked(ws, { type: "item/create", spaceId: "s2" }, ctx);
    const created = Object.values(spaceOf(withTab, "s2").items).find((i) => i.id !== "i6");
    expect(created && layoutPanes(created.layout)[0]).toMatchObject({
      profileId: "pwsh",
      cwd: "C:\\work",
    });
  });

  it("keeps what is not given, replaces the whole environment and clears with a blank", () => {
    const first = applyChecked(fixture(), {
      type: "space/set-defaults",
      spaceId: "s1",
      profileId: "pwsh",
      cwd: "/a",
      env: { A: "1", B: "2" },
    });
    const second = applyChecked(first, {
      type: "space/set-defaults",
      spaceId: "s1",
      env: { C: "3" },
    });
    expect(spaceOf(second, "s1").defaults).toEqual({
      profileId: "pwsh",
      cwd: "/a",
      env: { C: "3" },
    });
    const cleared = applyChecked(second, {
      type: "space/set-defaults",
      spaceId: "s1",
      profileId: " ",
      cwd: "",
      env: {},
    });
    expect(spaceOf(cleared, "s1").defaults).toEqual({ env: {} });
  });

  it("returns the same workspace when nothing changes or the input is invalid", () => {
    const ws = applyChecked(fixture(), {
      type: "space/set-defaults",
      spaceId: "s1",
      cwd: "/a",
      env: { A: "1" },
    });
    const apply = (action: Action) => applyChecked(ws, action);
    expect(apply({ type: "space/set-defaults", spaceId: "s1" })).toBe(ws);
    expect(apply({ type: "space/set-defaults", spaceId: "s1", cwd: "/a", env: { A: "1" } })).toBe(
      ws,
    );
    expect(apply({ type: "space/set-defaults", spaceId: "nope", cwd: "/b" })).toBe(ws);
    expect(apply({ type: "space/set-defaults", spaceId: "s1", env: { "A=": "1" } })).toBe(ws);
  });
});

describe("space/set-defaults with gitIdentity", () => {
  const identity = { name: "Ada Lovelace", email: "ada@example.com" };
  const withIdentity = () =>
    applyChecked(fixture(), { type: "space/set-defaults", spaceId: "s1", gitIdentity: identity });

  it("sets the identity (trimmed) and leaves the other defaults alone", () => {
    const first = applyChecked(fixture(), {
      type: "space/set-defaults",
      spaceId: "s1",
      cwd: "/a",
      gitIdentity: { name: "  Ada Lovelace ", email: " ada@example.com " },
    });
    expect(spaceOf(first, "s1").defaults).toEqual({ cwd: "/a", env: {}, gitIdentity: identity });
  });

  it("keeps the identity when the action does not mention it, and replaces it when it does", () => {
    const ws = withIdentity();
    const other = applyChecked(ws, { type: "space/set-defaults", spaceId: "s1", cwd: "/b" });
    expect(spaceOf(other, "s1").defaults.gitIdentity).toEqual(identity);
    const changed = applyChecked(ws, {
      type: "space/set-defaults",
      spaceId: "s1",
      gitIdentity: { name: "Grace", email: "" },
    });
    expect(spaceOf(changed, "s1").defaults.gitIdentity).toEqual({ name: "Grace", email: "" });
  });

  it("clears the identity when name and email are both blank", () => {
    const cleared = applyChecked(withIdentity(), {
      type: "space/set-defaults",
      spaceId: "s1",
      gitIdentity: { name: " ", email: "" },
    });
    expect(spaceOf(cleared, "s1").defaults).toEqual({ env: {} });
    expect("gitIdentity" in spaceOf(cleared, "s1").defaults).toBe(false);
  });

  it("returns the same workspace when the identity does not change or is refused", () => {
    const ws = withIdentity();
    const apply = (action: Action) => applyChecked(ws, action);
    expect(apply({ type: "space/set-defaults", spaceId: "s1", gitIdentity: identity })).toBe(ws);
    expect(
      apply({
        type: "space/set-defaults",
        spaceId: "s1",
        gitIdentity: { name: " Ada Lovelace", email: "ada@example.com " },
      }),
    ).toBe(ws);
    expect(
      apply({
        type: "space/set-defaults",
        spaceId: "s1",
        gitIdentity: { name: "A\u0000B", email: "a@x.io" },
      }),
    ).toBe(ws);
    // Clearing a space that has none changes nothing either.
    const none = fixture();
    expect(
      applyChecked(none, {
        type: "space/set-defaults",
        spaceId: "s2",
        gitIdentity: { name: "", email: "" },
      }),
    ).toBe(none);
  });
});

describe("space/move", () => {
  const order = (ws: Workspace): Id[] => ws.spaces.map((s) => s.id);

  it("puts the space at the given position", () => {
    const next = applyChecked(fixture(), { type: "space/move", spaceId: "s1", index: 1 });
    expect(order(next)).toEqual(["s2", "s1"]);
    expect(next.activeSpaceId).toBe("s1");
  });

  it("clamps the position to the ends", () => {
    const ws = fixture();
    expect(order(applyChecked(ws, { type: "space/move", spaceId: "s1", index: 99 }))).toEqual([
      "s2",
      "s1",
    ]);
    expect(order(applyChecked(ws, { type: "space/move", spaceId: "s2", index: -5 }))).toEqual([
      "s2",
      "s1",
    ]);
  });

  it("returns the same workspace when nothing moves or the input is invalid", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "space/move", spaceId: "s1", index: 0 })).toBe(ws);
    expect(applyChecked(ws, { type: "space/move", spaceId: "nope", index: 0 })).toBe(ws);
    expect(applyChecked(ws, { type: "space/move", spaceId: "s1", index: 0.5 })).toBe(ws);
    expect(applyChecked(ws, { type: "space/move", spaceId: "s1", index: Number.NaN })).toBe(ws);
  });
});

describe("space/activate", () => {
  it("switches the active space", () => {
    expect(applyChecked(fixture(), { type: "space/activate", spaceId: "s2" }).activeSpaceId).toBe(
      "s2",
    );
  });

  it("returns the same workspace for the active or an unknown space", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "space/activate", spaceId: "s1" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/activate", spaceId: "nope" })).toBe(ws);
  });
});

describe("space/delete", () => {
  it("moves the items to another space: pinned stay pinned, the tree is appended, sessions live on", () => {
    const ws = fixture();
    const next = applyChecked(ws, {
      type: "space/delete",
      spaceId: "s1",
      items: { mode: "move", targetSpaceId: "s2" },
    });
    expect(next.spaces.map((s) => s.id)).toEqual(["s2"]);
    const work = spaceOf(next, "s2");
    expect(work.pinned).toEqual(["i1"]);
    expect(shape(work.tree)).toEqual(["i6", { g1: ["i2", { g2: ["i3"] }] }, "i4", "i5"]);
    expect(Object.keys(work.items).sort()).toEqual(["i1", "i2", "i3", "i4", "i5", "i6"]);
    expect(next.activeSpaceId).toBe("s2");
    expect(next.favorites).toEqual(["i1", "i6"]);
    expect(next.closed).toEqual(ws.closed);
    expect(lost(ws, next)).toEqual([]);
  });

  it("keeps the active space when a space that is not active is deleted by moving", () => {
    const next = applyChecked(fixture(), {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "move", targetSpaceId: "s1" },
    });
    expect(next.activeSpaceId).toBe("s1");
    expect(shape(spaceOf(next, "s1").tree)).toEqual([
      { g1: ["i2", { g2: ["i3"] }] },
      "i4",
      "i5",
      "i6",
    ]);
  });

  it("closes every item: closed stack in visual order, no sessions, favorites cleaned", () => {
    const ws = fixture();
    const next = applyChecked(ws, {
      type: "space/delete",
      spaceId: "s1",
      items: { mode: "close" },
    });
    expect(next.spaces.map((s) => s.id)).toEqual(["s2"]);
    expect(closedIds(next)).toEqual(["i7", "i1", "i2", "i3", "i4", "i5"]);
    const added = next.closed.slice(1);
    expect(added.every((entry) => entry.spaceId === "s1" && entry.closedAt === 1000)).toBe(true);
    expect(added.every(closedSessionFree)).toBe(true);
    expect(next.favorites).toEqual(["i6"]);
    expect(next.activeSpaceId).toBe("s2");
    expect(lost(ws, next)).toEqual(["x1", "x2", "x3", "x4", "x5", "x6"]);
  });

  it("keeps the active space when another one is deleted", () => {
    const next = applyChecked(fixture(), {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "close" },
    });
    expect(next.activeSpaceId).toBe("s1");
    expect(closedIds(next)).toEqual(["i7", "i6"]);
    expect(next.favorites).toEqual(["i1"]);
  });

  it("makes the space that took its place active; the last one when it was the last", () => {
    const { ctx } = testContext();
    let ws = applyChecked(fixture(), { type: "space/create", name: "Third" }, ctx);
    expect(ws.spaces.map((s) => s.id)).toEqual(["s1", "s2", "n1"]);
    ws = applyChecked(ws, { type: "space/activate", spaceId: "s2" }, ctx);
    const middle = applyChecked(
      ws,
      { type: "space/delete", spaceId: "s2", items: { mode: "close" } },
      ctx,
    );
    expect(middle.activeSpaceId).toBe("n1");
    ws = applyChecked(ws, { type: "space/activate", spaceId: "n1" }, ctx);
    const last = applyChecked(
      ws,
      { type: "space/delete", spaceId: "n1", items: { mode: "close" } },
      ctx,
    );
    expect(last.activeSpaceId).toBe("s2");
  });

  it("keeps only the newest 50 closed items", () => {
    const ws = { ...fixture(), closed: manyClosed(49) };
    const next = applyChecked(ws, {
      type: "space/delete",
      spaceId: "s1",
      items: { mode: "close" },
    });
    expect(next.closed).toHaveLength(MAX_CLOSED);
    expect(closedIds(next).slice(0, 2)).toEqual(["c4", "c5"]);
    expect(closedIds(next).slice(-5)).toEqual(["i1", "i2", "i3", "i4", "i5"]);
  });

  it("returns the same workspace for the only space, an unknown space or a bad target", () => {
    const ws = fixture();
    const alone = applyChecked(ws, {
      type: "space/delete",
      spaceId: "s2",
      items: { mode: "close" },
    });
    expect(
      applyChecked(alone, { type: "space/delete", spaceId: "s1", items: { mode: "close" } }),
    ).toBe(alone);
    expect(
      applyChecked(alone, {
        type: "space/delete",
        spaceId: "s1",
        items: { mode: "move", targetSpaceId: "s1" },
      }),
    ).toBe(alone);
    expect(
      applyChecked(ws, { type: "space/delete", spaceId: "nope", items: { mode: "close" } }),
    ).toBe(ws);
    expect(
      applyChecked(ws, {
        type: "space/delete",
        spaceId: "s1",
        items: { mode: "move", targetSpaceId: "nope" },
      }),
    ).toBe(ws);
    expect(
      applyChecked(ws, {
        type: "space/delete",
        spaceId: "s1",
        items: { mode: "move", targetSpaceId: "s1" },
      }),
    ).toBe(ws);
  });
});

describe("item/create", () => {
  it("adds a tab with one pane at the end of the active space's tree", () => {
    const next = applyChecked(fixture(), { type: "item/create" });
    const main = spaceOf(next, "s1");
    expect(shape(main.tree)).toEqual([{ g1: ["i2", { g2: ["i3"] }] }, "i4", "i5", "n1"]);
    expect(main.items.n1).toEqual({
      id: "n1",
      titleLocked: false,
      layout: {
        kind: "pane",
        pane: {
          id: "n2",
          type: "terminal",
          profileId: "default",
          status: "idle",
          unread: false,
          bell: false,
        },
      },
      focusedPaneId: "n2",
      lastActivityAt: 1000,
    });
  });

  it("uses the defaults of the space and lets the action override them", () => {
    let ws = fixture();
    ws = {
      ...ws,
      spaces: ws.spaces.map((s) =>
        s.id === "s2" ? { ...s, defaults: { env: {}, profileId: "zsh", cwd: "/work" } } : s,
      ),
    };
    const inherited = applyChecked(ws, { type: "item/create", spaceId: "s2" });
    expect(layoutPanes(must(spaceOf(inherited, "s2").items.n1).layout)[0]).toMatchObject({
      profileId: "zsh",
      cwd: "/work",
    });
    const own = applyChecked(ws, {
      type: "item/create",
      spaceId: "s2",
      profileId: "cmd",
      cwd: "/x",
    });
    expect(layoutPanes(must(spaceOf(own, "s2").items.n1).layout)[0]).toMatchObject({
      profileId: "cmd",
      cwd: "/x",
    });
  });

  it("honours the placement: pinned, a group, a position", () => {
    const { ctx } = testContext();
    let ws = applyChecked(
      fixture(),
      { type: "item/create", placement: { to: "pinned", index: 0 } },
      ctx,
    );
    expect(spaceOf(ws, "s1").pinned).toEqual(["n1", "i1"]);
    ws = applyChecked(
      ws,
      { type: "item/create", placement: { to: "tree", groupId: "g2", index: 0 } },
      ctx,
    );
    expect(shape(spaceOf(ws, "s1").tree)).toEqual([
      { g1: ["i2", { g2: ["n3", "i3"] }] },
      "i4",
      "i5",
    ]);
    ws = applyChecked(ws, { type: "item/create", placement: { to: "tree", index: 1 } }, ctx);
    expect(shape(spaceOf(ws, "s1").tree)[1]).toBe("n5");
  });

  it("returns the same workspace for an unknown space or group, a bad index or a blank profile", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/create", spaceId: "nope" })).toBe(ws);
    expect(
      applyChecked(ws, { type: "item/create", placement: { to: "tree", groupId: "nope" } }),
    ).toBe(ws);
    expect(applyChecked(ws, { type: "item/create", placement: { to: "pinned", index: 1.5 } })).toBe(
      ws,
    );
    expect(applyChecked(ws, { type: "item/create", profileId: " " })).toBe(ws);
  });

  it("does not use up ids on an invalid action", () => {
    const ws = fixture();
    const { ctx } = testContext();
    reduceStrict(ws, { type: "item/create", spaceId: "nope" }, ctx);
    expect(ctx.newId()).toBe("n1");
  });

  it("skips ids that the workspace already uses (a restarted counter is safe)", () => {
    const ws = fixture();
    const ctx = idsFrom(["i1", "p1", "s1", "g1", "i7", "p8", "fresh-item", "fresh-pane"]);
    const next = reduceStrict(ws, { type: "item/create" }, ctx);
    expect(checkInvariants(next)).toEqual([]);
    expect(spaceOf(next, "s1").items["fresh-item"]).toMatchObject({ focusedPaneId: "fresh-pane" });
  });

  it("gives up, without throwing, when the generator only returns used ids", () => {
    const ws = fixture();
    const stuck: ReducerContext = { ...testContext().ctx, newId: () => "i1" };
    expect(() => reduceStrict(ws, { type: "item/create" }, stuck)).toThrow();
    expect(reduce(ws, { type: "item/create" }, stuck)).toBe(ws);
  });
});

describe("item/close", () => {
  it("moves the item to the top of the closed stack, strips its sessions and unlists it", () => {
    const ws = fixture();
    const next = applyChecked(ws, { type: "item/close", itemId: "i2" });
    const main = spaceOf(next, "s1");
    expect(main.items.i2).toBeUndefined();
    expect(shape(main.tree)).toEqual([{ g1: [{ g2: ["i3"] }] }, "i4", "i5"]);
    expect(closedIds(next)).toEqual(["i7", "i2"]);
    const entry = must(next.closed.at(-1));
    expect(entry).toMatchObject({ spaceId: "s1", closedAt: 1000 });
    expect(layoutPanes(entry.item.layout).map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(closedSessionFree(entry)).toBe(true);
    expect(lost(ws, next)).toEqual(["x2", "x3"]);
  });

  it("takes a pinned and favorite item out of pinned and favorites", () => {
    const next = applyChecked(fixture(), { type: "item/close", itemId: "i1" });
    expect(spaceOf(next, "s1").pinned).toEqual([]);
    expect(next.favorites).toEqual(["i6"]);
  });

  it("keeps the closed stack at 50, dropping the oldest", () => {
    const ws = { ...fixture(), closed: manyClosed(MAX_CLOSED) };
    const next = applyChecked(ws, { type: "item/close", itemId: "i4" });
    expect(next.closed).toHaveLength(MAX_CLOSED);
    expect(must(next.closed[0]).item.id).toBe("c1");
    expect(must(next.closed.at(-1)).item.id).toBe("i4");
  });

  it("returns the same workspace for an unknown item", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/close", itemId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/close", itemId: "g1" })).toBe(ws);
  });
});

describe("item/reopen", () => {
  it("brings the newest closed item back to the end of the tree of its space", () => {
    const ws = fixture();
    const next = applyChecked(ws, { type: "item/reopen" });
    expect(next.closed).toEqual([]);
    expect(shape(spaceOf(next, "s1").tree).at(-1)).toBe("i7");
    expect(spaceOf(next, "s1").items.i7).toEqual({
      ...must(ws.closed[0]).item,
      lastActivityAt: 1000,
    });
  });

  it("brings back a specific item, in the space it came from", () => {
    const { ctx } = testContext();
    let ws = applyChecked(fixture(), { type: "item/close", itemId: "i6" }, ctx);
    ws = applyChecked(ws, { type: "item/close", itemId: "i4" }, ctx);
    expect(closedIds(ws)).toEqual(["i7", "i6", "i4"]);
    const next = applyChecked(ws, { type: "item/reopen", itemId: "i6" }, ctx);
    expect(closedIds(next)).toEqual(["i7", "i4"]);
    expect(shape(spaceOf(next, "s2").tree)).toEqual(["i6"]);
  });

  it("uses the active space when the space of origin no longer exists", () => {
    const { ctx } = testContext();
    let ws = applyChecked(fixture(), { type: "item/close", itemId: "i6" }, ctx);
    ws = applyChecked(ws, { type: "space/delete", spaceId: "s2", items: { mode: "close" } }, ctx);
    const next = applyChecked(ws, { type: "item/reopen", itemId: "i6" }, ctx);
    expect(shape(spaceOf(next, "s1").tree).at(-1)).toBe("i6");
  });

  it("gives a closed item back with valid ids and the panes it had, minus the sessions", () => {
    const { ctx } = testContext();
    const ws = fixture();
    const closed = applyChecked(ws, { type: "item/close", itemId: "i2" }, ctx);
    const reopened = applyChecked(closed, { type: "item/reopen" }, ctx);
    const back = must(spaceOf(reopened, "s1").items.i2);
    expect(layoutPanes(back.layout).map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(sessionsOf(back)).toEqual([]);
    expect(back.layout).toMatchObject({ kind: "split", sizes: [40, 60] });
    expect(liveSessionIds(reopened).has("x2")).toBe(false);
  });

  it("never revives a session that a loaded closed item still carries", () => {
    const ws = fixture();
    const stale: Workspace = {
      ...ws,
      closed: [{ item: item("i7", leaf("p8", "x99"), "p8"), spaceId: "s1", closedAt: 1 }],
    };
    const next = applyChecked(stale, { type: "item/reopen" });
    expect(liveSessionIds(next).has("x99")).toBe(false);
  });

  it("returns the same workspace when there is nothing to reopen", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/reopen", itemId: "nope" })).toBe(ws);
    const empty = { ...ws, closed: [] };
    expect(applyChecked(empty, { type: "item/reopen" })).toBe(empty);
  });
});

describe("item/rename", () => {
  it("sets the title and locks it", () => {
    const next = applyChecked(fixture(), { type: "item/rename", itemId: "i4", title: " build " });
    expect(spaceOf(next, "s1").items.i4).toMatchObject({ title: "build", titleLocked: true });
  });

  it("lets the running program rename an unlocked item, without locking it", () => {
    const next = applyChecked(fixture(), {
      type: "item/rename",
      itemId: "i4",
      title: "vim",
      source: "process",
    });
    expect(spaceOf(next, "s1").items.i4).toMatchObject({ title: "vim", titleLocked: false });
  });

  it("ignores the running program once the user has locked the title", () => {
    const locked = applyChecked(fixture(), { type: "item/rename", itemId: "i4", title: "mine" });
    expect(
      applyChecked(locked, { type: "item/rename", itemId: "i4", title: "vim", source: "process" }),
    ).toBe(locked);
    expect(
      applyChecked(locked, { type: "item/rename", itemId: "i4", title: "", source: "process" }),
    ).toBe(locked);
  });

  it("clears the title and the lock when the user renames to blank", () => {
    const locked = applyChecked(fixture(), { type: "item/rename", itemId: "i4", title: "mine" });
    const cleared = applyChecked(locked, { type: "item/rename", itemId: "i4", title: "  " });
    const renamed = must(spaceOf(cleared, "s1").items.i4);
    expect(renamed.title).toBeUndefined();
    expect("title" in renamed).toBe(false);
    expect(renamed.titleLocked).toBe(false);
  });

  it("returns the same workspace for an unknown item or an unchanged title", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/rename", itemId: "nope", title: "x" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/rename", itemId: "i4", title: "" })).toBe(ws);
    const named = applyChecked(ws, { type: "item/rename", itemId: "i4", title: "mine" });
    expect(applyChecked(named, { type: "item/rename", itemId: "i4", title: "mine" })).toBe(named);
  });
});

describe("item/move", () => {
  it("moves within the tree to a position", () => {
    const next = applyChecked(fixture(), {
      type: "item/move",
      itemId: "i5",
      placement: { to: "tree", index: 0 },
    });
    expect(shape(spaceOf(next, "s1").tree)).toEqual(["i5", { g1: ["i2", { g2: ["i3"] }] }, "i4"]);
  });

  it("moves into a group and out of one", () => {
    const { ctx } = testContext();
    const into = applyChecked(
      fixture(),
      { type: "item/move", itemId: "i4", placement: { to: "tree", groupId: "g2" } },
      ctx,
    );
    expect(shape(spaceOf(into, "s1").tree)).toEqual([{ g1: ["i2", { g2: ["i3", "i4"] }] }, "i5"]);
    const out = applyChecked(
      into,
      { type: "item/move", itemId: "i3", placement: { to: "tree", index: 0 } },
      ctx,
    );
    expect(shape(spaceOf(out, "s1").tree)).toEqual(["i3", { g1: ["i2", { g2: ["i4"] }] }, "i5"]);
  });

  it("counts the position after the item left its old spot", () => {
    const next = applyChecked(fixture(), {
      type: "item/move",
      itemId: "i4",
      placement: { to: "tree", index: 2 },
    });
    expect(shape(spaceOf(next, "s1").tree)).toEqual([{ g1: ["i2", { g2: ["i3"] }] }, "i5", "i4"]);
  });

  it("moves to another space, keeping panes, sessions and favorite status", () => {
    const ws = fixture();
    const next = applyChecked(ws, {
      type: "item/move",
      itemId: "i2",
      spaceId: "s2",
      placement: { to: "tree", index: 0 },
    });
    expect(spaceOf(next, "s1").items.i2).toBeUndefined();
    expect(shape(spaceOf(next, "s1").tree)).toEqual([{ g1: [{ g2: ["i3"] }] }, "i4", "i5"]);
    expect(shape(spaceOf(next, "s2").tree)).toEqual(["i2", "i6"]);
    expect(spaceOf(next, "s2").items.i2).toEqual(spaceOf(ws, "s1").items.i2);
    expect(lost(ws, next)).toEqual([]);
    const fav = applyChecked(ws, { type: "item/move", itemId: "i1", spaceId: "s2" });
    expect(fav.favorites).toEqual(["i1", "i6"]);
    expect(spaceOf(fav, "s1").pinned).toEqual([]);
    expect(shape(spaceOf(fav, "s2").tree)).toEqual(["i6", "i1"]);
  });

  it("moves to pinned, at a position", () => {
    const next = applyChecked(fixture(), {
      type: "item/move",
      itemId: "i4",
      placement: { to: "pinned", index: 0 },
    });
    expect(spaceOf(next, "s1").pinned).toEqual(["i4", "i1"]);
  });

  it("returns the same workspace for an unknown item, space or group, or a group of another space", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/move", itemId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/move", itemId: "i4", spaceId: "nope" })).toBe(ws);
    expect(
      applyChecked(ws, {
        type: "item/move",
        itemId: "i4",
        placement: { to: "tree", groupId: "nope" },
      }),
    ).toBe(ws);
    expect(
      applyChecked(ws, {
        type: "item/move",
        itemId: "i6",
        placement: { to: "tree", groupId: "g1" },
      }),
    ).toBe(ws);
    expect(
      applyChecked(ws, { type: "item/move", itemId: "i4", placement: { to: "tree", index: 0.5 } }),
    ).toBe(ws);
  });
});

describe("item/pin and item/unpin", () => {
  it("pins at the end, pulling the item out of its group", () => {
    const next = applyChecked(fixture(), { type: "item/pin", itemId: "i3" });
    expect(spaceOf(next, "s1").pinned).toEqual(["i1", "i3"]);
    expect(shape(spaceOf(next, "s1").tree)).toEqual([{ g1: ["i2", { g2: [] }] }, "i4", "i5"]);
  });

  it("pins at a position", () => {
    const next = applyChecked(fixture(), { type: "item/pin", itemId: "i4", index: 0 });
    expect(spaceOf(next, "s1").pinned).toEqual(["i4", "i1"]);
  });

  it("unpins to the top of the tree by default, or to the given position", () => {
    const top = applyChecked(fixture(), { type: "item/unpin", itemId: "i1" });
    expect(spaceOf(top, "s1").pinned).toEqual([]);
    expect(shape(spaceOf(top, "s1").tree)).toEqual([
      "i1",
      { g1: ["i2", { g2: ["i3"] }] },
      "i4",
      "i5",
    ]);
    const placed = applyChecked(fixture(), { type: "item/unpin", itemId: "i1", index: 2 });
    expect(shape(spaceOf(placed, "s1").tree)).toEqual([
      { g1: ["i2", { g2: ["i3"] }] },
      "i4",
      "i1",
      "i5",
    ]);
  });

  it("returns the same workspace when already pinned, not pinned or unknown", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/pin", itemId: "i1" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/pin", itemId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/pin", itemId: "i4", index: 0.5 })).toBe(ws);
    expect(applyChecked(ws, { type: "item/unpin", itemId: "i4" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/unpin", itemId: "nope" })).toBe(ws);
  });
});

describe("item/favorite and item/unfavorite", () => {
  it("adds a favorite from any space, once", () => {
    const next = applyChecked(fixture(), { type: "item/favorite", itemId: "i3" });
    expect(next.favorites).toEqual(["i1", "i6", "i3"]);
    expect(applyChecked(next, { type: "item/favorite", itemId: "i3" })).toBe(next);
  });

  it("removes a favorite", () => {
    const next = applyChecked(fixture(), { type: "item/unfavorite", itemId: "i1" });
    expect(next.favorites).toEqual(["i6"]);
    expect(spaceOf(next, "s1").pinned).toEqual(["i1"]);
  });

  it("returns the same workspace for an unknown item or a non-favorite", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "item/favorite", itemId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/favorite", itemId: "i7" })).toBe(ws);
    expect(applyChecked(ws, { type: "item/unfavorite", itemId: "i4" })).toBe(ws);
  });
});

describe("group/create", () => {
  it("adds an empty group to the end of the tree, in the color of the space by default", () => {
    const next = applyChecked(fixture(), { type: "group/create", name: " Work " });
    const group = must(spaceOf(next, "s1").tree.at(-1));
    expect(group).toEqual({
      kind: "group",
      id: "n1",
      name: "Work",
      color: "#6b8afd",
      collapsed: false,
      children: [],
    });
  });

  it("nests in a top-level group (the second level), at a position", () => {
    const next = applyChecked(fixture(), {
      type: "group/create",
      name: "Sub",
      color: "red",
      parentGroupId: "g1",
      index: 0,
    });
    expect(shape(spaceOf(next, "s1").tree)[0]).toEqual({ g1: [{ n1: [] }, "i2", { g2: ["i3"] }] });
  });

  it("returns the same workspace for a third level, an unknown parent or a parent of another space", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "group/create", name: "Deep", parentGroupId: "g2" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/create", name: "X", parentGroupId: "nope" })).toBe(ws);
    expect(
      applyChecked(ws, { type: "group/create", name: "X", spaceId: "s2", parentGroupId: "g1" }),
    ).toBe(ws);
  });

  it("returns the same workspace for a blank name or color, an unknown space or a bad index", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "group/create", name: " " })).toBe(ws);
    expect(applyChecked(ws, { type: "group/create", name: "X", color: "" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/create", name: "X", spaceId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/create", name: "X", index: 0.5 })).toBe(ws);
  });
});

describe("group/create-from-selection", () => {
  it("wraps the items in a group where the first one was, in tree order", () => {
    const next = applyChecked(fixture(), {
      type: "group/create-from-selection",
      itemIds: ["i5", "i4"],
      name: "Pair",
    });
    expect(shape(spaceOf(next, "s1").tree)).toEqual([
      { g1: ["i2", { g2: ["i3"] }] },
      { n1: ["i4", "i5"] },
    ]);
    expect(spaceOf(next, "s1").tree.at(-1)).toMatchObject({
      name: "Pair",
      color: "#6b8afd",
      collapsed: false,
    });
  });

  it("works across groups: the new group sits in the group of the first item", () => {
    const next = applyChecked(fixture(), {
      type: "group/create-from-selection",
      itemIds: ["i3", "i2", "i5"],
      name: "Mix",
      color: "red",
    });
    expect(shape(spaceOf(next, "s1").tree)).toEqual([
      { g1: [{ n1: ["i2", "i3", "i5"] }, { g2: [] }] },
      "i4",
    ]);
  });

  it("accepts duplicated ids", () => {
    const next = applyChecked(fixture(), {
      type: "group/create-from-selection",
      itemIds: ["i4", "i4"],
      name: "One",
    });
    expect(shape(spaceOf(next, "s1").tree)).toEqual([
      { g1: ["i2", { g2: ["i3"] }] },
      { n1: ["i4"] },
      "i5",
    ]);
  });

  it("returns the same workspace when the group would be a third level", () => {
    const ws = fixture();
    expect(
      applyChecked(ws, { type: "group/create-from-selection", itemIds: ["i3"], name: "Deep" }),
    ).toBe(ws);
  });

  it("returns the same workspace for an empty, unknown, pinned or cross-space selection", () => {
    const ws = fixture();
    const group = (itemIds: Id[]): Action => ({
      type: "group/create-from-selection",
      itemIds,
      name: "G",
    });
    expect(applyChecked(ws, group([]))).toBe(ws);
    expect(applyChecked(ws, group(["nope"]))).toBe(ws);
    expect(applyChecked(ws, group(["i4", "nope"]))).toBe(ws);
    expect(applyChecked(ws, group(["i1"]))).toBe(ws);
    expect(applyChecked(ws, group(["i4", "i1"]))).toBe(ws);
    expect(applyChecked(ws, group(["i4", "i6"]))).toBe(ws);
    expect(
      applyChecked(ws, { type: "group/create-from-selection", itemIds: ["i4"], name: " " }),
    ).toBe(ws);
    expect(
      applyChecked(ws, {
        type: "group/create-from-selection",
        itemIds: ["i4"],
        name: "G",
        color: "",
      }),
    ).toBe(ws);
  });
});

describe("group/ungroup", () => {
  it("puts the children in the place of the group", () => {
    const next = applyChecked(fixture(), { type: "group/ungroup", groupId: "g1" });
    expect(shape(spaceOf(next, "s1").tree)).toEqual(["i2", { g2: ["i3"] }, "i4", "i5"]);
  });

  it("ungroups the inner group into the outer one", () => {
    const next = applyChecked(fixture(), { type: "group/ungroup", groupId: "g2" });
    expect(shape(spaceOf(next, "s1").tree)).toEqual([{ g1: ["i2", "i3"] }, "i4", "i5"]);
  });

  it("drops an empty group and returns the same workspace for an unknown one", () => {
    const ws = fixture();
    const empty = applyChecked(ws, { type: "group/create", name: "E" });
    expect(
      shape(spaceOf(applyChecked(empty, { type: "group/ungroup", groupId: "n1" }), "s1").tree),
    ).toEqual(shape(spaceOf(ws, "s1").tree));
    expect(applyChecked(ws, { type: "group/ungroup", groupId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/ungroup", groupId: "i4" })).toBe(ws);
  });
});

describe("group/set-collapsed, group/rename and group/set-color", () => {
  const groupOf = (ws: Workspace, id: Id): GroupNode => {
    const found = spaceOf(ws, "s1").tree.find(
      (n): n is GroupNode => n.kind === "group" && n.id === id,
    );
    return must(found);
  };

  it("collapses and expands a group", () => {
    const collapsed = applyChecked(fixture(), {
      type: "group/set-collapsed",
      groupId: "g1",
      collapsed: true,
    });
    expect(groupOf(collapsed, "g1").collapsed).toBe(true);
    const expanded = applyChecked(collapsed, {
      type: "group/set-collapsed",
      groupId: "g1",
      collapsed: false,
    });
    expect(groupOf(expanded, "g1").collapsed).toBe(false);
  });

  it("collapses an inner group", () => {
    const next = applyChecked(fixture(), {
      type: "group/set-collapsed",
      groupId: "g2",
      collapsed: true,
    });
    const inner = must(groupOf(next, "g1").children.find((n) => n.id === "g2"));
    expect(inner).toMatchObject({ collapsed: true });
  });

  it("renames a group, trimming the name", () => {
    const next = applyChecked(fixture(), {
      type: "group/rename",
      groupId: "g1",
      name: " Servers ",
    });
    expect(groupOf(next, "g1").name).toBe("Servers");
  });

  it("changes the color of a group", () => {
    const next = applyChecked(fixture(), { type: "group/set-color", groupId: "g1", color: "red" });
    expect(groupOf(next, "g1").color).toBe("red");
  });

  it("returns the same workspace for an unknown group, blank input or no change", () => {
    const ws = fixture();
    expect(
      applyChecked(ws, { type: "group/set-collapsed", groupId: "nope", collapsed: true }),
    ).toBe(ws);
    expect(applyChecked(ws, { type: "group/set-collapsed", groupId: "g1", collapsed: false })).toBe(
      ws,
    );
    expect(applyChecked(ws, { type: "group/rename", groupId: "nope", name: "X" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/rename", groupId: "g1", name: " " })).toBe(ws);
    expect(applyChecked(ws, { type: "group/rename", groupId: "g1", name: "outer" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/set-color", groupId: "nope", color: "red" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/set-color", groupId: "g1", color: "" })).toBe(ws);
    expect(applyChecked(ws, { type: "group/set-color", groupId: "g1", color: "teal" })).toBe(ws);
  });
});

describe("liveSessionIds", () => {
  it("lists the sessions of live items, not of closed or archived ones", () => {
    const ws: Workspace = {
      ...fixture(),
      closed: [{ item: item("c", leaf("pc", "xc"), "pc"), spaceId: "s1", closedAt: 1 }],
      archive: [{ item: item("a", leaf("pa", "xa"), "pa"), spaceId: "s1", archivedAt: 1 }],
    };
    expect([...liveSessionIds(ws)].sort()).toEqual(["x1", "x2", "x3", "x4", "x5", "x6", "x7"]);
  });

  it("is empty when no pane has a session", () => {
    const { ctx } = testContext();
    const ws = applyChecked(fixture(), { type: "space/create", name: "Empty" }, ctx);
    expect(liveSessionIds({ ...ws, spaces: ws.spaces.filter((s) => s.id === "n1") }).size).toBe(0);
  });

  it("tells the app which sessions to end: those of the closed item only", () => {
    const ws = fixture();
    const next = applyChecked(ws, { type: "item/close", itemId: "i2" });
    expect(lost(ws, next)).toEqual(sessionsOf(must(spaceOf(ws, "s1").items.i2)).sort());
    expect([...liveSessionIds(next)].filter((id) => !liveSessionIds(ws).has(id))).toEqual([]);
  });
});

describe("reduce", () => {
  it("never mutates its input", () => {
    const ws = deepFreeze(fixture());
    const { ctx } = testContext();
    const actions: Action[] = [
      { type: "space/create", name: "A" },
      { type: "item/create" },
      { type: "item/move", itemId: "i2", spaceId: "s2" },
      { type: "group/create-from-selection", itemIds: ["i4", "i5"], name: "G" },
      { type: "item/close", itemId: "i1" },
      { type: "item/reopen" },
      { type: "space/delete", spaceId: "s2", items: { mode: "close" } },
    ];
    let current = ws;
    for (const action of actions) current = reduceStrict(current, action, ctx);
    expect(current).not.toBe(ws);
    expect(ws).toEqual(fixture());
  });

  it("is deterministic: same state, actions and context give the same result", () => {
    const actions: Action[] = [
      { type: "item/create" },
      { type: "group/create", name: "G" },
      { type: "item/close", itemId: "i4" },
      { type: "item/reopen" },
    ];
    const run = (): Workspace => {
      const { ctx } = testContext();
      return actions.reduce((state, action) => reduceStrict(state, action, ctx), fixture());
    };
    expect(run()).toEqual(run());
  });

  it("returns the same workspace, without throwing, for input that is not an action", () => {
    const ws = fixture();
    const { ctx } = testContext();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      {},
      { type: "nope" },
      { type: "item/close" },
      { type: "item/close", itemId: 42 },
      { type: "space/rename", spaceId: "s1", name: 42 },
      { type: "space/delete", spaceId: "s1" },
      { type: "space/delete", spaceId: "s1", items: null },
      { type: "group/create-from-selection", itemIds: "i4", name: "G" },
      { type: "group/create-from-selection", itemIds: null, name: "G" },
      { type: "item/move", itemId: "i4", placement: { to: "elsewhere" } },
    ];
    for (const action of junk) {
      const next = reduce(ws, action as Action, ctx);
      expect(checkInvariants(next)).toEqual([]);
    }
  });
});

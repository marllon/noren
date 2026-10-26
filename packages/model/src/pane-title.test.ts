import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { checkInvariants } from "./invariants";
import { reduce } from "./reducer";
import { layoutPanes } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, deepFreeze, pane, testContext } from "./test-helpers";
import { MAX_PANE_NAME, MAX_PANE_TITLE } from "./types";
import type { Id, Item, LayoutNode, Pane, Space, Workspace } from "./types";

const leaf = (id: string, sessionId: string): LayoutNode => ({
  kind: "pane",
  pane: { ...pane(id, sessionId), cwd: `/work/${id}` },
});

const item = (id: string, layout: LayoutNode, focusedPaneId: string): Item => ({
  id,
  titleLocked: false,
  layout,
  focusedPaneId,
  lastActivityAt: 0,
});

/** One space with a tab `loop` (pane `pl`) and a tab `docs` that is a split of `pm1` and `pm2`. */
function fixture(): Workspace {
  const space: Space = {
    id: "s1",
    name: "Main",
    icon: "terminal",
    color: "#6b8afd",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: [],
    tree: [
      { kind: "item", id: "loop" },
      { kind: "item", id: "docs" },
    ],
    items: {
      loop: item("loop", leaf("pl", "x1"), "pl"),
      docs: item(
        "docs",
        {
          kind: "split",
          dir: "row",
          sizes: [50, 50],
          children: [leaf("pm1", "x3"), leaf("pm2", "x4")],
        },
        "pm1",
      ),
    },
  };
  return {
    version: 2,
    spaces: [space],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing value");
  return value;
}

const allPanes = (ws: Workspace): Pane[] =>
  ws.spaces.flatMap((space) => Object.values(space.items).flatMap((it) => layoutPanes(it.layout)));
const paneOf = (ws: Workspace, id: Id): Pane => must(allPanes(ws).find((p) => p.id === id));
const setTitle = (itemId: Id, paneId: Id, title: string): Action => ({
  type: "pane/set-title",
  itemId,
  paneId,
  title,
});

describe("pane/set-title", () => {
  it("records the title a program set, trimmed", () => {
    const next = applyChecked(fixture(), setTitle("loop", "pl", "  loop Noren  "));
    expect(paneOf(next, "pl").title).toBe("loop Noren");
    expect(paneOf(next, "pm1").title).toBeUndefined();
  });

  it("keeps the title apart from the name of the pane", () => {
    const named = applyChecked(fixture(), {
      type: "pane/rename",
      itemId: "loop",
      paneId: "pl",
      name: "Loop",
    });
    const next = applyChecked(named, setTitle("loop", "pl", "vim"));
    expect(paneOf(next, "pl").name).toBe("Loop");
    expect(paneOf(next, "pl").title).toBe("vim");
    // A blank name does not take the title away, and the other way round.
    const unnamed = applyChecked(next, {
      type: "pane/rename",
      itemId: "loop",
      paneId: "pl",
      name: "",
    });
    expect(paneOf(unnamed, "pl")).not.toHaveProperty("name");
    expect(paneOf(unnamed, "pl").title).toBe("vim");
  });

  it("titles the panes of a split one by one", () => {
    const a = applyChecked(fixture(), setTitle("docs", "pm1", "build"));
    const next = applyChecked(a, setTitle("docs", "pm2", "serve"));
    expect(paneOf(next, "pm1").title).toBe("build");
    expect(paneOf(next, "pm2").title).toBe("serve");
  });

  it("takes the title away when it is blank, so the pane goes back to its folder", () => {
    const titled = applyChecked(fixture(), setTitle("loop", "pl", "vim"));
    for (const blank of ["", "   ", "\t\n"]) {
      const next = applyChecked(titled, setTitle("loop", "pl", blank));
      expect(paneOf(next, "pl")).not.toHaveProperty("title");
    }
  });

  it("cuts a title at the longest the pane keeps, by characters", () => {
    expect(MAX_PANE_TITLE).toBe(MAX_PANE_NAME);
    const long = applyChecked(fixture(), setTitle("loop", "pl", "x".repeat(MAX_PANE_TITLE + 40)));
    expect(paneOf(long, "pl").title).toBe("x".repeat(MAX_PANE_TITLE));
    const emoji = applyChecked(
      fixture(),
      setTitle("loop", "pl", "\u{1F680}".repeat(MAX_PANE_TITLE + 5)),
    );
    expect(Array.from(must(paneOf(emoji, "pl").title))).toHaveLength(MAX_PANE_TITLE);
    expect(checkInvariants(emoji)).toEqual([]);
  });

  it("leaves the workspace as it is for an unknown tab or pane, or for a title it already has", () => {
    const { ctx } = testContext();
    const ws = deepFreeze(applyChecked(fixture(), setTitle("loop", "pl", "vim")));
    expect(reduce(ws, setTitle("ghost", "pl", "X"), ctx)).toBe(ws);
    expect(reduce(ws, setTitle("loop", "ghost", "X"), ctx)).toBe(ws);
    expect(reduce(ws, setTitle("docs", "pl", "X"), ctx)).toBe(ws);
    expect(reduce(ws, setTitle("loop", "pl", "vim"), ctx)).toBe(ws);
    expect(reduce(ws, setTitle("loop", "pl", "  vim "), ctx)).toBe(ws);
    expect(reduce(ws, setTitle("docs", "pm1", ""), ctx)).toBe(ws);
  });

  it("leaves the workspace as it is when the title is not text", () => {
    const { ctx } = testContext();
    const ws = deepFreeze(fixture());
    const bad = { type: "pane/set-title", itemId: "loop", paneId: "pl", title: 7 } as never;
    expect(reduce(ws, bad, ctx)).toBe(ws);
  });

  it("does not touch the tab title or the state of the pane", () => {
    const before = fixture();
    const next = applyChecked(before, setTitle("loop", "pl", "vim"));
    const titled = { ...paneOf(next, "pl") };
    delete titled.title;
    expect(titled).toEqual(paneOf(before, "pl"));
    expect(must(next.spaces[0]).items["loop"]?.title).toBeUndefined();
  });

  it("makes the new pane of a split without a title", () => {
    const titled = applyChecked(fixture(), setTitle("loop", "pl", "vim"));
    const next = applyChecked(titled, {
      type: "pane/split",
      itemId: "loop",
      paneId: "pl",
      dir: "row",
      side: "after",
    });
    const panes = layoutPanes(must(must(next.spaces[0]).items["loop"]).layout);
    expect(panes.map((p) => p.title)).toEqual(["vim", undefined]);
  });

  it("goes away with the shell that exits", () => {
    const titled = applyChecked(fixture(), setTitle("loop", "pl", "vim"));
    const next = applyChecked(titled, {
      type: "pane/set-status",
      itemId: "loop",
      paneId: "pl",
      status: "exited",
      exitCode: 0,
    });
    expect(paneOf(next, "pl")).not.toHaveProperty("title");
  });

  it("is not kept by a closed tab that is reopened", () => {
    const titled = applyChecked(fixture(), setTitle("loop", "pl", "vim"));
    const closed = applyChecked(titled, { type: "item/close", itemId: "loop" });
    const next = applyChecked(closed, { type: "item/reopen" });
    expect(paneOf(next, "pl")).not.toHaveProperty("title");
  });

  it("follows the pane when it is taken out of a split", () => {
    const titled = applyChecked(fixture(), setTitle("docs", "pm2", "serve"));
    const next = applyChecked(titled, { type: "pane/detach", itemId: "docs", paneId: "pm2" });
    expect(paneOf(next, "pm2").title).toBe("serve");
  });
});

describe("the title of a pane in state.json", () => {
  it("is not saved", () => {
    const ws = applyChecked(fixture(), setTitle("loop", "pl", "loop Noren"));
    expect(paneOf(ws, "pl").title).toBe("loop Noren");
    const text = serializeWorkspace(ws);
    expect(text).not.toContain("loop Noren");
    expect(text).not.toContain('"title":"loop Noren"');
    const parsed = parseState(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, "pl")).not.toHaveProperty("title");
  });

  it("is dropped when a file holds one", () => {
    const data = JSON.parse(serializeWorkspace(fixture())) as {
      spaces: { items: Record<string, { layout: { pane: Record<string, unknown> } }> }[];
    };
    const first = must(must(data.spaces[0]).items["loop"]);
    first.layout.pane["title"] = "left by an old run";
    const parsed = parseState(JSON.stringify(data));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, "pl")).not.toHaveProperty("title");
    expect(checkInvariants(parsed.workspace)).toEqual([]);
  });

  it("keeps the name, which is saved", () => {
    const named = applyChecked(fixture(), {
      type: "pane/rename",
      itemId: "loop",
      paneId: "pl",
      name: "Loop",
    });
    const ws = applyChecked(named, setTitle("loop", "pl", "vim"));
    const parsed = parseState(serializeWorkspace(ws));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, "pl").name).toBe("Loop");
  });
});

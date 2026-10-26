import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { checkInvariants } from "./invariants";
import { reduce } from "./reducer";
import { layoutPanes } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked, deepFreeze, pane, testContext } from "./test-helpers";
import { MAX_PANE_NAME } from "./types";
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

/**
 * One space with three tabs: `loop` (pane `pl`), `dev` (pane `pd`) and `docs` (pane `pm`, a split of
 * two panes `pm1` and `pm2`). Every pane has its own id and its own session.
 */
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
      { kind: "item", id: "dev" },
      { kind: "item", id: "docs" },
    ],
    items: {
      loop: item("loop", leaf("pl", "x1"), "pl"),
      dev: item("dev", leaf("pd", "x2"), "pd"),
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
const rename = (itemId: Id, paneId: Id, name: string): Action => ({
  type: "pane/rename",
  itemId,
  paneId,
  name,
});

describe("pane/rename", () => {
  it("gives a pane a name, trimmed", () => {
    const next = applyChecked(fixture(), rename("loop", "pl", "  Loop Noren  "));
    expect(paneOf(next, "pl").name).toBe("Loop Noren");
    // The other panes are not touched.
    expect(paneOf(next, "pd").name).toBeUndefined();
    expect(paneOf(next, "pm1").name).toBeUndefined();
  });

  it("renames a pane of a split without touching its neighbour", () => {
    const named = applyChecked(fixture(), rename("docs", "pm1", "Docs"));
    const next = applyChecked(named, rename("docs", "pm2", "Site"));
    expect(paneOf(next, "pm1").name).toBe("Docs");
    expect(paneOf(next, "pm2").name).toBe("Site");
  });

  it("changes a name that is already there", () => {
    const named = applyChecked(fixture(), rename("loop", "pl", "Loop"));
    const next = applyChecked(named, rename("loop", "pl", "Loop Noren"));
    expect(paneOf(next, "pl").name).toBe("Loop Noren");
  });

  it("takes the name away when it is blank, so the pane shows what it did before", () => {
    const named = applyChecked(fixture(), rename("loop", "pl", "Loop"));
    for (const blank of ["", "   ", "\t\n"]) {
      const next = applyChecked(named, rename("loop", "pl", blank));
      expect(paneOf(next, "pl")).not.toHaveProperty("name");
    }
  });

  it("cuts a name at the longest the pane keeps", () => {
    const next = applyChecked(fixture(), rename("loop", "pl", "x".repeat(MAX_PANE_NAME + 40)));
    expect(paneOf(next, "pl").name).toBe("x".repeat(MAX_PANE_NAME));
    expect(checkInvariants(next)).toEqual([]);
  });

  it("cuts by characters, not by code units", () => {
    const next = applyChecked(
      fixture(),
      rename("loop", "pl", "\u{1F680}".repeat(MAX_PANE_NAME + 5)),
    );
    expect(Array.from(must(paneOf(next, "pl").name))).toHaveLength(MAX_PANE_NAME);
  });

  it("leaves the workspace as it is for an unknown tab or pane, or for a name it already has", () => {
    const { ctx } = testContext();
    const ws = deepFreeze(applyChecked(fixture(), rename("loop", "pl", "Loop")));
    expect(reduce(ws, rename("ghost", "pl", "X"), ctx)).toBe(ws);
    expect(reduce(ws, rename("loop", "ghost", "X"), ctx)).toBe(ws);
    // A pane of another tab is not the pane of this one.
    expect(reduce(ws, rename("dev", "pl", "X"), ctx)).toBe(ws);
    expect(reduce(ws, rename("loop", "pl", "Loop"), ctx)).toBe(ws);
    expect(reduce(ws, rename("loop", "pl", "  Loop "), ctx)).toBe(ws);
    expect(reduce(ws, rename("dev", "pd", ""), ctx)).toBe(ws);
  });

  it("leaves the workspace as it is when the name is not text", () => {
    const { ctx } = testContext();
    const ws = deepFreeze(fixture());
    const bad = { type: "pane/rename", itemId: "loop", paneId: "pl", name: 7 } as unknown as Action;
    expect(reduce(ws, bad, ctx)).toBe(ws);
  });

  it("does not touch the tab title or the state of the pane", () => {
    const before = fixture();
    const next = applyChecked(before, rename("loop", "pl", "Loop"));
    const renamed = { ...paneOf(next, "pl") };
    delete renamed.name;
    expect(renamed).toEqual(paneOf(before, "pl"));
    expect(must(next.spaces[0]).items["loop"]?.title).toBeUndefined();
  });

  it("makes the new pane of a split without a name", () => {
    const named = applyChecked(fixture(), rename("loop", "pl", "Loop"));
    const next = applyChecked(named, {
      type: "pane/split",
      itemId: "loop",
      paneId: "pl",
      dir: "row",
      side: "after",
    });
    const panes = layoutPanes(must(must(next.spaces[0]).items["loop"]).layout);
    expect(panes.map((p) => p.name)).toEqual(["Loop", undefined]);
  });
});

describe("the name of a pane follows the pane", () => {
  const named = (): Workspace => {
    const a = applyChecked(fixture(), rename("loop", "pl", "Loop"));
    return applyChecked(a, rename("dev", "pd", "Dev server"));
  };

  it("survives joining its tab into a split", () => {
    const next = applyChecked(named(), {
      type: "item/join",
      itemId: "dev",
      targetItemId: "loop",
      targetPaneId: "pl",
      dir: "row",
      side: "after",
    });
    const joined = layoutPanes(must(must(next.spaces[0]).items["loop"]).layout);
    expect(joined.map((p) => [p.id, p.name])).toEqual([
      ["pl", "Loop"],
      ["pd", "Dev server"],
    ]);
  });

  it("survives being taken out of a split into a tab of its own", () => {
    const joined = applyChecked(named(), {
      type: "item/join",
      itemId: "dev",
      targetItemId: "loop",
      targetPaneId: "pl",
      dir: "row",
      side: "after",
    });
    const next = applyChecked(joined, { type: "pane/detach", itemId: "loop", paneId: "pd" });
    expect(paneOf(next, "pd").name).toBe("Dev server");
    expect(paneOf(next, "pl").name).toBe("Loop");
    const owners = Object.values(must(next.spaces[0]).items).filter((it) =>
      layoutPanes(it.layout).some((p) => p.id === "pd"),
    );
    expect(owners).toHaveLength(1);
    expect(layoutPanes(must(owners[0]).layout)).toHaveLength(1);
  });

  it("survives a pane swap", () => {
    const joined = applyChecked(named(), {
      type: "item/join",
      itemId: "dev",
      targetItemId: "loop",
      targetPaneId: "pl",
      dir: "row",
      side: "after",
    });
    const next = applyChecked(joined, {
      type: "pane/swap",
      itemId: "loop",
      paneId: "pl",
      otherPaneId: "pd",
    });
    expect(layoutPanes(must(must(next.spaces[0]).items["loop"]).layout).map((p) => p.name)).toEqual(
      ["Dev server", "Loop"],
    );
  });

  it("survives closing and reopening its tab", () => {
    const closed = applyChecked(named(), { type: "item/close", itemId: "loop" });
    const next = applyChecked(closed, { type: "item/reopen" });
    expect(paneOf(next, "pl").name).toBe("Loop");
  });
});

describe("the name of a pane in state.json", () => {
  it("is saved and read back as it was", () => {
    const ws = applyChecked(
      applyChecked(fixture(), rename("loop", "pl", "Loop")),
      rename("docs", "pm2", "Site"),
    );
    const parsed = parseState(serializeWorkspace(ws));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, "pl").name).toBe("Loop");
    expect(paneOf(parsed.workspace, "pm2").name).toBe("Site");
    expect(paneOf(parsed.workspace, "pm1")).not.toHaveProperty("name");
    expect(checkInvariants(parsed.workspace)).toEqual([]);
  });

  it("reads a file saved before panes had a name", () => {
    expect(parseState(serializeWorkspace(fixture())).ok).toBe(true);
  });

  const withName = (name: unknown): string => {
    const ws = fixture();
    const space = must(ws.spaces[0]);
    const tab = must(space.items["loop"]);
    const first = layoutPanes(tab.layout)[0];
    const bad: Workspace = {
      ...ws,
      spaces: [
        {
          ...space,
          items: {
            ...space.items,
            loop: { ...tab, layout: { kind: "pane", pane: { ...must(first), name } as Pane } },
          },
        },
      ],
    };
    return serializeWorkspace(bad);
  };

  it.each([
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["an object", { text: "Loop" }],
    ["blank", ""],
    ["only spaces", "   "],
    ["longer than a pane keeps", "x".repeat(MAX_PANE_NAME + 1)],
  ])("refuses a file whose pane name is %s", (_label, name) => {
    const parsed = parseState(withName(name));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("name");
  });

  it("accepts a name of the longest size", () => {
    expect(parseState(withName("x".repeat(MAX_PANE_NAME))).ok).toBe(true);
  });
});

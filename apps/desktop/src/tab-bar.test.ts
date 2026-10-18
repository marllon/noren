import { describe, expect, it } from "vitest";
import type { Space } from "@noren/model";
import { barFocusTarget, barItemIds, barNodes } from "./tab-bar";
import { visibleItemIds, visibleRows } from "./sidebar-tree";

function pane(id: string) {
  return {
    id,
    type: "terminal" as const,
    profileId: "default",
    status: "idle" as const,
    unread: false,
    bell: false,
  };
}

function item(id: string) {
  return {
    id,
    titleLocked: false,
    layout: { kind: "pane" as const, pane: pane(`p-${id}`) },
    focusedPaneId: `p-${id}`,
    lastActivityAt: 1,
  };
}

function spaceOf(pinned: string[], tree: Space["tree"], ids: string[]): Space {
  return {
    id: "s1",
    name: "Main",
    icon: "terminal",
    color: "#6b8afd",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned,
    tree,
    items: Object.fromEntries(ids.map((id) => [id, item(id)])),
    activeItemId: ids[0],
  } as Space;
}

const group = (id: string, collapsed: boolean, children: Space["tree"]): Space["tree"][number] => ({
  kind: "group",
  id,
  name: `Group ${id}`,
  color: "teal",
  collapsed,
  children,
});

describe("barNodes", () => {
  const space = spaceOf(
    ["a"],
    [
      group("g1", false, [
        { kind: "item", id: "b" },
        group("g2", false, [{ kind: "item", id: "c" }]),
      ]),
      { kind: "item", id: "d" },
    ],
    ["a", "b", "c", "d"],
  );

  it("lists pinned tabs first, then the tree, with groups holding their nodes", () => {
    const nodes = barNodes(space);
    expect(nodes.map((node) => node.kind)).toEqual(["item", "group", "item"]);
    expect(nodes[0]).toEqual({ kind: "item", id: "a", pinned: true });
    const outer = nodes[1];
    if (outer?.kind !== "group") throw new Error("expected a group");
    expect(outer.count).toBe(2);
    expect(outer.nodes.map((node) => node.kind)).toEqual(["item", "group"]);
  });

  it("keeps a collapsed group as a header with its count and no tabs", () => {
    const folded = spaceOf(
      [],
      [
        group("g1", true, [
          { kind: "item", id: "b" },
          { kind: "item", id: "c" },
        ]),
      ],
      ["b", "c"],
    );
    const [only] = barNodes(folded);
    if (only?.kind !== "group") throw new Error("expected a group");
    expect(only.count).toBe(2);
    expect(only.nodes).toEqual([]);
    expect(barItemIds(barNodes(folded))).toEqual([]);
  });

  it("shows the same tabs in the same order as the sidebar rows", () => {
    expect(barItemIds(barNodes(space))).toEqual(visibleItemIds(visibleRows(space)));
    const folded = spaceOf(
      ["a"],
      [group("g1", true, [{ kind: "item", id: "b" }]), { kind: "item", id: "d" }],
      ["a", "b", "d"],
    );
    expect(barItemIds(barNodes(folded))).toEqual(visibleItemIds(visibleRows(folded)));
  });
});

describe("barFocusTarget", () => {
  it("steps to the neighbor and stops at the ends", () => {
    expect(barFocusTarget("ArrowRight", 1, 4)).toBe(2);
    expect(barFocusTarget("ArrowRight", 3, 4)).toBe(3);
    expect(barFocusTarget("ArrowLeft", 1, 4)).toBe(0);
    expect(barFocusTarget("ArrowLeft", 0, 4)).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    expect(barFocusTarget("Home", 2, 4)).toBe(0);
    expect(barFocusTarget("End", 1, 4)).toBe(3);
  });

  it("ignores other keys and an empty bar", () => {
    expect(barFocusTarget("ArrowDown", 1, 4)).toBeUndefined();
    expect(barFocusTarget("a", 1, 4)).toBeUndefined();
    expect(barFocusTarget("ArrowRight", 0, 0)).toBeUndefined();
  });
});

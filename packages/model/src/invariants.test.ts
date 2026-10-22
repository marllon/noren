import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbWorkspace } from "./arbitraries";
import { ManualClock } from "./clock";
import { createDefaultWorkspace } from "./default-workspace";
import { createSequentialIds } from "./ids";
import { SIZE_SUM_TOLERANCE, checkInvariants, type ViolationCode } from "./invariants";
import {
  MAX_CLOSED,
  type FavoriteLink,
  type GroupNode,
  type Item,
  type LayoutNode,
  type Pane,
  type Space,
  type SplitNode,
  type Workspace,
} from "./types";

const pane = (id: string, sessionId?: string): Pane => ({
  id,
  type: "terminal",
  ...(sessionId !== undefined ? { sessionId } : {}),
  profileId: "bash",
  status: "running",
  unread: false,
  bell: false,
});

const leaf = (p: Pane): LayoutNode => ({ kind: "pane", pane: p });

const item = (id: string, layout: LayoutNode, focusedPaneId: string): Item => ({
  id,
  titleLocked: false,
  layout,
  focusedPaneId,
  lastActivityAt: 0,
});

/**
 * Hand-built valid workspace used as the base of the negative tests:
 * s1 { pinned i1; tree: group g1 { i2 (split of p2,p3), group g2 { i3 } } }, i1 is a favorite,
 * i4 is closed and i5 is archived.
 */
function fixture(): Workspace {
  const split: SplitNode = {
    kind: "split",
    dir: "row",
    sizes: [40, 60],
    children: [leaf(pane("p2", "x2")), leaf(pane("p3", "x3"))],
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
    collapsed: true,
    children: [{ kind: "item", id: "i2" }, g2],
  };
  const space: Space = {
    id: "s1",
    name: "Main",
    icon: "terminal",
    color: "red",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback: true,
    pinned: ["i1"],
    tree: [g1],
    items: {
      i1: item("i1", leaf(pane("p1", "x1")), "p1"),
      i2: item("i2", split, "p2"),
      i3: item("i3", leaf(pane("p4")), "p4"),
    },
  };
  return {
    version: 2,
    spaces: [space],
    activeSpaceId: "s1",
    favorites: ["i1"],
    closed: [{ item: item("i4", leaf(pane("p5")), "p5"), spaceId: "s1", closedAt: 1 }],
    archive: [{ item: item("i5", leaf(pane("p6")), "p6"), spaceId: "s1", archivedAt: 2 }],
  };
}

/** Clone of the fixture, mutated by `mutate`, whose violation codes are returned. */
function codesAfter(mutate: (ws: Workspace, space: Space) => void): ViolationCode[] {
  const ws = fixture();
  const space = ws.spaces[0] as Space;
  mutate(ws, space);
  return checkInvariants(ws).map((v) => v.code);
}

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("fixture changed");
  return value;
};

describe("createDefaultWorkspace", () => {
  it("is the space Main with one tab of one pane, and valid", () => {
    const ws = createDefaultWorkspace();
    expect(ws.version).toBe(2);
    expect(ws.spaces).toHaveLength(1);
    const space = must(ws.spaces[0]);
    expect(space.name).toBe("Main");
    expect(ws.activeSpaceId).toBe(space.id);
    expect(space.pinned).toEqual([]);
    expect(space.tree).toHaveLength(1);
    const items = Object.values(space.items);
    expect(items).toHaveLength(1);
    const only = must(items[0]);
    expect(only.layout.kind).toBe("pane");
    expect(space.tree).toEqual([{ kind: "item", id: only.id }]);
    expect(ws.closed).toEqual([]);
    expect(ws.archive).toEqual([]);
    expect(checkInvariants(ws)).toEqual([]);
  });

  it("takes ids, time and profile from its parameters", () => {
    const clock = new ManualClock();
    clock.advance(1234);
    const ws = createDefaultWorkspace({
      newId: createSequentialIds("n"),
      clock,
      profileId: "pwsh",
    });
    const space = must(ws.spaces[0]);
    expect(space.id).toBe("n1");
    const only = must(space.items["n2"]);
    expect(only.lastActivityAt).toBe(1234);
    expect(only.focusedPaneId).toBe("n3");
    expect(only.layout).toMatchObject({ kind: "pane", pane: { id: "n3", profileId: "pwsh" } });
  });

  it("is deterministic and survives a JSON round trip", () => {
    expect(createDefaultWorkspace()).toEqual(createDefaultWorkspace());
    const ws = createDefaultWorkspace();
    expect(JSON.parse(JSON.stringify(ws))).toEqual(ws);
  });
});

describe("arbWorkspace", () => {
  it("property: 1000 generated workspaces satisfy every invariant", () => {
    fc.assert(
      fc.property(arbWorkspace(), (ws) => {
        expect(checkInvariants(ws)).toEqual([]);
      }),
      { numRuns: 1000 },
    );
  });

  it("property: respects a smaller maxPanes", () => {
    fc.assert(
      fc.property(arbWorkspace({ maxPanes: 2 }), (ws) => {
        expect(checkInvariants(ws, { maxPanes: 2 })).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("covers 2-level groups, pinned items, and splits of 2 to 8 panes", () => {
    const sample = fc.sample(arbWorkspace(), { numRuns: 300, seed: 7 });
    let nestedGroup = false;
    let pinned = false;
    const splitSizes = new Set<number>();
    const countPanes = (layout: LayoutNode): number =>
      layout.kind === "pane" ? 1 : layout.children.reduce((n, c) => n + countPanes(c), 0);
    const hasNested = (nodes: GroupNode["children"]): boolean =>
      nodes.some((n) => n.kind === "group" && n.children.some((c) => c.kind === "group"));
    for (const ws of sample) {
      for (const space of ws.spaces) {
        if (space.pinned.length > 0) pinned = true;
        if (hasNested(space.tree)) nestedGroup = true;
        for (const it of Object.values(space.items)) splitSizes.add(countPanes(it.layout));
      }
    }
    expect(nestedGroup).toBe(true);
    expect(pinned).toBe(true);
    expect([...splitSizes].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("derives ids from a counter, so equal seeds give equal workspaces", () => {
    const a = fc.sample(arbWorkspace(), { numRuns: 20, seed: 11 });
    const b = fc.sample(arbWorkspace(), { numRuns: 20, seed: 11 });
    expect(a).toEqual(b);
  });
});

describe("checkInvariants", () => {
  it("accepts the hand-built fixture", () => {
    expect(checkInvariants(fixture())).toEqual([]);
  });

  it("never throws: input that cannot be walked is reported as malformed", () => {
    for (const bad of [null, undefined, {}, { spaces: 3 }]) {
      const violations = checkInvariants(bad as unknown as Workspace);
      expect(violations.map((v) => v.code)).toEqual(["malformed"]);
    }
  });

  it("duplicate-id: a group reuses the id of an item", () => {
    expect(
      codesAfter((_, space) => {
        must(space.tree[0] as GroupNode).id = "i1";
      }),
    ).toContain("duplicate-id");
  });

  it("duplicate-id: two spaces share an id", () => {
    expect(
      codesAfter((ws, space) => {
        ws.spaces.push({ ...space, items: {}, pinned: [], tree: [] });
      }),
    ).toContain("duplicate-id");
  });

  it("pane-in-multiple-items: the same pane sits in two items", () => {
    expect(
      codesAfter((_, space) => {
        must(space.items["i3"]).layout = leaf(pane("p1"));
        must(space.items["i3"]).focusedPaneId = "p1";
      }),
    ).toContain("pane-in-multiple-items");
  });

  it("pane-in-multiple-items: a closed item keeps a live pane", () => {
    expect(
      codesAfter((ws) => {
        must(ws.closed[0]).item.layout = leaf(pane("p1"));
        must(ws.closed[0]).item.focusedPaneId = "p1";
      }),
    ).toContain("pane-in-multiple-items");
  });

  it("session-shared: two panes use one session", () => {
    expect(
      codesAfter((_, space) => {
        must(space.items["i3"]).layout = leaf(pane("p4", "x1"));
      }),
    ).toContain("session-shared");
  });

  it("active-space-missing", () => {
    expect(
      codesAfter((ws) => {
        ws.activeSpaceId = "nope";
      }),
    ).toContain("active-space-missing");
  });

  it("active-item-missing: the active item is not an item of its space", () => {
    expect(
      codesAfter((_, space) => {
        space.activeItemId = "nope";
      }),
    ).toContain("active-item-missing");
    // A closed item is not an item of the space either.
    expect(
      codesAfter((ws, space) => {
        space.activeItemId = must(ws.closed[0]).item.id;
      }),
    ).toContain("active-item-missing");
  });

  it("accepts a space with no active item and one on a valid item", () => {
    expect(codesAfter(() => undefined)).not.toContain("active-item-missing");
    expect(
      codesAfter((_, space) => {
        space.activeItemId = "i3";
      }),
    ).not.toContain("active-item-missing");
  });

  it("item-key-mismatch: the record key differs from the item id", () => {
    expect(
      codesAfter((_, space) => {
        space.items["other"] = must(space.items["i3"]);
        delete space.items["i3"];
      }),
    ).toContain("item-key-mismatch");
  });

  it("item-unplaced: an item is neither pinned nor in the tree", () => {
    expect(
      codesAfter((_, space) => {
        space.pinned = [];
      }),
    ).toContain("item-unplaced");
  });

  it("item-duplicated: an item is pinned and in the tree", () => {
    expect(
      codesAfter((_, space) => {
        space.pinned.push("i2");
      }),
    ).toContain("item-duplicated");
  });

  it("item-duplicated: an item appears twice in the tree", () => {
    expect(
      codesAfter((_, space) => {
        space.tree.push({ kind: "item", id: "i1" });
        space.pinned = [];
        space.tree.push({ kind: "item", id: "i1" });
      }),
    ).toContain("item-duplicated");
  });

  it("dangling-reference: the tree points at a missing item", () => {
    expect(
      codesAfter((_, space) => {
        space.tree.push({ kind: "item", id: "ghost" });
      }),
    ).toContain("dangling-reference");
  });

  it("dangling-reference: pinned points at a missing item", () => {
    expect(
      codesAfter((_, space) => {
        space.pinned.push("ghost");
      }),
    ).toContain("dangling-reference");
  });

  it("group-too-deep: a group inside a group inside a group", () => {
    expect(
      codesAfter((_, space) => {
        const inner = must(must(space.tree[0] as GroupNode).children[1] as GroupNode);
        inner.children.push({
          kind: "group",
          id: "g3",
          name: "third",
          color: "red",
          collapsed: false,
          children: [],
        });
      }),
    ).toContain("group-too-deep");
  });

  it("split-too-few-children: a split with one child", () => {
    expect(
      codesAfter((_, space) => {
        const split = must(space.items["i2"]).layout as SplitNode;
        split.children = [must(split.children[0])];
        split.sizes = [100];
      }),
    ).toContain("split-too-few-children");
  });

  it("split-too-many-panes: nine panes with the default of eight", () => {
    const codes = codesAfter((_, space) => {
      const split = must(space.items["i2"]).layout as SplitNode;
      split.children.push(
        ...["p7", "p8", "p9", "p10", "p11", "p12", "p13"].map((id) => leaf(pane(id))),
      );
      split.sizes = [12, 11, 11, 11, 11, 11, 11, 11, 11];
    });
    expect(codes).toContain("split-too-many-panes");
    expect(codes).not.toContain("split-sizes-sum");
  });

  it("split-too-many-panes: maxPanes can be lowered", () => {
    const codes = checkInvariants(fixture(), { maxPanes: 1 }).map((v) => v.code);
    expect(codes).toContain("split-too-many-panes");
  });

  it("split-sizes-length: sizes and children differ in length", () => {
    expect(
      codesAfter((_, space) => {
        (must(space.items["i2"]).layout as SplitNode).sizes = [100];
      }),
    ).toContain("split-sizes-length");
  });

  it("split-size-not-positive: a zero size", () => {
    expect(
      codesAfter((_, space) => {
        (must(space.items["i2"]).layout as SplitNode).sizes = [0, 100];
      }),
    ).toContain("split-size-not-positive");
  });

  it("split-sizes-sum: sizes do not sum to 100", () => {
    expect(
      codesAfter((_, space) => {
        (must(space.items["i2"]).layout as SplitNode).sizes = [40, 50];
      }),
    ).toContain("split-sizes-sum");
  });

  it("split sizes tolerate floating-point error but not more than the declared slack", () => {
    const withSizes = (sizes: number[]): ViolationCode[] =>
      codesAfter((_, space) => {
        (must(space.items["i2"]).layout as SplitNode).sizes = sizes;
      });
    expect(withSizes([100 / 3, 100 - 100 / 3])).toEqual([]);
    expect(withSizes([40, 60 + SIZE_SUM_TOLERANCE / 2])).toEqual([]);
    expect(withSizes([40, 60 + SIZE_SUM_TOLERANCE * 10])).toContain("split-sizes-sum");
  });

  it("focused-pane-missing: the focus points outside the item", () => {
    expect(
      codesAfter((_, space) => {
        must(space.items["i2"]).focusedPaneId = "p1";
      }),
    ).toContain("focused-pane-missing");
  });

  it("zoomed-pane-missing: the zoom points outside the item", () => {
    expect(
      codesAfter((_, space) => {
        must(space.items["i2"]).zoomedPaneId = "p1";
      }),
    ).toContain("zoomed-pane-missing");
  });

  it("accepts a zoomed pane that belongs to the item", () => {
    expect(
      codesAfter((_, space) => {
        must(space.items["i2"]).zoomedPaneId = "p3";
      }),
    ).toEqual([]);
  });

  it("favorite-missing: a favorite is not an item of any space", () => {
    expect(
      codesAfter((ws) => {
        ws.favorites.push("ghost");
      }),
    ).toContain("favorite-missing");
  });

  it("favorite-duplicate: an item is favorited twice", () => {
    expect(
      codesAfter((ws) => {
        ws.favorites.push("i1");
      }),
    ).toContain("favorite-duplicate");
  });

  it("accepts the profiles and actions of the bar when each is well formed and once", () => {
    expect(
      codesAfter((ws) => {
        ws.favoriteLinks = [
          { kind: "profile", profileId: "pwsh", label: "PowerShell" },
          { kind: "action", spaceId: "s1", actionId: "build", label: "Build" },
          { kind: "action", spaceId: "s1", actionId: "test", label: "Test" },
        ];
      }),
    ).toEqual([]);
  });

  it("favorite-link-invalid: a link with no name, no id, or an action of a space that is not there", () => {
    const codes = (link: FavoriteLink) =>
      codesAfter((ws) => {
        ws.favoriteLinks = [link];
      });
    expect(codes({ kind: "profile", profileId: "pwsh", label: "" })).toContain(
      "favorite-link-invalid",
    );
    expect(codes({ kind: "profile", profileId: " ", label: "x" })).toContain(
      "favorite-link-invalid",
    );
    expect(codes({ kind: "action", spaceId: "s1", actionId: "", label: "x" })).toContain(
      "favorite-link-invalid",
    );
    expect(codes({ kind: "action", spaceId: "ghost", actionId: "a", label: "x" })).toContain(
      "favorite-link-invalid",
    );
  });

  it("favorite-link-duplicate: the same profile, or the same action of a space, listed twice", () => {
    const profile: FavoriteLink = { kind: "profile", profileId: "pwsh", label: "PowerShell" };
    expect(
      codesAfter((ws) => {
        ws.favoriteLinks = [profile, { ...profile, label: "Another name" }];
      }),
    ).toContain("favorite-link-duplicate");
  });

  it("closed-overflow: 51 closed items", () => {
    const codes = codesAfter((ws) => {
      ws.closed = Array.from({ length: MAX_CLOSED + 1 }, (_, n) => ({
        item: item(`c${n}`, leaf(pane(`cp${n}`)), `cp${n}`),
        spaceId: "s1",
        closedAt: n,
      }));
    });
    expect(codes).toEqual(["closed-overflow"]);
  });

  it("accepts exactly 50 closed items", () => {
    expect(
      codesAfter((ws) => {
        ws.closed = Array.from({ length: MAX_CLOSED }, (_, n) => ({
          item: item(`c${n}`, leaf(pane(`cp${n}`)), `cp${n}`),
          spaceId: "s1",
          closedAt: n,
        }));
      }),
    ).toEqual([]);
  });
});

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbWorkspace } from "./arbitraries";
import {
  DEFAULT_PROFILE_ID,
  createBrowserPane,
  createDiffPane,
  createEmptySpace,
  createPane,
  createPreviewPane,
  createTab,
} from "./factories";
import { checkInvariants } from "./invariants";
import { reduce } from "./reducer";
import { restoreWorkspace } from "./restore";
import { FakeBackend } from "./fake-backend";
import { layoutPanes, liveSessionIds } from "./sessions";
import { parseState, serializeWorkspace, workspaceWithoutSessions } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import { MAX_EXTRA_WINDOWS } from "./types";
import type { Item, Pane, Space, Workspace } from "./types";
import { windowCanShowTab, windowShowing } from "./windows";

// A tab dragged out of the window makes a space and a window of its own and goes in, in one step
// (`window/open-with-item`); closing that window gives the tabs back (`window/return`).

/** A space with one tab (item `i<n>`, pane `p<n>`, session `x<n>`) per number given. */
function space(id: string, ...tabs: number[]): Space {
  const base = createEmptySpace(id, `Space ${id}`, { color: "#336699", cwd: `/work/${id}` });
  const items = Object.fromEntries(
    tabs.map((n) => [
      `i${n}`,
      createTab(`i${n}`, { ...createPane(`p${n}`, DEFAULT_PROFILE_ID), sessionId: `x${n}` }, n),
    ]),
  );
  const first = tabs[0];
  return {
    ...base,
    items,
    tree: tabs.map((n) => ({ kind: "item" as const, id: `i${n}` })),
    ...(first !== undefined ? { activeItemId: `i${first}` } : {}),
  };
}

/** Three spaces: A (tabs 1, 2 and 5) shown by the main window, B (tab 3) and C (tab 4). */
function workspace(windows?: Workspace["windows"]): Workspace {
  return {
    version: 2,
    spaces: [space("sA", 1, 2, 5), space("sB", 3), space("sC", 4)],
    activeSpaceId: "sA",
    favorites: [],
    closed: [],
    archive: [],
    ...(windows !== undefined ? { windows } : {}),
  };
}

const spaceOf = (ws: Workspace, id: string): Space | undefined =>
  ws.spaces.find((s) => s.id === id);
const panesOf = (ws: Workspace, spaceId: string, itemId: string): Pane[] => {
  const item = spaceOf(ws, spaceId)?.items[itemId];
  return item === undefined ? [] : layoutPanes(item.layout);
};
const treeOf = (ws: Workspace, id: string): string[] =>
  spaceOf(ws, id)?.tree.map((node) => node.id) ?? [];

describe("window/open-with-item", () => {
  it("makes a space, a window that shows it, and moves the tab in, in one step", () => {
    const { ctx } = testContext();
    const next = applyChecked(workspace(), { type: "window/open-with-item", itemId: "i2" }, ctx);
    // The space is n1 and the window n2: the ids come from the context, once each.
    expect(next.windows).toEqual([{ id: "n2", spaceId: "n1", returnSpaceId: "sA" }]);
    expect(next.spaces.map((s) => s.id)).toEqual(["sA", "sB", "sC", "n1"]);
    expect(Object.keys(spaceOf(next, "n1")?.items ?? {})).toEqual(["i2"]);
    expect(treeOf(next, "n1")).toEqual(["i2"]);
    expect(spaceOf(next, "n1")?.activeItemId).toBe("i2");
    // The tab left its origin, which shows another one; the main window did not change spaces.
    expect(Object.keys(spaceOf(next, "sA")?.items ?? {})).toEqual(["i1", "i5"]);
    expect(next.activeSpaceId).toBe("sA");
  });

  it("names the space after the action, or Window when it gives no name or a blank one", () => {
    const named = applyChecked(workspace(), {
      type: "window/open-with-item",
      itemId: "i2",
      name: "  Build logs ",
    });
    expect(spaceOf(named, "n1")?.name ?? named.spaces.at(-1)?.name).toBe("Build logs");
    for (const name of [undefined, "", "   "]) {
      const next = applyChecked(workspace(), {
        type: "window/open-with-item",
        itemId: "i2",
        ...(name !== undefined ? { name } : {}),
      });
      expect(next.spaces.at(-1)?.name).toBe("Window");
    }
  });

  it("gives the new space the look and the start folder of the space the tab came from", () => {
    const next = applyChecked(workspace(), { type: "window/open-with-item", itemId: "i3" });
    const made = next.spaces.at(-1);
    expect(made?.color).toBe("#336699");
    expect(made?.defaults.cwd).toBe("/work/sB");
    expect(made?.icon).toBe(spaceOf(next, "sB")?.icon);
    expect(made?.pinned).toEqual([]);
  });

  it("keeps every pane and every session of the tab, the same ones, and starts none", () => {
    const ws = workspace();
    const next = applyChecked(ws, { type: "window/open-with-item", itemId: "i2" });
    expect(liveSessionIds(next)).toEqual(liveSessionIds(ws));
    const moved = next.spaces.at(-1)?.items["i2"];
    expect(moved && layoutPanes(moved.layout).map((p) => [p.id, p.sessionId])).toEqual([
      ["p2", "x2"],
    ]);
  });

  it("a pinned tab stays pinned in the window", () => {
    const ws: Workspace = {
      ...workspace(),
      spaces: [
        { ...space("sA", 1, 2, 5), pinned: ["i1"], tree: space("sA", 2, 5).tree },
        space("sB", 3),
        space("sC", 4),
      ],
    };
    const next = applyChecked(ws, { type: "window/open-with-item", itemId: "i1" });
    expect(next.spaces.at(-1)?.pinned).toEqual(["i1"]);
    expect(next.spaces.at(-1)?.tree).toEqual([]);
  });

  it("works from a tab in the space another window shows, and leaves that window valid", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB", returnSpaceId: "sA" }]);
    const next = applyChecked(ws, { type: "window/open-with-item", itemId: "i3" });
    expect(next.windows?.map((w) => w.id)).toEqual(["w1", "n2"]);
    expect(next.windows?.[1]?.returnSpaceId).toBe("sB");
    expect(windowShowing(next, "sB")?.id).toBe("w1");
    expect(spaceOf(next, "sB")?.items).toEqual({});
  });

  it("changes nothing for a tab that does not exist or a full house", () => {
    const ws = workspace();
    expect(applyChecked(ws, { type: "window/open-with-item", itemId: "nope" })).toBe(ws);
    const full: Workspace = {
      ...ws,
      windows: Array.from({ length: MAX_EXTRA_WINDOWS }, (_, n) => ({
        id: `w${n}`,
        spaceId: "sB",
      })),
    };
    // (Not valid as a workspace, which is the point: the action does not get past the limit.)
    expect(reduce(full, { type: "window/open-with-item", itemId: "i2" }, testContext().ctx)).toBe(
      full,
    );
  });
});

/** The tabs a window draws besides terminals, in space A: a preview alone, a diff alone and a split of three. */
function withPanes(windows?: Workspace["windows"]): Workspace {
  const preview = createTab("ip", createPreviewPane("pp", "/work/sA/notes.md"), 9);
  const diff = createTab("id", createDiffPane("pd", "/work/sA"), 10);
  const terminal: Pane = { ...createPane("pt", DEFAULT_PROFILE_ID), sessionId: "xt" };
  const mixed: Item = {
    ...createTab("im", terminal, 11),
    layout: {
      kind: "split",
      dir: "row",
      sizes: [34, 33, 33],
      children: [
        { kind: "pane", pane: terminal },
        { kind: "pane", pane: createPreviewPane("pm", "/work/sA/README.md") },
        { kind: "pane", pane: createDiffPane("pn", "/work/sA") },
      ],
    },
  };
  const base = workspace(windows);
  const sA = space("sA", 1, 2, 5);
  return {
    ...base,
    spaces: [
      {
        ...sA,
        items: { ...sA.items, ip: preview, id: diff, im: mixed },
        tree: [...sA.tree, ...["ip", "id", "im"].map((id) => ({ kind: "item" as const, id }))],
      },
      ...base.spaces.slice(1),
    ],
  };
}

describe("a tab with a preview or a diff pane (NOR-F15-04d)", () => {
  it("can be shown by a window", () => {
    const ws = withPanes();
    const items = ws.spaces[0]?.items ?? {};
    for (const id of ["ip", "id", "im"]) {
      const item = items[id];
      expect(item && windowCanShowTab(item)).toBe(true);
    }
  });

  it("window/open-with-item takes it to a window of its own with its panes as they are", () => {
    const ws = withPanes();
    for (const itemId of ["ip", "id", "im"]) {
      const next = applyChecked(ws, { type: "window/open-with-item", itemId });
      const made = next.spaces.at(-1);
      expect(Object.keys(made?.items ?? {})).toEqual([itemId]);
      expect(made?.items[itemId]).toEqual(ws.spaces[0]?.items[itemId]);
      expect(next.windows).toHaveLength(1);
      expect(Object.hasOwn(spaceOf(next, "sA")?.items ?? {}, itemId)).toBe(false);
    }
  });

  it("window/move-item takes it into the space of a window", () => {
    const ws = withPanes([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, { type: "window/move-item", itemId: "id", windowId: "w1" });
    expect(Object.keys(spaceOf(next, "sB")?.items ?? {})).toEqual(["i3", "id"]);
    expect(spaceOf(next, "sB")?.activeItemId).toBe("id");
    expect(spaceOf(next, "sB")?.items["id"]).toEqual(ws.spaces[0]?.items["id"]);
  });

  it("window/return gives it back to the space it came from, panes unchanged", () => {
    const ws = withPanes();
    const out = applyChecked(ws, { type: "window/open-with-item", itemId: "im" });
    // (Without this the test would pass when the tab never left, since there would be nothing to return.)
    expect(out.windows).toHaveLength(1);
    expect(spaceOf(out, "sA")?.items["im"]).toBeUndefined();
    const windowId = out.windows?.[0]?.id ?? "";
    const back = applyChecked(out, { type: "window/return", windowId });
    expect(back.windows).toBeUndefined();
    expect(spaceOf(back, "sA")?.items["im"]).toEqual(ws.spaces[0]?.items["im"]);
    expect(liveSessionIds(back)).toEqual(liveSessionIds(ws));
  });

  it("closing the window takes the actions of its space out of the Favorites bar, and keeps the profiles", () => {
    const out = applyChecked(withPanes(), { type: "window/open-with-item", itemId: "im" });
    const windowSpace = out.windows?.[0]?.spaceId ?? "";
    const windowId = out.windows?.[0]?.id ?? "";
    expect(spaceOf(out, windowSpace)).toBeDefined();
    const marked = [
      { kind: "profile", profileId: "pwsh", label: "PowerShell" } as const,
      { kind: "action", spaceId: windowSpace, actionId: "dev", label: "Dev" } as const,
      { kind: "action", spaceId: "sA", actionId: "dev", label: "Dev" } as const,
    ].reduce((ws, link) => applyChecked(ws, { type: "favorite/add-link", link }), out);
    expect(marked.favoriteLinks).toHaveLength(3);
    const back = applyChecked(marked, { type: "window/return", windowId });
    // The space made for the window goes away with it, and so does the tile of its action.
    expect(spaceOf(back, windowSpace)).toBeUndefined();
    expect(back.favoriteLinks?.map((link) => link.kind)).toEqual(["profile", "action"]);
    expect(back.favoriteLinks?.[1]).toMatchObject({ spaceId: "sA" });
  });
});

/** The tabs with a browser pane, in space A: alone, beside a terminal, and beside a terminal and a preview. */
function withBrowsers(windows?: Workspace["windows"]): Workspace {
  const alone = createTab("ib", createBrowserPane("pb", "https://example.com/"), 9);
  const shell = (n: number): Pane => ({
    ...createPane(`pt${n}`, DEFAULT_PROFILE_ID),
    sessionId: `xt${n}`,
  });
  const [first, second] = [shell(1), shell(2)] as const;
  const beside: Item = {
    ...createTab("iw", first, 10),
    layout: {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [
        { kind: "pane", pane: first },
        { kind: "pane", pane: createBrowserPane("pz", "https://example.org/docs") },
      ],
    },
  };
  const mixed: Item = {
    ...createTab("ix", second, 11),
    layout: {
      kind: "split",
      dir: "row",
      sizes: [34, 33, 33],
      children: [
        { kind: "pane", pane: second },
        { kind: "pane", pane: createPreviewPane("pm", "/work/sA/README.md") },
        { kind: "pane", pane: createBrowserPane("py", "http://localhost:3000/") },
      ],
    },
  };
  const base = workspace(windows);
  const sA = space("sA", 1, 2, 5);
  return {
    ...base,
    spaces: [
      {
        ...sA,
        items: { ...sA.items, ib: alone, iw: beside, ix: mixed },
        tree: [...sA.tree, ...["ib", "iw", "ix"].map((id) => ({ kind: "item" as const, id }))],
      },
      ...base.spaces.slice(1),
    ],
  };
}

describe("a tab with a browser pane (NOR-F15-04e)", () => {
  it("can be shown by a window, alone or beside other panes", () => {
    const items = withBrowsers().spaces[0]?.items ?? {};
    for (const id of ["ib", "iw", "ix"]) {
      const item = items[id];
      expect(item && windowCanShowTab(item)).toBe(true);
    }
  });

  it("window/open-with-item takes it to a window of its own with its panes as they are", () => {
    const ws = withBrowsers();
    for (const itemId of ["ib", "iw", "ix"]) {
      const next = applyChecked(ws, { type: "window/open-with-item", itemId });
      const made = next.spaces.at(-1);
      expect(Object.keys(made?.items ?? {})).toEqual([itemId]);
      expect(made?.items[itemId]).toEqual(ws.spaces[0]?.items[itemId]);
      expect(next.windows).toHaveLength(1);
      expect(Object.hasOwn(spaceOf(next, "sA")?.items ?? {}, itemId)).toBe(false);
      // The address of the pane is the one the web view will be opened at.
      const urls = panesOf(next, made?.id ?? "", itemId)
        .filter((pane) => pane.type === "browser")
        .map((pane) => pane.url);
      expect(urls).toHaveLength(1);
    }
  });

  it("window/move-item takes it into the space of a window", () => {
    const ws = withBrowsers([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, { type: "window/move-item", itemId: "ib", windowId: "w1" });
    expect(Object.keys(spaceOf(next, "sB")?.items ?? {})).toEqual(["i3", "ib"]);
    expect(spaceOf(next, "sB")?.activeItemId).toBe("ib");
    expect(spaceOf(next, "sB")?.items["ib"]).toEqual(ws.spaces[0]?.items["ib"]);
    expect(Object.hasOwn(spaceOf(next, "sA")?.items ?? {}, "ib")).toBe(false);
  });

  it("window/return gives it back to the space it came from, panes unchanged", () => {
    const ws = withBrowsers();
    for (const itemId of ["ib", "iw", "ix"]) {
      const out = applyChecked(ws, { type: "window/open-with-item", itemId });
      // (Without this the test would pass when the tab never left, since there would be nothing to return.)
      expect(out.windows).toHaveLength(1);
      expect(spaceOf(out, "sA")?.items[itemId]).toBeUndefined();
      const windowId = out.windows?.[0]?.id ?? "";
      const back = applyChecked(out, { type: "window/return", windowId });
      expect(back.windows).toBeUndefined();
      expect(spaceOf(back, "sA")?.items[itemId]).toEqual(ws.spaces[0]?.items[itemId]);
      expect(liveSessionIds(back)).toEqual(liveSessionIds(ws));
    }
  });

  it("changes its address in the space of the window, where the main window no longer draws it", () => {
    const ws = withBrowsers();
    const out = applyChecked(ws, { type: "window/open-with-item", itemId: "ib" });
    const next = applyChecked(out, {
      type: "pane/set-url",
      itemId: "ib",
      paneId: "pb",
      url: "https://example.net/next",
    });
    const made = next.spaces.at(-1);
    expect(panesOf(next, made?.id ?? "", "ib")[0]?.url).toBe("https://example.net/next");
    // And it comes back to the main window with the address it has now.
    const back = applyChecked(next, {
      type: "window/return",
      windowId: out.windows?.[0]?.id ?? "",
    });
    expect(panesOf(back, "sA", "ib")[0]?.url).toBe("https://example.net/next");
  });
});

describe("window/open-with-item (saved)", () => {
  it("is saved with the window and comes back with it", async () => {
    const next = applyChecked(workspace(), { type: "window/open-with-item", itemId: "i2" });
    const text = serializeWorkspace(workspaceWithoutSessions(next));
    const read = parseState(text);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.workspace.windows).toEqual(next.windows);
    const backend = new FakeBackend({ state: text });
    const restored = await restoreWorkspace(backend);
    expect(restored.workspace.windows).toEqual(next.windows);
    // A shell started for every pane of every space, those of the window's space included.
    const window = restored.workspace.spaces.find((s) => s.id === next.windows?.[0]?.spaceId);
    const panes = Object.values(window?.items ?? {}).flatMap((item) => layoutPanes(item.layout));
    expect(panes).toHaveLength(1);
    expect(panes.every((p) => p.sessionId !== undefined)).toBe(true);
  });
});

describe("window/return", () => {
  const dragged = (itemId = "i2"): Workspace =>
    applyChecked(workspace(), { type: "window/open-with-item", itemId });
  const windowId = (ws: Workspace): string => ws.windows?.[0]?.id ?? "none";

  it("gives the tab back to the space it came from and takes the space made for the window away", () => {
    const out = dragged("i5");
    const next = applyChecked(out, { type: "window/return", windowId: windowId(out) });
    expect(next.windows).toBeUndefined();
    expect("windows" in next).toBe(false);
    expect(next.spaces.map((s) => s.id)).toEqual(["sA", "sB", "sC"]);
    expect(treeOf(next, "sA")).toEqual(["i1", "i2", "i5"]);
    expect(liveSessionIds(next)).toEqual(liveSessionIds(workspace()));
  });

  it("a tab that was the last of its space and the one it showed comes back to the same place", () => {
    const out = applyChecked(workspace(), { type: "window/open-with-item", itemId: "i3" });
    expect(spaceOf(out, "sB")?.items).toEqual({});
    const back = applyChecked(out, { type: "window/return", windowId: windowId(out) });
    expect(back).toEqual(workspace());
  });

  it("the tab comes back at the end of the tree, and a pinned one comes back pinned", () => {
    const ws: Workspace = {
      ...workspace(),
      spaces: [
        { ...space("sA", 1, 2, 5), pinned: ["i1"], tree: space("sA", 2, 5).tree },
        space("sB", 3),
        space("sC", 4),
      ],
    };
    const first = applyChecked(ws, { type: "window/open-with-item", itemId: "i1" });
    const back = applyChecked(first, { type: "window/return", windowId: windowId(first) });
    expect(spaceOf(back, "sA")?.pinned).toEqual(["i1"]);
    const second = applyChecked(ws, { type: "window/open-with-item", itemId: "i2" });
    const again = applyChecked(second, { type: "window/return", windowId: windowId(second) });
    expect(treeOf(again, "sA")).toEqual(["i5", "i2"]);
  });

  it("gives back every tab the window holds, in the order it shows them", () => {
    const out = dragged("i2");
    const id = windowId(out);
    const more = applyChecked(out, { type: "window/move-item", itemId: "i5", windowId: id });
    expect(treeOf(more, more.windows?.[0]?.spaceId ?? "")).toEqual(["i2", "i5"]);
    const back = applyChecked(more, { type: "window/return", windowId: id });
    expect(treeOf(back, "sA")).toEqual(["i1", "i2", "i5"]);
    // The main window shows the tab the window showed (the last one that arrived).
    expect(spaceOf(back, "sA")?.activeItemId).toBe("i5");
    expect(back.spaces).toHaveLength(3);
  });

  it("goes to the space the main window shows when the origin is another window's, or is gone", () => {
    // The origin sA is shown by w1 now, and the main window shows sB.
    const ws: Workspace = {
      ...workspace([
        { id: "w1", spaceId: "sA" },
        { id: "w2", spaceId: "sC", returnSpaceId: "sA" },
      ]),
      activeSpaceId: "sB",
    };
    const next = applyChecked(ws, { type: "window/return", windowId: "w2" });
    expect(treeOf(next, "sB")).toEqual(["i3", "i4"]);
    expect(next.windows).toEqual([{ id: "w1", spaceId: "sA" }]);
    // The origin does not exist any more.
    const lost: Workspace = {
      ...workspace([{ id: "w2", spaceId: "sC", returnSpaceId: "gone" }]),
    };
    const there = applyChecked(lost, { type: "window/return", windowId: "w2" });
    expect(treeOf(there, "sA")).toEqual(["i1", "i2", "i5", "i4"]);
    expect(there.spaces.map((s) => s.id)).toEqual(["sA", "sB"]);
  });

  it("leaves the main window on the tab it shows when the tabs go to a space it does not show", () => {
    const ws: Workspace = {
      ...workspace([{ id: "w1", spaceId: "sC", returnSpaceId: "sB" }]),
    };
    const next = applyChecked(ws, { type: "window/return", windowId: "w1" });
    expect(treeOf(next, "sB")).toEqual(["i3", "i4"]);
    expect(spaceOf(next, "sB")?.activeItemId).toBe("i3");
    expect(next.activeSpaceId).toBe("sA");
  });

  it("a window that was always on a space of the user keeps the space, as window/close does", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, { type: "window/return", windowId: "w1" });
    expect(next).toEqual(applyChecked(ws, { type: "window/close", windowId: "w1" }));
    expect(treeOf(next, "sB")).toEqual(["i3"]);
  });

  it("changes nothing for a window that does not exist", () => {
    const ws = dragged();
    expect(applyChecked(ws, { type: "window/return", windowId: "nope" })).toBe(ws);
    const bare = workspace();
    expect(applyChecked(bare, { type: "window/return", windowId: "w1" })).toBe(bare);
  });

  it("leaves no window on a space that went away with it, other windows untouched", () => {
    const first = dragged("i2");
    const second = applyChecked(first, { type: "window/open-with-item", itemId: "i5" });
    expect(second.windows).toHaveLength(2);
    const next = applyChecked(second, {
      type: "window/return",
      windowId: first.windows?.[0]?.id ?? "",
    });
    expect(next.windows).toEqual([second.windows?.[1]]);
    expect(checkInvariants(next)).toEqual([]);
  });
});

describe("property: dragging tabs out and closing their windows", () => {
  it("any sequence of drags and returns keeps the invariants and every session", () => {
    fc.assert(
      fc.property(
        arbWorkspace({ windows: true }),
        fc.array(fc.tuple(fc.boolean(), fc.nat(40)), { maxLength: 30 }),
        (start, steps) => {
          const { ctx } = testContext();
          let ws = start;
          const sessions = [...liveSessionIds(start)].sort();
          for (const [drag, pick] of steps) {
            if (drag) {
              const items = ws.spaces.flatMap((s) => Object.keys(s.items));
              const itemId = items[pick % Math.max(items.length, 1)];
              if (itemId !== undefined) {
                ws = reduce(ws, { type: "window/open-with-item", itemId }, ctx);
              }
            } else {
              const windows = ws.windows ?? [];
              const id = windows[pick % Math.max(windows.length, 1)]?.id;
              if (id !== undefined) ws = reduce(ws, { type: "window/return", windowId: id }, ctx);
            }
            expect(checkInvariants(ws)).toEqual([]);
            expect([...liveSessionIds(ws)].sort()).toEqual(sessions);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

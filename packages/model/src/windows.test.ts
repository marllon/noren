import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbWorkspace } from "./arbitraries";
import { DEFAULT_PROFILE_ID, createEmptySpace, createPane, createTab } from "./factories";
import { FakeBackend } from "./fake-backend";
import { createSequentialIds } from "./ids";
import { checkInvariants } from "./invariants";
import type { Violation } from "./invariants";
import { reduce } from "./reducer";
import { restoreWorkspace } from "./restore";
import { layoutPanes, liveSessionIds } from "./sessions";
import { parseState, serializeWorkspace, workspaceWithoutSessions } from "./state";
import { applyChecked, testContext } from "./test-helpers";
import { MAX_EXTRA_WINDOWS } from "./types";
import type { Space, Workspace } from "./types";
import { isPaneVisible } from "./unread";
import {
  WINDOW_LABEL_PREFIX,
  canOpenWindow,
  findWindow,
  isWindowId,
  spaceIsShown,
  windowIdOfLabel,
  windowLabel,
  windowShowing,
  workspaceWindows,
} from "./windows";

/** A space with one tab (item `i<n>`, pane `p<n>`, session `x<n>`) per number given. */
function space(id: string, ...tabs: number[]): Space {
  const base = createEmptySpace(id, `Space ${id}`);
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

/** Three spaces: A (tabs 1 and 2) shown by the main window, B (tab 3) and C (tab 4). */
function workspace(windows?: Workspace["windows"]): Workspace {
  return {
    version: 2,
    spaces: [space("sA", 1, 2), space("sB", 3), space("sC", 4)],
    activeSpaceId: "sA",
    favorites: [],
    closed: [],
    archive: [],
    ...(windows !== undefined ? { windows } : {}),
  };
}

const codes = (violations: Violation[]): string[] => violations.map((v) => v.code);

describe("window ids and labels", () => {
  it("accepts the names a native window can have and nothing else", () => {
    for (const id of [
      "w1",
      "main",
      "3f2b9c1e-7d4a-4b6e-9a51-0c2d8e7f1a33",
      "A_b-9",
      "x".repeat(64),
    ]) {
      expect(isWindowId(id), id).toBe(true);
    }
    for (const id of ["", " ", "a b", "a/b", "a:b", "é", "x".repeat(65), "w*", "../w", "w\n"]) {
      expect(isWindowId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it("property: the label of a window names it back, and no other label does", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u), (id) => {
        const label = windowLabel(id);
        expect(label.startsWith(WINDOW_LABEL_PREFIX)).toBe(true);
        expect(windowIdOfLabel(label)).toBe(id);
      }),
    );
    for (const label of [
      "main",
      "quick",
      "browser-p1",
      "window-",
      "window-a b",
      "window-é",
      "windows-w1",
    ]) {
      expect(windowIdOfLabel(label), label).toBeUndefined();
    }
  });

  it("never makes a label that is the web view of a browser pane, the main window or the quick one", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const label = windowLabel(id);
        expect(label.startsWith("browser-")).toBe(false);
        expect(label).not.toBe("main");
        expect(label).not.toBe("quick");
      }),
    );
  });
});

describe("which window shows a space", () => {
  it("the main window shows the active space and a window shows its own", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    expect(spaceIsShown(ws, "sA")).toBe(true);
    expect(spaceIsShown(ws, "sB")).toBe(true);
    expect(spaceIsShown(ws, "sC")).toBe(false);
    expect(windowShowing(ws, "sB")?.id).toBe("w1");
    expect(windowShowing(ws, "sA")).toBeUndefined();
    expect(findWindow(ws, "w1")?.spaceId).toBe("sB");
    expect(findWindow(ws, "nope")).toBeUndefined();
  });

  it("a workspace without windows has none and takes more", () => {
    const ws = workspace();
    expect(workspaceWindows(ws)).toEqual([]);
    expect(canOpenWindow(ws)).toBe(true);
    const full = {
      ...ws,
      windows: Array.from({ length: MAX_EXTRA_WINDOWS }, (_, n) => ({
        id: `w${n}`,
        spaceId: "sB",
      })),
    };
    expect(canOpenWindow(full)).toBe(false);
  });

  it("a pane in the tab a window shows is on screen, and one in a space nobody shows is not", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    expect(isPaneVisible(ws, "sA", "i1", "p1")).toBe(true);
    expect(isPaneVisible(ws, "sA", "i2", "p2")).toBe(false);
    expect(isPaneVisible(ws, "sB", "i3", "p3")).toBe(true);
    expect(isPaneVisible(ws, "sC", "i4", "p4")).toBe(false);
    expect(isPaneVisible(workspace(), "sB", "i3", "p3")).toBe(false);
  });
});

describe("invariants of the windows", () => {
  it("a workspace with windows on spaces nobody else shows is valid", () => {
    expect(
      checkInvariants(
        workspace([
          { id: "w1", spaceId: "sB" },
          { id: "w2", spaceId: "sC" },
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses a window whose space is not one", () => {
    expect(codes(checkInvariants(workspace([{ id: "w1", spaceId: "gone" }])))).toEqual([
      "window-space-missing",
    ]);
  });

  it("refuses a space shown twice: by the main window and a window, or by two windows", () => {
    expect(codes(checkInvariants(workspace([{ id: "w1", spaceId: "sA" }])))).toEqual([
      "window-space-shared",
    ]);
    expect(
      codes(
        checkInvariants(
          workspace([
            { id: "w1", spaceId: "sB" },
            { id: "w2", spaceId: "sB" },
          ]),
        ),
      ),
    ).toEqual(["window-space-shared"]);
  });

  it("refuses an id that cannot name a window, and an id the workspace uses already", () => {
    expect(codes(checkInvariants(workspace([{ id: "a b", spaceId: "sB" }])))).toEqual([
      "window-id-invalid",
    ]);
    expect(codes(checkInvariants(workspace([{ id: "", spaceId: "sB" }])))).toContain(
      "window-id-invalid",
    );
    // The id of a space, of an item, and of another window.
    expect(codes(checkInvariants(workspace([{ id: "sC", spaceId: "sB" }])))).toEqual([
      "duplicate-id",
    ]);
    expect(codes(checkInvariants(workspace([{ id: "i1", spaceId: "sB" }])))).toEqual([
      "duplicate-id",
    ]);
    expect(
      codes(
        checkInvariants(
          workspace([
            { id: "w1", spaceId: "sB" },
            { id: "w1", spaceId: "sC" },
          ]),
        ),
      ),
    ).toEqual(["duplicate-id"]);
  });

  it("refuses more windows than the limit", () => {
    const many = Array.from({ length: MAX_EXTRA_WINDOWS + 1 }, (_, n) => ({
      id: `w${n}`,
      spaceId: `s${n}`,
    }));
    const ws: Workspace = {
      ...workspace(many),
      spaces: many.map((w) => space(w.spaceId, 100 + Number(w.id.slice(1)))).concat(space("sA", 1)),
      activeSpaceId: "sA",
    };
    expect(codes(checkInvariants(ws))).toEqual(["window-overflow"]);
  });
});

describe("state.json with windows", () => {
  const windows = [
    { id: "w1", spaceId: "sB" },
    { id: "w2", spaceId: "sC" },
  ];

  it("keeps the windows through a save and a read, sessions left out", () => {
    const ws = workspace(windows);
    const text = serializeWorkspace(ws);
    expect(JSON.parse(text).windows).toEqual(windows);
    const parsed = parseState(text);
    expect(parsed).toEqual({ ok: true, workspace: workspaceWithoutSessions(ws) });
    expect(parsed.ok && parsed.workspace.windows).toEqual(windows);
  });

  it("reads a state saved before windows existed, and writes none for a workspace without", () => {
    const text = serializeWorkspace(workspace());
    expect("windows" in JSON.parse(text)).toBe(false);
    const parsed = parseState(text);
    expect(parsed.ok && parsed.workspace.windows).toBeUndefined();
  });

  it("refuses a windows entry that is not a list of ids and spaces", () => {
    const base = JSON.parse(serializeWorkspace(workspace(windows))) as Record<string, unknown>;
    for (const bad of [
      {},
      "w1",
      [1],
      [{ id: "w1" }],
      [{ spaceId: "sB" }],
      [null],
      [["w1", "sB"]],
    ]) {
      const parsed = parseState(JSON.stringify({ ...base, windows: bad }));
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("windows");
    }
  });

  it("refuses a file whose windows break the invariants, naming the code", () => {
    const base = JSON.parse(serializeWorkspace(workspace(windows))) as Record<string, unknown>;
    const parsed = parseState(JSON.stringify({ ...base, windows: [{ id: "w1", spaceId: "sA" }] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("window-space-shared at windows[0]");
  });

  it("property: any workspace with windows survives a save and a read unchanged", () => {
    let seen = 0;
    fc.assert(
      fc.property(arbWorkspace({ windows: true }), (ws) => {
        if (workspaceWindows(ws).length > 0) seen++;
        expect(checkInvariants(ws)).toEqual([]);
        const parsed = parseState(serializeWorkspace(ws));
        expect(parsed.ok && parsed.workspace).toEqual(workspaceWithoutSessions(ws));
      }),
      { numRuns: 100 },
    );
    expect(seen).toBeGreaterThan(0);
  });

  it("restores the windows as they were saved and starts a shell for every pane of every space", async () => {
    const backend = new FakeBackend({ state: serializeWorkspace(workspace(windows)) });
    const restored = await restoreWorkspace(backend);
    expect(restored.source).toBe("saved");
    expect(restored.workspace.windows).toEqual(windows);
    expect(checkInvariants(restored.workspace)).toEqual([]);
    // Four tabs in three spaces: the owner starts the shell of the ones a window shows too, and
    // hands them over to the window afterwards (`moveTabToWindow`).
    const panes = restored.workspace.spaces.flatMap((s) =>
      Object.values(s.items).flatMap((item) => layoutPanes(item.layout)),
    );
    expect(panes).toHaveLength(4);
    expect(panes.every((p) => p.sessionId !== undefined)).toBe(true);
    expect(backend.callsTo("createSession")).toHaveLength(4);
    // Restoring opens no window by itself: that is for the interface to do from the state.
    expect(backend.callsTo("openWindow")).toHaveLength(0);
    expect(backend.windows()).toEqual([]);
  });

  it("a state with a window broken in the file is quarantined and the default workspace stands", async () => {
    const base = JSON.parse(serializeWorkspace(workspace(windows))) as Record<string, unknown>;
    const backend = new FakeBackend({
      state: JSON.stringify({ ...base, windows: [{ id: "w1", spaceId: "nowhere" }] }),
    });
    const restored = await restoreWorkspace(backend, {
      defaults: { newId: createSequentialIds("d") },
    });
    expect(restored.source).toBe("recovered");
    expect(restored.reason).toContain("window-space-missing");
    expect(restored.workspace.windows).toBeUndefined();
  });
});

describe("window/open", () => {
  it("adds a window on a space nobody shows, with a fresh id", () => {
    const { ctx } = testContext();
    const next = applyChecked(workspace(), { type: "window/open", spaceId: "sB" }, ctx);
    expect(next.windows).toEqual([{ id: "n1", spaceId: "sB" }]);
    const again = applyChecked(next, { type: "window/open", spaceId: "sC" }, ctx);
    expect(again.windows).toEqual([
      { id: "n1", spaceId: "sB" },
      { id: "n2", spaceId: "sC" },
    ]);
  });

  it("changes nothing for a space that is gone, one that is shown already, or a full house", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    expect(applyChecked(ws, { type: "window/open", spaceId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "window/open", spaceId: "sA" })).toBe(ws);
    expect(applyChecked(ws, { type: "window/open", spaceId: "sB" })).toBe(ws);
    const full: Workspace = {
      ...ws,
      windows: Array.from({ length: MAX_EXTRA_WINDOWS }, (_, n) => ({
        id: `w${n}`,
        spaceId: "sB",
      })),
    };
    // (Not valid as a workspace, which is the point: the action does not get past the limit.)
    expect(reduce(full, { type: "window/open", spaceId: "sC" }, testContext().ctx)).toBe(full);
  });

  it("skips an id the workspace uses, and refuses a generator that only makes unusable ids", () => {
    const { ctx } = testContext();
    const taken = ctx.newId;
    const first = taken();
    expect(first).toBe("n1");
    const ws: Workspace = {
      ...workspace(),
      spaces: [space("n2", 1), space("sB", 3)],
      activeSpaceId: "n2",
    };
    const next = applyChecked(ws, { type: "window/open", spaceId: "sB" }, ctx);
    expect(next.windows?.[0]?.id).toBe("n3");
    const odd = reduce(
      workspace(),
      { type: "window/open", spaceId: "sB" },
      {
        ...testContext().ctx,
        newId: () => "not a name",
      },
    );
    expect(odd.windows).toBeUndefined();
  });
});

describe("window/close", () => {
  it("takes the window away and leaves the key out when it was the last", () => {
    const ws = workspace([
      { id: "w1", spaceId: "sB" },
      { id: "w2", spaceId: "sC" },
    ]);
    const one = applyChecked(ws, { type: "window/close", windowId: "w1" });
    expect(one.windows).toEqual([{ id: "w2", spaceId: "sC" }]);
    const none = applyChecked(one, { type: "window/close", windowId: "w2" });
    expect("windows" in none).toBe(false);
    expect(serializeWorkspace(none)).toBe(serializeWorkspace(workspace()));
  });

  it("leaves the tabs of the space where they are", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, { type: "window/close", windowId: "w1" });
    expect(next.spaces).toBe(ws.spaces);
    expect(liveSessionIds(next)).toEqual(liveSessionIds(ws));
  });

  it("changes nothing for a window that does not exist", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    expect(applyChecked(ws, { type: "window/close", windowId: "nope" })).toBe(ws);
    const bare = workspace();
    expect(applyChecked(bare, { type: "window/close", windowId: "w1" })).toBe(bare);
  });
});

describe("window/move-item", () => {
  const ws = workspace([{ id: "w1", spaceId: "sB" }]);

  it("moves the tab into the space of the window and makes it the tab that space shows", () => {
    const next = applyChecked(ws, { type: "window/move-item", itemId: "i2", windowId: "w1" });
    const origin = next.spaces.find((s) => s.id === "sA");
    const target = next.spaces.find((s) => s.id === "sB");
    expect(Object.keys(origin?.items ?? {})).toEqual(["i1"]);
    expect(Object.keys(target?.items ?? {})).toEqual(["i3", "i2"]);
    expect(target?.tree.map((node) => node.id)).toEqual(["i3", "i2"]);
    expect(target?.activeItemId).toBe("i2");
    // The tab that left was not the one the origin showed, which stays.
    expect(origin?.activeItemId).toBe("i1");
  });

  it("gives the origin another tab when the one that left was the one it showed", () => {
    const next = applyChecked(ws, { type: "window/move-item", itemId: "i1", windowId: "w1" });
    expect(next.spaces.find((s) => s.id === "sA")?.activeItemId).toBe("i2");
  });

  it("keeps every pane and every session of the tab, the same ones", () => {
    const next = applyChecked(ws, { type: "window/move-item", itemId: "i2", windowId: "w1" });
    expect(liveSessionIds(next)).toEqual(liveSessionIds(ws));
    const moved = next.spaces.find((s) => s.id === "sB")?.items["i2"];
    expect(moved && layoutPanes(moved.layout).map((p) => [p.id, p.sessionId])).toEqual([
      ["p2", "x2"],
    ]);
  });

  it("puts it where the placement says", () => {
    const next = applyChecked(ws, {
      type: "window/move-item",
      itemId: "i2",
      windowId: "w1",
      placement: { to: "pinned" },
    });
    expect(next.spaces.find((s) => s.id === "sB")?.pinned).toEqual(["i2"]);
  });

  it("changes nothing for a window or a tab that does not exist, or a tab already there", () => {
    expect(applyChecked(ws, { type: "window/move-item", itemId: "i2", windowId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "window/move-item", itemId: "nope", windowId: "w1" })).toBe(ws);
    expect(applyChecked(ws, { type: "window/move-item", itemId: "i3", windowId: "w1" })).toBe(ws);
    expect(
      applyChecked(workspace(), { type: "window/move-item", itemId: "i2", windowId: "w1" }),
    ).toEqual(workspace());
  });

  it("moves the last tab of a space and leaves it empty, with the window still on its space", () => {
    const one = workspace([{ id: "w1", spaceId: "sC" }]);
    const next = applyChecked(one, { type: "window/move-item", itemId: "i3", windowId: "w1" });
    const emptied = next.spaces.find((s) => s.id === "sB");
    expect(emptied?.items).toEqual({});
    expect(emptied?.activeItemId).toBeUndefined();
    expect(next.windows).toEqual(one.windows);
  });
});

describe("the main window and the windows share the spaces", () => {
  it("the main window cannot take the space a window shows", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    expect(applyChecked(ws, { type: "space/activate", spaceId: "sB" })).toBe(ws);
    expect(applyChecked(ws, { type: "space/activate", spaceId: "sC" }).activeSpaceId).toBe("sC");
  });

  it("deleting the space of a window takes the window with it", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, {
      type: "space/delete",
      spaceId: "sB",
      items: { mode: "close" },
    });
    expect(next.windows).toBeUndefined();
    expect(next.spaces.map((s) => s.id)).toEqual(["sA", "sC"]);
  });

  it("deleting the space of the main window gives it a space no window shows", () => {
    // sA is main's; sB (the neighbor that slides in) is a window's: main goes to sC instead.
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, {
      type: "space/delete",
      spaceId: "sA",
      items: { mode: "close" },
    });
    expect(next.activeSpaceId).toBe("sC");
    expect(next.windows).toEqual([{ id: "w1", spaceId: "sB" }]);
  });

  it("when every space is shown by a window the main window takes one and its window goes", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    const two: Workspace = { ...ws, spaces: ws.spaces.slice(0, 2) };
    const next = applyChecked(two, {
      type: "space/delete",
      spaceId: "sA",
      items: { mode: "close" },
    });
    expect(next.activeSpaceId).toBe("sB");
    expect(next.windows).toBeUndefined();
  });

  it("merging a space into the one a window shows keeps the window", () => {
    const ws = workspace([{ id: "w1", spaceId: "sB" }]);
    const next = applyChecked(ws, {
      type: "space/delete",
      spaceId: "sC",
      items: { mode: "move", targetSpaceId: "sB" },
    });
    expect(next.windows).toEqual([{ id: "w1", spaceId: "sB" }]);
    expect(Object.keys(next.spaces.find((s) => s.id === "sB")?.items ?? {}).sort()).toEqual([
      "i3",
      "i4",
    ]);
  });

  it("a workspace without windows reduces exactly as before", () => {
    const next = applyChecked(workspace(), { type: "space/activate", spaceId: "sB" });
    expect(next.activeSpaceId).toBe("sB");
    expect("windows" in next).toBe(false);
  });
});

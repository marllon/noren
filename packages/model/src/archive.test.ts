import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_CHECK_INTERVAL_MS,
  DEFAULT_ARCHIVE_AFTER_HOURS,
  archiveSettingsOf,
  idleItems,
  itemInUse,
} from "./archive";
import { arbWorkspace } from "./arbitraries";
import { createEmptySpace, createPane, createTab } from "./factories";
import type { Pane, Workspace } from "./types";

// Which open items the auto-archive would put away: pure, with the moment handed in.

const HOUR = 3_600_000;

const withPane = (id: string, changes: Partial<Pane>, lastActivityAt: number) =>
  createTab(id, { ...createPane(`p-${id}`, "bash", "/home"), ...changes }, lastActivityAt);

/**
 * s1: pinned [pin]; tree [idle, busy, fresh, fav, unread, bell, shown]; favorite fav
 * s2: tree [other]
 * Everything was last active at 0 except "fresh", at 11 h.
 */
function fixture(): Workspace {
  const main = createEmptySpace("s1", "Main");
  const work = createEmptySpace("s2", "Work");
  const items = {
    pin: withPane("pin", {}, 0),
    idle: withPane("idle", {}, 0),
    busy: withPane("busy", { runningCommand: { text: "npm test" } }, 0),
    fresh: withPane("fresh", {}, 11 * HOUR),
    fav: withPane("fav", {}, 0),
    unread: withPane("unread", { unread: true }, 0),
    bell: withPane("bell", { bell: true }, 0),
    shown: withPane("shown", {}, 0),
  };
  const treeIds = ["idle", "busy", "fresh", "fav", "unread", "bell", "shown"];
  return {
    version: 2,
    spaces: [
      {
        ...main,
        pinned: ["pin"],
        tree: treeIds.map((id) => ({ kind: "item", id })),
        items,
        activeItemId: "shown",
      },
      {
        ...work,
        tree: [{ kind: "item", id: "other" }],
        items: { other: withPane("other", {}, 0) },
        activeItemId: "other",
      },
    ],
    activeSpaceId: "s1",
    favorites: ["fav"],
    closed: [],
    archive: [],
  };
}

const ids = (ws: Workspace, now: number, afterMs = 12 * HOUR, shownItemId?: string) =>
  idleItems(ws, { now, afterMs, shownItemId }).map((entry) => entry.itemId);

describe("idleItems", () => {
  it("picks the items with no activity for the time, and only those", () => {
    // 12 h in: "idle" and "other" have been quiet that long; "fresh" was active at 11 h.
    expect(ids(fixture(), 12 * HOUR, 12 * HOUR, "shown")).toEqual(["idle", "other"]);
  });

  it("an item is idle exactly when the time has passed, not one moment before", () => {
    const ws = fixture();
    expect(ids(ws, 12 * HOUR - 1, 12 * HOUR, "shown")).toEqual([]);
    expect(ids(ws, 12 * HOUR, 12 * HOUR, "shown")).toContain("idle");
  });

  it("leaves out the tab a window besides the main one shows, and still picks the others of its space", () => {
    // The space "Work" is shown by a window: "other" is the tab it shows. With a second tab in it,
    // that one is as idle as any tab out of sight.
    const ws = fixture();
    const work = ws.spaces[1];
    if (!work) throw new Error("the fixture has a second space");
    const shownByWindow: Workspace = {
      ...ws,
      spaces: [
        ws.spaces[0] as Workspace["spaces"][number],
        {
          ...work,
          tree: [...work.tree, { kind: "item", id: "second" }],
          items: { ...work.items, second: withPane("second", {}, 0) },
        },
      ],
      windows: [{ id: "w1", spaceId: "s2", returnSpaceId: "s1" }],
    };
    const found = ids(shownByWindow, 99 * HOUR, 12 * HOUR, "shown");
    expect(found).not.toContain("other");
    expect(found).toContain("second");
    // Without the window, "other" is idle like the rest.
    expect(ids(ws, 99 * HOUR, 12 * HOUR, "shown")).toContain("other");
  });

  it("leaves out a pinned item", () => {
    expect(ids(fixture(), 99 * HOUR, 12 * HOUR, "shown")).not.toContain("pin");
  });

  it("leaves out a favorite, from any space", () => {
    const ws = fixture();
    expect(ids(ws, 99 * HOUR, 12 * HOUR, "shown")).not.toContain("fav");
    // A favorite of the second space is left out as well.
    const other: Workspace = { ...ws, favorites: ["fav", "other"] };
    expect(ids(other, 99 * HOUR, 12 * HOUR, "shown")).not.toContain("other");
  });

  it("leaves out an item with a command running, by OSC 133 or by status", () => {
    const ws = fixture();
    expect(ids(ws, 99 * HOUR, 12 * HOUR, "shown")).not.toContain("busy");
    const running: Workspace = {
      ...ws,
      spaces: ws.spaces.map((s) =>
        s.id === "s2" ? { ...s, items: { other: withPane("other", { status: "running" }, 0) } } : s,
      ),
    };
    expect(ids(running, 99 * HOUR, 12 * HOUR, "shown")).not.toContain("other");
  });

  it("a command that has only just started in one pane of a split keeps the whole item", () => {
    const ws = fixture();
    const split = {
      kind: "split" as const,
      dir: "row" as const,
      sizes: [50, 50],
      children: [
        { kind: "pane" as const, pane: createPane("sp1", "bash") },
        {
          kind: "pane" as const,
          pane: { ...createPane("sp2", "bash"), runningCommand: {} },
        },
      ],
    };
    const mixed: Workspace = {
      ...ws,
      spaces: ws.spaces.map((s) =>
        s.id === "s2"
          ? { ...s, items: { other: { ...withPane("other", {}, 0), layout: split } } }
          : s,
      ),
    };
    expect(ids(mixed, 99 * HOUR, 12 * HOUR, "shown")).not.toContain("other");
  });

  it("leaves out an item with something unread or a bell nobody has looked at", () => {
    const idle = ids(fixture(), 99 * HOUR, 12 * HOUR, "shown");
    expect(idle).not.toContain("unread");
    expect(idle).not.toContain("bell");
  });

  it("leaves out the item on screen", () => {
    expect(ids(fixture(), 99 * HOUR, 12 * HOUR, "shown")).not.toContain("shown");
    expect(ids(fixture(), 99 * HOUR, 12 * HOUR)).toContain("shown");
  });

  it("leaves out an item with recent activity: it counts from the last sign of life", () => {
    const ws = fixture();
    expect(ids(ws, 22 * HOUR, 12 * HOUR, "shown")).not.toContain("fresh");
    expect(ids(ws, 23 * HOUR, 12 * HOUR, "shown")).toContain("fresh");
  });

  it("a sign of life seen while the app ran counts when it is later than the item's own time", () => {
    const ws = fixture();
    const seen = new Map([["idle", 5 * HOUR]]);
    const idle = (now: number): string[] =>
      idleItems(ws, { now, afterMs: 12 * HOUR, shownItemId: "shown", seen }).map((e) => e.itemId);
    expect(idle(12 * HOUR)).not.toContain("idle");
    expect(idle(17 * HOUR - 1)).not.toContain("idle");
    expect(idle(17 * HOUR)).toContain("idle");
    // One that is older than the item's own time changes nothing.
    const older = new Map([["idle", -3 * HOUR]]);
    expect(
      idleItems(ws, { now: 12 * HOUR, afterMs: 12 * HOUR, shownItemId: "shown", seen: older }).map(
        (e) => e.itemId,
      ),
    ).toContain("idle");
  });

  it("nothing is idle for any time before the app opened", () => {
    const ws = fixture();
    const check = { afterMs: 12 * HOUR, shownItemId: "shown", since: 100 * HOUR };
    expect(idleItems(ws, { ...check, now: 100 * HOUR }).map((e) => e.itemId)).toEqual([]);
    expect(idleItems(ws, { ...check, now: 112 * HOUR - 1 }).map((e) => e.itemId)).toEqual([]);
    expect(idleItems(ws, { ...check, now: 112 * HOUR }).map((e) => e.itemId)).toContain("idle");
  });

  it("leaves out an item whose last activity is in the future of the clock", () => {
    expect(ids(fixture(), -5 * HOUR, 12 * HOUR, "shown")).toEqual([]);
  });

  it("answers with the space of each item", () => {
    expect(
      idleItems(fixture(), { now: 99 * HOUR, afterMs: 12 * HOUR, shownItemId: "shown" }),
    ).toEqual([
      { spaceId: "s1", itemId: "idle" },
      { spaceId: "s1", itemId: "fresh" },
      { spaceId: "s2", itemId: "other" },
    ]);
  });

  it("a time that is not usable archives nothing", () => {
    const ws = fixture();
    expect(idleItems(ws, { now: Number.NaN, afterMs: HOUR })).toEqual([]);
    expect(idleItems(ws, { now: 99 * HOUR, afterMs: 0 })).toEqual([]);
    expect(idleItems(ws, { now: 99 * HOUR, afterMs: -1 })).toEqual([]);
    expect(idleItems(ws, { now: 99 * HOUR, afterMs: Number.NaN })).toEqual([]);
  });

  it("never throws and only names items that exist, whatever the workspace holds", () => {
    fc.assert(
      fc.property(
        arbWorkspace(),
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.integer({ min: 1, max: 100 * HOUR }),
        (ws, now, afterMs) => {
          for (const entry of idleItems(ws, { now, afterMs })) {
            const space = ws.spaces.find((s) => s.id === entry.spaceId);
            const item = space?.items[entry.itemId];
            expect(item).toBeDefined();
            expect(space?.pinned).not.toContain(entry.itemId);
            expect(ws.favorites).not.toContain(entry.itemId);
            expect(item && itemInUse(item)).toBe(false);
            expect(now - (item?.lastActivityAt ?? 0)).toBeGreaterThanOrEqual(afterMs);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("archiveSettingsOf", () => {
  it("is on, after 12 hours, when the file says nothing", () => {
    expect(archiveSettingsOf(undefined)).toEqual({ enabled: true, afterMs: 12 * HOUR });
    expect(archiveSettingsOf({})).toEqual({ enabled: true, afterMs: 12 * HOUR });
    expect(DEFAULT_ARCHIVE_AFTER_HOURS).toBe(12);
  });

  it("takes the file's switch and its hours, a fraction included", () => {
    expect(archiveSettingsOf({ enabled: false })).toEqual({ enabled: false, afterMs: 12 * HOUR });
    expect(archiveSettingsOf({ afterHours: 2 })).toEqual({ enabled: true, afterMs: 2 * HOUR });
    expect(archiveSettingsOf({ afterHours: 0.5 })).toEqual({ enabled: true, afterMs: HOUR / 2 });
    expect(archiveSettingsOf({ afterHours: 0.001 }).afterMs).toBeCloseTo(3600, 5);
  });

  it("falls back to the default hours for a value that cannot be a wait", () => {
    for (const afterHours of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(archiveSettingsOf({ afterHours }).afterMs, String(afterHours)).toBe(12 * HOUR);
    }
  });

  it("checks every minute", () => {
    expect(ARCHIVE_CHECK_INTERVAL_MS).toBe(60_000);
  });
});

import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { createEmptySpace, createPane, createTab } from "./factories";
import { layoutPanes } from "./sessions";
import { applyChecked, testContext } from "./test-helpers";
import { isPaneVisible, lastUnread, shownItem, visiblePanes } from "./unread";
import type { Id, Item, Pane, Workspace } from "./types";

const tab = (itemId: Id, paneId: Id): Item => createTab(itemId, createPane(paneId, "bash"), 0);

/**
 * s1 "Main": pinned [a]; tree [ g { b, c }, d ]; active c.
 * s2 "Work": tree [ e, f (split pf, pf2) ]; active e.
 * s1 is the active space, so the pane on screen is pc.
 */
function fixture(): Workspace {
  const split: Item = {
    ...tab("f", "pf"),
    layout: {
      kind: "split",
      dir: "row",
      sizes: [50, 50],
      children: [
        { kind: "pane", pane: createPane("pf", "bash") },
        { kind: "pane", pane: createPane("pf2", "bash") },
      ],
    },
  };
  return {
    version: 2,
    spaces: [
      {
        ...createEmptySpace("s1", "Main"),
        pinned: ["a"],
        tree: [
          {
            kind: "group",
            id: "g",
            name: "group",
            color: "teal",
            collapsed: false,
            children: [
              { kind: "item", id: "b" },
              { kind: "item", id: "c" },
            ],
          },
          { kind: "item", id: "d" },
        ],
        items: { a: tab("a", "pa"), b: tab("b", "pb"), c: tab("c", "pc"), d: tab("d", "pd") },
        activeItemId: "c",
      },
      {
        ...createEmptySpace("s2", "Work"),
        tree: [
          { kind: "item", id: "e" },
          { kind: "item", id: "f" },
        ],
        items: { e: tab("e", "pe"), f: split },
        activeItemId: "e",
      },
    ],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
  };
}

const paneOf = (ws: Workspace, paneId: Id): Pane => {
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      const found = layoutPanes(item.layout).find((p) => p.id === paneId);
      if (found) return found;
    }
  }
  throw new Error(`no pane ${paneId}`);
};

const notify = (itemId: Id, paneId: Id, bell?: boolean): Action => ({
  type: "pane/notify",
  itemId,
  paneId,
  ...(bell !== undefined ? { bell } : {}),
});

describe("pane/notify", () => {
  it("marks a pane that is not on screen as unread, with the time", () => {
    const { ctx, clock } = testContext();
    clock.advance(500);
    const next = applyChecked(fixture(), notify("a", "pa"), ctx);
    expect(paneOf(next, "pa")).toMatchObject({ unread: true, bell: false, unreadAt: 1500 });
  });

  it("a bell sets the bell mark as well", () => {
    const next = applyChecked(fixture(), notify("a", "pa", true));
    expect(paneOf(next, "pa")).toMatchObject({ unread: true, bell: true });
  });

  it("marks a pane of another space", () => {
    const next = applyChecked(fixture(), notify("e", "pe"));
    expect(paneOf(next, "pe").unread).toBe(true);
  });

  it("never marks the pane on screen", () => {
    const ws = fixture();
    expect(applyChecked(ws, notify("c", "pc"))).toBe(ws);
    expect(applyChecked(ws, notify("c", "pc", true))).toBe(ws);
  });

  it("marks the pane of the active item once its space is not the active one", () => {
    const next = applyChecked(fixture(), { type: "space/activate", spaceId: "s2" });
    const hidden = applyChecked(next, notify("c", "pc"));
    expect(paneOf(hidden, "pc").unread).toBe(true);
    // And e, which s2 shows now, is on screen.
    expect(applyChecked(next, notify("e", "pe"))).toBe(next);
  });

  it("a split on screen has all its panes on screen; zoom hides the others", () => {
    const shown = applyChecked(fixture(), {
      type: "space/set-active-item",
      spaceId: "s1",
      itemId: "d",
    });
    const onWork = applyChecked(shown, { type: "space/activate", spaceId: "s2" });
    const f = applyChecked(onWork, { type: "space/set-active-item", spaceId: "s2", itemId: "f" });
    expect(applyChecked(f, notify("f", "pf"))).toBe(f);
    expect(applyChecked(f, notify("f", "pf2"))).toBe(f);
    const zoomed = applyChecked(f, { type: "pane/zoom", itemId: "f", paneId: "pf" });
    expect(applyChecked(zoomed, notify("f", "pf"))).toBe(zoomed);
    expect(paneOf(applyChecked(zoomed, notify("f", "pf2")), "pf2").unread).toBe(true);
  });

  it("changes nothing when the marks are already there", () => {
    const marked = applyChecked(fixture(), notify("a", "pa", true));
    expect(applyChecked(marked, notify("a", "pa"))).toBe(marked);
    expect(applyChecked(marked, notify("a", "pa", true))).toBe(marked);
    const quiet = applyChecked(fixture(), notify("a", "pa"));
    expect(applyChecked(quiet, notify("a", "pa"))).toBe(quiet);
  });

  it("a bell after a plain notification adds the bell and keeps the time", () => {
    const { ctx, clock } = testContext();
    const first = applyChecked(fixture(), notify("a", "pa"), ctx);
    clock.advance(300);
    const next = applyChecked(first, notify("a", "pa", true), ctx);
    expect(paneOf(next, "pa")).toMatchObject({ unread: true, bell: true, unreadAt: 1000 });
  });

  it("an unknown item or pane changes nothing", () => {
    const ws = fixture();
    expect(applyChecked(ws, notify("nope", "pa"))).toBe(ws);
    expect(applyChecked(ws, notify("a", "nope"))).toBe(ws);
    expect(applyChecked(ws, notify("a", "pb"))).toBe(ws);
  });
});

describe("pane/clear-unread", () => {
  it("clears one pane, or every pane of the item", () => {
    const marked = applyChecked(
      applyChecked(applyChecked(fixture(), notify("f", "pf", true)), notify("f", "pf2")),
      notify("a", "pa"),
    );
    const one = applyChecked(marked, { type: "pane/clear-unread", itemId: "f", paneId: "pf" });
    expect(paneOf(one, "pf")).toMatchObject({ unread: false, bell: false });
    expect(paneOf(one, "pf")).not.toHaveProperty("unreadAt");
    expect(paneOf(one, "pf2").unread).toBe(true);
    const all = applyChecked(marked, { type: "pane/clear-unread", itemId: "f" });
    expect(paneOf(all, "pf2").unread).toBe(false);
    expect(paneOf(all, "pa").unread).toBe(true);
  });

  it("changes nothing when there is nothing to clear, or the target is unknown", () => {
    const ws = fixture();
    expect(applyChecked(ws, { type: "pane/clear-unread", itemId: "a" })).toBe(ws);
    expect(applyChecked(ws, { type: "pane/clear-unread", itemId: "nope" })).toBe(ws);
    expect(applyChecked(ws, { type: "pane/clear-unread", itemId: "a", paneId: "nope" })).toBe(ws);
  });
});

describe("showing a pane reads it", () => {
  const marked = (): Workspace =>
    ["a", "b", "d", "e"].reduce(
      (ws, id) => applyChecked(ws, notify(id, `p${id}`, id === "b")),
      fixture(),
    );

  it("choosing the tab clears it, and only it", () => {
    const next = applyChecked(marked(), {
      type: "space/set-active-item",
      spaceId: "s1",
      itemId: "b",
    });
    expect(paneOf(next, "pb")).toMatchObject({ unread: false, bell: false });
    expect(paneOf(next, "pa").unread).toBe(true);
    expect(paneOf(next, "pd").unread).toBe(true);
  });

  it("choosing the space clears the tab it shows", () => {
    const next = applyChecked(marked(), { type: "space/activate", spaceId: "s2" });
    expect(paneOf(next, "pe").unread).toBe(false);
    expect(paneOf(next, "pa").unread).toBe(true);
  });

  it("focusing a pane that zoom hid clears it", () => {
    const f = applyChecked(applyChecked(fixture(), { type: "space/activate", spaceId: "s2" }), {
      type: "space/set-active-item",
      spaceId: "s2",
      itemId: "f",
    });
    const zoomed = applyChecked(f, { type: "pane/zoom", itemId: "f", paneId: "pf" });
    const marks = applyChecked(zoomed, notify("f", "pf2"));
    expect(paneOf(marks, "pf2").unread).toBe(true);
    const next = applyChecked(marks, { type: "pane/focus", itemId: "f", paneId: "pf2" });
    expect(paneOf(next, "pf2").unread).toBe(false);
  });

  it("an action that changes nothing clears nothing", () => {
    // A state saved with a mark on screen stays as it is until something changes.
    const ws = fixture();
    const odd: Workspace = {
      ...ws,
      spaces: ws.spaces.map((space) =>
        space.id === "s1"
          ? {
              ...space,
              items: {
                ...space.items,
                c: {
                  ...tab("c", "pc"),
                  layout: { kind: "pane", pane: { ...createPane("pc", "bash"), unread: true } },
                },
              },
            }
          : space,
      ),
    };
    expect(applyChecked(odd, { type: "space/activate", spaceId: "s1" })).toBe(odd);
    const next = applyChecked(odd, { type: "space/rename", spaceId: "s2", name: "Other" });
    expect(paneOf(next, "pc").unread).toBe(false);
  });
});

describe("lastUnread", () => {
  it("is undefined when nothing is unread", () => {
    expect(lastUnread(fixture())).toBeUndefined();
  });

  it("is the pane that became unread last, in any space", () => {
    const { ctx, clock } = testContext();
    let ws = fixture();
    for (const [itemId, paneId] of [
      ["a", "pa"],
      ["e", "pe"],
      ["d", "pd"],
    ] as const) {
      ws = applyChecked(ws, notify(itemId, paneId), ctx);
      clock.advance(10);
    }
    expect(lastUnread(ws)).toEqual({ spaceId: "s1", itemId: "d", paneId: "pd" });
    const read = applyChecked(ws, { type: "space/set-active-item", spaceId: "s1", itemId: "d" });
    expect(lastUnread(read)).toEqual({ spaceId: "s2", itemId: "e", paneId: "pe" });
  });

  it("follows the order of the marks, not the order of the sidebar", () => {
    const { ctx, clock } = testContext();
    let ws = applyChecked(fixture(), notify("d", "pd"), ctx);
    clock.advance(10);
    ws = applyChecked(ws, notify("a", "pa"), ctx);
    expect(lastUnread(ws)).toEqual({ spaceId: "s1", itemId: "a", paneId: "pa" });
  });

  it("a tie goes to the first in sidebar order, and a pane with only a bell counts", () => {
    const { ctx } = testContext();
    let ws = applyChecked(fixture(), notify("d", "pd"), ctx);
    ws = applyChecked(ws, notify("b", "pb"), ctx);
    expect(lastUnread(ws)).toEqual({ spaceId: "s1", itemId: "b", paneId: "pb" });
    const bellOnly: Workspace = {
      ...fixture(),
      spaces: fixture().spaces.map((space) =>
        space.id === "s2"
          ? {
              ...space,
              items: {
                ...space.items,
                e: {
                  ...tab("e", "pe"),
                  layout: { kind: "pane", pane: { ...createPane("pe", "bash"), bell: true } },
                },
              },
            }
          : space,
      ),
    };
    expect(lastUnread(bellOnly)).toEqual({ spaceId: "s2", itemId: "e", paneId: "pe" });
  });
});

describe("what is on screen", () => {
  it("shownItem falls back to the first item of a space without an active one", () => {
    const [first] = fixture().spaces;
    if (!first) throw new Error("no space");
    const space = { ...first };
    delete space.activeItemId;
    expect(shownItem(space)?.id).toBe("a");
    expect(shownItem(createEmptySpace("x", "Empty"))).toBeUndefined();
  });

  it("visiblePanes and isPaneVisible follow zoom and the active space", () => {
    const ws = fixture();
    const f = ws.spaces[1]?.items["f"];
    if (!f) throw new Error("no tab f");
    expect(visiblePanes(f).map((p) => p.id)).toEqual(["pf", "pf2"]);
    expect(visiblePanes({ ...f, zoomedPaneId: "pf2" }).map((p) => p.id)).toEqual(["pf2"]);
    expect(isPaneVisible(ws, "s1", "c", "pc")).toBe(true);
    expect(isPaneVisible(ws, "s1", "b", "pb")).toBe(false);
    expect(isPaneVisible(ws, "s2", "e", "pe")).toBe(false);
  });
});

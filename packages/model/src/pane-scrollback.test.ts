import { describe, expect, it } from "vitest";
import type { Action } from "./actions";
import { createEmptySpace, createPane, createTab } from "./factories";
import { layoutPanes } from "./sessions";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked } from "./test-helpers";
import type { Id, Pane, Workspace } from "./types";

// pane/set-scrollback: the note on a pane that says where its snapshot is.

function fixture(): Workspace {
  return {
    version: 2,
    spaces: [
      {
        ...createEmptySpace("s1", "Main"),
        tree: [
          { kind: "item", id: "a" },
          { kind: "item", id: "b" },
        ],
        items: {
          a: createTab("a", createPane("pa", "bash"), 0),
          b: createTab("b", createPane("pb", "bash"), 0),
        },
        activeItemId: "a",
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

const note = (itemId: Id, paneId: Id, ref?: string): Action => ({
  type: "pane/set-scrollback",
  itemId,
  paneId,
  ...(ref !== undefined ? { ref } : {}),
});

describe("pane/set-scrollback", () => {
  it("records the file of the snapshot on the pane and only on that pane", () => {
    const next = applyChecked(fixture(), note("a", "pa", "pa.txt"));
    expect(paneOf(next, "pa").scrollbackRef).toBe("pa.txt");
    expect(paneOf(next, "pb").scrollbackRef).toBeUndefined();
  });

  it("takes the note away when the action has no file", () => {
    const withNote = applyChecked(fixture(), note("a", "pa", "pa.txt"));
    const cleared = applyChecked(withNote, note("a", "pa"));
    expect("scrollbackRef" in paneOf(cleared, "pa")).toBe(false);
  });

  it("changes the note when the file is another one", () => {
    const first = applyChecked(fixture(), note("a", "pa", "one.txt"));
    const second = applyChecked(first, note("a", "pa", "two.txt"));
    expect(paneOf(second, "pa").scrollbackRef).toBe("two.txt");
  });

  it("leaves the workspace as it is when the pane already has the note", () => {
    const withNote = applyChecked(fixture(), note("a", "pa", "pa.txt"));
    expect(applyChecked(withNote, note("a", "pa", "pa.txt"))).toBe(withNote);
    // And when there is nothing to take away.
    const ws = fixture();
    expect(applyChecked(ws, note("a", "pa"))).toBe(ws);
  });

  it("ignores a blank file, an unknown pane and an unknown item", () => {
    const ws = fixture();
    expect(applyChecked(ws, note("a", "pa", ""))).toBe(ws);
    expect(applyChecked(ws, note("a", "pa", "   "))).toBe(ws);
    expect(applyChecked(ws, note("a", "nope", "x.txt"))).toBe(ws);
    expect(applyChecked(ws, note("nope", "pa", "x.txt"))).toBe(ws);
    // A pane of another item is not found through this one.
    expect(applyChecked(ws, note("a", "pb", "x.txt"))).toBe(ws);
  });

  it("does not touch the sessions, the status or the marks of the pane", () => {
    const before = fixture();
    const next = applyChecked(before, note("a", "pa", "pa.txt"));
    const { scrollbackRef, ...rest } = paneOf(next, "pa");
    expect(scrollbackRef).toBe("pa.txt");
    expect(rest).toEqual(paneOf(before, "pa"));
  });

  it("is saved in state.json and comes back from it", () => {
    const next = applyChecked(fixture(), note("a", "pa", "pa.txt"));
    const parsed = parseState(serializeWorkspace(next));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(paneOf(parsed.workspace, "pa").scrollbackRef).toBe("pa.txt");
  });
});

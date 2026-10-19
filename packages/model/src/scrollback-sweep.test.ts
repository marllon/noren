import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEmptySpace, createPane, createTab } from "./factories";
import { orphanScrollbackIds, snapshotSearchText } from "./scrollback";
import type { Item, LayoutNode, Space, Workspace } from "./types";

// The two pure pieces of the 03b task: the text a search looks in, and which files in `scrollback/`
// no pane claims.

const ESC = "\x1b";

const tab = (itemId: string, ...paneIds: string[]): Item => {
  const panes = paneIds.map((id) => createPane(id, "default"));
  const first = panes[0];
  if (first === undefined) throw new Error("a tab needs a pane");
  const layout: LayoutNode =
    panes.length === 1
      ? { kind: "pane", pane: first }
      : {
          kind: "split",
          dir: "row",
          sizes: panes.map(() => 100 / panes.length),
          children: panes.map((pane) => ({ kind: "pane", pane })),
        };
  return { ...createTab(itemId, first, 1), layout };
};

const withItems = (space: Space, items: Item[]): Space => ({
  ...space,
  tree: items.map((item) => ({ kind: "item", id: item.id })),
  items: Object.fromEntries(items.map((item) => [item.id, item])),
});

function workspace(parts: { open?: Item[]; closed?: Item[]; archived?: Item[] }): Workspace {
  return {
    version: 2,
    spaces: [withItems(createEmptySpace("s1", "Work"), parts.open ?? [])],
    activeSpaceId: "s1",
    favorites: [],
    closed: (parts.closed ?? []).map((item) => ({ item, spaceId: "s1", closedAt: 1 })),
    archive: (parts.archived ?? []).map((item) => ({ item, spaceId: "s1", archivedAt: 1 })),
  };
}

describe("snapshotSearchText", () => {
  it("keeps the text and the line breaks and drops the colors", () => {
    const raw = `${ESC}[2m${ESC}[31mred line${ESC}[0m\nsecond ${ESC}[1;38;5;12mline${ESC}[0m`;
    expect(snapshotSearchText(raw)).toBe("red line\nsecond line");
  });

  it("drops what is not text: titles, clipboard, mode changes, requests, control characters", () => {
    const raw = [
      `before${ESC}]0;fake title\x07`,
      `${ESC}]52;c;ZWNobyBoaQ==\x07copied`,
      `${ESC}[?1049hscreen${ESC}[6n`,
      `${ESC}[2J${ESC}[1;1Hmoved\x07\x9b31m`,
    ].join("\n");
    const text = snapshotSearchText(raw);
    expect(text).toBe("before\ncopied\nscreen\nmoved31m");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("fake title");
  });

  it("leaves markup as the plain text it is, for the caller to draw as text", () => {
    expect(snapshotSearchText('<img src=x onerror="alert(1)"> & <script>')).toBe(
      '<img src=x onerror="alert(1)"> & <script>',
    );
  });

  it("never throws and never returns an escape or a control character, whatever the text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (raw) => {
        const text = snapshotSearchText(raw);
        // eslint-disable-next-line no-control-regex
        expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      }),
    );
  });
});

describe("orphanScrollbackIds", () => {
  it("returns only the files that no pane claims", () => {
    const ws = workspace({ open: [tab("i1", "p-open")] });
    expect(orphanScrollbackIds(ws, ["p-open", "p-gone", "p-also-gone"])).toEqual([
      "p-gone",
      "p-also-gone",
    ]);
  });

  it("keeps the files of the panes in spaces, in closed and in the archive", () => {
    const ws = workspace({
      open: [tab("i1", "p-open")],
      closed: [tab("i2", "p-closed")],
      archived: [tab("i3", "p-archived")],
    });
    expect(orphanScrollbackIds(ws, ["p-open", "p-closed", "p-archived"])).toEqual([]);
    expect(orphanScrollbackIds(ws, ["p-archived", "p-x", "p-closed", "p-open"])).toEqual(["p-x"]);
  });

  it("a tab with split panes claims the file of each pane", () => {
    const ws = workspace({
      open: [tab("i1", "a1", "a2")],
      closed: [tab("i2", "b1", "b2")],
      archived: [tab("i3", "c1", "c2")],
    });
    const listed = ["a1", "a2", "b1", "b2", "c1", "c2", "z"];
    expect(orphanScrollbackIds(ws, listed)).toEqual(["z"]);
  });

  it("a pane claims its file whether or not it has a note about it", () => {
    const withNote = tab("i1", "p-note");
    const layout = withNote.layout;
    if (layout.kind !== "pane") throw new Error("one pane");
    const ws = workspace({
      open: [
        {
          ...withNote,
          layout: { kind: "pane", pane: { ...layout.pane, scrollbackRef: "p-note.txt" } },
        },
        tab("i2", "p-no-note"),
      ],
    });
    expect(orphanScrollbackIds(ws, ["p-note", "p-no-note"])).toEqual([]);
  });

  it("an empty list has no orphans, and an empty workspace makes every valid id one", () => {
    expect(orphanScrollbackIds(workspace({ open: [tab("i1", "p")] }), [])).toEqual([]);
    expect(orphanScrollbackIds(workspace({}), ["a", "b"])).toEqual(["a", "b"]);
  });

  it("never returns an id that cannot name a snapshot file, nor the same id twice", () => {
    const ws = workspace({});
    const listed = ["../escape", "a/b", "", "con", "a b", "x".repeat(65), "ok", "ok", "café"];
    expect(orphanScrollbackIds(ws, listed)).toEqual(["ok"]);
  });

  it("never returns a pane of the workspace, whatever the list (property)", () => {
    const ids = fc.array(fc.stringMatching(/^[a-z0-9_-]{1,8}$/), { maxLength: 12 });
    fc.assert(
      fc.property(ids, ids, ids, ids, (open, closed, archived, extra) => {
        const mk = (prefix: string, panes: string[]) =>
          panes.length === 0 ? [] : [tab(prefix, ...new Set(panes))];
        const ws = workspace({
          open: mk("o", open),
          closed: mk("c", closed),
          archived: mk("a", archived),
        });
        const claimed = new Set([...open, ...closed, ...archived]);
        const orphans = orphanScrollbackIds(ws, [...open, ...closed, ...archived, ...extra]);
        for (const id of orphans) expect(claimed.has(id)).toBe(false);
        for (const id of extra) if (!claimed.has(id)) expect(orphans).toContain(id);
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import type { ArchivedItem, ClosedItem, Item, Workspace } from "@noren/model";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";
import { UNTITLED_TAB, filterLibrary, libraryEntries } from "./library-entries";

// The library lists the archive and the closed tabs and narrows them by title and folder.

const item = (name: string, cwd: string | undefined, title?: string): Item => ({
  ...fixtureTab(`i-${name}`, fixturePane(`p-${name}`, cwd !== undefined ? { cwd } : {})),
  ...(title !== undefined ? { title } : {}),
});

const archived = (name: string, at: number, cwd?: string, title?: string): ArchivedItem => ({
  item: item(name, cwd, title),
  spaceId: "s1",
  archivedAt: at,
});

const closed = (name: string, at: number, cwd?: string, title?: string): ClosedItem => ({
  item: item(name, cwd, title),
  spaceId: "s1",
  closedAt: at,
});

function workspace(extra: Partial<Workspace> = {}): Workspace {
  return {
    version: 2,
    spaces: [{ ...fixtureSpace("s1", []), name: "Work", color: "#112233" }],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive: [],
    ...extra,
  };
}

describe("libraryEntries", () => {
  it("lists a section with the newest first", () => {
    const ws = workspace({
      archive: [archived("old", 100, "/srv/old"), archived("new", 300, "/srv/new")],
      closed: [closed("c", 50, "/srv/c")],
    });
    expect(libraryEntries(ws, "archive").map((e) => e.itemId)).toEqual(["i-new", "i-old"]);
    expect(libraryEntries(ws, "closed").map((e) => e.itemId)).toEqual(["i-c"]);
  });

  it("the last of two that left at the same moment comes first", () => {
    const ws = workspace({ archive: [archived("a", 100), archived("b", 100)] });
    expect(libraryEntries(ws, "archive").map((e) => e.itemId)).toEqual(["i-b", "i-a"]);
  });

  it("carries the title, the folder in full and short, the space, the moment and the pane count", () => {
    const ws = workspace({
      archive: [archived("a", new Date(2026, 9, 19, 14, 5).getTime(), "/home/me/proj", "build")],
    });
    const [entry] = libraryEntries(ws, "archive", "/home/me");
    expect(entry).toMatchObject({
      section: "archive",
      itemId: "i-a",
      title: "build",
      spaceId: "s1",
      spaceName: "Work",
      spaceColor: "#112233",
      cwd: "/home/me/proj",
      cwdShort: "~/proj",
      when: "2026-10-19 14:05",
      panes: 1,
    });
  });

  it("names a tab with no title, and leaves the folder out when the pane never had one", () => {
    const ws = workspace({ archive: [archived("a", 1), archived("b", 2, "/x", "   ")] });
    const entries = libraryEntries(ws, "archive");
    expect(entries.map((e) => e.title)).toEqual([UNTITLED_TAB, UNTITLED_TAB]);
    expect(entries[1]).not.toHaveProperty("cwd");
    expect(entries[0]).toHaveProperty("cwd", "/x");
  });

  it("says so when the space it came from is gone", () => {
    const ws = workspace({
      closed: [{ item: item("a", "/x"), spaceId: "gone", closedAt: 1 }],
    });
    expect(libraryEntries(ws, "closed")[0]?.spaceName).toBe("Deleted space");
  });

  it("takes the folder of the focused pane of a split", () => {
    const split: Item = {
      ...item("a", "/x"),
      layout: {
        kind: "split",
        dir: "row",
        sizes: [50, 50],
        children: [
          { kind: "pane", pane: fixturePane("p1", { cwd: "/first" }) },
          { kind: "pane", pane: fixturePane("p2", { cwd: "/second" }) },
        ],
      },
      focusedPaneId: "p2",
    };
    const ws = workspace({ archive: [{ item: split, spaceId: "s1", archivedAt: 1 }] });
    const [entry] = libraryEntries(ws, "archive");
    expect(entry?.cwd).toBe("/second");
    expect(entry?.panes).toBe(2);
  });
});

describe("filterLibrary", () => {
  const ws = workspace({
    archive: [
      archived("a", 1, "/srv/api", "server"),
      archived("b", 2, "/srv/web", "Frontend build"),
      archived("c", 3, "C:\\Users\\Me\\Code\\noren", "release"),
    ],
  });
  const entries = libraryEntries(ws, "archive");
  const ids = (query: string): string[] => filterLibrary(entries, query).map((e) => e.itemId);

  it("an empty query shows everything", () => {
    expect(ids("")).toEqual(["i-c", "i-b", "i-a"]);
    expect(ids("   ")).toEqual(["i-c", "i-b", "i-a"]);
  });

  it("matches the title, ignoring case", () => {
    expect(ids("FRONT")).toEqual(["i-b"]);
    expect(ids("release")).toEqual(["i-c"]);
  });

  it("matches the folder, in full", () => {
    expect(ids("/srv/api")).toEqual(["i-a"]);
    expect(ids("srv")).toEqual(["i-b", "i-a"]);
    expect(ids("code\\noren")).toEqual(["i-c"]);
  });

  it("every word has to match, in the title or in the folder", () => {
    expect(ids("srv build")).toEqual(["i-b"]);
    expect(ids("srv release")).toEqual([]);
  });

  it("finds nothing for text that is in neither", () => {
    expect(ids("zzz")).toEqual([]);
    // The space name is not searched.
    expect(ids("work")).toEqual([]);
  });
});

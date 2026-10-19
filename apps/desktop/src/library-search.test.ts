import { describe, expect, it } from "vitest";
import { FakeBackend } from "@noren/model";
import type { ArchivedItem, Workspace } from "@noren/model";
import { fixturePane, fixtureSpace, fixtureTab } from "./closed-fixtures";
import {
  SNIPPET_LENGTH,
  filterLibrary,
  libraryEntries,
  libraryText,
  loadLibraryTexts,
} from "./library-entries";
import type { LibraryText } from "./library-entries";

// The library looks in the saved output of the tabs too: which tabs match, the line it shows, and
// how the files are read (cleaned, a few at a time, and never trusted).

const withOutput = (name: string, at: number, cwd: string, title: string): ArchivedItem => ({
  item: {
    ...fixtureTab(`i-${name}`, fixturePane(`p-${name}`, { cwd, ref: true })),
    title,
  },
  spaceId: "s1",
  archivedAt: at,
});

const plainTab = (name: string, at: number, cwd: string, title: string): ArchivedItem => ({
  item: { ...fixtureTab(`i-${name}`, fixturePane(`p-${name}`, { cwd })), title },
  spaceId: "s1",
  archivedAt: at,
});

function workspace(archive: ArchivedItem[]): Workspace {
  return {
    version: 2,
    spaces: [{ ...fixtureSpace("s1", []), name: "Work", color: "#112233" }],
    activeSpaceId: "s1",
    favorites: [],
    closed: [],
    archive,
  };
}

describe("filterLibrary on the saved output", () => {
  const ws = workspace([
    withOutput("a", 1, "/srv/api", "server"),
    withOutput("b", 2, "/srv/web", "frontend"),
    plainTab("c", 3, "/srv/none", "empty"),
  ]);
  const entries = libraryEntries(ws, "archive");
  const texts = new Map<string, LibraryText>([
    ["i-a", libraryText("starting up\nlistening on port 8080\nready")],
    ["i-b", libraryText("compiling\nwarning: deprecated Zebra call in main.ts\ndone")],
  ]);
  const ids = (query: string): string[] =>
    filterLibrary(entries, query, texts).map((e) => e.itemId);

  it("finds a tab by a word that is only in its output, ignoring case", () => {
    expect(ids("zebra")).toEqual(["i-b"]);
    expect(ids("PORT 8080")).toEqual(["i-a"]);
    expect(ids("nothing-like-this")).toEqual([]);
  });

  it("the output is searched together with the title and the folder, word by word", () => {
    expect(ids("frontend zebra")).toEqual(["i-b"]);
    expect(ids("/srv/api listening")).toEqual(["i-a"]);
    expect(ids("server zebra")).toEqual([]);
    expect(ids("listening zebra")).toEqual([]);
  });

  it("a tab with no output loaded matches by title and folder only", () => {
    expect(ids("empty")).toEqual(["i-c"]);
    expect(filterLibrary(entries, "zebra")).toEqual([]);
    expect(filterLibrary(entries, "zebra", new Map())).toEqual([]);
  });

  it("shows the line that matched, and none when the title or folder matched", () => {
    const [byOutput] = filterLibrary(entries, "zebra", texts);
    expect(byOutput?.snippet).toBe("warning: deprecated Zebra call in main.ts");
    const [byTitle] = filterLibrary(entries, "frontend", texts);
    expect(byTitle?.snippet).toBeUndefined();
    const [both] = filterLibrary(entries, "frontend zebra", texts);
    expect(both?.snippet).toBe("warning: deprecated Zebra call in main.ts");
  });

  it("prefers the line that has every word, and does not change the entry it was given", () => {
    const text = libraryText("alpha only\nbeta only\nalpha and beta together");
    const [hit] = filterLibrary(entries, "alpha beta", new Map([["i-a", text]]));
    expect(hit?.snippet).toBe("alpha and beta together");
    expect(entries.find((e) => e.itemId === "i-a")?.snippet).toBeUndefined();
  });

  it("cuts a long line around the match and collapses its blanks", () => {
    const long = `${"x".repeat(300)}   needle    ${"y".repeat(300)}`;
    const [hit] = filterLibrary(entries, "needle", new Map([["i-a", libraryText(long)]]));
    const snippet = hit?.snippet ?? "";
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_LENGTH + 2);
    expect(snippet).not.toContain("  ");
  });

  it("an empty query still shows everything, with no snippet", () => {
    expect(filterLibrary(entries, "", texts)).toEqual(entries);
  });
});

describe("loadLibraryTexts", () => {
  async function load(backend: FakeBackend, ws: Workspace, signal?: AbortSignal) {
    const got = new Map<string, LibraryText>();
    await loadLibraryTexts(
      backend,
      libraryEntries(ws, "archive"),
      (id, text) => got.set(id, text),
      signal,
    );
    return got;
  }
  const output = (name: string, at: number) => withOutput(name, at, "/srv", name);

  it("reads the output of each tab that records one, cleaned and without colors", async () => {
    const backend = new FakeBackend();
    backend.setScrollback("p-a", "\x1b[2m\x1b[31mRed word\x1b[0m\nnext line");
    backend.setScrollback("p-b", "other");
    const ws = workspace([output("a", 1), output("b", 2), plainTab("c", 3, "/srv", "c")]);
    const got = await load(backend, ws);
    expect([...got.keys()].sort()).toEqual(["i-a", "i-b"]);
    expect(got.get("i-a")?.text).toBe("Red word\nnext line");
    expect(got.get("i-a")?.lower).toBe("red word\nnext line");
    expect(
      backend
        .callsTo("loadScrollback")
        .map((c) => c.args[0])
        .sort(),
    ).toEqual(["p-a", "p-b"]);
  });

  it("a hostile file gives text and nothing that a terminal would obey", async () => {
    const backend = new FakeBackend();
    backend.setScrollback(
      "p-a",
      "ok\x1b]52;c;ZWNobyBoaQ==\x07 <b>bold</b>\x1b[6n\x1b[?1049h\x1b]0;title\x07",
    );
    const got = await load(backend, workspace([output("a", 1)]));
    expect(got.get("i-a")?.text).toBe("ok <b>bold</b>");
  });

  it("skips a file that is missing, empty or unreadable, and the others still load", async () => {
    const backend = new FakeBackend();
    backend.setScrollback("p-b", "kept");
    backend.setScrollback("p-c", "\x1b]0;only a title\x07");
    const ws = workspace([output("a", 1), output("b", 2), output("c", 3), output("d", 4)]);
    const original = backend.loadScrollback.bind(backend);
    backend.loadScrollback = async (paneId) => {
      if (paneId === "p-a") throw new Error("locked");
      return original(paneId);
    };
    const got = await load(backend, ws);
    expect([...got.keys()]).toEqual(["i-b"]);
  });

  it("starts no read once it is aborted", async () => {
    const backend = new FakeBackend();
    const controller = new AbortController();
    controller.abort();
    const got = await load(backend, workspace([output("a", 1), output("b", 2)]), controller.signal);
    expect(got.size).toBe(0);
    expect(backend.callsTo("loadScrollback")).toEqual([]);
  });
});

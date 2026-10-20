import { describe, expect, it } from "vitest";
import { pathLinksOfRow } from "./terminal-paths";
import type { BufferLike, CellLike, LineLike } from "./terminal-paths";

/** A cell: its characters and its width in cells (a wide character is followed by a cell of width 0). */
const cell = (chars: string, width = 1): CellLike => ({
  getChars: () => chars,
  getWidth: () => width,
});

/** A row of the screen that is `columns` wide: the text laid out as a terminal would, a cell each. */
function line(text: string, columns: number, isWrapped = false): LineLike {
  const cells: CellLike[] = [];
  for (const char of text) {
    const wide = (char.codePointAt(0) ?? 0) > 0x2e80;
    cells.push(cell(char, wide ? 2 : 1));
    if (wide) cells.push(cell("", 0));
  }
  while (cells.length < columns) cells.push(cell("", 1));
  return { isWrapped, length: columns, getCell: (x) => cells[x] };
}

const screen = (...rows: LineLike[]): BufferLike => ({ getLine: (y) => rows[y] });

describe("the path links of a row of the screen", () => {
  it("gives the cells of the path, 1-based and with the end included", () => {
    const [link] = pathLinksOfRow(screen(line("see /tmp/a.md now", 40)), 0, undefined);
    expect(link).toEqual({
      text: "/tmp/a.md",
      path: "/tmp/a.md",
      range: { start: { x: 5, y: 1 }, end: { x: 13, y: 1 } },
    });
  });

  it("takes the :line:column into the link and keeps it out of the path", () => {
    const [link] = pathLinksOfRow(screen(line("src/main.rs:12:5: bad", 40)), 0, "/work");
    expect(link?.path).toBe("src/main.rs");
    expect(link?.text).toBe("src/main.rs:12:5");
    expect(link?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 16, y: 1 } });
  });

  it("counts a wide character as the two cells it takes", () => {
    const [link] = pathLinksOfRow(screen(line("日本 /tmp/a.md", 40)), 0, undefined);
    // Two wide characters take four cells, then a blank: the path starts at the sixth cell.
    expect(link?.range.start).toEqual({ x: 6, y: 1 });
    expect(link?.range.end).toEqual({ x: 14, y: 1 });
  });

  it("ties a wide character inside the path to its cells", () => {
    const [link] = pathLinksOfRow(screen(line("/tmp/日本.md", 40)), 0, undefined);
    expect(link?.path).toBe("/tmp/日本.md");
    expect(link?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 12, y: 1 } });
  });

  it("joins a path that wraps and gives it to both rows", () => {
    const rows = screen(line("see /home/me/proj", 17), line("ect/notes.md", 17, true));
    const first = pathLinksOfRow(rows, 0, undefined);
    const second = pathLinksOfRow(rows, 1, undefined);
    expect(first).toEqual(second);
    expect(first[0]?.path).toBe("/home/me/project/notes.md");
    expect(first[0]?.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 12, y: 2 } });
  });

  it("gives a row only the paths it holds a part of", () => {
    const rows = screen(line("/tmp/a.md and", 14), line("/tmp/b.md", 14, true));
    expect(pathLinksOfRow(rows, 0, undefined).map((link) => link.path)).toEqual(["/tmp/a.md"]);
    expect(pathLinksOfRow(rows, 1, undefined).map((link) => link.path)).toEqual(["/tmp/b.md"]);
  });

  it("does not join a row that does not continue the one above", () => {
    const rows = screen(line("/home/me/proj", 13), line("ect/notes.md", 13));
    expect(pathLinksOfRow(rows, 1, "/w").map((link) => link.path)).toEqual(["ect/notes.md"]);
    expect(pathLinksOfRow(rows, 0, undefined).map((link) => link.path)).toEqual(["/home/me/proj"]);
  });

  it("makes a relative path a link only where the pane has a folder", () => {
    const rows = screen(line("error in ./a.md", 30));
    expect(pathLinksOfRow(rows, 0, undefined)).toEqual([]);
    expect(pathLinksOfRow(rows, 0, "relative/folder")).toEqual([]);
    expect(pathLinksOfRow(rows, 0, "/work")).toHaveLength(1);
  });

  it("keeps a relative path in a folder on the network a link, so the click can say why it opens nothing", () => {
    const rows = screen(line("error in ./a.md", 30));
    expect(pathLinksOfRow(rows, 0, "\\\\server\\share")).toHaveLength(1);
  });

  it("finds nothing in an empty row or one that is not there", () => {
    expect(pathLinksOfRow(screen(line("", 20)), 0, "/work")).toEqual([]);
    expect(pathLinksOfRow(screen(), 3, "/work")).toEqual([]);
  });

  it("leaves an address to the link of addresses", () => {
    expect(pathLinksOfRow(screen(line("see https://example.com/a/b.md", 40)), 0, "/w")).toEqual([]);
  });
});

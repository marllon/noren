import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PEEK_LINES, PEEK_LINE_CHARS, peekLines } from "./scrollback";

const ESC = "\x1b";

describe("the lines of a peek", () => {
  it("is empty for an empty snapshot and for one with only blank lines", () => {
    expect(peekLines("")).toEqual([]);
    expect(peekLines("\n\n   \n\t\n")).toEqual([]);
  });

  it("gives all the lines when there are fewer than the limit, without the empty ones", () => {
    expect(peekLines("one\n\ntwo\n   \nthree\n\n\n")).toEqual(["one", "two", "three"]);
  });

  it("gives the last 15 lines that hold something, in order", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const lines = peekLines(text);
    expect(lines).toHaveLength(PEEK_LINES);
    expect(lines[0]).toBe("line 26");
    expect(lines[14]).toBe("line 40");
  });

  it("counts only lines that hold something toward the limit", () => {
    const text = ["a", "", "", "b", "", "c"].join("\n");
    expect(peekLines(text, 2)).toEqual(["b", "c"]);
  });

  it("takes the count as given, and nothing for a count below 1 or not a number", () => {
    expect(peekLines("a\nb\nc", 1)).toEqual(["c"]);
    expect(peekLines("a\nb\nc", 0)).toEqual([]);
    expect(peekLines("a\nb\nc", -3)).toEqual([]);
    expect(peekLines("a\nb\nc", Number.NaN)).toEqual([]);
    expect(peekLines("a\nb\nc", 2.9)).toEqual(["b", "c"]);
  });

  it("drops the colors and the trailing blanks of a line", () => {
    expect(peekLines(`${ESC}[31mred${ESC}[0m   \n${ESC}[1;32mgreen${ESC}[0m`)).toEqual([
      "red",
      "green",
    ]);
  });

  it("cuts a long line with an ellipsis, to the limit", () => {
    const [line] = peekLines("x".repeat(PEEK_LINE_CHARS + 50));
    expect(line).toHaveLength(PEEK_LINE_CHARS);
    expect(line?.endsWith("…")).toBe(true);
    expect(peekLines("y".repeat(PEEK_LINE_CHARS))).toEqual(["y".repeat(PEEK_LINE_CHARS)]);
    expect(peekLines("abcdefghij", 5, 5)).toEqual(["abcd…"]);
  });

  it("does not cut a surrogate pair in half", () => {
    const [line] = peekLines("a😀😀😀😀", 1, 4);
    expect(line).toBe("a😀…");
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("keeps markup as the text it is", () => {
    expect(peekLines("<img src=x onerror=alert(1)>\n<script>boom()</script>")).toEqual([
      "<img src=x onerror=alert(1)>",
      "<script>boom()</script>",
    ]);
  });

  it("removes hostile sequences, as the snapshot filter does", () => {
    const hostile = [
      `before${ESC}]52;c;ZWNobyBoaQ==\x07after`, // clipboard write
      `a${ESC}]0;title\x07b`, // window title
      `c${ESC}[6nd`, // cursor position report request
      `e${ESC}[?1049hf`, // alternate screen
      `g${ESC}[?1000hh`, // mouse tracking
      `i${ESC}Pq#0;2;0;0;0${ESC}\\j`, // DCS string
      "k\u009b6nl", // eight-bit CSI
      "m‮evil‬n", // text reordering
      "o\x00p\x07q",
    ];
    const lines = peekLines(hostile.join("\n"), 20);
    // The eight-bit CSI and the reordering marks are dropped; the characters after them stay as text.
    expect(lines).toEqual(["beforeafter", "ab", "cd", "ef", "gh", "ij", "k6nl", "meviln", "opq"]);
    for (const line of lines) {
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/);
    }
  });

  it("never throws, never exceeds the limits and holds only clean text, for any input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 600 }), (raw) => {
        const lines = peekLines(raw);
        expect(lines.length).toBeLessThanOrEqual(PEEK_LINES);
        for (const line of lines) {
          expect(line.length).toBeLessThanOrEqual(PEEK_LINE_CHARS);
          expect(line.trim()).not.toBe("");
          // eslint-disable-next-line no-control-regex
          expect(line).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/);
        }
      }),
      { numRuns: 300 },
    );
  });
});

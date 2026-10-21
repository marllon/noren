import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TerminalTail } from "./terminal-tail";
import { encodeUtf8 } from "./utf8";

// The last lines of a terminal, for `terminal.read` (NOR-F17-01b).

describe("TerminalTail", () => {
  it("reads the lines as plain text: no colors, no cursor moves, no window titles", () => {
    const tail = new TerminalTail();
    tail.feed(1, "\x1b[1;31merror\x1b[0m: bad\r\n\x1b]0;title\x07\x1b[2Kok\r\n");
    expect(tail.read(1, 10)).toEqual(["error: bad", "ok"]);
  });

  it("gives the line still being written, as a prompt is, and not an empty one after the last line end", () => {
    const tail = new TerminalTail();
    tail.feed(1, "one\r\ntwo\r\nPS> ");
    expect(tail.read(1, 10)).toEqual(["one", "two", "PS> "]);
    tail.feed(1, "ls\r\n");
    expect(tail.read(1, 10)).toEqual(["one", "two", "PS> ls"]);
  });

  it("puts the pieces of a line together, even when a character or a sequence is cut", () => {
    const tail = new TerminalTail();
    const bytes = encodeUtf8("a€b\x1b[31mred\x1b[0m\n");
    for (const byte of bytes) tail.feed(1, Uint8Array.of(byte));
    expect(tail.read(1, 5)).toEqual(["a€bred"]);
  });

  it("gives the last lines asked for, oldest first", () => {
    const tail = new TerminalTail();
    tail.feed(1, "1\n2\n3\n4\n5\n");
    expect(tail.read(1, 2)).toEqual(["4", "5"]);
    expect(tail.read(1, 5)).toEqual(["1", "2", "3", "4", "5"]);
    expect(tail.read(1, 50)).toEqual(["1", "2", "3", "4", "5"]);
    expect(tail.read(1, 2.9)).toEqual(["4", "5"]);
  });

  it("keeps blank lines between others and drops the blank ones at the end", () => {
    const tail = new TerminalTail();
    tail.feed(1, "a\n\nb\n\n\n   \n");
    expect(tail.read(1, 10)).toEqual(["a", "", "b"]);
  });

  it("answers an empty list for a session it never heard, and for a count that is no count", () => {
    const tail = new TerminalTail();
    tail.feed(1, "x\n");
    expect(tail.read(2, 5)).toEqual([]);
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tail.read(1, count)).toEqual([]);
    }
  });

  it("keeps the sessions apart and forgets one on request", () => {
    const tail = new TerminalTail();
    tail.feed(1, "one\n");
    tail.feed(2, "two\n");
    expect(tail.read(1, 5)).toEqual(["one"]);
    expect(tail.read(2, 5)).toEqual(["two"]);
    expect(tail.size).toBe(2);
    tail.forget(1);
    expect(tail.read(1, 5)).toEqual([]);
    expect(tail.read(2, 5)).toEqual(["two"]);
    expect(tail.size).toBe(1);
    tail.forget(1);
    tail.forget(99);
    expect(tail.size).toBe(1);
  });

  it("holds the most lines it was told to and drops the oldest", () => {
    const tail = new TerminalTail({ maxLines: 3 });
    tail.feed(1, "1\n2\n3\n4\n5\n");
    expect(tail.read(1, 10)).toEqual(["3", "4", "5"]);
  });

  it("cuts a line that is too long, finished or not", () => {
    const tail = new TerminalTail({ maxLineChars: 5 });
    tail.feed(1, "abcdefgh\nij");
    tail.feed(1, "klmnop");
    expect(tail.read(1, 10)).toEqual(["abcde", "ijklm"]);
  });

  it("holds a bounded amount however much is printed", () => {
    const tail = new TerminalTail({ maxLines: 100, maxLineChars: 50 });
    const chunk = `${"x".repeat(200)}\n`.repeat(50);
    for (let n = 0; n < 200; n++) tail.feed(1, chunk);
    const lines = tail.read(1, 10_000);
    expect(lines).toHaveLength(100);
    expect(lines.every((line) => line.length === 50)).toBe(true);
  });

  it("is the same whatever way the output is cut into chunks", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        fc.array(fc.nat(30), { maxLength: 8 }),
        (text, cuts) => {
          const bytes = encodeUtf8(`${text}\n`);
          const whole = new TerminalTail();
          whole.feed(1, bytes);
          const pieces = new TerminalTail();
          let at = 0;
          for (const cut of cuts) {
            pieces.feed(1, bytes.slice(at, at + cut));
            at += cut;
          }
          pieces.feed(1, bytes.slice(at));
          expect(pieces.read(1, 1000)).toEqual(whole.read(1, 1000));
        },
      ),
      { numRuns: 300 },
    );
  });
});

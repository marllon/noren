import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAVE_SCROLLBACK,
  MAX_SCROLLBACK_BYTES,
  MAX_SNAPSHOT_LINE,
  SCROLLBACK_SAVE_INTERVAL_MS,
  SCROLLBACK_SAVE_LINES,
  cleanSnapshot,
  formatRestoreTime,
  isScrollbackPaneId,
  restoredMarker,
  restoredTerminalText,
  savesScrollback,
  scrollbackAllowed,
  scrollbackFileName,
} from "./scrollback";
import { encodeUtf8 } from "./utf8";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

/**
 * Everything a cleaned snapshot may hold: printable text and tabs, line breaks, and a color or
 * style sequence. No other escape, no other control character, no eight-bit control.
 */
// eslint-disable-next-line no-control-regex
const SAFE_SNAPSHOT = /^(?:[^\x00-\x1f\x7f-\x9f]|\t|\n|\x1b\[[0-9;:]*m)*$/;

/** A UTF-16 unit of a surrogate pair that has no partner. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** What is written to a terminal for a snapshot: the same, with the carriage returns of the lines. */
// eslint-disable-next-line no-control-regex
const SAFE_TERMINAL_TEXT = /^(?:[^\x00-\x1f\x7f-\x9f]|\t|\r\n|\x1b\[[0-9;:]*m)*$/;

describe("which panes can have a snapshot file", () => {
  // The same cases as `is_valid_pane_id` in crates/noren-core/src/scrollback.rs.
  it("accepts the ids panes have: a UUID and the plain names of the tests", () => {
    for (const id of [
      "3f2b8c1e-9d4a-4c7b-8e21-0a5d6f7b9c11",
      "pane-1",
      "p_2",
      "id1",
      "7",
      "console",
      "com10",
      "a".repeat(64),
    ]) {
      expect(isScrollbackPaneId(id), id).toBe(true);
    }
  });

  it("refuses what is not a file name, a path included, and the device names of Windows", () => {
    for (const id of [
      "",
      ".",
      "..",
      "../escape",
      "..\\escape",
      "a/b",
      "a\\b",
      "/abs",
      "C:\\x",
      "c:x",
      "a:b",
      "a.txt",
      "a b",
      "a\0b",
      "\u202epane",
      "caf\u00e9",
      "con",
      "CON",
      "Nul",
      "aux",
      "prn",
      "com1",
      "LPT9",
      "a".repeat(65),
    ]) {
      expect(isScrollbackPaneId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it("names the file of a pane after its id", () => {
    expect(scrollbackFileName("pane-1")).toBe("pane-1.txt");
  });
});

describe("whether a pane's snapshot may be kept", () => {
  it("needs the setting of the app and the setting of the space", () => {
    expect(savesScrollback(true, true)).toBe(true);
    expect(savesScrollback(true, false)).toBe(false);
    expect(savesScrollback(false, true)).toBe(false);
    expect(savesScrollback(false, false)).toBe(false);
  });

  it("is on unless the settings say it is not", () => {
    expect(DEFAULT_SAVE_SCROLLBACK).toBe(true);
    expect(scrollbackAllowed(undefined)).toBe(true);
    expect(scrollbackAllowed({})).toBe(true);
    expect(scrollbackAllowed({ saveScrollback: undefined })).toBe(true);
    expect(scrollbackAllowed({ saveScrollback: true })).toBe(true);
    expect(scrollbackAllowed({ saveScrollback: false })).toBe(false);
  });

  it("keeps the last 2000 lines, every 60 seconds", () => {
    expect(SCROLLBACK_SAVE_LINES).toBe(2000);
    expect(SCROLLBACK_SAVE_INTERVAL_MS).toBe(60_000);
  });
});

describe("cleaning a snapshot", () => {
  it("keeps text, tabs and the colors the serializer writes", () => {
    const raw = `${ESC}[1mbold${ESC}[0m plain\ttab\r\n${ESC}[38;2;10;20;30mrgb${ESC}[39m\r\n${ESC}[48;5;200;4:3mx${ESC}[m`;
    expect(cleanSnapshot(raw)).toBe(
      `${ESC}[1mbold${ESC}[0m plain\ttab\n${ESC}[38;2;10;20;30mrgb${ESC}[39m\n${ESC}[48;5;200;4:3mx${ESC}[m`,
    );
  });

  it("puts blanks where the serializer moved over empty cells", () => {
    expect(cleanSnapshot(`a${ESC}[4Cb`)).toBe("a    b");
    expect(cleanSnapshot(`a${ESC}[Cb${ESC}[0Cc`)).toBe("a b c");
    // A move is capped, so a hostile number cannot make a huge line.
    expect(cleanSnapshot(`a${ESC}[999999Cb`).length).toBe(1002);
    // A move that is not to the right is dropped.
    expect(cleanSnapshot(`a${ESC}[4Db${ESC}[2Ac${ESC}[1;1Hd`)).toBe("abcd");
  });

  it("treats a carriage return and a line feed, together or alone, as one line break", () => {
    expect(cleanSnapshot("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(cleanSnapshot("a\n\nb")).toBe("a\n\nb");
  });

  it("drops the blank lines at the end", () => {
    expect(cleanSnapshot("one\r\ntwo\r\n\r\n   \r\n\r\n")).toBe("one\ntwo");
    expect(cleanSnapshot(`one\r\n${ESC}[0m\r\n${ESC}[2m  \r\n`)).toBe("one");
    expect(cleanSnapshot("")).toBe("");
    expect(cleanSnapshot("\r\n\r\n")).toBe("");
    expect(cleanSnapshot(`${ESC}[31m`)).toBe("");
  });

  it("keeps the blank lines in the middle", () => {
    expect(cleanSnapshot("one\r\n\r\nthree")).toBe("one\n\nthree");
  });

  it("keeps only the last lines", () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\r\n");
    const lines = cleanSnapshot(raw).split("\n");
    expect(lines).toHaveLength(SCROLLBACK_SAVE_LINES);
    expect(lines[0]).toBe("line 3000");
    expect(lines.at(-1)).toBe("line 4999");
    expect(cleanSnapshot(raw, { maxLines: 3 })).toBe("line 4997\nline 4998\nline 4999");
    expect(cleanSnapshot(raw, { maxLines: 0 })).toBe("");
  });

  it("drops the oldest lines until the text fits the limit of bytes", () => {
    const raw = ["a".repeat(100), "b".repeat(100), "c".repeat(100)].join("\r\n");
    expect(cleanSnapshot(raw, { maxBytes: 1000 })).toBe(
      [`${"a".repeat(100)}`, "b".repeat(100), "c".repeat(100)].join("\n"),
    );
    // Two lines are 201 bytes, three are 302.
    expect(cleanSnapshot(raw, { maxBytes: 250 })).toBe(`${"b".repeat(100)}\n${"c".repeat(100)}`);
    expect(cleanSnapshot(raw, { maxBytes: 150 })).toBe("c".repeat(100));
    expect(cleanSnapshot(raw, { maxBytes: 50 })).toBe("");
  });

  it("measures the limit in bytes of UTF-8, not in characters", () => {
    const line = "\u00e9".repeat(100); // 200 bytes
    expect(cleanSnapshot(`${line}\r\n${line}`, { maxBytes: 300 })).toBe(line);
    expect(cleanSnapshot(`${line}\r\n${line}`, { maxBytes: 401 })).toBe(`${line}\n${line}`);
  });

  it("cuts a line that is too long and keeps the lines after it", () => {
    const cleaned = cleanSnapshot(`${"x".repeat(MAX_SNAPSHOT_LINE + 500)}\r\nnext`);
    const [first, second] = cleaned.split("\n");
    expect(first).toHaveLength(MAX_SNAPSHOT_LINE);
    expect(second).toBe("next");
  });

  it("keeps letters of every script and emoji, and turns a lone surrogate into the replacement mark", () => {
    expect(cleanSnapshot("caf\u00e9 \u4e2d\u6587 \u{1f600} \u0645\u0631\u062d\u0628\u0627")).toBe(
      "caf\u00e9 \u4e2d\u6587 \u{1f600} \u0645\u0631\u062d\u0628\u0627",
    );
    expect(cleanSnapshot("a\ud800b")).toBe("a\ufffdb");
    expect(cleanSnapshot("a\udc00b")).toBe("a\ufffdb");
    expect(cleanSnapshot("a\ud800")).toBe("a\ufffd");
  });

  it("drops the characters that reorder text", () => {
    expect(cleanSnapshot("a\u202eb\u202ac\u2066d\u2069e")).toBe("abcde");
  });

  it("drops a color sequence that is too long or is not made only of numbers", () => {
    const longColors = `${ESC}[${"1;".repeat(100)}1m`;
    expect(cleanSnapshot(`a${longColors}b`)).toBe("ab");
    for (const sequence of [
      `${ESC}[?5m`,
      `${ESC}[>4;2m`,
      `${ESC}[1;2 m`,
      `${ESC}[1;2$m`,
      `${ESC}[<1m`,
    ]) {
      expect(cleanSnapshot(`a${sequence}b`), JSON.stringify(sequence)).toBe("ab");
    }
  });

  it("gives the same text when it is cleaned again", () => {
    const raw = `${ESC}[31mred${ESC}[0m${ESC}[3Cx\r\n${ESC}]0;title${BEL}b\r\n\r\n`;
    const once = cleanSnapshot(raw);
    expect(cleanSnapshot(once)).toBe(once);
  });
});

// What reaches a terminal from a file on disk. Each of these is a real sequence that would change
// the terminal, put text in the clipboard or make the terminal send bytes to the shell.
const HOSTILE: [string, string][] = [
  ["the clipboard (OSC 52), ended by BEL", `${ESC}]52;c;SGVsbG8=${BEL}`],
  ["the clipboard (OSC 52), ended by ST", `${ESC}]52;c;SGVsbG8=${ST}`],
  ["the clipboard (OSC 52), asking to read it", `${ESC}]52;c;?${BEL}`],
  ["the clipboard (OSC 52), ended by the eight-bit ST", `${ESC}]52;c;SGVsbG8=\u009c`],
  ["the title of the window (OSC 0)", `${ESC}]0;evil title${BEL}`],
  ["the title of the window (OSC 2)", `${ESC}]2;evil title${ST}`],
  ["a notification (OSC 9)", `${ESC}]9;you won${BEL}`],
  ["a notification (OSC 777)", `${ESC}]777;notify;title;body${BEL}`],
  ["the folder of the shell (OSC 7)", `${ESC}]7;file://host/etc${BEL}`],
  ["a hyperlink (OSC 8)", `${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`],
  ["the prompt marks (OSC 133)", `${ESC}]133;A${BEL}`],
  ["a string that never ends", `${ESC}]52;c;AAAA`],
  ["the alternate screen", `${ESC}[?1049h`],
  ["mouse tracking", `${ESC}[?1000h${ESC}[?1006h${ESC}[?1003h`],
  ["bracketed paste", `${ESC}[?2004h`],
  ["focus reporting", `${ESC}[?1004h`],
  ["a hidden cursor", `${ESC}[?25l`],
  ["application keys", `${ESC}[?1h${ESC}=`],
  ["a mode of the keyboard", `${ESC}[>4;2m${ESC}[>1u`],
  ["a report of the cursor position (makes the terminal answer)", `${ESC}[6n`],
  ["a report of the state (makes the terminal answer)", `${ESC}[5n`],
  ["a request for the device attributes (makes the terminal answer)", `${ESC}[c${ESC}[>c${ESC}[=c`],
  ["a request for the identity of the terminal", `${ESC}Z`],
  ["a request for the version of the terminal", `${ESC}[>0q`],
  ["a request for the title (makes the terminal answer)", `${ESC}[21t${ESC}[20t`],
  ["a request for the size of the window", `${ESC}[18t${ESC}[14t`],
  ["a request for a mode (makes the terminal answer)", `${ESC}[?2004$p${ESC}[4$p`],
  ["a request for a setting (DECRQSS, makes the terminal answer)", `${ESC}P$qm${ST}`],
  ["the answerback request (ENQ)", "\x05"],
  ["a reset of the terminal", `${ESC}c${ESC}[!p`],
  ["a clear of the screen and of the history", `${ESC}[2J${ESC}[3J${ESC}[H`],
  ["a move of the cursor", `${ESC}[10;10H${ESC}[5A${ESC}[3B${ESC}[2D`],
  ["a graphics string (APC)", `${ESC}_Gi=1,a=q;AAAA${ST}`],
  ["a sixel string (DCS)", `${ESC}Pq#0;2;0;0;0${ST}`],
  ["a privacy message (PM)", `${ESC}^secret${ST}`],
  ["a character set", `${ESC}(0${ESC})B${ESC}#8`],
  ["the bell", BEL],
  ["a backspace, a vertical tab, a form feed, a shift out", "\b\v\f\x0e\x0f"],
  ["the null character and DEL", "\0\x7f"],
  ["the eight-bit CSI asking for the cursor position", "\u009b6n"],
  ["the eight-bit OSC for the clipboard", "\u009d52;c;SGVsbG8=\u009c"],
  ["the eight-bit DCS", "\u0090$qm\u009c"],
  ["an escape that ends the file", ESC],
  ["an escape with an unfinished sequence", `${ESC}[`],
  ["an escape followed by a line break", `${ESC}\nb`],
];

describe("a snapshot that was changed on disk", () => {
  for (const [what, sequence] of HOSTILE) {
    it(`cannot change the terminal: ${what}`, () => {
      const cleaned = cleanSnapshot(`before ${sequence} after\r\nnext line`);
      expect(cleaned).toMatch(SAFE_SNAPSHOT);
      // What is not an attack is still there.
      expect(cleaned).toContain("before");
      expect(cleaned.split("\n").at(-1)).toBe("next line");
      // And what is written to a terminal is as safe.
      expect(restoredTerminalText(`before ${sequence} after\r\nnext line`, 0)).toMatch(
        SAFE_TERMINAL_TEXT,
      );
    });
  }

  it("keeps a line after a string sequence that never ends", () => {
    const cleaned = cleanSnapshot(`${ESC}]52;c;AAAA\nsecond\nthird`);
    expect(cleaned).toBe("\nsecond\nthird");
  });

  it("cannot get a sequence through by splitting it with a character that is dropped", () => {
    // The ESC and the rest of the sequence are separated by characters the cleaner removes; once
    // they are gone the pieces must not come together into a sequence.
    for (const raw of [
      `${ESC}\0]52;c;AAAA${BEL}`,
      `${ESC}\x7f[6n`,
      `${ESC}\u202e[6n`,
      `${ESC}\u009b6n`,
      `\u009b${ESC}6n`,
      `${ESC}${ESC}[6n`,
      `${ESC}[${ESC}[6n`,
      `${ESC}[\x006n`,
      `${ESC}]${ESC}\\]52;c;AAAA${BEL}`,
    ]) {
      const cleaned = cleanSnapshot(raw);
      expect(cleaned, JSON.stringify(raw)).toMatch(SAFE_SNAPSHOT);
      expect(cleaned, JSON.stringify(raw)).not.toContain(ESC);
    }
  });

  it("never lets anything but text and colors through, for any text at all", () => {
    const piece = fc.oneof(
      fc.string({ unit: "binary" }),
      fc.constantFrom(
        ESC,
        `${ESC}[`,
        `${ESC}]`,
        `${ESC}[6n`,
        `${ESC}]52;c;AAAA${BEL}`,
        `${ESC}[31m`,
        `${ESC}[0m`,
        `${ESC}[3C`,
        `${ESC}P`,
        ST,
        BEL,
        "\r",
        "\n",
        "\r\n",
        "\t",
        "\u009b",
        "\u009d",
        "\u009c",
        "\ud800",
        "\udc00",
        "\u202e",
        ";",
        "?",
        "m",
        "C",
      ),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }), (pieces) => {
        const raw = pieces.join("");
        const cleaned = cleanSnapshot(raw);
        expect(cleaned).toMatch(SAFE_SNAPSHOT);
        expect(cleanSnapshot(cleaned)).toBe(cleaned);
        expect(restoredTerminalText(raw, 0)).toMatch(SAFE_TERMINAL_TEXT);
        // No lone surrogate reaches the disk (a JSON text with one would not reach the Rust side).
        expect(cleaned).not.toMatch(LONE_SURROGATE);
      }),
      { numRuns: 400 },
    );
  });

  it("stays inside the limits of lines and bytes, for any text at all", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 3000 }),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 400 }),
        (raw, maxLines, maxBytes) => {
          const cleaned = cleanSnapshot(raw, { maxLines, maxBytes });
          if (cleaned !== "") expect(cleaned.split("\n").length).toBeLessThanOrEqual(maxLines);
          expect(encodeUtf8(cleaned).length).toBeLessThanOrEqual(maxBytes);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is never longer, in bytes, than a snapshot the store accepts", () => {
    // 3000 lines of 400 colored cells each is far more than the store takes.
    const line = Array.from({ length: 400 }, () => `${ESC}[38;2;255;100;50mx`).join("");
    const raw = Array.from({ length: 3000 }, () => line).join("\r\n");
    const cleaned = cleanSnapshot(raw);
    expect(encodeUtf8(cleaned).length).toBeLessThanOrEqual(MAX_SCROLLBACK_BYTES);
    expect(cleaned.length).toBeGreaterThan(0);
  });
});

describe("showing a snapshot again", () => {
  const at = new Date(2026, 9, 19, 14, 5, 59).getTime();

  it("formats the time in the time zone of the computer, to the minute", () => {
    expect(formatRestoreTime(at)).toBe("2026-10-19 14:05");
    expect(formatRestoreTime(new Date(2027, 0, 2, 3, 4).getTime())).toBe("2027-01-02 03:04");
    expect(restoredMarker(at)).toBe("session restored 2026-10-19 14:05");
  });

  it("shows nothing for a pane that has nothing saved", () => {
    expect(restoredTerminalText("", at)).toBe("");
    expect(restoredTerminalText("\r\n  \r\n", at)).toBe("");
    expect(restoredTerminalText(`${ESC}]52;c;AAAA${BEL}`, at)).toBe("");
  });

  it("dims the old text, ends it with the marker line and leaves the cursor on a new line", () => {
    const text = restoredTerminalText("first\nsecond", at);
    expect(text).toBe(
      `${ESC}[0m${ESC}[2mfirst\r\nsecond${ESC}[0m\r\n${ESC}[2msession restored 2026-10-19 14:05${ESC}[0m\r\n`,
    );
  });

  it("puts the dimming back after every color, so a reset in the old text does not end it", () => {
    const text = restoredTerminalText(`${ESC}[31mred${ESC}[0m plain\n${ESC}[1mbold${ESC}[22m`, at);
    expect(text).toContain(`${ESC}[31m${ESC}[2mred${ESC}[0m${ESC}[2m plain`);
    expect(text).toContain(`${ESC}[1m${ESC}[2mbold${ESC}[22m${ESC}[2m`);
    // The color is kept: it is dimmed, not replaced.
    expect(text.indexOf(`${ESC}[31m`)).toBeLessThan(text.indexOf("red"));
  });

  it("does not reset the style between lines, because the serializer leaves out an unchanged color", () => {
    const text = restoredTerminalText(`${ESC}[32mgreen\nstill green${ESC}[0m`, at);
    const between = text.slice(text.indexOf("green"), text.indexOf("still"));
    expect(between).toBe("green\r\n");
  });

  it("cleans what it is given, so a text that never went through the cleaner is safe too", () => {
    const text = restoredTerminalText(`ok${ESC}]52;c;SGVsbG8=${BEL} more${ESC}[6n\u009b6n\x05`, at);
    expect(text).toMatch(SAFE_TERMINAL_TEXT);
    expect(text).toContain("ok more");
    expect(text).not.toContain("52");
  });

  it("writes only the last 2000 lines, whatever was in the file", () => {
    const raw = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const text = restoredTerminalText(raw, at);
    expect(text.split("\r\n").filter((line) => line.includes("line "))).toHaveLength(
      SCROLLBACK_SAVE_LINES,
    );
    expect(text).not.toContain("line 1999\r\n");
    expect(text).toContain("line 2000");
  });
});

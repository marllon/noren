import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { keySequence, keySequences } from "./api-keys";

// The key names of `terminal.send` and the bytes a terminal gets for them (NOR-F17-01b).

describe("keySequence", () => {
  it("knows the keys of the keyboard that have no letter", () => {
    const table: [string, string][] = [
      ["Enter", "\r"],
      ["Return", "\r"],
      ["Tab", "\t"],
      ["Escape", "\x1b"],
      ["Esc", "\x1b"],
      ["Backspace", "\x7f"],
      ["Space", " "],
      ["Up", "\x1b[A"],
      ["Down", "\x1b[B"],
      ["Right", "\x1b[C"],
      ["Left", "\x1b[D"],
      ["Home", "\x1b[H"],
      ["End", "\x1b[F"],
      ["Insert", "\x1b[2~"],
      ["Delete", "\x1b[3~"],
      ["Del", "\x1b[3~"],
      ["PageUp", "\x1b[5~"],
      ["PageDown", "\x1b[6~"],
      ["F1", "\x1bOP"],
      ["F2", "\x1bOQ"],
      ["F3", "\x1bOR"],
      ["F4", "\x1bOS"],
      ["F5", "\x1b[15~"],
      ["F6", "\x1b[17~"],
      ["F7", "\x1b[18~"],
      ["F8", "\x1b[19~"],
      ["F9", "\x1b[20~"],
      ["F10", "\x1b[21~"],
      ["F11", "\x1b[23~"],
      ["F12", "\x1b[24~"],
    ];
    for (const [name, bytes] of table) expect(keySequence(name), name).toBe(bytes);
  });

  it("does not care for the case of a name", () => {
    expect(keySequence("enter")).toBe("\r");
    expect(keySequence("ENTER")).toBe("\r");
    expect(keySequence("pageup")).toBe("\x1b[5~");
    expect(keySequence("CTRL+c")).toBe("\x03");
    expect(keySequence("ctrl+ALT+Up")).toBe(keySequence("Alt+Ctrl+up"));
  });

  it("gives a letter or a digit as it is, and Ctrl the control character of the letter", () => {
    expect(keySequence("a")).toBe("a");
    expect(keySequence("7")).toBe("7");
    expect(keySequence("Ctrl+A")).toBe("\x01");
    expect(keySequence("Ctrl+C")).toBe("\x03");
    expect(keySequence("Ctrl+D")).toBe("\x04");
    expect(keySequence("Ctrl+Z")).toBe("\x1a");
    expect(keySequence("Ctrl+Space")).toBe("\0");
    expect(keySequence("Shift+a")).toBe("A");
    expect(keySequence("Alt+b")).toBe("\x1bb");
    expect(keySequence("Alt+Ctrl+c")).toBe("\x1b\x03");
    expect(keySequence("Alt+Enter")).toBe("\x1b\r");
    expect(keySequence("Alt+Backspace")).toBe("\x1b\x7f");
  });

  it("numbers the modifiers of a cursor, tilde or function key the way xterm does", () => {
    expect(keySequence("Shift+Up")).toBe("\x1b[1;2A");
    expect(keySequence("Alt+Left")).toBe("\x1b[1;3D");
    expect(keySequence("Ctrl+Right")).toBe("\x1b[1;5C");
    expect(keySequence("Ctrl+Shift+Home")).toBe("\x1b[1;6H");
    expect(keySequence("Ctrl+Alt+End")).toBe("\x1b[1;7F");
    expect(keySequence("Ctrl+Delete")).toBe("\x1b[3;5~");
    expect(keySequence("Shift+PageUp")).toBe("\x1b[5;2~");
    expect(keySequence("Ctrl+F5")).toBe("\x1b[15;5~");
    expect(keySequence("Ctrl+F1")).toBe("\x1b[1;5P");
    expect(keySequence("Shift+Tab")).toBe("\x1b[Z");
    expect(keySequence("Alt+Shift+Tab")).toBe("\x1b\x1b[Z");
  });

  it("has no bytes for a name it does not know, and does not guess", () => {
    for (const name of [
      "",
      "+",
      "Ctrl+",
      "Ctrl++",
      "Meta",
      "Super+a",
      "Hyper+Q",
      "F0",
      "F13",
      "Ctrl+Ctrl+a",
      "Alt+Alt+a",
      "Shift+Shift+a",
      "Ctrl+Shift+a",
      "Ctrl+1",
      "Shift+1",
      "Shift+Enter",
      "Ctrl+Enter",
      "Ctrl+Escape",
      "Ctrl+Backspace",
      "Shift+Space",
      "Ctrl+Tab",
      "Ab",
      "Enterx",
      " Enter",
      "Enter ",
      "é",
      "Ctrl+é",
      "Plus",
      "Ctrl+Shift+Tab",
    ]) {
      expect(keySequence(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it("never adds a line end the name did not ask for", () => {
    const names = ["a", "Ctrl+C", "Tab", "Up", "F5", "Alt+x", "Escape", "Space", "Backspace"];
    for (const name of names) {
      expect(keySequence(name)).not.toMatch(/[\r\n]/);
    }
    // Enter is the one key that is a line end, and only when it is named.
    expect(keySequence("Enter")).toBe("\r");
  });

  it("never throws, and gives only printable ASCII and escapes", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        const bytes = keySequence(name);
        if (bytes !== undefined) {
          expect(bytes.length).toBeGreaterThan(0);
          // eslint-disable-next-line no-control-regex
          expect(bytes).toMatch(/^[\x00-\x7f]+$/);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("keySequences", () => {
  it("joins the bytes of the keys in order", () => {
    expect(keySequences(["Up", "Up", "Enter"])).toEqual({ ok: true, bytes: "\x1b[A\x1b[A\r" });
    expect(keySequences([])).toEqual({ ok: true, bytes: "" });
  });

  it("names the first key it does not know and gives no bytes at all", () => {
    expect(keySequences(["Enter", "Nope", "Other"])).toEqual({ ok: false, unknown: "Nope" });
  });
});

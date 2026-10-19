import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OSC_BYTES,
  ShellIntegrationParser,
  encodeUtf8,
  parseOsc,
  pathFromFileUri,
  pathFromPlainPath,
  unescapeCommandLine,
} from "./index";
import type { ShellEvent } from "./index";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

function osc(payload: string, terminator: string = BEL): string {
  return `${ESC}]${payload}${terminator}`;
}

function parseAll(text: string): ShellEvent[] {
  return new ShellIntegrationParser().feed(text);
}

/** Feeds `bytes` cut at the given offsets and joins the events. */
function parseCut(bytes: Uint8Array, cuts: readonly number[]): ShellEvent[] {
  const parser = new ShellIntegrationParser();
  const points = [...new Set([0, ...cuts, bytes.length])].sort((a, b) => a - b);
  const events: ShellEvent[] = [];
  for (let i = 1; i < points.length; i++) {
    events.push(...parser.feed(bytes.subarray(points[i - 1], points[i])));
  }
  return events;
}

describe("each kind of sequence", () => {
  it("OSC 7 gives the folder", () => {
    expect(parseAll(osc("7;file://PC/C:/Users/me"))).toEqual([
      { kind: "cwd", path: "C:/Users/me" },
    ]);
    expect(parseAll(osc("7;file:///home/me/my%20dir"))).toEqual([
      { kind: "cwd", path: "/home/me/my dir" },
    ]);
  });

  it("OSC 7 with something that is not a folder gives nothing", () => {
    expect(parseAll(osc("7;http://host/x"))).toEqual([]);
    expect(parseAll(osc("7;file://host"))).toEqual([]);
    expect(parseAll(osc("7;file:///a%00b"))).toEqual([]);
    expect(parseAll(osc("7;file:///%E0%A4%A"))).toEqual([]);
    expect(parseAll(osc("7"))).toEqual([]);
  });

  it("OSC 9;9 gives the folder, as cmd writes it (ST or BEL, with or without quotes)", () => {
    expect(parseAll(osc("9;9;C:\\Users\\me", ST))).toEqual([{ kind: "cwd", path: "C:/Users/me" }]);
    expect(parseAll(osc("9;9;C:\\Users\\me"))).toEqual([{ kind: "cwd", path: "C:/Users/me" }]);
    expect(parseAll(osc('9;9;"D:\\My Projects\\x"', ST))).toEqual([
      { kind: "cwd", path: "D:/My Projects/x" },
    ]);
    expect(parseAll(osc("9;9;C:\\", ST))).toEqual([{ kind: "cwd", path: "C:/" }]);
    expect(parseAll(osc("9;9;\\\\srv\\share\\dir", ST))).toEqual([
      { kind: "cwd", path: "//srv/share/dir" },
    ]);
    expect(parseAll(osc("9;9;/home/me/dir"))).toEqual([{ kind: "cwd", path: "/home/me/dir" }]);
  });

  it("OSC 9;9 with something that is not a folder gives nothing", () => {
    expect(parseAll(osc("9;9"))).toEqual([]);
    expect(parseAll(osc("9;9;"))).toEqual([]);
    expect(parseAll(osc("9;9;relative\\dir"))).toEqual([]);
    expect(parseAll(osc("9;9;C:\\a\u0001b"))).toEqual([]);
    expect(parseAll(osc(`9;9;C:\\${"a".repeat(5000)}`))).toEqual([]);
  });

  it("other OSC 9 sequences are not read as a folder (notifications and progress stay free)", () => {
    expect(parseAll(osc("9;Build finished"))).toEqual([]);
    expect(parseAll(osc("9;C:\\Users\\me"))).toEqual([]);
    expect(parseAll(osc("9;4;1;50"))).toEqual([]);
    expect(parseAll(osc("9;99;C:\\x"))).toEqual([]);
    expect(parseAll(osc("9"))).toEqual([]);
    expect(parseAll(osc("99;9;C:\\x"))).toEqual([]);
    // A folder between two of them is still found, and the others do not hide it.
    expect(
      parseAll(`${osc("9;Done")}${osc("9;9;C:\\w", ST)}${osc("9;4;0;0")}${osc("133;A")}`),
    ).toEqual([{ kind: "cwd", path: "C:/w" }, { kind: "prompt-start" }]);
  });

  it("OSC 133 marks the prompt and the command", () => {
    expect(parseAll(osc("133;A"))).toEqual([{ kind: "prompt-start" }]);
    expect(parseAll(osc("133;B"))).toEqual([{ kind: "prompt-end" }]);
    expect(parseAll(osc("133;C"))).toEqual([{ kind: "command-start" }]);
  });

  it("OSC 133;D carries the exit code when there is one", () => {
    expect(parseAll(osc("133;D;0"))).toEqual([{ kind: "command-end", exitCode: 0 }]);
    expect(parseAll(osc("133;D;3"))).toEqual([{ kind: "command-end", exitCode: 3 }]);
    expect(parseAll(osc("133;D;-1"))).toEqual([{ kind: "command-end", exitCode: -1 }]);
    expect(parseAll(osc("133;D"))).toEqual([{ kind: "command-end", exitCode: undefined }]);
    expect(parseAll(osc("133;D;"))).toEqual([{ kind: "command-end", exitCode: undefined }]);
    expect(parseAll(osc("133;D;abc"))).toEqual([{ kind: "command-end", exitCode: undefined }]);
    expect(parseAll(osc("133;D;12345678901234"))).toEqual([
      { kind: "command-end", exitCode: undefined },
    ]);
  });

  it("OSC 133 options after the letter are ignored", () => {
    expect(parseAll(osc("133;A;aid=7;cl=m"))).toEqual([{ kind: "prompt-start" }]);
    expect(parseAll(osc("133;D;2;aid=7"))).toEqual([{ kind: "command-end", exitCode: 2 }]);
  });

  it("OSC 133 with an unknown letter gives nothing", () => {
    expect(parseAll(osc("133;Z"))).toEqual([]);
    expect(parseAll(osc("133"))).toEqual([]);
    expect(parseAll(osc("133;"))).toEqual([]);
  });

  it("OSC 633;E gives the command line, unescaped", () => {
    expect(parseAll(osc("633;E;git status"))).toEqual([
      { kind: "command-line", text: "git status" },
    ]);
    expect(parseAll(osc("633;E;echo a\\x3b b\\x0aline2 C:\\\\dir"))).toEqual([
      { kind: "command-line", text: "echo a; b\nline2 C:\\dir" },
    ]);
    expect(parseAll(osc("633;E;"))).toEqual([{ kind: "command-line", text: "" }]);
    expect(parseAll(osc("633;E;déjà vu ✓"))).toEqual([{ kind: "command-line", text: "déjà vu ✓" }]);
  });

  it("OSC 633;E drops the nonce after the command line", () => {
    expect(parseAll(osc("633;E;ls -l;4f2a9c"))).toEqual([{ kind: "command-line", text: "ls -l" }]);
  });

  it("OSC 633 with another letter gives nothing", () => {
    expect(parseAll(osc("633;A"))).toEqual([]);
    expect(parseAll(osc("633;Ex"))).toEqual([]);
    expect(parseAll(osc("633"))).toEqual([]);
  });
});

describe("terminators", () => {
  it("accepts BEL and ST", () => {
    expect(parseAll(osc("133;A", BEL))).toEqual([{ kind: "prompt-start" }]);
    expect(parseAll(osc("133;A", ST))).toEqual([{ kind: "prompt-start" }]);
  });

  it("an unterminated sequence gives nothing until it ends", () => {
    const parser = new ShellIntegrationParser();
    expect(parser.feed(`${ESC}]133;D;3`)).toEqual([]);
    expect(parser.pendingBytes).toBe("133;D;3".length);
    expect(parser.feed(BEL)).toEqual([{ kind: "command-end", exitCode: 3 }]);
    expect(parser.pendingBytes).toBe(0);
  });

  it("ESC followed by something other than a backslash abandons the sequence", () => {
    // The first OSC is cut by `ESC [`; the next one is read normally.
    expect(parseAll(`${ESC}]133;A${ESC}[31m${osc("133;B")}`)).toEqual([{ kind: "prompt-end" }]);
    // ESC ] inside an OSC starts a new one.
    expect(parseAll(`${ESC}]133;A${osc("133;C")}`)).toEqual([{ kind: "command-start" }]);
  });

  it("CAN and SUB cancel a sequence", () => {
    expect(parseAll(`${ESC}]133;A\x18${BEL}${osc("133;B")}`)).toEqual([{ kind: "prompt-end" }]);
    expect(parseAll(`${ESC}]133;A\x1a${BEL}`)).toEqual([]);
  });

  it("a lone ESC, or ESC ESC ], still opens a sequence", () => {
    expect(parseAll(`${ESC}${ESC}]133;A${BEL}`)).toEqual([{ kind: "prompt-start" }]);
    expect(parseAll(`${ESC}x${osc("133;A")}`)).toEqual([{ kind: "prompt-start" }]);
  });
});

describe("a stream", () => {
  it("returns several sequences of one chunk in order, with text around them", () => {
    const text =
      `PS C:\\> ${osc("133;D;1")}${osc("7;file://pc/C:/proj")}${osc("133;A")}` +
      `PS C:\\proj> ${osc("133;B", ST)}ls\r\n${osc("633;E;ls")}${osc("133;C")}output`;
    expect(parseAll(text)).toEqual([
      { kind: "command-end", exitCode: 1 },
      { kind: "cwd", path: "C:/proj" },
      { kind: "prompt-start" },
      { kind: "prompt-end" },
      { kind: "command-line", text: "ls" },
      { kind: "command-start" },
    ]);
  });

  it("ignores unknown OSC sequences and other escapes", () => {
    const text =
      `${osc("0;window title")}${osc("9;4;1;50")}${osc("777;notify;a;b")}${ESC}[31mred${ESC}[0m` +
      `${osc("133;A")}${osc("1337;x=y", ST)}${osc("")}`;
    expect(parseAll(text)).toEqual([{ kind: "prompt-start" }]);
  });

  it("keeps working after an unknown sequence in the middle of a split", () => {
    const parser = new ShellIntegrationParser();
    expect(parser.feed(`${ESC}]0;ti`)).toEqual([]);
    expect(parser.feed(`tle${BEL}${ESC}]133;`)).toEqual([]);
    expect(parser.feed("A" + BEL)).toEqual([{ kind: "prompt-start" }]);
  });

  it("text without sequences gives nothing and holds nothing", () => {
    const parser = new ShellIntegrationParser();
    expect(parser.feed("plain output\r\n".repeat(100))).toEqual([]);
    expect(parser.pendingBytes).toBe(0);
  });

  it("reads bytes and text alike", () => {
    const text = osc("633;E;echo ✓");
    expect(new ShellIntegrationParser().feed(encodeUtf8(text))).toEqual(parseAll(text));
  });

  it("reset forgets an unfinished sequence", () => {
    const parser = new ShellIntegrationParser();
    parser.feed(`${ESC}]133;`);
    parser.reset();
    expect(parser.pendingBytes).toBe(0);
    expect(parser.feed(`A${BEL}`)).toEqual([]);
  });
});

describe("a sequence split between chunks", () => {
  const stream =
    `lead${osc("133;D;3")}${osc("7;file://pc/C:/my%20dir", ST)}${osc("133;A")}` +
    `${osc("633;E;echo ✓ \\x3b x")}${osc("133;C")}${osc("9;Note")}${osc("9;9;E:\\ünï\\d", ST)}tail`;
  const bytes = encodeUtf8(stream);
  const whole = parseAll(stream);

  it("the whole stream has the expected events", () => {
    expect(whole).toEqual([
      { kind: "command-end", exitCode: 3 },
      { kind: "cwd", path: "C:/my dir" },
      { kind: "prompt-start" },
      { kind: "command-line", text: "echo ✓ ; x" },
      { kind: "command-start" },
      { kind: "cwd", path: "E:/ünï/d" },
    ]);
  });

  it("gives the same events cut at every single byte", () => {
    for (let at = 1; at < bytes.length; at++) {
      expect(parseCut(bytes, [at]), `cut at ${at}`).toEqual(whole);
    }
  });

  it("gives the same events fed one byte at a time", () => {
    const every = Array.from({ length: bytes.length }, (_, i) => i);
    expect(parseCut(bytes, every)).toEqual(whole);
  });

  it("is not confused by a multi-byte character cut in the middle", () => {
    const at = bytes.indexOf(0xe2) + 1; // inside the three bytes of ✓
    expect(at).toBeGreaterThan(0);
    expect(parseCut(bytes, [at, at + 1])).toEqual(whole);
  });
});

describe("the cap on what is held", () => {
  it("drops a sequence longer than the cap and keeps the next one", () => {
    const parser = new ShellIntegrationParser({ maxOscBytes: 16 });
    const events = parser.feed(`${osc(`633;E;${"x".repeat(100)}`)}${osc("133;A")}`);
    expect(events).toEqual([{ kind: "prompt-start" }]);
  });

  it("holds at most the cap while a long sequence goes by, then recovers", () => {
    const parser = new ShellIntegrationParser({ maxOscBytes: 16 });
    parser.feed(`${ESC}]633;E;`);
    for (let i = 0; i < 1000; i++) {
      parser.feed("y".repeat(50));
      expect(parser.pendingBytes).toBeLessThanOrEqual(16);
    }
    expect(parser.feed(`${BEL}${osc("133;B")}`)).toEqual([{ kind: "prompt-end" }]);
    expect(parser.pendingBytes).toBe(0);
  });

  it("a dropped sequence ends with ST as well", () => {
    const parser = new ShellIntegrationParser({ maxOscBytes: 8 });
    expect(parser.feed(`${osc("133;" + "z".repeat(40), ST)}${osc("133;C")}`)).toEqual([
      { kind: "command-start" },
    ]);
  });

  it("a payload exactly at the cap is kept", () => {
    const parser = new ShellIntegrationParser({ maxOscBytes: 6 });
    expect(parser.feed(osc("133;A"))).toEqual([{ kind: "prompt-start" }]);
    expect(parser.feed(osc("133;D;7"))).toEqual([]);
  });

  it("the default cap fits a long command line", () => {
    const line = "a".repeat(DEFAULT_MAX_OSC_BYTES - 20);
    expect(parseAll(osc(`633;E;${line}`))).toEqual([{ kind: "command-line", text: line }]);
    expect(parseAll(osc(`633;E;${"a".repeat(DEFAULT_MAX_OSC_BYTES)}`))).toEqual([]);
  });

  it("a cap below one is raised to one", () => {
    const parser = new ShellIntegrationParser({ maxOscBytes: 0 });
    expect(parser.feed(osc("7"))).toEqual([]);
    expect(parser.feed(osc("133;A"))).toEqual([]);
    expect(parser.feed(osc("133;A"))).toEqual([]);
  });
});

describe("helpers", () => {
  it("unescapeCommandLine undoes backslash and hex escapes only", () => {
    expect(unescapeCommandLine("a\\\\b")).toBe("a\\b");
    expect(unescapeCommandLine("a\\x3bb\\x0D\\x0a")).toBe("a;b\r\n");
    expect(unescapeCommandLine("a\\nb\\xZZ\\x1")).toBe("a\\nb\\xZZ\\x1");
    // The backslash of an escape is not read twice.
    expect(unescapeCommandLine("\\\\x3b")).toBe("\\x3b");
  });

  it("pathFromFileUri is the same reading as the OSC 7 handler of the app", () => {
    expect(pathFromFileUri("file://h/C:/a")).toBe("C:/a");
    expect(pathFromFileUri("file://h/C:")).toBe("C:");
    expect(pathFromFileUri("file://h/usr/x")).toBe("/usr/x");
    expect(pathFromFileUri("  file://h/x  ")).toBe("/x");
    expect(pathFromFileUri("FILE://h/x")).toBe("/x");
    expect(pathFromFileUri(`file://h/${"a".repeat(5000)}`)).toBeUndefined();
    expect(pathFromFileUri("")).toBeUndefined();
  });

  it("pathFromPlainPath reads an absolute path and nothing else", () => {
    expect(pathFromPlainPath("C:\\a\\b")).toBe("C:/a/b");
    expect(pathFromPlainPath("  c:/a  ")).toBe("c:/a");
    expect(pathFromPlainPath('"C:\\a b"')).toBe("C:/a b");
    expect(pathFromPlainPath("C:")).toBe("C:");
    expect(pathFromPlainPath("/usr/x")).toBe("/usr/x");
    expect(pathFromPlainPath("a\\b")).toBeUndefined();
    expect(pathFromPlainPath("C:x")).toBeUndefined();
    expect(pathFromPlainPath("")).toBeUndefined();
    expect(pathFromPlainPath('""')).toBeUndefined();
  });

  it("parseOsc takes the payload alone", () => {
    expect(parseOsc("133;A")).toEqual({ kind: "prompt-start" });
    expect(parseOsc("0;title")).toBeUndefined();
    expect(parseOsc("")).toBeUndefined();
  });
});

/** What the PowerShell script does to a command line: `\\`, and `\xNN` for `;` and controls. */
function escapeLine(line: string): string {
  let out = "";
  for (const ch of line) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === ";" || code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return out;
}

function withoutControl(text: string): string {
  return [...text].filter((ch) => ch.charCodeAt(0) >= 0x20).join("");
}

describe("property: any chunking gives the same events", () => {
  const sequence = fc.oneof(
    fc.constant(osc("133;A")),
    fc.constant(osc("133;B", ST)),
    fc.constant(osc("133;C")),
    fc.integer({ min: -3, max: 255 }).map((code) => osc(`133;D;${code}`)),
    fc.constant(osc("133;D", ST)),
    fc
      .string({ unit: "grapheme", maxLength: 20 })
      .map((p) => osc(`7;file://pc/${encodeURIComponent(p)}`, ST)),
    fc.string({ unit: "grapheme", maxLength: 40 }).map((c) => osc(`633;E;${escapeLine(c)}`)),
    fc.string({ unit: "grapheme", maxLength: 12 }).map((p) => osc(`9;${withoutControl(p)}`)),
    fc
      .string({ unit: "grapheme", maxLength: 12 })
      .map((p) => osc(`9;9;C:\\${withoutControl(p)}`, ST)),
    fc.constant(`${ESC}[31m`),
    fc.constant(`${ESC}]133;A${ESC}[0m`),
    fc.constant(`${ESC}]633;E;cut${ESC}`),
    fc.string({ unit: "binary", maxLength: 20 }),
  );
  const stream = fc.array(sequence, { maxLength: 12 }).map((parts) => parts.join(""));

  it("a command line escaped like the script does comes back as typed", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 60 }), (line) => {
        expect(parseAll(osc(`633;E;${escapeLine(line)}`))).toEqual([
          { kind: "command-line", text: line },
        ]);
      }),
      { numRuns: 300 },
    );
  });

  it("cut at random points", () => {
    fc.assert(
      fc.property(stream, fc.array(fc.nat(400), { maxLength: 30 }), (text, cuts) => {
        const bytes = encodeUtf8(text);
        const valid = cuts.map((cut) => cut % (bytes.length + 1));
        expect(parseCut(bytes, valid)).toEqual(parseAll(text));
      }),
      { numRuns: 400 },
    );
  });

  it("cut at random points with a small cap", () => {
    fc.assert(
      fc.property(stream, fc.array(fc.nat(400), { maxLength: 30 }), (text, cuts) => {
        const bytes = encodeUtf8(text);
        const small = () => new ShellIntegrationParser({ maxOscBytes: 24 });
        const expected = small().feed(bytes);
        const parser = small();
        const points = [...new Set([0, ...cuts.map((c) => c % (bytes.length + 1)), bytes.length])];
        points.sort((a, b) => a - b);
        const got: ShellEvent[] = [];
        for (let i = 1; i < points.length; i++) {
          got.push(...parser.feed(bytes.subarray(points[i - 1], points[i])));
          expect(parser.pendingBytes).toBeLessThanOrEqual(24);
        }
        expect(got).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });
});

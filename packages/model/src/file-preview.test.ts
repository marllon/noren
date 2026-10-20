import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_PATH,
  MAX_PREVIEW_TEXT_BYTES,
  PREVIEW_REFUSALS,
  classifyPreviewPath,
  decodeFilePreview,
  formatJson,
  isPreviewPath,
  previewFileName,
  previewOf,
  previewPathProblem,
  previewTextKind,
  sniffPreviewImage,
} from "./file-preview";
import { encodeUtf8 } from "./utf8";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46];
const GIF = [...encodeUtf8("GIF89a"), 1, 0, 1, 0];
const WEBP = [...encodeUtf8("RIFF"), 0, 0, 0, 0, ...encodeUtf8("WEBPVP8 ")];
const bytes = (values: readonly number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => encodeUtf8(value);

describe("the path of a preview pane", () => {
  it.each([
    ["/home/me/notes.md"],
    ["/"],
    ["C:\\Users\\me\\notes.md"],
    ["c:/users/me/notes.md"],
    ["D:\\a b\\c d.txt"],
    ["/home/me/../you/a.md"],
    ["/tmp/a\\b"],
  ])("accepts the full path %s", (path) => {
    expect(classifyPreviewPath(path)).toBe("ok");
    expect(previewPathProblem(path)).toBeUndefined();
    expect(isPreviewPath(path)).toBe(true);
  });

  it.each([
    ["notes.md"],
    ["./notes.md"],
    ["../notes.md"],
    ["docs/notes.md"],
    ["~/notes.md"],
    ["C:notes.md"],
    ["\\notes.md"],
    ["https://example.com/a.md"],
    ["file:///C:/a.md"],
    ["data:text/plain,hi"],
  ])("calls %s relative: it names no root", (path) => {
    expect(classifyPreviewPath(path)).toBe("relative");
    expect(previewPathProblem(path)).toBe("the path is not a full path to a file");
  });

  it.each([
    ["\\\\server\\share\\a.md"],
    ["//server/share/a.md"],
    ["\\\\?\\C:\\a.md"],
    ["\\\\.\\pipe\\x"],
    ["//"],
  ])("calls %s a network or device path", (path) => {
    expect(classifyPreviewPath(path)).toBe("network");
    expect(previewPathProblem(path)).toBe("the path is a network or device path");
  });

  it.each([[""], ["   "], ["\t"], ["/a\nb"], ["/a\u0000b"], ["/a\u007fb"], ["C:\\a\u001b[0m"]])(
    "calls %j invalid",
    (path) => {
      expect(classifyPreviewPath(path)).toBe("invalid");
      expect(isPreviewPath(path)).toBe(false);
    },
  );

  it("limits the length of a path", () => {
    expect(classifyPreviewPath(`/${"a".repeat(MAX_PREVIEW_PATH - 1)}`)).toBe("ok");
    expect(classifyPreviewPath(`/${"a".repeat(MAX_PREVIEW_PATH)}`)).toBe("invalid");
  });

  it("names the file after the last part of the path", () => {
    expect(previewFileName("/home/me/notes.md")).toBe("notes.md");
    expect(previewFileName("C:\\Users\\me\\pic.PNG")).toBe("pic.PNG");
    expect(previewFileName("C:/Users/me/")).toBe("me");
    expect(previewFileName("/")).toBe("/");
    expect(previewFileName("C:\\")).toBe("C:");
  });

  it("decides the kind of text by the extension, in any case", () => {
    for (const name of ["a.md", "A.MD", "x.markdown", "x.mdown", "x.mkd", "/a/b/readme.Md"]) {
      expect(previewTextKind(name), name).toBe("markdown");
    }
    for (const name of ["a.json", "/x/package.JSON"]) {
      expect(previewTextKind(name), name).toBe("json");
    }
    for (const name of ["a.txt", "a", ".md", "a.md.bak", "a.jsonl", "a.svg", "a.png", "Makefile"]) {
      expect(previewTextKind(name), name).toBe("text");
    }
  });
});

describe("the kind of picture", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
  ])("tells %s by its first bytes", (mime, head) => {
    expect(sniffPreviewImage(bytes(head))).toBe(mime);
  });

  it.each([
    ["a bmp", [0x42, 0x4d, 0, 0, 0, 0]],
    ["a pdf", [...text("%PDF-1.7")]],
    ["an svg", [...text("<svg xmlns='http://www.w3.org/2000/svg'/>")]],
    ["a riff that is a wave", [...text("RIFF"), 0, 0, 0, 0, ...text("WAVEfmt ")]],
    ["a cut png", PNG.slice(0, 7)],
    ["nothing", []],
  ])("does not take %s for a picture", (_name, head) => {
    expect(sniffPreviewImage(bytes(head))).toBeUndefined();
  });
});

describe("previewOf", () => {
  const FILE = "/home/me/notes.md";

  it("shows markdown, JSON and text by the name of the file", () => {
    expect(previewOf(FILE, text("# Title\n\nbody"))).toEqual({
      kind: "markdown",
      text: "# Title\n\nbody",
    });
    expect(previewOf("/a/data.json", text('{"a":1}'))).toEqual({ kind: "json", text: '{"a":1}' });
    expect(previewOf("/a/log.txt", text("line\n"))).toEqual({ kind: "text", text: "line\n" });
    expect(previewOf("/a/Makefile", text("all:\n"))).toEqual({ kind: "text", text: "all:\n" });
  });

  it("shows an empty file as empty text", () => {
    expect(previewOf("/a/empty.txt", bytes([]))).toEqual({ kind: "text", text: "" });
  });

  it("shows a picture by its bytes, whatever its name says", () => {
    const shown = previewOf("/a/photo.txt", bytes(PNG));
    expect(shown).toEqual({ kind: "image", mime: "image/png", bytes: bytes(PNG) });
    expect(previewOf("/a/notes.md", bytes(GIF)).kind).toBe("image");
    // A file named like a picture that is not one is text.
    expect(previewOf("/a/fake.png", text("not a picture"))).toEqual({
      kind: "text",
      text: "not a picture",
    });
  });

  it("hands over a copy of the bytes of a picture", () => {
    const original = bytes(PNG);
    const shown = previewOf("/a/p.png", original);
    if (shown.kind !== "image") throw new Error("not an image");
    shown.bytes[0] = 0;
    expect(original[0]).toBe(0x89);
  });

  it("drops a byte order mark and mends bytes that are not UTF-8", () => {
    expect(previewOf("/a/b.txt", bytes([0xef, 0xbb, 0xbf, ...text("hi")]))).toEqual({
      kind: "text",
      text: "hi",
    });
    expect(previewOf("/a/b.txt", bytes([0x61, 0xff, 0x62]))).toEqual({
      kind: "text",
      text: "a\ufffdb",
    });
    expect(previewOf("/a/caf.txt", text("café ✓"))).toEqual({ kind: "text", text: "café ✓" });
  });

  it("refuses a binary file, with a NUL anywhere in it", () => {
    expect(previewOf("/a/prog.exe", bytes([0x4d, 0x5a, 0, 0]))).toEqual({
      kind: "refused",
      reason: "binary",
    });
    expect(previewOf("/a/late.txt", bytes([...text("a".repeat(5000)), 0]))).toEqual({
      kind: "refused",
      reason: "binary",
    });
    // UTF-16 text has NULs: it is not shown as garbage.
    expect(previewOf("/a/wide.txt", bytes([0x68, 0, 0x69, 0])).kind).toBe("refused");
  });

  it("refuses what is not a full path before looking at the file", () => {
    expect(previewOf("notes.md", text("x"))).toEqual({ kind: "refused", reason: "relative" });
    expect(previewOf("\\\\srv\\s\\a.md", text("x"))).toEqual({
      kind: "refused",
      reason: "network",
    });
    expect(previewOf("", undefined)).toEqual({ kind: "refused", reason: "invalid" });
  });

  it("refuses nothing there and a folder", () => {
    expect(previewOf("/a/none.md", undefined)).toEqual({ kind: "refused", reason: "missing" });
    expect(previewOf("/a", "directory")).toEqual({ kind: "refused", reason: "directory" });
  });

  it("limits text to 1 MiB and a picture to 10 MiB", () => {
    const atLimit = new Uint8Array(MAX_PREVIEW_TEXT_BYTES).fill(0x61);
    expect(previewOf("/a/big.txt", atLimit).kind).toBe("text");
    const over = new Uint8Array(MAX_PREVIEW_TEXT_BYTES + 1).fill(0x61);
    expect(previewOf("/a/big.txt", over)).toEqual({
      kind: "refused",
      reason: "too-large",
      size: MAX_PREVIEW_TEXT_BYTES + 1,
    });

    const picture = (size: number): Uint8Array => {
      const data = new Uint8Array(size);
      data.set(PNG);
      return data;
    };
    expect(previewOf("/a/big.png", picture(MAX_PREVIEW_IMAGE_BYTES)).kind).toBe("image");
    expect(previewOf("/a/big.png", picture(MAX_PREVIEW_TEXT_BYTES + 1)).kind).toBe("image");
    expect(previewOf("/a/huge.png", picture(MAX_PREVIEW_IMAGE_BYTES + 1))).toEqual({
      kind: "refused",
      reason: "too-large",
      size: MAX_PREVIEW_IMAGE_BYTES + 1,
    });
  });

  it("says too large before it says binary", () => {
    const big = new Uint8Array(MAX_PREVIEW_TEXT_BYTES + 1);
    expect(previewOf("/a/big.bin", big)).toMatchObject({ reason: "too-large" });
  });

  it("answers one of the known reasons for any input", () => {
    fc.assert(
      fc.property(fc.string(), fc.uint8Array({ maxLength: 40 }), (path, data) => {
        const shown = previewOf(path, data);
        if (shown.kind === "refused") expect(PREVIEW_REFUSALS).toContain(shown.reason);
      }),
    );
  });
});

describe("formatJson", () => {
  it("writes one value per line with two spaces of indent", () => {
    expect(formatJson('{"a":1,"b":[true,null,"x"],"c":{"d":{}}}')).toBe(
      [
        "{",
        '  "a": 1,',
        '  "b": [',
        "    true,",
        "    null,",
        '    "x"',
        "  ],",
        '  "c": {',
        '    "d": {}',
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("keeps empty containers, scalars and white space already there", () => {
    expect(formatJson("  [ ]  ")).toBe("[]");
    expect(formatJson("{\n\n}")).toBe("{}");
    expect(formatJson("42")).toBe("42");
    expect(formatJson('"a"')).toBe('"a"');
    expect(formatJson("null")).toBe("null");
    expect(formatJson("[1,\n  2,\t3]")).toBe("[\n  1,\n  2,\n  3\n]");
  });

  it("copies strings as they are, with their commas, colons, braces and escapes", () => {
    const source = String.raw`{"k":"a, b: {c} [d] \" \\ \u00e9","e":"x"}`;
    expect(formatJson(source)).toBe(
      String.raw`{
  "k": "a, b: {c} [d] \" \\ \u00e9",
  "e": "x"
}`,
    );
  });

  it("does not round numbers or reorder keys", () => {
    expect(formatJson('{"n":12345678901234567890,"2":1,"1":2,"f":1.50e+3}')).toBe(
      '{\n  "n": 12345678901234567890,\n  "2": 1,\n  "1": 2,\n  "f": 1.50e+3\n}',
    );
  });

  it.each([
    [""],
    ["{"],
    ["{'a':1}"],
    ['{"a":1,}'],
    ["[1 2]"],
    ["undefined"],
    ["// c\n{}"],
    ["NaN"],
  ])("gives nothing for %j, which is not JSON", (source) => {
    expect(formatJson(source)).toBeUndefined();
  });

  it("is the same data as what it was given", () => {
    const json: fc.Arbitrary<unknown> = fc.jsonValue();
    fc.assert(
      fc.property(json, fc.constantFrom(0, 1, 2), (value, spaces) => {
        const source = JSON.stringify(value, null, spaces === 0 ? undefined : spaces);
        const formatted = formatJson(source);
        expect(formatted).toBeDefined();
        expect(JSON.parse(formatted ?? "")).toEqual(JSON.parse(source));
      }),
    );
  });

  it("formats what it formatted again as the same text", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = formatJson(JSON.stringify(value));
        expect(once).toBeDefined();
        expect(formatJson(once ?? "")).toBe(once);
      }),
    );
  });
});

/** The frame the shell answers with: the header length (4 bytes), the header, the body. */
function frame(header: unknown, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = text(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}

describe("decodeFilePreview", () => {
  it("reads text of the three kinds", () => {
    for (const kind of ["markdown", "json", "text"] as const) {
      expect(decodeFilePreview(frame({ kind }, text("héllo")))).toEqual({ kind, text: "héllo" });
    }
    expect(decodeFilePreview(frame({ kind: "text" }))).toEqual({ kind: "text", text: "" });
  });

  it("reads a picture whose mime is the one its bytes say", () => {
    expect(decodeFilePreview(frame({ kind: "image", mime: "image/png" }, bytes(PNG)))).toEqual({
      kind: "image",
      mime: "image/png",
      bytes: bytes(PNG),
    });
  });

  it("refuses a picture that is not what the header says", () => {
    expect(() =>
      decodeFilePreview(frame({ kind: "image", mime: "image/gif" }, bytes(PNG))),
    ).toThrow();
    expect(() =>
      decodeFilePreview(frame({ kind: "image", mime: "image/png" }, text("not a picture"))),
    ).toThrow();
    expect(() => decodeFilePreview(frame({ kind: "image" }, bytes(PNG)))).toThrow();
  });

  it("reads each reason for a refusal, with the size and the detail when they come", () => {
    for (const reason of PREVIEW_REFUSALS) {
      expect(decodeFilePreview(frame({ kind: "refused", reason }))).toEqual({
        kind: "refused",
        reason,
      });
    }
    expect(
      decodeFilePreview(frame({ kind: "refused", reason: "too-large", size: 2097152 })),
    ).toEqual({ kind: "refused", reason: "too-large", size: 2097152 });
    expect(
      decodeFilePreview(frame({ kind: "refused", reason: "unreadable", detail: "denied" })),
    ).toEqual({ kind: "refused", reason: "unreadable", detail: "denied" });
  });

  it("leaves out a size that is not a size and cuts a long detail", () => {
    expect(decodeFilePreview(frame({ kind: "refused", reason: "too-large", size: -1 }))).toEqual({
      kind: "refused",
      reason: "too-large",
    });
    expect(decodeFilePreview(frame({ kind: "refused", reason: "too-large", size: "big" }))).toEqual(
      { kind: "refused", reason: "too-large" },
    );
    const long = decodeFilePreview(
      frame({ kind: "refused", reason: "unreadable", detail: "x".repeat(5000) }),
    );
    expect(long.kind === "refused" && long.detail?.length).toBe(500);
  });

  it.each([
    ["an empty answer", new Uint8Array(0)],
    ["a cut length", bytes([0, 0])],
    ["a header longer than the answer", bytes([0, 0, 0, 9, 123, 125])],
    ["a header that is not JSON", bytes([0, 0, 0, 1, 123])],
    ["a header that is not an object", frame(7)],
    ["a kind unknown here", frame({ kind: "video" })],
    ["a reason unknown here", frame({ kind: "refused", reason: "because" })],
    ["no kind", frame({})],
  ])("fails on %s", (_name, answer) => {
    expect(() => decodeFilePreview(answer)).toThrow();
  });
});

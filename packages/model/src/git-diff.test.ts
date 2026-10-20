import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GIT_DIFF_REFUSALS,
  MAX_GIT_DIFF_DETAIL,
  decodeGitDiff,
  parseGitDiff,
  sideBySideRows,
  unquoteGitPath,
} from "./git-diff";
import type { GitDiffFile, GitDiffHunk, GitDiffLine, GitDiffStatus } from "./git-diff";

/** Joins lines the way git ends them: each one with a line break. */
const text = (...lines: string[]): string => `${lines.join("\n")}\n`;

const MODIFIED = text(
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@ export function main() {",
  " one",
  "-two",
  "+two!",
  "+three",
  " four",
  "@@ -20,3 +21,2 @@",
  " twenty",
  "-twenty-one",
  " twenty-two",
);

describe("parseGitDiff", () => {
  it("reads a modified file with two hunks, numbering both sides", () => {
    const [file, ...rest] = parseGitDiff(MODIFIED);
    expect(rest).toEqual([]);
    expect(file).toMatchObject({
      path: "src/app.ts",
      status: "modified",
      binary: false,
      added: 2,
      removed: 2,
    });
    expect(file?.oldPath).toBeUndefined();
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldCount: 4,
      newStart: 1,
      newCount: 5,
      heading: "export function main() {",
    });
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "context", text: "one", oldNo: 1, newNo: 1 },
      { kind: "del", text: "two", oldNo: 2 },
      { kind: "add", text: "two!", newNo: 2 },
      { kind: "add", text: "three", newNo: 3 },
      { kind: "context", text: "four", oldNo: 3, newNo: 4 },
    ]);
    expect(file?.hunks[1]).toMatchObject({ oldStart: 20, newStart: 21, heading: "" });
    expect(file?.hunks[1]?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["context", 20, 21],
      ["del", 21, undefined],
      ["context", 22, 22],
    ]);
  });

  it("reads several files in the order git printed them", () => {
    const files = parseGitDiff(
      MODIFIED +
        text(
          "diff --git a/b.txt b/b.txt",
          "index 3333333..4444444 100644",
          "--- a/b.txt",
          "+++ b/b.txt",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ),
    );
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "b.txt"]);
    expect(files[1]?.hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
  });

  it("reads an added file, whose old side is /dev/null", () => {
    const [file] = parseGitDiff(
      text(
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+alpha",
        "+beta",
      ),
    );
    expect(file).toMatchObject({
      path: "new.txt",
      status: "added",
      newMode: "100644",
      added: 2,
      removed: 0,
    });
    expect(file?.hunks[0]?.lines.map((l) => [l.kind, l.newNo])).toEqual([
      ["add", 1],
      ["add", 2],
    ]);
  });

  it("reads an empty added file, which has no hunk", () => {
    const [file] = parseGitDiff(
      text("diff --git a/empty b/empty", "new file mode 100644", "index 0000000..e69de29"),
    );
    expect(file).toMatchObject({ path: "empty", status: "added", binary: false, hunks: [] });
  });

  it("reads a deleted file under its old name", () => {
    const [file] = parseGitDiff(
      text(
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
      ),
    );
    expect(file).toMatchObject({ path: "gone.txt", status: "deleted", oldMode: "100644" });
    expect(file?.removed).toBe(1);
    expect(file?.oldPath).toBeUndefined();
  });

  it("reads a renamed file with the name it had and how alike it is", () => {
    const [file] = parseGitDiff(
      text(
        "diff --git a/old name.txt b/new name.txt",
        "similarity index 96%",
        "rename from old name.txt",
        "rename to new name.txt",
        "index 5555555..6666666 100644",
        "--- a/old name.txt\t",
        "+++ b/new name.txt\t",
        "@@ -1,2 +1,2 @@",
        " same",
        "-before",
        "+after",
      ),
    );
    expect(file).toMatchObject({
      path: "new name.txt",
      oldPath: "old name.txt",
      status: "renamed",
      similarity: 96,
      added: 1,
      removed: 1,
    });
  });

  it("reads a pure rename and a copy, which have no hunk", () => {
    const files = parseGitDiff(
      text(
        "diff --git a/a.txt b/b.txt",
        "similarity index 100%",
        "rename from a.txt",
        "rename to b.txt",
        "diff --git a/c.txt b/d.txt",
        "similarity index 100%",
        "copy from c.txt",
        "copy to d.txt",
      ),
    );
    expect(files).toMatchObject([
      { path: "b.txt", oldPath: "a.txt", status: "renamed", similarity: 100, hunks: [] },
      { path: "d.txt", oldPath: "c.txt", status: "copied", similarity: 100, hunks: [] },
    ]);
  });

  it("reads a change of mode with no change of content", () => {
    const [file] = parseGitDiff(
      text("diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"),
    );
    expect(file).toMatchObject({
      path: "run.sh",
      status: "modified",
      oldMode: "100644",
      newMode: "100755",
      hunks: [],
      binary: false,
    });
  });

  it("reads a binary file without lines", () => {
    const files = parseGitDiff(
      text(
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/new.bin b/new.bin",
        "new file mode 100644",
        "index 0000000..3333333",
        "Binary files /dev/null and b/new.bin differ",
      ),
    );
    expect(files).toMatchObject([
      { path: "img.png", status: "modified", binary: true, hunks: [] },
      { path: "new.bin", status: "added", binary: true, hunks: [] },
    ]);
  });

  it("puts the missing line break at the end of the file on the line before the marker", () => {
    const [file] = parseGitDiff(
      text(
        "diff --git a/f b/f",
        "--- a/f",
        "+++ b/f",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-last",
        "\\ No newline at end of file",
        "+last!",
        "\\ No newline at end of file",
      ),
    );
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => [l.kind, l.text, l.noEol])).toEqual([
      ["context", "keep", undefined],
      ["del", "last", true],
      ["add", "last!", true],
    ]);
    // The marker is no line: the counts of the header were met by the three above.
    expect(file?.added).toBe(1);
    expect(file?.removed).toBe(1);
  });

  it("reads a line that looks like the header of a file as the line it is", () => {
    const [file, ...rest] = parseGitDiff(
      text(
        "diff --git a/notes.md b/notes.md",
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1,4 +1,4 @@",
        "--- a/other",
        "-+++ b/other",
        "-diff --git a/x b/x",
        "+++ b/other",
        "++diff --git a/y b/y",
        "+@@ -1 +1 @@",
        " tail",
      ),
    );
    expect(rest).toEqual([]);
    expect(file?.path).toBe("notes.md");
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["del", "-- a/other"],
      ["del", "+++ b/other"],
      ["del", "diff --git a/x b/x"],
      ["add", "++ b/other"],
      ["add", "+diff --git a/y b/y"],
      ["add", "@@ -1 +1 @@"],
      ["context", "tail"],
    ]);
  });

  it("keeps a carriage return at the end of a line of a file with Windows line breaks", () => {
    const [file] = parseGitDiff(
      "diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1 @@ x\r\n-one\r\n+two\r\n",
    );
    expect(file?.hunks[0]?.heading).toBe("x\r");
    expect(file?.hunks[0]?.lines.map((l) => l.text)).toEqual(["one\r", "two\r"]);
  });

  it("reads a blank context line, written as a single space or trimmed to nothing", () => {
    const [file] = parseGitDiff(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n \n\n-b\n+c\n",
    );
    expect(file?.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "a"],
      ["context", ""],
      ["context", ""],
      ["del", "b"],
      ["add", "c"],
    ]);
  });

  it("reads names with spaces, quotes and bytes above ASCII", () => {
    const files = parseGitDiff(
      text(
        "diff --git a/my file.txt b/my file.txt",
        "--- a/my file.txt\t",
        "+++ b/my file.txt\t",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        "index 1111111..2222222 100644",
        '--- "a/caf\\303\\251.txt"',
        '+++ "b/caf\\303\\251.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/tab\\there" "b/tab\\there"',
        "old mode 100644",
        "new mode 100755",
        "diff --git a/café.txt b/café.txt",
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(files.map((f) => f.path)).toEqual(["my file.txt", "café.txt", "tab\there", "café.txt"]);
  });

  it("skips what is not a diff and gives what was read of a diff cut short", () => {
    expect(parseGitDiff("")).toEqual([]);
    expect(parseGitDiff("\n\n")).toEqual([]);
    expect(parseGitDiff("warning: something git said\n")).toEqual([]);
    const cut = MODIFIED.slice(0, MODIFIED.indexOf("+two!") + 3);
    const [file] = parseGitDiff(cut);
    expect(file?.path).toBe("src/app.ts");
    expect(file?.hunks[0]?.lines.length).toBeGreaterThan(0);
    // `* Unmerged path` lines (a merge in progress) are noise before the block of the file.
    const files = parseGitDiff(
      `* Unmerged path conflict.txt\n${text("diff --git a/conflict.txt b/conflict.txt", "--- a/conflict.txt", "+++ b/conflict.txt", "@@ -1 +1 @@", "-x", "+y")}`,
    );
    expect(files.map((f) => f.path)).toEqual(["conflict.txt"]);
  });

  it("reads a hunk header with no counts, a zero count and a heading with symbols", () => {
    const [file] = parseGitDiff(
      text("diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -3 +3,0 @@ fn a() -> @@ x", "-gone"),
    );
    expect(file?.hunks[0]).toMatchObject({
      oldStart: 3,
      oldCount: 1,
      newStart: 3,
      newCount: 0,
      heading: "fn a() -> @@ x",
    });
  });
});

describe("unquoteGitPath", () => {
  it.each([
    ["plain", "plain"],
    ['"plain"', "plain"],
    ['"a\\tb"', "a\tb"],
    ['"a\\nb"', "a\nb"],
    ['"say \\"hi\\""', 'say "hi"'],
    ['"back\\\\slash"', "back\\slash"],
    ['"caf\\303\\251"', "café"],
    ['"\\360\\237\\230\\200"', "😀"],
    ['"é"', "é"],
    ['"', '"'],
  ])("reads %s as %j", (quoted, expected) => {
    expect(unquoteGitPath(quoted)).toBe(expected);
  });
});

describe("sideBySideRows", () => {
  const rowsOf = (...lines: string[]) =>
    sideBySideRows(
      parseGitDiff(text("diff --git a/f b/f", "--- a/f", "+++ b/f", ...lines))[0] as GitDiffFile,
    );

  it("starts each hunk with a row that says where it is", () => {
    const [file] = parseGitDiff(MODIFIED);
    const rows = sideBySideRows(file as GitDiffFile);
    const hunks = rows.filter((r) => r.kind === "hunk");
    expect(hunks).toEqual([
      { kind: "hunk", label: "@@ -1,4 +1,5 @@", heading: "export function main() {" },
      { kind: "hunk", label: "@@ -20,3 +21,2 @@", heading: "" },
    ]);
    expect(rows[0]).toBe(hunks[0]);
  });

  it("sets a deleted line against the added line that takes its place", () => {
    const rows = rowsOf("@@ -1,3 +1,4 @@", " one", "-two", "+two!", "+three", " four");
    expect(rows.slice(1)).toEqual([
      { kind: "context", old: { no: 1, text: "one" }, new: { no: 1, text: "one" } },
      { kind: "change", old: { no: 2, text: "two" }, new: { no: 2, text: "two!" } },
      { kind: "change", new: { no: 3, text: "three" } },
      { kind: "context", old: { no: 3, text: "four" }, new: { no: 4, text: "four" } },
    ]);
  });

  it("leaves the other side empty for a line that was only deleted or only added", () => {
    const rows = rowsOf("@@ -1,3 +1,1 @@", "-a", "-b", " c");
    expect(rows.slice(1)).toEqual([
      { kind: "change", old: { no: 1, text: "a" } },
      { kind: "change", old: { no: 2, text: "b" } },
      { kind: "context", old: { no: 3, text: "c" }, new: { no: 1, text: "c" } },
    ]);
  });

  it("pairs deleted lines with added lines that come after other deleted ones", () => {
    const rows = rowsOf("@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+x");
    expect(rows.slice(1)).toEqual([
      { kind: "change", old: { no: 1, text: "a" }, new: { no: 1, text: "x" } },
      { kind: "change", old: { no: 2, text: "b" } },
      { kind: "change", old: { no: 3, text: "c" } },
    ]);
  });

  it("carries the missing line break of the end of a file to its cell", () => {
    const rows = rowsOf("@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b");
    expect(rows[1]).toEqual({
      kind: "change",
      old: { no: 1, text: "a", noEol: true },
      new: { no: 1, text: "b" },
    });
  });

  it("gives a file with no hunk no row", () => {
    const [file] = parseGitDiff(text("diff --git a/x b/x", "old mode 100644", "new mode 100755"));
    expect(sideBySideRows(file as GitDiffFile)).toEqual([]);
  });
});

describe("decodeGitDiff", () => {
  it("reads a diff and a refusal", () => {
    expect(decodeGitDiff({ kind: "diff", text: "x" })).toEqual({ kind: "diff", text: "x" });
    expect(decodeGitDiff({ kind: "diff", text: "" })).toEqual({ kind: "diff", text: "" });
    for (const reason of GIT_DIFF_REFUSALS) {
      expect(decodeGitDiff({ kind: "refused", reason })).toEqual({ kind: "refused", reason });
    }
  });

  it("keeps a detail, trimmed to the most it may have, and drops an empty one", () => {
    expect(decodeGitDiff({ kind: "refused", reason: "failed", detail: "fatal: x" })).toEqual({
      kind: "refused",
      reason: "failed",
      detail: "fatal: x",
    });
    const long = decodeGitDiff({ kind: "refused", reason: "failed", detail: "y".repeat(5000) });
    expect(long.kind === "refused" && long.detail?.length).toBe(MAX_GIT_DIFF_DETAIL);
    expect(decodeGitDiff({ kind: "refused", reason: "failed", detail: "" })).toEqual({
      kind: "refused",
      reason: "failed",
    });
  });

  it.each([
    [null],
    ["diff"],
    [42],
    [{}],
    [{ kind: "diff" }],
    [{ kind: "diff", text: 3 }],
    [{ kind: "refused" }],
    [{ kind: "refused", reason: "because" }],
    [{ kind: "maybe", text: "x" }],
  ])("refuses an answer that is %j", (value) => {
    expect(() => decodeGitDiff(value)).toThrow();
  });
});

// ---- Properties ------------------------------------------------------------------------------

interface GenLine {
  kind: "context" | "add" | "del";
  text: string;
  noEol: boolean;
}

interface GenHunk {
  oldStart: number;
  newStart: number;
  heading: string;
  lines: GenLine[];
}

interface GenFile {
  path: string;
  status: "modified" | "added" | "deleted";
  hunks: GenHunk[];
}

/** Prints files the way `git diff` does, counts and all. */
function render(files: GenFile[]): string {
  const out: string[] = [];
  for (const file of files) {
    const spaced = file.path.includes(" ") ? "\t" : "";
    out.push(`diff --git a/${file.path} b/${file.path}`);
    if (file.status === "added") out.push("new file mode 100644");
    if (file.status === "deleted") out.push("deleted file mode 100644");
    out.push("index 1111111..2222222 100644");
    out.push(file.status === "added" ? "--- /dev/null" : `--- a/${file.path}${spaced}`);
    out.push(file.status === "deleted" ? "+++ /dev/null" : `+++ b/${file.path}${spaced}`);
    for (const hunk of file.hunks) {
      const oldCount = hunk.lines.filter((l) => l.kind !== "add").length;
      const newCount = hunk.lines.filter((l) => l.kind !== "del").length;
      const span = (start: number, count: number): string =>
        count === 1 ? `${start}` : `${start},${count}`;
      out.push(
        `@@ -${span(hunk.oldStart, oldCount)} +${span(hunk.newStart, newCount)} @@${hunk.heading === "" ? "" : ` ${hunk.heading}`}`,
      );
      for (const line of hunk.lines) {
        const mark = line.kind === "context" ? " " : line.kind === "add" ? "+" : "-";
        out.push(`${mark}${line.text}`);
        if (line.noEol) out.push("\\ No newline at end of file");
      }
    }
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** What `parseGitDiff` must give back for a generated file. */
function expectedFile(file: GenFile): GitDiffFile {
  let added = 0;
  let removed = 0;
  const hunks: GitDiffHunk[] = file.hunks.map((hunk) => {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    const lines: GitDiffLine[] = hunk.lines.map((line) => {
      const out: GitDiffLine = { kind: line.kind, text: line.text };
      if (line.kind !== "add") out.oldNo = oldNo++;
      if (line.kind !== "del") out.newNo = newNo++;
      if (line.kind === "add") added++;
      if (line.kind === "del") removed++;
      if (line.noEol) out.noEol = true;
      return out;
    });
    return {
      oldStart: hunk.oldStart,
      oldCount: hunk.lines.filter((l) => l.kind !== "add").length,
      newStart: hunk.newStart,
      newCount: hunk.lines.filter((l) => l.kind !== "del").length,
      heading: hunk.heading,
      lines,
    };
  });
  const out: GitDiffFile = {
    path: file.path,
    status: file.status as GitDiffStatus,
    binary: false,
    hunks,
    added,
    removed,
  };
  if (file.status === "added") out.newMode = "100644";
  if (file.status === "deleted") out.oldMode = "100644";
  return out;
}

// Text a line may hold: anything on one line, and the lines that look like the parts of a diff.
const ANYTHING = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constantFrom(
    "",
    " ",
    "-",
    "+",
    "--- a/x",
    "+++ b/y",
    "-- a/x",
    "++ b/y",
    "diff --git a/x b/x",
    "@@ -1 +1 @@",
    "\\ No newline at end of file",
    "tab\there",
    "carriage\r",
    "héllo ✓ 😀",
  ),
);
const arbLineText = ANYTHING.filter((value) => !value.includes("\n"));

const arbLine: fc.Arbitrary<GenLine> = fc.record({
  kind: fc.constantFrom("context", "add", "del"),
  text: arbLineText,
  noEol: fc.boolean(),
});

const arbHunk: fc.Arbitrary<GenHunk> = fc.record({
  oldStart: fc.integer({ min: 1, max: 5000 }),
  newStart: fc.integer({ min: 1, max: 5000 }),
  heading: fc.constantFrom("", "fn main() {", "class A", "x @@ y", "ünï").map((value) => value),
  lines: fc.array(arbLine, { minLength: 1, maxLength: 12 }),
});

const arbName = fc
  .array(fc.constantFrom("a", "b", "z", "0", "9", ".", "-", "_", " ", "é"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((chars) => chars.join(""))
  .filter((name) => name.trim() === name && !name.startsWith("-"));

const arbPath = fc.array(arbName, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/"));

const arbFile: fc.Arbitrary<GenFile> = fc.record({
  path: arbPath,
  status: fc.constantFrom("modified", "added", "deleted"),
  hunks: fc.array(arbHunk, { minLength: 1, maxLength: 4 }),
});

// A path appears once in a diff.
const arbFiles = fc
  .array(arbFile, { maxLength: 4 })
  .map((files) =>
    files.filter((file, index) => files.findIndex((f) => f.path === file.path) === index),
  );

describe("properties of the parser", () => {
  it("property: what git prints for any files reads back as those files", () => {
    fc.assert(
      fc.property(arbFiles, (files) => {
        expect(parseGitDiff(render(files))).toEqual(files.map(expectedFile));
      }),
      { numRuns: 300 },
    );
  });

  it("property: the rows keep the old file on the left and the new file on the right, in order", () => {
    fc.assert(
      fc.property(arbFiles, (files) => {
        for (const file of parseGitDiff(render(files))) {
          const rows = sideBySideRows(file);
          const lines = file.hunks.flatMap((hunk) => hunk.lines);

          const left = rows.flatMap((row) =>
            row.kind === "hunk" ? [] : row.old !== undefined ? [row.old] : [],
          );
          const right = rows.flatMap((row) =>
            row.kind === "hunk" ? [] : row.new !== undefined ? [row.new] : [],
          );
          const old = lines.filter((line) => line.kind !== "add");
          const now = lines.filter((line) => line.kind !== "del");
          expect(left.map((cell) => cell.text)).toEqual(old.map((line) => line.text));
          expect(left.map((cell) => cell.no)).toEqual(old.map((line) => line.oldNo));
          expect(right.map((cell) => cell.text)).toEqual(now.map((line) => line.text));
          expect(right.map((cell) => cell.no)).toEqual(now.map((line) => line.newNo));

          // Every row says something, and each hunk starts with its own row.
          expect(rows.filter((row) => row.kind === "hunk")).toHaveLength(file.hunks.length);
          for (const row of rows) {
            if (row.kind === "change")
              expect(row.old !== undefined || row.new !== undefined).toBe(true);
          }
          // A change sets one deleted line against one added line: at most as many rows as lines,
          // and never fewer than the longer side of a run.
          const changed = lines.filter((line) => line.kind !== "context").length;
          const changeRows = rows.filter((row) => row.kind === "change").length;
          expect(changeRows).toBeLessThanOrEqual(changed);
          expect(changeRows).toBeGreaterThanOrEqual(Math.ceil(changed / 2));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("property: any text at all reads without throwing, and the counts of a file match its lines", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (input) => {
        for (const file of parseGitDiff(input)) {
          const lines = file.hunks.flatMap((hunk) => hunk.lines);
          expect(file.added).toBe(lines.filter((line) => line.kind === "add").length);
          expect(file.removed).toBe(lines.filter((line) => line.kind === "del").length);
          sideBySideRows(file);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("property: a diff cut anywhere reads without throwing and keeps what came before the cut", () => {
    fc.assert(
      fc.property(arbFiles, fc.nat(), (files, at) => {
        const printed = render(files);
        const cut = printed.slice(0, printed.length === 0 ? 0 : at % (printed.length + 1));
        const read = parseGitDiff(cut);
        const whole = parseGitDiff(printed);
        expect(read.length).toBeLessThanOrEqual(whole.length);
        // The files read before the one the cut fell in are the same files.
        for (let i = 0; i < read.length - 1; i++) expect(read[i]).toEqual(whole[i]);
      }),
      { numRuns: 300 },
    );
  });

  it("property: the lines of a diff that look like headers or markers stay lines", () => {
    const risky = fc.constantFrom(
      "--- a/x",
      "+++ b/y",
      "diff --git a/x b/x",
      "@@ -1 +1 @@",
      "\\ No newline at end of file",
    );
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom("add", "del", "context"),
            text: risky,
            noEol: fc.constant(false),
          }),
          {
            minLength: 1,
            maxLength: 10,
          },
        ),
        (lines) => {
          const file: GenFile = {
            path: "f.txt",
            status: "modified",
            hunks: [{ oldStart: 1, newStart: 1, heading: "", lines }],
          };
          expect(parseGitDiff(render([file]))).toEqual([expectedFile(file)]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

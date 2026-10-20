// What a diff pane shows: the changes of the working tree and the index of a git repository against
// `HEAD`, as `git diff` prints them. The text comes from `Backend.readGitDiff` (the Rust side runs
// git; see `noren-core`, `git_diff.rs`), and everything here is pure: the refusals the backend
// answers with, the parser of the unified diff, and the pairing of its lines into the rows of a
// side-by-side view.
//
// The parser expects what the Rust side asks git for (`--no-color --no-ext-diff --no-textconv
// -M --src-prefix=a/ --dst-prefix=b/`) but never trusts it: any text goes in, a list of files comes
// out, and what is not a diff is skipped.

import { decodeUtf8 } from "./utf8";

/** The most diff text a pane reads: 2 MiB. Past it git is stopped and the pane says so. */
export const MAX_GIT_DIFF_BYTES = 2 * 1024 * 1024;

/**
 * Why a diff is not shown:
 * - `relative`: the folder is not a full path (it names no drive or root);
 * - `network`: the folder is a network or device path, in which git is never run;
 * - `invalid`: the folder is empty, too long or holds a control character;
 * - `missing`: nothing is there, or it is not a folder;
 * - `not-a-repository`: the folder is in no git repository;
 * - `git-missing`: `git` could not be started (not installed, or not on the `PATH`);
 * - `too-large`: the diff is longer than `MAX_GIT_DIFF_BYTES`;
 * - `failed`: git ran and refused (`detail` is what it printed, as English text).
 */
export const GIT_DIFF_REFUSALS = [
  "relative",
  "network",
  "invalid",
  "missing",
  "not-a-repository",
  "git-missing",
  "too-large",
  "failed",
] as const;

export type GitDiffRefusalReason = (typeof GIT_DIFF_REFUSALS)[number];

/**
 * What `Backend.readGitDiff` answers: the text of `git diff HEAD` for the folder (empty when nothing
 * changed), or why there is none. A refusal is an answer, not an error.
 */
export type GitDiff =
  | { kind: "diff"; text: string }
  | { kind: "refused"; reason: GitDiffRefusalReason; detail?: string };

export type GitDiffRefusal = Extract<GitDiff, { kind: "refused" }>;

/** The longest `detail` of a refusal kept, in UTF-16 units. */
export const MAX_GIT_DIFF_DETAIL = 500;

/**
 * Reads the answer of a shell as a `GitDiff`, without taking its word for it: the kind and the
 * reason must be known ones and the text must be text. Throws when the answer is none of them.
 */
export function decodeGitDiff(value: unknown): GitDiff {
  if (typeof value !== "object" || value === null)
    throw new Error("the diff answer is not an object");
  const answer = value as Record<string, unknown>;
  if (answer["kind"] === "diff") {
    if (typeof answer["text"] !== "string") throw new Error("the diff answer has no text");
    return { kind: "diff", text: answer["text"] };
  }
  if (answer["kind"] === "refused") {
    const reason = answer["reason"];
    if (!GIT_DIFF_REFUSALS.some((known) => known === reason)) {
      throw new Error(`the diff answer has an unknown reason: ${String(reason)}`);
    }
    const detail = answer["detail"];
    return {
      kind: "refused",
      reason: reason as GitDiffRefusalReason,
      ...(typeof detail === "string" && detail !== ""
        ? { detail: detail.slice(0, MAX_GIT_DIFF_DETAIL) }
        : {}),
    };
  }
  throw new Error("the diff answer is neither a diff nor a refusal");
}

/** How a file changed. */
export type GitDiffStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

/** One line of a hunk: unchanged (`context`), `add`ed or deleted (`del`). */
export interface GitDiffLine {
  kind: "context" | "add" | "del";
  /** The line without its first column and without the line break (a `\r` before it stays). */
  text: string;
  /** The number of the line in the old file; on `context` and `del` lines. */
  oldNo?: number;
  /** The number of the line in the new file; on `context` and `add` lines. */
  newNo?: number;
  /** The file ends here with no line break (git printed `\ No newline at end of file` after it). */
  noEol?: boolean;
}

export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** What git printed after the second `@@` (the function the hunk is in); empty when nothing. */
  heading: string;
  lines: GitDiffLine[];
}

export interface GitDiffFile {
  /** The path in the new tree, or the old one for a file that was deleted. Uses `/`. */
  path: string;
  /** The path before the change; only on a renamed or copied file. */
  oldPath?: string;
  status: GitDiffStatus;
  /** Git does not print the lines of a binary file: it says the files differ. */
  binary: boolean;
  /** How alike a renamed or copied file is to its source, in percent. */
  similarity?: number;
  /** The file mode before and after, when the change touched it (`100644`, `100755`, ...). */
  oldMode?: string;
  newMode?: string;
  hunks: GitDiffHunk[];
  /** How many `add` and `del` lines the hunks hold. */
  added: number;
  removed: number;
}

/** Undoes the quoting git applies to a path with a tab, a quote, a backslash or a byte above 0x7f. */
export function unquoteGitPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const body = text.slice(1, -1);
  const bytes: number[] = [];
  const push = (code: number): void => {
    bytes.push(code);
  };
  const SIMPLE: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const char = body.charAt(i);
    if (char !== "\\") {
      // A character outside ASCII is kept as its own UTF-8 bytes (git quotes them, but a name that
      // reached us unquoted is not ours to alter).
      const code = body.codePointAt(i) ?? 0;
      if (code < 0x80) {
        push(code);
      } else {
        const piece = String.fromCodePoint(code);
        for (const byte of utf8Bytes(piece)) push(byte);
        if (code > 0xffff) i++;
      }
      continue;
    }
    const next = body.charAt(i + 1);
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (octal !== null) {
      push(Number.parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
    } else if (Object.hasOwn(SIMPLE, next)) {
      push(SIMPLE[next] ?? 0);
      i += 1;
    } else if (next !== "") {
      // `\\`, `\"` and anything else: the character itself.
      for (const byte of utf8Bytes(next)) push(byte);
      i += 1;
    }
  }
  return decodeUtf8(Uint8Array.from(bytes));
}

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** A path as it stands in a `---`, `+++` or `rename` line: unquoted, no prefix, no trailing tab. */
function headerPath(text: string, prefix: "a/" | "b/" | ""): string | undefined {
  const trimmed = text.endsWith("\t") ? text.slice(0, -1) : text;
  const path = unquoteGitPath(trimmed);
  if (path === "/dev/null") return undefined;
  return prefix !== "" && path.startsWith(prefix) ? path.slice(2) : path;
}

/** The two names on a `diff --git a/X b/Y` line, best effort (the lines after it say it better). */
function namesOfDiffLine(rest: string): { old: string; new: string } | undefined {
  // Both names quoted, one quoted, or neither (then a name with spaces is ambiguous: take the
  // split where both halves are the same name, else the first ` b/`).
  const quoted = /^("(?:[^"\\]|\\.)*")\s+(.*)$/s.exec(rest);
  if (quoted !== null) {
    const second = quoted[2] ?? "";
    return { old: headerPath(quoted[1] ?? "", "a/") ?? "", new: headerPath(second, "b/") ?? "" };
  }
  const quotedSecond = /^(\S+)\s+("(?:[^"\\]|\\.)*")$/s.exec(rest);
  if (quotedSecond !== null) {
    return {
      old: headerPath(quotedSecond[1] ?? "", "a/") ?? "",
      new: headerPath(quotedSecond[2] ?? "", "b/") ?? "",
    };
  }
  if (!rest.startsWith("a/")) return undefined;
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    const left = rest.slice(2, at);
    const right = rest.slice(at + 3);
    if (left === right) return { old: left, new: right };
  }
  const first = rest.indexOf(" b/");
  return first === -1 ? undefined : { old: rest.slice(2, first), new: rest.slice(first + 3) };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/s;

/**
 * Reads a unified diff as git prints it for `git diff`: one entry per `diff --git` block, with the
 * status, the paths, the hunks and their lines numbered on both sides. A hunk is read by the counts
 * in its header, so a deleted line that starts with `--` (which prints as `---`) or an added one
 * that starts with `++` is a line and not the header of a file. Text that is not a diff gives no
 * file; a block that is cut short gives what was read of it. Never throws.
 */
export function parseGitDiff(text: string): GitDiffFile[] {
  const lines = text.split("\n");
  // A diff ends with a line break; the empty piece after it is no line.
  if (lines.at(-1) === "") lines.pop();
  const files: GitDiffFile[] = [];
  let at = 0;

  const readHunk = (file: GitDiffFile, header: RegExpExecArray): void => {
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const hunk: GitDiffHunk = {
      oldStart,
      oldCount,
      newStart,
      newCount,
      heading: header[5] ?? "",
      lines: [],
    };
    file.hunks.push(hunk);
    at++;
    let oldLeft = oldCount;
    let newLeft = newCount;
    let oldNo = oldStart;
    let newNo = newStart;
    while (at < lines.length) {
      const line = lines[at] ?? "";
      const mark = line.charAt(0);
      if (mark === "\\") {
        // `\ No newline at end of file` belongs to the line before it.
        const previous = hunk.lines.at(-1);
        if (previous !== undefined) previous.noEol = true;
        at++;
        continue;
      }
      if (oldLeft <= 0 && newLeft <= 0) break;
      if (mark === "+" && newLeft > 0) {
        hunk.lines.push({ kind: "add", text: line.slice(1), newNo });
        newNo++;
        newLeft--;
        file.added++;
      } else if (mark === "-" && oldLeft > 0) {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldNo });
        oldNo++;
        oldLeft--;
        file.removed++;
      } else if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        // Git writes a blank context line as a single space; a tool that trimmed it leaves "".
        hunk.lines.push({ kind: "context", text: line.slice(1), oldNo, newNo });
        oldNo++;
        newNo++;
        oldLeft--;
        newLeft--;
      } else {
        break;
      }
      at++;
    }
  };

  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (!line.startsWith("diff --git ")) {
      at++;
      continue;
    }
    const names = namesOfDiffLine(line.slice("diff --git ".length));
    const file: GitDiffFile = {
      path: names?.new ?? "",
      status: "modified",
      binary: false,
      hunks: [],
      added: 0,
      removed: 0,
    };
    let oldPath = names?.old;
    let newPath = names?.new;
    let sawHunk = false;
    at++;
    while (at < lines.length && !(lines[at] ?? "").startsWith("diff --git ")) {
      const current = lines[at] ?? "";
      const hunk = HUNK_HEADER.exec(current);
      if (hunk !== null) {
        readHunk(file, hunk);
        sawHunk = true;
        continue;
      }
      at++;
      if (sawHunk) continue;
      if (current.startsWith("new file mode ")) {
        file.status = "added";
        file.newMode = current.slice("new file mode ".length).trim();
      } else if (current.startsWith("deleted file mode ")) {
        file.status = "deleted";
        file.oldMode = current.slice("deleted file mode ".length).trim();
      } else if (current.startsWith("old mode ")) {
        file.oldMode = current.slice("old mode ".length).trim();
      } else if (current.startsWith("new mode ")) {
        file.newMode = current.slice("new mode ".length).trim();
      } else if (current.startsWith("rename from ") || current.startsWith("copy from ")) {
        file.status = current.startsWith("rename") ? "renamed" : "copied";
        oldPath = headerPath(current.slice(current.indexOf(" from ") + 6), "") ?? oldPath;
      } else if (current.startsWith("rename to ") || current.startsWith("copy to ")) {
        newPath = headerPath(current.slice(current.indexOf(" to ") + 4), "") ?? newPath;
      } else if (current.startsWith("similarity index ")) {
        const percent = Number.parseInt(current.slice("similarity index ".length), 10);
        if (Number.isFinite(percent)) file.similarity = percent;
      } else if (current.startsWith("--- ")) {
        // `/dev/null` is a file that did not exist: the other name is the file.
        const name = headerPath(current.slice(4), "a/");
        if (name !== undefined && file.status !== "renamed" && file.status !== "copied") {
          oldPath = name;
        }
      } else if (current.startsWith("+++ ")) {
        const name = headerPath(current.slice(4), "b/");
        if (name !== undefined && file.status !== "renamed" && file.status !== "copied") {
          newPath = name;
        }
      } else if (current.startsWith("Binary files ") || current.startsWith("GIT binary patch")) {
        file.binary = true;
      }
    }
    if (file.status === "deleted") file.path = oldPath ?? newPath ?? "";
    else file.path = newPath ?? oldPath ?? "";
    if (
      (file.status === "renamed" || file.status === "copied") &&
      oldPath !== undefined &&
      oldPath !== file.path
    ) {
      file.oldPath = oldPath;
    }
    files.push(file);
  }
  return files;
}

/** One side of a row: the line number and the text. */
export interface DiffCell {
  no: number;
  text: string;
  /** The file ends at this line with no line break. */
  noEol?: boolean;
}

/**
 * A row of the side-by-side view: the start of a hunk (`@@ -1,3 +1,4 @@ fn`), a line both files
 * have, or a change, which has a line on the old side (a deleted one), on the new side (an added
 * one) or on both (a deleted line and the added line that takes its place).
 */
export type DiffRow =
  | { kind: "hunk"; label: string; heading: string }
  | { kind: "context"; old: DiffCell; new: DiffCell }
  | { kind: "change"; old?: DiffCell; new?: DiffCell };

const cell = (line: GitDiffLine, no: number | undefined): DiffCell => ({
  no: no ?? 0,
  text: line.text,
  ...(line.noEol === true ? { noEol: true } : {}),
});

/**
 * The rows of a side-by-side view of one file: each hunk starts with a `hunk` row, an unchanged line
 * sits on both sides, and a run of deleted and added lines is set side by side, the first deleted
 * line against the first added one and so on; the side that has more lines goes on alone. Reading
 * down the left column gives the old lines and down the right one the new lines, in order.
 */
export function sideBySideRows(file: GitDiffFile): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of file.hunks) {
    rows.push({
      kind: "hunk",
      label: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      heading: hunk.heading,
    });
    let removed: GitDiffLine[] = [];
    let added: GitDiffLine[] = [];
    const flush = (): void => {
      const count = Math.max(removed.length, added.length);
      for (let i = 0; i < count; i++) {
        const del = removed[i];
        const add = added[i];
        rows.push({
          kind: "change",
          ...(del !== undefined ? { old: cell(del, del.oldNo) } : {}),
          ...(add !== undefined ? { new: cell(add, add.newNo) } : {}),
        });
      }
      removed = [];
      added = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === "del") {
        removed.push(line);
      } else if (line.kind === "add") {
        added.push(line);
      } else {
        flush();
        rows.push({ kind: "context", old: cell(line, line.oldNo), new: cell(line, line.newNo) });
      }
    }
    flush();
  }
  return rows;
}

// File paths in a line of terminal output, and the full path a preview pane opens for each. Pure:
// it reads text and a folder and touches no disk, so a hover over the output costs nothing and what
// is underlined is decided by the line alone. The check that the file exists, is a file and can be
// shown is the preview pane's (`readFilePreview`), when it opens.

import { MAX_PREVIEW_PATH, classifyPreviewPath, previewPathProblem } from "./file-preview";

/** A path found in a line of output. */
export interface OutputPathMatch {
  /** Where the link starts in the line, in UTF-16 units. */
  start: number;
  /** Where the link ends (past its last unit); it takes in a `:line` or `:line:column` suffix. */
  end: number;
  /** The path as written, without the quotes, the punctuation after it or the suffix. */
  path: string;
  /** The line the output named after the path (`a.ts:12`), when it did. */
  line?: number;
  /** The column the output named after the line (`a.ts:12:5`), when it did. */
  column?: number;
}

// A path is a run of characters that are not white space, a quote, a bracket, a pipe, a redirection,
// a wildcard or a colon. The colon ends a run (it starts the line number of `a.ts:12`, and it
// separates the folders of a PATH), except the one after a drive letter, which the first
// alternative takes. Control characters end a run as well; a path with one is never a file name.
const BREAKS = String.raw`\s"'\`()\[\]{}<>|*?:\u0000-\u001f\u007f`;
// An equals sign followed by a drive starts a new run: `--file=C:\work\a.md`.
const TOKEN = new RegExp(
  String.raw`[A-Za-z]:[\\/][^${BREAKS}]*|(?:[^${BREAKS}=]|=(?![A-Za-z]:[\\/]))+`,
  "g",
);
// An address with a scheme is the business of the link of the output, not of this: its slashes,
// host and path are blanked out (same length, so the indexes stay) before the line is read.
const ADDRESS = /[A-Za-z][A-Za-z0-9+.-]+:\/\/[^\s"'`<>]*/g;
const SUFFIX = /^:(\d{1,9})(?::(\d{1,9}))?(?!\d)/;
const DRIVE_ROOT = /^[A-Za-z]:[\\/]/;
const STARTS_AS_PATH = /^(?:[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/])/;
const TRAILING = /[.,;!…]+$/u;
// A name with an extension: something before the dot, and at least one letter after it (so
// `3.14` and `v1.2` are numbers and versions, not files).
const NAME_WITH_EXTENSION = /^[^.].*\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/su;

const isSeparator = (c: string | undefined): boolean => c === "/" || c === "\\";

/** How a token reads as a path: a full path of a drive or of `/`, one that starts at `./` or `../`, or `dir/file.ext`. */
function looksLikePath(token: string): boolean {
  if (token.length > MAX_PREVIEW_PATH || isSeparator(token.at(-1)) || token.startsWith("~")) {
    return false;
  }
  if (DRIVE_ROOT.test(token))
    return token
      .slice(3)
      .split(/[\\/]/)
      .every((part) => part !== "");
  // Two separators at the start are a network or device path (`//host`, `\\server`): not a link.
  if (isSeparator(token[0]) && isSeparator(token[1])) return false;
  if (token[0] === "/") {
    const parts = token.slice(1).split("/");
    if (parts.some((part) => part === "")) return false;
    // `/s` and `/c` are the options of a command of Windows, not files; one name needs an extension.
    return parts.length > 1 || NAME_WITH_EXTENSION.test(parts[0] ?? "");
  }
  if (isSeparator(token[0])) return false;
  const parts = token.split(/[\\/]/);
  if (parts.length < 2 || parts.some((part) => part === "")) return false;
  const named = parts.filter((part) => part !== "." && part !== "..");
  if (named.length === 0) return false;
  // `./build.sh` and `../Makefile` are paths by how they start; `src/main.rs` needs the extension.
  if (parts[0] === "." || parts[0] === "..") return true;
  return NAME_WITH_EXTENSION.test(parts.at(-1) ?? "");
}

/**
 * The paths in `line`, left to right. Absolute paths are `C:\...` (a drive letter and a separator
 * only: no `\\?\` or `\\server` path) and `/...`; relative ones start at `./`, `.\`, `../` or `..\`
 * or are a folder, a separator and a name with an extension (`src/main.rs`). A path ends at white
 * space, a quote, a bracket or a colon, so a name with a blank in it is not found whole; the dots,
 * commas, semicolons and bangs that end a sentence are left out, and so are the quotes around the
 * path; a `:line` or `:line:column` after it is part of the link and not of the path. The text of
 * an address with a scheme (`https://host/a.md`) is not read, `~` is not expanded, and nothing is
 * looked up on a disk.
 */
export function findOutputPaths(line: string): OutputPathMatch[] {
  const text = line.replace(ADDRESS, (address) => " ".repeat(address.length));
  const found: OutputPathMatch[] = [];
  for (const match of text.matchAll(TOKEN)) {
    let raw = match[0];
    let start = match.index;
    // `--file=/tmp/a.md`: the path is what follows the equals sign.
    if (!STARTS_AS_PATH.test(raw) && raw.includes("=")) {
      const cut = raw.indexOf("=") + 1;
      raw = raw.slice(cut);
      start += cut;
    }
    const token = raw.replace(TRAILING, "");
    if (token === "" || !looksLikePath(token)) continue;
    let end = start + token.length;
    const entry: OutputPathMatch = { start, end, path: token };
    // The suffix belongs to the path only when nothing was cut from the end of it first.
    const suffix = token === raw ? SUFFIX.exec(line.slice(end)) : null;
    if (suffix !== null) {
      end += suffix[0].length;
      entry.end = end;
      entry.line = Number(suffix[1]);
      if (suffix[2] !== undefined) entry.column = Number(suffix[2]);
    }
    found.push(entry);
  }
  return found;
}

/** Why a path found in the output is not opened: no folder to resolve it against, or a path the preview refuses. */
export type OutputPathProblem = "no-folder" | "network" | "invalid";

/** What a path found in the output turns into: the full path to preview, or why there is none. */
export type ResolvedOutputPath =
  { ok: true; path: string } | { ok: false; problem: OutputPathProblem };

/** The root of a full path (`C:` or `/`) and its parts, or `undefined` when it is not one. */
function splitFull(path: string): { root: string; windows: boolean; parts: string[] } | undefined {
  if (DRIVE_ROOT.test(path)) {
    return { root: path.slice(0, 2), windows: true, parts: path.slice(3).split(/[\\/]/) };
  }
  if (path.startsWith("/") && !path.startsWith("//")) {
    return { root: "", windows: false, parts: path.slice(1).split("/") };
  }
  return undefined;
}

/** The full path made of a root and its parts, with `.` dropped and `..` taking the part before it. */
function join(root: string, windows: boolean, parts: string[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") kept.pop();
    else kept.push(part);
  }
  if (windows) return kept.length === 0 ? `${root}\\` : `${root}\\${kept.join("\\")}`;
  return `/${kept.join("/")}`;
}

/**
 * The full path `path` (as found in the output) names. A full path is written out without `.` and
 * `..` (`..` at the root stays at the root, as it does in a shell); a relative one is resolved against
 * `cwd`, the folder of the pane, and without one (or with a folder that is not a full path) there is
 * nothing to resolve it against. The result is checked by `previewPathProblem`, the check a preview
 * pane holds its path to: a folder on the network gives a path that is refused here, before any pane
 * is made.
 */
export function resolveOutputPath(path: string, cwd: string | undefined): ResolvedOutputPath {
  let full = splitFull(path);
  if (full === undefined) {
    if (cwd === undefined) return { ok: false, problem: "no-folder" };
    const base = splitFull(cwd);
    if (base === undefined) {
      return {
        ok: false,
        problem: classifyPreviewPath(cwd) === "network" ? "network" : "no-folder",
      };
    }
    full = { ...base, parts: [...base.parts, ...path.split(/[\\/]/)] };
  }
  const result = join(full.root, full.windows, full.parts);
  if (previewPathProblem(result) === undefined) return { ok: true, path: result };
  return { ok: false, problem: classifyPreviewPath(result) === "network" ? "network" : "invalid" };
}

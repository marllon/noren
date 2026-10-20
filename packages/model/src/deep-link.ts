import type { Space, Workspace } from "./types";
import { windowShowing } from "./windows";

/** What a valid `noren://` link asks for. */
export type DeepLink =
  /** Focus the space whose default folder is `path`, or make one there. */
  | { kind: "open"; path: string }
  /** Run the action `id` declared in the `.noren/actions.json` of `path`. */
  | { kind: "action"; path: string; id: string };

export type ParseDeepLinkResult = { ok: true; link: DeepLink } | { ok: false; reason: string };

/** Longest folder path or action id a link may carry. */
const MAX_LENGTH = 4096;

/** The parameters each kind of link takes, all of them required. */
const PARAMS: Record<"open" | "action", readonly string[]> = {
  open: ["path"],
  action: ["path", "id"],
};

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** True when the text has a control character (NUL included). */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A drive path (`C:\x`, `C:/x`) or a UNC path (`\\server\share`). */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

/** Absolute on a POSIX system or on Windows. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsPath(path);
}

/** Reasons a decoded folder path is refused, or `undefined` when it is acceptable. */
function pathProblem(path: string): string | undefined {
  if (path === "") return "the path is empty";
  if (path.length > MAX_LENGTH) return "the path is too long";
  if (hasControl(path)) return "the path has a control character";
  if (!isAbsolutePath(path)) return "the path must be absolute";
  if (path.split(/[\\/]/).includes("..")) return 'the path must not have a ".." segment';
  return undefined;
}

/**
 * Parses a `noren://` link. Never throws. Accepted forms:
 *
 * - `noren://open?path=<folder>`
 * - `noren://action?path=<folder>&id=<action id>`
 *
 * Only those two hosts exist and each takes exactly the parameters shown, once each. Any other
 * parameter (a `command`, `cmd` or `args` included) refuses the whole link, so nothing in a link
 * can become a command: an action is only ever named by its `id` in the project's own file.
 * Values are percent-decoded (`%20`, `%C3%A9`); a `+` stays a plus. The folder must be absolute
 * (POSIX, drive or UNC) and have no `..` segment.
 */
export function parseDeepLink(url: string): ParseDeepLinkResult {
  const trimmed = url.trim();
  const head = /^noren:\/\/([^/?#]*)(\/?)(?:\?([^#]*))?(#.*)?$/i.exec(trimmed);
  if (!head) {
    return refuse(
      /^noren:/i.test(trimmed)
        ? "the link is not of the form noren://open?path=… or noren://action?path=…&id=…"
        : "the link does not start with noren://",
    );
  }
  const [, rawHost = "", , query, fragment] = head;
  if (fragment !== undefined) return refuse("the link must not have a fragment");
  const host = rawHost.toLowerCase();
  if (host !== "open" && host !== "action") {
    return refuse(
      rawHost === ""
        ? 'the link has no kind; use "open" or "action"'
        : `unknown link kind "${rawHost}"; use "open" or "action"`,
    );
  }
  if (query === undefined || query === "") return refuse("the link has no parameters");

  const allowed = PARAMS[host];
  const values = new Map<string, string>();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const rawName = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch {
      return refuse("the link has a bad percent-encoding");
    }
    if (name === "") return refuse("the link has an empty parameter name");
    if (!allowed.includes(name)) {
      return refuse(`the "${host}" link does not take the parameter "${name}"`);
    }
    if (values.has(name)) return refuse(`the parameter "${name}" is repeated`);
    values.set(name, value);
  }

  const path = values.get("path");
  if (path === undefined) return refuse('the "path" parameter is missing');
  const problem = pathProblem(path);
  if (problem !== undefined) return refuse(problem);
  if (host === "open") return { ok: true, link: { kind: "open", path } };

  const id = values.get("id")?.trim();
  if (id === undefined) return refuse('the "id" parameter is missing');
  if (id === "") return refuse("the action id is empty");
  if (id.length > MAX_LENGTH) return refuse("the action id is too long");
  if (hasControl(id)) return refuse("the action id has a control character");
  return { ok: true, link: { kind: "action", path, id } };
}

/**
 * The form two folders are compared in: `/` for `\`, repeated separators folded (a UNC prefix keeps
 * its two), no trailing separator (the root keeps its own).
 */
function folderKey(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const unc = slashed.startsWith("//");
  const folded = slashed.replace(/\/{2,}/g, "/");
  const trimmed = folded.length > 1 ? folded.replace(/\/+$/, "") : folded;
  const key = unc ? `/${trimmed}` : trimmed;
  return key === "" ? "/" : key;
}

/**
 * True when two folder paths name the same folder. `/` and `\` are the same separator and a
 * trailing separator does not count. A Windows-style path (a drive or UNC path) on either side
 * compares without regard to case; a POSIX path compares exactly.
 */
export function sameFolder(a: string, b: string): boolean {
  const left = folderKey(a);
  const right = folderKey(b);
  if (isWindowsPath(a) || isWindowsPath(b)) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * The space whose default folder is `path`: the active one when it matches, else the first in the
 * order of the switcher. `undefined` when none has that folder.
 */
export function findSpaceByFolder(workspace: Workspace, path: string): Space | undefined {
  // A space another window shows cannot be shown by the main window (the link would do nothing).
  const matching = workspace.spaces.filter(
    (space) =>
      space.defaults.cwd !== undefined &&
      sameFolder(space.defaults.cwd, path) &&
      windowShowing(workspace, space.id) === undefined,
  );
  return matching.find((space) => space.id === workspace.activeSpaceId) ?? matching[0];
}

/** Name for a space made from a link: the last segment of the folder, else the whole path. */
export function spaceNameForFolder(path: string): string {
  const last = path
    .split(/[\\/]/)
    .filter((part) => part !== "")
    .pop();
  return last === undefined || /^[A-Za-z]:$/.test(last) ? path.trim() : last;
}

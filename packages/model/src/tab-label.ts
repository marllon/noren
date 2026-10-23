import { previewFileName } from "./file-preview";
import { layoutPanes } from "./sessions";
import type { Item, Pane } from "./types";

// What a tab is called (NOR-F20-12). One place decides it, so the sidebar, the tab bar, the favorites,
// the breadcrumb, the search, the palette and what is read aloud all say the same name.
//
// The order, first one that has something to say wins:
//
//  1. The title the person typed (`titleLocked`): always, whatever the shell does.
//  2. The title the shell last asked for, which the app keeps equal to the automatic one below
//     (`item/rename` with the source `process`, never locked): the name of the folder the focused pane
//     is in, then ` · ` and the program of the command it is running when there is one
//     (`api · npm`); with no folder known yet, the program alone; with neither, nothing.
//  3. The automatic one, worked out now from the focused pane (the same rule, so a tab that has a folder
//     and no title yet is not left waiting for the next prompt).
//  4. The placeholder the interface gives (`Tab 3`), which is the only thing that needs a language and
//     so is given by the caller.
//
// The window title a program sets (OSC 0 and 2) is not read at all (docs/SHELL_INTEGRATION.md): the
// shell and the command line it reports are what a tab is named after, and a program that renames the
// window can not rename a tab the person named.

const ELLIPSIS = "…";

/** Longest name of a command used as a tab title. */
const MAX_COMMAND_NAME = 32;

/** Between the folder and the command in a title (`api · npm`). */
export const TITLE_SEPARATOR = " · ";

/** A Windows path: a drive letter, or any backslash. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.includes("\\");
}

/** Path with the separators and the case of the drive normalized, for comparing against `home`. */
function comparable(path: string, windows: boolean): string {
  const slashed = windows ? path.replaceAll("\\", "/") : path;
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  return windows ? trimmed.toLowerCase() : trimmed;
}

/**
 * A short form of a working directory for the sidebar: `home` becomes `~`, and a path with more than
 * `maxSegments` segments keeps only the last ones, behind an ellipsis. Both `/` and `\` are read as
 * separators; the result keeps the separator the path used. A path inside `home` is shown as
 * `~/rest` (`~\rest` on Windows); `home` itself is `~`. A Windows path compares with `home`
 * ignoring case and slash direction. A blank `cwd` gives an empty string.
 */
export function shortCwd(cwd: string, home?: string, maxSegments = 2): string {
  if (cwd.trim() === "") return "";
  const windows = isWindowsPath(cwd);
  const sep = windows && cwd.includes("\\") ? "\\" : "/";
  const split = (path: string): string[] => path.split(/[\\/]+/).filter((part) => part !== "");

  let root = "";
  let segments: string[];
  const homeKey = home !== undefined && home.trim() !== "" ? comparable(home, windows) : undefined;
  const cwdKey = comparable(cwd, windows);
  if (cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("~\\")) {
    root = "~";
    segments = split(cwd.slice(1));
  } else if (homeKey !== undefined && (cwdKey === homeKey || cwdKey.startsWith(`${homeKey}/`))) {
    root = "~";
    segments = split(cwd).slice(split(home ?? "").length);
  } else {
    const drive = /^[A-Za-z]:/.exec(cwd)?.[0];
    if (drive !== undefined) {
      root = drive;
      segments = split(cwd.slice(drive.length));
    } else {
      segments = split(cwd);
      if (cwd.startsWith("/") || cwd.startsWith("\\")) root = sep;
    }
  }

  if (segments.length === 0) return root === "~" ? "~" : `${root === sep ? "" : root}${sep}`;
  const kept = segments.slice(-maxSegments);
  const body = kept.join(sep);
  if (segments.length > maxSegments) return `${ELLIPSIS}${sep}${body}`;
  if (root === "~") return `~${sep}${body}`;
  if (root === sep) return `${sep}${body}`;
  return root === "" ? body : `${root}${sep}${body}`;
}

/**
 * The pane that speaks for a tab: the one with the keyboard, or the first terminal pane when that one
 * is a browser or a preview pane, which have no folder, branch, command or program to name the tab
 * after.
 */
export function speakingPane(item: Item): Pane | undefined {
  const panes = layoutPanes(item.layout);
  const focused = panes.find((pane) => pane.id === item.focusedPaneId) ?? panes[0];
  return focused !== undefined && focused.type !== "terminal"
    ? (panes.find((pane) => pane.type === "terminal") ?? focused)
    : focused;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Leading `NAME=value` words (which run nothing), then the program: quoted, or up to a blank. */
const PROGRAM = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:"([^"]*)"|'([^']*)'|(\S+))/;

/**
 * The name of the program a command line runs: its first word, without quotes, folder or Windows
 * extension (`C:\tools\node.exe app.js` is `node`). Leading `NAME=value` words are skipped.
 * `undefined` when there is no such word.
 */
export function commandName(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const match = PROGRAM.exec(text);
  const word = match?.[1] ?? match?.[2] ?? match?.[3];
  // A line with only assignments runs nothing.
  if (word === undefined || (match?.[3] !== undefined && ASSIGNMENT.test(word))) return undefined;
  const base = word.trim().split(/[\\/]/).pop() ?? "";
  const name = base.replace(/\.(exe|cmd|bat|com|ps1)$/i, "");
  if (name === "") return undefined;
  return name.length > MAX_COMMAND_NAME ? `${name.slice(0, MAX_COMMAND_NAME - 1)}…` : name;
}

/**
 * The last part of a folder, as a tab title: `~` for the home folder and the root when there is no
 * last part (`/`, `C:\`). A trailing slash does not matter, and `\` and `/` both separate. `undefined`
 * for a blank folder.
 */
export function folderName(cwd: string | undefined, home?: string): string | undefined {
  if (cwd === undefined || cwd.trim() === "") return undefined;
  const short = shortCwd(cwd, home);
  if (short === "~") return "~";
  const last = cwd
    .split(/[\\/]+/)
    .filter((part) => part !== "")
    .pop();
  if (last === undefined || /^[A-Za-z]:$/.test(last)) return short;
  return last;
}

/**
 * The folder a pane is in for the purpose of naming its tab: the one its shell reported last, even the
 * folder the shell started in (which the pane does not record as its own, see `PaneLocationTracker`),
 * else the one the pane has.
 */
export function paneFolder(pane: Pane): string | undefined {
  return pane.shellCwd ?? pane.cwd;
}

/**
 * The title a pane gives its tab by itself: the name of its folder and, while a command runs, ` · ` and
 * the program of that command (`api · npm`); the program alone while no folder is known; none when the
 * pane has neither. A preview pane names a tab after its file. A running command whose line the shell
 * did not tell adds nothing.
 */
export function paneTitle(pane: Pane | undefined, home?: string): string | undefined {
  if (pane === undefined) return undefined;
  if (pane.type === "preview" && pane.path !== undefined) return previewFileName(pane.path);
  const folder = folderName(paneFolder(pane), home);
  const command = commandName(pane.runningCommand?.text);
  if (folder === undefined) return command;
  return command === undefined ? folder : `${folder}${TITLE_SEPARATOR}${command}`;
}

/** The title the focused pane of a tab asks for, `undefined` when it asks for nothing. */
export function autoTabTitle(item: Item, home?: string): string | undefined {
  return paneTitle(speakingPane(item), home);
}

export interface TabLabelOptions {
  /** The place of the tab among the tabs of its space, from 0: the number of the placeholder is one more. */
  index: number;
  /** The placeholder for a tab with nothing to say, given the number of the tab (`Tab 3`). */
  placeholder(n: number): string;
  /** The home folder, so a tab in it is `~`. */
  home?: string | undefined;
}

/** The name a tab shows, by the order at the top of this file. Never empty. */
export function tabLabel(item: Item, options: TabLabelOptions): string {
  // The title of the person and the one the shell asked for are both kept in `title`; the first is
  // never replaced (the reducer ignores a `process` rename while `titleLocked`).
  if (item.title !== undefined && item.title.trim() !== "") return item.title;
  return autoTabTitle(item, options.home) ?? options.placeholder(options.index + 1);
}

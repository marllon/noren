import type { Action, Item, Pane } from "@noren/model";
import { shortCwd, speakingPane } from "./pane-info";

/** Longest name of a command used as a tab title. */
const MAX_COMMAND_NAME = 32;

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
 * last part (`/`, `C:\`). `undefined` for a blank folder.
 */
export function folderTitle(cwd: string | undefined, home?: string): string | undefined {
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
 * The title a pane gives its tab by itself: the program it is running, else the last part of its
 * folder, else none. A running command whose line the shell did not tell gives no name, so the
 * folder is used.
 */
export function paneAutoTitle(pane: Pane | undefined, home?: string): string | undefined {
  if (pane === undefined) return undefined;
  return commandName(pane.runningCommand?.text) ?? folderTitle(pane.cwd, home);
}

/**
 * The action that gives a tab the title its focused pane asks for, or `undefined` when the tab
 * already has it. A tab whose title the user chose (locked) is never touched. When the pane asks
 * for nothing, a title that came from the shell goes away and the tab goes back to its number.
 */
export function autoTitleAction(item: Item, home?: string): Action | undefined {
  if (item.titleLocked) return undefined;
  const wanted = paneAutoTitle(speakingPane(item), home);
  if (wanted === item.title) return undefined;
  return { type: "item/rename", itemId: item.id, title: wanted ?? "", source: "process" };
}

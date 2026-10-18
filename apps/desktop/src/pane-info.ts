import { layoutPanes } from "@noren/model";
import type { Item, Pane } from "@noren/model";

const ELLIPSIS = "…";

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

/** What the sidebar shows for a tab, taken from the panes of its layout. */
export interface ItemSummary {
  /** Folder of the focused pane, falling back to `defaultCwd`; `undefined` when neither is set. */
  cwd?: string;
  /** Git branch of the focused pane. */
  gitBranch?: string;
  /** A command is running in some pane. */
  running: boolean;
  /** Exit code of the first pane that ended with an error; `null` when it ended without a code. */
  failed?: number | null;
  unread: boolean;
  bell: boolean;
}

/**
 * Sidebar facts of an item. A pane that exited with a code other than 0, or with none at all (the
 * shell never started or was killed), counts as an error.
 */
export function summarizeItem(item: Item, defaultCwd?: string): ItemSummary {
  const panes = layoutPanes(item.layout);
  const focused: Pane | undefined =
    panes.find((pane) => pane.id === item.focusedPaneId) ?? panes[0];
  const cwd = focused?.cwd ?? defaultCwd;
  const failed = panes.find((pane) => pane.status === "exited" && pane.exitCode !== 0);
  return {
    ...(cwd !== undefined && cwd.trim() !== "" ? { cwd } : {}),
    ...(focused?.gitBranch !== undefined && focused.gitBranch !== ""
      ? { gitBranch: focused.gitBranch }
      : {}),
    running: panes.some((pane) => pane.status === "running"),
    ...(failed ? { failed: failed.exitCode ?? null } : {}),
    unread: panes.some((pane) => pane.unread),
    bell: panes.some((pane) => pane.bell),
  };
}

/** Tooltip of the running indicator. */
export const RUNNING_LABEL = "Running";
/** Tooltip of the unread indicator. */
export const UNREAD_LABEL = "Unread output";
/** Tooltip of the bell indicator. */
export const BELL_LABEL = "Bell";

/** Tooltip of the error indicator. */
export function failureLabel(code: number | null): string {
  return code === null ? "Exited with an error" : `Exited with code ${code}`;
}

/** The indicators of a summary in words, in the order the sidebar draws them. */
export function indicatorLabels(summary: ItemSummary): string[] {
  return [
    ...(summary.running ? [RUNNING_LABEL] : []),
    ...(summary.failed !== undefined ? [failureLabel(summary.failed)] : []),
    ...(summary.unread ? [UNREAD_LABEL] : []),
    ...(summary.bell ? [BELL_LABEL] : []),
  ];
}

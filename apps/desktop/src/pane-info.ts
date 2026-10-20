import { layoutPanes, treeItemIds } from "@noren/model";
import type { AgentState, GroupNode, Item, Pane, SessionLink, Space } from "@noren/model";
import { t } from "./i18n";

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

/** How long a command took, for the sidebar: `<1s`, `2.5s`, `12s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return "<1s";
  const seconds = ms / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  const whole = Math.floor(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The command of a pane as the sidebar tells it: the one running now, else the last one that ended. */
export interface CommandInfo {
  /** `running`; `done` (exit code 0, or none known); `failed` (a code other than 0). */
  state: "running" | "done" | "failed";
  /** The command line, when the shell told it. */
  text?: string;
  exitCode?: number;
  /** The duration in words (see {@link formatDuration}); absent for a command still running. */
  duration?: string;
}

/** The command a pane shows; `undefined` when it never ran one that the shell reported. */
export function commandInfo(pane: Pane | undefined): CommandInfo | undefined {
  if (pane === undefined) return undefined;
  if (pane.runningCommand !== undefined) {
    return {
      state: "running",
      ...(pane.runningCommand.text !== undefined ? { text: pane.runningCommand.text } : {}),
    };
  }
  const last = pane.lastCommand;
  if (last === undefined) return undefined;
  const duration = last.durationMs !== undefined ? formatDuration(last.durationMs) : "";
  return {
    state: last.exitCode !== undefined && last.exitCode !== 0 ? "failed" : "done",
    ...(last.text !== undefined ? { text: last.text } : {}),
    ...(last.exitCode !== undefined ? { exitCode: last.exitCode } : {}),
    ...(duration !== "" ? { duration } : {}),
  };
}

/** The exit code of a command as the sidebar writes it, `exit 1`; empty while it runs or when unknown. */
export function exitText(info: CommandInfo): string {
  return info.exitCode === undefined ? "" : t("pane.exitCode", { code: info.exitCode });
}

/** The command in words for assistive technology: `Running npm test`, `Last command npm test, exit 1, 2.5s`. */
export function commandWords(info: CommandInfo): string {
  if (info.state === "running")
    return info.text !== undefined
      ? t("pane.runningCommand", { command: info.text })
      : t("pane.runningSome");
  const parts = [
    info.text !== undefined
      ? t("pane.lastCommand", { command: info.text })
      : t("pane.lastCommandBare"),
    ...(info.exitCode !== undefined ? [exitText(info)] : []),
    ...(info.duration !== undefined ? [info.duration] : []),
  ];
  return parts.join(", ");
}

/** The connection of a tab whose shell is on another machine, while it is not up. */
export type ItemLink = Pick<SessionLink, "attempt" | "maxAttempts" | "reason"> & {
  state: "reconnecting" | "failed";
};

/** What the sidebar shows for a tab, taken from the panes of its layout. */
export interface ItemSummary {
  /** Folder of the focused pane, falling back to `defaultCwd`; `undefined` when neither is set. */
  cwd?: string;
  /** Git branch of the focused pane. */
  gitBranch?: string;
  /** The CLI agent in the tab: the one in the focused pane, else in the first pane that has one. */
  agent?: string;
  /**
   * What the agents of the tab are doing: the most pressing state among its panes that have an
   * agent (waiting for you, then working, then idle). Absent when the tab has no agent.
   */
  agentState?: AgentState;
  /** A command is running in some pane. */
  running: boolean;
  /** The command of the focused pane: the one running now, else the last one. */
  command?: CommandInfo;
  /** Exit code of the first pane that ended with an error; `null` when it ended without a code. */
  failed?: number | null;
  unread: boolean;
  bell: boolean;
  /** The connection of the tab to its shell on another machine, when it is down (a failure outranks a retry). */
  link?: ItemLink;
}

/**
 * Sidebar facts of an item. A pane that exited with a code other than 0, or with none at all (the
 * shell never started or was killed), counts as an error.
 */
export function summarizeItem(
  item: Item,
  defaultCwd?: string,
  agentOf?: (pane: Pane) => string | undefined,
  agentStateOf?: (pane: Pane) => AgentState | undefined,
  linkOf?: (pane: Pane) => SessionLink | undefined,
): ItemSummary {
  const panes = layoutPanes(item.layout);
  const focused: Pane | undefined =
    panes.find((pane) => pane.id === item.focusedPaneId) ?? panes[0];
  const cwd = focused?.cwd ?? defaultCwd;
  const failed = panes.find((pane) => pane.status === "exited" && pane.exitCode !== 0);
  const command = commandInfo(focused);
  const agent =
    agentOf === undefined
      ? undefined
      : ((focused && agentOf(focused)) ?? panes.map(agentOf).find((id) => id !== undefined));
  const agentState =
    agent === undefined || agentStateOf === undefined
      ? undefined
      : mostPressing(panes, agentStateOf);
  const link = linkOf === undefined ? undefined : worstLink(panes, linkOf);
  return {
    ...(cwd !== undefined && cwd.trim() !== "" ? { cwd } : {}),
    ...(focused?.gitBranch !== undefined && focused.gitBranch !== ""
      ? { gitBranch: focused.gitBranch }
      : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(agentState !== undefined ? { agentState } : {}),
    running: panes.some((pane) => pane.status === "running" || pane.runningCommand !== undefined),
    ...(command !== undefined ? { command } : {}),
    ...(failed ? { failed: failed.exitCode ?? null } : {}),
    unread: panes.some((pane) => pane.unread),
    bell: panes.some((pane) => pane.bell),
    ...(link !== undefined ? { link } : {}),
  };
}

/** The connection that needs the person most among the panes of a tab: one that failed, else one retrying. */
function worstLink(
  panes: readonly Pane[],
  linkOf: (pane: Pane) => SessionLink | undefined,
): ItemLink | undefined {
  let found: ItemLink | undefined;
  for (const pane of panes) {
    const link = linkOf(pane);
    if (link === undefined || link.state === "connected") continue;
    if (found !== undefined && !(link.state === "failed" && found.state !== "failed")) continue;
    found = {
      state: link.state,
      ...(link.attempt !== undefined ? { attempt: link.attempt } : {}),
      ...(link.maxAttempts !== undefined ? { maxAttempts: link.maxAttempts } : {}),
      ...(link.reason !== undefined ? { reason: link.reason } : {}),
    };
  }
  return found;
}

/** The state that needs the person most: waiting for you, then working, then idle. */
const STATE_URGENCY: readonly AgentState[] = ["waiting", "working", "idle"];

function mostPressing(
  panes: readonly Pane[],
  stateOf: (pane: Pane) => AgentState | undefined,
): AgentState | undefined {
  const states = panes.map(stateOf);
  return STATE_URGENCY.find((state) => states.includes(state));
}

/** Tooltip of the agent icon: the plain name of the agent, as the catalog has it. */
export const agentLabel = (name: string): string => t("pane.agentLabel", { name });

/** The agent and what it is doing, in words: `Agent helper is waiting for you`. */
export const agentStateLabel = (name: string, state: AgentState): string =>
  t(`pane.agentState.${state}`, { name });

/** Tooltip of the running indicator. */
export const runningLabel = (): string => t("pane.runningLabel");
/** Tooltip of the unread indicator. */
export const unreadLabel = (): string => t("pane.unreadLabel");
/** Tooltip of the bell indicator. */
export const bellLabel = (): string => t("pane.bellLabel");

/** Tooltip of the error indicator. */
export function failureLabel(code: number | null): string {
  return code === null ? t("pane.exitedError") : t("pane.exitedCode", { code });
}

/** Notice of the shortcut that goes to the last unread tab when there is none. */
export const nothingUnreadNotice = (): string => t("pane.nothingUnread");

/** The unread and bell marks of the panes below a group or a space. */
export interface UnreadMarks {
  unread: boolean;
  bell: boolean;
}

function marksOf(items: readonly (Item | undefined)[]): UnreadMarks {
  const panes = items.flatMap((item) => (item ? layoutPanes(item.layout) : []));
  return { unread: panes.some((pane) => pane.unread), bell: panes.some((pane) => pane.bell) };
}

/** Whether any tab inside the group, at any depth, holds an unread pane or a bell. */
export function groupMarks(space: Space, group: GroupNode): UnreadMarks {
  return marksOf(treeItemIds(group.children).map((id) => space.items[id]));
}

/** Whether any tab of the space, pinned or not, holds an unread pane or a bell. */
export function spaceMarks(space: Space): UnreadMarks {
  return marksOf(Object.values(space.items));
}

/** The marks of a group or a space in words, for assistive technology. */
export function marksWords(marks: UnreadMarks): string[] {
  return [...(marks.unread ? [unreadLabel()] : []), ...(marks.bell ? [bellLabel()] : [])];
}

/**
 * The connection of a tab in a sentence. While it retries it says what the person needs to know:
 * what they type is not sent (the backend refuses a write with no connection and keeps nothing).
 */
export function linkText(link: ItemLink): string {
  if (link.state === "failed") {
    return link.reason !== undefined
      ? t("pane.link.failed", { reason: link.reason })
      : t("pane.link.failedBare");
  }
  const sentence =
    link.attempt !== undefined && link.maxAttempts !== undefined
      ? t("pane.link.reconnecting", { attempt: link.attempt, max: link.maxAttempts })
      : t("pane.link.reconnectingBare");
  return link.reason !== undefined ? `${sentence} ${link.reason}` : sentence;
}

/** The connection of a tab in a few words, for a tab with little room. */
export function linkShort(link: ItemLink): string {
  if (link.state === "failed") return t("pane.link.failedShort");
  return link.attempt !== undefined && link.maxAttempts !== undefined
    ? t("pane.link.reconnectingShort", { attempt: link.attempt, max: link.maxAttempts })
    : t("pane.link.reconnectingShortBare");
}

/** The indicators of a summary in words, in the order the sidebar draws them. */
export function indicatorLabels(summary: ItemSummary): string[] {
  return [
    ...(summary.link !== undefined ? [linkText(summary.link)] : []),
    ...(summary.agent !== undefined
      ? [
          summary.agentState !== undefined
            ? agentStateLabel(summary.agent, summary.agentState)
            : agentLabel(summary.agent),
        ]
      : []),
    ...(summary.running ? [runningLabel()] : []),
    ...(summary.failed !== undefined ? [failureLabel(summary.failed)] : []),
    ...(summary.unread ? [unreadLabel()] : []),
    ...(summary.bell ? [bellLabel()] : []),
  ];
}

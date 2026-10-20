import type { AgentState } from "./agent-state";
import { formatElapsed } from "./notifications";
import { spaceItemIds } from "./tree";
import type { Id, Pane, Space, Workspace } from "./types";
import { layoutPanes } from "./sessions";

// The list of the agents of all the spaces, for the Agents panel and its shortcut. Pure: the
// interface says which agent runs in which pane and what it is doing (`AgentInfo`), and this puts
// them in order, says how long each has been in its state and picks the one that waits for you.
//
// The order: waiting for you first, then working, then idle; inside a state the one that has been
// there longest comes first (it is the one that has waited longest); a tie keeps the order of the
// sidebar (spaces in order, tabs as the sidebar lists them, panes as the layout does).

/** What the interface knows about the agent of one pane. */
export interface AgentInfo {
  /** The id of its catalog entry, which is the name of the executable. */
  readonly agentId: string;
  readonly state: AgentState;
  /** When the state began, on the same clock as the `now` the list is built with. */
  readonly since: number;
  /** The last line of its output, as plain text (may be long; the list cuts it). */
  readonly lastLine: string;
}

/** One agent of the list, with where it is and for how long it has been in its state. */
export interface AgentRow {
  readonly paneId: Id;
  readonly itemId: Id;
  readonly spaceId: Id;
  readonly spaceName: string;
  readonly spaceColor: string;
  /** The name of its tab. */
  readonly itemTitle: string;
  readonly agentId: string;
  readonly state: AgentState;
  readonly since: number;
  /** Milliseconds in the state, never negative. */
  readonly elapsedMs: number;
  /** `elapsedMs` the way the list shows it (`formatElapsed`: `45s`, `3m 05s`, `2h 07m`). */
  readonly elapsed: string;
  /** The last line of the output, already cut for the screen; `""` when it printed nothing. */
  readonly lastLine: string;
}

/** The longest last line the list shows, in characters; a longer one ends in `…`. */
export const AGENT_LINE_MAX = 120;

const STATE_RANK: Readonly<Record<AgentState, number>> = { waiting: 0, working: 1, idle: 2 };

/** `line` cut to `max` characters (not UTF-16 units), with `…` as the last one when it was longer. */
export function truncateLine(line: string, max: number = AGENT_LINE_MAX): string {
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * The agents of every space in the order described above. `infoOf` answers for a pane (`undefined`
 * when it has no agent), `titleOf` names a tab (the interface holds the placeholder text for a tab
 * without a title), and `now` is on the clock `AgentInfo.since` was taken from.
 */
export function buildAgentList(
  workspace: Pick<Workspace, "spaces">,
  infoOf: (pane: Pane) => AgentInfo | undefined,
  titleOf: (space: Space, itemId: Id) => string,
  now: number,
): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const space of workspace.spaces) {
    for (const itemId of spaceItemIds(space)) {
      const item = space.items[itemId];
      if (item === undefined) continue;
      const itemTitle = titleOf(space, itemId);
      for (const pane of layoutPanes(item.layout)) {
        const info = infoOf(pane);
        if (info === undefined) continue;
        const elapsedMs = Math.max(0, now - info.since);
        rows.push({
          paneId: pane.id,
          itemId,
          spaceId: space.id,
          spaceName: space.name,
          spaceColor: space.color,
          itemTitle,
          agentId: info.agentId,
          state: info.state,
          since: info.since,
          elapsedMs,
          elapsed: formatElapsed(elapsedMs),
          lastLine: truncateLine(info.lastLine),
        });
      }
    }
  }
  // `sort` is stable, so a tie keeps the order of the sidebar.
  return rows.sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.elapsedMs - a.elapsedMs,
  );
}

/** The agent that has waited for you longest; `undefined` when none waits. */
export function firstWaitingAgent(rows: readonly AgentRow[]): AgentRow | undefined {
  return rows.find((row) => row.state === "waiting");
}

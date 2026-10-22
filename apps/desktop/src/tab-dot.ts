import type { ItemSummary } from "./pane-info";

/**
 * The state dot of a tab in the glass sidebar (the leading dot of a row, the corner of a favorite
 * tile): the color of what the tab needs from the person.
 *
 *  - `waiting` an agent in the tab waits for you (amber)
 *  - `running` a command runs in some pane, or an agent is working (green)
 *  - `idle`    nothing going on (the dot is only a muted point, so a row always has its place)
 */
export type TabDot = "waiting" | "running" | "idle";

/** The dot of a tab: waiting beats running, which beats idle. */
export function tabDotOf(summary: Pick<ItemSummary, "agentState" | "running">): TabDot {
  if (summary.agentState === "waiting") return "waiting";
  if (summary.running || summary.agentState === "working") return "running";
  return "idle";
}

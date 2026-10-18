import type { Id, Item, LayoutNode, Pane, Workspace } from "./types";

/** Panes of a layout, left to right. */
export function layoutPanes(layout: LayoutNode): Pane[] {
  return layout.kind === "pane" ? [layout.pane] : layout.children.flatMap(layoutPanes);
}

/** A copy of the item with every pane stripped of its session. */
export function withoutSessions(item: Item): Item {
  const strip = (layout: LayoutNode): LayoutNode => {
    if (layout.kind === "split") return { ...layout, children: layout.children.map(strip) };
    if (layout.pane.sessionId === undefined) return layout;
    const pane = { ...layout.pane };
    delete pane.sessionId;
    return { kind: "pane", pane };
  };
  return { ...item, layout: strip(item.layout) };
}

/**
 * Ids of the sessions held by panes of the spaces' items. Closed and archived items hold none: the
 * reducer strips the session from every pane it closes. The app ends the sessions in
 * `liveSessionIds(before)` that are missing from `liveSessionIds(after)`.
 */
export function liveSessionIds(ws: Workspace): Set<Id> {
  const ids = new Set<Id>();
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        if (pane.sessionId !== undefined) ids.add(pane.sessionId);
      }
    }
  }
  return ids;
}

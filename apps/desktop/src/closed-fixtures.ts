import type { Id, Item, Pane, Space } from "@noren/model";

// Small builders for the tests of closing and reopening tabs. Not used by the app.

/** A pane that has already started a shell in `cwd` and records a snapshot file when `ref` is true. */
export function fixturePane(id: Id, options: { cwd?: string; ref?: boolean } = {}): Pane {
  return {
    id,
    type: "terminal",
    profileId: "default",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    status: "idle",
    unread: false,
    bell: false,
    ...(options.ref === true ? { scrollbackRef: `${id}.txt` } : {}),
  };
}

/** A tab of one pane. */
export function fixtureTab(id: Id, pane: Pane): Item {
  return {
    id,
    titleLocked: false,
    layout: { kind: "pane", pane },
    focusedPaneId: pane.id,
    lastActivityAt: 1,
  };
}

/** A space whose tree holds `items` in order, at the top level. */
export function fixtureSpace(id: Id, items: readonly Item[], saveScrollback = true): Space {
  return {
    id,
    name: id,
    icon: "terminal",
    color: "#6b8afd",
    modIds: [],
    defaults: { env: {} },
    aiEnabled: true,
    saveScrollback,
    pinned: [],
    tree: items.map((item) => ({ kind: "item", id: item.id })),
    items: Object.fromEntries(items.map((item) => [item.id, item])),
    ...(items[0] !== undefined ? { activeItemId: items[0].id } : {}),
  };
}

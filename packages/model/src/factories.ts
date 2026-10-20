import type { Id, Item, Pane, Space } from "./types";

/** Profile of a pane when neither the action nor the space names one. */
export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_SPACE_ICON = "terminal";
export const DEFAULT_SPACE_COLOR = "#6b8afd";

export function createPane(id: Id, profileId: string, cwd?: string): Pane {
  return {
    id,
    type: "terminal",
    profileId,
    ...(cwd !== undefined ? { cwd } : {}),
    status: "idle",
    unread: false,
    bell: false,
  };
}

/**
 * A pane that shows the web page at `url`. It has no shell: no session, the default profile (so a
 * terminal pane split from it starts the default shell), and no folder. The address is the caller's
 * to check (`browserUrlProblem`).
 */
export function createBrowserPane(id: Id, url: string): Pane {
  return {
    id,
    type: "browser",
    profileId: DEFAULT_PROFILE_ID,
    url,
    status: "idle",
    unread: false,
    bell: false,
  };
}

/** A tab: one item with one pane, focused. */
export function createTab(itemId: Id, pane: Pane, lastActivityAt: number): Item {
  return {
    id: itemId,
    titleLocked: false,
    layout: { kind: "pane", pane },
    focusedPaneId: pane.id,
    lastActivityAt,
  };
}

export interface EmptySpaceOptions {
  icon?: string;
  color?: string;
  profileId?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** A space with nothing in it. */
export function createEmptySpace(id: Id, name: string, options: EmptySpaceOptions = {}): Space {
  return {
    id,
    name,
    icon: options.icon ?? DEFAULT_SPACE_ICON,
    color: options.color ?? DEFAULT_SPACE_COLOR,
    modIds: [],
    defaults: {
      env: { ...options.env },
      ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    },
    aiEnabled: true,
    saveScrollback: true,
    pinned: [],
    tree: [],
    items: {},
  };
}

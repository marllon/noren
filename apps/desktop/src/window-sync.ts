import { findWindow, parseState, treeGroups, workspaceWindows } from "@noren/model";
import type { Action, Id, Placement, Space, Workspace } from "@noren/model";
import type { QuickEvents } from "./quick";
import { WINDOW_READY_EVENT, windowIdOfPayload } from "./window-events";

// How the page of a window besides the main one learns what to draw, and how it asks for a change.
// The main window owns the workspace and is the only page that loads and saves it (`state.json`):
// it sends each window the space the window shows (`window-state`), and a window asks for the few
// changes it can make on its own (`window-action`: show another tab, focus a pane, resize a split,
// open a tab, close a tab, move a tab), which the main window checks and carries out. The page of a
// window never holds the workspace and never writes anything. The names are repeated in
// `src-tauri/src/windows.rs` and in the smoke.

/** Main window → window pages: the space the window shows, `{ windowId, space }`. */
export const WINDOW_STATE_EVENT = "window-state";
/** Window page → main window: a change the window asks for, `{ windowId, action }`. */
export const WINDOW_ACTION_EVENT = "window-action";

/**
 * The changes a window page can ask for, and nothing else. Every tab named is a tab of the space
 * the window shows (the main window checks), and a new tab is always made in that space.
 */
export type WindowAction =
  | { type: "space/set-active-item"; spaceId: Id; itemId: Id }
  | { type: "pane/focus"; itemId: Id; paneId: Id }
  | { type: "pane/resize"; itemId: Id; path: number[]; sizes: number[] }
  /** A new tab with a new shell, in the space of the window. */
  | { type: "item/create"; spaceId: Id }
  /** Closes the tab and ends its shells. */
  | { type: "item/close"; itemId: Id }
  /** Moves the tab inside the space of the window (the order of the sidebar). */
  | { type: "item/move"; itemId: Id; placement: Placement };

/** The deepest split and the most children a request about a resize may name. */
const MAX_SPLIT_DEPTH = 16;
const MAX_SPLIT_CHILDREN = 16;
/**
 * The most tabs the space of a window may hold for it to open another: a window that asked for
 * shells without end would fill the machine. Generous (a person does not open this many by hand).
 */
export const MAX_WINDOW_TABS = 64;
/** The furthest place in a list a request to move a tab may name. */
const MAX_TAB_INDEX = 4096;

/** The payload of `window-state` for the window `windowId` showing `space`. */
export function windowStatePayload(windowId: Id, space: Space): { windowId: Id; space: Space } {
  return { windowId, space };
}

/**
 * The space a `window-state` event carries for the window `windowId`, or `undefined` for an event
 * for another window or one that does not carry a space the model accepts. An event can carry
 * whatever a page sent, so the space is read the way a saved state is: its shape and its
 * invariants (the ids, the tree, the panes) are checked before anything draws it.
 */
export function spaceOfWindowState(payload: unknown, windowId: Id): Space | undefined {
  if (windowIdOfPayload(payload) !== windowId) return undefined;
  const space = (payload as { space?: unknown }).space;
  if (typeof space !== "object" || space === null) return undefined;
  const alone = {
    version: 2,
    spaces: [space],
    activeSpaceId: (space as { id?: unknown }).id,
    favorites: [],
    closed: [],
    archive: [],
  };
  const read = parseState(JSON.stringify(alone));
  return read.ok ? read.workspace.spaces[0] : undefined;
}

const wholeNumbers = (value: unknown, max: number): number[] | undefined =>
  Array.isArray(value) &&
  value.length <= max &&
  (value as unknown[]).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    ? (value as number[])
    : undefined;

/**
 * The place a request names for a tab, checked against the space of the window and made again from
 * the fields that were checked: the pinned list or the tree, a group that is in the tree of the
 * space, a place that is a whole number. `undefined` for anything else.
 */
function placementOfRequest(value: unknown, space: Space): Placement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { to, groupId, index } = value as Record<string, unknown>;
  if (index !== undefined) {
    if (typeof index !== "number" || !Number.isSafeInteger(index)) return undefined;
    if (index < 0 || index > MAX_TAB_INDEX) return undefined;
  }
  const at = typeof index === "number" ? { index } : {};
  if (to === "pinned") return groupId === undefined ? { to, ...at } : undefined;
  if (to !== "tree") return undefined;
  if (groupId === undefined) return { to, ...at };
  if (typeof groupId !== "string" || !treeGroups(space.tree).some((g) => g.id === groupId)) {
    return undefined;
  }
  return { to, groupId, ...at };
}

/**
 * The action a `window-action` event asks for, as the workspace would run it, or `undefined` when
 * the event is not for a window of the workspace, names a tab that the space of that window does
 * not hold, or asks for something a window may not ask. Only what a window can do is accepted, and
 * the action is made again from the fields that were checked, so nothing else a page sent gets
 * through.
 */
export function actionOfWindowRequest(payload: unknown, workspace: Workspace): Action | undefined {
  const windowId = windowIdOfPayload(payload);
  if (windowId === undefined) return undefined;
  const window = findWindow(workspace, windowId);
  const space = workspace.spaces.find((s) => s.id === window?.spaceId);
  if (window === undefined || space === undefined) return undefined;
  const request = (payload as { action?: unknown }).action;
  if (typeof request !== "object" || request === null) return undefined;
  const { type, itemId, paneId, spaceId, path, sizes, placement } = request as Record<
    string,
    unknown
  >;
  // A new tab names no tab: it is made in the space of the window, and only while that has room.
  if (type === "item/create") {
    return spaceId === space.id && Object.keys(space.items).length < MAX_WINDOW_TABS
      ? { type, spaceId: space.id }
      : undefined;
  }
  if (typeof itemId !== "string" || !Object.hasOwn(space.items, itemId)) return undefined;
  switch (type) {
    case "space/set-active-item":
      return spaceId === space.id ? { type, spaceId: space.id, itemId } : undefined;
    case "item/close":
      return { type, itemId };
    case "item/move": {
      // Moved inside the space of the window: the action never names another space.
      const where = placementOfRequest(placement, space);
      return where === undefined ? undefined : { type, itemId, placement: where };
    }
    case "pane/focus":
      return typeof paneId === "string" ? { type, itemId, paneId } : undefined;
    case "pane/resize": {
      const where = wholeNumbers(path, MAX_SPLIT_DEPTH);
      const shares = Array.isArray(sizes) ? (sizes as unknown[]) : undefined;
      if (
        where === undefined ||
        shares === undefined ||
        shares.length > MAX_SPLIT_CHILDREN ||
        !shares.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        return undefined;
      }
      return { type, itemId, path: where, sizes: shares as number[] };
    }
    default:
      return undefined;
  }
}

/** The windows besides the main one that the workspace has, with the space each shows. */
function shownSpaces(workspace: Workspace): Map<Id, Space> {
  const shown = new Map<Id, Space>();
  for (const window of workspaceWindows(workspace)) {
    const space = workspace.spaces.find((s) => s.id === window.spaceId);
    if (space !== undefined) shown.set(window.id, space);
  }
  return shown;
}

/** What the main window needs from the store: the workspace, its changes, and the actions. */
export interface WindowSyncStore {
  getState(): { workspace: Workspace; dispatch(action: Action): void };
  subscribe(listener: () => void): () => void;
}

/**
 * What carries out a request that passed the checks. The default dispatches the action; the main
 * window gives one that also starts the shell of a new tab and ends the window of a tab that was
 * the last (`runWindowAction`), which need the backend. It may be asynchronous; it must not throw.
 */
export type WindowActionRunner = (windowId: Id, action: Action) => unknown;

/**
 * Keeps the pages of the windows in step with the workspace (run by the main window): each window
 * gets the space it shows when its page says it is ready (`window-ready`) and again each time that
 * space changes, and the changes the pages ask for (`window-action`) are checked and run (`run`).
 * Returns the function that stops it. Never throws: an event that is not understood is ignored.
 */
export function followWindowPages(
  store: WindowSyncStore,
  events: QuickEvents,
  run: WindowActionRunner = (_windowId, action) => store.getState().dispatch(action),
): () => void {
  // The space each window was last sent: an unchanged space is not sent again.
  const sent = new Map<Id, Space>();
  const send = (windowId: Id, space: Space): void => {
    sent.set(windowId, space);
    events.emit(WINDOW_STATE_EVENT, windowStatePayload(windowId, space)).catch(() => undefined);
  };
  const sendChanged = (): void => {
    const shown = shownSpaces(store.getState().workspace);
    for (const windowId of [...sent.keys()]) if (!shown.has(windowId)) sent.delete(windowId);
    for (const [windowId, space] of shown) if (sent.get(windowId) !== space) send(windowId, space);
  };
  let stopped = false;
  const stops: (() => void)[] = [store.subscribe(sendChanged)];
  const listen = (event: string, handler: (payload: unknown) => void): void => {
    events
      .listen(event, handler)
      .then((stop) => {
        if (stopped) stop();
        else stops.push(stop);
      })
      .catch(() => undefined);
  };
  // A page that just loaded asks for its space, which it may have missed.
  listen(WINDOW_READY_EVENT, (payload) => {
    const windowId = windowIdOfPayload(payload);
    const space =
      windowId === undefined ? undefined : shownSpaces(store.getState().workspace).get(windowId);
    if (windowId !== undefined && space !== undefined) send(windowId, space);
  });
  listen(WINDOW_ACTION_EVENT, (payload) => {
    const windowId = windowIdOfPayload(payload);
    const action = actionOfWindowRequest(payload, store.getState().workspace);
    if (windowId === undefined || action === undefined) return;
    try {
      // A runner that is asynchronous and fails must not leave a rejection nobody reads.
      Promise.resolve(run(windowId, action)).catch(() => undefined);
    } catch {
      // A request that could not be carried out changes nothing.
    }
  });
  // The windows the workspace has now are sent to pages that are up already.
  sendChanged();
  return () => {
    stopped = true;
    for (const stop of stops.splice(0)) stop();
  };
}

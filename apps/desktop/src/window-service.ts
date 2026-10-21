import {
  canOpenWindow,
  findWindow,
  layoutPanes,
  windowCanShowTab,
  workspaceWindows,
} from "@noren/model";
import type { Action, Backend, Id, Space, Unsubscribe, Workspace } from "@noren/model";
import type { QuickEvents } from "./quick";
import { sessionStartOptions } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";
import { followWindowBrowsers } from "./window-browser";
import { followWindowPages, followWindowReads } from "./window-sync";

/** The size a shell of a tab opened from a window starts with, until the terminal of the window fits it. */
const NEW_TAB_COLS = 80;
const NEW_TAB_ROWS = 24;

// The windows of the app as the main window, which owns the workspace, drives them: the workspace
// says which windows there are and which space each shows (`Workspace.windows`), the backend makes
// the native windows and moves the output of the sessions. No other window loads the workspace or
// writes `state.json`.

/** What became of a request about a window: it worked, or why it did not (nothing changed then). */
export type WindowResult = { ok: true; windowId: Id } | { ok: false; reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Opens a window that shows the space: the workspace gets the window first (the model decides if
 * the space can be shown there: it must exist and no other window may show it), then the backend
 * makes the native window. A backend that refuses takes the window out of the workspace again, so
 * the two never disagree. Never throws.
 */
export async function openWindowOnSpace(
  store: WorkspaceStore,
  backend: Pick<Backend, "openWindow">,
  spaceId: Id,
): Promise<WindowResult> {
  const known = new Set(workspaceWindows(store.getState().workspace).map((w) => w.id));
  store.getState().dispatch({ type: "window/open", spaceId });
  const made = workspaceWindows(store.getState().workspace).find((w) => !known.has(w.id));
  if (made === undefined) {
    return { ok: false, reason: "that space cannot be shown in a window of its own" };
  }
  try {
    await backend.openWindow(made.id, spaceId);
  } catch (error) {
    store.getState().dispatch({ type: "window/close", windowId: made.id });
    return { ok: false, reason: reasonOf(error) };
  }
  return { ok: true, windowId: made.id };
}

/**
 * Closes a window: it leaves the workspace and the native window is closed. The space it showed
 * keeps its tabs and their sessions. Never throws.
 */
export async function closeAppWindow(
  store: WorkspaceStore,
  backend: Pick<Backend, "closeWindow">,
  windowId: Id,
): Promise<WindowResult> {
  if (findWindow(store.getState().workspace, windowId) === undefined) {
    return { ok: false, reason: "no such window" };
  }
  store.getState().dispatch({ type: "window/close", windowId });
  try {
    await backend.closeWindow(windowId);
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  return { ok: true, windowId };
}

/** The sessions of the panes of the tab `itemId`, as the backend names them; none for an unknown tab. */
function sessionsOfItem(store: WorkspaceStore, itemId: Id): number[] {
  for (const space of store.getState().workspace.spaces) {
    const item = space.items[itemId];
    if (item === undefined) continue;
    return layoutPanes(item.layout).flatMap((pane) =>
      pane.sessionId === undefined ? [] : [Number(pane.sessionId)],
    );
  }
  return [];
}

/** The sessions of every pane of every tab of the space, as the backend names them. */
function sessionsOfSpace(space: Space): number[] {
  return Object.values(space.items).flatMap((item) =>
    layoutPanes(item.layout).flatMap((pane) =>
      pane.sessionId === undefined ? [] : [Number(pane.sessionId)],
    ),
  );
}

/**
 * Moves the tab to the window: the page of the window takes over the output of the sessions of its
 * panes first (the same processes, nothing restarted), then the tab goes into the space the window
 * shows (`window/move-item`) and becomes the one that window shows. A window that refuses, or does
 * not answer, leaves the tab where it was. Never throws.
 */
export async function moveItemToWindow(
  store: WorkspaceStore,
  backend: Pick<Backend, "moveTabToWindow">,
  itemId: Id,
  windowId: Id,
): Promise<WindowResult> {
  const window = findWindow(store.getState().workspace, windowId);
  if (window === undefined) return { ok: false, reason: "no such window" };
  const holder = store.getState().workspace.spaces.find((s) => Object.hasOwn(s.items, itemId));
  if (holder === undefined) return { ok: false, reason: "no such tab" };
  if (holder.id === window.spaceId)
    return { ok: false, reason: "that tab is in the window already" };
  const item = holder.items[itemId];
  if (item !== undefined && !windowCanShowTab(item)) {
    return { ok: false, reason: "that tab has a pane a window cannot show" };
  }
  try {
    await backend.moveTabToWindow(windowId, sessionsOfItem(store, itemId));
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
  store.getState().dispatch({ type: "window/move-item", itemId, windowId });
  const now = store.getState().workspace.spaces.find((s) => s.id === window.spaceId);
  return now !== undefined && Object.hasOwn(now.items, itemId)
    ? { ok: true, windowId }
    : { ok: false, reason: "the tab or the window changed while the tab moved" };
}

/** Why a tab cannot go to a window of its own: it is not there, it has a pane the page of a window cannot draw (`windowCanShowTab`; none today), or the windows are too many. */
export type WindowMoveProblem = "no-tab" | "panes" | "limit";

/** What stops the tab `itemId` from going to a new window, or `undefined` when nothing does. */
export function windowMoveProblem(workspace: Workspace, itemId: Id): WindowMoveProblem | undefined {
  const holder = workspace.spaces.find((space) => Object.hasOwn(space.items, itemId));
  const item = holder?.items[itemId];
  if (item === undefined) return "no-tab";
  if (!windowCanShowTab(item)) return "panes";
  return canOpenWindow(workspace) ? undefined : "limit";
}

/**
 * Takes the tab out to a window of its own (dragging it out of the window, or the palette): the
 * workspace gets a space for the window, the window and the tab in it in one step
 * (`window/open-with-item`), then the backend makes the native window and the page of the window
 * takes over the output of the sessions of the tab (the same processes, nothing restarted). A
 * backend that refuses, or a window that does not answer, gives the tab back where it came from, so
 * the workspace and the windows never disagree. `name` names the space (the title of the tab).
 * Never throws.
 */
export async function moveItemToNewWindow(
  store: WorkspaceStore,
  backend: Pick<Backend, "openWindow" | "moveTabToWindow" | "attachSession" | "closeWindow">,
  itemId: Id,
  name?: string,
): Promise<WindowResult> {
  const problem = windowMoveProblem(store.getState().workspace, itemId);
  if (problem !== undefined) {
    return {
      ok: false,
      reason:
        problem === "no-tab"
          ? "no such tab"
          : problem === "panes"
            ? "that tab has a pane a window cannot show"
            : "there are too many windows",
    };
  }
  const known = new Set(workspaceWindows(store.getState().workspace).map((w) => w.id));
  store.getState().dispatch({
    type: "window/open-with-item",
    itemId,
    ...(name !== undefined ? { name } : {}),
  });
  const made = workspaceWindows(store.getState().workspace).find((w) => !known.has(w.id));
  if (made === undefined) return { ok: false, reason: "that tab cannot go to a window of its own" };
  try {
    await backend.openWindow(made.id, made.spaceId);
    await backend.moveTabToWindow(made.id, sessionsOfItem(store, itemId));
  } catch (error) {
    await returnWindowTabs(store, backend, made.id);
    return { ok: false, reason: reasonOf(error) };
  }
  return { ok: true, windowId: made.id };
}

/**
 * Gives the tabs of a window back and closes it: the sessions of the tabs are attached to this
 * page again first (the output of a session goes to the page that attached it last, and the page
 * of the window is gone or going), then the workspace takes the tabs back (`window/return`: to the
 * space they came from, or the one the main window shows), and the native window is closed if it
 * is still there. A window that was always on a space of the user is closed and keeps the space.
 * Never throws; a session that ended meanwhile is left out.
 */
export async function returnWindowTabs(
  store: WorkspaceStore,
  backend: Pick<Backend, "attachSession" | "closeWindow">,
  windowId: Id,
): Promise<WindowResult> {
  const window = findWindow(store.getState().workspace, windowId);
  if (window === undefined) return { ok: false, reason: "no such window" };
  const space = store.getState().workspace.spaces.find((s) => s.id === window.spaceId);
  if (space !== undefined && window.returnSpaceId !== undefined) {
    for (const id of sessionsOfSpace(space)) {
      await backend.attachSession(id, { replay: true }).catch(() => undefined);
    }
  }
  store.getState().dispatch({ type: "window/return", windowId });
  await backend.closeWindow(windowId).catch(() => undefined);
  return { ok: true, windowId };
}

/**
 * Opens a tab in the space of the window, for a window that asked for one: the workspace gets the
 * tab (`item/create`, in the space of the window, with its profile, folder and environment), the
 * shell of its pane is started here, where the shells of the app are started and the pane is told
 * its session, and the page of the window takes the output of that shell over (the same
 * processes under the same ids, as for a tab moved there). A shell that cannot start, or a window
 * that does not take it, closes the tab again, so the workspace and the window never disagree.
 * Never throws.
 */
export async function openTabInWindow(
  store: WorkspaceStore,
  backend: Pick<Backend, "createSession" | "moveTabToWindow">,
  windowId: Id,
): Promise<WindowResult> {
  const window = findWindow(store.getState().workspace, windowId);
  const before = store.getState().workspace.spaces.find((s) => s.id === window?.spaceId);
  if (window === undefined || before === undefined) return { ok: false, reason: "no such window" };
  const known = new Set(Object.keys(before.items));
  store.getState().dispatch({ type: "item/create", spaceId: window.spaceId });
  const space = store.getState().workspace.spaces.find((s) => s.id === window.spaceId);
  const itemId = Object.keys(space?.items ?? {}).find((id) => !known.has(id));
  const item = itemId === undefined ? undefined : space?.items[itemId];
  const pane = item === undefined ? undefined : layoutPanes(item.layout)[0];
  if (space === undefined || itemId === undefined || pane === undefined) {
    return { ok: false, reason: "the tab could not be made" };
  }
  const closeAgain = (): void => store.getState().dispatch({ type: "item/close", itemId });
  let session: number;
  try {
    session = await backend.createSession({
      ...sessionStartOptions(space, pane),
      paneId: pane.id,
      cols: NEW_TAB_COLS,
      rows: NEW_TAB_ROWS,
    });
  } catch (error) {
    closeAgain();
    return { ok: false, reason: reasonOf(error) };
  }
  // The pane is told its session (the shell is ended instead when the pane closed meanwhile).
  store.getState().attachSession(pane.id, String(session));
  try {
    await backend.moveTabToWindow(windowId, [session]);
  } catch (error) {
    closeAgain();
    return { ok: false, reason: reasonOf(error) };
  }
  return { ok: true, windowId };
}

/**
 * Carries out a request a window made that the main window checked (see `actionOfWindowRequest`).
 * A new tab starts its shell (`openTabInWindow`); closing a tab ends its shells (the store does,
 * for every pane an action drops) and, when it was the last tab of the window, closes the window
 * (`returnWindowTabs`: a window made for a tab goes away with the space made for it, one on a space
 * of the user is closed and keeps the space); everything else is an action of the workspace. Never
 * throws.
 */
export async function runWindowAction(
  store: WorkspaceStore,
  backend: Pick<Backend, "createSession" | "moveTabToWindow" | "attachSession" | "closeWindow">,
  windowId: Id,
  action: Action,
): Promise<void> {
  try {
    if (action.type === "item/create") {
      await openTabInWindow(store, backend, windowId);
      return;
    }
    store.getState().dispatch(action);
    if (action.type !== "item/close") return;
    const window = findWindow(store.getState().workspace, windowId);
    const space = store.getState().workspace.spaces.find((s) => s.id === window?.spaceId);
    if (window !== undefined && space !== undefined && Object.keys(space.items).length === 0) {
      await returnWindowTabs(store, backend, windowId);
    }
  } catch {
    // A request that could not be carried out changes nothing more.
  }
}

/**
 * Opens the native window of every window the workspace has (the app was closed or reloaded with
 * windows open; `state.json` remembers them) and hands each the sessions of its tabs, which the
 * restore started with the rest. A window that cannot be brought up gives its tabs back. Never
 * throws.
 */
export async function bringUpWindows(
  store: WorkspaceStore,
  backend: Pick<Backend, "openWindow" | "moveTabToWindow" | "attachSession" | "closeWindow">,
): Promise<void> {
  for (const window of [...workspaceWindows(store.getState().workspace)]) {
    const space = store.getState().workspace.spaces.find((s) => s.id === window.spaceId);
    if (space === undefined) continue;
    try {
      await backend.openWindow(window.id, window.spaceId);
      const sessions = sessionsOfSpace(space);
      if (sessions.length > 0) await backend.moveTabToWindow(window.id, sessions);
    } catch {
      await returnWindowTabs(store, backend, window.id);
    }
  }
}

/**
 * Keeps the workspace in step with the native windows: when the person closes one, it leaves the
 * workspace. A window made for a tab sends its tabs back to the main window and attaches their
 * sessions to it again (`returnWindowTabs`); one on a space of the user keeps the space, and its
 * sessions go on with no page until a window shows the space again. Returns the function that
 * stops listening.
 */
export function followWindowClosed(
  store: WorkspaceStore,
  backend: Pick<Backend, "onWindowClosed" | "attachSession" | "closeWindow">,
): Unsubscribe {
  return backend.onWindowClosed((windowId) => {
    if (findWindow(store.getState().workspace, windowId)?.returnSpaceId !== undefined) {
      void returnWindowTabs(store, backend, windowId);
      return;
    }
    store.getState().dispatch({ type: "window/close", windowId });
  });
}

/**
 * Starts what the main window does for the other windows (the interface starts it once, at boot):
 * the pages of the windows get the space they show and their requests are carried out
 * (`followWindowPages`), the files and git diffs their preview and diff panes need are read here
 * and sent to them (`followWindowReads`), the web views of their browser panes are opened here as
 * children of the window and kept in step with the workspace (`followWindowBrowsers`), a window the
 * person closes gives its tabs back (`followWindowClosed`), and the windows the saved state
 * remembers are brought up again (`bringUpWindows`). Returns the function that stops the first
 * four.
 */
export function startWindows(
  store: WorkspaceStore,
  backend: Pick<
    Backend,
    | "openWindow"
    | "moveTabToWindow"
    | "attachSession"
    | "closeWindow"
    | "onWindowClosed"
    | "createSession"
    | "readFilePreview"
    | "readGitDiff"
    | "openBrowserPane"
    | "navigateBrowserPane"
    | "setBrowserPaneBounds"
    | "closeBrowserPane"
  >,
  events: QuickEvents,
): Unsubscribe {
  const stopPages = followWindowPages(store, events, (windowId, action) =>
    runWindowAction(store, backend, windowId, action),
  );
  const stopReads = followWindowReads(store, backend, events);
  const stopBrowsers = followWindowBrowsers(store, backend, events);
  const stopClosed = followWindowClosed(store, backend);
  void bringUpWindows(store, backend);
  return () => {
    stopPages();
    stopReads();
    stopBrowsers();
    stopClosed();
  };
}

/**
 * Gives the tabs of every window of the workspace back to the main window, for a page that cannot
 * show another window (a plain browser opening a state saved by one that could). The shells of the
 * tabs were restored in this page, so nothing else has to move.
 */
export function releaseWindows(store: WorkspaceStore): void {
  for (const window of [...workspaceWindows(store.getState().workspace)]) {
    store.getState().dispatch({ type: "window/return", windowId: window.id });
  }
}

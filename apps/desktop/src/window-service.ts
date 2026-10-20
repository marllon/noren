import { findWindow, layoutPanes, workspaceWindows } from "@noren/model";
import type { Backend, Id, Unsubscribe } from "@noren/model";
import type { WorkspaceStore } from "./workspace-store";

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

/**
 * Keeps the workspace in step with the native windows: when the person closes one, it leaves the
 * workspace (its space keeps the tabs; their sessions go on with no page until a window shows the
 * space again). Returns the function that stops listening.
 */
export function followWindowClosed(
  store: WorkspaceStore,
  backend: Pick<Backend, "onWindowClosed">,
): Unsubscribe {
  return backend.onWindowClosed((windowId) => {
    store.getState().dispatch({ type: "window/close", windowId });
  });
}

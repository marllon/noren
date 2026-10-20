import { MAX_EXTRA_WINDOWS } from "./types";
import type { AppWindow, Id, Workspace } from "./types";

/**
 * The start of the label of the native window of every `AppWindow`. The app chooses only what
 * follows, so a window can never be named `main`, `quick` or the web view of a browser pane
 * (`browser-<pane id>`).
 */
export const WINDOW_LABEL_PREFIX = "window-";

/** The longest window id, so the label of the window stays short. */
const MAX_WINDOW_ID = 64;

/**
 * Whether `id` can name a window: ASCII letters, digits, `-` and `_`, at most 64 (the id the app
 * makes, a UUID, is one). The id becomes part of the label of a native window.
 */
export function isWindowId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_WINDOW_ID
    ? /^[A-Za-z0-9_-]+$/u.test(id)
    : false;
}

/** The label of the native window of the window `id` (`window-<id>`). */
export function windowLabel(id: Id): string {
  return `${WINDOW_LABEL_PREFIX}${id}`;
}

/** The id of the window a native window label names, or `undefined` for any other label. */
export function windowIdOfLabel(label: string): Id | undefined {
  if (!label.startsWith(WINDOW_LABEL_PREFIX)) return undefined;
  const id = label.slice(WINDOW_LABEL_PREFIX.length);
  return isWindowId(id) ? id : undefined;
}

/** The windows of the app besides the main one (none for a workspace without any). */
export function workspaceWindows(ws: Pick<Workspace, "windows">): readonly AppWindow[] {
  return ws.windows ?? [];
}

/** The window `windowId`, if it is one of the workspace's. */
export function findWindow(ws: Pick<Workspace, "windows">, windowId: Id): AppWindow | undefined {
  return workspaceWindows(ws).find((window) => window.id === windowId);
}

/** The window besides the main one that shows the space, if any. */
export function windowShowing(ws: Pick<Workspace, "windows">, spaceId: Id): AppWindow | undefined {
  return workspaceWindows(ws).find((window) => window.spaceId === spaceId);
}

/** Whether some window, the main one or another, shows the space. */
export function spaceIsShown(
  ws: Pick<Workspace, "windows" | "activeSpaceId">,
  spaceId: Id,
): boolean {
  return ws.activeSpaceId === spaceId || windowShowing(ws, spaceId) !== undefined;
}

/** Whether the workspace can take one more window. */
export function canOpenWindow(ws: Pick<Workspace, "windows">): boolean {
  return workspaceWindows(ws).length < MAX_EXTRA_WINDOWS;
}

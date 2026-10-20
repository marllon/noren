import { layoutPanes } from "./sessions";
import { MAX_EXTRA_WINDOWS } from "./types";
import type { AppWindow, Id, Item, Space, Workspace } from "./types";

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

/**
 * The spaces the main window can show: every space except those other windows show. These are the
 * ones its space switcher lists, in the workspace's order.
 */
export function mainWindowSpaces(ws: Pick<Workspace, "spaces" | "windows">): Space[] {
  return ws.spaces.filter((space) => windowShowing(ws, space.id) === undefined);
}

/**
 * The tabs the windows besides the main one show now: the active tab of the space of each (its
 * first when it names none). The person is looking at them, as at the tab of the main window.
 */
export function windowShownItems(ws: Pick<Workspace, "spaces" | "windows">): Set<Id> {
  const shown = new Set<Id>();
  for (const window of workspaceWindows(ws)) {
    const space = ws.spaces.find((s) => s.id === window.spaceId);
    if (space === undefined) continue;
    const chosen = space.activeItemId;
    const id =
      chosen !== undefined && Object.hasOwn(space.items, chosen)
        ? chosen
        : [...space.pinned, ...Object.keys(space.items)].find((i) => Object.hasOwn(space.items, i));
    if (id !== undefined) shown.add(id);
  }
  return shown;
}

/** Whether some window, the main one or another, shows the space. */
export function spaceIsShown(
  ws: Pick<Workspace, "windows" | "activeSpaceId">,
  spaceId: Id,
): boolean {
  return ws.activeSpaceId === spaceId || windowShowing(ws, spaceId) !== undefined;
}

/**
 * Whether the tab can be shown by a window besides the main one: no pane of it is a browser. The
 * page of such a window draws terminals, previews and diffs (the file and the git diff are read by
 * the main window and sent to it); the web view of a browser pane is a child of the main window
 * until a window can be its parent (NOR-F15-04e), so a tab with one stays where it is.
 */
export function windowCanShowTab(item: Pick<Item, "layout">): boolean {
  return layoutPanes(item.layout).every((pane) => pane.type !== "browser");
}

/** Whether the workspace can take one more window. */
export function canOpenWindow(ws: Pick<Workspace, "windows">): boolean {
  return workspaceWindows(ws).length < MAX_EXTRA_WINDOWS;
}

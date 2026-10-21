import type { Action, Placement, ReducerContext } from "./actions";
import { browserUrlProblem } from "./browser";
import {
  DEFAULT_PROFILE_ID,
  createBrowserPane,
  createDiffPane,
  createEmptySpace,
  createPane,
  createPreviewPane,
  createTab,
  type EmptySpaceOptions,
} from "./factories";
import { previewPathProblem } from "./file-preview";
import { neighborPane } from "./geometry";
import {
  countPanes,
  findPane,
  insertBeside,
  normalizeSizes,
  removePane,
  setSplitSizes,
  splitAt,
  swapPanes,
} from "./layout";
import { MAX_BACKGROUND_BLUR, backgroundImageProblem } from "./background";
import { MAX_MODS, isValidModFileName, sameModList } from "./mods";
import { isLiveSource } from "./live-groups";
import { layoutPanes, liveSessionIds, withoutSessions } from "./sessions";
import { isMarked, isPaneVisible, mapPanes, shownItem, visiblePanes, withoutMarks } from "./unread";
import {
  editChildren,
  findGroup,
  findGroupSlot,
  findItemSlot,
  insertAt,
  removeGroupNode,
  removeItemNodes,
  replaceGroupWithChildren,
  resolveIndex,
  spaceItemIds,
  treeGroups,
  treeItemIds,
  updateGroup,
  type GroupLocation,
} from "./tree";
import {
  canOpenWindow,
  findWindow,
  isWindowId,
  spaceIsShown,
  windowCanShowTab,
  windowShowing,
  workspaceWindows,
} from "./windows";
import {
  DEFAULT_MAX_PANES,
  MAX_CLOSED,
  MAX_GROUP_DEPTH,
  type AppWindow,
  type ArchivedItem,
  type ClosedItem,
  type ClosedPlace,
  type GroupNode,
  type Id,
  type Item,
  type ItemOrigin,
  type LastCommand,
  type LayoutNode,
  type Node,
  type Pane,
  type Space,
  type SpaceBackground,
  type Workspace,
} from "./types";

/**
 * Applies an action to a workspace and returns the new workspace. Pure: the input is never
 * mutated, and ids and time come from `ctx`. An action that cannot apply (unknown target, third
 * group level, deleting the only space, blank name, ...) returns the very same `ws`. Never throws:
 * anything unexpected, such as an action that does not match its type, also returns `ws`.
 *
 * Sessions are not touched here. Closing an item (or deleting a space with `mode: "close"`) strips
 * `sessionId` from the panes it closes; the app compares `liveSessionIds` before and after to know
 * which sessions to end.
 */
export function reduce(ws: Workspace, action: Action, ctx: ReducerContext): Workspace {
  try {
    return reduceStrict(ws, action, ctx);
  } catch {
    return ws;
  }
}

/**
 * `reduce` without the safety net: tests use it so a bug cannot hide behind a no-op. Every space
 * the action changed ends with a valid active item (see `settleActive`), the panes on screen are
 * not unread (see `clearViewed`), and no window is left on a space that is gone or that the main
 * window shows (see `settleWindows`).
 */
export function reduceStrict(ws: Workspace, action: Action, ctx: ReducerContext): Workspace {
  const next = applyAction(ws, action, ctx);
  return next === ws ? ws : settleWindows(clearViewed(settleActive(ws, next, action)));
}

function applyAction(ws: Workspace, action: Action, ctx: ReducerContext): Workspace {
  switch (action.type) {
    case "space/create":
      return createSpace(ws, action, ctx);
    case "space/rename": {
      const name = clean(action.name);
      if (name === undefined) return ws;
      return updateSpace(ws, action.spaceId, (space) =>
        space.name === name ? undefined : { ...space, name },
      );
    }
    case "space/set-color": {
      const color = clean(action.color);
      if (color === undefined) return ws;
      return updateSpace(ws, action.spaceId, (space) =>
        space.color === color ? undefined : { ...space, color },
      );
    }
    case "space/set-icon": {
      const icon = clean(action.icon);
      if (icon === undefined) return ws;
      return updateSpace(ws, action.spaceId, (space) =>
        space.icon === icon ? undefined : { ...space, icon },
      );
    }
    case "space/set-theme": {
      if (action.themeId === null) {
        return updateSpace(ws, action.spaceId, (space) => {
          if (space.themeId === undefined) return undefined;
          const next = { ...space };
          delete next.themeId;
          return next;
        });
      }
      const themeId = clean(action.themeId);
      if (themeId === undefined) return ws;
      return updateSpace(ws, action.spaceId, (space) =>
        space.themeId === themeId ? undefined : { ...space, themeId },
      );
    }
    case "space/set-mods": {
      const modIds = cleanModIds(action.modIds);
      return updateSpace(ws, action.spaceId, (space) =>
        sameModList(space.modIds, modIds) ? undefined : { ...space, modIds },
      );
    }
    case "space/set-ai":
      if (typeof action.enabled !== "boolean") return ws;
      return updateSpace(ws, action.spaceId, (space) =>
        space.aiEnabled === action.enabled ? undefined : { ...space, aiEnabled: action.enabled },
      );
    case "space/set-background": {
      if (action.background === null) {
        return updateSpace(ws, action.spaceId, (space) => {
          if (space.background === undefined) return undefined;
          const next = { ...space };
          delete next.background;
          return next;
        });
      }
      const background = cleanBackground(action.background);
      if (background === undefined) return ws;
      return updateSpace(ws, action.spaceId, (space) =>
        sameBackground(space.background, background) ? undefined : { ...space, background },
      );
    }
    case "space/set-defaults":
      return setSpaceDefaults(ws, action);
    case "space/move":
      return moveSpace(ws, action.spaceId, action.index);
    case "space/activate":
      if (ws.activeSpaceId === action.spaceId || !findSpace(ws, action.spaceId)) return ws;
      // A space another window shows stays there: a terminal is drawn by one page.
      if (windowShowing(ws, action.spaceId) !== undefined) return ws;
      return { ...ws, activeSpaceId: action.spaceId };
    case "window/open":
      return openWindow(ws, action.spaceId, ctx);
    case "window/close":
      return closeWindow(ws, action.windowId);
    case "window/move-item":
      return moveItemToWindow(ws, action);
    case "window/open-with-item":
      return openWindowWithItem(ws, action, ctx);
    case "window/return":
      return returnWindow(ws, action.windowId);
    case "space/set-active-item":
      return updateSpace(ws, action.spaceId, (space) =>
        typeof action.itemId === "string" &&
        Object.hasOwn(space.items, action.itemId) &&
        space.activeItemId !== action.itemId
          ? { ...space, activeItemId: action.itemId }
          : undefined,
      );
    case "space/delete":
      return deleteSpace(ws, action.spaceId, action.items, ctx);
    case "item/create":
      return createItem(ws, action, ctx);
    case "item/close":
      return closeItem(ws, action.itemId, ctx);
    case "item/reopen":
      return reopenItem(ws, action.itemId, ctx);
    case "item/archive":
      return archiveItem(ws, action.itemId, ctx);
    case "archive/restore":
      return restoreArchived(ws, action.itemId, ctx);
    case "archive/delete":
      return typeof action.itemId === "string" &&
        ws.archive.some((e) => e.item.id === action.itemId)
        ? { ...ws, archive: ws.archive.filter((entry) => entry.item.id !== action.itemId) }
        : ws;
    case "closed/delete":
      return typeof action.itemId === "string" && ws.closed.some((e) => e.item.id === action.itemId)
        ? { ...ws, closed: ws.closed.filter((entry) => entry.item.id !== action.itemId) }
        : ws;
    case "item/rename":
      return renameItem(ws, action);
    case "item/move": {
      const located = locate(ws, action.itemId);
      if (!located) return ws;
      return relocate(
        ws,
        located,
        action.spaceId ?? located.space.id,
        action.placement ?? { to: "tree" },
      );
    }
    case "item/pin": {
      const located = locate(ws, action.itemId);
      if (!located || located.space.pinned.includes(action.itemId)) return ws;
      return relocate(ws, located, located.space.id, withIndex({ to: "pinned" }, action.index));
    }
    case "item/unpin": {
      const located = locate(ws, action.itemId);
      if (!located?.space.pinned.includes(action.itemId)) return ws;
      // Back to the top of the tree, right below the pinned items.
      return relocate(ws, located, located.space.id, withIndex({ to: "tree" }, action.index ?? 0));
    }
    case "item/reset":
      return resetItem(ws, action.itemId, ctx);
    case "item/favorite":
      if (!locate(ws, action.itemId) || ws.favorites.includes(action.itemId)) return ws;
      return { ...ws, favorites: [...ws.favorites, action.itemId] };
    case "item/unfavorite":
      if (!ws.favorites.includes(action.itemId)) return ws;
      return { ...ws, favorites: ws.favorites.filter((id) => id !== action.itemId) };
    case "group/create":
      return createGroup(ws, action, ctx);
    case "group/create-from-selection":
      return groupSelection(ws, action, ctx);
    case "group/ungroup": {
      const hit = locateGroup(ws, action.groupId);
      if (!hit) return ws;
      const tree = replaceGroupWithChildren(hit.space.tree, action.groupId);
      return replaceSpace(ws, { ...hit.space, tree });
    }
    case "group/move":
      return moveGroup(ws, action);
    case "group/set-collapsed":
      return updateGroupIn(ws, action.groupId, (group) =>
        group.collapsed === action.collapsed
          ? undefined
          : { ...group, collapsed: action.collapsed },
      );
    case "group/rename": {
      const name = clean(action.name);
      if (name === undefined) return ws;
      return updateGroupIn(ws, action.groupId, (group) =>
        group.name === name ? undefined : { ...group, name },
      );
    }
    case "group/set-color": {
      const color = clean(action.color);
      if (color === undefined) return ws;
      return updateGroupIn(ws, action.groupId, (group) =>
        group.color === color ? undefined : { ...group, color },
      );
    }
    case "group/set-live": {
      if (action.live !== undefined && !isLiveSource(action.live)) return ws;
      const live = action.live;
      return updateGroupIn(ws, action.groupId, (group) => {
        if (live === undefined) {
          if (group.live === undefined) return undefined;
          const ordinary: GroupNode = { ...group };
          delete ordinary.live;
          return ordinary;
        }
        return JSON.stringify(group.live) === JSON.stringify(live)
          ? undefined
          : { ...group, live: { ...live } };
      });
    }
    case "pane/split":
      return splitPane(ws, action, ctx);
    case "pane/set-url":
      return setPaneUrl(ws, action);
    case "pane/close":
      return closePane(ws, action.itemId, action.paneId, ctx);
    case "pane/detach":
      return detachPane(ws, action.itemId, action.paneId, ctx);
    case "item/join":
      return joinItem(ws, action, ctx);
    case "pane/resize":
      return resizeSplit(ws, action);
    case "pane/zoom":
      return zoomPane(ws, action.itemId, action.paneId);
    case "pane/swap":
      return swapItemPanes(ws, action.itemId, action.paneId, action.otherPaneId);
    case "pane/focus":
      return focusPane(ws, action.itemId, action.paneId);
    case "pane/focus-direction":
      return focusDirection(ws, action.itemId, action.direction);
    case "pane/set-status":
      return setPaneStatus(ws, action);
    case "pane/set-location":
      return setPaneLocation(ws, action);
    case "pane/command-start":
      return startPaneCommand(ws, action);
    case "pane/command-end":
      return endPaneCommand(ws, action);
    case "pane/notify":
      return notifyPane(ws, action, ctx);
    case "pane/set-scrollback":
      return setPaneScrollback(ws, action);
    case "pane/clear-unread":
      return clearUnread(ws, action);
    default:
      return assertNever(action, ws);
  }
}

/** Compile-time check that the switch covers every action; at run time unknown input is a no-op. */
function assertNever(_action: never, ws: Workspace): Workspace {
  return ws;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

/** Trimmed text, or undefined when it is blank. */
function clean(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The background as it is kept: the path trimmed and checked, `opacity` and `blur` held to their
 * range and left out when they are not numbers. `undefined` when the path cannot be a background.
 */
function cleanBackground(background: SpaceBackground): SpaceBackground | undefined {
  if (typeof background !== "object" || typeof background.image !== "string") return undefined;
  const image = background.image.trim();
  if (backgroundImageProblem(image) !== undefined) return undefined;
  const number = (value: unknown, max: number): number | undefined =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(0, value))
      : undefined;
  const opacity = number(background.opacity, 1);
  const blur = number(background.blur, MAX_BACKGROUND_BLUR);
  return {
    image,
    ...(opacity !== undefined ? { opacity } : {}),
    ...(blur !== undefined ? { blur } : {}),
  };
}

function sameBackground(a: SpaceBackground | undefined, b: SpaceBackground): boolean {
  return a !== undefined && a.image === b.image && a.opacity === b.opacity && a.blur === b.blur;
}

/** The mod names of a list, in order, once each; what is not a mod name is dropped. */
function cleanModIds(list: readonly string[]): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const name of list as readonly unknown[]) {
    if (isValidModFileName(name) && !names.includes(name) && names.length < MAX_MODS) {
      names.push(name);
    }
  }
  return names;
}

/** The text as given, or undefined when it is blank (paths and profile ids are not trimmed). */
function present(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === "" ? undefined : text;
}

function withIndex(placement: Placement, index: number | undefined): Placement {
  return index === undefined ? placement : { ...placement, index };
}

function findSpace(ws: Workspace, spaceId: Id): Space | undefined {
  return ws.spaces.find((space) => space.id === spaceId);
}

function replaceSpace(ws: Workspace, space: Space): Workspace {
  return { ...ws, spaces: ws.spaces.map((s) => (s.id === space.id ? space : s)) };
}

/** Applies `update` to a space; undefined from `update` (or no such space) means no change. */
function updateSpace(
  ws: Workspace,
  spaceId: Id,
  update: (space: Space) => Space | undefined,
): Workspace {
  const space = findSpace(ws, spaceId);
  const next = space && update(space);
  return next ? replaceSpace(ws, next) : ws;
}

interface Located {
  space: Space;
  item: Item;
}

function locate(ws: Workspace, itemId: Id): Located | undefined {
  for (const space of ws.spaces) {
    const item = Object.hasOwn(space.items, itemId) ? space.items[itemId] : undefined;
    if (item) return { space, item };
  }
  return undefined;
}

function locateGroup(
  ws: Workspace,
  groupId: Id,
): { space: Space; found: GroupLocation } | undefined {
  for (const space of ws.spaces) {
    const found = findGroup(space.tree, groupId);
    if (found) return { space, found };
  }
  return undefined;
}

function updateGroupIn(
  ws: Workspace,
  groupId: Id,
  update: (group: GroupNode) => GroupNode | undefined,
): Workspace {
  const hit = locateGroup(ws, groupId);
  const next = hit && update(hit.found.group);
  if (!hit || !next) return ws;
  const tree = updateGroup(hit.space.tree, groupId, () => next);
  return tree ? replaceSpace(ws, { ...hit.space, tree }) : ws;
}

function collectIds(ws: Workspace): Set<Id> {
  const ids = new Set<Id>();
  const addItem = (item: Item): void => {
    ids.add(item.id);
    for (const pane of layoutPanes(item.layout)) ids.add(pane.id);
  };
  for (const space of ws.spaces) {
    ids.add(space.id);
    Object.values(space.items).forEach(addItem);
    for (const group of treeGroups(space.tree)) ids.add(group.id);
  }
  ws.closed.forEach((entry) => {
    addItem(entry.item);
  });
  ws.archive.forEach((entry) => {
    addItem(entry.item);
  });
  for (const window of workspaceWindows(ws)) ids.add(window.id);
  return ids;
}

/**
 * Draws ids from `ctx.newId`, skipping any already used in the workspace (closed and archived
 * items included). Throws only when the generator keeps answering with taken ids.
 */
function idPool(ws: Workspace, ctx: ReducerContext): () => Id {
  const taken = collectIds(ws);
  let attempts = taken.size + 1000;
  return () => {
    while (attempts-- > 0) {
      const id = ctx.newId();
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new Error("newId only returns ids that are already in use");
  };
}

function pushClosed(closed: readonly ClosedItem[], entries: readonly ClosedItem[]): ClosedItem[] {
  return [...closed, ...entries].slice(-MAX_CLOSED);
}

// ---------------------------------------------------------------------------------------------
// Active item

/**
 * Fixes the active item of every space the action changed. A created or reopened item becomes
 * active in its space, and so does the target of a join. Otherwise the active item stays, unless it
 * left the space (closed, moved out, merged away): then the next item in sidebar order takes over,
 * else the previous one, else none for an empty space. A space with items but no active item (old
 * data) gets its first item.
 */
function settleActive(before: Workspace, after: Workspace, action: Action): Workspace {
  let changed = false;
  const spaces = after.spaces.map((space) => {
    const old = findSpace(before, space.id);
    if (old === space) return space;
    const chosen = chooseActive(old, space, action);
    if (chosen === space.activeItemId) return space;
    changed = true;
    return withActiveItem(space, chosen);
  });
  return changed ? { ...after, spaces } : after;
}

function chooseActive(old: Space | undefined, space: Space, action: Action): Id | undefined {
  if (action.type === "item/join" && Object.hasOwn(space.items, action.targetItemId)) {
    return action.targetItemId;
  }
  if (
    action.type === "item/create" ||
    action.type === "item/reopen" ||
    action.type === "archive/restore"
  ) {
    const arrived = Object.keys(space.items).find((id) => !old || !Object.hasOwn(old.items, id));
    if (arrived !== undefined) return arrived;
  }
  const current = space.activeItemId;
  if (current !== undefined && Object.hasOwn(space.items, current)) return current;
  const order = spaceItemIds(space);
  if (old && current !== undefined) {
    const was = spaceItemIds(old);
    const at = was.indexOf(current);
    const heir = [...was.slice(at + 1), ...was.slice(0, Math.max(at, 0)).reverse()].find((id) =>
      Object.hasOwn(space.items, id),
    );
    if (at >= 0 && heir !== undefined) return heir;
  }
  return order[0];
}

function withActiveItem(space: Space, itemId: Id | undefined): Space {
  const next: Space = { ...space };
  if (itemId === undefined) {
    delete next.activeItemId;
  } else {
    next.activeItemId = itemId;
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Placement

/** The space without the item in `pinned` and in the tree; its `items` entry stays. */
function unplace(space: Space, itemId: Id): Space {
  return {
    ...space,
    pinned: space.pinned.filter((id) => id !== itemId),
    tree: removeItemNodes(space.tree, new Set([itemId])),
  };
}

/** The space without the item at all. */
function dropItem(space: Space, itemId: Id): Space {
  return {
    ...unplace(space, itemId),
    items: Object.fromEntries(Object.entries(space.items).filter(([id]) => id !== itemId)),
  };
}

/** The pane as a new shell finds it: an exit code and a command line belong to the old process. */
function withoutOldShell(pane: Pane): Pane {
  if (
    pane.status !== "exited" &&
    pane.exitCode === undefined &&
    pane.runningCommand === undefined
  ) {
    return pane;
  }
  const next: Pane = { ...pane, status: pane.status === "exited" ? "idle" : pane.status };
  delete next.exitCode;
  delete next.runningCommand;
  return next;
}

const TREE_END: Placement = { to: "tree" };

/** Where the item is in the space now: its list, its group and its position; none when it is not placed. */
function placeOfItem(space: Space, itemId: Id): ClosedPlace | undefined {
  const pinnedAt = space.pinned.indexOf(itemId);
  if (pinnedAt >= 0) return { list: "pinned", index: pinnedAt };
  const slot = findItemSlot(space.tree, itemId);
  if (!slot) return undefined;
  return {
    list: "tree",
    ...(slot.parentId !== undefined ? { groupId: slot.parentId } : {}),
    index: slot.index,
  };
}

/**
 * The placement that brings an item back to `place` in `space`: the same list and position (clamped
 * to what the list holds now) when it can, else the end of the tree. A group that is gone, or a
 * position that is not a whole number, send it to the end of the tree.
 */
function placementOf(space: Space, place: ClosedPlace | undefined): Placement {
  if (place === undefined || !Number.isInteger(place.index)) return TREE_END;
  if (place.list === "pinned") return { to: "pinned", index: place.index };
  if (place.groupId === undefined) return { to: "tree", index: place.index };
  return findGroup(space.tree, place.groupId)
    ? { to: "tree", groupId: place.groupId, index: place.index }
    : TREE_END;
}

/** Puts `itemId` (already in `space.items`, not yet placed) where `placement` says. */
function place(space: Space, itemId: Id, placement: Placement): Space | undefined {
  if (placement.to === "pinned") {
    const index = resolveIndex(placement.index, space.pinned.length, space.pinned.length);
    return index === undefined
      ? undefined
      : { ...space, pinned: insertAt(space.pinned, index, itemId) };
  }
  const tree = editChildren(space.tree, placement.groupId, (children) => {
    const index = resolveIndex(placement.index, children.length, children.length);
    return index === undefined
      ? undefined
      : insertAt<Node>(children, index, { kind: "item", id: itemId });
  });
  return tree ? { ...space, tree } : undefined;
}

/**
 * Where a pinned item returns to on reset: the folder, profile and (when the model has one) the
 * command of its focused pane. The folder is the pane's own or else the start folder of the space
 * it is in; with neither there is nothing to return to, so no origin is recorded.
 */
function originOf(item: Item, space: Space): ItemOrigin | undefined {
  const pane = findPane(item.layout, item.focusedPaneId);
  const cwd = pane?.cwd ?? space.defaults.cwd;
  if (!pane || cwd === undefined) return undefined;
  return { cwd, profileId: pane.profileId };
}

/**
 * The item as `space` now holds it. A pinned item that was already pinned keeps its origin (or gets
 * one if it had none); one that has just been pinned records a new one from the pane it has now
 * (`from` is the space it was in); an item that is not pinned has none.
 */
function withOrigin(space: Space, item: Item, from: Space): Space {
  const current = space.items[item.id] ?? item;
  const origin = space.pinned.includes(item.id)
    ? from.pinned.includes(item.id)
      ? (current.origin ?? originOf(current, from))
      : originOf(current, from)
    : undefined;
  if (origin === current.origin) return space;
  const next: Item = { ...current };
  if (origin === undefined) {
    delete next.origin;
  } else {
    next.origin = origin;
  }
  return { ...space, items: { ...space.items, [item.id]: next } };
}

/** Copy of the layout with the leaf of pane `paneId` holding `next` instead. */
function replacePane(layout: LayoutNode, paneId: Id, next: Pane): LayoutNode {
  if (layout.kind === "pane")
    return layout.pane.id === paneId ? { kind: "pane", pane: next } : layout;
  const children = layout.children.map((child) => replacePane(child, paneId, next));
  return children.some((child, index) => child !== layout.children[index])
    ? { ...layout, children }
    : layout;
}

/**
 * Takes a pinned item back to its origin: its focused pane is replaced by a fresh one in the folder
 * and profile of the origin. The old pane's session is dropped (the app ends it, as for a closed
 * pane) and the new pane has none, so the view starts a shell for it. No origin, no change.
 */
function resetItem(ws: Workspace, itemId: Id, ctx: ReducerContext): Workspace {
  const located = locate(ws, itemId);
  const origin = located?.item.origin;
  if (!located || !origin || !located.space.pinned.includes(itemId)) return ws;
  const { item, space } = located;
  const old = findPane(item.layout, item.focusedPaneId);
  if (!old) return ws;
  const fresh = createPane(idPool(ws, ctx)(), origin.profileId, origin.cwd);
  const next: Item = {
    ...item,
    layout: replacePane(item.layout, old.id, fresh),
    focusedPaneId: fresh.id,
    lastActivityAt: ctx.clock.now(),
  };
  if (item.zoomedPaneId === old.id) next.zoomedPaneId = fresh.id;
  return replaceItem(ws, space, next);
}

/** Moves an item to `placement` in `targetSpaceId` (its own space or another one). */
function relocate(
  ws: Workspace,
  located: Located,
  targetSpaceId: Id,
  placement: Placement,
): Workspace {
  const { item } = located;
  const source = located.space;
  const target = findSpace(ws, targetSpaceId);
  if (!target) return ws;
  if (target.id === source.id) {
    const placed = place(unplace(source, item.id), item.id, placement);
    return placed ? replaceSpace(ws, withOrigin(placed, item, source)) : ws;
  }
  const arriving: Space = { ...target, items: { ...target.items, [item.id]: item } };
  const arrived = place(arriving, item.id, placement);
  if (!arrived) return ws;
  const placed = withOrigin(arrived, item, source);
  return {
    ...ws,
    spaces: ws.spaces.map((space) =>
      space.id === placed.id ? placed : space.id === source.id ? dropItem(source, item.id) : space,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Spaces

function createSpace(
  ws: Workspace,
  action: Extract<Action, { type: "space/create" }>,
  ctx: ReducerContext,
): Workspace {
  const name = clean(action.name);
  const icon = action.icon === undefined ? undefined : clean(action.icon);
  const color = action.color === undefined ? undefined : clean(action.color);
  if (name === undefined || (action.icon !== undefined && icon === undefined)) return ws;
  if (action.color !== undefined && color === undefined) return ws;
  const profileId = present(action.profileId);
  const cwd = present(action.cwd);
  if (action.env !== undefined && !validEnv(action.env)) return ws;
  const options: EmptySpaceOptions = {
    ...(action.env !== undefined ? { env: action.env } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(color !== undefined ? { color } : {}),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
  const space = createEmptySpace(idPool(ws, ctx)(), name, options);
  return {
    ...ws,
    spaces: [...ws.spaces, space],
    activeSpaceId: action.activate === false ? ws.activeSpaceId : space.id,
  };
}

function setSpaceDefaults(
  ws: Workspace,
  action: Extract<Action, { type: "space/set-defaults" }>,
): Workspace {
  if (action.env !== undefined && !validEnv(action.env)) return ws;
  const given = action.gitIdentity;
  if (given !== undefined && [given.name, given.email].some((text) => text.includes("\u0000"))) {
    return ws;
  }
  return updateSpace(ws, action.spaceId, (space) => {
    const {
      profileId: oldProfile,
      cwd: oldCwd,
      env: oldEnv,
      gitIdentity: oldIdentity,
      ...rest
    } = space.defaults;
    const profileId = action.profileId === undefined ? oldProfile : present(action.profileId);
    const cwd = action.cwd === undefined ? oldCwd : present(action.cwd);
    const env = action.env === undefined ? oldEnv : { ...action.env };
    const gitIdentity = given === undefined ? oldIdentity : normalizeIdentity(given);
    const same =
      profileId === oldProfile &&
      cwd === oldCwd &&
      sameEnv(env, oldEnv) &&
      gitIdentity?.name === oldIdentity?.name &&
      gitIdentity?.email === oldIdentity?.email;
    if (same) return undefined;
    const defaults: Space["defaults"] = {
      ...rest,
      env,
      ...(profileId !== undefined ? { profileId } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(gitIdentity !== undefined ? { gitIdentity } : {}),
    };
    return { ...space, defaults };
  });
}

/** Trimmed name and email; `undefined` (no identity) when both are blank. */
function normalizeIdentity(identity: {
  name: string;
  email: string;
}): Space["defaults"]["gitIdentity"] {
  const name = identity.name.trim();
  const email = identity.email.trim();
  return name === "" && email === "" ? undefined : { name, email };
}

/** True when every name is a usable environment variable name and no value holds a NUL. */
export function validEnv(env: Record<string, string>): boolean {
  return Object.entries(env).every(
    ([name, value]) =>
      name !== "" && !/[=\s]/.test(name) && !name.includes("\u0000") && !value.includes("\u0000"),
  );
}

function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function moveSpace(ws: Workspace, spaceId: Id, index: number): Workspace {
  const from = ws.spaces.findIndex((space) => space.id === spaceId);
  const space = ws.spaces[from];
  if (!space) return ws;
  const rest = ws.spaces.filter((s) => s.id !== spaceId);
  const to = resolveIndex(index, rest.length, rest.length);
  if (to === undefined || to === from) return ws;
  return { ...ws, spaces: insertAt(rest, to, space) };
}

// ---------------------------------------------------------------------------------------------
// Windows

function openWindow(ws: Workspace, spaceId: Id, ctx: ReducerContext): Workspace {
  if (!findSpace(ws, spaceId) || spaceIsShown(ws, spaceId) || !canOpenWindow(ws)) return ws;
  const id = idPool(ws, ctx)();
  if (!isWindowId(id)) return ws;
  return { ...ws, windows: [...workspaceWindows(ws), { id, spaceId }] };
}

function closeWindow(ws: Workspace, windowId: Id): Workspace {
  if (findWindow(ws, windowId) === undefined) return ws;
  return withWindows(
    ws,
    workspaceWindows(ws).filter((window) => window.id !== windowId),
  );
}

function moveItemToWindow(
  ws: Workspace,
  action: Extract<Action, { type: "window/move-item" }>,
): Workspace {
  const window = findWindow(ws, action.windowId);
  const located = locate(ws, action.itemId);
  if (!window || !located || located.space.id === window.spaceId) return ws;
  // A tab goes only if the page of a window can draw every pane of it.
  if (!windowCanShowTab(located.item)) return ws;
  const moved = relocate(ws, located, window.spaceId, action.placement ?? { to: "tree" });
  if (moved === ws) return ws;
  // The tab that arrives is the one the window shows.
  return updateSpace(moved, window.spaceId, (space) =>
    space.activeItemId === action.itemId ? undefined : withActiveItem(space, action.itemId),
  );
}

/** The name of the space made for a window when the action gives none. */
const WINDOW_SPACE_NAME = "Window";

/**
 * A tab dragged out: a space for the window, the window (which remembers the space the tab came
 * from) and the tab moved in, in one step, so no state in between (a window with an empty space,
 * a tab in a space nobody shows) is ever seen.
 */
function openWindowWithItem(
  ws: Workspace,
  action: Extract<Action, { type: "window/open-with-item" }>,
  ctx: ReducerContext,
): Workspace {
  const located = locate(ws, action.itemId);
  if (!located || !canOpenWindow(ws) || !windowCanShowTab(located.item)) return ws;
  const name =
    (typeof action.name === "string" ? clean(action.name) : undefined) ?? WINDOW_SPACE_NAME;
  const take = idPool(ws, ctx);
  const spaceId = take();
  const windowId = take();
  if (!isWindowId(windowId)) return ws;
  const source = located.space;
  const space = createEmptySpace(spaceId, name, {
    icon: source.icon,
    color: source.color,
    ...(source.defaults.profileId !== undefined ? { profileId: source.defaults.profileId } : {}),
    ...(source.defaults.cwd !== undefined ? { cwd: source.defaults.cwd } : {}),
    env: source.defaults.env,
  });
  const made: Workspace = {
    ...ws,
    spaces: [...ws.spaces, space],
    windows: [...workspaceWindows(ws), { id: windowId, spaceId, returnSpaceId: source.id }],
  };
  // A pinned tab stays pinned in the window.
  const placement: Placement = source.pinned.includes(action.itemId)
    ? { to: "pinned" }
    : { to: "tree" };
  return moveItemToWindow(made, {
    type: "window/move-item",
    itemId: action.itemId,
    windowId,
    placement,
  });
}

/**
 * Closes a window and gives its tabs back to the space they came from (see `window/return`). The
 * space the tabs go to is never one that a window shows: the page that draws it must be the main
 * window's, which is where the sessions of the tabs are taken back to.
 */
function returnWindow(ws: Workspace, windowId: Id): Workspace {
  const window = findWindow(ws, windowId);
  if (window === undefined) return ws;
  const own = findSpace(ws, window.spaceId);
  if (window.returnSpaceId === undefined || own === undefined) return closeWindow(ws, windowId);
  const home = window.returnSpaceId === own.id ? undefined : findSpace(ws, window.returnSpaceId);
  const target =
    home !== undefined && windowShowing(ws, home.id) === undefined
      ? home
      : findSpace(ws, ws.activeSpaceId);
  if (target === undefined) return closeWindow(ws, windowId);
  let next = ws;
  for (const itemId of spaceItemIds(own)) {
    const located = locate(next, itemId);
    if (!located || located.space.id !== own.id) continue;
    const placement: Placement = own.pinned.includes(itemId) ? { to: "pinned" } : { to: "tree" };
    next = relocate(next, located, target.id, placement);
  }
  // The tab the window showed is the one the main window shows when it is the one that gets them.
  const shown = own.activeItemId;
  if (target.id === ws.activeSpaceId && shown !== undefined) {
    next = updateSpace(next, target.id, (space) =>
      Object.hasOwn(space.items, shown) && space.activeItemId !== shown
        ? withActiveItem(space, shown)
        : undefined,
    );
  }
  const gone = findSpace(next, own.id);
  const rest = withWindows(
    next,
    workspaceWindows(next).filter((w) => w.id !== windowId),
  );
  // The space was made for the window, and the tabs it held left with it: it goes away too. One
  // that still holds an item (a tab that could not be placed) stays, so nothing is lost.
  return gone !== undefined && Object.keys(gone.items).length === 0
    ? { ...rest, spaces: rest.spaces.filter((space) => space.id !== own.id) }
    : rest;
}

/** The workspace with `windows` as its windows; the key is left out when there are none. */
function withWindows(ws: Workspace, windows: readonly AppWindow[]): Workspace {
  const next = { ...ws };
  delete next.windows;
  return windows.length === 0 ? next : { ...next, windows: [...windows] };
}

/**
 * Drops the windows that cannot stay after an action: the space was deleted, or the main window
 * ended up showing it (`space/delete` can do either). Runs after every action that changed the
 * workspace, so no action has to know, and the invariants of the windows always hold.
 */
function settleWindows(ws: Workspace): Workspace {
  const windows = workspaceWindows(ws);
  if (windows.length === 0) return ws;
  const shown = new Set<Id>([ws.activeSpaceId]);
  const kept = windows.filter((window) => {
    if (!findSpace(ws, window.spaceId) || shown.has(window.spaceId)) return false;
    shown.add(window.spaceId);
    return true;
  });
  return kept.length === windows.length ? ws : withWindows(ws, kept);
}

function deleteSpace(
  ws: Workspace,
  spaceId: Id,
  fate: Extract<Action, { type: "space/delete" }>["items"],
  ctx: ReducerContext,
): Workspace {
  const index = ws.spaces.findIndex((space) => space.id === spaceId);
  const space = ws.spaces[index];
  if (!space || ws.spaces.length < 2) return ws;
  const rest = ws.spaces.filter((s) => s.id !== spaceId);
  const wasActive = ws.activeSpaceId === spaceId;

  if (fate.mode === "move") {
    const target = rest.find((s) => s.id === fate.targetSpaceId);
    if (!target) return ws;
    const merged: Space = {
      ...target,
      pinned: [...target.pinned, ...space.pinned],
      tree: [...target.tree, ...space.tree],
      items: { ...target.items, ...space.items },
    };
    return {
      ...ws,
      spaces: rest.map((s) => (s.id === target.id ? merged : s)),
      activeSpaceId: wasActive ? target.id : ws.activeSpaceId,
    };
  }

  // The space that slides into the deleted one's place, or the last one. A space another window
  // shows is passed over when the main window is the one that needs a new space, so the window
  // is not taken from it.
  const slid = Math.min(index, rest.length - 1);
  const free = rest.filter((s) => windowShowing(ws, s.id) === undefined);
  const neighbor =
    wasActive && free.length > 0
      ? free.reduce((best, s) =>
          Math.abs(rest.indexOf(s) - slid) < Math.abs(rest.indexOf(best) - slid) ? s : best,
        )
      : rest[slid];
  if (!neighbor) return ws;
  const now = ctx.clock.now();
  const ids = spaceItemIds(space);
  const gone = new Set(ids);
  const entries: ClosedItem[] = [];
  for (const id of ids) {
    const item = space.items[id];
    if (item) entries.push({ item: withoutSessions(item), spaceId: space.id, closedAt: now });
  }
  return {
    ...ws,
    spaces: rest,
    activeSpaceId: wasActive ? neighbor.id : ws.activeSpaceId,
    favorites: ws.favorites.filter((id) => !gone.has(id)),
    closed: pushClosed(ws.closed, entries),
  };
}

// ---------------------------------------------------------------------------------------------
// Items

function createItem(
  ws: Workspace,
  action: Extract<Action, { type: "item/create" }>,
  ctx: ReducerContext,
): Workspace {
  const space = findSpace(ws, action.spaceId ?? ws.activeSpaceId);
  if (!space) return ws;
  const profileId =
    action.profileId === undefined
      ? (space.defaults.profileId ?? DEFAULT_PROFILE_ID)
      : present(action.profileId);
  if (profileId === undefined) return ws;
  const cwd = present(action.cwd) ?? space.defaults.cwd;
  const sessionId = present(action.sessionId);
  // A session belongs to one pane: ending it would end the shell of the other one too.
  if (sessionId !== undefined && liveSessionIds(ws).has(sessionId)) return ws;
  const nextId = idPool(ws, ctx);
  const itemId = nextId();
  const pane = createPane(nextId(), profileId, cwd);
  const made = createTab(
    itemId,
    sessionId === undefined ? pane : { ...pane, sessionId },
    ctx.clock.now(),
  );
  const liveKey = present(action.liveKey);
  const item = liveKey === undefined ? made : { ...made, liveKey };
  const arriving: Space = { ...space, items: { ...space.items, [itemId]: item } };
  const placed = place(arriving, itemId, action.placement ?? { to: "tree" });
  return placed ? replaceSpace(ws, placed) : ws;
}

function closeItem(ws: Workspace, itemId: Id, ctx: ReducerContext): Workspace {
  const located = locate(ws, itemId);
  if (!located) return ws;
  const place = placeOfItem(located.space, itemId);
  const entry: ClosedItem = {
    item: withoutSessions(located.item),
    spaceId: located.space.id,
    closedAt: ctx.clock.now(),
    ...(place !== undefined ? { place } : {}),
  };
  return replaceSpace(
    {
      ...ws,
      favorites: ws.favorites.filter((id) => id !== itemId),
      closed: pushClosed(ws.closed, [entry]),
    },
    dropItem(located.space, itemId),
  );
}

function reopenItem(ws: Workspace, itemId: Id | undefined, ctx: ReducerContext): Workspace {
  const at =
    itemId === undefined
      ? ws.closed.length - 1
      : ws.closed.findIndex((entry) => entry.item.id === itemId);
  const entry = ws.closed[at];
  if (!entry) return ws;
  const revived = revive(ws, entry, ctx);
  return revived ? { ...revived, closed: revived.closed.filter((_, i) => i !== at) } : ws;
}

/** Puts an open item away in the archive, with the slot it leaves; its sessions are dropped. */
function archiveItem(ws: Workspace, itemId: Id, ctx: ReducerContext): Workspace {
  const located = locate(ws, itemId);
  if (!located) return ws;
  const place = placeOfItem(located.space, itemId);
  const entry: ArchivedItem = {
    item: withoutSessions(located.item),
    spaceId: located.space.id,
    archivedAt: ctx.clock.now(),
    ...(place !== undefined ? { place } : {}),
  };
  return replaceSpace(
    {
      ...ws,
      favorites: ws.favorites.filter((id) => id !== itemId),
      archive: [...ws.archive, entry],
    },
    dropItem(located.space, itemId),
  );
}

function restoreArchived(ws: Workspace, itemId: Id, ctx: ReducerContext): Workspace {
  const at = ws.archive.findIndex((entry) => entry.item.id === itemId);
  const entry = ws.archive[at];
  if (!entry) return ws;
  const revived = revive(ws, entry, ctx);
  return revived ? { ...revived, archive: revived.archive.filter((_, i) => i !== at) } : ws;
}

/**
 * The workspace with the item of a closed or archived entry back in a space, where it sat; the
 * entry itself is left in its list for the caller to take out. `undefined` when it cannot be placed.
 */
function revive(
  ws: Workspace,
  entry: Pick<ClosedItem, "item" | "spaceId" | "place">,
  ctx: ReducerContext,
): Workspace | undefined {
  // Back to the space it came from, in the slot it left; with that space gone, to the end of the
  // tree of the active one.
  const home = findSpace(ws, entry.spaceId);
  const space = home ?? findSpace(ws, ws.activeSpaceId);
  if (!space) return undefined;
  const placement = home ? placementOf(home, entry.place) : TREE_END;
  // A closed item holds no live session, whatever the state it was loaded from says.
  const stripped = withoutSessions(entry.item);
  const item: Item = {
    ...stripped,
    // Nor does it carry what the old shell was doing: its new session starts clean.
    layout: mapPanes(stripped.layout, withoutOldShell),
    lastActivityAt: ctx.clock.now(),
  };
  // Only a pinned item has an origin to return to.
  if (placement.to === "pinned") {
    const origin = item.origin ?? originOf(item, space);
    if (origin !== undefined) item.origin = origin;
  } else {
    delete item.origin;
  }
  const arriving: Space = { ...space, items: { ...space.items, [item.id]: item } };
  const placed = place(arriving, item.id, placement);
  return placed ? replaceSpace(ws, placed) : undefined;
}

function renameItem(ws: Workspace, action: Extract<Action, { type: "item/rename" }>): Workspace {
  const located = locate(ws, action.itemId);
  if (!located) return ws;
  const { item, space } = located;
  const title = clean(action.title);
  const byUser = (action.source ?? "user") === "user";
  // A title the user typed locks it against the running program.
  if (!byUser && item.titleLocked) return ws;

  const next: Item = { ...item, titleLocked: byUser ? title !== undefined : item.titleLocked };
  if (title === undefined) {
    delete next.title;
  } else {
    next.title = title;
  }
  if (next.title === item.title && next.titleLocked === item.titleLocked) return ws;
  return replaceSpace(ws, { ...space, items: { ...space.items, [item.id]: next } });
}

// ---------------------------------------------------------------------------------------------
// Groups

function createGroup(
  ws: Workspace,
  action: Extract<Action, { type: "group/create" }>,
  ctx: ReducerContext,
): Workspace {
  const space = findSpace(ws, action.spaceId ?? ws.activeSpaceId);
  const name = clean(action.name);
  const color = action.color === undefined ? space?.color : clean(action.color);
  if (!space || name === undefined || color === undefined) return ws;
  if (action.live !== undefined && !isLiveSource(action.live)) return ws;
  if (action.parentGroupId !== undefined) {
    // Only a top-level group can hold another one: groups go two levels deep.
    const parent = findGroup(space.tree, action.parentGroupId);
    if (!parent || parent.depth >= MAX_GROUP_DEPTH) return ws;
  }
  const group: GroupNode = {
    kind: "group",
    id: idPool(ws, ctx)(),
    name,
    color,
    collapsed: false,
    children: [],
    ...(action.live !== undefined ? { live: { ...action.live } } : {}),
  };
  const tree = editChildren(space.tree, action.parentGroupId, (children) => {
    const index = resolveIndex(action.index, children.length, children.length);
    return index === undefined ? undefined : insertAt<Node>(children, index, group);
  });
  return tree ? replaceSpace(ws, { ...space, tree }) : ws;
}

function moveGroup(ws: Workspace, action: Extract<Action, { type: "group/move" }>): Workspace {
  const hit = locateGroup(ws, action.groupId);
  if (!hit) return ws;
  const { space } = hit;
  const group = hit.found.group;
  if (action.parentGroupId !== undefined) {
    // Only a top-level group can hold another one, and only one that holds no group itself.
    const parent = findGroup(space.tree, action.parentGroupId);
    const holdsGroup = group.children.some((child) => child.kind === "group");
    if (!parent || parent.depth >= MAX_GROUP_DEPTH || holdsGroup) return ws;
    if (parent.group.id === group.id) return ws;
  }
  const from = findGroupSlot(space.tree, group.id);
  const tree = editChildren(
    removeGroupNode(space.tree, group.id),
    action.parentGroupId,
    (children) => {
      const index = resolveIndex(action.index, children.length, children.length);
      return index === undefined ? undefined : insertAt<Node>(children, index, group);
    },
  );
  if (!tree || !from) return ws;
  const to = findGroupSlot(tree, group.id);
  // Dropped where it already was: nothing changes.
  if (to && to.parentId === from.parentId && to.index === from.index) return ws;
  return replaceSpace(ws, { ...space, tree });
}

function groupSelection(
  ws: Workspace,
  action: Extract<Action, { type: "group/create-from-selection" }>,
  ctx: ReducerContext,
): Workspace {
  const name = clean(action.name);
  const wanted = new Set(action.itemIds);
  const anchor = action.itemIds[0];
  const located = anchor === undefined ? undefined : locate(ws, anchor);
  if (!located || name === undefined) return ws;
  const { space } = located;
  const color = action.color === undefined ? space.color : clean(action.color);
  if (color === undefined) return ws;

  // Every id must be a tree item of this one space (not pinned, not elsewhere).
  const selected = treeItemIds(space.tree).filter((id) => wanted.has(id));
  const first = selected[0];
  if (first === undefined || selected.length !== wanted.size) return ws;
  const slot = findItemSlot(space.tree, first);
  if (!slot || slot.parentDepth >= MAX_GROUP_DEPTH) return ws;

  const group: GroupNode = {
    kind: "group",
    id: idPool(ws, ctx)(),
    name,
    color,
    collapsed: false,
    children: selected.map((id) => ({ kind: "item", id })),
  };
  // The group takes the place of the first selected item; nothing selected sits before it.
  const tree = editChildren(removeItemNodes(space.tree, wanted), slot.parentId, (children) =>
    insertAt<Node>(children, slot.index, group),
  );
  return tree ? replaceSpace(ws, { ...space, tree }) : ws;
}

// ---------------------------------------------------------------------------------------------
// Splits

const isDir = (dir: unknown): dir is "row" | "column" => dir === "row" || dir === "column";
const isSide = (side: unknown): side is "before" | "after" => side === "before" || side === "after";

/** `ctx.maxPanes` when it is a positive integer, else the default. */
function maxPanesOf(ctx: ReducerContext): number {
  const max = ctx.maxPanes;
  return max !== undefined && Number.isInteger(max) && max >= 1 ? max : DEFAULT_MAX_PANES;
}

function replaceItem(ws: Workspace, space: Space, item: Item): Workspace {
  return replaceSpace(ws, { ...space, items: { ...space.items, [item.id]: item } });
}

function withoutZoom(item: Item): Item {
  if (item.zoomedPaneId === undefined) return item;
  const next = { ...item };
  delete next.zoomedPaneId;
  return next;
}

/**
 * The item after `removedId` left its layout (now `layout`): zoom ends if it was on that pane or
 * nothing is left to zoom; focus goes to the neighbor in layout order (before it, else after) if it
 * was on that pane.
 */
function afterRemoval(item: Item, layout: LayoutNode, removedId: Id): Item {
  const old = layoutPanes(item.layout);
  const at = old.findIndex((pane) => pane.id === removedId);
  const heir = old[at - 1] ?? old[at + 1];
  const next: Item = { ...item, layout };
  if (item.focusedPaneId === removedId && heir) next.focusedPaneId = heir.id;
  return item.zoomedPaneId === removedId || layout.kind === "pane" ? withoutZoom(next) : next;
}

function splitPane(
  ws: Workspace,
  action: Extract<Action, { type: "pane/split" }>,
  ctx: ReducerContext,
): Workspace {
  if (!isDir(action.dir) || !isSide(action.side)) return ws;
  const located = locate(ws, action.itemId);
  const source = located && findPane(located.item.layout, action.paneId);
  if (!located || !source) return ws;
  if (countPanes(located.item.layout) + 1 > maxPanesOf(ctx)) return ws;
  const profileId = action.profileId === undefined ? source.profileId : present(action.profileId);
  if (profileId === undefined) return ws;
  // A browser pane has no folder of its own to hand on, and its address has to be one it may show.
  const { url } = action;
  if (url !== undefined && (typeof url !== "string" || browserUrlProblem(url) !== undefined)) {
    return ws;
  }
  // A preview pane is the same: no folder to hand on, and a path it may hold.
  const { path } = action;
  if (path !== undefined && (typeof path !== "string" || previewPathProblem(path) !== undefined)) {
    return ws;
  }
  if (url !== undefined && path !== undefined) return ws;
  // A diff pane takes the folder it is given, else the one of the pane it is split from, and the
  // folder has to be one git can be run in (a full local path).
  const diffCwd = action.diff === true ? (present(action.cwd) ?? source.cwd) : undefined;
  if (action.diff === true) {
    if (url !== undefined || path !== undefined) return ws;
    if (diffCwd === undefined || previewPathProblem(diffCwd) !== undefined) return ws;
  }
  const id = idPool(ws, ctx)();
  const fresh =
    diffCwd !== undefined
      ? createDiffPane(id, diffCwd)
      : url !== undefined
        ? createBrowserPane(id, url)
        : path !== undefined
          ? createPreviewPane(id, path)
          : createPane(id, profileId, present(action.cwd) ?? source.cwd);
  const layout = insertBeside(located.item.layout, source.id, action.dir, action.side, {
    kind: "pane",
    pane: fresh,
  });
  if (!layout) return ws;
  // The new pane takes focus, so zoom on another pane would hide it.
  const item: Item = { ...withoutZoom(located.item), layout, focusedPaneId: fresh.id };
  return replaceItem(ws, located.space, item);
}

function setPaneUrl(ws: Workspace, action: Extract<Action, { type: "pane/set-url" }>): Workspace {
  if (typeof action.url !== "string" || browserUrlProblem(action.url) !== undefined) return ws;
  const located = locate(ws, action.itemId);
  const pane = located && findPane(located.item.layout, action.paneId);
  if (!located || !pane || pane.type !== "browser" || pane.url === action.url) return ws;
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, { ...pane, url: action.url }),
  });
}

function closePane(ws: Workspace, itemId: Id, paneId: Id, ctx: ReducerContext): Workspace {
  const located = locate(ws, itemId);
  if (!located || !findPane(located.item.layout, paneId)) return ws;
  // The only pane: nothing would be left, so the item closes.
  if (located.item.layout.kind === "pane") return closeItem(ws, itemId, ctx);
  const layout = removePane(located.item.layout, paneId);
  return layout ? replaceItem(ws, located.space, afterRemoval(located.item, layout, paneId)) : ws;
}

function detachPane(ws: Workspace, itemId: Id, paneId: Id, ctx: ReducerContext): Workspace {
  const located = locate(ws, itemId);
  const pane = located && findPane(located.item.layout, paneId);
  if (!located || !pane) return ws;
  // A tab with one pane has nothing to detach (`removePane` gives up on it).
  const layout = removePane(located.item.layout, paneId);
  if (!layout) return ws;
  const { item, space } = located;
  const detached = createTab(idPool(ws, ctx)(), pane, ctx.clock.now());
  const arriving: Space = {
    ...space,
    items: {
      ...space.items,
      [item.id]: afterRemoval(item, layout, paneId),
      [detached.id]: detached,
    },
  };
  // Right after the origin item. A pinned origin keeps the pin to itself: the new item opens at
  // the top of the tree, just below the pinned items.
  const slot = findItemSlot(space.tree, item.id);
  if (!slot && !space.pinned.includes(item.id)) return ws;
  const placement: Placement = slot
    ? {
        to: "tree",
        index: slot.index + 1,
        ...(slot.parentId !== undefined ? { groupId: slot.parentId } : {}),
      }
    : { to: "tree", index: 0 };
  const placed = place(arriving, detached.id, placement);
  return placed ? replaceSpace(ws, placed) : ws;
}

function joinItem(
  ws: Workspace,
  action: Extract<Action, { type: "item/join" }>,
  ctx: ReducerContext,
): Workspace {
  if (!isDir(action.dir) || !isSide(action.side) || action.itemId === action.targetItemId) {
    return ws;
  }
  const source = locate(ws, action.itemId);
  const target = locate(ws, action.targetItemId);
  if (!source || !target || !findPane(target.item.layout, action.targetPaneId)) return ws;
  if (countPanes(source.item.layout) + countPanes(target.item.layout) > maxPanesOf(ctx)) return ws;
  const layout = insertBeside(
    target.item.layout,
    action.targetPaneId,
    action.dir,
    action.side,
    source.item.layout,
  );
  const joinedPanes = layoutPanes(source.item.layout);
  const focus = joinedPanes.find((pane) => pane.id === source.item.focusedPaneId) ?? joinedPanes[0];
  if (!layout || !focus) return ws;
  const merged: Item = { ...withoutZoom(target.item), layout, focusedPaneId: focus.id };
  const joined = replaceItem(ws, target.space, merged);
  // The source space as it is now (the same as the target's when both share a space).
  const left = locate(joined, source.item.id);
  if (!left) return ws;
  return {
    ...replaceSpace(joined, dropItem(left.space, source.item.id)),
    favorites: ws.favorites.filter((id) => id !== source.item.id),
  };
}

function resizeSplit(ws: Workspace, action: Extract<Action, { type: "pane/resize" }>): Workspace {
  const located = locate(ws, action.itemId);
  if (!located || !Array.isArray(action.path) || !Array.isArray(action.sizes)) return ws;
  const split = splitAt(located.item.layout, action.path);
  if (!split || action.sizes.length !== split.children.length) return ws;
  const sizes = normalizeSizes(action.sizes);
  if (!sizes || sizes.every((size, i) => Math.abs(size - (split.sizes[i] ?? NaN)) < 1e-9)) {
    return ws;
  }
  const layout = setSplitSizes(located.item.layout, action.path, sizes);
  return layout ? replaceItem(ws, located.space, { ...located.item, layout }) : ws;
}

function zoomPane(ws: Workspace, itemId: Id, paneId: Id | undefined): Workspace {
  const located = locate(ws, itemId);
  if (!located || located.item.layout.kind === "pane") return ws;
  const { item, space } = located;
  const target = paneId ?? item.zoomedPaneId ?? item.focusedPaneId;
  if (!findPane(item.layout, target)) return ws;
  if (item.zoomedPaneId === target) return replaceItem(ws, space, withoutZoom(item));
  return replaceItem(ws, space, { ...item, zoomedPaneId: target, focusedPaneId: target });
}

function swapItemPanes(ws: Workspace, itemId: Id, paneId: Id, otherPaneId: Id): Workspace {
  const located = locate(ws, itemId);
  const a = located && findPane(located.item.layout, paneId);
  const b = located && findPane(located.item.layout, otherPaneId);
  if (!located || !a || !b || a.id === b.id) return ws;
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: swapPanes(located.item.layout, a, b),
  });
}

function focusPane(ws: Workspace, itemId: Id, paneId: Id): Workspace {
  const located = locate(ws, itemId);
  if (!located || !findPane(located.item.layout, paneId)) return ws;
  const { item, space } = located;
  const zoomed = item.zoomedPaneId;
  if (item.focusedPaneId === paneId && (zoomed === undefined || zoomed === paneId)) return ws;
  // Zoom shows one pane only: focusing another one brings the layout back.
  const base = zoomed !== undefined && zoomed !== paneId ? withoutZoom(item) : item;
  return replaceItem(ws, space, { ...base, focusedPaneId: paneId });
}

/** Copy of the layout with the pane replaced by `next`; the same object when the pane is absent. */
function withPane(layout: LayoutNode, next: Pane): LayoutNode {
  if (layout.kind === "pane")
    return layout.pane.id === next.id ? { kind: "pane", pane: next } : layout;
  const children = layout.children.map((child) => withPane(child, next));
  return children.some((child, index) => child !== layout.children[index])
    ? { ...layout, children }
    : layout;
}

function setPaneStatus(
  ws: Workspace,
  action: Extract<Action, { type: "pane/set-status" }>,
): Workspace {
  const { status, exitCode } = action;
  if (status !== "running" && status !== "idle" && status !== "exited") return ws;
  const located = locate(ws, action.itemId);
  const pane = located && findPane(located.item.layout, action.paneId);
  if (!located || !pane) return ws;
  const code =
    status === "exited" && typeof exitCode === "number" && Number.isFinite(exitCode)
      ? exitCode
      : undefined;
  if (
    pane.status === status &&
    pane.exitCode === code &&
    !(status === "exited" && pane.runningCommand)
  ) {
    return ws;
  }
  const next: Pane = { ...pane, status };
  delete next.exitCode;
  if (code !== undefined) next.exitCode = code;
  // A shell that exited runs nothing.
  if (status === "exited") delete next.runningCommand;
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, next),
  });
}

function setPaneLocation(
  ws: Workspace,
  action: Extract<Action, { type: "pane/set-location" }>,
): Workspace {
  const { cwd, gitBranch } = action;
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.trim() === "")) return ws;
  if (gitBranch !== undefined && typeof gitBranch !== "string") return ws;
  const branch = gitBranch === undefined ? undefined : present(gitBranch);
  const located = locate(ws, action.itemId);
  const pane = located && findPane(located.item.layout, action.paneId);
  if (!located || !pane) return ws;
  if ((cwd === undefined || pane.cwd === cwd) && pane.gitBranch === branch) return ws;
  const next: Pane = { ...pane, ...(cwd !== undefined ? { cwd } : {}) };
  delete next.gitBranch;
  if (branch !== undefined) next.gitBranch = branch;
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, next),
  });
}

/** Longest command line kept on a pane, in characters. */
const MAX_COMMAND_TEXT = 500;

/** The command line of a pane as kept: trimmed, none when blank, cut at {@link MAX_COMMAND_TEXT}. */
function commandText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = clean(text);
  if (trimmed === undefined) return undefined;
  const chars = Array.from(trimmed);
  return chars.length > MAX_COMMAND_TEXT ? chars.slice(0, MAX_COMMAND_TEXT).join("") : trimmed;
}

function startPaneCommand(
  ws: Workspace,
  action: Extract<Action, { type: "pane/command-start" }>,
): Workspace {
  const located = locate(ws, action.itemId);
  const pane = located && findPane(located.item.layout, action.paneId);
  if (!located || !pane || pane.status === "exited") return ws;
  const text = commandText(action.text);
  if (pane.runningCommand && pane.runningCommand.text === text) return ws;
  const next: Pane = { ...pane, runningCommand: text !== undefined ? { text } : {} };
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, next),
  });
}

function endPaneCommand(
  ws: Workspace,
  action: Extract<Action, { type: "pane/command-end" }>,
): Workspace {
  const located = locate(ws, action.itemId);
  const pane = located && findPane(located.item.layout, action.paneId);
  if (!located || !pane) return ws;
  const text = commandText(action.text) ?? pane.runningCommand?.text;
  const { exitCode, durationMs } = action;
  const last: LastCommand = {
    ...(text !== undefined ? { text } : {}),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
    ...(typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs: Math.round(durationMs) }
      : {}),
  };
  const known = Object.keys(last).length > 0;
  const before = pane.lastCommand;
  const sameLast = known
    ? before !== undefined &&
      before.text === last.text &&
      before.exitCode === last.exitCode &&
      before.durationMs === last.durationMs
    : true;
  if (!pane.runningCommand && sameLast) return ws;
  const next: Pane = { ...pane, ...(known ? { lastCommand: last } : {}) };
  delete next.runningCommand;
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, next),
  });
}

function notifyPane(
  ws: Workspace,
  action: Extract<Action, { type: "pane/notify" }>,
  ctx: ReducerContext,
): Workspace {
  const located = locate(ws, action.itemId);
  const pane = located && findPane(located.item.layout, action.paneId);
  if (!located || !pane) return ws;
  // The user is looking at it: there is nothing they missed.
  if (isPaneVisible(ws, located.space.id, located.item.id, pane.id)) return ws;
  const bell = action.bell === true;
  if (pane.unread && (pane.bell || !bell)) return ws;
  // The time is kept from the first mark, so a program that keeps ringing does not change the
  // workspace (and the saved file) at every bell.
  const next: Pane = {
    ...pane,
    unread: true,
    bell: pane.bell || bell,
    unreadAt: pane.unread ? (pane.unreadAt ?? ctx.clock.now()) : ctx.clock.now(),
  };
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, next),
  });
}

function setPaneScrollback(
  ws: Workspace,
  action: Extract<Action, { type: "pane/set-scrollback" }>,
): Workspace {
  const { ref } = action;
  if (ref !== undefined && (typeof ref !== "string" || ref.trim() === "")) return ws;
  const located = locate(ws, action.itemId);
  const note = (pane: Pane): Pane => {
    const next: Pane = { ...pane };
    delete next.scrollbackRef;
    if (ref !== undefined) next.scrollbackRef = ref;
    return next;
  };
  if (!located) {
    // A closed or archived item keeps the notes of its panes too: its snapshot is written as it
    // leaves the space.
    const at = ws.closed.findIndex((entry) => entry.item.id === action.itemId);
    const entry = ws.closed[at];
    if (entry) {
      const closedPane = findPane(entry.item.layout, action.paneId);
      if (!closedPane || closedPane.scrollbackRef === ref) return ws;
      const layout = withPane(entry.item.layout, note(closedPane));
      return {
        ...ws,
        closed: ws.closed.map((e, i) => (i === at ? { ...e, item: { ...e.item, layout } } : e)),
      };
    }
    const archivedAt = ws.archive.findIndex((e) => e.item.id === action.itemId);
    const archived = ws.archive[archivedAt];
    const archivedPane = archived && findPane(archived.item.layout, action.paneId);
    if (!archived || !archivedPane || archivedPane.scrollbackRef === ref) return ws;
    const layout = withPane(archived.item.layout, note(archivedPane));
    return {
      ...ws,
      archive: ws.archive.map((e, i) =>
        i === archivedAt ? { ...e, item: { ...e.item, layout } } : e,
      ),
    };
  }
  const pane = findPane(located.item.layout, action.paneId);
  if (!pane || pane.scrollbackRef === ref) return ws;
  return replaceItem(ws, located.space, {
    ...located.item,
    layout: withPane(located.item.layout, note(pane)),
  });
}

function clearUnread(
  ws: Workspace,
  action: Extract<Action, { type: "pane/clear-unread" }>,
): Workspace {
  const located = locate(ws, action.itemId);
  if (!located) return ws;
  const layout = mapPanes(located.item.layout, (pane) =>
    action.paneId === undefined || pane.id === action.paneId ? withoutMarks(pane) : pane,
  );
  return layout === located.item.layout
    ? ws
    : replaceItem(ws, located.space, { ...located.item, layout });
}

/**
 * The panes on screen have nothing unread: showing a tab (or a space, or a pane that zoom hid)
 * is reading it. The main window shows the tab of the active space and every other window the tab
 * of its own space, each is looked at, so each is read (finding 241). Runs after every action that
 * changed the workspace, so no action has to know.
 */
function clearViewed(ws: Workspace): Workspace {
  let next = ws;
  for (const spaceId of [ws.activeSpaceId, ...workspaceWindows(ws).map((w) => w.spaceId)]) {
    next = clearViewedIn(next, spaceId);
  }
  return next;
}

/** The panes the space `spaceId` has on screen, read; the same workspace when none is marked. */
function clearViewedIn(ws: Workspace, spaceId: Id): Workspace {
  const space = findSpace(ws, spaceId);
  const item = space && shownItem(space);
  if (!space || !item || !visiblePanes(item).some(isMarked)) return ws;
  const seen = new Set(visiblePanes(item).map((pane) => pane.id));
  const layout = mapPanes(item.layout, (pane) => (seen.has(pane.id) ? withoutMarks(pane) : pane));
  // A space from an old file may have no active item: the one it shows becomes it, like in
  // `settleActive`, so a space this changes always has a valid one.
  const shown = space.activeItemId === item.id ? space : withActiveItem(space, item.id);
  return replaceItem(ws, shown, { ...item, layout });
}

function focusDirection(ws: Workspace, itemId: Id, direction: unknown): Workspace {
  const located = locate(ws, itemId);
  if (
    !located ||
    (direction !== "left" && direction !== "right" && direction !== "up" && direction !== "down")
  ) {
    return ws;
  }
  const next = neighborPane(located.item.layout, located.item.focusedPaneId, direction);
  return next === undefined ? ws : focusPane(ws, itemId, next);
}

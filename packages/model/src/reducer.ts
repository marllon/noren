import type { Action, Placement, ReducerContext } from "./actions";
import {
  DEFAULT_PROFILE_ID,
  createEmptySpace,
  createPane,
  createTab,
  type EmptySpaceOptions,
} from "./factories";
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
import { layoutPanes, withoutSessions } from "./sessions";
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
  treeGroups,
  treeItemIds,
  updateGroup,
  type GroupLocation,
} from "./tree";
import {
  DEFAULT_MAX_PANES,
  MAX_CLOSED,
  MAX_GROUP_DEPTH,
  type ClosedItem,
  type GroupNode,
  type Id,
  type Item,
  type ItemOrigin,
  type LayoutNode,
  type Node,
  type Pane,
  type Space,
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
 * the action changed ends with a valid active item (see `settleActive`).
 */
export function reduceStrict(ws: Workspace, action: Action, ctx: ReducerContext): Workspace {
  const next = applyAction(ws, action, ctx);
  return next === ws ? ws : settleActive(ws, next, action);
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
    case "space/set-defaults":
      return setSpaceDefaults(ws, action);
    case "space/move":
      return moveSpace(ws, action.spaceId, action.index);
    case "space/activate":
      if (ws.activeSpaceId === action.spaceId || !findSpace(ws, action.spaceId)) return ws;
      return { ...ws, activeSpaceId: action.spaceId };
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
    case "pane/split":
      return splitPane(ws, action, ctx);
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

/** Item ids of a space in visual order: pinned, then the tree depth-first. */
function spaceItemIds(space: Space): Id[] {
  const ordered = new Set(
    [...space.pinned, ...treeItemIds(space.tree)].filter((id) => Object.hasOwn(space.items, id)),
  );
  for (const id of Object.keys(space.items)) ordered.add(id);
  return [...ordered];
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
  if (action.type === "item/create" || action.type === "item/reopen") {
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

  // The space that slides into the deleted one's place, or the last one.
  const neighbor = rest[Math.min(index, rest.length - 1)];
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
  const nextId = idPool(ws, ctx);
  const itemId = nextId();
  const item = createTab(itemId, createPane(nextId(), profileId, cwd), ctx.clock.now());
  const arriving: Space = { ...space, items: { ...space.items, [itemId]: item } };
  const placed = place(arriving, itemId, action.placement ?? { to: "tree" });
  return placed ? replaceSpace(ws, placed) : ws;
}

function closeItem(ws: Workspace, itemId: Id, ctx: ReducerContext): Workspace {
  const located = locate(ws, itemId);
  if (!located) return ws;
  const entry: ClosedItem = {
    item: withoutSessions(located.item),
    spaceId: located.space.id,
    closedAt: ctx.clock.now(),
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
  // Back to the space it came from, or to the active one when that space is gone.
  const space = findSpace(ws, entry.spaceId) ?? findSpace(ws, ws.activeSpaceId);
  if (!space) return ws;
  // A closed item holds no live session, whatever the state it was loaded from says.
  const item: Item = { ...withoutSessions(entry.item), lastActivityAt: ctx.clock.now() };
  // It comes back unpinned, so it has no origin to return to.
  delete item.origin;
  const arriving: Space = { ...space, items: { ...space.items, [item.id]: item } };
  const placed = place(arriving, item.id, { to: "tree" });
  if (!placed) return ws;
  return replaceSpace({ ...ws, closed: ws.closed.filter((_, i) => i !== at) }, placed);
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
  const fresh = createPane(idPool(ws, ctx)(), profileId, present(action.cwd) ?? source.cwd);
  const layout = insertBeside(located.item.layout, source.id, action.dir, action.side, {
    kind: "pane",
    pane: fresh,
  });
  if (!layout) return ws;
  // The new pane takes focus, so zoom on another pane would hide it.
  const item: Item = { ...withoutZoom(located.item), layout, focusedPaneId: fresh.id };
  return replaceItem(ws, located.space, item);
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
  if (pane.status === status && pane.exitCode === code) return ws;
  const next: Pane = { ...pane, status };
  delete next.exitCode;
  if (code !== undefined) next.exitCode = code;
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

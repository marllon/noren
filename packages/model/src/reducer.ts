import type { Action, Placement, ReducerContext } from "./actions";
import {
  DEFAULT_PROFILE_ID,
  createEmptySpace,
  createPane,
  createTab,
  type EmptySpaceOptions,
} from "./factories";
import { layoutPanes, withoutSessions } from "./sessions";
import {
  editChildren,
  findGroup,
  findItemSlot,
  insertAt,
  removeItemNodes,
  replaceGroupWithChildren,
  resolveIndex,
  treeGroups,
  treeItemIds,
  updateGroup,
  type GroupLocation,
} from "./tree";
import {
  MAX_CLOSED,
  MAX_GROUP_DEPTH,
  type ClosedItem,
  type GroupNode,
  type Id,
  type Item,
  type Node,
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

/** `reduce` without the safety net: tests use it so a bug cannot hide behind a no-op. */
export function reduceStrict(ws: Workspace, action: Action, ctx: ReducerContext): Workspace {
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
    case "space/move":
      return moveSpace(ws, action.spaceId, action.index);
    case "space/activate":
      if (ws.activeSpaceId === action.spaceId || !findSpace(ws, action.spaceId)) return ws;
      return { ...ws, activeSpaceId: action.spaceId };
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
    return placed ? replaceSpace(ws, placed) : ws;
  }
  const arriving: Space = { ...target, items: { ...target.items, [item.id]: item } };
  const placed = place(arriving, item.id, placement);
  if (!placed) return ws;
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
  const options: EmptySpaceOptions = {
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

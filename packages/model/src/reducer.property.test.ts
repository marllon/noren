import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbAction } from "./action-arbitraries";
import type { Action, ActionType } from "./actions";
import { arbWorkspace } from "./arbitraries";
import { favoriteLinkKey, favoriteLinkProblem, favoriteLinksOf } from "./favorite-links";
import { checkInvariants } from "./invariants";
import { exportSpace, validateSpaceFile } from "./space-file";
import { reduce, reduceStrict } from "./reducer";
import { layoutPanes, liveSessionIds } from "./sessions";
import { shownItem, visiblePanes } from "./unread";
import { deepFreeze, testContext } from "./test-helpers";
import { treeGroups } from "./tree";
import {
  DEFAULT_MAX_PANES,
  MAX_CLOSED,
  MAX_EXTRA_WINDOWS,
  type FavoriteLinkRef,
  type Id,
  type Item,
  type Workspace,
} from "./types";

/** One key per action type: the compiler fails here when a new action is not listed. */
const ACTION_TYPES: Record<ActionType, true> = {
  "space/create": true,
  "space/import": true,
  "space/reimport": true,
  "space/rename": true,
  "space/set-color": true,
  "space/set-icon": true,
  "space/set-theme": true,
  "space/set-background": true,
  "space/set-mods": true,
  "space/set-ai": true,
  "space/set-in-projects": true,
  "space/set-projects-open": true,
  "space/set-defaults": true,
  "space/move": true,
  "space/activate": true,
  "window/open": true,
  "window/close": true,
  "window/move-item": true,
  "window/open-with-item": true,
  "window/return": true,
  "space/set-active-item": true,
  "space/delete": true,
  "item/create": true,
  "item/close": true,
  "item/reopen": true,
  "item/archive": true,
  "archive/restore": true,
  "archive/delete": true,
  "closed/delete": true,
  "item/rename": true,
  "item/move": true,
  "item/pin": true,
  "item/unpin": true,
  "item/reset": true,
  "item/favorite": true,
  "item/unfavorite": true,
  "favorite/add-link": true,
  "favorite/remove-link": true,
  "group/create": true,
  "group/create-from-selection": true,
  "group/ungroup": true,
  "group/move": true,
  "group/set-collapsed": true,
  "group/rename": true,
  "group/set-color": true,
  "group/set-live": true,
  "pane/split": true,
  "pane/set-url": true,
  "pane/close": true,
  "pane/detach": true,
  "item/join": true,
  "pane/resize": true,
  "pane/zoom": true,
  "pane/swap": true,
  "pane/focus": true,
  "pane/focus-direction": true,
  "pane/set-status": true,
  "pane/set-location": true,
  "pane/set-shell-folder": true,
  "pane/command-start": true,
  "pane/command-end": true,
  "pane/notify": true,
  "pane/set-scrollback": true,
  "pane/clear-unread": true,
};
const TYPES = Object.keys(ACTION_TYPES) as ActionType[];

const STEPS = 200;
const NUM_RUNS = 150;
/** Runs of the sequences with a non-default `maxPanes`. */
const SMALL_RUNS = 50;
const SEQUENCE_TIMEOUT_MS = 60_000;

/**
 * The seed every property of this file plays with. A random seed made the coverage checks below (each
 * action applied for real, a split over the limit, a browser tab taken to a window) fail one run in
 * about fifteen, and a failure of those checks says nothing about the seed that caused it. A fixed
 * seed makes every run of the file play the same sequences, so it passes or fails the same way
 * everywhere. `NOREN_PROPERTY_SEED=<number>` plays other sequences (to look for a counterexample
 * with a new seed); a failing property prints its seed (fast-check) and the coverage checks name it,
 * so the failure is played again with the same number.
 */
const DEFAULT_SEED = 20261024;
const SEED = seedOf(process.env["NOREN_PROPERTY_SEED"]);

/** The seed asked for in the environment, or the fixed one; an invalid value is an error, not a fallback. */
function seedOf(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_SEED;
  const seed = Number(value);
  if (!Number.isSafeInteger(seed))
    throw new Error(`NOREN_PROPERTY_SEED is not an integer: ${value}`);
  return seed;
}

/** What a run of `playSequences` counted: the same seed must give the same numbers. */
interface Played {
  generated: Record<string, number>;
  applied: Record<string, number>;
  noops: number;
  overLimit: number;
  previewsSeen: number;
  diffsSeen: number;
  browserTabsInWindows: number;
}

/** Actions whose effect on the panes `checkPaneDelta` knows. */
const PANE_ACTIONS = new Set<ActionType>([
  "pane/split",
  "pane/set-url",
  "pane/close",
  "pane/detach",
  "item/join",
  "pane/swap",
  "pane/resize",
  "pane/zoom",
  "pane/focus",
  "pane/focus-direction",
  "pane/set-status",
  "pane/set-location",
  "pane/set-shell-folder",
  "pane/command-start",
  "pane/command-end",
  "pane/notify",
  "pane/set-scrollback",
  "pane/clear-unread",
]);

const itemIdsOf = (ws: Workspace): Set<Id> =>
  new Set(ws.spaces.flatMap((space) => Object.keys(space.items)));
const itemOf = (ws: Workspace, itemId: Id): Item | undefined =>
  ws.spaces.flatMap((space) => Object.values(space.items)).find((item) => item.id === itemId);
/**
 * The panes of the tab as the page of a window would draw them: their ids, kinds and the one thing
 * each kind shows (the address, the file, the folder). A tab that goes to a window, and one that
 * comes back, must keep exactly these.
 */
const drawnPanesOf = (item: Item): string =>
  JSON.stringify(
    layoutPanes(item.layout).map((pane) => [pane.id, pane.type, pane.url, pane.path, pane.cwd]),
  );
/** Ids of every pane of every live item (closed and archived ones do not count). */
const paneIdsOf = (ws: Workspace): Id[] =>
  ws.spaces
    .flatMap((space) => Object.values(space.items))
    .flatMap((item) => layoutPanes(item.layout).map((pane) => pane.id))
    .sort();
const groupIdsOf = (ws: Workspace): Set<Id> =>
  new Set(ws.spaces.flatMap((space) => treeGroups(space.tree).map((g) => g.id)));

/** Sessions the app is expected to end for this action. */
function sessionsEndedBy(ws: Workspace, action: Action): Set<Id> {
  const ids = new Set<Id>();
  const collect = (items: Iterable<Item>): void => {
    for (const item of items) {
      for (const pane of layoutPanes(item.layout)) {
        if (pane.sessionId !== undefined) ids.add(pane.sessionId);
      }
    }
  };
  if (action.type === "pane/close") {
    // The pane's own session ends (the whole item's, when it was the only pane, via the pane too).
    const pane = itemOf(ws, action.itemId)?.layout;
    const closed = pane && layoutPanes(pane).find((p) => p.id === action.paneId);
    if (closed?.sessionId !== undefined) ids.add(closed.sessionId);
  }
  if (action.type === "item/reset") {
    // The focused pane of the item is replaced and its session ends.
    const item = itemOf(ws, action.itemId);
    const old = item && layoutPanes(item.layout).find((p) => p.id === item.focusedPaneId);
    if (old?.sessionId !== undefined) ids.add(old.sessionId);
  }
  for (const space of ws.spaces) {
    if (
      (action.type === "item/close" || action.type === "item/archive") &&
      Object.hasOwn(space.items, action.itemId)
    ) {
      collect(Object.values(space.items).filter((item) => item.id === action.itemId));
    } else if (
      ((action.type === "space/delete" && action.items.mode === "close") ||
        action.type === "space/reimport") &&
      space.id === action.spaceId
    ) {
      collect(Object.values(space.items));
    }
  }
  return ids;
}

/** The target an action names, when it is an id of the existing workspace that must exist. */
function missingTarget(ws: Workspace, action: Action): boolean {
  switch (action.type) {
    case "space/rename":
    case "space/set-color":
    case "space/set-icon":
    case "space/set-theme":
    case "space/set-background":
    case "space/set-mods":
    case "space/set-ai":
    case "space/set-in-projects":
    case "space/set-projects-open":
    case "space/set-defaults":
    case "space/move":
    case "space/activate":
    case "space/delete":
    case "space/reimport":
      return !ws.spaces.some((space) => space.id === action.spaceId);
    case "space/set-active-item":
      return !ws.spaces.some(
        (space) => space.id === action.spaceId && Object.hasOwn(space.items, action.itemId),
      );
    case "window/close":
    case "window/return":
      return !(ws.windows ?? []).some((window) => window.id === action.windowId);
    case "window/open-with-item":
      return !itemIdsOf(ws).has(action.itemId);
    case "window/move-item":
      return (
        !itemIdsOf(ws).has(action.itemId) ||
        !(ws.windows ?? []).some((window) => window.id === action.windowId)
      );
    case "item/close":
    case "item/archive":
    case "item/rename":
    case "item/move":
    case "item/pin":
    case "item/unpin":
    case "item/reset":
    case "item/favorite":
      return !itemIdsOf(ws).has(action.itemId);
    case "archive/restore":
    case "archive/delete":
      return !ws.archive.some((entry) => entry.item.id === action.itemId);
    case "closed/delete":
      return !ws.closed.some((entry) => entry.item.id === action.itemId);
    case "item/unfavorite":
      return !ws.favorites.includes(action.itemId);
    case "favorite/add-link":
      return (
        favoriteLinkProblem(action.link, ws.spaces) !== undefined ||
        hasFavoriteLink(ws, action.link)
      );
    case "favorite/remove-link":
      return !hasFavoriteLink(ws, action.link);
    case "group/ungroup":
    case "group/move":
    case "group/set-collapsed":
    case "group/rename":
    case "group/set-color":
    case "group/set-live":
      return !groupIdsOf(ws).has(action.groupId);
    case "pane/split":
    case "pane/set-url":
    case "pane/close":
    case "pane/detach":
    case "pane/focus":
    case "pane/set-status":
    case "pane/set-location":
    case "pane/set-shell-folder":
    case "pane/command-start":
    case "pane/command-end":
    case "pane/notify":
    case "pane/set-scrollback":
      return !hasPane(ws, action.itemId, action.paneId);
    case "pane/clear-unread":
      return (
        !itemIdsOf(ws).has(action.itemId) ||
        (action.paneId !== undefined && !hasPane(ws, action.itemId, action.paneId))
      );
    case "pane/swap":
      return (
        !hasPane(ws, action.itemId, action.paneId) ||
        !hasPane(ws, action.itemId, action.otherPaneId)
      );
    case "pane/zoom":
      return action.paneId !== undefined && !hasPane(ws, action.itemId, action.paneId);
    case "pane/resize":
    case "pane/focus-direction":
      return !itemIdsOf(ws).has(action.itemId);
    case "item/join":
      return (
        !itemIdsOf(ws).has(action.itemId) || !hasPane(ws, action.targetItemId, action.targetPaneId)
      );
    default:
      return false;
  }
}

function hasFavoriteLink(ws: Workspace, ref: FavoriteLinkRef): boolean {
  const key = favoriteLinkKey(ref);
  return favoriteLinksOf(ws).some((link) => favoriteLinkKey(link) === key);
}

/**
 * The bar takes a link at the end, once, with the name trimmed; a removal takes out that link and
 * keeps the others in their order; any other action leaves them alone, except that the actions of a
 * space that is gone go with it (and the profiles stay).
 */
function checkFavoriteLinks(
  ws: Workspace,
  next: Workspace,
  action: Action,
  where: () => string,
): void {
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  const before = favoriteLinksOf(ws);
  const after = favoriteLinksOf(next);
  if (action.type === "favorite/add-link") {
    if (after.length !== before.length + 1) fail("an added link did not make the list one longer");
    if (!before.every((link, index) => after[index] === link)) fail("an add moved a link");
    const added = after.at(-1);
    if (added === undefined || favoriteLinkKey(added) !== favoriteLinkKey(action.link)) {
      fail("the added link is not at the end");
    } else if (added.label !== action.link.label.trim()) {
      fail("the name of the added link was not trimmed");
    }
  } else if (action.type === "favorite/remove-link") {
    const key = favoriteLinkKey(action.link);
    if (after.some((link) => favoriteLinkKey(link) === key)) fail("a removed link is still there");
    if (
      JSON.stringify(after) !== JSON.stringify(before.filter((l) => favoriteLinkKey(l) !== key))
    ) {
      fail("a removal changed other links");
    }
  } else {
    // What leaves with a space (a deleted one, or the one of a window that closed) is its actions.
    const kept = before.filter(
      (link) => link.kind === "profile" || next.spaces.some((space) => space.id === link.spaceId),
    );
    if (JSON.stringify(after) !== JSON.stringify(kept)) {
      fail(`${action.type} changed the profiles and actions of the bar beyond a space that left`);
    }
  }
}

function hasPane(ws: Workspace, itemId: Id, paneId: Id): boolean {
  const item = itemOf(ws, itemId);
  return item !== undefined && layoutPanes(item.layout).some((pane) => pane.id === paneId);
}

/**
 * The active item of every space an action changed: always an item of the space (also covered by
 * `checkInvariants`), set whenever the space has items, and following creation, reopening and
 * explicit choice.
 */
function checkActiveItems(ws: Workspace, next: Workspace, action: Action, where: () => string) {
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  for (const space of next.spaces) {
    const old = ws.spaces.find((s) => s.id === space.id);
    if (old === space) continue;
    const count = Object.keys(space.items).length;
    const active = space.activeItemId;
    if (count > 0 && active === undefined) fail(`space ${space.id} has items but no active item`);
    if (count === 0 && active !== undefined) fail(`empty space ${space.id} has an active item`);
    if (old && active !== undefined && old.activeItemId === active) continue;
    if (action.type === "space/set-active-item" && action.spaceId === space.id) {
      if (active !== action.itemId) fail("the chosen item did not become active");
    }
    if (
      action.type === "item/create" ||
      action.type === "item/reopen" ||
      action.type === "archive/restore"
    ) {
      const arrived = Object.keys(space.items).filter(
        (id) => !old || !Object.hasOwn(old.items, id),
      );
      if (arrived.length === 1 && active !== arrived[0]) fail("the new item did not become active");
    }
  }
}

/**
 * Pinning leaves an origin (when the pane or the space has a folder), unpinning clears it, and a
 * reset puts a new pane in the folder and profile of the origin, keeping the origin.
 */
function checkOrigin(ws: Workspace, next: Workspace, action: Action, where: () => string): void {
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  if (action.type === "item/unpin") {
    if (itemOf(next, action.itemId)?.origin !== undefined) fail("unpin kept the origin");
  } else if (action.type === "item/pin") {
    const space = next.spaces.find((s) => Object.hasOwn(s.items, action.itemId));
    const item = itemOf(next, action.itemId);
    const pane = item && layoutPanes(item.layout).find((p) => p.id === item.focusedPaneId);
    const cwd = pane?.cwd ?? space?.defaults.cwd;
    if (cwd !== undefined && item?.origin === undefined) fail("pin recorded no origin");
    if (item?.origin !== undefined && pane?.profileId !== item.origin.profileId) {
      fail("the origin is not the pane's profile");
    }
  } else if (action.type === "item/reset") {
    const before = itemOf(ws, action.itemId);
    const after = itemOf(next, action.itemId);
    const pane = after && layoutPanes(after.layout).find((p) => p.id === after.focusedPaneId);
    if (!before?.origin || !pane) fail("reset changed an item that had no origin");
    if (pane?.cwd !== before?.origin?.cwd || pane?.profileId !== before?.origin?.profileId) {
      fail("reset did not return to the origin");
    }
    if (pane?.sessionId !== undefined) fail("the new pane has a session");
    if (after?.origin !== before?.origin) fail("reset changed the origin");
  }
}

/**
 * `space/import` adds exactly one space, at the end, made of ids no other space, item, group or
 * pane had, and exporting it again gives the file it came from; a file that is not valid (or has a
 * tab over `maxPanes`) adds nothing.
 */
function checkImport(
  ws: Workspace,
  next: Workspace,
  action: Action,
  limit: number,
  where: () => string,
): void {
  if (action.type !== "space/import") return;
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  if (!validateSpaceFile(action.file, limit).ok) {
    if (next !== ws) fail("a file that is not valid added a space");
    return;
  }
  if (next === ws) return fail("a valid file added nothing");
  const added = next.spaces.at(-1);
  if (next.spaces.length !== ws.spaces.length + 1 || added === undefined) {
    fail("an import did not add exactly one space at the end");
  } else if (action.activate !== false && next.activeSpaceId !== added.id) {
    fail("the imported space did not become the active one");
  } else if (action.activate === false && next.activeSpaceId !== ws.activeSpaceId) {
    fail("an import that asked not to activate changed the active space");
  } else {
    const back = exportSpace(added);
    if (
      !back.ok ||
      JSON.stringify(back.file) !== JSON.stringify({ ...action.file, profiles: [] })
    ) {
      fail("exporting the imported space does not give the file again");
    }
    const before = new Set(
      ws.spaces.flatMap((space) => [
        space.id,
        ...Object.keys(space.items),
        ...treeGroups(space.tree).map((group) => group.id),
        ...Object.values(space.items).flatMap((item) =>
          layoutPanes(item.layout).map((pane) => pane.id),
        ),
      ]),
    );
    for (const id of [
      added.id,
      ...Object.keys(added.items),
      ...treeGroups(added.tree).map((group) => group.id),
    ]) {
      if (before.has(id)) fail(`the imported space reuses the id ${id}`);
    }
  }
}

/**
 * `space/reimport` makes the space again from the file: the same id at the same place, the same
 * active space, the file back when it is exported again, ids no space, closed or archived tab ever
 * had, and the tabs it had in the closed stack (the stack keeps its last `MAX_CLOSED`); a space that
 * does not exist, or a file that is not valid, changes nothing.
 */
function checkReimport(
  ws: Workspace,
  next: Workspace,
  action: Action,
  limit: number,
  where: () => string,
): void {
  if (action.type !== "space/reimport") return;
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  const index = ws.spaces.findIndex((space) => space.id === action.spaceId);
  const old = ws.spaces[index];
  if (old === undefined || !validateSpaceFile(action.file, limit).ok) {
    if (next !== ws) fail("a reimport that could not be done changed the workspace");
    return;
  }
  if (next === ws) return fail("a valid reimport changed nothing");
  const made = next.spaces[index];
  if (made?.id !== old.id || next.spaces.length !== ws.spaces.length) {
    fail("the reimported space is not in its place");
  } else if (next.activeSpaceId !== ws.activeSpaceId) {
    fail("a reimport changed the active space");
  } else if (made.background !== old.background) {
    fail("a reimport lost the picture behind the terminals");
  } else {
    const back = exportSpace(made);
    if (
      !back.ok ||
      JSON.stringify(back.file) !== JSON.stringify({ ...action.file, profiles: [] })
    ) {
      fail("exporting the reimported space does not give the file again");
    }
    const known = new Set<Id>();
    const see = (item: Item): void => {
      known.add(item.id);
      for (const pane of layoutPanes(item.layout)) known.add(pane.id);
    };
    for (const space of ws.spaces) {
      known.add(space.id);
      Object.values(space.items).forEach(see);
      for (const group of treeGroups(space.tree)) known.add(group.id);
    }
    ws.closed.forEach((entry) => see(entry.item));
    ws.archive.forEach((entry) => see(entry.item));
    for (const id of [
      ...Object.keys(made.items),
      ...treeGroups(made.tree).map((group) => group.id),
      ...Object.values(made.items).flatMap((item) =>
        layoutPanes(item.layout).map((pane) => pane.id),
      ),
    ]) {
      if (known.has(id)) fail(`the reimported space reuses the id ${id}`);
    }
    const kept = new Set(next.closed.map((entry) => entry.item.id));
    const wanted = Object.keys(old.items);
    if (next.closed.length < MAX_CLOSED && !wanted.every((id) => kept.has(id))) {
      fail("the tabs the space had are not in the closed stack");
    }
  }
}

/** What an action that did something must do to the panes of the live items. */
function checkPaneDelta(ws: Workspace, next: Workspace, action: Action, where: () => string): void {
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  const same = (a: readonly Id[], b: readonly Id[]): boolean =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  if (!PANE_ACTIONS.has(action.type)) return;
  const before = paneIdsOf(ws);
  const after = paneIdsOf(next);
  switch (action.type) {
    case "pane/split":
      // Exactly one new pane.
      if (after.length !== before.length + 1 || !before.every((id) => after.includes(id))) {
        fail("split did not add exactly one pane");
      }
      break;
    case "pane/close":
      // Exactly that pane is gone (an item's only pane takes the item along).
      if (
        !same(
          after,
          before.filter((id) => id !== action.paneId),
        )
      ) {
        fail("close did not remove exactly the pane");
      }
      break;
    case "pane/detach":
    case "item/join":
    case "pane/swap":
    case "pane/resize":
    case "pane/zoom":
    case "pane/focus":
    case "pane/focus-direction":
    case "pane/set-url":
    case "pane/set-status":
    case "pane/set-location":
    case "pane/set-shell-folder":
    case "pane/command-start":
    case "pane/command-end":
    case "pane/notify":
    case "pane/set-scrollback":
    case "pane/clear-unread": {
      // The same panes, only arranged differently, and every session still there.
      const sessions = liveSessionIds(next);
      const kept = [...liveSessionIds(ws)].every((id) => sessions.has(id));
      if (!same(after, before) || !kept || sessions.size !== liveSessionIds(ws).size) {
        fail("the panes or the sessions changed");
      }
      break;
    }
    default:
      break;
  }
}

/**
 * The panes on screen are not unread, whatever the action that just ran: the ones the active space
 * shows in the main window, and the ones the space of each other window shows in that window.
 */
function checkNothingUnreadOnScreen(ws: Workspace, where: () => string): void {
  const shown = [ws.activeSpaceId, ...(ws.windows ?? []).map((window) => window.spaceId)];
  for (const spaceId of shown) {
    const space = ws.spaces.find((s) => s.id === spaceId);
    const item = space && shownItem(space);
    if (item && visiblePanes(item).some((pane) => pane.unread || pane.bell)) {
      throw new Error(`${where()}: a pane on screen is unread`);
    }
  }
}

/**
 * A tab is not refused a window for the kind of pane it holds (a window draws every kind). When the
 * tab exists, the window exists (or can be made: fewer than the most windows) and the tab is not in
 * the space of the window already, taking it there with no wish about the place must change the
 * workspace, whatever its panes are. This looks at the facts of the workspace, not at
 * `windowCanShowTab`, so it cannot agree with a wrong answer of that function.
 */
function checkNoTabRefusedForItsPanes(ws: Workspace, action: Action, where: () => string): void {
  if (action.type === "window/open-with-item") {
    if (itemOf(ws, action.itemId) !== undefined && (ws.windows ?? []).length < MAX_EXTRA_WINDOWS) {
      throw new Error(
        `${where()}: a tab that exists was not dragged out although there is room for a window`,
      );
    }
    return;
  }
  if (action.type !== "window/move-item" || itemOf(ws, action.itemId) === undefined) return;
  const window = (ws.windows ?? []).find((w) => w.id === action.windowId);
  const holder = ws.spaces.find((s) => Object.hasOwn(s.items, action.itemId));
  if (
    window !== undefined &&
    holder !== undefined &&
    holder.id !== window.spaceId &&
    action.placement === undefined
  ) {
    throw new Error(`${where()}: a tab was not taken into the space of a window`);
  }
}

/**
 * What the actions on windows must do: `window/open` adds exactly one window on the space asked,
 * `window/move-item` puts the tab in the space of the window and makes it the one that space
 * shows, `window/close` takes away exactly that window, and the main window never takes the space
 * of a window by `space/activate`. A window only goes away with its action, with its space (a
 * deleted space) or because the main window ended up showing it (`space/delete`).
 */
function checkWindows(ws: Workspace, next: Workspace, action: Action, where: () => string): void {
  const fail = (what: string): never => {
    throw new Error(`${where()}: ${what}`);
  };
  const before = ws.windows ?? [];
  const after = next.windows ?? [];
  if (action.type === "window/open") {
    const added = after.filter((w) => !before.some((b) => b.id === w.id));
    if (
      after.length !== before.length + 1 ||
      added.length !== 1 ||
      added[0]?.spaceId !== action.spaceId
    ) {
      fail("open did not add exactly one window on the space");
    }
  } else if (action.type === "window/close") {
    if (after.length !== before.length - 1 || after.some((w) => w.id === action.windowId)) {
      fail("close did not take away exactly the window");
    }
  } else if (action.type === "window/move-item") {
    const window = before.find((w) => w.id === action.windowId);
    const moving = itemOf(ws, action.itemId);
    const space = next.spaces.find((s) => s.id === window?.spaceId);
    const moved = space?.items[action.itemId];
    if (space === undefined || moved === undefined) {
      fail("the tab is not in the space of the window");
    } else if (space.activeItemId !== action.itemId) {
      fail("the tab that arrived is not the one the window shows");
    } else if (moving !== undefined && drawnPanesOf(moved) !== drawnPanesOf(moving)) {
      fail("the panes of the tab that went to a window are not the panes it had");
    }
  } else if (action.type === "window/open-with-item") {
    const dragged = itemOf(ws, action.itemId);
    const added = after.filter((w) => !before.some((b) => b.id === w.id));
    const space = next.spaces.find((s) => s.id === added[0]?.spaceId);
    if (after.length !== before.length + 1 || added.length !== 1 || space === undefined) {
      fail("dragging a tab out did not add exactly one window on a space");
    } else if (ws.spaces.some((s) => s.id === space.id)) {
      fail("the space of the window was there before");
    } else if (
      Object.keys(space.items).join() !== action.itemId ||
      space.activeItemId !== action.itemId
    ) {
      fail("the tab dragged out is not alone in the space of the window as the one it shows");
    } else if (dragged === undefined || added[0]?.returnSpaceId === undefined) {
      fail("the window does not remember where the tab came from");
    } else if (drawnPanesOf(dragged) !== drawnPanesOf(space.items[action.itemId] ?? dragged)) {
      fail("the panes of the tab dragged out are not the panes it had");
    } else if (next.spaces.length !== ws.spaces.length + 1) {
      fail("dragging a tab out made other than one space");
    }
  } else if (action.type === "window/return") {
    const window = before.find((w) => w.id === action.windowId);
    const gone = window !== undefined && !next.spaces.some((s) => s.id === window.spaceId);
    const held =
      window === undefined
        ? []
        : Object.keys(ws.spaces.find((s) => s.id === window.spaceId)?.items ?? {});
    if (after.length !== before.length - 1 || after.some((w) => w.id === action.windowId)) {
      fail("return did not take away exactly the window");
    } else if (window?.returnSpaceId !== undefined && !gone) {
      fail("the space made for the window did not go away with it");
    } else if (window?.returnSpaceId !== undefined) {
      for (const itemId of held) {
        const holder = next.spaces.find((s) => Object.hasOwn(s.items, itemId));
        if (holder === undefined || after.some((w) => w.spaceId === holder.id)) {
          fail("a tab of the window did not come back to a space a window does not show");
        }
      }
    }
  } else if (action.type === "space/activate") {
    if (before.some((w) => w.spaceId === action.spaceId) && next !== ws) {
      fail("the main window took the space of a window");
    }
  } else if (action.type !== "space/delete" && after.length < before.length) {
    fail("a window went away without its action");
  }
  if (
    action.type !== "window/open" &&
    action.type !== "window/open-with-item" &&
    after.length > before.length
  ) {
    fail("a window appeared without its action");
  }
}

interface Kinds {
  browserPanes?: boolean;
  previewPanes?: boolean;
  diffPanes?: boolean;
  windows?: boolean;
}

/**
 * Plays `STEPS` random actions per run on random workspaces, checking the invariants at every
 * step. `maxPanes` goes both to the generated workspaces and to the reducer; absent means the
 * default of 4. `browserPanes`, `previewPanes` and `diffPanes` make every third pane of the
 * generated workspaces a browser, a preview or a diff pane. Returns what the sequences covered.
 */
function play(numRuns: number, maxPanes: number | undefined, kinds: Kinds, seed: number): Played {
  const generated = new Map<ActionType, number>();
  const applied = new Map<ActionType, number>();
  let noops = 0;
  let overLimit = 0;
  let previewsSeen = 0;
  let diffsSeen = 0;
  let browserTabsInWindows = 0;
  const limit = maxPanes ?? DEFAULT_MAX_PANES;

  fc.assert(
    fc.property(
      arbWorkspace({
        ...(maxPanes === undefined ? {} : { maxPanes }),
        ...(kinds.browserPanes === true ? { browserPanes: true } : {}),
        ...(kinds.previewPanes === true ? { previewPanes: true } : {}),
        ...(kinds.diffPanes === true ? { diffPanes: true } : {}),
        ...(kinds.windows === true ? { windows: true } : {}),
      }),
      fc.gen(),
      (initial, gen) => {
        for (const space of initial.spaces) {
          for (const item of Object.values(space.items)) {
            previewsSeen += layoutPanes(item.layout).filter((p) => p.type === "preview").length;
            diffsSeen += layoutPanes(item.layout).filter((p) => p.type === "diff").length;
          }
        }
        const { ctx: base, clock } = testContext();
        const ctx = maxPanes === undefined ? base : { ...base, maxPanes };
        let ws = deepFreeze(initial);
        for (let step = 0; step < STEPS; step++) {
          clock.advance(1);
          // A closure, not `gen(arbAction, ws)`: fast-check works over every extra argument of
          // `gen` on each call, which made 150 runs of 200 steps take 90 s instead of 3 s.
          const state = ws;
          const action = gen(() => arbAction(state));
          const where = (): string => `step ${step}, ${JSON.stringify(action)}`;
          // Strict reducer on a frozen state: a throw or a mutation fails the property.
          const next = reduceStrict(ws, action, ctx);

          const violations = checkInvariants(next, { maxPanes: limit });
          if (violations.length > 0) {
            throw new Error(
              `${where()}: ${violations.map((v) => `${v.code} at ${v.path}`).join("; ")}`,
            );
          }

          // Sessions only leave with a closed item or pane, or a deleted space, and none appears,
          // except the one a new tab is made around (`item/create` with a `sessionId`), which no
          // pane may hold already: asking for one that is held changes nothing.
          const before = liveSessionIds(ws);
          const after = liveSessionIds(next);
          const ended = sessionsEndedBy(ws, action);
          const adopted = action.type === "item/create" ? action.sessionId : undefined;
          for (const id of after) {
            if (!before.has(id) && id !== adopted) {
              throw new Error(`${where()}: session ${id} appeared`);
            }
          }
          if (adopted !== undefined && before.has(adopted) && next !== ws) {
            throw new Error(`${where()}: a session held by a pane was given to a second one`);
          }
          for (const id of before) {
            if (!after.has(id) && !ended.has(id)) {
              throw new Error(`${where()}: session ${id} vanished`);
            }
          }
          // Whatever the reducer closes or archives keeps no session.
          const keptEntries = new Set<object>([...ws.closed, ...ws.archive]);
          for (const entry of [...next.closed, ...next.archive]) {
            if (keptEntries.has(entry)) continue;
            for (const pane of layoutPanes(entry.item.layout)) {
              if (pane.sessionId !== undefined)
                throw new Error(`${where()}: closed item has a session`);
            }
          }
          // An action on something that does not exist changes nothing.
          if (missingTarget(ws, action) && next !== ws) {
            throw new Error(`${where()}: unknown target changed the workspace`);
          }
          // A split that would pass the limit changes nothing either.
          if (action.type === "pane/split" && hasPane(ws, action.itemId, action.paneId)) {
            const item = itemOf(ws, action.itemId);
            const count = item ? layoutPanes(item.layout).length : 0;
            if (count + 1 > limit) {
              overLimit++;
              if (next !== ws) throw new Error(`${where()}: split passed maxPanes`);
            }
          }
          checkImport(ws, next, action, limit, where);
          checkReimport(ws, next, action, limit, where);
          if (next !== ws) checkPaneDelta(ws, next, action, where);
          if (next !== ws) checkOrigin(ws, next, action, where);
          if (next !== ws) checkFavoriteLinks(ws, next, action, where);
          if (next !== ws) checkActiveItems(ws, next, action, where);
          if (next !== ws) checkNothingUnreadOnScreen(next, where);
          if (next !== ws) checkWindows(ws, next, action, where);
          if (next === ws) checkNoTabRefusedForItsPanes(ws, action, where);
          if (
            next !== ws &&
            (action.type === "window/move-item" || action.type === "window/open-with-item")
          ) {
            const moved = itemOf(ws, action.itemId);
            if (
              moved !== undefined &&
              layoutPanes(moved.layout).some((p) => p.type === "browser")
            ) {
              browserTabsInWindows++;
            }
          }

          generated.set(action.type, (generated.get(action.type) ?? 0) + 1);
          if (next === ws) {
            noops++;
          } else {
            applied.set(action.type, (applied.get(action.type) ?? 0) + 1);
          }
          ws = deepFreeze(next);
        }
      },
    ),
    { numRuns, seed },
  );

  return {
    generated: Object.fromEntries(generated),
    applied: Object.fromEntries(applied),
    noops,
    overLimit,
    previewsSeen,
    diffsSeen,
    browserTabsInWindows,
  };
}

/** Plays the sequences of `play` and checks they covered what the property is about. */
function playSequences(
  numRuns: number,
  maxPanes?: number,
  kinds: Kinds = {},
  seed: number = SEED,
): Played {
  const played = play(numRuns, maxPanes, kinds, seed);
  // The sequences must exercise every action for real, and the invalid paths too. Each check names
  // the seed, so a failure is played again with NOREN_PROPERTY_SEED.
  const why = `seed ${seed}`;
  const neverApplied = TYPES.filter((type) => (played.applied[type] ?? 0) === 0);
  expect(neverApplied, why).toEqual([]);
  expect(played.noops, why).toBeGreaterThan(0);
  expect(played.overLimit, why).toBeGreaterThan(0);
  expect(
    Object.values(played.generated).reduce((sum, n) => sum + n, 0),
    why,
  ).toBe(numRuns * STEPS);
  // A run asked to have preview panes must have had them to play with.
  if (kinds.previewPanes === true) expect(played.previewsSeen, why).toBeGreaterThan(0);
  if (kinds.diffPanes === true) expect(played.diffsSeen, why).toBeGreaterThan(0);
  // A run with windows and browser panes must have taken a tab with a browser pane to a window.
  if (kinds.windows === true && kinds.browserPanes === true) {
    expect(played.browserTabsInWindows, why).toBeGreaterThan(0);
  }
  return played;
}

describe("reducer properties", () => {
  // About 4 s on a quiet machine, near the 5 s default: a loaded runner must not turn it flaky.
  it(
    `property: ${STEPS} random actions keep every invariant (${NUM_RUNS} runs)`,
    () => {
      playSequences(NUM_RUNS);
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces with browser panes",
    () => {
      playSequences(SMALL_RUNS, undefined, { browserPanes: true });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces with preview panes",
    () => {
      playSequences(SMALL_RUNS, undefined, { previewPanes: true });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces with browser and preview panes",
    () => {
      playSequences(SMALL_RUNS, undefined, { browserPanes: true, previewPanes: true });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces with diff panes",
    () => {
      playSequences(SMALL_RUNS, undefined, { diffPanes: true });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces with browser, preview and diff panes",
    () => {
      playSequences(SMALL_RUNS, undefined, {
        browserPanes: true,
        previewPanes: true,
        diffPanes: true,
      });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces that already have windows",
    () => {
      playSequences(SMALL_RUNS, undefined, { windows: true, browserPanes: true });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it(
    "property: sequences keep every invariant on workspaces with windows and browser, preview and diff panes",
    () => {
      playSequences(SMALL_RUNS, undefined, {
        windows: true,
        browserPanes: true,
        previewPanes: true,
        diffPanes: true,
      });
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it.each([2, 6])(
    "property: sequences keep every invariant with maxPanes %i",
    (maxPanes) => {
      playSequences(SMALL_RUNS, maxPanes);
    },
    SEQUENCE_TIMEOUT_MS,
  );

  it("property: the same seed plays the same sequences, another seed plays others", () => {
    const kinds = { browserPanes: true, previewPanes: true, diffPanes: true, windows: true };
    const first = play(3, undefined, kinds, 1234);
    expect(play(3, undefined, kinds, 1234)).toEqual(first);
    expect(play(3, undefined, kinds, 4321)).not.toEqual(first);
  });

  it("property: input that is not an action never throws and never breaks the invariants", () => {
    const keys = [
      "spaceId",
      "itemId",
      "groupId",
      "parentGroupId",
      "name",
      "title",
      "color",
      "icon",
      "index",
      "items",
      "itemIds",
      "placement",
      "collapsed",
      "source",
      "profileId",
      "cwd",
      "url",
      "activate",
    ] as const;
    fc.assert(
      fc.property(
        arbWorkspace(),
        fc.constantFrom(...TYPES, "nope"),
        fc.dictionary(fc.constantFrom(...keys), fc.anything()),
        (ws, type, fields) => {
          const { ctx } = testContext();
          const action = { ...fields, type } as unknown as Action;
          const next = reduce(deepFreeze(ws), action, ctx);
          expect(checkInvariants(next)).toEqual([]);
        },
      ),
      { numRuns: 500, seed: SEED },
    );
  });
});

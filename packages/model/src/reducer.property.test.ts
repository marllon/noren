import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbAction } from "./action-arbitraries";
import type { Action, ActionType } from "./actions";
import { arbWorkspace } from "./arbitraries";
import { checkInvariants } from "./invariants";
import { reduce, reduceStrict } from "./reducer";
import { layoutPanes, liveSessionIds } from "./sessions";
import { shownItem, visiblePanes } from "./unread";
import { deepFreeze, testContext } from "./test-helpers";
import { treeGroups } from "./tree";
import { DEFAULT_MAX_PANES, type Id, type Item, type Workspace } from "./types";

/** One key per action type: the compiler fails here when a new action is not listed. */
const ACTION_TYPES: Record<ActionType, true> = {
  "space/create": true,
  "space/rename": true,
  "space/set-color": true,
  "space/set-icon": true,
  "space/set-theme": true,
  "space/set-defaults": true,
  "space/move": true,
  "space/activate": true,
  "space/set-active-item": true,
  "space/delete": true,
  "item/create": true,
  "item/close": true,
  "item/reopen": true,
  "item/rename": true,
  "item/move": true,
  "item/pin": true,
  "item/unpin": true,
  "item/reset": true,
  "item/favorite": true,
  "item/unfavorite": true,
  "group/create": true,
  "group/create-from-selection": true,
  "group/ungroup": true,
  "group/move": true,
  "group/set-collapsed": true,
  "group/rename": true,
  "group/set-color": true,
  "pane/split": true,
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
  "pane/command-start": true,
  "pane/command-end": true,
  "pane/notify": true,
  "pane/clear-unread": true,
};
const TYPES = Object.keys(ACTION_TYPES) as ActionType[];

const STEPS = 200;
const NUM_RUNS = 150;
/** Runs of the sequences with a non-default `maxPanes`. */
const SMALL_RUNS = 50;
const SEQUENCE_TIMEOUT_MS = 60_000;

/** Actions whose effect on the panes `checkPaneDelta` knows. */
const PANE_ACTIONS = new Set<ActionType>([
  "pane/split",
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
  "pane/command-start",
  "pane/command-end",
  "pane/notify",
  "pane/clear-unread",
]);

const itemIdsOf = (ws: Workspace): Set<Id> =>
  new Set(ws.spaces.flatMap((space) => Object.keys(space.items)));
const itemOf = (ws: Workspace, itemId: Id): Item | undefined =>
  ws.spaces.flatMap((space) => Object.values(space.items)).find((item) => item.id === itemId);
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
    if (action.type === "item/close" && Object.hasOwn(space.items, action.itemId)) {
      collect(Object.values(space.items).filter((item) => item.id === action.itemId));
    } else if (
      action.type === "space/delete" &&
      action.items.mode === "close" &&
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
    case "space/set-defaults":
    case "space/move":
    case "space/activate":
    case "space/delete":
      return !ws.spaces.some((space) => space.id === action.spaceId);
    case "space/set-active-item":
      return !ws.spaces.some(
        (space) => space.id === action.spaceId && Object.hasOwn(space.items, action.itemId),
      );
    case "item/close":
    case "item/rename":
    case "item/move":
    case "item/pin":
    case "item/unpin":
    case "item/reset":
    case "item/favorite":
      return !itemIdsOf(ws).has(action.itemId);
    case "item/unfavorite":
      return !ws.favorites.includes(action.itemId);
    case "group/ungroup":
    case "group/move":
    case "group/set-collapsed":
    case "group/rename":
    case "group/set-color":
      return !groupIdsOf(ws).has(action.groupId);
    case "pane/split":
    case "pane/close":
    case "pane/detach":
    case "pane/focus":
    case "pane/set-status":
    case "pane/set-location":
    case "pane/command-start":
    case "pane/command-end":
    case "pane/notify":
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
    if (action.type === "item/create" || action.type === "item/reopen") {
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
    case "pane/set-status":
    case "pane/set-location":
    case "pane/command-start":
    case "pane/command-end":
    case "pane/notify":
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

/** The panes the active space shows are not unread, whatever the action that just ran. */
function checkNothingUnreadOnScreen(ws: Workspace, where: () => string): void {
  const space = ws.spaces.find((s) => s.id === ws.activeSpaceId);
  const item = space && shownItem(space);
  if (item && visiblePanes(item).some((pane) => pane.unread || pane.bell)) {
    throw new Error(`${where()}: a pane on screen is unread`);
  }
}

/**
 * Plays `STEPS` random actions per run on random workspaces. `maxPanes` goes both to the
 * generated workspaces and to the reducer; absent means the default of 4.
 */
function playSequences(numRuns: number, maxPanes?: number): void {
  const generated = new Map<ActionType, number>();
  const applied = new Map<ActionType, number>();
  let noops = 0;
  let overLimit = 0;
  const limit = maxPanes ?? DEFAULT_MAX_PANES;

  fc.assert(
    fc.property(
      arbWorkspace(maxPanes === undefined ? {} : { maxPanes }),
      fc.gen(),
      (initial, gen) => {
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

          // Sessions only leave with a closed item or pane, or a deleted space, and none appears.
          const before = liveSessionIds(ws);
          const after = liveSessionIds(next);
          const ended = sessionsEndedBy(ws, action);
          for (const id of after) {
            if (!before.has(id)) throw new Error(`${where()}: session ${id} appeared`);
          }
          for (const id of before) {
            if (!after.has(id) && !ended.has(id)) {
              throw new Error(`${where()}: session ${id} vanished`);
            }
          }
          // Whatever the reducer closes keeps no session.
          for (const entry of next.closed) {
            if (ws.closed.includes(entry)) continue;
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
          if (next !== ws) checkPaneDelta(ws, next, action, where);
          if (next !== ws) checkOrigin(ws, next, action, where);
          if (next !== ws) checkActiveItems(ws, next, action, where);
          if (next !== ws) checkNothingUnreadOnScreen(next, where);

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
    { numRuns },
  );

  // The sequences must exercise every action for real, and the invalid paths too.
  const neverApplied = TYPES.filter((type) => (applied.get(type) ?? 0) === 0);
  expect(neverApplied).toEqual([]);
  expect(noops).toBeGreaterThan(0);
  expect(overLimit).toBeGreaterThan(0);
  expect([...generated.values()].reduce((sum, n) => sum + n, 0)).toBe(numRuns * STEPS);
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

  it.each([2, 6])(
    "property: sequences keep every invariant with maxPanes %i",
    (maxPanes) => {
      playSequences(SMALL_RUNS, maxPanes);
    },
    SEQUENCE_TIMEOUT_MS,
  );

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
      { numRuns: 500 },
    );
  });
});

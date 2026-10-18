import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { arbAction } from "./action-arbitraries";
import type { Action, ActionType } from "./actions";
import { arbWorkspace } from "./arbitraries";
import { checkInvariants } from "./invariants";
import { reduce, reduceStrict } from "./reducer";
import { layoutPanes, liveSessionIds } from "./sessions";
import { deepFreeze, testContext } from "./test-helpers";
import { treeGroups } from "./tree";
import type { Id, Item, Workspace } from "./types";

/** One key per action type: the compiler fails here when a new action is not listed. */
const ACTION_TYPES: Record<ActionType, true> = {
  "space/create": true,
  "space/rename": true,
  "space/set-color": true,
  "space/set-icon": true,
  "space/move": true,
  "space/activate": true,
  "space/delete": true,
  "item/create": true,
  "item/close": true,
  "item/reopen": true,
  "item/rename": true,
  "item/move": true,
  "item/pin": true,
  "item/unpin": true,
  "item/favorite": true,
  "item/unfavorite": true,
  "group/create": true,
  "group/create-from-selection": true,
  "group/ungroup": true,
  "group/set-collapsed": true,
  "group/rename": true,
  "group/set-color": true,
};
const TYPES = Object.keys(ACTION_TYPES) as ActionType[];

const STEPS = 200;
const NUM_RUNS = 150;

const itemIdsOf = (ws: Workspace): Set<Id> =>
  new Set(ws.spaces.flatMap((space) => Object.keys(space.items)));
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
    case "space/move":
    case "space/activate":
    case "space/delete":
      return !ws.spaces.some((space) => space.id === action.spaceId);
    case "item/close":
    case "item/rename":
    case "item/move":
    case "item/pin":
    case "item/unpin":
    case "item/favorite":
      return !itemIdsOf(ws).has(action.itemId);
    case "item/unfavorite":
      return !ws.favorites.includes(action.itemId);
    case "group/ungroup":
    case "group/set-collapsed":
    case "group/rename":
    case "group/set-color":
      return !groupIdsOf(ws).has(action.groupId);
    default:
      return false;
  }
}

describe("reducer properties", () => {
  it(`property: ${STEPS} random actions keep every invariant (${NUM_RUNS} runs)`, () => {
    const generated = new Map<ActionType, number>();
    const applied = new Map<ActionType, number>();
    let noops = 0;

    fc.assert(
      fc.property(arbWorkspace(), fc.gen(), (initial, gen) => {
        const { ctx, clock } = testContext();
        let ws = deepFreeze(initial);
        for (let step = 0; step < STEPS; step++) {
          clock.advance(1);
          // A closure, not `gen(arbAction, ws)`: fast-check works over every extra argument of
          // `gen` on each call, which made 150 runs of 200 steps take 90 s instead of 3 s.
          const state = ws;
          const action = gen(() => arbAction(state));
          const where = `step ${step}, ${JSON.stringify(action)}`;
          // Strict reducer on a frozen state: a throw or a mutation fails the property.
          const next = reduceStrict(ws, action, ctx);

          const violations = checkInvariants(next);
          if (violations.length > 0) {
            throw new Error(
              `${where}: ${violations.map((v) => `${v.code} at ${v.path}`).join("; ")}`,
            );
          }

          // Sessions only leave with a closed item or a deleted space, and none appears.
          const before = liveSessionIds(ws);
          const after = liveSessionIds(next);
          const ended = sessionsEndedBy(ws, action);
          for (const id of after) {
            if (!before.has(id)) throw new Error(`${where}: session ${id} appeared`);
          }
          for (const id of before) {
            if (!after.has(id) && !ended.has(id)) {
              throw new Error(`${where}: session ${id} vanished`);
            }
          }
          // Whatever the reducer closes keeps no session.
          for (const entry of next.closed) {
            if (ws.closed.includes(entry)) continue;
            for (const pane of layoutPanes(entry.item.layout)) {
              if (pane.sessionId !== undefined)
                throw new Error(`${where}: closed item has a session`);
            }
          }
          // An action on something that does not exist changes nothing.
          if (missingTarget(ws, action) && next !== ws) {
            throw new Error(`${where}: unknown target changed the workspace`);
          }

          generated.set(action.type, (generated.get(action.type) ?? 0) + 1);
          if (next === ws) {
            noops++;
          } else {
            applied.set(action.type, (applied.get(action.type) ?? 0) + 1);
          }
          ws = deepFreeze(next);
        }
      }),
      { numRuns: NUM_RUNS },
    );

    // The sequences must exercise every action for real, and the invalid paths too.
    const neverApplied = TYPES.filter((type) => (applied.get(type) ?? 0) === 0);
    expect(neverApplied).toEqual([]);
    expect(noops).toBeGreaterThan(0);
    expect([...generated.values()].reduce((sum, n) => sum + n, 0)).toBe(NUM_RUNS * STEPS);
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

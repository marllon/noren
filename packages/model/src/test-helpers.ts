import type { ReducerContext } from "./actions";
import { ManualClock } from "./clock";
import { createSequentialIds } from "./ids";
import { checkInvariants } from "./invariants";
import { reduceStrict } from "./reducer";
import type { Action } from "./actions";
import type { Pane, Workspace } from "./types";

// Shared by the reducer tests. Not part of the public API.

/**
 * Context for tests: ids `n1`, `n2`, ... (the fixtures use other prefixes, so they never collide)
 * and a clock that starts at 1000.
 */
export function testContext(): { ctx: ReducerContext; clock: ManualClock } {
  const clock = new ManualClock();
  clock.advance(1000);
  return { ctx: { newId: createSequentialIds("n"), clock }, clock };
}

/** Freezes the value and everything under it, so any mutation throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Applies the action with the strict reducer on a frozen input and checks the invariants. */
export function applyChecked(
  ws: Workspace,
  action: Action,
  ctx: ReducerContext = testContext().ctx,
): Workspace {
  const next = reduceStrict(deepFreeze(ws), action, ctx);
  const violations = checkInvariants(next);
  if (violations.length > 0) {
    throw new Error(
      `${action.type} broke invariants: ${violations.map((v) => `${v.code} at ${v.path}`).join("; ")}`,
    );
  }
  return next;
}

export function pane(id: string, sessionId?: string): Pane {
  return {
    id,
    type: "terminal",
    ...(sessionId !== undefined ? { sessionId } : {}),
    profileId: "bash",
    status: "running",
    unread: false,
    bell: false,
  };
}

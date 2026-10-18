import type { Id } from "./types";

/** Source of fresh ids. Injected so the model stays deterministic and free of randomness. */
export type IdGenerator = () => Id;

/**
 * Deterministic generator (`prefix1`, `prefix2`, ...). For tests and fixtures: it restarts at 1 on
 * every call, so the app must pass a generator that stays unique across restarts.
 */
export function createSequentialIds(prefix = "id"): IdGenerator {
  let next = 1;
  return () => `${prefix}${next++}`;
}

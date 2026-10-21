import type { SyncStatus } from "./sync";

// The push when the app closes (NOR-F19-01d): `sync.pushOnClose` of `config.jsonc`, off unless the
// file says so, and the one place that decides whether closing the app pushes. Pure: the interface
// reads the status and writes the space files, this only answers what to do with them.

/** `sync.pushOnClose` when the settings file does not say: closing the app never pushes. */
export const DEFAULT_PUSH_ON_CLOSE = false;

/**
 * Whether closing the app pushes, from the `sync` section of the settings: it does only when
 * `sync.pushOnClose` is `true`.
 */
export function pushOnCloseAllowed(
  sync: { pushOnClose?: boolean | undefined } | undefined,
): boolean {
  return sync?.pushOnClose ?? DEFAULT_PUSH_ON_CLOSE;
}

/** Why closing the app does not push. */
export type ClosePushSkip = "off" | "no-remote" | "nothing-pending";

export type ClosePushDecision = { action: "skip"; reason: ClosePushSkip } | { action: "push" };

/**
 * What the decision needs of the status of either method: a git status has `ahead` (commits waiting),
 * a gist status has none (a gist keeps no commits of its own here).
 */
export type ClosePushStatus = Pick<SyncStatus, "connected" | "pending"> & {
  ahead?: number | undefined;
};

export interface ClosePushFacts {
  /** `pushOnCloseAllowed` of the settings now. */
  enabled: boolean;
  /** Where the sync stands (read with no network); `undefined` when it could not be read. */
  status: ClosePushStatus | undefined;
  /** How many space files were written to the config folder just now (they are not in `status` yet). */
  spaceFilesWritten: number;
}

/**
 * What closing the app does about the sync: nothing when the option is off, when there is no remote
 * connected (or the status could not be read), or when nothing is waiting (no file of the config
 * folder differs from the clone, no commit waits to be sent and no space file was just written);
 * otherwise a push.
 */
export function closePushDecision(facts: ClosePushFacts): ClosePushDecision {
  if (!facts.enabled) return { action: "skip", reason: "off" };
  const status = facts.status;
  if (status === undefined || !status.connected) return { action: "skip", reason: "no-remote" };
  const waiting =
    status.pending.length > 0 || (status.ahead ?? 0) > 0 || facts.spaceFilesWritten > 0;
  return waiting ? { action: "push" } : { action: "skip", reason: "nothing-pending" };
}

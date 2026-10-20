import { keepSessionsAllowed } from "@noren/model";
import type { Backend, ConfigState, Unsubscribe } from "@noren/model";

// Hands `sessions.keepOnClose` of `config.jsonc` to the backend, because the Rust side decides what
// becomes of the shells when the app closes and it knows only what it was told. It runs once when the
// settings are first in force (before any shell is restored: the backend gives a pane its old shell
// back only when the settings keep sessions) and again whenever the file changes the value, so
// turning it off in the file or the settings screen ends the shells at the next close without a
// restart. A change to any other setting hands nothing over. A backend that refuses is never a reason
// to stop the app: it keeps what it had, which ends the shells as it always did.

/** What the sync needs of the settings manager. */
export interface ConfigFollowed {
  readonly state: ConfigState;
  subscribe(listener: () => void): Unsubscribe;
}

export interface KeepSessionsFollow {
  /** Resolves once every value handed over so far has been taken or refused. Never rejects. */
  settled(): Promise<void>;
  /** Stops following the settings. */
  stop(): void;
}

export function followKeepSessions(
  manager: ConfigFollowed,
  backend: Pick<Backend, "setKeepSessions">,
): KeepSessionsFollow {
  /** The value queued last; `undefined` while none is, or after the backend refused the last. */
  let queued: boolean | undefined;
  // The calls go one after the other, so an older value never lands after a newer one.
  let chain: Promise<void> = Promise.resolve();
  const push = () => {
    const keep = keepSessionsAllowed(manager.state.config.sessions);
    if (keep === queued) return;
    queued = keep;
    chain = chain.then(async () => {
      try {
        await backend.setKeepSessions(keep);
      } catch {
        // Not remembered, so the next change of the file tries the value again.
        if (queued === keep) queued = undefined;
      }
    });
  };
  push();
  const stop = manager.subscribe(push);
  return { settled: () => chain, stop };
}

import type { Backend } from "./backend";
import type { Clock } from "./clock";
import { serializeWorkspace } from "./state";
import type { Workspace } from "./types";

/** Quiet time after the last change before the state is written. */
export const STATE_SAVE_DELAY_MS = 500;

// This package has no DOM or Node typings; every runtime that loads it provides these globals.
declare function setTimeout(callback: () => void, delayMs: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** Timers on the global `setTimeout`, looked up at call time so fake timers in tests apply. */
const globalTimers: Pick<Clock, "setTimer"> = {
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface StateWriterOptions {
  backend: Pick<Backend, "saveState">;
  /** Defaults to `STATE_SAVE_DELAY_MS` (500). */
  delayMs?: number;
  /** Defaults to the global `setTimeout`. */
  clock?: Pick<Clock, "setTimer">;
  /** Told when a write started by the timer fails (a failed `flush` rejects instead). */
  onError?: (error: unknown) => void;
}

/**
 * Debounced writer of `state.json`. Every `schedule` restarts the wait; when it ends, only the
 * newest workspace is serialized and saved, so a burst of changes is one write. Writes never
 * overlap: each one starts after the previous one finished.
 */
export class StateWriter {
  readonly #backend: Pick<Backend, "saveState">;
  readonly #delayMs: number;
  readonly #timers: Pick<Clock, "setTimer">;
  readonly #onError: (error: unknown) => void;
  #latest: Workspace | undefined;
  #cancelTimer: (() => void) | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(options: StateWriterOptions) {
    this.#backend = options.backend;
    this.#delayMs = options.delayMs ?? STATE_SAVE_DELAY_MS;
    this.#timers = options.clock ?? globalTimers;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** True while a change waits for its write. */
  get pending(): boolean {
    return this.#latest !== undefined;
  }

  /** Notes the newest workspace and restarts the wait. */
  schedule(ws: Workspace): void {
    this.#latest = ws;
    this.#cancelTimer?.();
    this.#cancelTimer = this.#timers.setTimer(() => {
      this.#cancelTimer = undefined;
      this.#write().catch(this.#onError);
    }, this.#delayMs);
  }

  /** Writes the waiting change now (if any) and resolves when every write so far has finished. */
  async flush(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    await this.#write();
    await this.#chain;
  }

  /** Forgets the waiting change without writing it. A write already started is not stopped. */
  cancel(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#latest = undefined;
  }

  #write(): Promise<void> {
    const ws = this.#latest;
    if (ws === undefined) return this.#chain;
    this.#latest = undefined;
    const content = serializeWorkspace(ws);
    const run = this.#chain.then(() => this.#backend.saveState(content));
    // The chain keeps going after a failure; the caller of this write still sees the error.
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

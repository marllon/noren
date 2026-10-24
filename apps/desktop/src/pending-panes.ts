import type { Id } from "@noren/model";
import { useSyncExternalStore } from "react";

// The panes whose shell the restore left for later (NOR-F20-14a). A start with a hundred saved tabs
// used to start a hundred shells, one after the other, and mount a hundred terminals before the first
// prompt showed. Now only the tab on screen is started and mounted first; the shells of the other tabs
// are started in the background once the first prompt is on screen, and the terminal of a tab mounts
// when its shell is there (it is given everything the shell printed meanwhile: the output is held
// until a terminal subscribes). A tab the person opens before its turn jumps the queue.

/** How many shells the window starts at once in the background (measured, see `docs/PERF.md`). */
const START_CONCURRENCY = 12;

type Starter = (paneId: Id) => Promise<void>;

/** The queue of the panes waiting for their shell. */
export class PendingPanes {
  #waiting = new Set<Id>();
  #queue: Id[] = [];
  #urgent = new Set<Id>();
  #released = false;
  #held = false;
  #releaseAsked = false;
  #active = 0;
  readonly #concurrency: number;
  #listeners = new Set<() => void>();
  #settled = new Set<() => void>();
  #start: Starter = () => Promise.resolve();

  /**
   * `concurrency` is how many shells may be starting at once: the daemon makes one after the other,
   * but the page mounts the terminal of one while the next is being made.
   */
  constructor(concurrency = 1) {
    this.#concurrency = Math.max(1, concurrency);
  }

  /**
   * Takes the panes to start (in the order to start them) and the function that starts one. It must
   * settle the pane itself (a failure is a pane that shows as exited); an error it throws is dropped
   * and the pane stops waiting. Nothing starts before `release`, except a pane `prioritize` asked for.
   */
  load(ids: readonly Id[], start: Starter): void {
    this.#waiting = new Set(ids);
    this.#queue = [...ids];
    this.#urgent.clear();
    this.#released = false;
    this.#start = start;
    this.#notify();
  }

  /** Whether the pane is still waiting for its shell (its terminal is not mounted yet). */
  waiting(paneId: Id): boolean {
    return this.#waiting.has(paneId);
  }

  /** Whether a person waits for this pane (its tab was opened before its turn). */
  urgent(paneId: Id): boolean {
    return this.#urgent.has(paneId);
  }

  /** How many panes are still waiting. */
  get count(): number {
    return this.#waiting.size;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Lets the queue run: the first prompt is on screen, so the other shells can start. */
  release(): void {
    if (this.#held) {
      this.#releaseAsked = true;
      return;
    }
    this.#released = true;
    this.#pump();
  }

  /**
   * Keeps `release` from running the queue until `unhold`, so a test can look at the window while
   * the tabs wait. A pane asked for with `prioritize` still starts.
   */
  hold(): void {
    this.#held = true;
  }

  /** Ends `hold`; a `release` that came meanwhile runs now. */
  unhold(): void {
    this.#held = false;
    if (this.#releaseAsked) {
      this.#releaseAsked = false;
      this.release();
    }
  }

  /**
   * Calls `callback` once, when no pane waits any more: now if none does. This is the moment every
   * pane has had its shell, so what the daemon still holds belongs to no pane.
   */
  whenSettled(callback: () => void): void {
    if (this.#waiting.size === 0) callback();
    else this.#settled.add(callback);
  }

  /** Starts these panes next, whether or not the queue was released: a person is about to look at them. */
  prioritize(paneIds: readonly Id[]): void {
    let any = false;
    for (const id of paneIds) {
      if (this.#waiting.has(id)) {
        this.#urgent.add(id);
        any = true;
      }
    }
    if (any) this.#pump();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #next(): Id | undefined {
    const urgent = this.#queue.findIndex((id) => this.#urgent.has(id));
    const at = urgent >= 0 ? urgent : this.#released && this.#queue.length > 0 ? 0 : -1;
    if (at < 0) return undefined;
    return this.#queue.splice(at, 1)[0];
  }

  /** Starts panes while fewer than `concurrency` are being started. */
  #pump(): void {
    while (this.#active < this.#concurrency) {
      const id = this.#next();
      if (id === undefined) return;
      this.#active++;
      void this.#run(id);
    }
  }

  async #run(id: Id): Promise<void> {
    try {
      await this.#start(id);
    } catch {
      // The starter settles its own failures; whatever escaped, the pane stops waiting.
    }
    this.#active--;
    this.#urgent.delete(id);
    this.#waiting.delete(id);
    this.#notify();
    if (this.#waiting.size === 0) {
      const callbacks = [...this.#settled];
      this.#settled.clear();
      for (const callback of callbacks) callback();
    }
    this.#pump();
  }
}

/** The queue of this window. */
export const pendingPanes = new PendingPanes(START_CONCURRENCY);

/** True while the pane has no shell yet because the restore left it for later. */
export function usePaneWaiting(paneId: Id): boolean {
  return useSyncExternalStore(
    (listener) => pendingPanes.subscribe(listener),
    () => pendingPanes.waiting(paneId),
  );
}

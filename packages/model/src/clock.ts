/** Time source injected into code that waits (the fake shell's `sleep`). */
export interface Clock {
  /** Milliseconds on the clock's own timeline. */
  now(): number;
  /** Runs `callback` once, `delayMs` from now. Returns a function that cancels it. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

interface Timer {
  readonly seq: number;
  readonly due: number;
  readonly callback: () => void;
}

/** A clock that only moves when `advance` is called. No real timers, so tests stay deterministic. */
export class ManualClock implements Clock {
  #now = 0;
  #seq = 0;
  #timers: Timer[] = [];

  now(): number {
    return this.#now;
  }

  /** Number of timers that did not fire or get cancelled yet. */
  get pending(): number {
    return this.#timers.length;
  }

  setTimer(callback: () => void, delayMs: number): () => void {
    const timer: Timer = {
      seq: this.#seq++,
      due: this.#now + Math.max(0, delayMs),
      callback,
    };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((t) => t !== timer);
    };
  }

  /** Moves time forward and fires, in order, every timer that became due (also ones they schedule). */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const timer of this.#timers) {
        if (
          timer.due <= target &&
          (!next || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq))
        ) {
          next = timer;
        }
      }
      if (!next) break;
      this.#timers = this.#timers.filter((t) => t !== next);
      this.#now = Math.max(this.#now, next.due);
      next.callback();
    }
    this.#now = target;
  }
}

import type { Id } from "@noren/model";

// When the peek of a tab opens and closes. It opens when the pointer has stayed on a tab for
// `PEEK_DELAY_MS`, and closes when the pointer leaves, a button is pressed, Escape is pressed or a
// drag starts; no peek opens while a drag is under way. The timer is injected, so the tests move
// time by hand. Pure: it does not know React, the DOM or what the peek shows.

/** How long the pointer stays on a tab before its peek opens, in milliseconds. */
export const PEEK_DELAY_MS = 400;

/** The timer the controller waits with; the page's `setTimeout` and `clearTimeout` by default. */
export interface PeekTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realPeekTimers: PeekTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PeekControllerOptions {
  /** The pointer waited long enough on this tab: its peek is due. */
  onShow(itemId: Id): void;
  /** The peek that was shown (or being prepared) is over. */
  onHide(): void;
  delayMs?: number;
  timers?: PeekTimers;
}

export class PeekController {
  private readonly delayMs: number;
  private readonly timers: PeekTimers;
  private waiting: { itemId: Id; handle: unknown } | undefined;
  private current: Id | undefined;
  private dragging = false;

  constructor(private readonly options: PeekControllerOptions) {
    this.delayMs = options.delayMs ?? PEEK_DELAY_MS;
    this.timers = options.timers ?? realPeekTimers;
  }

  /** The tab whose peek is up now (after `onShow`, until the next close). */
  get shown(): Id | undefined {
    return this.current;
  }

  /** The pointer entered a tab: its peek is due after the delay. */
  enter(itemId: Id): void {
    if (this.dragging) return;
    if (this.current === itemId) return;
    this.close();
    this.wait(itemId);
  }

  /** The pointer moved on a tab: it is not still, so the wait starts again (an open peek stays). */
  move(itemId: Id): void {
    if (this.dragging || this.current === itemId) return;
    if (this.current !== undefined) this.close();
    this.wait(itemId);
  }

  /** The pointer left a tab; leaving another tab than the one waited for or shown changes nothing. */
  leave(itemId: Id): void {
    if (this.current === itemId || this.waiting?.itemId === itemId) this.close();
  }

  /** A click, a key, a scroll or the tab disappearing: whatever is up or due is dropped. */
  close(): void {
    this.cancelWait();
    if (this.current !== undefined) {
      this.current = undefined;
      this.options.onHide();
    }
  }

  /** A drag started: nothing is shown or due until it ends. */
  dragStart(): void {
    this.dragging = true;
    this.close();
  }

  /** The drag ended or was cancelled. A peek comes only after the pointer moves again. */
  dragEnd(): void {
    this.dragging = false;
  }

  /** The view is going away. */
  dispose(): void {
    this.cancelWait();
    this.current = undefined;
  }

  private wait(itemId: Id): void {
    this.cancelWait();
    const handle = this.timers.set(() => {
      if (this.waiting?.handle !== handle) return;
      this.waiting = undefined;
      this.current = itemId;
      this.options.onShow(itemId);
    }, this.delayMs);
    this.waiting = { itemId, handle };
  }

  private cancelWait(): void {
    if (this.waiting === undefined) return;
    this.timers.clear(this.waiting.handle);
    this.waiting = undefined;
  }
}

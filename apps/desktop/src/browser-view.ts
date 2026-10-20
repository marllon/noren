import type { Backend, BrowserBounds, Id } from "@noren/model";

// The web view of one browser pane. The page is drawn by a native web view that the shell lays over
// the window (`browser_pane.rs`), so it covers whatever HTML is under it and nothing in the page's
// stacking order can put a dialog over it. `BrowserPaneView` is what keeps it where the pane is:
//
// - it opens the web view the first time the pane is shown, not before (a tab nobody looked at
//   costs nothing),
// - it follows the bounds of the pane,
// - while the pane is out of view (another tab or space, hidden by the zoom of another pane, a
//   dialog or menu over the window) the web view is kept at zero size: the contract has no hide
//   call, and a view with no area draws nothing and keeps its page, scroll and form,
// - it closes the web view for good when the pane goes away.
//
// The calls to the shell are asynchronous and the shell does not run them in the order they were
// sent (each command is its own task), so they are made one at a time, and a burst of changes
// collapses into the last one: only what is wanted now is sent.

/** The calls of `Backend` this uses. */
export type BrowserViewBackend = Pick<
  Backend,
  "openBrowserPane" | "navigateBrowserPane" | "setBrowserPaneBounds" | "closeBrowserPane"
>;

/** What the pane wants to show: the page, and where, or `undefined` while it is out of view. */
export interface BrowserViewWish {
  url: string;
  bounds: BrowserBounds | undefined;
}

/** The bounds of a web view that is out of view: where it was, with no area. */
export function hiddenBounds(bounds: BrowserBounds): BrowserBounds {
  return { x: bounds.x, y: bounds.y, width: 0, height: 0 };
}

/** Whether `bounds` is the place of a web view that draws nothing. */
export function isHiddenBounds(bounds: BrowserBounds): boolean {
  return bounds.width === 0 || bounds.height === 0;
}

function sameBounds(a: BrowserBounds, b: BrowserBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function wishKey(wish: BrowserViewWish): string {
  const { bounds } = wish;
  return `${wish.url}|${bounds === undefined ? "hidden" : `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`}`;
}

/** The sentence of an error of the shell. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BrowserPaneView {
  readonly #backend: BrowserViewBackend;
  readonly #paneId: Id;
  readonly #onProblem: ((problem: string | undefined) => void) | undefined;
  #wish: BrowserViewWish | undefined;
  #closing = false;
  /** An open was tried: the shell may hold a web view for this pane. */
  #touched = false;
  /** What the web view is at now, once it is open. */
  #at: { url: string; bounds: BrowserBounds } | undefined;
  /** The wish the shell refused: it is not tried again until the wish changes. */
  #refused: string | undefined;
  #running = false;

  constructor(
    backend: BrowserViewBackend,
    paneId: Id,
    onProblem?: (problem: string | undefined) => void,
  ) {
    this.#backend = backend;
    this.#paneId = paneId;
    this.#onProblem = onProblem;
  }

  /** The pane wants to show `wish`. The last wish is the one that counts. */
  want(wish: BrowserViewWish): void {
    if (this.#closing) return;
    this.#wish = { url: wish.url, bounds: wish.bounds && { ...wish.bounds } };
    void this.#run();
  }

  /** The pane is gone: the web view is closed, and the pane never shows a page again. */
  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    void this.#run();
  }

  /** Resolves when everything asked for so far has reached the shell. */
  async settled(): Promise<void> {
    while (this.#running) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (;;) {
        const step = this.#next();
        if (step === undefined) return;
        try {
          await step();
        } catch (error) {
          this.#refuse(error);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** The next call the shell needs to match the wish, or `undefined` when it matches. */
  #next(): (() => Promise<void>) | undefined {
    if (this.#closing) {
      if (!this.#touched) return undefined;
      return async () => {
        this.#touched = false;
        this.#at = undefined;
        // The pane is gone whatever the shell answers: there is nobody left to tell.
        await this.#backend.closeBrowserPane(this.#paneId).catch(() => undefined);
      };
    }
    const wish = this.#wish;
    if (wish === undefined || wishKey(wish) === this.#refused) return undefined;
    const at = this.#at;
    if (at === undefined) {
      const { bounds } = wish;
      // Never shown: nothing to open yet.
      if (bounds === undefined) return undefined;
      return async () => {
        this.#touched = true;
        // A page that was reloaded leaves the web views of its panes in the shell. Starting from
        // no view makes this the one view of the pane (closing a pane without one is not an error).
        await this.#backend.closeBrowserPane(this.#paneId);
        await this.#backend.openBrowserPane(this.#paneId, wish.url, bounds);
        this.#at = { url: wish.url, bounds };
        this.#settle();
      };
    }
    if (wish.url !== at.url) {
      return async () => {
        await this.#backend.navigateBrowserPane(this.#paneId, wish.url);
        at.url = wish.url;
        this.#settle();
      };
    }
    const bounds = wish.bounds ?? hiddenBounds(at.bounds);
    if (sameBounds(bounds, at.bounds)) return undefined;
    return async () => {
      await this.#backend.setBrowserPaneBounds(this.#paneId, bounds);
      at.bounds = bounds;
      this.#settle();
    };
  }

  #settle(): void {
    this.#refused = undefined;
    this.#onProblem?.(undefined);
  }

  #refuse(error: unknown): void {
    const wish = this.#wish;
    if (wish !== undefined) this.#refused = wishKey(wish);
    this.#onProblem?.(messageOf(error));
  }
}

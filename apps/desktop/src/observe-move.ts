// Tells when an element has moved on the page without changing its size, which a `ResizeObserver`
// never reports. The web view of a browser pane has to sit exactly on its area, and the area moves
// when a panel beside it takes more room, when the sidebar settles after a reload or when anything
// above it changes height, none of which changes the size of the area.
//
// An `IntersectionObserver` whose root is shrunk to the rectangle the element has now sees the
// element as fully inside while it stays there; the first pixel it moves, it is not, and the
// observer calls back. The rectangle is then measured again and the watch starts over from it.

/** What watching an element for a move gives back. */
export interface MoveObserver {
  /**
   * Watches again from where the element is now, without calling `onMove`. The watch gives up while
   * the element has no area, so whoever sees it get one (a resize) starts it again with this.
   */
  refresh(): void;
  /** Stops watching for good. */
  stop(): void;
}

/** Calls `onMove` after the element has moved away from where it was. */
export function observeMove(element: Element, onMove: () => void): MoveObserver {
  let observer: IntersectionObserver | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stopWatching = (): void => {
    observer?.disconnect();
    observer = undefined;
    clearTimeout(retry);
  };

  /**
   * Watches from the rectangle the element has now; `threshold` is the share of it that counts as
   * "there". `notify` says whether the caller learns of a move that may have happened since the
   * last look (a spurious call costs nothing: the wish it makes is the same one).
   */
  const watch = (threshold: number, notify: boolean): void => {
    stopWatching();
    if (stopped) return;
    if (notify) onMove();
    const rect = element.getBoundingClientRect();
    // Nothing to watch while it has no area (hidden): a change of size is the other observer's.
    if (rect.width === 0 || rect.height === 0) return;
    const page = document.documentElement;
    const top = Math.floor(rect.top);
    const left = Math.floor(rect.left);
    const right = Math.floor(page.clientWidth - rect.right);
    const bottom = Math.floor(page.clientHeight - rect.bottom);
    let first = true;
    observer = new IntersectionObserver(
      (entries) => {
        const ratio = entries.at(-1)?.intersectionRatio ?? 0;
        if (ratio !== threshold) {
          if (!first) {
            // It moved: measure again and watch from where it is now.
            watch(1, true);
            return;
          }
          if (ratio === 0) {
            // Entirely out of the viewport: look again in a while rather than in a loop.
            retry = setTimeout(() => watch(1e-7, true), 1000);
          } else {
            // Partly out of the viewport (or a fraction of a pixel off): that share is "there".
            // It may have moved between the look and this first answer, so the caller looks again.
            watch(ratio, true);
            return;
          }
        }
        first = false;
      },
      { rootMargin: `${-top}px ${-right}px ${-bottom}px ${-left}px`, threshold },
    );
    observer.observe(element);
  };

  watch(1, false);
  return {
    refresh: () => watch(1, false),
    stop: () => {
      stopped = true;
      stopWatching();
    },
  };
}

/** The events that say a CSS animation or transition is over (it ran to its end or was cut short). */
export const SETTLE_EVENTS = [
  "animationend",
  "animationcancel",
  "transitionend",
  "transitioncancel",
] as const;

/**
 * Calls `onSettle` when an animation or a transition of `element`, or of anything above it, is over.
 * The watch in `observeMove` cannot tell an element that ends an animation a fraction of a pixel from
 * where its last look put it (it sits inside the slack of the watched rectangle), yet the position
 * the web view takes is rounded and that fraction can be a whole pixel; the end of the animation is
 * the moment to look again. Returns the function that stops listening.
 */
export function observeSettle(
  element: Element,
  onSettle: () => void,
  scope: Pick<EventTarget, "addEventListener" | "removeEventListener"> = document,
): () => void {
  const listener = (event: Event): void => {
    const target = event.target as { contains?: (other: unknown) => boolean } | null;
    if (target !== null && typeof target.contains === "function" && target.contains(element)) {
      onSettle();
    }
  };
  for (const name of SETTLE_EVENTS) scope.addEventListener(name, listener, true);
  return () => {
    for (const name of SETTLE_EVENTS) scope.removeEventListener(name, listener, true);
  };
}

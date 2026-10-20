import { useSyncExternalStore } from "react";

// The web view of a browser pane is native: it is drawn over the page of the window, so a dialog or
// a menu of the interface that opens above the pane would sit under it. While one is open the web
// views step out of view (`browser-view.ts` takes them to zero size) and come back when it closes.
//
// Which overlays count is read from the page itself and not from a list kept in step with the
// components: every modal of the interface says `aria-modal="true"`, every menu `role="menu"`, and
// the tab switcher is marked with its part name. A new dialog that says what it is covers the pane
// without anybody remembering to tell this file.

/** The elements that cover the window while they are on it. */
export const COVERING_SELECTOR = '[aria-modal="true"], [role="menu"], [data-nr-part="mru"]';

/** Whether something of `root` covers the window. */
export function coversWindow(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(COVERING_SELECTOR) !== null;
}

let covered = false;
let observer: MutationObserver | undefined;
const listeners = new Set<() => void>();

function refresh(): void {
  const next = coversWindow(document);
  if (next === covered) return;
  covered = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // Watching the whole page costs a look per batch of changes, so it only runs while a browser
    // pane is on screen to care.
    observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-modal", "role", "data-nr-part"],
    });
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
      covered = false;
    }
  };
}

/** True while a dialog, a menu or the tab switcher is over the window. */
export function useWindowCovered(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => covered,
    () => false,
  );
}

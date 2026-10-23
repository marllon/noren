import { useSyncExternalStore } from "react";

// What the shell tells the title bar of the dense window. The title bar is drawn by the page, outside
// the shell, so the two things it needs from the shell sit outside the components, the way the state of
// the settings screen does (`settings-ui.ts`): where the person is (the space, the group and the tab
// on screen) and the way to open the command palette, which the shell owns.

/** Where the person is: the active space, the group of the tab on screen (if it is in one) and the tab. */
export interface WindowCrumbs {
  space: string;
  group?: string;
  tab?: string;
}

let crumbs: WindowCrumbs | undefined;
let paletteOpener: (() => void) | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function same(a: WindowCrumbs | undefined, b: WindowCrumbs | undefined): boolean {
  return a?.space === b?.space && a?.group === b?.group && a?.tab === b?.tab;
}

/** The shell says where the person is; `undefined` when there is nothing to say (the shell left). */
export function setWindowCrumbs(next: WindowCrumbs | undefined): void {
  if (same(crumbs, next)) return;
  crumbs = next;
  notify();
}

/** The shell hands over the way to open the command palette, or takes it back with `undefined`. */
export function setPaletteOpener(open: (() => void) | undefined): void {
  if (paletteOpener === open) return;
  paletteOpener = open;
  notify();
}

/** Opens the command palette; nothing happens while the shell is not there. */
export function openPaletteFromChrome(): void {
  paletteOpener?.();
}

/** Calls back when the crumbs or the way to open the palette change; returns the way to stop. */
export function subscribeWindowChrome(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Where the person is, for the breadcrumb of the title bar; draws again when it changes. */
export function useWindowCrumbs(): WindowCrumbs | undefined {
  // The third argument is what a tree rendered to a string (the tests do) reads.
  return useSyncExternalStore(
    subscribeWindowChrome,
    () => crumbs,
    () => crumbs,
  );
}

/** Whether the palette can be opened from the title bar (the shell is up); draws again when that changes. */
export function usePaletteOpenable(): boolean {
  return useSyncExternalStore(
    subscribeWindowChrome,
    () => paletteOpener !== undefined,
    () => paletteOpener !== undefined,
  );
}

/** Forgets what was said, so a test starts from nothing. */
export function resetWindowChrome(): void {
  crumbs = undefined;
  paletteOpener = undefined;
  notify();
}

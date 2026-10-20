import { externalLinkProblem } from "@noren/model";
import { useSyncExternalStore } from "react";

// The one link waiting for the person's answer. A link in the terminal (a plain address on the
// screen, or the target of an OSC 8 hyperlink) is text a program wrote, so clicking it does not
// open anything: it lands here, `LinkPrompt` shows the address, and the browser is asked only after
// the person confirms. Anything that is not an `http` or `https` address never gets this far.

let pending: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null): void {
  pending = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * A link was activated in a terminal. Puts it up for confirmation when it is a web address and
 * ignores it otherwise (`file:`, `javascript:`, `noren:` and the rest are never offered). A link
 * already waiting is replaced: only the last click matters.
 */
export function requestExternalLink(address: string): void {
  if (externalLinkProblem(address) !== undefined) return;
  set(address);
}

/** The address waiting for an answer, `null` when none is. */
export function usePendingLink(): string | null {
  return useSyncExternalStore(subscribe, () => pending);
}

/** The person answered (or the window went away): nothing waits any more. */
export function clearPendingLink(): void {
  if (pending !== null) set(null);
}

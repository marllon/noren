import { useSyncExternalStore } from "react";
import type { Backend } from "@noren/model";

// Whether the system has its transparency effects turned off (the "Transparency effects" switch of
// Windows). The glass interface style draws opaque panels then, as it does for the media feature
// `prefers-reduced-transparency` (which the stylesheet reads on its own). The web view does not always
// report the Windows switch as that feature, so the app asks the system itself through the backend
// (`systemTransparencyReduced`, a read of the setting of the current user and nothing else) and puts the
// answer on the root element as `data-nr-transparency="reduced"`, which the stylesheet reads too
// (`style-tokens.css`). The switch is read when the window starts and again each time it gains the
// focus, so a change made in the system settings while the app is open is followed when the person
// comes back.

/** The attribute of the root element that says the system asks for opaque surfaces. */
export const TRANSPARENCY_ATTRIBUTE = "data-nr-transparency";

/** The value of the attribute while the system has its transparency effects off. */
export const TRANSPARENCY_REDUCED = "reduced";

let reduced = false;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether the system has its transparency effects off, as last asked. */
export function systemTransparencyReduced(): boolean {
  return reduced;
}

/** Whether the system has its transparency effects off; the component renders again when it changes. */
export function useSystemTransparencyReduced(): boolean {
  return useSyncExternalStore(subscribe, systemTransparencyReduced);
}

/**
 * Asks the system and keeps the answer. A system that cannot answer (the backend rejects) counts as
 * one with its effects on, which is how a system is by default.
 */
export async function refreshSystemTransparency(
  backend: Pick<Backend, "systemTransparencyReduced">,
): Promise<void> {
  let answer: boolean;
  try {
    answer = (await backend.systemTransparencyReduced()) === true;
  } catch {
    answer = false;
  }
  if (answer === reduced) return;
  reduced = answer;
  notify();
}

/** Forgets the answer, so a test starts from nothing. */
export function resetSystemTransparency(): void {
  reduced = false;
  notify();
}

/** The slice of an element that `applySystemTransparency` needs (a plain object works in tests). */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Puts the attribute on `root` while the system asks for opaque surfaces, takes it off otherwise. */
export function applySystemTransparency(root: AttributeTarget, isReduced: boolean): void {
  if (isReduced) root.setAttribute(TRANSPARENCY_ATTRIBUTE, TRANSPARENCY_REDUCED);
  else root.removeAttribute(TRANSPARENCY_ATTRIBUTE);
}

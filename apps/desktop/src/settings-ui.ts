import { useSyncExternalStore } from "react";

// Whether the settings screen is open. The button in the title bar, the palette and the shortcut
// all open it, and the shell draws it, so the state sits outside the components.

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

export function openSettings(): void {
  set(true);
}

export function closeSettings(): void {
  set(false);
}

export function isSettingsOpen(): boolean {
  return open;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Whether the settings screen is open; the component renders again when it opens or closes. */
export function useSettingsOpen(): boolean {
  return useSyncExternalStore(subscribe, isSettingsOpen);
}

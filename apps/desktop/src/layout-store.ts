import { useSyncExternalStore } from "react";
import { clampWidth, loadLayout, saveLayout } from "./layout";
import type { Layout } from "./layout";

// The layout preferences, shared by the title bar control and the shell. Provisional until the
// settings file (NOR-F8-01) owns them: every change is saved to the browser storage right away.

const listeners = new Set<() => void>();
let current: Layout | undefined;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function snapshot(): Layout {
  current ??= loadLayout(storage());
  return current;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Changes some preferences, keeps the width in range, saves and tells the listeners. */
export function updateLayout(patch: Partial<Layout>): void {
  const next: Layout = { ...snapshot(), ...patch };
  next.width = clampWidth(next.width);
  current = next;
  saveLayout(storage(), next);
  for (const listener of listeners) listener();
}

/** The layout preferences; the component renders again when any of them changes. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, snapshot);
}

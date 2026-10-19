import { useSyncExternalStore } from "react";
import type { Config } from "@noren/model";
import { configManager } from "./config-store";
import { clampWidth, layoutFromConfig, loadLayout, saveLayout } from "./layout";
import type { Layout } from "./layout";

// The layout preferences, shared by the title bar control and the shell. What the settings file
// (`appearance` in config.jsonc) sets rules; the rest comes from the provisional controls, which
// save every change to the browser storage right away, until the settings screen (NOR-F8-01b)
// replaces them. A preference the file sets cannot be changed from the controls: it would be undone
// at the next read of the file.

const listeners = new Set<() => void>();

/** What the person chose with the provisional controls. */
let stored: Layout | undefined;

interface LayoutView {
  layout: Layout;
  /** The preferences the settings file sets. */
  locked: ReadonlySet<keyof Layout>;
}

/** The layout in force, rebuilt when the stored choice or the settings change. */
let view: LayoutView | undefined;
let viewConfig: Config | undefined;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function current(): LayoutView {
  const config = configManager.state.config;
  if (view === undefined || viewConfig !== config) {
    stored ??= loadLayout(storage());
    const fromConfig = layoutFromConfig(config);
    view = {
      layout: { ...stored, ...fromConfig },
      locked: new Set(Object.keys(fromConfig) as (keyof Layout)[]),
    };
    viewConfig = config;
  }
  return view;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const stopFollowingConfig = configManager.subscribe(onChange);
  return () => {
    listeners.delete(onChange);
    stopFollowingConfig();
  };
}

/** The layout in force: the settings file over the stored choice. */
export function getLayout(): Layout {
  return current().layout;
}

/** The preferences the settings file sets, which the provisional controls cannot change. */
export function layoutLocks(): ReadonlySet<keyof Layout> {
  return current().locked;
}

/**
 * Changes some preferences, keeps the width in range, saves and tells the listeners. A preference
 * the settings file sets is left as it is.
 */
export function updateLayout(patch: Partial<Layout>): void {
  const { locked } = current();
  const allowed = Object.fromEntries(
    Object.entries(patch).filter(([key]) => !locked.has(key as keyof Layout)),
  ) as Partial<Layout>;
  if (Object.keys(allowed).length === 0) return;
  const next: Layout = { ...(stored ?? loadLayout(storage())), ...allowed };
  next.width = clampWidth(next.width);
  stored = next;
  view = undefined;
  saveLayout(storage(), next);
  for (const listener of listeners) listener();
}

/** The layout preferences; the component renders again when any of them changes. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, getLayout);
}

/** The preferences the settings file sets; the component renders again when they change. */
export function useLayoutLocks(): ReadonlySet<keyof Layout> {
  return useSyncExternalStore(subscribe, layoutLocks);
}

/** Forgets what was read, so a test starts from the storage again. */
export function resetLayoutStore(): void {
  stored = undefined;
  view = undefined;
  viewConfig = undefined;
}

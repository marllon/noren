import { useMemo, useSyncExternalStore } from "react";
import { planMods } from "@noren/model";
import type { ModPlan } from "@noren/model";
import { useConfigState } from "./config-store";
import { useModFiles } from "./mods-store";
import { activeSpaceOf } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

// Which mods are in force: the global list (`mods` of `config.jsonc`), then the list of the active
// space (`modIds` in `state.json`), against the files the folder has (`mods-store.ts`). Switching
// space switches the mods at once, like the theme of a space.

const NONE: readonly string[] = [];
const listeners = new Set<() => void>();
/** The `modIds` of the active space. The array of the space itself, replaced when it changes. */
let spaceMods: readonly string[] = NONE;
let stopFollowing: (() => void) | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/**
 * Follows the mods of the active space in `store`: the window applies them while that space is
 * active. Follows one store at a time; a second call replaces the first.
 */
export function followActiveSpaceMods(store: Pick<WorkspaceStore, "getState" | "subscribe">): void {
  stopFollowing?.();
  const read = () => {
    const next = activeSpaceOf(store.getState().workspace).modIds;
    if (next === spaceMods) return;
    spaceMods = next;
    notify();
  };
  read();
  stopFollowing = store.subscribe(read);
}

/** Stops following the store and forgets the mods of the space, so a test starts from nothing. */
export function resetSpaceMods(): void {
  stopFollowing?.();
  stopFollowing = undefined;
  spaceMods = NONE;
}

/** The names the active space turns on, in order. */
export function getSpaceMods(): readonly string[] {
  return spaceMods;
}

/** The names the active space turns on; the component renders again when they change. */
export function useSpaceMods(): readonly string[] {
  return useSyncExternalStore(subscribe, getSpaceMods);
}

/** The mods in force for the active space, and what was left out of them. */
export function useModPlan(): ModPlan {
  const global = useConfigState().config.mods ?? NONE;
  const own = useSpaceMods();
  const files = useModFiles();
  return useMemo(() => planMods(global, own, files), [global, own, files]);
}

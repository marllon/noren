import { useSyncExternalStore } from "react";
import { LiveGroups, liveSourcesOf } from "@noren/model";
import type { Backend, Clock, Id, LiveEntry } from "@noren/model";
import { t } from "./i18n";
import type { WorkspaceStore } from "./workspace-store";

// The live groups while the app runs (NOR-F17-04a): `LiveGroups` (see `live-groups.ts` in the model)
// asks the source of every live group of the workspace at the start and every ten seconds, and the
// entries it keeps are what `openLiveEntry` of the store opens. The sidebar shows them (NOR-F17-04b):
// `useLiveGroupsVersion` makes it draw again whenever the updater says a list or an error changed.

let running: LiveGroups | undefined;
let stopListening: (() => void) | undefined;
// Bumped at every notice of the updater; what `useSyncExternalStore` reads to know it must draw again.
let version = 0;
const listeners = new Set<() => void>();

/** The updater that is running, for the store and for tests. */
export function currentLiveGroups(): LiveGroups | undefined {
  return running;
}

/** The entries a live group lists now; none when the updater is not running. */
export function liveEntriesOf(groupId: Id): readonly LiveEntry[] {
  return running?.entries(groupId) ?? [];
}

/** The name of the group "New group of worktrees" makes: the last folder of the path, else the path. */
export function worktreesGroupName(folder: string): string {
  const trimmed = folder.trim().replace(/[\\/]+$/, "");
  const last = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
  return t("live.worktrees.name", { folder: last !== "" ? last : trimmed });
}

/** Why the last question of a live group failed; `undefined` when it was answered. */
export function liveErrorOf(groupId: Id): string | undefined {
  return running?.error(groupId);
}

/** Calls `listener` whenever any live group's entries or error change. Returns the way to stop. */
export function subscribeLiveGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A number that changes every time the updater tells a list or an error changed. */
export function liveGroupsVersion(): number {
  return version;
}

/** Re-renders the component whenever the live groups change (see `subscribeLiveGroups`). */
export function useLiveGroupsVersion(): number {
  return useSyncExternalStore(subscribeLiveGroups, liveGroupsVersion, liveGroupsVersion);
}

/**
 * Asks every live group now, outside the ten-second round: used after the app itself changed what a
 * source lists (a worktree made or removed). Resolves when the answers are in; without the updater
 * it does nothing.
 */
export async function refreshLiveGroups(): Promise<void> {
  await running?.refresh();
}

export interface LiveGroupsServiceOptions {
  store: WorkspaceStore;
  backend: Pick<Backend, "listWorktrees">;
  clock: Pick<Clock, "setTimer">;
  intervalMs?: number;
  onError?(groupId: Id, error: unknown): void;
}

/** Starts the updater. Starting again replaces the one that was running. */
export function startLiveGroups(options: LiveGroupsServiceOptions): LiveGroups {
  running?.stop();
  stopListening?.();
  const started = new LiveGroups({
    clock: options.clock,
    workspace: () => options.store.getState().workspace,
    sources: liveSourcesOf(options.backend),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  running = started;
  stopListening = started.subscribe(() => {
    version += 1;
    for (const listener of [...listeners]) listener();
  });
  started.start();
  return started;
}

/** Stops the updater (tests). */
export function stopLiveGroups(): void {
  running?.stop();
  stopListening?.();
  stopListening = undefined;
  running = undefined;
}

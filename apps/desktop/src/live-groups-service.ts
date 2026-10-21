import { LiveGroups, liveSourcesOf } from "@noren/model";
import type { Backend, Clock, Id, LiveEntry } from "@noren/model";
import type { WorkspaceStore } from "./workspace-store";

// The live groups while the app runs (NOR-F17-04a): `LiveGroups` (see `live-groups.ts` in the model)
// asks the source of every live group of the workspace at the start and every ten seconds, and the
// entries it keeps are what `openLiveEntry` of the store opens. Nothing here shows them; the sidebar
// that does is another task.

let running: LiveGroups | undefined;

/** The updater that is running, for the store and for tests. */
export function currentLiveGroups(): LiveGroups | undefined {
  return running;
}

/** The entries a live group lists now; none when the updater is not running. */
export function liveEntriesOf(groupId: Id): readonly LiveEntry[] {
  return running?.entries(groupId) ?? [];
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
  const started = new LiveGroups({
    clock: options.clock,
    workspace: () => options.store.getState().workspace,
    sources: liveSourcesOf(options.backend),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  running = started;
  started.start();
  return started;
}

/** Stops the updater (tests). */
export function stopLiveGroups(): void {
  running?.stop();
  running = undefined;
}

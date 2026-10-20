import { restoreWorkspace } from "@noren/model";
import type { Backend, Id, RestoreOptions, RestoreResult } from "@noren/model";
import { followKeepSessions } from "./keep-sessions-sync";
import type { ConfigFollowed, KeepSessionsFollow } from "./keep-sessions-sync";

// The part of the start of the app that decides which shell each pane gets (NOR-F14-02b): the
// shells the session daemon kept for the panes come back, the other panes get a new one.

/**
 * Hands `sessions.keepOnClose` to the backend, and only then restores the workspace: the backend gives
 * a pane its old shell back only when the settings keep sessions, so the restore must not ask before
 * it knows. The setting is followed from here on (the returned `follow` is how to stop it).
 */
export async function restoreKeepingSessions(
  backend: Pick<
    Backend,
    "setKeepSessions" | "loadState" | "quarantineState" | "createSession" | "reattachSession"
  >,
  settings: ConfigFollowed,
  options?: RestoreOptions,
): Promise<{ restored: RestoreResult; follow: KeepSessionsFollow }> {
  const follow = followKeepSessions(settings, backend);
  await follow.settled();
  const restored = await restoreWorkspace(backend, options);
  return { restored, follow };
}

/**
 * Takes the saved scrollback of the panes that got their old shell back out of `texts`: such a pane
 * gets what the shell printed from the shell itself, and the snapshot would only repeat it.
 */
export function withoutReattachedSnapshots(
  texts: Map<Id, string> | undefined,
  reattachedPaneIds: readonly Id[],
): void {
  for (const paneId of reattachedPaneIds) texts?.delete(paneId);
}

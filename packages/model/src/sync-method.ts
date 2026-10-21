// How the settings are synced (NOR-F19-02b): `sync.method` of `config.jsonc`, through a git remote
// (the default) or through a secret GitHub gist. Pure: the screen, the palette commands and the
// push when the app closes all read the choice here, so they cannot disagree about it.

/** The ways to sync: a git remote (`noren-core::sync`) or a gist (`noren-core::sync_gist`). */
export const SYNC_METHODS = ["git", "gist"] as const;

export type SyncMethod = (typeof SYNC_METHODS)[number];

/** `sync.method` when the settings file does not say. */
export const DEFAULT_SYNC_METHOD: SyncMethod = "git";

/** The method the settings choose: `sync.method`, or git when it is not there. */
export function syncMethodOf(sync: { method?: SyncMethod | undefined } | undefined): SyncMethod {
  return sync?.method ?? DEFAULT_SYNC_METHOD;
}

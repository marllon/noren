import { useSyncExternalStore } from "react";
import { ConfigManager } from "@noren/model";
import type { ConfigState } from "@noren/model";

// The settings of `config.jsonc` in force. `boot.ts` starts the manager with the backend: it reads
// the file, watches it, and keeps the last valid settings when a later text is invalid. Whatever
// uses a setting reads it from here (`layout-store.ts`, `notification-settings.ts`), and the
// notice of a problem with the file reads the errors.

export const configManager = new ConfigManager();

/** The settings and the problems with the file; the component renders again when either changes. */
export function useConfigState(): ConfigState {
  return useSyncExternalStore(configManager.subscribe, () => configManager.state);
}

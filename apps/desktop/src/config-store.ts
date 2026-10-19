import { useSyncExternalStore } from "react";
import { ConfigManager } from "@noren/model";
import type { ConfigState } from "@noren/model";
import { AiProvidersSync } from "./ai-providers-sync";

// The settings of `config.jsonc` in force. `boot.ts` starts the manager with the backend: it reads
// the file, watches it, and keeps the last valid settings when a later text is invalid. Whatever
// uses a setting reads it from here (`layout-store.ts`, `notification-settings.ts`), and the
// notice of a problem with the file reads the errors.

export const configManager = new ConfigManager();

/**
 * Hands `ai.providers` of the settings to the backend at start and at every change of the list
 * (`boot.ts` starts it). The settings screen waits on it before it tests a connection, and shows
 * why a list was refused.
 */
export const aiProvidersSync = new AiProvidersSync();

/** The settings and the problems with the file; the component renders again when either changes. */
export function useConfigState(): ConfigState {
  return useSyncExternalStore(configManager.subscribe, () => configManager.state);
}

/** Why the backend refused the providers of the file, `undefined` when it took them. */
export function useAiProvidersError(): string | undefined {
  return useSyncExternalStore(aiProvidersSync.subscribe, () => aiProvidersSync.error);
}

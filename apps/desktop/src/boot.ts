import { SystemNotifier, restoreWorkspace } from "@noren/model";
import type { Backend } from "@noren/model";
import { createBackend } from "./backend";
import { configManager } from "./config-store";
import { loadHome } from "./home";
import { migrateLegacySettings } from "./legacy-settings";
import type { LegacyStorageArea } from "./legacy-settings";
import { notificationSettings } from "./notification-settings";
import { getProfiles, startProfiles } from "./profiles-store";
import { followActiveSpaceTheme } from "./use-theme";
import { loadUserThemes } from "./user-themes-store";
import { createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

export const backend: Backend = createBackend();

export type BootResult =
  | { ok: true; store: WorkspaceStore; source: "saved" | "fresh" | "recovered" }
  | { ok: false; error: string };

const newId = () => crypto.randomUUID();
const clock = { now: () => Date.now() };

/** Where earlier builds kept the active tab of each space; now it lives in `state.json`. */
export const LEGACY_ACTIVE_ITEMS_KEY = "noren.ui.activeItems";

/**
 * Restores the saved workspace (new shells in the saved folders), builds the store around it and
 * makes sure the pending state is written when the window goes away. The old browser-storage copy
 * of the active tabs is dropped, not migrated: the first run after the upgrade shows the first tab.
 */
export async function bootWorkspace(
  target: Backend,
  events: Pick<Window, "addEventListener">,
  storage: LegacyStorageArea | undefined,
): Promise<BootResult> {
  try {
    try {
      storage?.removeItem(LEGACY_ACTIVE_ITEMS_KEY);
    } catch {
      // Storage may be blocked; the leftover key is harmless.
    }
    // The settings first, so the first frame already has the side of the sidebar. A file that is
    // missing, unreadable or invalid never stops the app: the defaults and an error notice stand in.
    await configManager.start(target);
    // What earlier builds kept in the browser storage (layout, notifications, shortcut preset)
    // moves into the file once, before the first frame. It never stops the app: a file it cannot
    // edit leaves the old keys for the next start.
    await migrateLegacySettings(storage, configManager).catch(() => undefined);
    // The themes of the user, before the first frame: a space or the settings may name one of them.
    // A folder that cannot be read leaves the built-in themes, and never stops the app.
    await loadUserThemes(target).catch(() => undefined);
    // The profiles of the user (from the file) are handed to the backend before anything restores a
    // shell, since a saved pane may name one of them; the list is then the machine's and the user's.
    await startProfiles(target, configManager);
    if (getProfiles().length === 0) {
      return { ok: false, error: "No shell was found on this machine." };
    }
    const restored = await restoreWorkspace(target, { defaults: { newId, clock } });
    const home = await loadHome();
    const store = createWorkspaceStore({
      backend: target,
      ...(home !== undefined ? { home } : {}),
      workspace: restored.workspace,
      failedPaneIds: restored.failedPaneIds,
      newId,
      clock,
      // A failed notification (the system refused) is not worth an error on screen.
      notifier: new SystemNotifier({ backend: target, settings: notificationSettings }),
    });
    // The window shows the theme of the active space, if it has one, from the first frame.
    followActiveSpaceTheme(store);
    const flush = () => {
      store
        .getState()
        .flush()
        .catch(() => undefined);
    };
    events.addEventListener("beforeunload", flush);
    events.addEventListener("pagehide", flush);
    return { ok: true, store, source: restored.source };
  } catch (reason: unknown) {
    return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
  }
}

/** Starts at import, so the restore runs once even when React mounts the app twice. */
export const booted: Promise<BootResult> = bootWorkspace(backend, window, window.localStorage);

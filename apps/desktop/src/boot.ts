import { restoreWorkspace } from "@noren/model";
import type { Backend } from "@noren/model";
import { createBackend } from "./backend";
import { createWorkspaceStore } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

export const backend: Backend = createBackend();

export type BootResult =
  | { ok: true; store: WorkspaceStore; source: "saved" | "fresh" | "recovered" }
  | { ok: false; error: string };

const newId = () => crypto.randomUUID();
const clock = { now: () => Date.now() };

/**
 * Restores the saved workspace (new shells in the saved folders), builds the store around it and
 * makes sure the pending state is written when the window goes away.
 */
export async function bootWorkspace(
  target: Backend,
  events: Pick<Window, "addEventListener">,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
): Promise<BootResult> {
  try {
    const profiles = await target.listProfiles();
    if (profiles.length === 0) return { ok: false, error: "No shell was found on this machine." };
    const restored = await restoreWorkspace(target, { defaults: { newId, clock } });
    const store = createWorkspaceStore({
      backend: target,
      workspace: restored.workspace,
      failedPaneIds: restored.failedPaneIds,
      newId,
      clock,
      ...(storage !== undefined ? { uiStorage: storage } : {}),
    });
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

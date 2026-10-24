import { layoutPanes } from "@noren/model";
import type { AgentSettings, Backend, Id, Pane, PendingPane, Workspace } from "@noren/model";
import { armAgentResumes } from "./resume-restore";
import type { ResumeService } from "./resume-service";
import type { PendingPanes } from "./pending-panes";
import { spaceItemIds } from "./workspace-store";
import type { WorkspaceStore } from "./workspace-store";

/**
 * How long after the restore the shells left for later start even if no first prompt showed (a shell
 * without the integration never writes the mark `watchFirstPrompt` looks for).
 */
export const PENDING_START_FALLBACK_MS = 500;

/**
 * How long the panes that got their shell are held to be recorded in the store together. Every change
 * of the store draws the whole window again (a hundred tabs), so a hundred changes one after the other
 * cost more than the shells themselves; a tab that is opened does not wait for it.
 */
export const SETTLE_WINDOW_MS = 100;

export interface PendingStartOptions {
  /** The panes the restore left for later, and the workspace it restored (the store's, as it was). */
  pending: readonly PendingPane[];
  workspace: Workspace;
  store: WorkspaceStore;
  queue: PendingPanes;
  /** The saved scrollback the terminals will write, by pane; a pane that got its shell back loses its entry. */
  scrollback: Map<Id, string> | undefined;
  settings: () => Pick<AgentSettings, "enabled" | "resumeOnRestore" | "catalog">;
  backend: Pick<Backend, "write">;
  resume: ResumeService;
  /** Milliseconds to the fallback that lets the queue run without a first prompt. */
  fallbackMs?: number;
  /** Milliseconds the started panes are held to be recorded together (`SETTLE_WINDOW_MS`). */
  settleMs?: number;
}

/**
 * Records started panes in the store in groups: a call waits for the end of the window (or goes
 * at once when `now` says a person waits for the pane) and resolves when its group is recorded.
 */
function settler(
  store: WorkspaceStore,
  windowMs: number,
): (paneId: Id, started: Pane, now: boolean) => Promise<void> {
  let group: { paneId: Id; started: Pane; done: () => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const settled = group;
    group = [];
    store.getState().settlePanes(settled.map(({ paneId, started }) => ({ paneId, started })));
    for (const { done } of settled) done();
  };
  return (paneId, started, now) =>
    new Promise<void>((done) => {
      group.push({ paneId, started, done });
      if (now) flush();
      else timer ??= setTimeout(flush, windowMs);
    });
}

/** The panes of the workspace, those of the active space first: the ones a person opens first. */
function paneOrder(ws: Workspace): Id[] {
  const active = ws.spaces.find((space) => space.id === ws.activeSpaceId) ?? ws.spaces[0];
  const spaces = active ? [active, ...ws.spaces.filter((space) => space !== active)] : [];
  const ids: Id[] = [];
  for (const space of spaces) {
    for (const itemId of spaceItemIds(space)) {
      const item = space.items[itemId];
      if (item) for (const pane of layoutPanes(item.layout)) ids.push(pane.id);
    }
  }
  return ids;
}

/** True when some terminal pane of the workspace has a shell already: its prompt is yet to come. */
function hasShell(ws: Workspace): boolean {
  return ws.spaces.some((space) =>
    Object.values(space.items).some((item) =>
      layoutPanes(item.layout).some((pane) => pane.sessionId !== undefined),
    ),
  );
}

/** True when the pane is still in the workspace and still has no shell (a page of another window may have started one for it). */
function stillWaiting(ws: Workspace, paneId: Id): boolean {
  return ws.spaces.some((space) =>
    Object.values(space.items).some((item) =>
      layoutPanes(item.layout).some((pane) => pane.id === paneId && pane.sessionId === undefined),
    ),
  );
}

/**
 * Queues the panes the restore left without a shell. Each is started in its turn once the first
 * prompt is on screen (or `fallbackMs` after this call), or at once when its tab is opened
 * (`PendingPanes.prioritize`). Starting one does what the restore does for a pane: the shell it had
 * is given back when the daemon holds it (and the saved scrollback, which would only repeat what the
 * shell printed, is left out), else a new one starts in its folder; the agent it was running is armed
 * to resume; a pane that closed meanwhile, or that got a shell some other way, starts nothing.
 */
export function queuePendingPanes(options: PendingStartOptions): void {
  const { pending, store, queue, scrollback, resume } = options;
  if (pending.length === 0) return;
  const settle = settler(store, options.settleMs ?? SETTLE_WINDOW_MS);
  const byId = new Map(pending.map((pane) => [pane.paneId, pane]));
  const order = paneOrder(options.workspace).filter((id) => byId.has(id));
  queue.load(order, async (paneId) => {
    const pane = byId.get(paneId);
    if (pane === undefined || !stillWaiting(store.getState().workspace, paneId)) return;
    const started = await pane.start();
    if (started.reattached) scrollback?.delete(paneId);
    await settle(paneId, started.pane, queue.urgent(paneId));
    if (started.savedCommand !== undefined) {
      armAgentResumes({
        restored: {
          workspace: store.getState().workspace,
          savedCommands: [started.savedCommand],
          reattachedPaneIds: started.reattached ? [paneId] : [],
        },
        settings: options.settings(),
        backend: options.backend,
        service: resume,
      });
    }
  });
  // With no shell on screen (the tab shown holds only previews, a browser, a diff) no first prompt will
  // come to let the rest go.
  if (!hasShell(options.workspace)) queue.release();
  // The fallback only matters if the first prompt never shows; `release` is idempotent.
  setTimeout(() => queue.release(), options.fallbackMs ?? PENDING_START_FALLBACK_MS);
}

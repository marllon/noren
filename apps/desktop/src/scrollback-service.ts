import { FakeBackend, scrollbackAllowed, scrollbackFileName } from "@noren/model";
import type { Backend, Clock, Id } from "@noren/model";
import { closedChanges } from "./closed-scrollback";
import { configManager } from "./config-store";
import { realClock } from "./real-clock";
import { ScrollbackSaver, scrollbackPanes } from "./scrollback-saver";
import type { StaleSnapshot } from "./scrollback-restore";
import type { WorkspaceStore } from "./workspace-store";

// The scrollback snapshots while the app runs: the terminals tell here what they would save, the
// saver (see `scrollback-saver.ts`) asks for it every minute and when the window closes, and the
// panes note in the workspace that they have a file.

/** What the terminal of each pane serializes: the last lines, with their colors. */
const sources = new Map<Id, () => string>();

/** The terminal of `paneId` can be asked for its snapshot with `source` (a later one replaces it). */
export function registerTerminalSnapshot(paneId: Id, source: () => string): void {
  sources.set(paneId, source);
}

/** What the terminal of `paneId` serializes now; `undefined` when it has none, or it is already gone. */
function readTerminal(paneId: Id): string | undefined {
  try {
    return sources.get(paneId)?.();
  } catch {
    return undefined;
  }
}

/** Whether the terminal of `paneId` is registered (a pane that was closed is forgotten at the next save). */
export function hasTerminalSnapshot(paneId: Id): boolean {
  return sources.has(paneId);
}

let saver: ScrollbackSaver | undefined;
/** Stops what the last `startScrollback` follows (its saver and the settings). */
let stopFollowing: (() => void) | undefined;

/** The pane printed something: its snapshot is due at the next save. */
export function noteTerminalActivity(paneId: Id): void {
  saver?.noteActivity(paneId);
}

/** The saver that is running, for tests and diagnostics. */
export function currentScrollbackSaver(): ScrollbackSaver | undefined {
  return saver;
}

/** The clock of the saves: the one the fake shell runs on in web mode (the tests move it), else the real one. */
export function scrollbackClock(backend: Backend): Clock {
  return backend instanceof FakeBackend ? backend.clock : realClock;
}

export interface ScrollbackServiceOptions {
  store: WorkspaceStore;
  backend: Backend;
  clock: Clock;
  /** Where the window closing is heard (`beforeunload`, `pagehide`). */
  events: Pick<Window, "addEventListener">;
  onError?(error: unknown): void;
}

/**
 * Starts saving the snapshots: every minute for the panes that had activity, and when the window
 * goes away. The listeners are added here, so they run before the ones added after: the snapshot
 * notes the panes make (see `ScrollbackSaverOptions.onFile`) reach the state the window then writes.
 */
export function startScrollback(options: ScrollbackServiceOptions): ScrollbackSaver {
  const { store, backend } = options;
  stopFollowing?.();
  const started = new ScrollbackSaver({
    backend,
    clock: options.clock,
    panes: () => {
      const open = scrollbackPanes(store.getState().workspace);
      // A pane that was closed takes its terminal with it: nothing keeps asking a dead terminal.
      const ids = new Set(open.map((pane) => pane.paneId));
      for (const paneId of [...sources.keys()]) if (!ids.has(paneId)) sources.delete(paneId);
      return open;
    },
    snapshot: readTerminal,
    enabled: () => scrollbackAllowed(configManager.state.config.terminal),
    onFile: (pane, has) =>
      store.getState().dispatch({
        type: "pane/set-scrollback",
        itemId: pane.itemId,
        paneId: pane.paneId,
        ...(has ? { ref: scrollbackFileName(pane.paneId) } : {}),
      }),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  saver = started;
  started.start();

  const closing = () => {
    void started.flush();
  };
  options.events.addEventListener("beforeunload", closing);
  options.events.addEventListener("pagehide", closing);

  // A tab that closes keeps its scrollback for when it is reopened, and one that leaves the closed
  // stack (or the workspace) takes its file with it. The terminals of a tab that closed leave with
  // the render that follows, so they are asked now; the writes and the notes wait for the end of
  // the action that closed it (a note is an action too, and must not run inside another).
  const stopClosed = store.subscribe((state, previous) => {
    const changes = closedChanges(previous.workspace, state.workspace);
    if (changes.closed.length === 0 && changes.gone.length === 0) return;
    const lines = changes.closed.map((pane) => ({ pane, raw: readTerminal(pane.paneId) }));
    queueMicrotask(() => {
      for (const { pane, raw } of lines) void started.saveNow(pane, raw);
      for (const paneId of changes.gone) void started.discard(paneId);
    });
  });

  // Turning the setting off removes the files at once, not at the next minute.
  let allowed = scrollbackAllowed(configManager.state.config.terminal);
  const stopSettings = configManager.subscribe(() => {
    const now = scrollbackAllowed(configManager.state.config.terminal);
    if (allowed && !now) void started.flush();
    allowed = now;
  });
  stopFollowing = () => {
    started.stop();
    stopSettings();
    stopClosed();
  };
  return started;
}

/**
 * Takes the notes away from panes whose snapshot is not to be kept (see `StaleSnapshot`): the file
 * is removed when it is still there, and the pane stops recording it. A file that cannot be removed
 * keeps its note, so the next start tries again.
 */
export async function clearStaleSnapshots(
  store: WorkspaceStore,
  backend: Pick<Backend, "deleteScrollback">,
  stale: readonly StaleSnapshot[],
  onError?: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    stale.map(async ({ paneId, itemId, remove }) => {
      try {
        if (remove) await backend.deleteScrollback(paneId);
        store.getState().dispatch({ type: "pane/set-scrollback", itemId, paneId });
      } catch (error) {
        onError?.(error);
      }
    }),
  );
}

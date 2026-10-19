import { layoutPanes } from "@noren/model";
import type { Backend, ClosedItem, Id } from "@noren/model";
import { loadScrollbackForItem, setRestoredScrollbackFor } from "./scrollback-restore";
import { clearStaleSnapshots } from "./scrollback-service";
import type { WorkspaceStore } from "./workspace-store";

// Reopens a tab from the closed stack (Ctrl+Shift+Alt+T or the palette) or restores one from the
// archive (the library): the reducer puts it back in its space, group and position (`item/reopen`,
// `archive/restore`), and here its saved scrollback is read first, so the terminal of each pane
// writes it, dimmed under "session restored", before the new shell prints, exactly as at the start
// of the app. The shell is new, in the folder and profile of the pane.

/** What the user is told when the stack has nothing to reopen. */
export const NOTHING_CLOSED_NOTICE = "No closed tab to reopen";

/** What the user is told when the tab asked for is no longer in the library. */
export const GONE_FROM_LIBRARY_NOTICE = "That tab is no longer in the library";

/** Where the tab comes back from. */
export type ReopenSource = "closed" | "archive";

export interface ReopenClosedOptions {
  store: WorkspaceStore;
  backend: Pick<Backend, "loadScrollback" | "deleteScrollback">;
  /** Whether the settings of the app allow snapshots. */
  enabled(): boolean;
  /** The date of the line "session restored". */
  now(): number;
  /** A given item, or (without one) the closed item closed last. */
  itemId?: Id;
  /** The list the tab comes back from. Default `closed`. */
  from?: ReopenSource;
  onError?(error: unknown): void;
}

// Reopens never overlap: two presses in a row bring back two tabs, the second one the next newest.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Reopens a closed tab, or restores an archived one (`from: "archive"`, which needs `itemId`), and
 * shows it (its space becomes the active one). Resolves to `false` when there was nothing to bring
 * back. Never rejects: a snapshot that cannot be read leaves the pane without it, and the tab still
 * comes back.
 */
export function reopenClosed(options: ReopenClosedOptions): Promise<boolean> {
  const run = queue.then(() => reopenNow(options));
  queue = run.catch(() => undefined);
  return run;
}

function pick(
  store: WorkspaceStore,
  itemId: Id | undefined,
  from: ReopenSource,
): Pick<ClosedItem, "item" | "spaceId"> | undefined {
  const { closed, archive } = store.getState().workspace;
  const list: readonly Pick<ClosedItem, "item" | "spaceId">[] =
    from === "archive" ? archive : closed;
  if (itemId === undefined) return from === "archive" ? undefined : list.at(-1);
  return list.find((entry) => entry.item.id === itemId);
}

async function reopenNow(options: ReopenClosedOptions): Promise<boolean> {
  const { store, backend } = options;
  const from = options.from ?? "closed";
  const entry = pick(store, options.itemId, from);
  if (!entry) return false;
  const { workspace } = store.getState();
  // The space it goes back to: its own, else the active one (what the reducer does).
  const space =
    workspace.spaces.find((s) => s.id === entry.spaceId) ??
    workspace.spaces.find((s) => s.id === workspace.activeSpaceId);
  const restore = await loadScrollbackForItem(backend, entry.item, space?.saveScrollback ?? true, {
    enabled: options.enabled(),
    now: options.now(),
  });
  // Another reopen, a delete or the stack may have moved on while the files were read.
  const again = pick(store, entry.item.id, from);
  if (!again) return false;
  setRestoredScrollbackFor(
    layoutPanes(entry.item.layout).map((pane) => pane.id),
    restore.texts,
  );
  const before = store.getState().workspace;
  store
    .getState()
    .dispatch(
      from === "archive"
        ? { type: "archive/restore", itemId: entry.item.id }
        : { type: "item/reopen", itemId: entry.item.id },
    );
  const after = store.getState().workspace;
  if (after === before) return false;
  const home = after.spaces.find((s) => Object.hasOwn(s.items, entry.item.id));
  if (home) store.getState().dispatch({ type: "space/activate", spaceId: home.id });
  await clearStaleSnapshots(store, backend, restore.stale, options.onError);
  return true;
}

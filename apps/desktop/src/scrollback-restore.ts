import {
  isScrollbackPaneId,
  layoutPanes,
  restoredTerminalText,
  savesScrollback,
} from "@noren/model";
import type { Backend, Id, Item, Workspace } from "@noren/model";

// Brings the saved scrollback of the panes back when the app opens: for each pane that has a
// snapshot, the text that shows it again (dimmed, under the line "session restored <date>") is kept
// here until the terminal of the pane is mounted, which writes it before the new session prints.
//
// What is read is data from disk: `restoredTerminalText` cleans it, so only text and colors get as
// far as a terminal. A snapshot that settings or the space no longer allow is not shown, and its
// file is removed.

/** A pane whose note about a snapshot file does not hold any more. */
export interface StaleSnapshot {
  paneId: Id;
  itemId: Id;
  /** The file is still on disk and goes (the settings forbid it, or it holds nothing to show). */
  remove: boolean;
}

export interface ScrollbackRestore {
  /** The text to write to the terminal of each pane before its session prints, by pane id. */
  texts: Map<Id, string>;
  /** Notes to take away from the panes (and files to remove). */
  stale: StaleSnapshot[];
}

export interface ScrollbackRestoreOptions {
  /** Whether the settings of the app allow snapshots. */
  enabled: boolean;
  /** When the panes are restored: the date in the line "session restored". */
  now: number;
}

/**
 * Reads the snapshot of every pane that records one. A file that cannot be read is skipped (the
 * pane opens without it, and the note stays for the next start); a note whose file is not there, or
 * that holds nothing, is stale.
 */
export async function loadScrollbackForRestore(
  backend: Pick<Backend, "loadScrollback">,
  workspace: Workspace,
  options: ScrollbackRestoreOptions,
): Promise<ScrollbackRestore> {
  const restore: ScrollbackRestore = { texts: new Map(), stale: [] };
  const jobs: Promise<void>[] = [];
  for (const space of workspace.spaces) {
    for (const item of Object.values(space.items)) {
      jobs.push(readItemScrollback(backend, item, space.saveScrollback, options, restore));
    }
  }
  await Promise.all(jobs);
  return restore;
}

/**
 * Reads the snapshots of the panes of one item, as `loadScrollbackForRestore` does for the whole
 * workspace: this is what a tab that is reopened shows. `spaceSaves` is `saveScrollback` of the space
 * the item goes to.
 */
export async function loadScrollbackForItem(
  backend: Pick<Backend, "loadScrollback">,
  item: Item,
  spaceSaves: boolean,
  options: ScrollbackRestoreOptions,
): Promise<ScrollbackRestore> {
  const restore: ScrollbackRestore = { texts: new Map(), stale: [] };
  await readItemScrollback(backend, item, spaceSaves, options, restore);
  return restore;
}

async function readItemScrollback(
  backend: Pick<Backend, "loadScrollback">,
  item: Item,
  spaceSaves: boolean,
  options: ScrollbackRestoreOptions,
  restore: ScrollbackRestore,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const pane of layoutPanes(item.layout)) {
    if (pane.scrollbackRef === undefined) continue;
    const where = { paneId: pane.id, itemId: item.id };
    if (!savesScrollback(options.enabled, spaceSaves)) {
      // Never saved here, so nothing is shown and the file goes.
      restore.stale.push({ ...where, remove: true });
      continue;
    }
    if (!isScrollbackPaneId(pane.id)) continue;
    jobs.push(
      backend.loadScrollback(pane.id).then(
        (raw) => {
          if (raw === null) {
            restore.stale.push({ ...where, remove: false });
            return;
          }
          const text = restoredTerminalText(raw, options.now);
          if (text === "") restore.stale.push({ ...where, remove: true });
          else restore.texts.set(pane.id, text);
        },
        () => undefined,
      ),
    );
  }
  await Promise.all(jobs);
}

// The text waiting for each terminal. It stays for the life of the window: a terminal that mounts
// again for the same pane shows the snapshot again.
const waiting = new Map<Id, string>();

/** Keeps `texts` as what the terminals of the panes write when they mount, replacing what was kept. */
export function setRestoredScrollback(texts: ReadonlyMap<Id, string>): void {
  waiting.clear();
  for (const [paneId, text] of texts) waiting.set(paneId, text);
}

/** The text the terminal of `paneId` writes before its session prints, or `undefined` for none. */
export function restoredScrollbackOf(paneId: Id): string | undefined {
  return waiting.get(paneId);
}

/**
 * Sets what the terminals of `paneIds` write when they mount: the text in `texts` for the panes
 * that have one, and nothing for the others (a snapshot kept from an earlier mount of the pane does
 * not come back). The panes of other items are left as they are.
 */
export function setRestoredScrollbackFor(
  paneIds: readonly Id[],
  texts: ReadonlyMap<Id, string>,
): void {
  for (const paneId of paneIds) {
    const text = texts.get(paneId);
    if (text === undefined) waiting.delete(paneId);
    else waiting.set(paneId, text);
  }
}

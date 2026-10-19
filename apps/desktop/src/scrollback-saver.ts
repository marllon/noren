import {
  SCROLLBACK_SAVE_INTERVAL_MS,
  cleanSnapshot,
  isScrollbackPaneId,
  layoutPanes,
  savesScrollback,
} from "@noren/model";
import type { Backend, Clock, Id, Workspace } from "@noren/model";

// Keeps the scrollback snapshots of the panes up to date: every minute, for the panes that had
// activity since they were last saved, and once more when the window closes (`flush`). The clock, the
// backend and the terminals are all handed in, so the rules are tested without any of them.
//
// - A pane is saved only when its space and the settings of the app both allow it
//   (`savesScrollback`). When one of them says no, nothing is written, and the file that was saved
//   before is removed.
// - A pane that had no activity since its last snapshot is not saved again: the file already has
//   what the terminal shows.
// - What is written is `cleanSnapshot` of what the terminal serialized, so a file never holds
//   anything but text and colors (the file is cleaned again when it is read, since it may have been
//   changed on disk in between).
// - Saves of the same pane never overlap: a second one waits for the first, so an older snapshot
//   cannot land on top of a newer one.

/** What the saver needs to know of a pane: where it is, and what its space and its file say. */
export interface ScrollbackPane {
  paneId: Id;
  itemId: Id;
  /** `saveScrollback` of the pane's space. */
  spaceSaves: boolean;
  /** The pane records a snapshot file (`Pane.scrollbackRef`). */
  hasFile: boolean;
}

/** Every pane of the open items, with what the saver needs of each. */
export function scrollbackPanes(workspace: Workspace): ScrollbackPane[] {
  const found: ScrollbackPane[] = [];
  for (const space of workspace.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        found.push({
          paneId: pane.id,
          itemId: item.id,
          spaceSaves: space.saveScrollback,
          hasFile: pane.scrollbackRef !== undefined,
        });
      }
    }
  }
  return found;
}

export interface ScrollbackSaverOptions {
  backend: Pick<Backend, "saveScrollback" | "deleteScrollback">;
  /** The clock of the 60 seconds; a test moves it by hand. */
  clock: Clock;
  /** Milliseconds between saves. Default 60 seconds. */
  intervalMs?: number;
  /** The panes open now. */
  panes(): ScrollbackPane[];
  /**
   * What the terminal of a pane serializes now (the last lines, as the serialize addon writes them),
   * or `undefined` when the pane has no terminal at the moment (it is tried again later).
   */
  snapshot(paneId: Id): string | undefined;
  /** Whether the settings of the app allow snapshots now. */
  enabled(): boolean;
  /**
   * The pane has a snapshot file (`true`, called before the file is written, so a state saved while
   * the window closes already knows it) or no longer has one (`false`, called once it is removed).
   */
  onFile(pane: ScrollbackPane, has: boolean): void;
  onError?(error: unknown): void;
}

export class ScrollbackSaver {
  readonly #options: ScrollbackSaverOptions;
  /** Panes that had output since their last snapshot was taken. */
  readonly #dirty = new Set<Id>();
  /** The save of each pane that is in flight, so the next one waits for it. */
  readonly #saving = new Map<Id, Promise<void>>();
  #cancel: (() => void) | undefined;

  constructor(options: ScrollbackSaverOptions) {
    this.#options = options;
  }

  /** The pane printed something: its next save is due. */
  noteActivity(paneId: Id): void {
    this.#dirty.add(paneId);
  }

  /** Panes that would be saved by the next `flush` (before it checks what the settings allow). */
  get dirtyPaneIds(): readonly Id[] {
    return [...this.#dirty];
  }

  /** Starts the saves every `intervalMs`. Starting a saver that is running changes nothing. */
  start(): void {
    if (this.#cancel !== undefined) return;
    const interval = this.#options.intervalMs ?? SCROLLBACK_SAVE_INTERVAL_MS;
    const schedule = (): void => {
      this.#cancel = this.#options.clock.setTimer(() => {
        // The next one is set first, so the cadence does not depend on how long a save takes.
        schedule();
        void this.flush();
      }, interval);
    };
    schedule();
  }

  /** Stops the saves. What is in flight still finishes. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /**
   * Saves every pane that had activity since its last snapshot (and removes the files of the panes
   * the settings no longer allow). All the writes are started at once, before any of them is
   * waited for: the window closing may not give the later ones the time. Never rejects; a pane that
   * failed stays due and goes to `onError`.
   */
  flush(): Promise<void> {
    return Promise.all(this.#options.panes().map((pane) => this.#queue(pane))).then(
      () => undefined,
    );
  }

  /**
   * Saves a pane at once, with the lines its terminal had (`raw`, as the serialize addon wrote
   * them; `undefined` when the terminal could not be asked), even though the pane is not in the
   * list of open ones any more: this is how the scrollback of a tab that was just closed is kept.
   * The same rules apply as for the saves of every minute (settings, space, nothing to keep when the
   * terminal is empty), and it waits for a save of the same pane that is in flight. Never rejects.
   */
  saveNow(pane: ScrollbackPane, raw: string | undefined): Promise<void> {
    this.#dirty.add(pane.paneId);
    return this.#queue(pane, () => raw);
  }

  /** Removes the file of a pane that is gone for good (after any save of it that is in flight). Never rejects. */
  discard(paneId: Id): Promise<void> {
    this.#dirty.delete(paneId);
    const pane: ScrollbackPane = { paneId, itemId: "", spaceSaves: false, hasFile: false };
    return this.#queue(
      pane,
      () => undefined,
      async () => {
        try {
          await this.#options.backend.deleteScrollback(paneId);
        } catch (error) {
          this.#options.onError?.(error);
        }
      },
    );
  }

  #queue(
    pane: ScrollbackPane,
    snapshot: () => string | undefined = () => this.#options.snapshot(pane.paneId),
    job: () => Promise<void> = () => this.#handle(pane, snapshot),
  ): Promise<void> {
    const previous = this.#saving.get(pane.paneId);
    // Nothing in flight: the work starts now, not on the next turn of the event loop.
    const run = previous === undefined ? job() : previous.then(job);
    const tracked = run.finally(() => {
      if (this.#saving.get(pane.paneId) === tracked) this.#saving.delete(pane.paneId);
    });
    this.#saving.set(pane.paneId, tracked);
    return tracked;
  }

  async #handle(pane: ScrollbackPane, snapshot: () => string | undefined): Promise<void> {
    const { paneId } = pane;
    const options = this.#options;
    try {
      if (!savesScrollback(options.enabled(), pane.spaceSaves)) {
        // Nothing is written, and the file saved before goes.
        this.#dirty.delete(paneId);
        if (pane.hasFile) await this.#remove(pane);
        return;
      }
      if (!this.#dirty.has(paneId) || !isScrollbackPaneId(paneId)) return;
      const raw = snapshot();
      if (raw === undefined) return;
      const text = cleanSnapshot(raw);
      // A terminal with nothing in it is a terminal that has not got its text yet (it was just
      // made again, or what it was told to show is still being written), not one whose history
      // should go: the file from before stays, and the pane stays due.
      if (text === "") return;
      // Output that arrives while the file is written makes the pane due again.
      this.#dirty.delete(paneId);
      if (!pane.hasFile) options.onFile(pane, true);
      await options.backend.saveScrollback(paneId, text);
    } catch (error) {
      this.#dirty.add(paneId);
      options.onError?.(error);
    }
  }

  async #remove(pane: ScrollbackPane): Promise<void> {
    await this.#options.backend.deleteScrollback(pane.paneId);
    this.#options.onFile(pane, false);
  }
}

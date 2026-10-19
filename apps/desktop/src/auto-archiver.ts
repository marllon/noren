import { ARCHIVE_CHECK_INTERVAL_MS, idleItems, layoutPanes } from "@noren/model";
import type { Action, ArchiveSettings, Clock, Id, Workspace } from "@noren/model";
import { activeItemIdOf } from "./workspace-store";

// The auto-archive: every minute it looks for open tabs that nobody is using and puts them in the
// archive (`item/archive`), which keeps their place and, through the scrollback service, their
// output. What counts as idle is `idleItems` in the model; this only keeps the sign of life of
// each tab while the app runs and asks on a timer. The clock, the workspace, the settings and
// `dispatch` are all handed in, so the rules are tested with none of the real ones.
//
// - A tab is alive while its panes print (`noteActivity`) and while it is the one on screen.
// - The idle time counts from the app opening at the earliest: tabs left from a long time ago
//   are not archived a minute after the app starts, since nothing was said about them since.

export interface AutoArchiverOptions {
  /** The timers of the checks and the moment they happen at (the timeline of `lastActivityAt`). */
  clock: Clock;
  /** The workspace now. */
  workspace(): Workspace;
  /** The settings now; read at every check, so a changed file applies at once. */
  settings(): ArchiveSettings;
  /** Runs an action on the workspace (`item/archive`). */
  dispatch(action: Action): void;
  /** Milliseconds between checks. Default one minute. */
  intervalMs?: number;
  onError?(error: unknown): void;
}

export class AutoArchiver {
  readonly #options: AutoArchiverOptions;
  /** When each pane last printed, until the next check turns it into the sign of life of its tab. */
  readonly #printed = new Map<Id, number>();
  /** The last sign of life of each tab, by item id. */
  readonly #seen = new Map<Id, number>();
  readonly #since: number;
  #cancel: (() => void) | undefined;

  constructor(options: AutoArchiverOptions) {
    this.#options = options;
    this.#since = options.clock.now();
  }

  /** A pane printed something. */
  noteActivity(paneId: Id): void {
    this.#printed.set(paneId, this.#options.clock.now());
  }

  /** Starts the checks every `intervalMs`. Starting an archiver that is running changes nothing. */
  start(): void {
    if (this.#cancel !== undefined) return;
    const interval = this.#options.intervalMs ?? ARCHIVE_CHECK_INTERVAL_MS;
    const schedule = (): void => {
      this.#cancel = this.#options.clock.setTimer(() => {
        // The next one is set first, so the cadence does not depend on how long a check takes.
        schedule();
        this.check();
      }, interval);
    };
    schedule();
  }

  /** Stops the checks. */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /**
   * Looks for idle tabs now and archives them. Returns the ids it archived. Never throws; a failure
   * goes to `onError`. With the auto-archive off nothing is archived, but the signs of life are
   * still kept, so turning it on does not archive what was in use a moment ago.
   */
  check(): Id[] {
    const options = this.#options;
    try {
      const now = options.clock.now();
      const workspace = options.workspace();
      this.#absorb(workspace, now);
      const settings = options.settings();
      if (!settings.enabled) return [];
      const idle = idleItems(workspace, {
        now,
        afterMs: settings.afterMs,
        shownItemId: shownItemId(workspace),
        seen: this.#seen,
        since: this.#since,
      });
      for (const { itemId } of idle) {
        options.dispatch({ type: "item/archive", itemId });
        this.#seen.delete(itemId);
      }
      return idle.map((entry) => entry.itemId);
    } catch (error) {
      options.onError?.(error);
      return [];
    }
  }

  /** Turns what the panes printed, and the tab on screen, into the signs of life of the tabs. */
  #absorb(workspace: Workspace, now: number): void {
    const open = new Set<Id>();
    const shown = shownItemId(workspace);
    for (const space of workspace.spaces) {
      for (const item of Object.values(space.items)) {
        open.add(item.id);
        let latest = item.id === shown ? now : -Infinity;
        for (const pane of layoutPanes(item.layout)) {
          latest = Math.max(latest, this.#printed.get(pane.id) ?? -Infinity);
        }
        if (latest > (this.#seen.get(item.id) ?? -Infinity)) this.#seen.set(item.id, latest);
      }
    }
    this.#printed.clear();
    // A tab that is gone (closed, archived, moved out) leaves nothing behind.
    for (const itemId of [...this.#seen.keys()]) if (!open.has(itemId)) this.#seen.delete(itemId);
  }
}

/** The tab the active space shows, or `undefined` when there is none. */
function shownItemId(workspace: Workspace): Id | undefined {
  try {
    return activeItemIdOf({ workspace });
  } catch {
    return undefined;
  }
}

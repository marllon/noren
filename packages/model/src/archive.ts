import { layoutPanes } from "./sessions";
import type { Id, Item, Workspace } from "./types";

// The auto-archive: which open items have been idle long enough to be put away in the archive.
// Pure: it reads a workspace and a moment, and answers with item ids. The scheduler that asks every
// minute (and dispatches `item/archive`) lives in the interface; the clock is the caller's.

/** Items are put in the archive unless the settings say they never are. */
export const DEFAULT_ARCHIVE_ENABLED = true;

/** How long an item is left alone before it is archived, in hours. */
export const DEFAULT_ARCHIVE_AFTER_HOURS = 12;

/** How often the idle items are looked for, in milliseconds. */
export const ARCHIVE_CHECK_INTERVAL_MS = 60_000;

const HOUR_MS = 3_600_000;

/** What the settings say about the auto-archive, in the units the check works in. */
export interface ArchiveSettings {
  enabled: boolean;
  /** Milliseconds without activity after which an item is idle. Always positive. */
  afterMs: number;
}

/**
 * The auto-archive settings in force from the `archive` section of the settings file (absent keys
 * take the defaults). A number of hours that is not positive and finite falls back to the default,
 * so a bad value never archives everything at once.
 */
export function archiveSettingsOf(
  section: { enabled?: boolean | undefined; afterHours?: number | undefined } | undefined,
): ArchiveSettings {
  const hours = section?.afterHours;
  const usable = typeof hours === "number" && Number.isFinite(hours) && hours > 0;
  return {
    enabled: section?.enabled ?? DEFAULT_ARCHIVE_ENABLED,
    afterMs: (usable ? hours : DEFAULT_ARCHIVE_AFTER_HOURS) * HOUR_MS,
  };
}

/** An item the check would put away: where it is. */
export interface IdleItem {
  spaceId: Id;
  itemId: Id;
}

export interface IdleCheck {
  /** The moment of the check, on the timeline of `Item.lastActivityAt`. */
  now: number;
  /** Milliseconds without activity after which an item is idle. */
  afterMs: number;
  /** The item on screen (the one the active space shows): the person is looking at it. */
  shownItemId?: Id | undefined;
  /**
   * The last sign of life seen of each item while the app ran (its panes printed, or it was on
   * screen), on the same timeline. It counts when it is later than `Item.lastActivityAt`, which
   * only knows when the item was made, restored or reset.
   */
  seen?: ReadonlyMap<Id, number> | undefined;
  /**
   * The moment the app opened: no item counts as idle for any time before it, so an app that was
   * closed for days does not archive every tab a minute after it opens.
   */
  since?: number | undefined;
}

/** The last moment the item showed a sign of life, as far as the check knows. */
function lastActivity(item: Item, check: IdleCheck): number {
  return Math.max(
    item.lastActivityAt,
    check.seen?.get(item.id) ?? -Infinity,
    check.since ?? -Infinity,
  );
}

/**
 * Whether something is going on in the item that the archive must not cut off: a command is running
 * in one of its panes (the shell said so through OSC 133, or the pane is marked running), or a pane
 * has an unread mark or a bell nobody has looked at.
 */
export function itemInUse(item: Item): boolean {
  return layoutPanes(item.layout).some(
    (pane) =>
      pane.status === "running" || pane.runningCommand !== undefined || pane.unread || pane.bell,
  );
}

/**
 * The open items that are idle: not pinned, not a favorite, not on screen, with no command running
 * (and nothing unread), and with no activity (the latest of `lastActivityAt`, what `seen` says and
 * `since`) for `afterMs`. In the order of the spaces. Never throws, whatever the workspace holds.
 */
export function idleItems(ws: Workspace, check: IdleCheck): IdleItem[] {
  if (!Number.isFinite(check.now) || !(check.afterMs > 0)) return [];
  const favorites = new Set(ws.favorites);
  const idle: IdleItem[] = [];
  for (const space of ws.spaces) {
    const pinned = new Set(space.pinned);
    for (const item of Object.values(space.items)) {
      if (pinned.has(item.id) || favorites.has(item.id) || item.id === check.shownItemId) continue;
      if (itemInUse(item)) continue;
      if (check.now - lastActivity(item, check) < check.afterMs) continue;
      idle.push({ spaceId: space.id, itemId: item.id });
    }
  }
  return idle;
}

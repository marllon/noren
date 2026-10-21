import type { Id } from "@noren/model";
import type { TreeRow } from "./sidebar-tree";

// The keyboard rules of the sidebar tree (the ARIA tree pattern): which row a key moves to, which
// row folds or unfolds, and where the focus goes when a row goes away. Pure; the component only
// reads the DOM and calls `focus()`.

/**
 * What a row of the tree is: a group header, a tab, a pane of an unfolded split tab, or an entry of
 * a live group (NOR-F17-04b; not a tab).
 */
export type NavKind = "group" | "item" | "pane" | "entry";

/** A row of the tree as the keyboard sees it, in the order shown. */
export interface NavEntry {
  /** Unique among the rows, and stable while the row exists (`data-tree-key` in the DOM). */
  key: string;
  kind: NavKind;
  id: Id;
  /** `aria-level`: 1 for the top rows, one more for each group or split tab above. */
  level: number;
  /** `aria-setsize` and `aria-posinset`: the siblings under the same parent, and the place among them. */
  setSize: number;
  posInSet: number;
  /** The key of the group or tab this row sits under; undefined for the top rows. */
  parentKey: string | undefined;
  /** `aria-expanded`: set on groups and split tabs, undefined on rows that cannot fold. */
  expanded: boolean | undefined;
}

export const groupKey = (groupId: Id): string => `g:${groupId}`;
export const itemKey = (itemId: Id): string => `i:${itemId}`;
export const paneKey = (paneId: Id): string => `p:${paneId}`;
export const liveKey = (groupId: Id, key: string): string => `l:${groupId}:${key}`;

/** The panes a split tab lists: undefined for a tab that is not a split, `expanded` false when folded. */
export interface SplitPanes {
  paneIds: readonly Id[];
  expanded: boolean;
}

/**
 * The rows of the tree for the keyboard. `rows` are the visible rows of the sidebar (pinned tabs
 * first, then the tree); a group's children follow it with one more depth. `panesOf` says which tabs
 * are split and whether their pane list is open. `liveOf` gives the keys of the entries a live group
 * lists (none for any other group): they come right after the group row, before its tabs, and are
 * left out when the group is folded.
 */
export function buildNav(
  rows: readonly TreeRow[],
  panesOf: (itemId: Id) => SplitPanes | undefined,
  liveOf: (groupId: Id) => readonly string[] = () => [],
): NavEntry[] {
  const entries: NavEntry[] = [];
  // The set each group or tab belongs to: the Pinned list, or the group (or the root) it sits in.
  const setOf: (string | undefined)[] = [];
  // The group headers above the current row, by depth.
  const groups: string[] = [];
  for (const row of rows) {
    groups.length = row.depth;
    const pinned = row.kind === "item" && row.pinned;
    const parentKey = pinned ? undefined : groups[row.depth - 1];
    const level = row.depth + 1;
    const base = { level, setSize: 0, posInSet: 0, parentKey };
    setOf.push(pinned ? "pinned" : parentKey);
    if (row.kind === "group") {
      const key = groupKey(row.group.id);
      entries.push({
        ...base,
        key,
        kind: "group",
        id: row.group.id,
        expanded: !row.group.collapsed,
      });
      groups[row.depth] = key;
      if (row.group.collapsed) continue;
      const live = liveOf(row.group.id);
      live.forEach((entryKey, index) => {
        entries.push({
          key: liveKey(row.group.id, entryKey),
          kind: "entry",
          id: entryKey,
          level: level + 1,
          setSize: live.length,
          posInSet: index + 1,
          parentKey: key,
          expanded: undefined,
        });
        setOf.push(undefined);
      });
      continue;
    }
    const key = itemKey(row.id);
    const split = panesOf(row.id);
    entries.push({ ...base, key, kind: "item", id: row.id, expanded: split?.expanded });
    if (split?.expanded !== true) continue;
    split.paneIds.forEach((paneId, index) => {
      entries.push({
        key: paneKey(paneId),
        kind: "pane",
        id: paneId,
        level: level + 1,
        setSize: split.paneIds.length,
        posInSet: index + 1,
        parentKey: key,
        expanded: undefined,
      });
      setOf.push(undefined);
    });
  }
  // The size of a set and the place in it are known once every row has been seen.
  const counts = new Map<string | undefined, number>();
  entries.forEach((entry, index) => {
    if (entry.kind === "pane" || entry.kind === "entry") return;
    const set = setOf[index];
    counts.set(set, (counts.get(set) ?? 0) + 1);
    entry.posInSet = counts.get(set) ?? 1;
  });
  return entries.map((entry, index) =>
    entry.kind === "pane" || entry.kind === "entry"
      ? entry
      : { ...entry, setSize: counts.get(setOf[index]) ?? 1 },
  );
}

/** What a key does to the tree: put the focus on a row, or fold or unfold the row that has it. */
export type TreeKeyAction =
  | { type: "focus"; key: string }
  | { type: "expand"; key: string }
  | { type: "collapse"; key: string };

/**
 * The effect of `key` (a `KeyboardEvent.key`) with the focus on row `current`; undefined when the
 * key means nothing there (the first row has nothing above it, a tab has nothing to unfold) or is
 * not one of the tree keys.
 *
 * Up and Down step to the neighbor row, Home and End jump to the ends. Right unfolds a folded row,
 * and on an unfolded one goes to its first child. Left folds an unfolded row, and on any other
 * goes to its parent.
 */
export function treeKeyAction(
  entries: readonly NavEntry[],
  current: string,
  key: string,
): TreeKeyAction | undefined {
  const at = entries.findIndex((entry) => entry.key === current);
  const entry = entries[at];
  if (entry === undefined) return undefined;
  const focus = (target: NavEntry | undefined): TreeKeyAction | undefined =>
    target === undefined ? undefined : { type: "focus", key: target.key };
  switch (key) {
    case "ArrowDown":
      return focus(entries[at + 1]);
    case "ArrowUp":
      return focus(entries[at - 1]);
    case "Home":
      return focus(entries[0]);
    case "End":
      return focus(entries.at(-1));
    case "ArrowRight": {
      if (entry.expanded === false) return { type: "expand", key: entry.key };
      if (entry.expanded === true) {
        const child = entries[at + 1];
        return child?.parentKey === entry.key ? focus(child) : undefined;
      }
      return undefined;
    }
    case "ArrowLeft": {
      if (entry.expanded === true) return { type: "collapse", key: entry.key };
      return focus(entries.find((candidate) => candidate.key === entry.parentKey));
    }
    default:
      return undefined;
  }
}

/**
 * Where the focus goes when the rows `removed` leave the tree (a tab closed, a group dissolved):
 * the first row after `current` that stays, else the last one before it; undefined when none stays.
 */
export function focusAfterRemoval(
  entries: readonly NavEntry[],
  current: string,
  removed: ReadonlySet<string>,
): string | undefined {
  const at = entries.findIndex((entry) => entry.key === current);
  if (at < 0) return undefined;
  const stays = (entry: NavEntry) => !removed.has(entry.key);
  const after = entries.slice(at + 1).find(stays);
  if (after !== undefined) return after.key;
  return entries.slice(0, at).findLast(stays)?.key;
}

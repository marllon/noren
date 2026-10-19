// The most-recently-used list behind the Ctrl+Tab switcher. Pure: the shell keeps the list in
// memory (it is not saved) and feeds it the tab on screen; this module only orders ids.

import type { Id, Workspace } from "@noren/model";
import { spaceItemIds } from "./workspace-store";

/** How many lines of a tab's output the switcher shows under its name. */
export const PREVIEW_LINES = 5;

/** Tab ids, the most recently used first. */
export type MruList = readonly Id[];

/** Moves a tab to the front (it is put there if the list did not hold it). */
export function touchMru(list: MruList, id: Id): Id[] {
  return [id, ...list.filter((other) => other !== id)];
}

/** Drops the tabs that are not open any more. */
export function pruneMru(list: MruList, existing: ReadonlySet<Id>): Id[] {
  return list.filter((id) => existing.has(id));
}

/** Every open tab of every space, in the order of the switcher and the sidebar. */
export function allTabIds(workspace: Pick<Workspace, "spaces">): Id[] {
  return workspace.spaces.flatMap((space) => spaceItemIds(space));
}

/** The tab on screen: the active tab of the active space. */
export function currentTabId(
  workspace: Pick<Workspace, "spaces" | "activeSpaceId">,
): Id | undefined {
  const space =
    workspace.spaces.find((s) => s.id === workspace.activeSpaceId) ?? workspace.spaces[0];
  if (space === undefined) return undefined;
  const chosen = space.activeItemId;
  if (chosen !== undefined && space.items[chosen] !== undefined) return chosen;
  return spaceItemIds(space)[0];
}

/**
 * The list after the workspace changed: closed tabs drop out and the tab on screen goes to the
 * front. Returns the same array when nothing changed, so the caller can tell.
 */
export function trackMru(list: MruList, workspace: Workspace): MruList {
  const existing = new Set(allTabIds(workspace));
  const current = currentTabId(workspace);
  const pruned = pruneMru(list, existing);
  const next = current !== undefined ? touchMru(pruned, current) : pruned;
  return next.length === list.length && next.every((id, index) => id === list[index]) ? list : next;
}

/**
 * The tabs in the order the switcher walks them: the tab on screen first, then the others by recent
 * use, then the ones never seen (a tab opened in a space nobody looked at) in the sidebar order.
 */
export function switcherOrder(list: MruList, workspace: Workspace): Id[] {
  const all = allTabIds(workspace);
  const existing = new Set(all);
  const current = currentTabId(workspace);
  const used = pruneMru(list, existing).filter((id) => id !== current);
  const seen = new Set(used);
  const unused = all.filter((id) => id !== current && !seen.has(id));
  return [...(current !== undefined ? [current] : []), ...used, ...unused];
}

/** The position after `delta` steps in a ring of `length` (wraps at both ends). */
export function stepIndex(length: number, index: number, delta: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** The last non-empty lines of a terminal buffer, oldest first. */
export function previewLines(lines: readonly string[], count: number = PREVIEW_LINES): string[] {
  return lines.filter((line) => line.trim() !== "").slice(-count);
}

// The folders the shells reported through OSC 7, most recent first, for the palette. Pure: the
// interface keeps the list and `loadRecentFolders`/`saveRecentFolders` move it to the browser
// storage.
//
// Provisional storage: the browser's `localStorage` under `noren.ui.recent-folders`, until the
// settings file of NOR-F8-01 takes over.

import { sameFolder } from "@noren/model";

/** Key of the recent folders in the browser storage. */
export const RECENT_FOLDERS_KEY = "noren.ui.recent-folders";

/** How many folders are kept; the oldest leave first. */
export const MAX_RECENT_FOLDERS = 200;

/**
 * The list with `path` at the front. A folder already in the list (same folder as deep links
 * compare: separator, trailing slash and, for Windows paths, case do not count) moves to the front,
 * in the spelling of the latest report. The list is cut to `MAX_RECENT_FOLDERS`. A blank path, or a folder
 * that is already first, gives back the same list.
 */
export function addRecentFolder(list: readonly string[], path: string): readonly string[] {
  if (path.trim() === "") return list;
  const first = list[0];
  if (first !== undefined && sameFolder(first, path)) return list;
  const rest = list.filter((folder) => !sameFolder(folder, path));
  return [path, ...rest].slice(0, MAX_RECENT_FOLDERS);
}

/**
 * Reads the saved list. Anything that is not a list of text (no value, broken JSON, another shape)
 * reads as empty; blank entries and repeats of a folder are dropped, the list is cut to the maximum.
 */
export function parseRecentFolders(raw: string | null): string[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  let list: readonly string[] = [];
  // Saved most recent first: adding from the oldest end keeps that order and drops later repeats.
  for (const folder of [...(value as unknown[])].reverse()) {
    if (typeof folder === "string") list = addRecentFolder(list, folder);
  }
  return [...list];
}

/** The part of the browser storage the list needs (so tests can hand in a plain object). */
export interface RecentFoldersStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved list, or empty when there is none, the storage is missing or it throws. */
export function loadRecentFolders(storage: RecentFoldersStorage | undefined): string[] {
  try {
    return parseRecentFolders(storage?.getItem(RECENT_FOLDERS_KEY) ?? null);
  } catch {
    return [];
  }
}

/** Saves the list; a storage that refuses (full, blocked) is ignored, the list lasts for this page. */
export function saveRecentFolders(
  storage: RecentFoldersStorage | undefined,
  list: readonly string[],
): void {
  try {
    storage?.setItem(RECENT_FOLDERS_KEY, JSON.stringify(list));
  } catch {
    // The folders only last until the page closes.
  }
}

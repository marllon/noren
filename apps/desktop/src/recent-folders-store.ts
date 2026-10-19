import { addRecentFolder, loadRecentFolders, saveRecentFolders } from "./recent-folders";

// The recent folders, shared by every terminal (they report into it) and the palette (it reads
// when it opens). Provisional until the settings file (NOR-F8-01) owns them: a new folder is saved
// to the browser storage right away.

let current: readonly string[] | undefined;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** The recent folders, most recent first. */
export function recentFolders(): readonly string[] {
  current ??= loadRecentFolders(storage());
  return current;
}

/** Notes that a shell reported this folder: it goes to the front of the list and is saved. */
export function recordFolder(path: string): void {
  const next = addRecentFolder(recentFolders(), path);
  if (next === current) return;
  current = next;
  saveRecentFolders(storage(), next);
}

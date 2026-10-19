import { useSyncExternalStore } from "react";
import type { Backend, ModFile } from "@noren/model";

// The mod files of the user (the CSS files of the `mods/` folder next to `config.jsonc`) as the
// backend last listed them. `boot.ts` starts it before the first frame, so the first frame already
// has the mods that are on; after that the backend tells when a file is added, edited or removed
// and the list is replaced, which is how a mod reloads while the app runs. Which of them are on is
// not decided here (`use-mods.ts`).

const listeners = new Set<() => void>();
let files: readonly ModFile[] = [];
let stopWatching: (() => void) | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function sameFiles(a: readonly ModFile[], b: readonly ModFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((file, index) => file.name === b[index]?.name && file.text === b[index]?.text)
  );
}

/** Replaces the list. A list equal to the one held changes nothing, so no view renders again. */
export function setModFiles(next: readonly ModFile[]): void {
  if (sameFiles(files, next)) return;
  files = next;
  notify();
}

/** The mod files now. Replaced, never changed, so a view can compare it by identity. */
export function getModFiles(): readonly ModFile[] {
  return files;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The mod files; the component renders again when they change. */
export function useModFiles(): readonly ModFile[] {
  return useSyncExternalStore(subscribe, getModFiles);
}

/**
 * Watches the mods folder through the backend, then lists it, and resolves once the list is in. A
 * change the watcher delivers while the first list is on its way is newer than that list and wins.
 * Never rejects: a folder that cannot be read leaves the list as it was (no mods at the start). Calling
 * it again follows the new backend and drops the old watching.
 */
export async function startMods(backend: Pick<Backend, "listMods" | "watchMods">): Promise<void> {
  stopWatching?.();
  let heard = false;
  let stopped = false;
  const unwatch = backend.watchMods((next) => {
    if (stopped) return;
    heard = true;
    setModFiles(next);
  });
  stopWatching = () => {
    stopped = true;
    unwatch();
  };
  try {
    const listed = await backend.listMods();
    if (!stopped && !heard) setModFiles(listed);
  } catch {
    // The folder cannot be read: the app goes on without mods, and the watcher may still report.
  }
}

/** Stops watching and forgets the files, so a test starts from nothing. */
export function resetMods(): void {
  stopWatching?.();
  stopWatching = undefined;
  setModFiles([]);
}

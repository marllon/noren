import { useSyncExternalStore } from "react";
import type { Backend } from "@noren/model";

// The picture behind the terminals, as the page can show it. The backend reads the file (it is the
// side that may open files; `Backend.readBackgroundImage`) and hands over the bytes, which become a
// `blob:` address that lives in this page: the page is never given a path or a web address to
// fetch, so showing a background cannot reach the network. A few pictures are kept, so switching
// between spaces that share one does not read the file again.

/** What the window has of its picture. */
export type PictureState =
  | { status: "none" }
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; url: string }
  | { status: "failed"; path: string; message: string };

const NONE: PictureState = { status: "none" };
/** Pictures kept at once (the one in use and the ones of the last spaces). */
const KEPT = 4;

const listeners = new Set<() => void>();
let backend: Pick<Backend, "readBackgroundImage"> | undefined;
let state: PictureState = NONE;
/** The path the window wants; an answer for another path is for a request that is out of date. */
let wanted: string | null = null;
/** Whether `wanted` is waiting for the backend, which the app hands over a little after the window starts. */
let waiting = false;
/** `blob:` addresses by path, oldest first. */
const kept = new Map<string, string>();

function set(next: PictureState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function keep(path: string, url: string): void {
  kept.delete(path);
  kept.set(path, url);
  for (const [oldPath, oldUrl] of kept) {
    if (kept.size <= KEPT) break;
    if (oldPath === wanted) continue;
    URL.revokeObjectURL(oldUrl);
    kept.delete(oldPath);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gives the store the backend that reads the files. A picture the window already asked for (the
 * settings are read first, and the window asks for the picture they name as soon as it has them,
 * which can be before the app gets here) is read now.
 */
export function startBackgroundImages(source: Pick<Backend, "readBackgroundImage">): void {
  backend = source;
  if (waiting && wanted !== null) read(wanted);
}

/**
 * Makes `path` (`null`: no picture) the picture of the window. A picture already read shows at
 * once; otherwise the state is `loading` until the backend answers (and until the app hands the
 * store its backend, for a path asked for before that), and `failed` with a sentence when it cannot
 * (the file is gone, it is not a picture, the path is refused). Asking for the path that is already
 * wanted changes nothing.
 */
export function showBackgroundImage(path: string | null): void {
  if (path === wanted) return;
  wanted = path;
  waiting = false;
  if (path === null) {
    set(NONE);
    return;
  }
  const url = kept.get(path);
  if (url !== undefined) {
    keep(path, url);
    set({ status: "ready", path, url });
    return;
  }
  read(path);
}

/** Asks the backend for `path`, or waits for it (`startBackgroundImages`) when the app has none yet. */
function read(path: string): void {
  set({ status: "loading", path });
  if (backend === undefined) {
    waiting = true;
    return;
  }
  waiting = false;
  backend.readBackgroundImage(path).then(
    (file) => {
      const address = URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mime }));
      keep(path, address);
      // An answer for a path the window no longer wants is kept for later and not shown.
      if (wanted === path) set({ status: "ready", path, url: address });
    },
    (error: unknown) => {
      if (wanted === path) set({ status: "failed", path, message: reasonOf(error) });
    },
  );
}

/** The state of the picture now. Replaced, never changed, so a view can compare it by identity. */
export function getPicture(): PictureState {
  return state;
}

/** The state of the picture; the component renders again when it changes. */
export function usePicture(): PictureState {
  return useSyncExternalStore(subscribe, getPicture);
}

/** The `blob:` address of the picture when it is on screen, else `null`. */
export function pictureUrl(picture: PictureState): string | null {
  return picture.status === "ready" ? picture.url : null;
}

/** Forgets the pictures and the backend, so a test starts from nothing. */
export function resetBackgroundImages(): void {
  for (const url of kept.values()) URL.revokeObjectURL(url);
  kept.clear();
  backend = undefined;
  wanted = null;
  waiting = false;
  set(NONE);
}

import {
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  PREVIEW_REFUSALS,
  decodeGitDiff,
  findWindow,
  layoutPanes,
  parseState,
  sniffPreviewImage,
  treeGroups,
  workspaceWindows,
} from "@noren/model";
import type {
  Action,
  Backend,
  FilePreview,
  Id,
  Placement,
  PreviewImageMime,
  PreviewRefusal,
  PreviewTextKind,
  Space,
  Workspace,
} from "@noren/model";
import type { QuickEvents } from "./quick";
import { WINDOW_READY_EVENT, requestOfPayload, windowIdOfPayload } from "./window-events";

// How the page of a window besides the main one learns what to draw, and how it asks for a change.
// The main window owns the workspace and is the only page that loads and saves it (`state.json`):
// it sends each window the space the window shows (`window-state`), and a window asks for the few
// changes it can make on its own (`window-action`: show another tab, focus a pane, resize a split,
// open a tab, close a tab, move a tab), which the main window checks and carries out. The page of a
// window never holds the workspace and never writes anything. A window cannot read a file or run
// git either (its capability has no such command): a preview or diff pane of the window asks the
// main window for the read (`window-read`), which checks that the pane is one of the window's and
// that the path or folder is the pane's own, reads it, and answers that window
// (`window-read-result`). The names are repeated in `src-tauri/src/windows.rs` and in the smoke.

/** Main window → window pages: the space the window shows, `{ windowId, space }`. */
export const WINDOW_STATE_EVENT = "window-state";
/** Window page → main window: a change the window asks for, `{ windowId, action }`. */
export const WINDOW_ACTION_EVENT = "window-action";
/**
 * Window page → main window: a file or a git diff a pane of the window needs,
 * `{ windowId, request, kind: "preview", itemId, paneId, path }` or
 * `{ windowId, request, kind: "diff", itemId, paneId, cwd }`.
 */
export const WINDOW_READ_EVENT = "window-read";
/**
 * Main window → window pages: what a read found, `{ windowId, request, kind: "preview", preview }`,
 * `{ windowId, request, kind: "diff", diff }`, or `{ windowId, request, failed }` when the read
 * itself failed. `request` is the number the read came with; a page keeps only the answers for its
 * own `windowId` and for a read it is waiting on.
 */
export const WINDOW_READ_RESULT_EVENT = "window-read-result";

/**
 * The changes a window page can ask for, and nothing else. Every tab named is a tab of the space
 * the window shows (the main window checks), and a new tab is always made in that space.
 */
export type WindowAction =
  | { type: "space/set-active-item"; spaceId: Id; itemId: Id }
  | { type: "pane/focus"; itemId: Id; paneId: Id }
  | { type: "pane/resize"; itemId: Id; path: number[]; sizes: number[] }
  /** A new tab with a new shell, in the space of the window. */
  | { type: "item/create"; spaceId: Id }
  /** Closes the tab and ends its shells. */
  | { type: "item/close"; itemId: Id }
  /** Moves the tab inside the space of the window (the order of the sidebar). */
  | { type: "item/move"; itemId: Id; placement: Placement };

/** The deepest split and the most children a request about a resize may name. */
const MAX_SPLIT_DEPTH = 16;
const MAX_SPLIT_CHILDREN = 16;
/**
 * The most tabs the space of a window may hold for it to open another: a window that asked for
 * shells without end would fill the machine. Generous (a person does not open this many by hand).
 */
export const MAX_WINDOW_TABS = 64;
/** The furthest place in a list a request to move a tab may name. */
const MAX_TAB_INDEX = 4096;

/** The payload of `window-state` for the window `windowId` showing `space`. */
export function windowStatePayload(windowId: Id, space: Space): { windowId: Id; space: Space } {
  return { windowId, space };
}

/**
 * The space a `window-state` event carries for the window `windowId`, or `undefined` for an event
 * for another window or one that does not carry a space the model accepts. An event can carry
 * whatever a page sent, so the space is read the way a saved state is: its shape and its
 * invariants (the ids, the tree, the panes) are checked before anything draws it.
 */
export function spaceOfWindowState(payload: unknown, windowId: Id): Space | undefined {
  if (windowIdOfPayload(payload) !== windowId) return undefined;
  const space = (payload as { space?: unknown }).space;
  if (typeof space !== "object" || space === null) return undefined;
  const alone = {
    version: 2,
    spaces: [space],
    activeSpaceId: (space as { id?: unknown }).id,
    favorites: [],
    closed: [],
    archive: [],
  };
  const read = parseState(JSON.stringify(alone));
  return read.ok ? read.workspace.spaces[0] : undefined;
}

const wholeNumbers = (value: unknown, max: number): number[] | undefined =>
  Array.isArray(value) &&
  value.length <= max &&
  (value as unknown[]).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
    ? (value as number[])
    : undefined;

/**
 * The place a request names for a tab, checked against the space of the window and made again from
 * the fields that were checked: the pinned list or the tree, a group that is in the tree of the
 * space, a place that is a whole number. `undefined` for anything else.
 */
function placementOfRequest(value: unknown, space: Space): Placement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { to, groupId, index } = value as Record<string, unknown>;
  if (index !== undefined) {
    if (typeof index !== "number" || !Number.isSafeInteger(index)) return undefined;
    if (index < 0 || index > MAX_TAB_INDEX) return undefined;
  }
  const at = typeof index === "number" ? { index } : {};
  if (to === "pinned") return groupId === undefined ? { to, ...at } : undefined;
  if (to !== "tree") return undefined;
  if (groupId === undefined) return { to, ...at };
  if (typeof groupId !== "string" || !treeGroups(space.tree).some((g) => g.id === groupId)) {
    return undefined;
  }
  return { to, groupId, ...at };
}

/**
 * The action a `window-action` event asks for, as the workspace would run it, or `undefined` when
 * the event is not for a window of the workspace, names a tab that the space of that window does
 * not hold, or asks for something a window may not ask. Only what a window can do is accepted, and
 * the action is made again from the fields that were checked, so nothing else a page sent gets
 * through.
 */
export function actionOfWindowRequest(payload: unknown, workspace: Workspace): Action | undefined {
  const windowId = windowIdOfPayload(payload);
  if (windowId === undefined) return undefined;
  const window = findWindow(workspace, windowId);
  const space = workspace.spaces.find((s) => s.id === window?.spaceId);
  if (window === undefined || space === undefined) return undefined;
  const request = (payload as { action?: unknown }).action;
  if (typeof request !== "object" || request === null) return undefined;
  const { type, itemId, paneId, spaceId, path, sizes, placement } = request as Record<
    string,
    unknown
  >;
  // A new tab names no tab: it is made in the space of the window, and only while that has room.
  if (type === "item/create") {
    return spaceId === space.id && Object.keys(space.items).length < MAX_WINDOW_TABS
      ? { type, spaceId: space.id }
      : undefined;
  }
  if (typeof itemId !== "string" || !Object.hasOwn(space.items, itemId)) return undefined;
  switch (type) {
    case "space/set-active-item":
      return spaceId === space.id ? { type, spaceId: space.id, itemId } : undefined;
    case "item/close":
      return { type, itemId };
    case "item/move": {
      // Moved inside the space of the window: the action never names another space.
      const where = placementOfRequest(placement, space);
      return where === undefined ? undefined : { type, itemId, placement: where };
    }
    case "pane/focus":
      return typeof paneId === "string" ? { type, itemId, paneId } : undefined;
    case "pane/resize": {
      const where = wholeNumbers(path, MAX_SPLIT_DEPTH);
      const shares = Array.isArray(sizes) ? (sizes as unknown[]) : undefined;
      if (
        where === undefined ||
        shares === undefined ||
        shares.length > MAX_SPLIT_CHILDREN ||
        !shares.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        return undefined;
      }
      return { type, itemId, path: where, sizes: shares as number[] };
    }
    default:
      return undefined;
  }
}

/** The windows besides the main one that the workspace has, with the space each shows. */
function shownSpaces(workspace: Workspace): Map<Id, Space> {
  const shown = new Map<Id, Space>();
  for (const window of workspaceWindows(workspace)) {
    const space = workspace.spaces.find((s) => s.id === window.spaceId);
    if (space !== undefined) shown.set(window.id, space);
  }
  return shown;
}

/** What the main window needs from the store: the workspace, its changes, and the actions. */
export interface WindowSyncStore {
  getState(): { workspace: Workspace; dispatch(action: Action): void };
  subscribe(listener: () => void): () => void;
}

/**
 * What carries out a request that passed the checks. The default dispatches the action; the main
 * window gives one that also starts the shell of a new tab and ends the window of a tab that was
 * the last (`runWindowAction`), which need the backend. It may be asynchronous; it must not throw.
 */
export type WindowActionRunner = (windowId: Id, action: Action) => unknown;

/**
 * Keeps the pages of the windows in step with the workspace (run by the main window): each window
 * gets the space it shows when its page says it is ready (`window-ready`) and again each time that
 * space changes, and the changes the pages ask for (`window-action`) are checked and run (`run`).
 * Returns the function that stops it. Never throws: an event that is not understood is ignored.
 */
export function followWindowPages(
  store: WindowSyncStore,
  events: QuickEvents,
  run: WindowActionRunner = (_windowId, action) => store.getState().dispatch(action),
): () => void {
  // The space each window was last sent: an unchanged space is not sent again.
  const sent = new Map<Id, Space>();
  const send = (windowId: Id, space: Space): void => {
    sent.set(windowId, space);
    events.emit(WINDOW_STATE_EVENT, windowStatePayload(windowId, space)).catch(() => undefined);
  };
  const sendChanged = (): void => {
    const shown = shownSpaces(store.getState().workspace);
    for (const windowId of [...sent.keys()]) if (!shown.has(windowId)) sent.delete(windowId);
    for (const [windowId, space] of shown) if (sent.get(windowId) !== space) send(windowId, space);
  };
  let stopped = false;
  const stops: (() => void)[] = [store.subscribe(sendChanged)];
  const listen = (event: string, handler: (payload: unknown) => void): void => {
    events
      .listen(event, handler)
      .then((stop) => {
        if (stopped) stop();
        else stops.push(stop);
      })
      .catch(() => undefined);
  };
  // A page that just loaded asks for its space, which it may have missed.
  listen(WINDOW_READY_EVENT, (payload) => {
    const windowId = windowIdOfPayload(payload);
    const space =
      windowId === undefined ? undefined : shownSpaces(store.getState().workspace).get(windowId);
    if (windowId !== undefined && space !== undefined) send(windowId, space);
  });
  listen(WINDOW_ACTION_EVENT, (payload) => {
    const windowId = windowIdOfPayload(payload);
    const action = actionOfWindowRequest(payload, store.getState().workspace);
    if (windowId === undefined || action === undefined) return;
    try {
      // A runner that is asynchronous and fails must not leave a rejection nobody reads.
      Promise.resolve(run(windowId, action)).catch(() => undefined);
    } catch {
      // A request that could not be carried out changes nothing.
    }
  });
  // The windows the workspace has now are sent to pages that are up already.
  sendChanged();
  return () => {
    stopped = true;
    for (const stop of stops.splice(0)) stop();
  };
}

// ---- Reads: the file of a preview pane and the git diff of a diff pane ----

/** What a read of a window asks for: the file of a preview pane, or the git diff of a diff pane's folder. */
export type WindowRead =
  | { kind: "preview"; itemId: Id; paneId: Id; path: string }
  | { kind: "diff"; itemId: Id; paneId: Id; cwd: string };

/** The reads of one window the main window carries out at the same time; a request past that is ignored. */
export const MAX_WINDOW_READS = 8;

/** The reads a window page has on their way at the same time; the rest wait their turn on the page. */
const MAX_PAGE_READS = 4;

/** How long a window page waits for the answer to a read before it shows the pane as failed. */
export const WINDOW_READ_TIMEOUT_MS = 30_000;

/** The longest reason of a failed read the page keeps, in UTF-16 units. */
const MAX_FAILED_REASON = 500;

/**
 * The read a `window-read` event asks for, with the window and the number of the request, or
 * `undefined` when the event is not one the main window answers: it is not for a window of the
 * workspace, names a tab that the space of that window does not hold, names a pane that is not in
 * that tab or is not of the kind asked for (a preview read needs a preview pane, a diff read a diff
 * pane), or carries a path or folder that is not the one the pane holds. A window can only have the
 * file or the folder its own pane names read, so what is read is made again from the pane, never
 * from what the event said.
 */
export function readOfWindowRequest(
  payload: unknown,
  workspace: Workspace,
): { windowId: Id; request: number; read: WindowRead } | undefined {
  const windowId = windowIdOfPayload(payload);
  const request = requestOfPayload(payload);
  if (windowId === undefined || request === undefined || request < 1) return undefined;
  const window = findWindow(workspace, windowId);
  const space = workspace.spaces.find((s) => s.id === window?.spaceId);
  if (window === undefined || space === undefined) return undefined;
  const { kind, itemId, paneId, path, cwd } = payload as Record<string, unknown>;
  if (typeof itemId !== "string" || !Object.hasOwn(space.items, itemId)) return undefined;
  const item = space.items[itemId];
  const pane =
    item === undefined ? undefined : layoutPanes(item.layout).find((p) => p.id === paneId);
  if (pane === undefined) return undefined;
  if (kind === "preview") {
    return pane.type === "preview" && pane.path !== undefined && path === pane.path
      ? { windowId, request, read: { kind, itemId, paneId: pane.id, path: pane.path } }
      : undefined;
  }
  if (kind === "diff") {
    return pane.type === "diff" && pane.cwd !== undefined && cwd === pane.cwd
      ? { windowId, request, read: { kind, itemId, paneId: pane.id, cwd: pane.cwd } }
      : undefined;
  }
  return undefined;
}

// What a preview answer looks like on the wire. A picture is bytes and an event carries JSON, so the
// bytes travel as base64; the rest of an answer is already JSON. Both sides are checked as an answer
// from the shell is: the page does not take the word of whoever sent the event.

type PreviewWire =
  | { kind: PreviewTextKind; text: string }
  | { kind: "image"; mime: PreviewImageMime; data: string }
  | PreviewRefusal;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

function bytesOfBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** A preview as it is sent to a window. */
export function previewToWire(preview: FilePreview): PreviewWire {
  return preview.kind === "image"
    ? { kind: "image", mime: preview.mime, data: base64Of(preview.bytes) }
    : preview;
}

/** The preview a wire answer holds, or an error when it is not one a preview can be. */
export function previewFromWire(value: unknown): FilePreview {
  if (typeof value !== "object" || value === null) throw new Error("the preview is not an object");
  const answer = value as Record<string, unknown>;
  const kind = answer["kind"];
  if (kind === "markdown" || kind === "json" || kind === "text") {
    const text = answer["text"];
    if (typeof text !== "string" || text.length > MAX_PREVIEW_TEXT_BYTES) {
      throw new Error("the preview has no text it can show");
    }
    return { kind, text };
  }
  if (kind === "image") {
    const data = answer["data"];
    if (typeof data !== "string" || data.length > Math.ceil(MAX_PREVIEW_IMAGE_BYTES / 3) * 4) {
      throw new Error("the preview has no picture it can show");
    }
    const bytes = bytesOfBase64(data);
    const mime = sniffPreviewImage(bytes);
    if (mime === undefined || answer["mime"] !== mime || bytes.length > MAX_PREVIEW_IMAGE_BYTES) {
      throw new Error("the preview picture is not the kind it was said to be");
    }
    return { kind, mime, bytes };
  }
  if (kind === "refused") {
    const reason = answer["reason"];
    if (typeof reason !== "string" || !(PREVIEW_REFUSALS as readonly string[]).includes(reason)) {
      throw new Error("the preview was refused for a reason unknown here");
    }
    const size = answer["size"];
    const detail = answer["detail"];
    return {
      kind,
      reason: reason as PreviewRefusal["reason"],
      ...(typeof size === "number" && Number.isFinite(size) && size >= 0 ? { size } : {}),
      ...(typeof detail === "string" ? { detail: detail.slice(0, MAX_FAILED_REASON) } : {}),
    };
  }
  throw new Error("the preview is of a kind unknown here");
}

/** What the main window answers a read with: what the backend found, or why it could not look. */
async function answerOf(
  backend: Pick<Backend, "readFilePreview" | "readGitDiff">,
  read: WindowRead,
): Promise<Record<string, unknown>> {
  try {
    return read.kind === "preview"
      ? { kind: "preview", preview: previewToWire(await backend.readFilePreview(read.path)) }
      : { kind: "diff", diff: await backend.readGitDiff(read.cwd) };
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Answers the reads the pages of the windows ask for (run by the main window): a `window-read`
 * that passes `readOfWindowRequest` is read through the backend, here, where the file and git
 * commands are allowed, and the answer goes out as `window-read-result` with the window and the
 * request number it came with. A request that does not pass gets no answer at all, and a window
 * has at most `MAX_WINDOW_READS` reads going at once. Returns the function that stops it. Never
 * throws.
 */
export function followWindowReads(
  store: Pick<WindowSyncStore, "getState">,
  backend: Pick<Backend, "readFilePreview" | "readGitDiff">,
  events: QuickEvents,
): () => void {
  const running = new Map<Id, number>();
  let stopped = false;
  let unlisten: (() => void) | undefined;
  events
    .listen(WINDOW_READ_EVENT, (payload) => {
      const asked = readOfWindowRequest(payload, store.getState().workspace);
      if (asked === undefined) return;
      const { windowId, request, read } = asked;
      const count = running.get(windowId) ?? 0;
      if (count >= MAX_WINDOW_READS) return;
      running.set(windowId, count + 1);
      void answerOf(backend, read)
        .then((answer) => events.emit(WINDOW_READ_RESULT_EVENT, { windowId, request, ...answer }))
        .catch(() => undefined)
        .finally(() => {
          const left = (running.get(windowId) ?? 1) - 1;
          if (left > 0) running.set(windowId, left);
          else running.delete(windowId);
        });
    })
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    unlisten?.();
    unlisten = undefined;
  };
}

/** What a preview or diff pane of a window page needs to read: the same two calls as the backend's. */
export type WindowPaneReader = Pick<Backend, "readFilePreview" | "readGitDiff">;

/** The reads of the page of a window (`createWindowReads`). */
export interface WindowReads {
  /** The reader of one pane of one tab; the same object every time it is asked for. */
  forPane(itemId: Id, paneId: Id): WindowPaneReader;
  /** Stops listening for answers; the reads still waiting fail. */
  stop(): void;
}

interface PendingRead {
  /** Takes an answer; the read is over unless the answer is not one for it. */
  answer(payload: Record<string, unknown>): void;
  abort(error: Error): void;
}

/**
 * The reads the page of the window `windowId` makes: a file or a git diff is asked of the main
 * window (`window-read`) and the answer is waited for (`window-read-result`, by the number of the
 * request, for this window and for the kind asked). The page itself never reads anything. An answer
 * that is not a proper one for a read it waits on is ignored (the read fails when it times out),
 * a failure the main window reports rejects the read, and a read with no answer in `timeoutMs`
 * rejects. At most four are on their way at once.
 */
export function createWindowReads(
  events: QuickEvents,
  windowId: Id,
  options: { timeoutMs?: number } = {},
): WindowReads {
  const timeoutMs = options.timeoutMs ?? WINDOW_READ_TIMEOUT_MS;
  const pending = new Map<number, PendingRead>();
  const readers = new Map<string, WindowPaneReader>();
  const waiting: (() => void)[] = [];
  let flying = 0;
  let next = 1;
  let listening: Promise<() => void> | undefined;

  const listen = (): Promise<() => void> => {
    listening ??= events
      .listen(WINDOW_READ_RESULT_EVENT, (payload) => {
        if (windowIdOfPayload(payload) !== windowId) return;
        const request = requestOfPayload(payload);
        if (request === undefined) return;
        pending.get(request)?.answer(payload as Record<string, unknown>);
      })
      .catch((error: unknown) => {
        listening = undefined;
        throw error;
      });
    return listening;
  };
  const acquire = (): Promise<void> => {
    if (flying < MAX_PAGE_READS) {
      flying++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiting.push(() => {
        flying++;
        resolve();
      });
    });
  };
  const release = (): void => {
    flying--;
    waiting.shift()?.();
  };

  const read = async <T>(
    kind: "preview" | "diff",
    body: Record<string, unknown>,
    decode: (payload: Record<string, unknown>) => T,
  ): Promise<T> => {
    await acquire();
    try {
      await listen();
      return await new Promise<T>((resolve, reject) => {
        const request = next++;
        const finish = (): void => {
          clearTimeout(timer);
          pending.delete(request);
        };
        const timer = setTimeout(() => {
          finish();
          reject(new Error("the main window did not answer"));
        }, timeoutMs);
        pending.set(request, {
          answer: (payload) => {
            const failed = payload["failed"];
            if (typeof failed === "string") {
              finish();
              reject(new Error(failed.slice(0, MAX_FAILED_REASON)));
              return;
            }
            if (payload["kind"] !== kind) return;
            let value: T;
            try {
              value = decode(payload);
            } catch {
              return;
            }
            finish();
            resolve(value);
          },
          abort: (error) => {
            finish();
            reject(error);
          },
        });
        events.emit(WINDOW_READ_EVENT, { windowId, request, kind, ...body }).catch((error) => {
          finish();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    } finally {
      release();
    }
  };

  return {
    forPane: (itemId, paneId) => {
      const key = `${itemId}\u0000${paneId}`;
      let reader = readers.get(key);
      if (reader === undefined) {
        reader = {
          readFilePreview: (path) =>
            read("preview", { itemId, paneId, path }, (p) => previewFromWire(p["preview"])),
          readGitDiff: (cwd) =>
            read("diff", { itemId, paneId, cwd }, (p) => decodeGitDiff(p["diff"])),
        };
        readers.set(key, reader);
      }
      return reader;
    },
    stop: () => {
      const held = listening;
      listening = undefined;
      held?.then((unlisten) => unlisten()).catch(() => undefined);
      for (const entry of [...pending.values()]) entry.abort(new Error("the window page stopped"));
    },
  };
}

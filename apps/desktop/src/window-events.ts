import { isWindowId } from "@noren/model";
import type { Backend, Id, Unsubscribe } from "@noren/model";
import type { QuickEvents } from "./quick";

// The other windows of the app (src-tauri/src/windows.rs makes them) load this same page in a form
// that only shows the tabs moved to them: it holds no workspace and never writes `state.json`, the
// main window owns that. The windows and the Rust side talk through the events below; the names are
// repeated in windows.rs.

/** Window page → everyone: the page listens for `window-take-sessions`, `{ windowId }`. */
export const WINDOW_READY_EVENT = "window-ready";
/**
 * Rust → window pages: the window `windowId` takes over the output of the sessions `ids`,
 * `{ windowId, request, ids }`. The answer carries the same `request` number.
 */
export const WINDOW_TAKE_EVENT = "window-take-sessions";
/** Window page → Rust: what became of a request, `{ windowId, request, ok, ids, reason? }`. */
export const WINDOW_TAKEN_EVENT = "window-sessions-taken";
/** Rust → everyone: the person closed the window `{ windowId }`. */
export const WINDOW_CLOSED_EVENT = "window-closed";

/** The window id an event payload names (`{ windowId }`), or `undefined` for anything else. */
export function windowIdOfPayload(payload: unknown): Id | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { windowId?: unknown }).windowId;
  return typeof id === "string" && isWindowId(id) ? id : undefined;
}

/**
 * The sessions an event payload carries (`{ ids: [3, 4] }`): whole, positive numbers, once each, in
 * order. An event can carry whatever a page sent, so a payload that has anything else in it is
 * refused as a whole (`undefined`), not trimmed.
 */
export function sessionsOfPayload(payload: unknown): number[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const ids = (payload as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return undefined;
  const seen = new Set<number>();
  for (const id of ids as unknown[]) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
    seen.add(id);
  }
  return [...seen];
}

/** The number of a request (`{ request: 4 }`), or `undefined` when the payload carries none. */
export function requestOfPayload(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const request = (payload as { request?: unknown }).request;
  return typeof request === "number" && Number.isSafeInteger(request) ? request : undefined;
}

/**
 * Takes over the sessions each time the Rust side says the window `windowId` should
 * (`window-take-sessions`), one after the other, and answers with `window-sessions-taken`
 * (`{ windowId, request, ok: true, ids }`, or `{ windowId, request, ok: false, ids, reason }` with the
 * ones it did take before one was refused; `request` is the number the event came with). `onTaken` is called with the sessions taken, once the backend moved
 * their output here. An event for another window is not for this page. Resolves with the function
 * that stops listening, after announcing the page ready (`window-ready`): whoever waits for the
 * page may send the first event from then on.
 */
export async function followTakes(
  events: QuickEvents,
  backend: Pick<Backend, "attachSession">,
  windowId: Id,
  onTaken: (ids: number[]) => void,
): Promise<Unsubscribe> {
  // One take at a time: two events for the same session would move its output twice.
  let queue: Promise<void> = Promise.resolve();
  const stop = await events.listen(WINDOW_TAKE_EVENT, (payload) => {
    if (windowIdOfPayload(payload) !== windowId) return;
    const wanted = sessionsOfPayload(payload);
    const request = requestOfPayload(payload);
    queue = queue.then(async () => {
      const taken: number[] = [];
      let reason: string | undefined =
        wanted === undefined ? "the event does not carry a list of sessions" : undefined;
      for (const id of wanted ?? []) {
        try {
          await backend.attachSession(id);
          taken.push(id);
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      if (taken.length > 0) onTaken(taken);
      await events
        .emit(WINDOW_TAKEN_EVENT, {
          windowId,
          ...(request !== undefined ? { request } : {}),
          ok: reason === undefined,
          ids: taken,
          ...(reason !== undefined ? { reason } : {}),
        })
        .catch(() => undefined);
    });
  });
  await events.emit(WINDOW_READY_EVENT, { windowId });
  return stop;
}

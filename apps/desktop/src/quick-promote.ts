import { liveSessionIds } from "@noren/model";
import type { Backend, Id } from "@noren/model";
import { QUICK_PROMOTED_EVENT, QUICK_PROMOTE_EVENT, sessionOfPayload } from "./quick";
import type { QuickEvents } from "./quick";
import type { WorkspaceStore } from "./workspace-store";

/** What became of a promotion: the tab that now shows the session, or why there is none. */
export type PromoteResult = { ok: true; itemId: Id } | { ok: false; reason: string };

/**
 * Brings a shell that is running in the quick window into this window as a tab of the active space.
 * The backend moves the output of the session here first, so the terminal of the new tab finds it
 * (what the shell prints in between is held); then the tab is made around the same session. Nothing
 * is restarted: the session id is the one the quick window had.
 *
 * It fails, changing nothing, when a tab already shows the session or the backend has no such
 * session; it never throws.
 */
export async function promoteQuickSession(
  store: WorkspaceStore,
  backend: Pick<Backend, "attachSession">,
  sessionId: number,
): Promise<PromoteResult> {
  const id = String(sessionId);
  if (liveSessionIds(store.getState().workspace).has(id)) {
    return { ok: false, reason: "a tab already shows that session" };
  }
  try {
    await backend.attachSession(sessionId);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const itemId = store.getState().adoptSession(id);
  if (itemId === undefined) return { ok: false, reason: "the tab could not be made" };
  return { ok: true, itemId };
}

/**
 * Promotes a session each time a `quick-promote` event names one, and answers with
 * `quick-promoted` (`{ id, ok, itemId }` or `{ id, ok: false, reason }`). A second request for a
 * session that is being promoted is answered as a failure: moving its output twice would leave the
 * terminal of the tab on a stream nobody feeds. Resolves with the function that stops listening.
 */
export function followQuickPromotions(
  events: QuickEvents,
  store: WorkspaceStore,
  backend: Pick<Backend, "attachSession">,
): Promise<() => void> {
  const promoting = new Set<number>();
  return events.listen(QUICK_PROMOTE_EVENT, (payload) => {
    const id = sessionOfPayload(payload);
    if (id === undefined) return;
    const answer = (result: PromoteResult) =>
      events.emit(QUICK_PROMOTED_EVENT, { id, ...result }).catch(() => undefined);
    if (promoting.has(id)) {
      void answer({ ok: false, reason: "that session is already being promoted" });
      return;
    }
    promoting.add(id);
    void promoteQuickSession(store, backend, id)
      .then(answer)
      .finally(() => promoting.delete(id));
  });
}

import { QUICK_PROMOTED_EVENT, QUICK_PROMOTE_EVENT } from "./quick";
import type { QuickEvents } from "./quick";

/** How long the quick window waits for the main window to answer a promotion. */
export const PROMOTE_TIMEOUT_MS = 5000;

/** What came of a promotion: the shell is a tab of the main window, or why it is not. */
export type QuickPromotion = { ok: true } | { ok: false; reason: string };

export interface QuickWindowDeps {
  /** The channel to the other windows (`quick-promote` out, `quick-promoted` back). */
  events: QuickEvents;
  /** Hides this window; the shell keeps running behind it. */
  hide(): Promise<void>;
  /** Waits `ms`; injected so tests need no real time. */
  after?(ms: number, run: () => void): () => void;
}

/**
 * What the quick window does besides showing a terminal: Esc hides it, and "promote" hands its shell
 * to the main window as a tab of the active space and then hides it. Neither ends the shell: a
 * hidden window comes back with the same shell, and a promoted one lives on in its tab.
 */
export interface QuickWindowActions {
  /** Esc: hide the window. Resolves with whether the window was asked to hide. */
  escape(): Promise<boolean>;
  /** Asks the main window to take the session over; hides the window once it did. Never throws. */
  promote(sessionId: number): Promise<QuickPromotion>;
}

export function createQuickWindowActions(deps: QuickWindowDeps): QuickWindowActions {
  const after =
    deps.after ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const hide = async (): Promise<boolean> => {
    try {
      await deps.hide();
      return true;
    } catch {
      return false;
    }
  };
  // The sessions being promoted now: a second click on the button must not send a second request.
  const promoting = new Set<number>();
  return {
    escape: hide,
    async promote(sessionId) {
      if (promoting.has(sessionId)) {
        return { ok: false, reason: "the shell is already being promoted" };
      }
      promoting.add(sessionId);
      let stopListening: (() => void) | undefined;
      let stopTimer: (() => void) | undefined;
      try {
        let resolveAnswer: (result: QuickPromotion) => void = () => undefined;
        const answer = new Promise<QuickPromotion>((resolve) => {
          resolveAnswer = resolve;
        });
        // Listening first, and only then asking, so the answer cannot slip past.
        stopListening = await deps.events.listen(QUICK_PROMOTED_EVENT, (payload) => {
          const reply = payload as { id?: unknown; ok?: unknown; reason?: unknown } | null;
          if (reply?.id !== sessionId) return;
          resolveAnswer(
            reply.ok === true
              ? { ok: true }
              : {
                  ok: false,
                  reason:
                    typeof reply.reason === "string"
                      ? reply.reason
                      : "the main window did not take the shell",
                },
          );
        });
        stopTimer = after(PROMOTE_TIMEOUT_MS, () =>
          resolveAnswer({ ok: false, reason: "the main window did not answer" }),
        );
        await deps.events.emit(QUICK_PROMOTE_EVENT, { id: sessionId });
        const result = await answer;
        if (result.ok) await hide();
        return result;
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        stopTimer?.();
        stopListening?.();
        promoting.delete(sessionId);
      }
    },
  };
}

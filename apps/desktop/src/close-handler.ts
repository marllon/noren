import type { Clock } from "@noren/model";
import type { TauriBridge } from "./tauri-backend";

// Closing the window gives the page a moment to save what it has in memory (the scrollback
// snapshots, the pending state). A call made from `beforeunload` may never leave the page when the
// window is torn down, so the Rust side holds the close instead (`lifecycle.rs`): it tells the page
// with the `close-requested` event, waits for `app_close_ready`, and destroys the window then.
// Asking the page to answer is the only thing this does; what is saved is the caller's.

/** The event the Rust side sends when the window is asked to close (`CLOSE_REQUESTED_EVENT` in `lifecycle.rs`). */
export const CLOSE_REQUESTED_EVENT = "close-requested";

/** The command that tells the Rust side the page listens, so a close waits for it. */
export const CLOSE_LISTENING_COMMAND = "app_close_listening";

/** The command that tells it the page has saved, so the window closes now. */
export const CLOSE_READY_COMMAND = "app_close_ready";

/** The longest the page spends saving before it lets the window close anyway. The Rust side waits longer. */
export const CLOSE_SAVE_LIMIT_MS = 2000;

/** What this needs of the bridge to the Rust side. */
export type CloseBridge = Pick<TauriBridge, "invoke" | "listen">;

/**
 * Starts answering the close of the window: when it is asked to close, `save` runs, and the window
 * closes when it is done, or after `limitMs` when it is slow, or when it fails. The Rust side is
 * told the page listens only once the listener is in place, so a close never waits for a page that
 * would not hear it. Rejects when the listener or the message cannot be set up (the window then closes
 * as it always did). Returns the function that stops listening.
 */
export async function followWindowClose(
  bridge: CloseBridge,
  save: () => Promise<void>,
  clock: Pick<Clock, "setTimer">,
  limitMs: number = CLOSE_SAVE_LIMIT_MS,
): Promise<() => void> {
  let closing = false;
  const stop = await bridge.listen<unknown>(CLOSE_REQUESTED_EVENT, () => {
    if (closing) return;
    closing = true;
    const saved = save().catch(() => undefined);
    const gaveUp = new Promise<void>((resolve) => {
      clock.setTimer(resolve, limitMs);
    });
    void Promise.race([saved, gaveUp])
      .then(() => bridge.invoke(CLOSE_READY_COMMAND))
      .catch(() => undefined);
  });
  try {
    await bridge.invoke(CLOSE_LISTENING_COMMAND);
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

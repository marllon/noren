// The receiving end of `noren://` links inside the desktop app. The Rust side keeps the links that
// arrive while the interface starts and emits the later ones (a second launch while Noren is
// open); this hands each to the interface's entry point as the raw text it got, as data. It
// validates nothing: the parser behind the entry point does that.

import type { TauriBridge } from "./tauri-backend";

/** Event the Rust side emits for a link that arrives once the interface is listening. */
export const LINK_EVENT = "deep-link-url";
/** Command that returns the links kept so far and makes the next ones come as events. */
export const TAKE_WAITING_COMMAND = "deep_link_take_waiting";
/** Command that tells the Rust side which folder the active space has after a link was applied. */
export const APPLIED_COMMAND = "deep_link_applied";

export interface LinkReceiverHost {
  bridge: Pick<TauriBridge, "invoke" | "listen">;
  /** The interface's entry point for a raw link; resolves when the link was applied or refused. */
  apply(url: string): Promise<void>;
  /** The default folder of the space on screen. */
  activeFolder(): string | undefined;
}

/**
 * Starts listening and asks for the links kept so far. Links are applied one at a time, in the
 * order they came. After each one the folder of the active space is reported back (the smoke run
 * checks it; a normal run ignores it). Returns a function that stops listening.
 */
export function startDeepLinkReceiver(host: LinkReceiverHost): () => void {
  const { bridge, apply, activeFolder } = host;
  let stopped = false;
  let unlisten: (() => void) | undefined;
  let queue: Promise<void> = Promise.resolve();

  const handle = (url: unknown): void => {
    if (typeof url !== "string") return;
    queue = queue.then(async () => {
      try {
        await apply(url);
        await bridge.invoke(APPLIED_COMMAND, { folder: activeFolder() ?? null });
      } catch {
        // `apply` reports problems as notices; a failed report only matters to the smoke run.
      }
    });
  };

  void (async () => {
    try {
      // Listen first, then take what waited: a link is in one of the two, never in neither.
      const off = await bridge.listen<unknown>(LINK_EVENT, (event) => handle(event.payload));
      if (stopped) {
        off();
        return;
      }
      unlisten = off;
      const waiting = await bridge.invoke<unknown>(TAKE_WAITING_COMMAND);
      if (Array.isArray(waiting)) for (const url of waiting) handle(url);
    } catch {
      // Without the Rust side there are no links to receive.
    }
  })();

  return () => {
    stopped = true;
    unlisten?.();
    unlisten = undefined;
  };
}

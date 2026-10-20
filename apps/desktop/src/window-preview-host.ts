import type { FakeWindowHost, Id, SessionId } from "@noren/model";
import { windowPreviewEvents } from "./quick";
import type { QuickEvents } from "./quick";
import {
  WINDOW_READY_EVENT,
  WINDOW_TAKE_EVENT,
  WINDOW_TAKEN_EVENT,
  requestOfPayload,
  windowIdOfPayload,
} from "./window-events";

// What stands in for the Rust side of the windows in a browser opened with `?window-preview` (the
// e2e tests): `windows.rs` makes the native window, waits for its page to say it is ready, asks it
// to take over the output of the sessions of a tab (`window-take-sessions`) and waits for the
// answer (`window-sessions-taken`). Here the "window" is a panel next to the app (`WindowPreview`),
// and this class does the same with the events of the page, so the page of the window and the main
// window run the very code of the real app on top of the fake backend.

/** How long the host waits for the page of a window to be ready, and then for its answer. */
export const PREVIEW_WAIT_MS = 10_000;

/** A window the host was told about: the panel draws one page for each. */
export interface PreviewWindow {
  id: Id;
  spaceId: Id;
}

interface Pending {
  promise: Promise<void>;
  resolve(): void;
}

function pending(): Pending {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer`)), PREVIEW_WAIT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class WindowPreviewHost implements FakeWindowHost {
  readonly #events: QuickEvents;
  #windows: readonly PreviewWindow[] = [];
  readonly #ready = new Map<Id, Pending>();
  readonly #listeners = new Set<() => void>();
  #requests = 0;

  constructor(events: QuickEvents = windowPreviewEvents) {
    this.#events = events;
    // A page announces itself once it listens; the first `take` waits for that.
    void events.listen(WINDOW_READY_EVENT, (payload) => {
      const windowId = windowIdOfPayload(payload);
      if (windowId !== undefined) this.#readyOf(windowId).resolve();
    });
  }

  /** The windows that are open now (a new array each time they change). */
  readonly snapshot = (): readonly PreviewWindow[] => this.#windows;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  opened(windowId: Id, spaceId: Id): void {
    this.#windows = [...this.#windows.filter((w) => w.id !== windowId), { id: windowId, spaceId }];
    this.#changed();
  }

  closed(windowId: Id): void {
    this.#ready.delete(windowId);
    this.#windows = this.#windows.filter((w) => w.id !== windowId);
    this.#changed();
  }

  async take(windowId: Id, sessionIds: readonly SessionId[]): Promise<void> {
    await within(this.#readyOf(windowId).promise, `the page of window ${windowId}`);
    const request = ++this.#requests;
    const answered = new Promise<void>((resolve, reject) => {
      void this.#events
        .listen(WINDOW_TAKEN_EVENT, (payload) => {
          if (windowIdOfPayload(payload) !== windowId || requestOfPayload(payload) !== request) {
            return;
          }
          const body = payload as { ok?: unknown; reason?: unknown };
          if (body.ok === true) resolve();
          else reject(new Error(typeof body.reason === "string" ? body.reason : "refused"));
        })
        .then((stop) => answered.then(stop, stop));
    });
    // Awaited below; this keeps an early refusal from being reported as unhandled meanwhile.
    answered.catch(() => undefined);
    await this.#events.emit(WINDOW_TAKE_EVENT, { windowId, request, ids: [...sessionIds] });
    await within(answered, `window ${windowId}`);
  }

  #readyOf(windowId: Id): Pending {
    let ready = this.#ready.get(windowId);
    if (ready === undefined) {
      ready = pending();
      this.#ready.set(windowId, ready);
    }
    return ready;
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The host of the window panels of this page. */
export const windowPreviewHost = new WindowPreviewHost();

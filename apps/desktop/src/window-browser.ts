import { browserBoundsProblem, browserUrlProblem, findWindow, layoutPanes } from "@noren/model";
import type { Backend, BrowserBounds, Id, Pane, Workspace } from "@noren/model";
import { exclusive } from "./browser-view";
import type { BrowserViewBackend } from "./browser-view";
import type { QuickEvents } from "./quick";
import { requestOfPayload, windowIdOfPayload } from "./window-events";
import type { WindowSyncStore } from "./window-sync";

// The web view of a browser pane shown by a window besides the main one. The page of such a window
// has no command to open, move or close a web view (its capability has none, and `browser_open`
// answers only to the main window), and the web view is a native child of a window, not part of the
// page. So the main window opens it, as a child of the window, with the bounds the page of that
// window measured and sent. The page asks (`window-browser`: open, navigate, bounds, close) and
// waits for the answer (`window-browser-result`); the main window checks that the request is the
// window's own and that the pane is one of its tabs, and only then calls the backend. The address
// is never the page's to choose: it is the one the pane holds in the workspace, and a request that
// names another is refused. The names are repeated in the smoke run and the docs.

/** Window page → main window: a call about the web view of a pane of the window, `{ windowId, request, op, itemId, paneId, ... }`. */
export const WINDOW_BROWSER_EVENT = "window-browser";
/**
 * Main window → window pages: what became of a call, `{ windowId, request, ok: true }` or
 * `{ windowId, request, failed }` with the reason. A page keeps only the answers for its own
 * `windowId` and for a call it waits on.
 */
export const WINDOW_BROWSER_RESULT_EVENT = "window-browser-result";

/** The calls about web views of one window the main window carries out at the same time; a call past that is refused. */
export const MAX_WINDOW_BROWSER_CALLS = 16;

/** How long a window page waits for the answer to a call before it says the pane could not be shown. */
export const WINDOW_BROWSER_TIMEOUT_MS = 30_000;

/** The longest reason of a failed call the page keeps, in UTF-16 units. */
const MAX_FAILED_REASON = 500;

/** What a window asks the main window to do about the web view of one of its panes. */
export type WindowBrowserCall =
  | { op: "open"; paneId: Id; url: string; bounds: BrowserBounds }
  | { op: "navigate"; paneId: Id; url: string }
  | { op: "bounds"; paneId: Id; bounds: BrowserBounds }
  | { op: "close"; paneId: Id };

/** The calls of the backend the main window makes for a window. */
export type WindowBrowserBackend = Pick<
  Backend,
  "openBrowserPane" | "navigateBrowserPane" | "setBrowserPaneBounds" | "closeBrowserPane"
>;

/**
 * The browser pane `paneId` in the space the window `windowId` shows (in the tab `itemId` when that
 * is given, in any tab of the space when it is not), or `undefined` when the window is not one of the
 * workspace's, shows no such space, the tab is not in it, or the pane is not a browser pane there.
 */
export function browserPaneOfWindow(
  workspace: Workspace,
  windowId: Id,
  paneId: Id,
  itemId?: Id,
): Pane | undefined {
  const window = findWindow(workspace, windowId);
  const space = workspace.spaces.find((s) => s.id === window?.spaceId);
  if (window === undefined || space === undefined) return undefined;
  const items =
    itemId === undefined
      ? Object.values(space.items)
      : Object.hasOwn(space.items, itemId)
        ? [space.items[itemId]]
        : [];
  for (const item of items) {
    const pane = item && layoutPanes(item.layout).find((p) => p.id === paneId);
    if (pane !== undefined) return pane.type === "browser" ? pane : undefined;
  }
  return undefined;
}

/** The place a request names, rebuilt from its four numbers, or `undefined` when it is not one the backend accepts. */
function boundsOfRequest(value: unknown): BrowserBounds | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return undefined;
  }
  const bounds = { x, y, width, height };
  return browserBoundsProblem(bounds) === undefined ? bounds : undefined;
}

/** A call of a window the main window will carry out, or why it will not (an answer for the page). */
export type WindowBrowserAsk =
  | { windowId: Id; request: number; call: WindowBrowserCall }
  | { windowId: Id; request: number; refusal: string };

/**
 * What a `window-browser` event asks for, or `undefined` when it is not one the main window answers:
 * it is not for a window of the workspace, names a tab that the space of that window does not hold,
 * names a pane that is not a browser pane of that tab, an operation that is not one of the four,
 * bounds the backend would not take or an address the rule of the browser pane refuses. The call is
 * made again from what was checked, with the address taken from the pane, so nothing else a page
 * sent gets through. A request that is the window's own but names another address than the pane
 * holds now (the pane was taken somewhere else while the call was on its way) is refused with a
 * reason, so the page does not wait for an answer that will not come.
 */
export function browserAskOfWindowRequest(
  payload: unknown,
  workspace: Workspace,
): WindowBrowserAsk | undefined {
  const windowId = windowIdOfPayload(payload);
  const request = requestOfPayload(payload);
  if (windowId === undefined || request === undefined || request < 1) return undefined;
  const { op, itemId, paneId, url, bounds } = payload as Record<string, unknown>;
  if (typeof itemId !== "string" || typeof paneId !== "string") return undefined;
  const pane = browserPaneOfWindow(workspace, windowId, paneId, itemId);
  if (pane === undefined) return undefined;
  switch (op) {
    case "close":
      return { windowId, request, call: { op, paneId: pane.id } };
    case "bounds": {
      const place = boundsOfRequest(bounds);
      return place === undefined
        ? undefined
        : { windowId, request, call: { op, paneId: pane.id, bounds: place } };
    }
    case "open":
    case "navigate": {
      if (typeof url !== "string" || browserUrlProblem(url) !== undefined) return undefined;
      if (pane.url !== url) {
        return { windowId, request, refusal: "the pane is at another address now" };
      }
      if (op === "navigate") return { windowId, request, call: { op, paneId: pane.id, url } };
      const place = boundsOfRequest(bounds);
      return place === undefined
        ? undefined
        : { windowId, request, call: { op, paneId: pane.id, url, bounds: place } };
    }
    default:
      return undefined;
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Carries out the calls the pages of the windows make about the web views of their browser panes
 * (run by the main window): a `window-browser` that passes `browserAskOfWindowRequest` is made
 * through the backend, here, where the commands for web views are allowed, as a child of the window
 * that asked, and the answer goes out as `window-browser-result` with the window and the request
 * number it came with. A request that does not pass gets no answer at all, a window has at most
 * `MAX_WINDOW_BROWSER_CALLS` calls going at once, and the calls of one pane are made one at a time
 * and in order, after whatever the main window itself asked of this backend for that pane before
 * (`exclusive`: the web view it closes as a tab leaves for a window is closed before the window
 * opens its own).
 *
 * It also keeps no web view of a window that has no use for it: when the pane is no longer in the
 * space the window shows (the tab came back to the main window or went to another, was closed, or
 * the window was closed), the web view is closed, so the main window can open the pane again as its
 * own child and no web view is left over. Returns the function that stops it. Never throws.
 */
export function followWindowBrowsers(
  store: WindowSyncStore,
  backend: WindowBrowserBackend,
  events: QuickEvents,
): () => void {
  /** The web views this holds for windows: the pane, and the window it was opened for. */
  const held = new Map<Id, Id>();
  const running = new Map<Id, number>();
  let stopped = false;
  let unlisten: (() => void) | undefined;

  const ours = (windowId: Id, paneId: Id): boolean =>
    browserPaneOfWindow(store.getState().workspace, windowId, paneId) !== undefined;

  const carryOut = async (windowId: Id, call: WindowBrowserCall): Promise<void> => {
    // The call waited its turn behind others: the pane may have gone from the window meanwhile.
    if (!ours(windowId, call.paneId)) throw new Error("the pane is not in the window any more");
    switch (call.op) {
      case "open":
        await backend.openBrowserPane(call.paneId, call.url, call.bounds, { windowId });
        held.set(call.paneId, windowId);
        // It left while the web view was being made: nobody will show this one.
        if (!ours(windowId, call.paneId)) {
          held.delete(call.paneId);
          await backend.closeBrowserPane(call.paneId);
        }
        return;
      case "navigate":
        await backend.navigateBrowserPane(call.paneId, call.url);
        return;
      case "bounds":
        await backend.setBrowserPaneBounds(call.paneId, call.bounds);
        return;
      case "close":
        held.delete(call.paneId);
        await backend.closeBrowserPane(call.paneId);
        return;
    }
  };

  const sweep = (): void => {
    for (const [paneId, windowId] of [...held]) {
      if (ours(windowId, paneId)) continue;
      held.delete(paneId);
      exclusive(backend, paneId, () => backend.closeBrowserPane(paneId)).catch(() => undefined);
    }
  };
  const stopSweeping = store.subscribe(sweep);

  events
    .listen(WINDOW_BROWSER_EVENT, (payload) => {
      const asked = browserAskOfWindowRequest(payload, store.getState().workspace);
      if (asked === undefined) return;
      const { windowId, request } = asked;
      const answer = (outcome: { ok: true } | { failed: string }): void => {
        events
          .emit(WINDOW_BROWSER_RESULT_EVENT, { windowId, request, ...outcome })
          .catch(() => undefined);
      };
      if ("refusal" in asked) {
        answer({ failed: asked.refusal });
        return;
      }
      const count = running.get(windowId) ?? 0;
      if (count >= MAX_WINDOW_BROWSER_CALLS) {
        answer({ failed: "too many calls at once" });
        return;
      }
      running.set(windowId, count + 1);
      exclusive(backend, asked.call.paneId, () => carryOut(windowId, asked.call))
        .then(
          () => answer({ ok: true }),
          (error: unknown) => answer({ failed: reasonOf(error).slice(0, MAX_FAILED_REASON) }),
        )
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
    stopSweeping();
    unlisten?.();
    unlisten = undefined;
  };
}

/** The calls about the web views of the panes of the page of a window (`createWindowBrowsers`). */
export interface WindowBrowsers {
  /**
   * The calls to the shell about the web view of one pane of one tab, as the `BrowserPaneView` of the
   * pane makes them; the same object every time it is asked for. They ask the main window.
   */
  forPane(itemId: Id, paneId: Id): BrowserViewBackend;
  /** Stops listening for answers; the calls still waiting fail. */
  stop(): void;
}

interface PendingCall {
  answer(payload: Record<string, unknown>): void;
  abort(error: Error): void;
}

/**
 * The calls the page of the window `windowId` makes about the web views of its browser panes: each is
 * asked of the main window (`window-browser`) and the answer is waited for (`window-browser-result`,
 * by the number of the request and for this window). The page itself calls no command about a web
 * view. A call that is answered with a failure rejects with the reason, and one with no answer in
 * `timeoutMs` rejects. The calls of a pane are made by one `BrowserPaneView` one at a time, so they
 * reach the main window in order.
 */
export function createWindowBrowsers(
  events: QuickEvents,
  windowId: Id,
  options: { timeoutMs?: number } = {},
): WindowBrowsers {
  const timeoutMs = options.timeoutMs ?? WINDOW_BROWSER_TIMEOUT_MS;
  const pending = new Map<number, PendingCall>();
  const views = new Map<string, BrowserViewBackend>();
  let next = 1;
  let listening: Promise<() => void> | undefined;

  const listen = (): Promise<() => void> => {
    listening ??= events
      .listen(WINDOW_BROWSER_RESULT_EVENT, (payload) => {
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

  const call = async (body: Record<string, unknown>): Promise<void> => {
    await listen();
    await new Promise<void>((resolve, reject) => {
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
          } else if (payload["ok"] === true) {
            finish();
            resolve();
          }
        },
        abort: (error) => {
          finish();
          reject(error);
        },
      });
      events.emit(WINDOW_BROWSER_EVENT, { windowId, request, ...body }).catch((error: unknown) => {
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  return {
    forPane: (itemId, paneId) => {
      const key = `${itemId}\u0000${paneId}`;
      let view = views.get(key);
      if (view === undefined) {
        // A view only ever talks about its own pane; a call that names another is the page's mistake.
        const own = (id: Id): void => {
          if (id !== paneId) throw new Error("that is not the pane of this view");
        };
        view = {
          openBrowserPane: async (id, url, bounds) => {
            own(id);
            await call({ op: "open", itemId, paneId, url, bounds });
          },
          navigateBrowserPane: async (id, url) => {
            own(id);
            await call({ op: "navigate", itemId, paneId, url });
          },
          setBrowserPaneBounds: async (id, bounds) => {
            own(id);
            await call({ op: "bounds", itemId, paneId, bounds });
          },
          closeBrowserPane: async (id) => {
            own(id);
            await call({ op: "close", itemId, paneId });
          },
        };
        views.set(key, view);
      }
      return view;
    },
    stop: () => {
      const held = listening;
      listening = undefined;
      held?.then((unlisten) => unlisten()).catch(() => undefined);
      for (const entry of [...pending.values()]) entry.abort(new Error("the window page stopped"));
    },
  };
}

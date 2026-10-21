// The page's end of the local API (NOR-F17-01c). The Rust side (`src-tauri/src/api_bridge.rs`) emits
// each call the server validated to this window as the event `api-call`, `{ id, method, params }`;
// the page runs it with `dispatchApiCall` of `@noren/model` over the real workspace store, backend
// and terminal tail, and gives the outcome back with the command `api_respond`. Only the window
// `main` runs this: it owns the workspace. In a plain browser (web mode, e2e) nothing starts it.

import { dispatchApiCall } from "@noren/model";
import type { ApiCall, ApiHost, ApiOutcome, Backend, TerminalTail } from "@noren/model";
import type { TauriBridge } from "./tauri-backend";
import type { WorkspaceStore } from "./workspace-store";

/** The event the Rust side emits for a call. */
export const API_CALL_EVENT = "api-call";
/** The command the page answers with: `api_respond(id, outcome)`. */
export const API_RESPOND_COMMAND = "api_respond";
/**
 * The command the page says it hears calls with: `api_ready()`. Until it is called the Rust side
 * answers a call `failed` ("Noren is still starting") instead of sending it to a page that cannot
 * hear it (NOR-F17-01d).
 */
export const API_READY_COMMAND = "api_ready";

export interface ApiListenerHost {
  bridge: Pick<TauriBridge, "invoke" | "listen">;
  /** Runs one call (`dispatchApiCall` over the app); must not reject, but a rejection is answered. */
  run(call: ApiCall): Promise<ApiOutcome>;
}

/** The id of a call event, or `undefined` when the payload is not one the page can answer. */
function callIdOf(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const { id } = payload as { id?: unknown };
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

/** The call inside an event: the payload without its id. */
function callOf(payload: object): ApiCall {
  const { method, params } = payload as Record<string, unknown>;
  // Only the method and its parameters: a field the page was not told about is not passed on, and
  // `dispatchApiCall` refuses a call whose method or parameters do not fit.
  return { method, params } as unknown as ApiCall;
}

const internal = (message: string): ApiOutcome => ({ error: { code: "internal", message } });

/**
 * Starts hearing calls. Each one runs on its own (calls of different clients do not wait for each
 * other) and is answered once, with whatever `run` gave: a result, an error, or an `internal` error
 * if `run` itself failed. An event that has no usable id cannot be answered and is dropped (the
 * Rust side times that call out). Once the listener is registered, and not before, the page tells
 * the Rust side with `api_ready`; a call that came earlier was already told the window is starting.
 * Returns a function that stops listening; calls already running still answer.
 */
export function startApiListener(host: ApiListenerHost): () => void {
  const { bridge, run } = host;
  let stopped = false;
  let unlisten: (() => void) | undefined;

  const answer = async (id: number, call: ApiCall): Promise<void> => {
    let outcome: ApiOutcome;
    try {
      outcome = await run(call);
    } catch (e) {
      outcome = internal(`the call broke: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await bridge.invoke(API_RESPOND_COMMAND, { id, outcome });
    } catch {
      // The Rust side already gave the caller a timeout, or the app is closing.
    }
  };

  void (async () => {
    try {
      const off = await bridge.listen<unknown>(API_CALL_EVENT, (event) => {
        if (stopped) return;
        const id = callIdOf(event.payload);
        if (id === undefined) return;
        void answer(id, callOf(event.payload as object));
      });
      if (stopped) {
        off();
        return;
      }
      unlisten = off;
    } catch {
      // Without the Rust side there are no calls to hear.
      return;
    }
    try {
      await bridge.invoke(API_READY_COMMAND);
    } catch {
      // The app is closing; there is nobody to tell.
    }
  })();

  return () => {
    stopped = true;
    unlisten?.();
    unlisten = undefined;
  };
}

export interface AppApiHostOptions {
  store: WorkspaceStore;
  backend: Pick<Backend, "createSession" | "write" | "kill">;
  /** Fed with the output of every session by the backend (`TauriBackend` option `tail`). */
  tail: Pick<TerminalTail, "read">;
}

/** The host of the dispatcher over the real workspace store, backend and terminal tail. */
export function appApiHost(options: AppApiHostOptions): ApiHost {
  const { store, backend, tail } = options;
  return {
    workspace: () => store.getState().workspace,
    dispatch: (action) => store.getState().dispatch(action),
    attachSession: (paneId, sessionId) => store.getState().attachSession(paneId, sessionId),
    backend,
    readLines: (sessionId, count) => tail.read(sessionId, count),
  };
}

/**
 * Starts the local API in this page: calls from the Rust side run against `store` and `backend`,
 * and `terminal.read` reads `tail`. Returns the function that stops it.
 */
export function startLocalApi(
  options: AppApiHostOptions & { bridge: Pick<TauriBridge, "invoke" | "listen"> },
): () => void {
  const host = appApiHost(options);
  return startApiListener({
    bridge: options.bridge,
    run: (call) => dispatchApiCall(call, host),
  });
}

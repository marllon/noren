import type { Backend } from "@noren/model";
import { TauriBackend } from "./tauri-backend";
import { WebBackend } from "./web-backend";

/** True when running inside the Tauri webview (not in a plain browser: web mode, e2e, demo). */
export const insideTauri = "__TAURI_INTERNALS__" in window;

/** The real backend inside Tauri, the in-memory one (state in `localStorage`) in a plain browser. */
export function createBackend(): Backend {
  return insideTauri ? new TauriBackend() : new WebBackend(window.localStorage);
}

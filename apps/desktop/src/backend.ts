import type { Backend } from "@noren/model";
import { seedDemo } from "./demo/demo-script";
import { TauriBackend } from "./tauri-backend";
import { WebBackend } from "./web-backend";

/** True when running inside the Tauri webview (not in a plain browser: web mode, e2e, demo). */
export const insideTauri = "__TAURI_INTERNALS__" in window;

/** The real backend inside Tauri, the in-memory one (state in `localStorage`) in a plain browser. */
export function createBackend(): Backend {
  // The web demo opens on its script (a first visit only); no other build contains it.
  if (import.meta.env.VITE_NOREN_DEMO === "1" && !insideTauri) seedDemo(window.localStorage);
  return insideTauri ? new TauriBackend() : new WebBackend(window.localStorage);
}

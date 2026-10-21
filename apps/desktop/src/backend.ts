import type { Backend, TerminalTail } from "@noren/model";
import { seedDemo } from "./demo/demo-script";
import { TauriBackend, tauriBridge } from "./tauri-backend";
import { WebBackend } from "./web-backend";

/** True when running inside the Tauri webview (not in a plain browser: web mode, e2e, demo). */
export const insideTauri = "__TAURI_INTERNALS__" in window;

export interface CreateBackendOptions {
  /** Takes the output of every session (the real backend only; the main window gives it). */
  tail?: TerminalTail;
}

/** The real backend inside Tauri, the in-memory one (state in `localStorage`) in a plain browser. */
export function createBackend(options: CreateBackendOptions = {}): Backend {
  // The web demo opens on its script (a first visit only); no other build contains it.
  if (import.meta.env.VITE_NOREN_DEMO === "1" && !insideTauri) seedDemo(window.localStorage);
  return insideTauri
    ? new TauriBackend(tauriBridge(), options)
    : new WebBackend(window.localStorage);
}

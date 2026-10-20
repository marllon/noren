import { windowIdOfLabel } from "@noren/model";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// The quick terminal is a second window of the app (src-tauri/src/quick.rs makes it, hidden). It
// loads this same page in a minimal form: just a terminal, with none of the workspace. The windows
// and the Rust side talk through the events below; the names are repeated in quick.rs.

/** The label the Rust side gives the quick window. */
export const QUICK_WINDOW_LABEL = "quick";

/** Rust → quick window: open a shell now, unless one is open. */
export const QUICK_OPEN_EVENT = "quick-open";
/** Quick window → everyone: the window listens for `quick-open` and `quick-promoted`. */
export const QUICK_READY_EVENT = "quick-ready";
/** Quick window → everyone: the shell it opened, `{ id }`. */
export const QUICK_SESSION_EVENT = "quick-session";
/** Anyone → main window: take the session `{ id }` over into a tab of the active space. */
export const QUICK_PROMOTE_EVENT = "quick-promote";
/** Main window → everyone: what became of a promotion, `{ id, ok, itemId?, reason? }`. */
export const QUICK_PROMOTED_EVENT = "quick-promoted";

/**
 * Which window this page is in: the main one (the workspace, the only page that loads and saves
 * the state), the quick terminal, or another window of the app (`window-<id>`, a space of its own).
 */
export type WindowKind = "main" | "quick" | "window";

/**
 * The kind of window from its label; a plain browser, which has no label, is the main one. Only a
 * label that names a window (`windowIdOfLabel`) is another window: any other label the page does
 * not know loads the main page, as before.
 */
export function windowKindOf(label: string | undefined): WindowKind {
  if (label === QUICK_WINDOW_LABEL) return "quick";
  return label !== undefined && windowIdOfLabel(label) !== undefined ? "window" : "main";
}

/** The part of the event system of the app the quick terminal uses, injected so tests can fake it. */
export interface QuickEvents {
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
  emit(event: string, payload?: unknown): Promise<void>;
}

/** The events on top of the real `@tauri-apps/api`. */
export function tauriQuickEvents(): QuickEvents {
  return {
    listen: (event, handler) => listen(event, (received) => handler(received.payload)),
    emit: (event, payload) => emit(event, payload),
  };
}

/**
 * The session id a quick event carries (`{ id: 3 }`), or `undefined` for anything else: an event
 * can carry whatever a page sent, so a payload that is not a whole, positive number is ignored.
 */
export function sessionOfPayload(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Events that stay inside one page: the same pair of calls as the real ones, for a browser (web mode,
 * the e2e tests, tests of the logic) where both windows are drawn in one page. A handler hears an
 * event even when it is the one that emitted it, like the real thing.
 */
export function memoryQuickEvents(): QuickEvents {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listen: async (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit: async (event, payload) => {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
  };
}

/** Hides the window this page is in (the capability of the quick window allows exactly that). */
export function tauriHideWindow(): Promise<void> {
  return getCurrentWindow().hide();
}

/**
 * True in a plain browser opened with `?quick-preview`: the page draws the quick window as a panel
 * next to the app, both on one in-memory backend and one in-memory bus (`QuickPreview.tsx`). It is
 * how the e2e tests see the two windows together, which one page of one window cannot; inside the
 * app the flag is always false.
 */
export const quickPreviewEnabled =
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  new URLSearchParams(window.location.search).has("quick-preview");

/** The bus of the preview: the app and the panel hear each other through it. */
export const quickPreviewEvents: QuickEvents = memoryQuickEvents();

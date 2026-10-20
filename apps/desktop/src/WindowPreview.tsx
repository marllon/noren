import { FakeBackend } from "@noren/model";
import type { Backend, Id } from "@noren/model";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { backend } from "./boot";
import { useT } from "./i18n";
import { windowPreviewEvents } from "./quick";
import type { TerminalHandle } from "./TerminalView";
import { WindowApp } from "./WindowApp";
import { windowPreviewHost } from "./window-preview-host";
import { WINDOW_ACTION_EVENT, WINDOW_READ_EVENT, WINDOW_READ_RESULT_EVENT } from "./window-sync";

/** What the e2e tests read on the window panels (`window.__norenWindows`). */
export interface WindowPreviewHook {
  /** The ids of the windows that are open, in the order they were opened. */
  windows(): string[];
  /** The lines of the terminal of a pane of a window (the first terminal of the window when `paneId` is left out). */
  lines(windowId: string, paneId?: string): string[];
  /** The person closes the window with the close button of its frame. */
  closeByPerson(windowId: string): void;
  /**
   * Sends the main window a `window-action` as the page of `windowId` would, with `action` as given
   * (the tests send what a page that is wrong, or not ours, could send, to see it refused).
   */
  ask(windowId: string, action: unknown): void;
  /**
   * Sends the main window a `window-read` as the page of `windowId` would, with the fields of
   * `body` (`request`, `kind`, `itemId`, `paneId`, `path` or `cwd`) as given: the tests send what a
   * page that is wrong, or not ours, could send, to see it ignored.
   */
  read(windowId: string, body: unknown): void;
  /** What the main window answered to reads so far (`window-read-result`), oldest first. */
  replies(): unknown[];
}

declare global {
  interface Window {
    __norenWindows?: WindowPreviewHook;
  }
}

/**
 * The backend a window page gets in the preview. It is the app's own, but a real window page can
 * read no file and run no git (its capability has no such command), so these two refuse here too:
 * a preview or diff pane in a panel can only show what the main window read and sent.
 */
function windowPageBackend(real: Backend): Backend {
  return new Proxy(real, {
    get(target, property) {
      if (property === "readFilePreview" || property === "readGitDiff") {
        return () => Promise.reject(new Error("a window page cannot read files or run git"));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const pageBackend = windowPageBackend(backend);

/**
 * The windows besides the main one drawn as panels in a browser (`?window-preview`), each with the
 * page of a window (`WindowApp`) on the same backend and the same events as the app next to them, as
 * the main window and the other pages share the sessions and the events in the real app. The close
 * button of a panel is the person closing the window (`closeWindowByPerson`).
 */
export function WindowPreview() {
  const t = useT();
  const windows = useSyncExternalStore(windowPreviewHost.subscribe, windowPreviewHost.snapshot);
  // Mounted terminals by window and pane, for the hook.
  const terminals = useRef(new Map<string, TerminalHandle>());
  const open = useRef<string[]>([]);
  open.current = windows.map((w) => w.id);
  const replies = useRef<unknown[]>([]);
  // The handle of a terminal in a window that closed is not kept.
  useEffect(() => {
    for (const key of [...terminals.current.keys()]) {
      if (!open.current.some((id) => key.startsWith(`${id}:`))) terminals.current.delete(key);
    }
  }, [windows]);

  useEffect(() => {
    window.__norenWindows = {
      windows: () => [...open.current],
      lines: (windowId, paneId) => {
        const prefix = `${windowId}:`;
        const key =
          paneId !== undefined
            ? `${prefix}${paneId}`
            : [...terminals.current.keys()].find((k) => k.startsWith(prefix));
        return (key === undefined ? undefined : terminals.current.get(key))?.readLines() ?? [];
      },
      closeByPerson: (windowId) => {
        if (backend instanceof FakeBackend) backend.closeWindowByPerson(windowId);
      },
      ask: (windowId, action) => {
        windowPreviewEvents.emit(WINDOW_ACTION_EVENT, { windowId, action }).catch(() => undefined);
      },
      read: (windowId, body) => {
        const fields = typeof body === "object" && body !== null ? body : {};
        windowPreviewEvents.emit(WINDOW_READ_EVENT, { windowId, ...fields }).catch(() => undefined);
      },
      replies: () => [...replies.current],
    };
    const stop = windowPreviewEvents.listen(WINDOW_READ_RESULT_EVENT, (payload) => {
      replies.current.push(payload);
    });
    return () => {
      delete window.__norenWindows;
      void stop.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className="window-previews" data-nr-part="window-previews">
      {windows.map((w) => (
        <section
          key={w.id}
          className="window-preview"
          aria-label={t("window.preview")}
          data-nr-part="window-preview"
          data-nr-window={w.id}
        >
          <div className="window-preview-frame">
            <span>{w.id}</span>
            <button
              type="button"
              className="window-preview-close"
              aria-label={t("window.close")}
              data-nr-part="window-preview-close"
              onClick={() => {
                if (backend instanceof FakeBackend) backend.closeWindowByPerson(w.id);
              }}
            >
              ×
            </button>
          </div>
          <WindowApp
            windowId={w.id as Id}
            backend={pageBackend}
            events={windowPreviewEvents}
            onTerminal={(paneId, handle) => {
              terminals.current.set(`${w.id}:${paneId}`, handle);
            }}
          />
        </section>
      ))}
    </div>
  );
}

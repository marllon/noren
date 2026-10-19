import type { Backend } from "@noren/model";
import { ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBackend } from "./backend";
import { useT } from "./i18n";
import {
  QUICK_OPEN_EVENT,
  QUICK_PROMOTED_EVENT,
  QUICK_READY_EVENT,
  QUICK_SESSION_EVENT,
  sessionOfPayload,
  tauriHideWindow,
  tauriQuickEvents,
} from "./quick";
import type { QuickEvents } from "./quick";
import { createQuickWindowActions } from "./quick-window";
import { TerminalView } from "./TerminalView";
import type { TerminalHandle } from "./TerminalView";
import { applyTheme, terminalTheme, themeForScheme } from "./theme";

/** How long a refusal to promote stays under the title. */
const NOTICE_MS = 4000;

interface QuickAppProps {
  /** The backend of the page; the real one for this window when left out. */
  backend?: Backend;
  /** The events to the other windows; the app's own when left out. */
  events?: QuickEvents;
  /** Hides the window; this window's own `hide` when left out. */
  hide?(): Promise<void>;
}

let ownBackend: Backend | undefined;
/** The backend of a page that is only this window (made once, when the page needs it). */
function pageBackend(): Backend {
  ownBackend ??= createBackend();
  return ownBackend;
}

/**
 * The page of the quick window: one terminal with the default profile, a title line with the
 * "Promote to tab" button, and nothing else. It does not read the workspace, the settings or the
 * saved state (the main window owns them), so it cannot write over them. The shell starts when the
 * Rust side asks (`quick-open`, each time the window is shown), and a promotion (`quick-promoted`
 * for its session) hands the shell to the main window: this page lets go of it without ending it and
 * waits for the next `quick-open`. Esc hides the window; the shell stays.
 */
export function QuickApp({ backend = pageBackend(), events, hide }: QuickAppProps) {
  const t = useT();
  const bus = useMemo(() => events ?? tauriQuickEvents(), [events]);
  const actions = useMemo(
    () => createQuickWindowActions({ events: bus, hide: hide ?? tauriHideWindow }),
    [bus, hide],
  );
  const [theme] = useState(() =>
    themeForScheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true),
  );
  const colors = useMemo(() => terminalTheme(theme), [theme]);
  // A new key remounts the terminal, which starts a new shell.
  const [shell, setShell] = useState<number | undefined>();
  const [sessionId, setSessionId] = useState<number | undefined>();
  const [notice, setNotice] = useState("");
  const [promoting, setPromoting] = useState(false);
  const session = useRef<number | undefined>(undefined);
  const terminal = useRef<TerminalHandle | undefined>(undefined);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    let stopped = false;
    const stops: (() => void)[] = [];
    const listen = async (event: string, handler: (payload: unknown) => void) => {
      const stop = await bus.listen(event, handler);
      if (stopped) stop();
      else stops.push(stop);
    };
    const letGo = () => {
      session.current = undefined;
      terminal.current = undefined;
      setSessionId(undefined);
      setShell(undefined);
    };
    const start = async () => {
      await listen(QUICK_OPEN_EVENT, () => setShell((open) => open ?? Date.now()));
      await listen(QUICK_PROMOTED_EVENT, (payload) => {
        const id = sessionOfPayload(payload);
        const ok = (payload as { ok?: unknown } | null)?.ok === true;
        if (ok && id !== undefined && id === session.current) letGo();
      });
      // Only now: whoever waits for this page may send `quick-open`.
      await bus.emit(QUICK_READY_EVENT);
    };
    start().catch(() => undefined);
    // A shell that ended on its own is not worth keeping on screen: the next open starts another.
    const unsubscribeExit = backend.onExit((exit) => {
      if (exit.id === session.current) letGo();
    });
    return () => {
      stopped = true;
      for (const stop of stops) stop();
      unsubscribeExit();
    };
  }, [backend, bus]);

  // Esc hides the window. The press is ours: the terminal does not get it (a full-screen program in
  // this window, an editor for one, would want the key, and this window is not the place for it).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.metaKey
      ) {
        return;
      }
      // Only a press that belongs to this window: in a page that also draws the app (the e2e
      // preview) the Esc of the other terminals is theirs.
      const target = event.target instanceof Node ? event.target : null;
      const own =
        target === null ||
        target === document.body ||
        target === document.documentElement ||
        root.current?.contains(target) === true;
      if (!own) return;
      event.preventDefault();
      event.stopPropagation();
      void actions.escape();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions]);

  // Shown by the shortcut: the keyboard goes to the terminal, not to the page around it.
  useEffect(() => {
    const onFocus = () => terminal.current?.focus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const showNotice = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);

  const promote = () => {
    if (sessionId === undefined || promoting) return;
    setPromoting(true);
    void actions
      .promote(sessionId)
      .then((result) => {
        if (!result.ok) showNotice(t("quick.promoteFailed", { reason: result.reason }));
      })
      .finally(() => setPromoting(false));
  };

  return (
    <div ref={root} className="app quick-app" data-nr-part="quick-app">
      <div className="quick-bar">
        <span className="quick-title">{t("quick.title")}</span>
        <button
          type="button"
          className="quick-promote"
          data-nr-part="quick-promote"
          disabled={sessionId === undefined || promoting}
          onClick={promote}
        >
          <ArrowUpRight size={14} aria-hidden="true" />
          {t("quick.promote")}
        </button>
      </div>
      {shell !== undefined && (
        <TerminalView
          key={shell}
          backend={backend}
          theme={colors}
          onReady={(handle) => {
            terminal.current = handle;
            handle.focus();
          }}
          onSessionStart={(id) => {
            session.current = id;
            setSessionId(id);
            bus.emit(QUICK_SESSION_EVENT, { id }).catch(() => undefined);
          }}
        />
      )}
      <div
        className="quick-notice"
        role="status"
        data-nr-part="quick-notice"
        data-nr-state={notice !== "" ? "shown" : "empty"}
      >
        {notice}
      </div>
    </div>
  );
}

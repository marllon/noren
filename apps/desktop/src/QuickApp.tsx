import { useEffect, useMemo, useRef, useState } from "react";
import { createBackend } from "./backend";
import {
  QUICK_OPEN_EVENT,
  QUICK_PROMOTED_EVENT,
  QUICK_READY_EVENT,
  QUICK_SESSION_EVENT,
  sessionOfPayload,
  tauriQuickEvents,
} from "./quick";
import { TerminalView } from "./TerminalView";
import { applyTheme, terminalTheme, themeForScheme } from "./theme";

const backend = createBackend();
const events = tauriQuickEvents();

/**
 * The page of the quick window: one terminal with the default profile and nothing else. It does not
 * read the workspace, the settings or the saved state (the main window owns them), so it cannot
 * write over them. The shell starts when the Rust side asks (`quick-open`), and a promotion
 * (`quick-promoted` for its session) hands the shell to the main window: this page lets go of it
 * without ending it and waits for the next `quick-open`.
 */
export function QuickApp() {
  const [theme] = useState(() =>
    themeForScheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true),
  );
  const colors = useMemo(() => terminalTheme(theme), [theme]);
  // A new key remounts the terminal, which starts a new shell.
  const [shell, setShell] = useState<number | undefined>();
  const session = useRef<number | undefined>(undefined);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    let stopped = false;
    const stops: (() => void)[] = [];
    const listen = async (event: string, handler: (payload: unknown) => void) => {
      const stop = await events.listen(event, handler);
      if (stopped) stop();
      else stops.push(stop);
    };
    const letGo = () => {
      session.current = undefined;
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
      await events.emit(QUICK_READY_EVENT);
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
  }, []);

  return (
    <div className="app">
      {shell !== undefined && (
        <TerminalView
          key={shell}
          backend={backend}
          theme={colors}
          onSessionStart={(id) => {
            session.current = id;
            events.emit(QUICK_SESSION_EVENT, { id }).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

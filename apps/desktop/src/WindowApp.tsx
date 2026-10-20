import type { Backend, Id } from "@noren/model";
import { useEffect, useMemo, useState } from "react";
import { createBackend } from "./backend";
import { useT } from "./i18n";
import { tauriQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import { TerminalView } from "./TerminalView";
import { applyTheme, terminalTheme, themeForScheme } from "./theme";
import { followTakes } from "./window-events";

interface WindowAppProps {
  /** The window this page is in (`window-<id>`). */
  windowId: Id;
  /** The backend of the page; the real one for this window when left out. */
  backend?: Backend;
  /** The events to the other windows; the app's own when left out. */
  events?: QuickEvents;
}

let ownBackend: Backend | undefined;
/** The backend of a page that is only this window (made once, when the page needs it). */
function pageBackend(): Backend {
  ownBackend ??= createBackend();
  return ownBackend;
}

/**
 * The page of a window besides the main one: it shows the terminals of the tabs that were moved to
 * it. It does not read the workspace, the settings or the saved state (the main window owns them,
 * and is the only page that writes `state.json`), so it cannot write over them; it holds no state
 * but the sessions it was given. A tab moved here arrives as an event from the Rust side
 * (`window-take-sessions`): the page takes over the output of its sessions (`attachSession`, the
 * same processes under the same ids) and draws one terminal for each. The window of a space with its
 * own tabs, sidebar and splits is the next task (NOR-F15-04b).
 */
export function WindowApp({ windowId, backend = pageBackend(), events }: WindowAppProps) {
  const t = useT();
  const bus = useMemo(() => events ?? tauriQuickEvents(), [events]);
  const [theme] = useState(() =>
    themeForScheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true),
  );
  const colors = useMemo(() => terminalTheme(theme), [theme]);
  const [sessions, setSessions] = useState<number[]>([]);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    let stopped = false;
    let stop: (() => void) | undefined;
    followTakes(bus, backend, windowId, (ids) => {
      setSessions((held) => [...held, ...ids.filter((id) => !held.includes(id))]);
    })
      .then((unlisten) => {
        if (stopped) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    // A shell that ended on its own is not worth keeping on screen.
    const unsubscribeExit = backend.onExit((exit) => {
      setSessions((held) => held.filter((id) => id !== exit.id));
    });
    return () => {
      stopped = true;
      stop?.();
      unsubscribeExit();
    };
  }, [backend, bus, windowId]);

  return (
    <div className="app window-app" data-nr-part="window-app" data-nr-window={windowId}>
      <div className="window-bar">
        <span className="window-title">{t("window.title")}</span>
      </div>
      <div className="window-terminals">
        {sessions.length === 0 && <p className="window-waiting">{t("window.waiting")}</p>}
        {sessions.map((id) => (
          <div className="window-terminal" key={id} data-nr-part="window-terminal">
            <TerminalView backend={backend} attach={id} theme={colors} />
          </div>
        ))}
      </div>
    </div>
  );
}

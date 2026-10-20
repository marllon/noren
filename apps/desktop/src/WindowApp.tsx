import { treeItemIds } from "@noren/model";
import type { Backend, Id, Item, Pane, Space } from "@noren/model";
import { useEffect, useMemo, useState } from "react";
import { createBackend } from "./backend";
import { useT } from "./i18n";
import { tauriQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import { SplitLayout } from "./SplitLayout";
import type { SplitLayoutContext } from "./SplitLayout";
import { TerminalView } from "./TerminalView";
import type { TerminalHandle } from "./TerminalView";
import { applyTheme, terminalTheme, themeForScheme } from "./theme";
import { WINDOW_READY_EVENT, followTakes } from "./window-events";
import { WINDOW_ACTION_EVENT, WINDOW_STATE_EVENT, spaceOfWindowState } from "./window-sync";
import type { WindowAction } from "./window-sync";

interface WindowAppProps {
  /** The window this page is in (`window-<id>`). */
  windowId: Id;
  /** The backend of the page; the real one for this window when left out. */
  backend?: Backend;
  /** The events to the other windows; the app's own when left out. */
  events?: QuickEvents;
  /** Called with the handle of each terminal once it is mounted (the e2e preview reads them). */
  onTerminal?(paneId: Id, handle: TerminalHandle): void;
}

/** How long the page waits for its space before it says it is ready again. */
const READY_AGAIN_MS = 1000;

let ownBackend: Backend | undefined;
/** The backend of a page that is only this window (made once, when the page needs it). */
function pageBackend(): Backend {
  ownBackend ??= createBackend();
  return ownBackend;
}

/** The ids of the tabs of the space in the order its sidebar lists them: pinned first, then the tree. */
function tabIdsOf(space: Space): Id[] {
  return [...space.pinned, ...treeItemIds(space.tree)];
}

/** The tabs of the space in that order. */
function tabsOf(space: Space): Item[] {
  return tabIdsOf(space).flatMap((id) => {
    const item = space.items[id];
    return item === undefined ? [] : [item];
  });
}

/** The tab the space shows: the one it names, else its first. */
function shownTabOf(space: Space): Id | undefined {
  const chosen = space.activeItemId;
  if (chosen !== undefined && Object.hasOwn(space.items, chosen)) return chosen;
  return tabIdsOf(space)[0];
}

interface WindowItemProps {
  backend: Backend;
  item: Item;
  /** True when this is the tab on screen; the others stay mounted, hidden. */
  shown: boolean;
  /** The sessions this page took over: a terminal is drawn only for one of them. */
  taken: ReadonlySet<number>;
  colors: ReturnType<typeof terminalTheme>;
  ask(action: WindowAction): void;
  onTerminal?(paneId: Id, handle: TerminalHandle): void;
}

/** The layout of one tab of the window: its panes as nested resizable panels, a terminal in each. */
function WindowItem({ backend, item, shown, taken, colors, ask, onTerminal }: WindowItemProps) {
  const t = useT();
  const context: SplitLayoutContext = {
    focusedPaneId: item.focusedPaneId,
    framed: item.layout.kind === "split",
    zoomedPaneId: item.zoomedPaneId,
    dropEnabled: false,
    headers: false,
    paneTitle: () => "",
    renderPane: (pane: Pane) => {
      // The web view of a browser pane, the preview and the diff stay with the main window until
      // the windows draw them too: a tab that has one does not come here (`windowCanShowTab`).
      if (pane.type !== "terminal") {
        return (
          <p className="window-waiting" data-nr-part="window-pane-elsewhere">
            {t("window.paneElsewhere")}
          </p>
        );
      }
      const session = pane.sessionId === undefined ? undefined : Number(pane.sessionId);
      if (session === undefined || !taken.has(session)) {
        return (
          <p className="window-waiting" data-nr-part="window-pane-waiting">
            {session === undefined ? t("window.noShell") : t("window.waiting")}
          </p>
        );
      }
      return (
        <div
          key={`${pane.id}:${session}`}
          className="window-terminal"
          data-nr-part="window-terminal"
        >
          <TerminalView
            backend={backend}
            attach={session}
            theme={colors}
            active={shown && pane.id === item.focusedPaneId}
            onReady={(handle) => onTerminal?.(pane.id, handle)}
          />
        </div>
      );
    },
    onFocusPane: (paneId) => ask({ type: "pane/focus", itemId: item.id, paneId }),
    onZoomPane: () => undefined,
    onClosePane: () => undefined,
    onDetachPane: () => undefined,
    onPaneMenu: () => undefined,
    onResize: (path, sizes) => ask({ type: "pane/resize", itemId: item.id, path, sizes }),
  };
  return (
    <div className="pane-slot" data-nr-part="window-item" data-nr-item={item.id} hidden={!shown}>
      <SplitLayout layout={item.layout} context={context} />
    </div>
  );
}

/**
 * The page of a window besides the main one: it draws the space the window shows, with the tabs of
 * the space and the splits of terminals of each tab. It does not read the workspace, the settings or
 * the saved state (the main window owns them, and is the only page that writes `state.json`), so it
 * cannot write over them. The space comes from the main window as an event (`window-state`, see
 * `window-sync.ts`) each time it changes, and the few changes this page can make (show another tab,
 * focus a pane, resize a split) go back to the main window as `window-action` events, which checks
 * and runs them. A tab moved here arrives as an event from the Rust side (`window-take-sessions`):
 * the page takes over the output of its sessions (`attachSession`, the same processes under the
 * same ids), and a terminal is drawn for a pane only once its session is taken. The browser, preview
 * and diff panes, the sidebar and the unread marks of the window are the next task (NOR-F15-04c).
 */
export function WindowApp({
  windowId,
  backend = pageBackend(),
  events,
  onTerminal,
}: WindowAppProps) {
  const t = useT();
  const bus = useMemo(() => events ?? tauriQuickEvents(), [events]);
  const [theme] = useState(() =>
    themeForScheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true),
  );
  const colors = useMemo(() => terminalTheme(theme), [theme]);
  const [taken, setTaken] = useState<ReadonlySet<number>>(() => new Set());
  const [space, setSpace] = useState<Space>();

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    let stopped = false;
    const stops: (() => void)[] = [];
    const keep = (unlisten: () => void): void => {
      if (stopped) unlisten();
      else stops.push(unlisten);
    };
    // The state is listened to before the page says it is ready, so the answer cannot be missed.
    bus
      .listen(WINDOW_STATE_EVENT, (payload) => {
        const next = spaceOfWindowState(payload, windowId);
        if (next !== undefined) setSpace(next);
      })
      .then((unlisten) => {
        keep(unlisten);
        return followTakes(bus, backend, windowId, (ids) => {
          setTaken((held) => new Set([...held, ...ids]));
        });
      })
      .then(keep)
      .catch(() => undefined);
    // A shell that ended on its own is not drawn any more; the main window marks the pane.
    const unsubscribeExit = backend.onExit((exit) => {
      setTaken((held) => {
        if (!held.has(exit.id)) return held;
        const next = new Set(held);
        next.delete(exit.id);
        return next;
      });
    });
    return () => {
      stopped = true;
      for (const stop of stops) stop();
      unsubscribeExit();
    };
  }, [backend, bus, windowId]);

  // The main window sends the space when this page says it is ready, and may not have been
  // listening yet (it starts at the same time as the window is made): until the space arrives the
  // page says so again, once a second.
  const waiting = space === undefined;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => {
      bus.emit(WINDOW_READY_EVENT, { windowId }).catch(() => undefined);
    }, READY_AGAIN_MS);
    return () => clearInterval(timer);
  }, [bus, waiting, windowId]);

  const ask = useMemo(
    () =>
      (action: WindowAction): void => {
        bus.emit(WINDOW_ACTION_EVENT, { windowId, action }).catch(() => undefined);
      },
    [bus, windowId],
  );

  const tabs = space === undefined ? [] : tabsOf(space);
  const shownId = space === undefined ? undefined : shownTabOf(space);
  return (
    <div className="app window-app" data-nr-part="window-app" data-nr-window={windowId}>
      <div className="window-bar">
        <span className="window-title" data-nr-part="window-title">
          {space?.name ?? t("window.title")}
        </span>
      </div>
      {space !== undefined && tabs.length > 0 && (
        <div className="window-tabs" role="tablist" aria-label={t("window.tabs")}>
          {tabs.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="window-tab"
              data-nr-part="window-tab"
              data-nr-item={item.id}
              aria-selected={item.id === shownId}
              onClick={() =>
                ask({ type: "space/set-active-item", spaceId: space.id, itemId: item.id })
              }
            >
              {item.title ?? t("tree.tabDefault", { n: index + 1 })}
            </button>
          ))}
        </div>
      )}
      <div className="window-content" data-nr-part="window-content">
        {tabs.length === 0 && <p className="window-waiting">{t("window.waiting")}</p>}
        {tabs.map((item) => (
          <WindowItem
            key={item.id}
            backend={backend}
            item={item}
            shown={item.id === shownId}
            taken={taken}
            colors={colors}
            ask={ask}
            {...(onTerminal !== undefined ? { onTerminal } : {})}
          />
        ))}
      </div>
    </div>
  );
}

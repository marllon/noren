import { treeItemIds } from "@noren/model";
import type { Action, Backend, Id, Item, Pane, Space } from "@noren/model";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { createBackend } from "./backend";
import { ContextMenu } from "./ContextMenu";
import { DiffPane } from "./DiffPane";
import { useT } from "./i18n";
import { PreviewPane } from "./PreviewPane";
import { tauriQuickEvents } from "./quick";
import type { QuickEvents } from "./quick";
import { SidebarTree } from "./SidebarTree";
import { visibleRows } from "./sidebar-tree";
import type { MenuPoint } from "./SpaceMenu";
import { SplitLayout } from "./SplitLayout";
import type { SplitLayoutContext } from "./SplitLayout";
import { TerminalView } from "./TerminalView";
import type { TerminalHandle } from "./TerminalView";
import { applyTheme, terminalTheme, themeForScheme } from "./theme";
import { TreeDnd } from "./TreeDnd";
import { WINDOW_READY_EVENT, followTakes } from "./window-events";
import {
  WINDOW_ACTION_EVENT,
  WINDOW_STATE_EVENT,
  createWindowReads,
  spaceOfWindowState,
} from "./window-sync";
import type { WindowAction, WindowReads } from "./window-sync";

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

/** How wide the sidebar of a window is (px): the tabs of one space, narrower than the main window's. */
const SIDEBAR_WIDTH = 168;

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
  /** Where the preview and diff panes of the tab get their files and diffs from: the main window. */
  reads: WindowReads;
  ask(action: WindowAction): void;
  onTerminal?(paneId: Id, handle: TerminalHandle): void;
}

/**
 * The layout of one tab of the window: its panes as nested resizable panels, a terminal in each
 * terminal pane and the file or the diff in each preview and diff pane.
 */
function WindowItem({
  backend,
  item,
  shown,
  taken,
  colors,
  reads,
  ask,
  onTerminal,
}: WindowItemProps) {
  const t = useT();
  const context: SplitLayoutContext = {
    focusedPaneId: item.focusedPaneId,
    framed: item.layout.kind === "split",
    zoomedPaneId: item.zoomedPaneId,
    dropEnabled: false,
    headers: false,
    paneTitle: () => "",
    renderPane: (pane: Pane) => {
      // A preview and a diff pane have no shell: they show what the main window read for them
      // (the page of a window can read no file and run no git), the diff while it is on screen.
      if (pane.type === "preview") {
        return <PreviewPane key={pane.id} backend={reads.forPane(item.id, pane.id)} pane={pane} />;
      }
      if (pane.type === "diff") {
        return (
          <DiffPane
            key={pane.id}
            backend={reads.forPane(item.id, pane.id)}
            pane={pane}
            visible={shown && (item.zoomedPaneId === undefined || item.zoomedPaneId === pane.id)}
          />
        );
      }
      // The web view of a browser pane stays a child of the main window until a window can be its
      // parent (NOR-F15-04e): a tab that has one does not come here (`windowCanShowTab`).
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

/** What the tree of the sidebar can ask of a window: a drop that moves a tab inside the space. */
function moveRequestOf(action: Action): WindowAction | undefined {
  if (action.type !== "item/move" || action.spaceId !== undefined) return undefined;
  return action.placement === undefined
    ? undefined
    : { type: "item/move", itemId: action.itemId, placement: action.placement };
}

/**
 * The page of a window besides the main one: it draws the space the window shows, with the sidebar
 * of its tabs (the same tree the main window has: click to show a tab, drag to put the tabs in
 * order, Delete or the menu to close one, and the button for a new tab) and the splits of terminals
 * of the tab on screen. It does not read the workspace, the settings or the saved state (the main
 * window owns them, and is the only page that writes `state.json`), so it cannot write over them.
 * The space comes from the main window as an event (`window-state`, see `window-sync.ts`) each time
 * it changes, and the changes this page can make (show another tab, focus a pane, resize a split,
 * open, close or move a tab) go back to the main window as `window-action` events, which checks and
 * runs them: a new tab is a shell that the main window starts and this page then takes over. A tab
 * moved here arrives as an event from the Rust side (`window-take-sessions`): the page takes over
 * the output of its sessions (`attachSession`, the same processes under the same ids, with what
 * they printed before so the terminal is not drawn blank), and a terminal is drawn for a pane only
 * once its session is taken. A preview or diff pane in a tab here shows what the main window read
 * for it: the page asks (`window-read`, see `window-sync.ts`) and the main window checks the pane
 * is one of this window's and answers, since the capability of this page has no command to read a
 * file or run git. The browser pane is the next task (NOR-F15-04e).
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
  const [menu, setMenu] = useState<{ itemId: Id; point: MenuPoint } | null>(null);

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

  // The files and diffs of the preview and diff panes come from the main window.
  const reads = useMemo(() => createWindowReads(bus, windowId), [bus, windowId]);
  useEffect(() => () => reads.stop(), [reads]);

  const tabs = space === undefined ? [] : tabsOf(space);
  const shownId = space === undefined ? undefined : shownTabOf(space);
  const style =
    space === undefined ? undefined : ({ "--nr-space-color": space.color } as CSSProperties);
  return (
    <div
      className="app window-app"
      data-nr-part="window-app"
      data-nr-window={windowId}
      {...(style !== undefined ? { style } : {})}
    >
      <div className="window-bar">
        <span className="window-title" data-nr-part="window-title">
          {space?.name ?? t("window.title")}
        </span>
      </div>
      <div className="app-body" data-nr-side="left" data-nr-density="comfortable">
        {space !== undefined && (
          <TreeDnd
            spaces={[space]}
            favorites={[]}
            space={space}
            rows={visibleRows(space)}
            onAction={(action) => {
              const request = moveRequestOf(action);
              if (request !== undefined) ask(request);
            }}
            paneItemId={undefined}
            onPaneDrop={() => undefined}
            onPaneSwap={() => undefined}
          >
            <aside
              className="sidebar window-sidebar"
              data-nr-part="window-sidebar"
              aria-label={t("window.sidebar")}
              style={{ width: SIDEBAR_WIDTH }}
            >
              <SidebarTree
                space={space}
                rows={visibleRows(space)}
                activeId={shownId}
                selected={[]}
                editing={null}
                onItemClick={(itemId) =>
                  ask({ type: "space/set-active-item", spaceId: space.id, itemId })
                }
                onPaneClick={(itemId, paneId) => {
                  ask({ type: "space/set-active-item", spaceId: space.id, itemId });
                  ask({ type: "pane/focus", itemId, paneId });
                }}
                onItemMenu={(itemId, point) => setMenu({ itemId, point })}
                onGroupMenu={() => undefined}
                onToggleGroup={() => undefined}
                onCloseItems={(itemIds) => {
                  for (const itemId of itemIds) ask({ type: "item/close", itemId });
                }}
                onUngroup={() => undefined}
                onStartEdit={() => undefined}
                onCommitEdit={() => undefined}
                onCancelEdit={() => undefined}
              />
              <div className="sidebar-foot">
                <button
                  type="button"
                  className="new-tab"
                  data-nr-part="window-new-tab"
                  onClick={() => ask({ type: "item/create", spaceId: space.id })}
                >
                  {t("window.newTab")}
                </button>
              </div>
            </aside>
          </TreeDnd>
        )}
        <div className="main">
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
                reads={reads}
                ask={ask}
                {...(onTerminal !== undefined ? { onTerminal } : {})}
              />
            ))}
          </div>
        </div>
      </div>
      {menu !== null && (
        <ContextMenu
          label={t("menu.tab")}
          point={menu.point}
          entries={[
            {
              label: t("menu.close"),
              onSelect: () => {
                ask({ type: "item/close", itemId: menu.itemId });
                setMenu(null);
              },
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

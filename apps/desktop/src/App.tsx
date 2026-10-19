import { emit } from "@tauri-apps/api/event";
import { DEFAULT_MAX_PANES, FakeBackend, layoutPanes, treeGroups } from "@noren/model";
import type { GroupNode, Id, Item, Pane, Space } from "@noren/model";
import type { ITheme } from "@xterm/xterm";
import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { insideTauri } from "./backend";
import { backend, booted } from "./boot";
import { loadHome } from "./home";
import { ConfirmDialog } from "./ConfirmDialog";
import { FavoritesGrid } from "./FavoritesGrid";
import { resolveFavorites } from "./favorites";
import type { ResolvedFavorite } from "./favorites";
import {
  clickSelection,
  menuTargets,
  visibleItemIds,
  visibleRows,
  visibleSelection,
} from "./sidebar-tree";
import type { ClickModifiers, Selection } from "./sidebar-tree";
import { sidebarMode } from "./layout";
import { shortCwd } from "./pane-info";
import { updateLayout, useLayout } from "./layout-store";
import { SidebarResizer } from "./SidebarResizer";
import { SidebarTree } from "./SidebarTree";
import { TabBar } from "./TabBar";
import { useSidebarReveal } from "./use-sidebar-reveal";
import type { Editing } from "./SidebarTree";
import { SpaceDialog } from "./SpaceDialog";
import type { SpaceFormValues } from "./SpaceDialog";
import { SpaceMenu } from "./SpaceMenu";
import type { MenuPoint } from "./SpaceMenu";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { SplitLayout } from "./SplitLayout";
import type { SplitLayoutContext } from "./SplitLayout";
import { joinedPaneCount, paneDropAction, paneLimitNotice } from "./sidebar-drop";
import type { PaneDrop } from "./sidebar-drop";
import { keyboardResize } from "./split-layout";
import { splitCommand, typesText } from "./split-keys";
import type { SplitCommand } from "./split-keys";
import { DropZones, TreeDnd } from "./TreeDnd";
import { createWheelGesture, spaceShortcutIndex, wheelTravel } from "./spaces";
import { TerminalView } from "./TerminalView";
import { applySpaceColor, applyTheme, terminalTheme } from "./theme";
import { TitleBar } from "./TitleBar";
import { FavoriteContextMenu, GroupContextMenu, ItemContextMenu } from "./TreeMenus";
import { useTheme } from "./use-theme";
import type { TerminalHandle } from "./TerminalView";
import {
  activeItemIdOf,
  activeSpaceOf,
  sessionStartOptions,
  spaceItemIds,
} from "./workspace-store";
import type { NewSpaceInput, SessionStartOptions, WorkspaceStore } from "./workspace-store";

/** Read-only view of the active terminal, published only when the backend is the in-memory one. */
export interface NorenTestHook {
  lines(): string[];
  renderer(): "webgl" | "dom";
  /** Number of `write` calls the backend received. */
  writeCalls(): number;
  /** Ids of the sessions the backend was asked to kill, in order. */
  killedSessions(): number[];
  /** Options of every `createSession` call the backend received, in order. */
  sessionStarts(): { profileId?: string; cwd?: string; env?: Record<string, string> }[];
  /** Ids of the panes of the active tab, in layout order. */
  paneIds(): string[];
  /** Id of the focused pane of the active tab. */
  focusedPaneId(): string | undefined;
  /** Text of every line of one pane's terminal, whichever tab it is in. */
  paneLines(paneId: string): string[];
  /**
   * Splits a pane of the active tab (the focused one by default) and returns the id of the new
   * pane. There is no way to split from the interface before the split interactions arrive.
   */
  split(dir: "row" | "column", paneId?: string): string | undefined;
}

declare global {
  interface Window {
    __norenTest?: NorenTestHook;
  }
}

/** The pane of the item that has the keyboard. */
function focusedPane(item: Item): Pane | undefined {
  return layoutPanes(item.layout).find((pane) => pane.id === item.focusedPaneId);
}

interface PaneTerminalProps {
  store: WorkspaceStore;
  space: Space;
  pane: Pane;
  /** True when the terminal should hold the keyboard: its tab shows and it is the focused pane. */
  active: boolean;
  colors: ITheme;
  onReady(paneId: Id, handle: TerminalHandle): void;
}

/** One terminal bound to one pane. */
function PaneTerminal({ store, space, pane, active, colors, onReady }: PaneTerminalProps) {
  const { profileId, cwd, env } = sessionStartOptions(space, pane);
  return (
    <TerminalView
      backend={backend}
      theme={colors}
      active={active}
      {...(pane.sessionId !== undefined ? { attach: Number(pane.sessionId) } : {})}
      {...(profileId !== undefined ? { profileId } : {})}
      {...(cwd !== undefined ? { cwd } : {})}
      {...(env !== undefined ? { env } : {})}
      onSessionStart={(id) => store.getState().attachSession(pane.id, String(id))}
      onReady={(handle) => onReady(pane.id, handle)}
    />
  );
}

interface ItemViewProps {
  store: WorkspaceStore;
  space: Space;
  item: Item;
  /** True when this is the tab on screen; the others stay mounted, hidden. */
  shown: boolean;
  colors: ITheme;
  /** The home folder, for the short form of the folder in a pane header (once known). */
  home: string | undefined;
  onReady(paneId: Id, handle: TerminalHandle): void;
}

/** The layout of one tab: its panes as nested resizable panels, a terminal in each. */
function ItemView({ store, space, item, shown, colors, home, onReady }: ItemViewProps) {
  const dispatch = useStore(store, (state) => state.dispatch);
  const { paneHeaders } = useLayout();
  const context: SplitLayoutContext = {
    focusedPaneId: item.focusedPaneId,
    framed: item.layout.kind === "split",
    zoomedPaneId: item.zoomedPaneId,
    dropEnabled: shown,
    headers: paneHeaders,
    paneTitle: (pane) => {
      const cwd = pane.cwd ?? space.defaults.cwd;
      const short = cwd !== undefined ? shortCwd(cwd, home) : "";
      return short !== "" ? short : "Terminal";
    },
    renderPane: (pane) => (
      <PaneTerminal
        key={pane.id}
        store={store}
        space={space}
        pane={pane}
        active={shown && pane.id === item.focusedPaneId}
        colors={colors}
        onReady={onReady}
      />
    ),
    onFocusPane: (paneId) => dispatch({ type: "pane/focus", itemId: item.id, paneId }),
    onZoomPane: (paneId) => dispatch({ type: "pane/zoom", itemId: item.id, paneId }),
    onClosePane: (paneId) => dispatch({ type: "pane/close", itemId: item.id, paneId }),
    onResize: (path, sizes) => dispatch({ type: "pane/resize", itemId: item.id, path, sizes }),
  };
  return (
    <div
      className="pane-slot"
      data-nr-part="item-layout"
      data-nr-zoomed={item.zoomedPaneId !== undefined ? "true" : undefined}
      hidden={!shown}
    >
      <SplitLayout layout={item.layout} context={context} />
    </div>
  );
}

/** How long the notice about a refused split stays on screen. */
const NOTICE_MS = 3500;

/**
 * Carries out a split shortcut on the focused pane of the active tab. Returns the notice to show
 * when the shortcut is refused (a split past the pane limit changes nothing), else undefined.
 */
function runSplitCommand(store: WorkspaceStore, command: SplitCommand): string | undefined {
  const state = store.getState();
  const itemId = activeItemIdOf(state);
  const item = itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
  if (!item) return undefined;
  const { dispatch } = state;
  switch (command.kind) {
    case "split":
      if (layoutPanes(item.layout).length >= DEFAULT_MAX_PANES) {
        return paneLimitNotice(DEFAULT_MAX_PANES);
      }
      dispatch({
        type: "pane/split",
        itemId: item.id,
        paneId: item.focusedPaneId,
        dir: command.dir,
        side: "after",
      });
      return undefined;
    case "close":
      dispatch({ type: "pane/close", itemId: item.id, paneId: item.focusedPaneId });
      return undefined;
    case "zoom":
      dispatch({ type: "pane/zoom", itemId: item.id });
      return undefined;
    case "focus":
      dispatch({ type: "pane/focus-direction", itemId: item.id, direction: command.direction });
      return undefined;
    case "resize": {
      // A zoomed pane hides the separators; resizing what is not on screen would surprise.
      if (item.zoomedPaneId !== undefined) return undefined;
      const resized = keyboardResize(item.layout, item.focusedPaneId, command.direction);
      if (resized) dispatch({ type: "pane/resize", itemId: item.id, ...resized });
      return undefined;
    }
  }
}

/** What covers the shell: a tab, group or space menu, or a dialog about one space (or a new one). */
type Overlay =
  | { kind: "item-menu"; targets: Id[]; point: MenuPoint }
  | { kind: "group-menu"; groupId: Id; point: MenuPoint }
  | { kind: "favorite-menu"; itemId: Id; point: MenuPoint }
  | { kind: "menu"; spaceId: Id; point: MenuPoint }
  | { kind: "new" }
  | { kind: "edit"; spaceId: Id }
  | { kind: "delete"; spaceId: Id };

/** What the new-space dialog hands the store: no folder and no environment when left blank. */
function newSpaceInput(values: SpaceFormValues): NewSpaceInput {
  return {
    name: values.name,
    icon: values.icon,
    color: values.color,
    ...(values.cwd !== "" ? { cwd: values.cwd } : {}),
    ...(Object.keys(values.env).length > 0 ? { env: values.env } : {}),
    ...(values.gitIdentity.name !== "" || values.gitIdentity.email !== ""
      ? { gitIdentity: values.gitIdentity }
      : {}),
  };
}

/** The multi-selection of the sidebar, tied to the space it was made in. */
type SpaceSelection = Selection & { spaceId: Id };

function Shell({ store }: { store: WorkspaceStore }) {
  const workspace = useStore(store, (state) => state.workspace);
  const newTab = useStore(store, (state) => state.newTab);
  const activateItem = useStore(store, (state) => state.activateItem);
  const activateSpace = useStore(store, (state) => state.activateSpace);
  const createSpace = useStore(store, (state) => state.createSpace);
  const editSpace = useStore(store, (state) => state.editSpace);
  const deleteSpace = useStore(store, (state) => state.deleteSpace);
  const moveSpace = useStore(store, (state) => state.moveSpace);
  const dispatch = useStore(store, (state) => state.dispatch);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [selection, setSelection] = useState<SpaceSelection>({ spaceId: "", ids: [] });
  const [editing, setEditing] = useState<Editing | null>(null);
  const handles = useRef(new Map<Id, TerminalHandle>());
  const theme = useTheme();
  const colors = useMemo(() => terminalTheme(theme), [theme]);
  const layout = useLayout();
  const reveal = useSidebarReveal(sidebarMode(layout) === "auto-hide");

  const space = activeSpaceOf(workspace);
  const activeId = activeItemIdOf({ workspace });
  const spaceColor = space.color;
  const itemIds = spaceItemIds(space);
  const rows = visibleRows(space);
  const favorites = resolveFavorites(workspace.spaces, workspace.favorites);
  const order = visibleItemIds(rows);
  // A selection belongs to the space it was made in and only counts tabs that are on screen.
  const selected = selection.spaceId === space.id ? visibleSelection(selection, order) : [];
  const editingHere =
    editing !== null &&
    (editing.kind === "item"
      ? space.items[editing.id] !== undefined
      : treeGroups(space.tree).some((group) => group.id === editing.id))
      ? editing
      : null;

  const clearSelection = () => setSelection({ spaceId: space.id, ids: [] });

  const onItemClick = (itemId: Id, modifiers: ClickModifiers) => {
    const current = selection.spaceId === space.id ? selection : { ids: [] };
    const next = clickSelection(current, order, itemId, modifiers, activeId);
    setSelection({ spaceId: space.id, ...next });
    if (!modifiers.toggle && !modifiers.shift) activateItem(itemId);
  };

  /** Puts the keyboard focus back on a row once the field that replaced it is gone. */
  const focusRow = (id: Id) => {
    requestAnimationFrame(() => {
      // The row is in the sidebar tree, or in the tab bar with top tabs; only one of them exists.
      document.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const startEdit = (target: Editing) => {
    setOverlay(null);
    setEditing(target);
  };

  const onCommitEdit = (target: Editing, value: string, restoreFocus: boolean) => {
    setEditing(null);
    if (target.kind === "group") {
      dispatch({ type: "group/rename", groupId: target.id, name: value });
    } else {
      const item = space.items[target.id];
      // The placeholder ("Tab 3") is not a name the user chose; keep the title unlocked.
      const placeholder = `Tab ${itemIds.indexOf(target.id) + 1}`;
      if (item && !(item.title === undefined && value.trim() === placeholder)) {
        dispatch({ type: "item/rename", itemId: target.id, title: value });
      }
    }
    if (restoreFocus) focusRow(target.id);
  };

  const onCancelEdit = () => {
    if (editingHere) focusRow(editingHere.id);
    setEditing(null);
  };

  // The active space tinges the accent. After the theme's own effect, which sets the accent.
  useEffect(() => {
    applySpaceColor(document.documentElement, theme, spaceColor);
  }, [theme, spaceColor]);

  // The home folder arrives asynchronously; until then folders show in full.
  const [home, setHome] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadHome().then((path) => {
      if (live) setHome(path);
    });
    return () => {
      live = false;
    };
  }, []);

  // Ctrl+Alt+1..9 switches space. Captured on the window so the terminal never sees the keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const index = spaceShortcutIndex(event);
      if (index === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      store.getState().activateSpaceAt(index);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [store]);

  // The split shortcuts act on the focused pane of the active tab. Captured on the window like the
  // space shortcut, so a key that is a shortcut never reaches the terminal and any other key does.
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);
  /** A tab was dropped on a pane of the tab on screen: join it, or say why it cannot be. */
  const onPaneDrop = (sourceId: Id, drop: PaneDrop) => {
    if (activeId === undefined) return;
    const panes = joinedPaneCount(space, sourceId, activeId);
    if (panes === undefined) return;
    if (panes > DEFAULT_MAX_PANES) {
      showNotice(paneLimitNotice(DEFAULT_MAX_PANES));
      return;
    }
    const action = paneDropAction({ kind: "item", id: sourceId }, activeId, drop);
    if (action) dispatch(action);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = splitCommand(event);
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (command === undefined || typesText(target)) return;
      event.preventDefault();
      event.stopPropagation();
      // Holding the key must not split, close or zoom over and over.
      if (event.repeat && !command.repeat) return;
      const refusal = runSplitCommand(store, command);
      if (refusal !== undefined) showNotice(refusal);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearTimeout(noticeTimer.current);
    };
  }, [store, showNotice]);

  // A horizontal wheel (or Shift+wheel) over the sidebar steps to the neighbor space and stops at
  // the ends. The listener is not passive so it can cancel the event, and it does that only when it
  // switches; it sits on the sidebar, so the terminal never sees these events.
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return undefined;
    const gesture = createWheelGesture();
    const onWheel = (event: WheelEvent) => {
      const travel = wheelTravel(event);
      if (travel === 0) return;
      const step = gesture(travel, event.timeStamp);
      if (step === 0) return;
      const state = store.getState();
      const from = state.workspace.spaces.findIndex((s) => s.id === state.workspace.activeSpaceId);
      if (from < 0 || state.workspace.spaces[from + step] === undefined) return;
      event.preventDefault();
      state.activateSpaceAt(from + step);
    };
    sidebar.addEventListener("wheel", onWheel, { passive: false });
    return () => sidebar.removeEventListener("wheel", onWheel);
  }, [store]);

  useEffect(() => {
    if (backend instanceof FakeBackend) {
      const fake = backend;
      const current = () => {
        const state = store.getState();
        const itemId = activeItemIdOf(state);
        const item =
          itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
        const pane = item && focusedPane(item);
        return pane && handles.current.get(pane.id);
      };
      const activeItem = () => {
        const state = store.getState();
        const itemId = activeItemIdOf(state);
        return itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
      };
      window.__norenTest = {
        lines: () => current()?.readLines() ?? [],
        paneIds: () => {
          const item = activeItem();
          return item ? layoutPanes(item.layout).map((pane) => pane.id) : [];
        },
        focusedPaneId: () => activeItem()?.focusedPaneId,
        paneLines: (paneId) => handles.current.get(paneId)?.readLines() ?? [],
        split: (dir, paneId) => {
          const item = activeItem();
          if (!item) return undefined;
          store.getState().dispatch({
            type: "pane/split",
            itemId: item.id,
            paneId: paneId ?? item.focusedPaneId,
            dir,
            side: "after",
          });
          return activeItem()?.focusedPaneId;
        },
        renderer: () => current()?.renderer() ?? "dom",
        writeCalls: () => fake.callsTo("write").length,
        killedSessions: () => fake.callsTo("kill").map((call) => Number(call.args[0])),
        sessionStarts: () =>
          fake.callsTo("createSession").map((call) => {
            const { profileId, cwd, env } = call.args[0] as SessionStartOptions;
            return {
              ...(profileId !== undefined ? { profileId } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...(env !== undefined ? { env } : {}),
            };
          }),
      };
    }
    if (insideTauri) {
      // Tells the Rust side the interface is mounted (used by `noren --smoke`).
      emit("app-ready").catch(() => undefined);
    }
  }, [store]);

  const recordHandle = (paneId: Id, handle: TerminalHandle) => {
    handles.current.set(paneId, handle);
  };

  /** A tile of the Favorites grid: show the space that owns the tab, then the tab. */
  const onOpenFavorite = (favorite: ResolvedFavorite) => {
    dispatch({ type: "space/activate", spaceId: favorite.spaceId });
    dispatch({ type: "space/set-active-item", spaceId: favorite.spaceId, itemId: favorite.id });
  };

  // The actions the sidebar tree and the top tab bar share: same selection, menus and renaming.
  const treeProps = {
    space,
    activeId,
    selected,
    editing: editingHere,
    onItemClick,
    onItemMenu: (itemId: Id, point: MenuPoint) => {
      const targets = menuTargets(selected, itemId);
      if (targets.length === 1 && !selected.includes(itemId)) clearSelection();
      setOverlay({ kind: "item-menu", targets, point });
    },
    onGroupMenu: (groupId: Id, point: MenuPoint) =>
      setOverlay({ kind: "group-menu", groupId, point }),
    onToggleGroup: (group: GroupNode) =>
      dispatch({ type: "group/set-collapsed", groupId: group.id, collapsed: !group.collapsed }),
    onStartEdit: setEditing,
    onCommitEdit,
    onCancelEdit,
  };

  const close = () => setOverlay(null);
  const overlaySpace =
    overlay?.kind === "menu" || overlay?.kind === "edit" || overlay?.kind === "delete"
      ? workspace.spaces.find((s) => s.id === overlay.spaceId)
      : undefined;
  const overlayGroup =
    overlay?.kind === "group-menu"
      ? treeGroups(space.tree).find((group) => group.id === overlay.groupId)
      : undefined;
  let overlayNode: React.ReactNode = null;
  if (overlay?.kind === "item-menu") {
    overlayNode = (
      <ItemContextMenu
        store={store}
        workspace={workspace}
        targets={overlay.targets.filter((id) => space.items[id] !== undefined)}
        point={overlay.point}
        onClose={close}
        onDone={() => {
          clearSelection();
          close();
        }}
        onRename={(itemId) => startEdit({ kind: "item", id: itemId })}
        onGrouped={(groupId) => setEditing({ kind: "group", id: groupId })}
      />
    );
  } else if (
    overlay?.kind === "favorite-menu" &&
    favorites.some((favorite) => favorite.id === overlay.itemId)
  ) {
    overlayNode = (
      <FavoriteContextMenu
        store={store}
        itemId={overlay.itemId}
        point={overlay.point}
        onClose={close}
      />
    );
  } else if (overlayGroup !== undefined && overlay?.kind === "group-menu") {
    overlayNode = (
      <GroupContextMenu
        store={store}
        group={overlayGroup}
        point={overlay.point}
        onClose={close}
        onRename={(groupId) => startEdit({ kind: "group", id: groupId })}
      />
    );
  } else if (overlay?.kind === "new") {
    overlayNode = (
      <SpaceDialog
        onCancel={close}
        onSubmit={(values) => {
          createSpace(newSpaceInput(values));
          close();
        }}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "menu") {
    overlayNode = (
      <SpaceMenu
        space={overlaySpace}
        index={workspace.spaces.indexOf(overlaySpace)}
        count={workspace.spaces.length}
        point={overlay.point}
        onEdit={() => setOverlay({ kind: "edit", spaceId: overlaySpace.id })}
        onMove={(delta) => {
          moveSpace(overlaySpace.id, workspace.spaces.indexOf(overlaySpace) + delta);
          close();
        }}
        onDelete={() => setOverlay({ kind: "delete", spaceId: overlaySpace.id })}
        onClose={close}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "edit") {
    overlayNode = (
      <SpaceDialog
        space={overlaySpace}
        onCancel={close}
        onSubmit={(values) => {
          editSpace(overlaySpace.id, values);
          close();
        }}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "delete") {
    const tabCount = spaceItemIds(overlaySpace).length;
    overlayNode = (
      <ConfirmDialog
        title="Delete space"
        message={`Delete "${overlaySpace.name}"? Its ${tabCount === 1 ? "1 tab" : `${tabCount} tabs`} will be closed and the shells running in them will end.`}
        confirmLabel="Delete space"
        onCancel={close}
        onConfirm={() => {
          deleteSpace(overlaySpace.id);
          close();
        }}
      />
    );
  }

  const autoHide = sidebarMode(layout) === "auto-hide";
  const tabsOnTop = layout.tabs === "top";
  // A menu or dialog opened from the sidebar keeps it shown, even though the pointer left it. The
  // tab and group menus of the top bar do not: they do not come from the sidebar.
  const fromTabBar = tabsOnTop && (overlay?.kind === "item-menu" || overlay?.kind === "group-menu");
  const shown = reveal.revealed || (overlay !== null && !fromTabBar);
  return (
    <div
      className="app-body"
      data-nr-side={layout.side}
      data-nr-density={layout.density}
      data-nr-sidebar-mode={sidebarMode(layout)}
    >
      {autoHide && (
        <div
          className="sidebar-edge"
          data-nr-part="sidebar-edge"
          aria-hidden="true"
          {...reveal.edge}
        />
      )}
      <TreeDnd
        spaces={workspace.spaces}
        favorites={workspace.favorites}
        space={space}
        rows={rows}
        onAction={dispatch}
        paneItemId={activeId}
        onPaneDrop={onPaneDrop}
      >
        <aside
          ref={sidebarRef}
          className="sidebar"
          data-nr-part="sidebar"
          data-nr-state={autoHide ? (shown ? "revealed" : "hidden") : undefined}
          aria-label="Sidebar"
          style={{ width: layout.width }}
          {...reveal.sidebar}
        >
          <SidebarResizer
            side={layout.side}
            width={layout.width}
            onResize={(width) => updateLayout({ width })}
          />
          {favorites.length > 0 && (
            <FavoritesGrid
              favorites={favorites}
              active={{ spaceId: space.id, itemId: activeId }}
              onOpen={onOpenFavorite}
              onMenu={(favorite, point) =>
                setOverlay({ kind: "favorite-menu", itemId: favorite.id, point })
              }
            />
          )}
          {!tabsOnTop && <SidebarTree {...treeProps} rows={rows} home={home} />}
          <div className="sidebar-foot">
            <button type="button" className="new-tab" onClick={() => newTab()}>
              New tab
            </button>
            <DropZones pinned={space.pinned.length === 0} favorites={favorites.length === 0} />
          </div>
          <SpaceSwitcher
            spaces={workspace.spaces}
            activeSpaceId={space.id}
            onActivate={activateSpace}
            onNewSpace={() => setOverlay({ kind: "new" })}
            onMenu={(spaceId, point) => setOverlay({ kind: "menu", spaceId, point })}
          />
        </aside>
        <div className="main">
          {tabsOnTop && <TabBar {...treeProps} onNewTab={() => newTab()} />}
          <section className="content" aria-label="Content">
            {workspace.spaces.map((s) => (
              <div key={s.id} className="space-layer" hidden={s.id !== space.id}>
                {Object.values(s.items).map((item) => (
                  <ItemView
                    key={item.id}
                    store={store}
                    space={s}
                    item={item}
                    shown={s.id === space.id && item.id === activeId}
                    colors={colors}
                    home={home}
                    onReady={recordHandle}
                  />
                ))}
              </div>
            ))}
            <div
              className="pane-notice"
              role="status"
              data-nr-part="pane-notice"
              data-nr-state={notice !== "" ? "shown" : "empty"}
            >
              {notice}
            </div>
          </section>
        </div>
      </TreeDnd>
      {overlayNode}
    </div>
  );
}

function Booted() {
  const result = use(booted);
  if (!result.ok) return <p role="alert">{result.error}</p>;
  return <Shell store={result.store} />;
}

export function App() {
  const theme = useTheme();
  // Before paint, so the first frame already has the colors.
  useLayoutEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  return (
    <main className="app">
      <TitleBar />
      <Suspense fallback={null}>
        <Booted />
      </Suspense>
    </main>
  );
}

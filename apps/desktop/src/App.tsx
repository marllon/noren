import { emit } from "@tauri-apps/api/event";
import {
  DEFAULT_MAX_PANES,
  FakeBackend,
  ManualClock,
  PaneLocationTracker,
  layoutPanes,
  treeGroups,
} from "@noren/model";
import type { GroupNode, Id, Item, Pane, ShellProfile, Space } from "@noren/model";
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
import { consentText } from "./action-consent";
import { loadHome } from "./home";
import { realClock } from "./real-clock";
import { recentFolders, recordFolder } from "./recent-folders-store";
import { ActionsHeader } from "./ActionsHeader";
import { handleDeepLink, setDeepLinkHandler } from "./deep-link";
import { createDeepLinkHandler } from "./deep-link-handler";
import { startDeepLinkReceiver } from "./deep-link-receiver";
import { tauriBridge } from "./tauri-backend";
import { CommandPalette } from "./CommandPalette";
import { ConfigErrorNotice } from "./ConfigErrorNotice";
import { MruSwitcherView } from "./MruSwitcher";
import { TabSearch } from "./TabSearch";
import { collectSearchTabs } from "./tab-search";
import type { SearchHit, SearchTab, TabHits } from "./tab-search";
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
import { NOTHING_UNREAD_NOTICE, shortCwd } from "./pane-info";
import { configManager, useConfigState } from "./config-store";
import { runLayoutCommand } from "./layout-actions";
import type { LayoutCommand } from "./layout-actions";
import { previewSidebarWidth, saveSidebarWidth, useLayout } from "./layout-store";
import { SettingsDialog } from "./SettingsDialog";
import { closeSettings, openSettings, useSettingsOpen } from "./settings-ui";
import { SidebarResizer } from "./SidebarResizer";
import { SidebarTree } from "./SidebarTree";
import { TabBar } from "./TabBar";
import { useMruSwitcher } from "./use-mru-switcher";
import { useProjectActions } from "./use-project-actions";
import { useSidebarReveal } from "./use-sidebar-reveal";
import type { Editing } from "./SidebarTree";
import { SpaceDialog } from "./SpaceDialog";
import type { SpaceFormValues } from "./SpaceDialog";
import { SpaceMenu } from "./SpaceMenu";
import type { MenuPoint } from "./SpaceMenu";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { spaceThemeOptions } from "./space-theme";
import { SplitLayout } from "./SplitLayout";
import type { SplitLayoutContext } from "./SplitLayout";
import { joinedPaneCount, paneDropAction, paneLimitNotice, paneSwapAction } from "./sidebar-drop";
import type { PaneDrop } from "./sidebar-drop";
import { keyboardResize } from "./split-layout";
import { currentResolver, isRecording, useKeybindings } from "./keybindings-store";
import { resolveBindings } from "./keybindings";
import type { ActionCommand } from "./keybindings";
import { buildEntries, buildSpaceThemeEntries } from "./palette";
import type { PaletteEntry } from "./palette";
import { typesText } from "./split-keys";
import { DropZones, TreeDnd } from "./TreeDnd";
import { createWheelGesture, wheelTravel } from "./spaces";
import { TerminalView } from "./TerminalView";
import {
  COPY_FAILED_NOTICE,
  NO_OUTPUT_TO_SELECT_NOTICE,
  NO_PROMPT_NOTICE,
  planCopy,
} from "./command-output";
import type { CommandMarkInfo } from "./command-marks-view";
import { THEMES, applySpaceColor, applyTheme, terminalTheme } from "./theme";
import { TitleBar } from "./TitleBar";
import {
  FavoriteContextMenu,
  GroupContextMenu,
  ItemContextMenu,
  PaneContextMenu,
} from "./TreeMenus";
import type { OutputActions } from "./TreeMenus";
import {
  chooseTheme,
  clearThemePreview,
  previewTheme,
  useTheme,
  useThemeChoice,
} from "./use-theme";
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
  /** Text selected in the active terminal (empty when nothing is). */
  selection(): string;
  /** Buffer row at the top of the active terminal's view and the number of rows in view. */
  viewport(): { top: number; rows: number };
  /** The commands the shell of the active terminal reported, oldest first, with the prompt stepped to flagged. */
  marks(): CommandMarkInfo[];
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
  /**
   * Makes the program of a pane (in any tab or space) write `text` to its terminal, as is: a BEL,
   * an OSC 9 or OSC 777 sequence. Returns `false` when no pane has that id or it has no session.
   */
  sendOutput(paneId: string, text: string): boolean;
  /** Every system notification the backend was asked to show, in order. None is ever shown. */
  notifications(): { title: string; body: string }[];
  /** Makes the fake window have the keyboard focus (it starts with it) or lose it. */
  setWindowFocused(focused: boolean): void;
  /** Every command line the backend was asked to run in a short process (stop commands), in order. */
  commandRuns(): { cwd: string; command: string }[];
  /** Makes the next short commands end with this exit code (0 by default). */
  failCommands(code: number): void;
  /** Number of times the backend was asked to read an actions file. */
  actionsReads(): number;
  /**
   * Moves the clock of the fake shell forward, so a `sleep` ends and a command lasts that long
   * (the clock does not move by itself in web mode).
   */
  advanceClock(ms: number): void;
  /** Hands a raw `noren://` link to the same entry point the desktop app uses; resolves when applied. */
  openUrl(url: string): Promise<void>;
  /**
   * Replaces the text of `config.jsonc` (`null` removes the file), as an edit made by another
   * program would. The web build keeps it in the browser storage, so a reload finds it.
   */
  setConfig(text: string | null): void;
  /** Makes saving `config.jsonc` fail with this message (the disk refused); `null` undoes it. */
  failConfigSaves(message: string | null): void;
  /** Number of times the app was asked to write `config.jsonc`. */
  configSaves(): number;
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

/**
 * One terminal bound to one pane. The tracker turns the output of the session into the folder and
 * git branch of the pane (OSC 7 and 133 from the integrated shell); it is made once per pane, and
 * the session it listens to is the one the terminal starts or attaches.
 */
function PaneTerminal({ store, space, pane, active, colors, onReady }: PaneTerminalProps) {
  const { profileId, cwd, env } = sessionStartOptions(space, pane);
  const [tracker] = useState(
    () =>
      new PaneLocationTracker({
        gitInfo: (folder) => backend.gitInfo(folder),
        onLocation: (location) => store.getState().setPaneLocation(pane.id, location),
        onCommand: (event) => store.getState().setPaneCommand(pane.id, event),
        onAttention: (event) => store.getState().notifyPane(pane.id, event),
        // The fake shell of web mode runs on a clock the tests move, so a command lasts as long
        // as they say.
        clock: backend instanceof FakeBackend ? backend.clock : realClock,
        ...(pane.cwd !== undefined ? { cwd: pane.cwd } : {}),
      }),
  );
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
      onCwd={recordFolder}
      onOutput={(bytes) => tracker.feed(bytes)}
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
  /** The menu button of a pane header was pressed. */
  onPaneMenu(paneId: Id, point: MenuPoint): void;
}

/** The layout of one tab: its panes as nested resizable panels, a terminal in each. */
function ItemView({ store, space, item, shown, colors, home, onReady, onPaneMenu }: ItemViewProps) {
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
    onDetachPane: (paneId) => dispatch({ type: "pane/detach", itemId: item.id, paneId }),
    onPaneMenu,
    onResize: (path, sizes) => dispatch({ type: "pane/resize", itemId: item.id, path, sizes }),
  };
  return (
    <div
      className="pane-slot"
      data-nr-part="item-view"
      data-nr-zoomed={item.zoomedPaneId !== undefined ? "true" : undefined}
      hidden={!shown}
    >
      <SplitLayout layout={item.layout} context={context} />
    </div>
  );
}

/** Keys that are only a modifier: pressing one never ends a switch. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"]);

/** How long the notice about a refused split stays on screen. */
const NOTICE_MS = 3500;

/**
 * Carries out the command of a shortcut: on the space list, the tabs of the active space, or the
 * focused pane of the active tab. Returns the notice to show when the shortcut is refused (a split
 * past the pane limit changes nothing), else undefined.
 */
function runCommand(store: WorkspaceStore, command: ActionCommand): string | undefined {
  const state = store.getState();
  switch (command.kind) {
    case "space":
      state.activateSpaceAt(command.index);
      return undefined;
    case "new-tab":
      state.newTab();
      return undefined;
    case "last-unread":
      return state.showLastUnread() ? undefined : NOTHING_UNREAD_NOTICE;
    case "tab": {
      const tabId = spaceItemIds(activeSpaceOf(state.workspace))[command.index];
      if (tabId !== undefined) state.activateItem(tabId);
      return undefined;
    }
    default:
      break;
  }
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
    default:
      return undefined;
  }
}

/** What covers the shell: a tab, group or space menu, or a dialog about one space (or a new one). */
type Overlay =
  | { kind: "item-menu"; targets: Id[]; point: MenuPoint }
  | { kind: "group-menu"; groupId: Id; point: MenuPoint }
  | { kind: "favorite-menu"; itemId: Id; point: MenuPoint }
  | { kind: "pane-menu"; paneId: Id; point: MenuPoint }
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  // What the open palette lists: everything, or only the themes the active space can take.
  const [paletteMode, setPaletteMode] = useState<"all" | "space-theme">("all");
  // The search over all tabs: the text of every tab, read when it opened (null while it is closed).
  const [searchText, setSearchText] = useState<SearchTab[] | null>(null);
  const handles = useRef(new Map<Id, TerminalHandle>());
  const theme = useTheme();
  const themeChoice = useThemeChoice();
  const colors = useMemo(() => terminalTheme(theme), [theme]);
  // The global theme, for the callbacks below that must not change with it.
  const themeChoiceRef = useRef(themeChoice);
  useEffect(() => {
    themeChoiceRef.current = themeChoice;
  }, [themeChoice]);
  const layout = useLayout();
  // A file with a problem of its own cannot be edited, so the handle cannot save a width either.
  const settingsFileBroken = useConfigState().errors.length > 0;
  const settingsOpen = useSettingsOpen();
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

  /** A pane in the list of a split tab: the same path as a click on the tab, then the pane's focus. */
  const onPaneClick = (itemId: Id, paneId: Id) => {
    onItemClick(itemId, { toggle: false, shift: false });
    dispatch({ type: "pane/focus", itemId, paneId });
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

  // The shell profiles of the machine, for the palette; listed once.
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  useEffect(() => {
    let live = true;
    backend.listProfiles().then(
      (list) => {
        if (live) setProfiles(list);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  // The notice about a refused shortcut (a split past the pane limit), shown for a few seconds.
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);
  /** A layout action writes its setting into the file; a refusal or a failed write is a notice. */
  const runLayout = useCallback(
    (command: LayoutCommand) => {
      void runLayoutCommand(configManager, command).then((problem) => {
        if (problem !== undefined) showNotice(problem);
      });
    },
    [showNotice],
  );
  const projectActions = useProjectActions(store, backend, space, showNotice);
  // A `noren://` link: the entry point stays the same while the run function (and so the hook's
  // state) changes on every render, so the handler reads it through a ref.
  const runActionIn = useRef(projectActions.runIn);
  runActionIn.current = projectActions.runIn;
  useEffect(() => {
    setDeepLinkHandler(
      createDeepLinkHandler({
        store,
        backend,
        runAction: (spaceId, action) => runActionIn.current(spaceId, action),
        notify: showNotice,
      }),
    );
    return () => setDeepLinkHandler(undefined);
  }, [store, showNotice]);
  // In the desktop app the Rust side delivers the links the system hands over. After the handler
  // effect above, so a waiting link finds the handler registered.
  useEffect(() => {
    if (!insideTauri) return undefined;
    return startDeepLinkReceiver({
      bridge: tauriBridge(),
      apply: handleDeepLink,
      activeFolder: () => activeSpaceOf(store.getState().workspace).defaults.cwd,
    });
  }, [store]);
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
  /** A pane header was dropped on the middle of another pane of the tab on screen: swap them. */
  const onPaneSwap = (paneId: Id, otherPaneId: Id) => {
    if (activeId === undefined) return;
    const action = paneSwapAction(activeId, paneId, otherPaneId);
    if (action) dispatch(action);
  };
  /**
   * Shows the space that owns a tab, then the tab (a Favorites tile, the palette and the Ctrl+Tab
   * switcher use it). The tab is chosen before the space is shown, so the space's old tab never
   * counts as used.
   */
  const showTab = (spaceId: Id, itemId: Id) => {
    dispatch({ type: "space/set-active-item", spaceId, itemId });
    dispatch({ type: "space/activate", spaceId });
  };

  /** Gives the keyboard to the terminal of the tab on screen, after the render that shows it. */
  const focusTerminal = useCallback(() => {
    requestAnimationFrame(() => {
      const state = store.getState();
      const itemId = activeItemIdOf(state);
      const item = itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
      const pane = item && focusedPane(item);
      if (pane) handles.current.get(pane.id)?.focus();
    });
  }, [store]);

  /** The terminal of the focused pane of the tab on screen. */
  const focusedHandle = useCallback((): TerminalHandle | undefined => {
    const state = store.getState();
    const itemId = activeItemIdOf(state);
    const item = itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
    const pane = item && focusedPane(item);
    return pane ? handles.current.get(pane.id) : undefined;
  }, [store]);

  /**
   * Carries out a command mark action on a pane (the focused one of the tab on screen by default):
   * a step to a prompt, selecting the output of a command, copying the output of the last one. Each
   * says in a notice why it did nothing.
   */
  const terminalAction = useCallback(
    (command: ActionCommand, paneId?: Id): void => {
      const handle = paneId === undefined ? focusedHandle() : handles.current.get(paneId);
      if (handle === undefined) return;
      if (command.kind === "prompt") {
        if (!handle.jumpToPrompt(command.direction)) showNotice(NO_PROMPT_NOTICE);
      } else if (command.kind === "select-output") {
        if (handle.selectOutput()) handle.focus();
        else showNotice(NO_OUTPUT_TO_SELECT_NOTICE);
      } else if (command.kind === "copy-output") {
        const plan = planCopy(handle.lastOutput());
        if (plan.text === undefined) {
          showNotice(plan.notice);
          return;
        }
        navigator.clipboard.writeText(plan.text).then(
          () => showNotice(plan.notice),
          () => showNotice(COPY_FAILED_NOTICE),
        );
      }
    },
    [focusedHandle, showNotice],
  );

  /** Opens the search over all tabs on the text the terminals hold now. */
  const openSearch = useCallback(() => {
    setPaletteOpen(false);
    setSearchText(
      collectSearchTabs(store.getState().workspace, (paneId) =>
        handles.current.get(paneId)?.readLines(),
      ),
    );
  }, [store]);

  /** Closes the search and gives the keyboard back to the terminal of the tab on screen. */
  const closeSearch = useCallback(() => {
    setSearchText(null);
    focusTerminal();
  }, [focusTerminal]);

  /**
   * Goes to a line of the search: shows its tab (and space), focuses the pane and selects the line
   * in the terminal. The tab may have been hidden until now, so the terminal is told after the
   * render that shows it, and once more after the next frame, when it has its size back.
   */
  const pickSearchHit = (tab: TabHits, hit: SearchHit) => {
    setSearchText(null);
    showTab(tab.spaceId, tab.itemId);
    dispatch({ type: "pane/focus", itemId: tab.itemId, paneId: hit.paneId });
    requestAnimationFrame(() => {
      const handle = handles.current.get(hit.paneId);
      handle?.revealLine(hit.row);
      handle?.focus();
      requestAnimationFrame(() => handle?.revealLine(hit.row));
    });
  };

  const mru = useMruSwitcher({ store, handles, onCommit: showTab, onEnd: focusTerminal });
  // The key listener below is set up once; it reaches the switcher through this ref.
  const mruRef = useRef(mru);
  mruRef.current = mru;

  const modalOpen = useRef(false);
  // The one keyboard listener: every Noren shortcut goes through the resolver. Captured on the
  // window, so a key that is a shortcut never reaches the terminal and any other key does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The shortcuts screen is capturing a chord: the press is its to read, not an action to run.
      if (isRecording()) return;
      const switcher = mruRef.current;
      if (switcher.active() && event.code === "Escape") {
        // Cancels the switcher; the terminal never sees this Escape.
        event.preventDefault();
        event.stopPropagation();
        switcher.cancel();
        return;
      }
      const action = currentResolver()(event);
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Any other key or shortcut during a switch ends it without switching (the key goes on).
      if (switcher.active() && action?.command.kind !== "mru" && !MODIFIER_KEYS.has(event.key)) {
        switcher.cancel();
      }
      if (action === undefined || typesText(target)) return;
      if (action.command.kind === "prompt") {
        // Ours only when a terminal has the keyboard and has a prompt to go to: with no mark (no
        // integrated shell, a program on the alternate screen) the key is still the shell's.
        if (modalOpen.current || target?.closest(".terminal-host") == null) return;
        if (focusedHandle()?.jumpToPrompt(action.command.direction) === true) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Holding the key must not split, close or zoom over and over.
      if (event.repeat && !action.repeat) return;
      if (action.command.kind === "select-output" || action.command.kind === "copy-output") {
        if (!modalOpen.current) terminalAction(action.command);
        return;
      }
      if (action.command.kind === "palette") {
        // Not over a menu or dialog: they hold the keyboard.
        if (!modalOpen.current) {
          setSearchText(null);
          setPaletteMode("all");
          setPaletteOpen(true);
        }
        return;
      }
      if (action.command.kind === "space-theme") {
        if (!modalOpen.current) {
          setSearchText(null);
          setPaletteMode("space-theme");
          setPaletteOpen(true);
        }
        return;
      }
      if (action.command.kind === "search-all") {
        if (!modalOpen.current) openSearch();
        return;
      }
      if (action.command.kind === "settings") {
        if (!modalOpen.current) openSettings();
        return;
      }
      if (action.command.kind === "layout" || action.command.kind === "layout-width") {
        if (!modalOpen.current) runLayout(action.command);
        return;
      }
      if (action.command.kind === "mru") {
        if (!modalOpen.current || switcher.active()) switcher.step(action.command.delta, event);
        return;
      }
      const refusal = runCommand(store, action.command);
      if (refusal !== undefined) showNotice(refusal);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearTimeout(noticeTimer.current);
    };
  }, [store, showNotice, openSearch, focusedHandle, terminalAction, runLayout]);

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
        selection: () => current()?.selection() ?? "",
        viewport: () => current()?.viewport() ?? { top: 0, rows: 0 },
        marks: () => current()?.marks() ?? [],
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
        sendOutput: (paneId, text) => {
          for (const space of store.getState().workspace.spaces) {
            for (const item of Object.values(space.items)) {
              const sessionId = layoutPanes(item.layout).find((p) => p.id === paneId)?.sessionId;
              if (sessionId === undefined) continue;
              fake.sendOutput(Number(sessionId), text);
              return true;
            }
          }
          return false;
        },
        notifications: () => fake.notifications.map(({ title, body }) => ({ title, body })),
        setWindowFocused: (focused) => fake.setWindowFocused(focused),
        commandRuns: () => fake.commands.map(({ cwd, command }) => ({ cwd, command })),
        failCommands: (code) => fake.setCommandExitCode(code),
        actionsReads: () => fake.callsTo("readActionsFile").length,
        advanceClock: (ms) => {
          if (fake.clock instanceof ManualClock) fake.clock.advance(ms);
        },
        openUrl: (url) => handleDeepLink(url),
        setConfig: (text) => fake.setConfig(text),
        failConfigSaves: (message) =>
          fake.setConfigSaveFailure(message === null ? undefined : new Error(message)),
        configSaves: () => fake.callsTo("saveConfig").length,
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

  const onOpenFavorite = (favorite: ResolvedFavorite) => showTab(favorite.spaceId, favorite.id);

  /** Closes the palette and gives the keyboard back to the terminal of the tab on screen. */
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    focusTerminal();
  }, [focusTerminal]);

  // The theme highlighted in the palette shows at once, unsaved; whatever closes the palette
  // without choosing one (Escape, a click outside, another entry) puts the saved theme back.
  useEffect(() => {
    if (!paletteOpen) clearThemePreview();
  }, [paletteOpen]);
  const onPaletteHighlight = useCallback((entry: PaletteEntry | undefined) => {
    if (entry?.kind === "theme") previewTheme(entry.themeId);
    else if (entry?.kind === "space-theme") {
      // "Use global theme" previews what the window shows with no theme of the space.
      previewTheme(entry.themeId ?? themeChoiceRef.current);
    } else clearThemePreview();
  }, []);

  const keybindings = useKeybindings();
  const paletteEntries = useMemo(
    () =>
      !paletteOpen
        ? []
        : paletteMode === "space-theme"
          ? buildSpaceThemeEntries(space.name, spaceThemeOptions(space.themeId, THEMES))
          : buildEntries({
              workspace,
              chords: resolveBindings(keybindings).chords,
              home,
              profiles,
              folders: recentFolders(),
              themes: { list: THEMES, choice: themeChoice },
            }),
    [paletteOpen, paletteMode, space, workspace, keybindings, home, profiles, themeChoice],
  );

  /** An entry of the palette: the same calls a click or a shortcut makes. */
  const runPaletteEntry = (entry: PaletteEntry) => {
    if (entry.kind === "tab") showTab(entry.spaceId, entry.itemId);
    else if (entry.kind === "space") activateSpace(entry.spaceId);
    else if (entry.kind === "profile") newTab({ profileId: entry.profileId });
    else if (entry.kind === "folder") newTab({ cwd: entry.path });
    else if (entry.kind === "space-theme") {
      // Enter gives the theme to the active space (state.json); null takes it back.
      dispatch({ type: "space/set-theme", spaceId: space.id, themeId: entry.themeId });
    } else if (entry.kind === "theme") {
      // Enter saves the theme highlighted; `chooseTheme` keeps it on screen until the file has it.
      void chooseTheme(entry.themeId).then((problem) => {
        if (problem !== undefined) showNotice(problem);
      });
    } else if (entry.action.command.kind === "search-all") {
      // The search takes the keyboard itself; the palette must not hand it to the terminal.
      openSearch();
      return;
    } else if (entry.action.command.kind === "space-theme") {
      // The same palette goes on, now listing the themes of the space; the preview starts at the
      // first one the arrows reach.
      setPaletteMode("space-theme");
      return;
    } else if (entry.action.command.kind === "settings") {
      // The settings screen takes the keyboard itself, and hands it back to the terminal on close.
      setPaletteOpen(false);
      openSettings();
      return;
    } else if (
      entry.action.command.kind === "layout" ||
      entry.action.command.kind === "layout-width"
    ) {
      runLayout(entry.action.command);
    } else if (entry.action.command.kind === "mru") {
      // No modifier is held in the palette: go straight to the tab the chord would end on.
      setPaletteOpen(false);
      mru.jump(entry.action.command.delta);
      return;
    } else if (
      entry.action.command.kind === "prompt" ||
      entry.action.command.kind === "select-output" ||
      entry.action.command.kind === "copy-output"
    ) {
      terminalAction(entry.action.command);
    } else {
      const refusal = runCommand(store, entry.action.command);
      if (refusal !== undefined) showNotice(refusal);
    }
    closePalette();
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
  // The output actions of a single tab act on its focused pane (the tab is shown to select).
  const menuItem =
    overlay?.kind === "item-menu" && overlay.targets.length === 1
      ? space.items[overlay.targets[0] ?? ""]
      : undefined;
  const itemOutputActions: OutputActions | undefined =
    menuItem === undefined
      ? undefined
      : {
          onSelect: () => {
            activateItem(menuItem.id);
            terminalAction({ kind: "select-output" }, menuItem.focusedPaneId);
          },
          onCopy: () => terminalAction({ kind: "copy-output" }, menuItem.focusedPaneId),
        };
  if (overlay?.kind === "item-menu") {
    const tabAction =
      overlay.targets.length === 1
        ? projectActions.actionOfTab(overlay.targets[0] ?? "")
        : undefined;
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
        {...(itemOutputActions !== undefined ? { outputActions: itemOutputActions } : {})}
        {...(tabAction !== undefined
          ? {
              projectAction: {
                label: tabAction.label,
                running: projectActions.statusOf(tabAction) === "running",
                onRun: () => projectActions.run(tabAction),
                onStop: () => projectActions.stop(tabAction),
              },
            }
          : {})}
      />
    );
  } else if (overlay?.kind === "pane-menu") {
    const { paneId } = overlay;
    overlayNode = (
      <PaneContextMenu
        point={overlay.point}
        onClose={close}
        onSelect={() => terminalAction({ kind: "select-output" }, paneId)}
        onCopy={() => terminalAction({ kind: "copy-output" }, paneId)}
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
        themes={spaceThemeOptions(overlaySpace.themeId, THEMES)}
        point={overlay.point}
        onTheme={(themeId) => {
          dispatch({ type: "space/set-theme", spaceId: overlaySpace.id, themeId });
          close();
        }}
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

  const { pending } = projectActions;
  modalOpen.current = overlay !== null || pending !== null || settingsOpen;
  const confirmNode = pending !== null && (
    <ConfirmDialog
      title="Run project action"
      message={`Run "${pending.action.label}"? Noren will type the command below into the tab "${pending.action.tab}" and press Enter.${pending.action.stop !== undefined ? " The second line runs when you stop it." : ""} It comes from the project's .noren/actions.json.`}
      detail={consentText(pending.action)}
      confirmLabel="Run"
      danger={false}
      onCancel={projectActions.cancelPending}
      onConfirm={projectActions.confirmPending}
    />
  );
  const autoHide = sidebarMode(layout) === "auto-hide";
  const tabsOnTop = layout.tabs === "top";
  // A menu or dialog opened from the sidebar keeps it shown, even though the pointer left it. The
  // tab and group menus of the top bar do not: they do not come from the sidebar.
  const fromTabBar = tabsOnTop && (overlay?.kind === "item-menu" || overlay?.kind === "group-menu");
  // A pane menu does not come from the sidebar either.
  const shown =
    reveal.revealed ||
    pending !== null ||
    (overlay !== null && !fromTabBar && overlay.kind !== "pane-menu");
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
        onPaneSwap={onPaneSwap}
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
            onPreview={previewSidebarWidth}
            onCommit={(width) => void saveSidebarWidth(width)}
            disabled={settingsFileBroken}
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
          <ActionsHeader spaceName={space.name} ui={projectActions} />
          {!tabsOnTop && (
            <SidebarTree {...treeProps} rows={rows} home={home} onPaneClick={onPaneClick} />
          )}
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
                    onPaneMenu={(paneId, point) => setOverlay({ kind: "pane-menu", paneId, point })}
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
      {confirmNode}
      {mru.rows !== undefined && <MruSwitcherView rows={mru.rows} />}
      {searchText !== null && (
        <TabSearch tabs={searchText} onPick={pickSearchHit} onClose={closeSearch} />
      )}
      {paletteOpen && (
        <CommandPalette
          key={paletteMode}
          entries={paletteEntries}
          {...(paletteMode === "space-theme"
            ? { placeholder: `Theme for ${space.name}  (Enter to keep, Esc to cancel)` }
            : {})}
          onRun={runPaletteEntry}
          onClose={closePalette}
          onHighlight={onPaletteHighlight}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            closeSettings();
            focusTerminal();
          }}
        />
      )}
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
      <ConfigErrorNotice />
      <Suspense fallback={null}>
        <Booted />
      </Suspense>
    </main>
  );
}

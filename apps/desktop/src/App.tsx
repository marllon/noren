import { emit } from "@tauri-apps/api/event";
import {
  DEFAULT_MAX_PANES,
  FakeBackend,
  ManualClock,
  PaneLocationTracker,
  aiIsOn,
  browserUrlProblem,
  exportSpace,
  layoutPanes,
  mainWindowSpaces,
  previewPathProblem,
  resolveOutputPath,
  scrollbackAllowed,
  syncMethodOf,
  treeGroups,
  windowShowing,
  withMod,
} from "@noren/model";
import type {
  AgentRow,
  BrowserBounds,
  FakeSshTarget,
  GitDiffRefusal,
  GroupNode,
  Id,
  Item,
  Pane,
  SessionLink,
  SessionLinkState,
  Space,
} from "@noren/model";
import type { ITheme } from "@xterm/xterm";
import type { ChangeEvent } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { insideTauri } from "./backend";
import { perfMark, perfMarkOnce } from "./perf-probe";
import { backend, booted } from "./boot";
import type { BootResult } from "./boot";
import { consentText } from "./action-consent";
import { loadHome } from "./home";
import { realClock } from "./real-clock";
import { recentFolders, recordFolder } from "./recent-folders-store";
import { ActionsHeader } from "./ActionsHeader";
import { handleDeepLink, setDeepLinkHandler } from "./deep-link";
import { createDeepLinkHandler } from "./deep-link-handler";
import { startDeepLinkReceiver } from "./deep-link-receiver";
import { QUICK_TOGGLE_ACTION } from "./quick-shortcut";
import { quickShortcut } from "./quick-shortcut-store";
import { formatChord } from "./shortcuts-screen";
import { followQuickPromotions, promoteQuickSession } from "./quick-promote";
import type { PromoteResult } from "./quick-promote";
import { quickPreviewEnabled, quickPreviewEvents, tauriQuickEvents } from "./quick";
import { windowsAvailable } from "./window-host";
import { moveItemToNewWindow, windowMoveProblem } from "./window-service";
import { retryFailedLinks } from "./session-link-store";
import { tauriBridge } from "./tauri-backend";
import { AskPanel } from "./AskPanel";
import { PluginPanel } from "./PluginPanel";
import { BrowserPane } from "./BrowserPane";
import { browserTitle } from "./browser-address";
import { DiffPane } from "./DiffPane";
import { badFolderNotice, diffLimitNotice, diffTitle, noFolderNotice } from "./diff-view";
import { PreviewPane } from "./PreviewPane";
import { openPathNotice, previewLimitNotice, previewTitle } from "./preview-view";
import { askOffNotice, shellNameOf } from "./ask-panel";
import type { AskSources, ExplainRequest } from "./ask-panel";
import { CommandAskDialog } from "./CommandAskDialog";
import { CommandPalette } from "./CommandPalette";
import { osNameOf } from "./os-name";
import { ConfigErrorNotice } from "./ConfigErrorNotice";
import { MruSwitcherView } from "./MruSwitcher";
import { TabSearch } from "./TabSearch";
import { collectSearchTabs } from "./tab-search";
import type { SearchHit, SearchTab, TabHits } from "./tab-search";
import { ConfirmDialog } from "./ConfirmDialog";
import { LinkPrompt } from "./LinkPrompt";
import { FavoritesGrid } from "./FavoritesGrid";
import { itemTitle, resolveFavorites } from "./favorites";
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
import { useLanguage, t, tabCount } from "./i18n";
import { refreshLiveGroups, worktreesGroupName } from "./live-groups-service";
import { agentStateLabel, nothingUnreadNotice, shortCwd, summarizeItem } from "./pane-info";
import { peekLinesOfItem } from "./peek-source";
import { configManager, useConfigState } from "./config-store";
import { AnnouncerRegion } from "./AnnouncerRegion";
import {
  announcer,
  bellAnnouncement,
  commandAnnouncement,
  navigationAnnouncement,
  sessionEndedAnnouncement,
  syncAnnouncement,
  tabNameOfPane,
} from "./announcer";
import type { NavigationPoint } from "./announcer";
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
import { SpaceBackgroundDialog } from "./SpaceBackgroundDialog";
import { SpaceDialog } from "./SpaceDialog";
import type { SpaceFormValues } from "./SpaceDialog";
import { NewWorktreeDialog, RemoveWorktreeDialog } from "./WorktreeDialogs";
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
import { currentPluginHost, pluginTrafficLog, usePluginActions } from "./plugin-host";
import type { PluginStatus, PluginTraffic } from "./plugin-host";
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
import { pictureUrl, showBackgroundImage, usePicture } from "./background-image-store";
import { applySpaceColor, applyTheme, terminalTheme } from "./theme";
import { DemoBanner } from "./demo/DemoBanner";
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
  useWindowScheme,
} from "./use-theme";
import { addUserThemes, getUserThemes, useAllThemes } from "./user-themes-store";
import { useWindowAppearance } from "./use-window";
import { applyWindowVariables, terminalOpacity, windowVariables } from "./window-appearance";
import { requestWindowEffect, requestedWindowEffect } from "./window-effect-store";
import { BackgroundNotice, WindowBackground } from "./WindowBackground";
import { spaceModOptions } from "./mod-options";
import { ModStyles } from "./ModStyles";
import { useModFiles } from "./mods-store";
import { importSchemeFile } from "./scheme-import";
import { downloadText } from "./download-text";
import { appSpaceSyncPort } from "./space-sync";
import { runScreenReaderToggle } from "./screen-reader-action";
import { runSyncCommand } from "./sync-run";
import {
  commitSpaceImport,
  exportFailureNotice,
  exportFileName,
  exportNotice,
  readSpaceFile,
} from "./space-file-io";
import { takenProfileIds } from "./profile-import";
import { getProfiles, syncProfiles, useProfiles, useProfilesProblem } from "./profiles-store";
import { currentAgentScanner } from "./agent-service";
import { AgentsPanel } from "./AgentsPanel";
import {
  feedAgentOutput,
  firstWaitingAgentOf,
  forgetAgentState,
  noteAgentInput,
  noteAgentNotification,
  useAgentStateOfPane,
} from "./agent-state-store";
import { agentOfPane } from "./agent-store";
import { noteArchiveActivity } from "./auto-archive-service";
import { Library } from "./Library";
import type { LibraryEntry } from "./library-entries";
import { GONE_FROM_LIBRARY_NOTICE, NOTHING_CLOSED_NOTICE, reopenClosed } from "./reopen-closed";
import { resumeService } from "./resume-service";
import { restoredScrollbackOf } from "./scrollback-restore";
import { noteTerminalActivity, registerTerminalSnapshot } from "./scrollback-service";
import type { TerminalDrawing, TerminalHandle } from "./TerminalView";
import { useTerminalOptions, zoomTerminalFont } from "./terminal-options-store";
import {
  activeItemIdOf,
  activeSpaceOf,
  itemShownIn,
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
  /** The font, cursor and scrollback xterm has in the focused pane (settings and zoom included). */
  terminalDrawing(): TerminalDrawing | undefined;
  /** The same for any pane of the window, whichever tab it is in. */
  paneDrawing(paneId: string): TerminalDrawing | undefined;
  /** Number of `write` calls the backend received. */
  writeCalls(): number;
  /** Ids of the sessions the backend was asked to kill, in order. */
  killedSessions(): number[];
  /**
   * Starts a shell that belongs to no tab, as the quick window does, and returns its id. It has the
   * size of a fresh session (80x24) until a view takes it over.
   */
  startDetachedSession(): Promise<number>;
  /** Brings such a shell in as a tab of the active space, as a `quick-promote` request does. */
  promoteSession(id: number): Promise<PromoteResult>;
  /** The size the backend has for a session (what the last `resize` set), `undefined` if unknown. */
  sessionSize(id: number): { cols: number; rows: number } | undefined;
  /** Every size the backend was asked to give to a session, in order. */
  sessionResizes(id: number): { cols: number; rows: number }[];
  /** Options of every `createSession` call the backend received, in order. */
  sessionStarts(): { profileId?: string; cwd?: string; env?: Record<string, string> }[];
  /**
   * What every session of a profile of the user was asked to run, in order of start: the profile,
   * the program and arguments of the profile, and the folder the session started in.
   */
  userProfileSessions(): { profileId: string; program: string; args: string[]; cwd: string }[];
  /**
   * The sessions of the profiles of kind ssh, in order of start: the session, the profile, the
   * machine the profile names (nothing of the folder or the environment the window passed) and
   * where its connection stands.
   */
  sshSessions(): {
    id: number;
    profileId: string;
    ssh: FakeSshTarget;
    link: SessionLinkState;
  }[];
  /** Breaks or mends the connection of every live session of an SSH profile, one event each. */
  setProfileLink(profileId: string, link: Omit<SessionLink, "id">): void;
  /** Breaks or mends the connection of one session of an SSH profile. */
  setSessionLink(id: number, link: Omit<SessionLink, "id">): void;
  /** The sessions the window asked the backend to connect again (Try again), in order. */
  retriedSessions(): number[];
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
  /** Puts an agent (or none) under the shell of the pane in the fake process tree, and looks at the tree now. */
  setPaneAgent(paneId: string, agentId: string | undefined): Promise<boolean>;
  /** Makes the fake git refuse to remove this worktree, as it refuses one with changes. */
  setWorktreeDirty(path: string, dirty: boolean): void;
  /** Sets the containers the fake Docker lists as running; `error` makes it fail with that sentence instead. */
  setDockerContainers(containers: string[], error?: string): void;
  /** What the plugins posted to the app and what the app posted back, in order (the answers carry `error` or `result`). */
  pluginTraffic(): PluginTraffic[];
  /** One status per folder of `plugins/`: running, failed or invalid, with the reason. */
  pluginStatus(): readonly PluginStatus[];
  /** Every system notification the backend was asked to show, in order. None is ever shown. */
  notifications(): { title: string; body: string }[];
  /** Makes the fake window have the keyboard focus (it starts with it) or lose it. */
  setWindowFocused(focused: boolean): void;
  /** Every web address the backend was asked to open in the browser, in order. None is ever opened. */
  openedLinks(): string[];
  /**
   * The web views the backend holds for browser panes now, in the order they were opened: the pane,
   * the page, where the view is (a view out of sight has no width or no height) and, for a view
   * that is a child of a window besides the main one, that window (none for a child of the main
   * window). No page is ever loaded.
   */
  browserViews(): { paneId: string; url: string; bounds: BrowserBounds; windowId?: string }[];
  /** Every call about a web view of a pane the backend got, in order, with the pane it was for. */
  browserCalls(): { method: string; paneId: string }[];
  /** The path of every file the backend was asked to read for a preview pane, in order. */
  previewReads(): string[];
  /** The folder of every git diff the backend was asked to read for a diff pane, in order. */
  gitDiffReads(): string[];
  /**
   * Sets the git diff the backend answers for the repository at `folder`: the text `git diff` would
   * print, or a refusal (`{ kind: "refused", reason }`); `null` takes the entry away.
   */
  setGitDiff(folder: string, entry: string | GitDiffRefusal | null): void;
  /** Every command line the backend was asked to run in a short process (stop commands), in order. */
  commandRuns(): { cwd: string; command: string }[];
  /** Makes the next short commands end with this exit code (0 by default). */
  failCommands(code: number): void;
  /** Number of times the backend was asked to read an actions file. */
  actionsReads(): number;
  /** Number of times the backend was asked to read the memory of the computer. */
  hardwareReads(): number;
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
  /**
   * Places the mod file `mods/<name>` with this CSS (`null` removes it), as an editor would; the
   * app reloads the mod without a restart. The web build keeps the files in the browser storage,
   * so a reload finds them.
   */
  setMod(name: string, text: string | null): void;
  /** Every call the backend got about the sync through git, in order, with the address for a connect. */
  syncCalls(): { method: string; remote?: string }[];
  /** Another computer pushed `text` as `path` to the remote (`null` removes it). */
  setSyncRemoteFile(path: string, text: string | null): void;
  /** Puts `text` in the config folder as `path` for the sync (`null` removes it). */
  setSyncLocalFile(path: string, text: string | null): void;
  /** The text of `path` in the config folder as the sync sees it, `null` for none. */
  syncLocalFile(path: string): string | null;
  /** What the remote of the sync holds now, by path. */
  syncRemoteFiles(): Record<string, string>;
  /** Makes every sync call fail with this message (git is missing, say); `null` undoes it. */
  failSync(message: string | null): void;
  /** A gist as another computer (or its web page) left it: files by flat name; replaces that id (NOR-F19-02b). */
  putSyncGist(id: string, gist: { public?: boolean; files?: Record<string, string> }): void;
  /** Sets a file of a gist by its flat name, as an edit on the web page does; `null` removes it. */
  setSyncGistFile(id: string, name: string, text: string | null): void;
  /** The files a gist holds now, by flat name. */
  syncGistFiles(id: string): Record<string, string>;
  /** The ids of the gists GitHub holds. */
  syncGistIds(): string[];
  /** Makes every call of the gist sync fail with this message; `null` undoes it. */
  failSyncGist(message: string | null): void;
  /** The providers lists handed to the AI side (`ai.configure`), in order, as the ids of each list. */
  aiConfigures(): string[][];
  /** The provider ids a key was stored or taken out for (`ai.setKey`), in order. The key is never recorded. */
  aiKeyCalls(): string[];
  /** The key held for a provider in the fake keychain, `undefined` for none: lets a test check where it did not go. */
  storedAiKey(providerId: string): string | undefined;
  /** Everything the backend was asked to write to a session, in order, as the terminal sent it. */
  writes(): { id: number; data: string }[];
  /** The questions the Ask panel sent to the AI (`ai.chat`), in order, with the messages exactly as they went. */
  aiChats(): {
    providerId: string;
    model: string | undefined;
    messages: { role: string; content: string }[];
  }[];
  /** The ids of the requests the AI was asked to cancel (`ai.cancel`), in order. */
  aiCancels(): string[];
  /** Sets what the fake AI answers to the next questions; `null` goes back to its default answer. */
  setAiReply(text: string | null): void;
  /** Makes the fake AI stop each answer after its first piece (`true`) or lets it finish (`false`). */
  holdAiAnswer(held: boolean): void;
  /** Makes saving `config.jsonc` fail with this message (the disk refused); `null` undoes it. */
  failConfigSaves(message: string | null): void;
  /** Number of times the app was asked to write `config.jsonc`. */
  configSaves(): number;
  /** The effects the app asked the window for, in order, with the scheme each was painted for. */
  windowEffectCalls(): { effect: string; scheme: string }[];
  /** The scrollback snapshot files the backend holds now, by pane id. */
  scrollbackFiles(): Record<string, string>;
  /** Every call the backend got about a snapshot (read, write or remove), in order, with the pane. */
  scrollbackCalls(): {
    method: "loadScrollback" | "saveScrollback" | "deleteScrollback";
    paneId: string;
  }[];
  /** How many times the backend was asked to list the snapshot files (the sweep at the start does). */
  scrollbackListCalls(): number;
  /**
   * Places the snapshot file of a pane as if somebody had put it there (`null` removes it). The web
   * build keeps the files in the browser storage, so a reload finds them.
   */
  setScrollbackFile(paneId: string, text: string | null): void;
  /** What the terminal of a pane would save now, before it is cleaned (empty for an unknown pane). */
  paneSnapshot(paneId: string): string;
  /** The text of the rows of a pane's terminal that are dimmed, whichever tab it is in. */
  paneDimLines(paneId: string): string[];
  /** The session of the focused pane of the active tab, `undefined` before it has one. */
  focusedSessionId(): number | undefined;
  /** Whether the (fake) quick window shows after the toggles the backend got. */
  quickVisible(): boolean;
  /** How many times the backend was asked to show or hide the quick window. */
  quickToggles(): number;
  /** The chord the (fake) system holds for the quick terminal now, `null` for none. */
  quickShortcut(): string | null;
  /** Every chord the backend was asked to register for the quick terminal, in order (`null`: none). */
  quickShortcutAsks(): (string | null)[];
  /** Makes the next registration of the quick terminal's shortcut fail with this reason; `null` undoes it. */
  failQuickShortcut(reason: string | null): void;
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

/**
 * What the Explain button of a failed command does: opens the Ask panel on that command. The shell
 * gives it where the panel is, and a terminal offers the button only where the AI is on.
 */
const ExplainContext = createContext<((request: ExplainRequest) => void) | undefined>(undefined);

interface PaneTerminalProps {
  store: WorkspaceStore;
  space: Space;
  pane: Pane;
  /** Name of the terminal region: "Terminal", or its place among several panes of the tab. */
  label: string;
  /** True when the terminal should hold the keyboard: its tab shows and it is the focused pane. */
  active: boolean;
  /** True for a tab that a space shows or will show first: its terminal draws as soon as it mounts. */
  first: boolean;
  colors: ITheme;
  onReady(paneId: Id, handle: TerminalHandle): void;
  /** A link of the output was Ctrl+clicked: true when it opened beside the pane. */
  onOpenLink(url: string): boolean;
  /** A file path of the output was Ctrl+clicked (as written, it may be relative). */
  onOpenPath(path: string): void;
}

/**
 * One terminal bound to one pane. The tracker turns the output of the session into the folder and
 * git branch of the pane (OSC 7 and 133 from the integrated shell); it is made once per pane, and
 * the session it listens to is the one the terminal starts or attaches.
 */
function PaneTerminal({
  store,
  space,
  pane,
  label,
  active,
  first,
  colors,
  onReady,
  onOpenLink,
  onOpenPath,
}: PaneTerminalProps) {
  const { profileId, cwd, env } = sessionStartOptions(space, pane);
  // Font, cursor, scrollback and bell: the settings of the file and the zoom of this window.
  const options = useTerminalOptions();
  // Where the AI is off, a failed command has no Explain button.
  const openExplain = useContext(ExplainContext);
  const onExplain = aiIsOn(useConfigState().config, space) ? openExplain : undefined;
  // The scrollback saved before this window opened, written by the terminal before the new shell
  // prints (only a pane restored from a saved state has any).
  const [restored] = useState(() => restoredScrollbackOf(pane.id));
  // The tracker below lives as long as the pane and was made with the first `pane`; this is the
  // latest one, which says what runs in it now.
  const paneRef = useRef(pane);
  useEffect(() => {
    paneRef.current = pane;
  });
  const [tracker] = useState(
    () =>
      new PaneLocationTracker({
        gitInfo: (folder) => backend.gitInfo(folder),
        onLocation: (location) => store.getState().setPaneLocation(pane.id, location),
        onCommand: (event) => {
          store.getState().setPaneCommand(pane.id, event);
          // A command that ended takes the agent it started with it, and what it was doing.
          if (event.kind === "end") {
            forgetAgentState(pane.id);
            announcer.announce(commandAnnouncement(event.text, event.exitCode));
          }
        },
        onAttention: (event) => {
          store.getState().notifyPane(pane.id, event);
          if (event.kind === "bell") {
            const name = tabNameOfPane(store.getState().workspace, pane.id);
            if (name !== undefined) announcer.announce(bellAnnouncement(name));
          }
          // A notification from an agent (OSC 9, OSC 777) means it wants you.
          if (event.kind === "notification") noteAgentNotification(paneRef.current);
        },
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
      options={options}
      active={active}
      webglFirst={first}
      {...(pane.sessionId !== undefined ? { attach: Number(pane.sessionId) } : {})}
      {...(profileId !== undefined ? { profileId } : {})}
      {...(cwd !== undefined ? { cwd } : {})}
      {...(env !== undefined ? { env } : {})}
      paneId={pane.id}
      label={label}
      {...(restored !== undefined ? { restored } : {})}
      onSessionStart={(id) => store.getState().attachSession(pane.id, String(id))}
      onReady={(handle) => onReady(pane.id, handle)}
      onOpenLink={onOpenLink}
      onOpenPath={onOpenPath}
      onExit={(code) => {
        const name = tabNameOfPane(store.getState().workspace, pane.id);
        if (name !== undefined) announcer.announce(sessionEndedAnnouncement(name, code));
      }}
      currentCwd={() => paneRef.current.cwd}
      onCwd={recordFolder}
      {...(onExplain !== undefined ? { onExplain } : {})}
      onInput={() => {
        resumeService.cancel(pane.id);
        noteAgentInput(pane);
      }}
      onOutput={(bytes) => {
        resumeService.feed(pane.id, bytes);
        tracker.feed(bytes);
        feedAgentOutput(pane, bytes);
        noteTerminalActivity(pane.id);
        noteArchiveActivity(pane.id);
      }}
    />
  );
}

interface ItemViewProps {
  store: WorkspaceStore;
  space: Space;
  item: Item;
  /** True when this is the tab on screen; the others stay mounted, hidden. */
  shown: boolean;
  /** True for the tab that its space shows (when the space is on screen) or will show first. */
  first: boolean;
  colors: ITheme;
  /** The home folder, for the short form of the folder in a pane header (once known). */
  home: string | undefined;
  onReady(paneId: Id, handle: TerminalHandle): void;
  /** The menu button of a pane header was pressed. */
  onPaneMenu(paneId: Id, point: MenuPoint): void;
  /** A link of the output of a pane was Ctrl+clicked: true when it opened beside the pane. */
  onOpenBrowser(paneId: Id, url: string): boolean;
  /** A file path of the output of a pane was Ctrl+clicked: a preview opens beside it, or a notice says why not. */
  onOpenPreview(paneId: Id, path: string): void;
}

/** The layout of one tab: its panes as nested resizable panels, a terminal in each. */
function ItemView({
  store,
  space,
  item,
  shown,
  first,
  colors,
  home,
  onReady,
  onPaneMenu,
  onOpenBrowser,
  onOpenPreview,
}: ItemViewProps) {
  const dispatch = useStore(store, (state) => state.dispatch);
  const { paneHeaders } = useLayout();
  const agentStateOf = useAgentStateOfPane();
  const context: SplitLayoutContext = {
    focusedPaneId: item.focusedPaneId,
    framed: item.layout.kind === "split",
    zoomedPaneId: item.zoomedPaneId,
    dropEnabled: shown,
    headers: paneHeaders,
    paneAgent: (pane) => {
      const state = agentStateOf(pane);
      const name = agentOfPane(pane);
      return state !== undefined && name !== undefined
        ? { state, label: agentStateLabel(name, state) }
        : undefined;
    },
    paneTitle: (pane) => {
      if (pane.type === "browser") return browserTitle(pane.url);
      if (pane.type === "preview") return previewTitle(pane.path);
      if (pane.type === "diff") return diffTitle(pane.cwd);
      const cwd = pane.cwd ?? space.defaults.cwd;
      const short = cwd !== undefined ? shortCwd(cwd, home) : "";
      return short !== "" ? short : t("pane.title");
    },
    // A browser pane has no shell: it draws its address bar and the area its web view is laid over.
    // The pane is in view when its tab is on screen and no other pane of the tab is zoomed over it.
    renderPane: (pane) => {
      if (pane.type === "browser") {
        return (
          <BrowserPane
            key={pane.id}
            backend={backend}
            pane={pane}
            visible={shown && (item.zoomedPaneId === undefined || item.zoomedPaneId === pane.id)}
            onNavigate={(url) =>
              dispatch({ type: "pane/set-url", itemId: item.id, paneId: pane.id, url })
            }
          />
        );
      }
      // A preview pane has no shell either: it reads its file and draws it in the page.
      if (pane.type === "preview")
        return <PreviewPane key={pane.id} backend={backend} pane={pane} />;
      // A diff pane has no shell either: it asks git for the changes of its folder when it is on screen.
      if (pane.type === "diff") {
        return (
          <DiffPane
            key={pane.id}
            backend={backend}
            pane={pane}
            visible={shown && (item.zoomedPaneId === undefined || item.zoomedPaneId === pane.id)}
          />
        );
      }
      // Several panes in a tab are several regions: each is named by its place so they differ.
      const panes = layoutPanes(item.layout);
      const label =
        panes.length > 1
          ? t("pane.terminalNth", {
              n: panes.findIndex((p) => p.id === pane.id) + 1,
              total: panes.length,
            })
          : t("pane.title");
      return (
        <PaneTerminal
          key={pane.id}
          store={store}
          space={space}
          pane={pane}
          label={label}
          active={shown && pane.id === item.focusedPaneId}
          first={first}
          colors={colors}
          onReady={onReady}
          onOpenLink={(url) => onOpenBrowser(pane.id, url)}
          onOpenPath={(path) => onOpenPreview(pane.id, path)}
        />
      );
    },
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
      return state.showLastUnread() ? undefined : nothingUnreadNotice();
    case "font-zoom":
      // The font of every terminal of the window; the file keeps its size.
      zoomTerminalFont(command.change);
      return undefined;
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
  | { kind: "background"; spaceId: Id }
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
  // The library (archive and closed tabs) is open.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // The Agents panel is open.
  const [agentsOpen, setAgentsOpen] = useState(false);
  // The dialog of a git worktree that is open: the folder of the pane it was opened from is the repository.
  const [worktreeDialog, setWorktreeDialog] = useState<{
    kind: "new" | "remove";
    cwd: string;
  } | null>(null);
  // The Ask panel was opened. It shows only where the AI is on (see `askShown` below).
  const [askOpen, setAskOpen] = useState(false);
  // A failed command sent to the Ask panel by its Explain button; `seq` tells one press from the next.
  const [askExplain, setAskExplain] = useState<{ request: ExplainRequest; seq: number }>();
  // "? text" in the palette: the request waiting in its dialog (the shell and system it is for).
  const [commandAsk, setCommandAsk] = useState<
    { request: string; shell: string; os: string } | undefined
  >();
  const handles = useRef(new Map<Id, TerminalHandle>());
  const theme = useTheme();
  const themeChoice = useThemeChoice();
  // The built-in themes and the ones the user imported or placed in the themes folder.
  const themes = useAllThemes();
  // The terminal is see-through while the interface is, and has no background at all while a
  // picture shows behind it.
  const appearance = useWindowAppearance();
  const pictureShown = pictureUrl(usePicture()) !== null;
  const terminalAlpha = terminalOpacity(appearance, pictureShown);
  const colors = useMemo(() => terminalTheme(theme, terminalAlpha), [theme, terminalAlpha]);
  // The global theme, for the callbacks below that must not change with it.
  const themeChoiceRef = useRef(themeChoice);
  useEffect(() => {
    themeChoiceRef.current = themeChoice;
  }, [themeChoice]);
  const layout = useLayout();
  // A file with a problem of its own cannot be edited, so the handle cannot save a width either.
  const configState = useConfigState();
  const settingsFileBroken = configState.errors.length > 0;
  // The mod files of the folder, for the menu of a space.
  const modFiles = useModFiles();
  const settingsOpen = useSettingsOpen();
  const reveal = useSidebarReveal(sidebarMode(layout) === "auto-hide");

  const space = activeSpaceOf(workspace);
  // The spaces the main window lists and takes tabs to: those another window shows are not there.
  const listedSpaces = mainWindowSpaces(workspace);
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

  // Switching tab or space is said to a screen reader (`announcer.ts`); renaming a tab is not a switch.
  const tabName = activeId === undefined ? "" : itemTitle(space, activeId);
  const navPoint = useMemo<NavigationPoint>(
    () => ({ spaceId: space.id, spaceName: space.name, itemId: activeId, tabName }),
    [space.id, space.name, activeId, tabName],
  );
  const lastNavPoint = useRef<NavigationPoint | undefined>(undefined);
  useEffect(() => {
    const said = navigationAnnouncement(lastNavPoint.current, navPoint);
    lastNavPoint.current = navPoint;
    if (said !== undefined) announcer.announce(said);
  }, [navPoint]);

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
      const placeholder = t("tree.tabDefault", { n: itemIds.indexOf(target.id) + 1 });
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

  // The shell profiles for the palette: the machine's, then the ones in `profiles` of config.jsonc.
  const profiles = useProfiles();
  // The backend refused the profiles of the file (an empty program, an id the machine has): the
  // ones it had stay, and this says why.
  const profilesProblem = useProfilesProblem();

  // The notice about a refused shortcut (a split past the pane limit), shown for a few seconds.
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A notice is said by the line itself (it is a status). A `silent` one is drawn out of the reach of
  // a screen reader because the announcer says it, with its own urgency (the result of Pull and Push).
  const [noticeSilent, setNoticeSilent] = useState(false);
  const showNotice = useCallback((text: string, silent = false) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    setNoticeSilent(silent);
    noticeTimer.current = setTimeout(() => setNotice(""), NOTICE_MS);
  }, []);
  /**
   * Brings back the tab closed last, where it was, with its scrollback and a new shell; with none to
   * bring back, a notice says so.
   */
  const reopenTab = useCallback(() => {
    void reopenClosed({
      store,
      backend,
      enabled: () => scrollbackAllowed(configManager.state.config.terminal),
      now: () => Date.now(),
    }).then((found) => {
      if (!found) showNotice(NOTHING_CLOSED_NOTICE);
    });
  }, [store, showNotice]);
  /** Shows the quick terminal window, or hides it: what its global shortcut does anywhere else. */
  const toggleQuick = useCallback(() => {
    backend.quickToggle().catch((error: unknown) => {
      showNotice(`Quick terminal: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [showNotice]);
  /** A layout action writes its setting into the file; a refusal or a failed write is a notice. */
  const runLayout = useCallback(
    (command: LayoutCommand) => {
      void runLayoutCommand(configManager, command).then((problem) => {
        if (problem !== undefined) showNotice(problem);
      });
    },
    [showNotice],
  );
  /** "Toggle screen reader mode": flips the setting of the file; the notice says what it is now. */
  const toggleScreenReader = useCallback(() => {
    void runScreenReaderToggle(configManager).then(showNotice);
  }, [showNotice]);
  // "Import color scheme...": the palette (or a recorded key) clicks this hidden file input, the
  // person picks a file, and the importers read it by what is in it (an extension is not needed,
  // so the input has no `accept`). The answer is a notice; a file that is not a scheme writes nothing.
  const schemeInput = useRef<HTMLInputElement>(null);
  const openSchemePicker = useCallback(() => schemeInput.current?.click(), []);
  const onSchemeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    void importSchemeFile(file, {
      backend,
      existing: getUserThemes(),
      added: addUserThemes,
    }).then(showNotice);
    // So picking the same file again (after fixing it) is a change the input reports.
    input.value = "";
  };
  // "Export space": the active space as a `.noren-space.json` the system saves (a download), with
  // the variables and commands that looked like secrets left out and named in the notice.
  const exportActiveSpace = useCallback(() => {
    const active = activeSpaceOf(store.getState().workspace);
    const made = exportSpace(active, { profiles: configManager.state.config.profiles ?? [] });
    if (!made.ok) {
      showNotice(exportFailureNotice(active.name, made.error));
      return;
    }
    const fileName = exportFileName(active.name);
    downloadText(fileName, made.text);
    showNotice(exportNotice(active.name, fileName, made.removed));
  }, [store, showNotice]);
  // "Pull settings" and "Push settings": the sync through git for the remote already connected in
  // the settings screen. The answer is a notice; with no remote it says where to connect. One step
  // at a time, so a second press while git works is ignored.
  const syncRunning = useRef(false);
  // The spaces and profiles of this window, for the sync to write as files and to make from files.
  const spaceSync = useMemo(() => appSpaceSyncPort(store, backend), [store]);
  const runSync = useCallback(
    (command: "pull" | "push") => {
      if (syncRunning.current) return;
      syncRunning.current = true;
      void runSyncCommand(
        backend,
        command,
        spaceSync,
        syncMethodOf(configManager.state.config.sync),
      )
        .then((message) => {
          showNotice(message.text, true);
          announcer.announce(syncAnnouncement(message));
        })
        .finally(() => {
          syncRunning.current = false;
        });
    },
    [showNotice, spaceSync],
  );
  // "Import space...": like the color scheme, a hidden file input the palette clicks. The file is
  // checked and planned first; its new profiles go to `config.jsonc`, then the space is made. A file
  // that is not a space file says why in a notice and changes nothing.
  const spaceInput = useRef<HTMLInputElement>(null);
  const openSpacePicker = useCallback(() => spaceInput.current?.click(), []);
  const onSpaceFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined) return;
    const settings = configManager.state.config;
    void readSpaceFile(file, settings.profiles ?? [], takenProfileIds(settings, getProfiles()))
      .then((read) =>
        read.ok
          ? commitSpaceImport(read.plan, {
              settings: configManager,
              syncProfiles: () => syncProfiles(backend, configManager.state.config.profiles ?? []),
              importSpace: (spaceFile) => dispatch({ type: "space/import", file: spaceFile }),
            })
          : read.message,
      )
      .then(showNotice);
    // So picking the same file again (after fixing it) is a change the input reports.
    input.value = "";
  };
  useEffect(() => {
    if (profilesProblem !== undefined) {
      showNotice(`The profiles in config.jsonc were not applied. ${profilesProblem}`);
    }
  }, [profilesProblem, showNotice]);
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
  // A shell opened in the quick window comes in as a tab of the active space when asked to
  // (`quick-promote`); its process and its id stay as they are.
  useEffect(() => {
    if (!insideTauri && !quickPreviewEnabled) return undefined;
    const events = insideTauri ? tauriQuickEvents() : quickPreviewEvents;
    const stopped = followQuickPromotions(events, store, backend);
    return () => {
      stopped.then((stop) => stop()).catch(() => undefined);
    };
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
    // A tab in the space another window shows is that window's to show.
    if (windowShowing(store.getState().workspace, spaceId) !== undefined) {
      showNotice(t("window.notice.inWindow"));
      return;
    }
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

  /**
   * Puts the keyboard on the tabs: the row of the sidebar tree that is in the Tab order, or the tab
   * on screen in the bar when the tabs are on top. The terminal keeps Tab for the shell, so this is
   * the way in for the keyboard.
   */
  const focusSidebar = useCallback(() => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-nr-part="sidebar"] [role="treeitem"][tabindex="0"], [data-nr-part="tabbar"] [role="tab"][aria-selected="true"]',
        )
        ?.focus();
    });
  }, []);

  /** Opens the library over everything else; the palette and the search give way to it. */
  const openLibrary = useCallback(() => {
    setPaletteOpen(false);
    setSearchText(null);
    setLibraryOpen(true);
  }, []);
  /** Closes the library and gives the keyboard back to the terminal of the tab on screen. */
  const closeLibrary = useCallback(() => {
    setLibraryOpen(false);
    focusTerminal();
  }, [focusTerminal]);
  /** Opens the Agents panel over everything else; the palette and the search give way to it. */
  const openAgents = useCallback(() => {
    setPaletteOpen(false);
    setSearchText(null);
    setAgentsOpen(true);
  }, []);
  /**
   * Opens the dialog of a worktree over everything else, on the repository of the folder of the
   * focused pane (else the start folder of the space); with no folder known a notice says so.
   */
  const openWorktree = useCallback(
    (kind: "new" | "remove") => {
      setPaletteOpen(false);
      setSearchText(null);
      const state = store.getState();
      const active = activeSpaceOf(state.workspace);
      const itemId = activeItemIdOf(state);
      const item = itemId === undefined ? undefined : active.items[itemId];
      const cwd =
        item !== undefined ? summarizeItem(item, active.defaults.cwd).cwd : active.defaults.cwd;
      if (cwd === undefined || cwd.trim() === "") {
        showNotice(t("worktree.noFolder"));
        focusTerminal();
        return;
      }
      setWorktreeDialog({ kind, cwd });
    },
    [store, showNotice, focusTerminal],
  );
  /**
   * Makes a live group of the worktrees of the repository of the folder of the focused pane (else
   * the start folder of the space) in the active space and asks its source at once, so the entries
   * show without waiting for the next round; with no folder known a notice says so.
   */
  const addWorktreesGroup = useCallback(() => {
    setPaletteOpen(false);
    setSearchText(null);
    const state = store.getState();
    const active = activeSpaceOf(state.workspace);
    const itemId = activeItemIdOf(state);
    const item = itemId === undefined ? undefined : active.items[itemId];
    const folder =
      item !== undefined ? summarizeItem(item, active.defaults.cwd).cwd : active.defaults.cwd;
    if (folder === undefined || folder.trim() === "") {
      showNotice(t("worktree.noFolder"));
      focusTerminal();
      return;
    }
    store.getState().dispatch({
      type: "group/create",
      spaceId: active.id,
      name: worktreesGroupName(folder),
      live: { source: "worktrees", folder },
    });
    void refreshLiveGroups();
    focusTerminal();
  }, [store, showNotice, focusTerminal]);
  /** Makes a live group of the hosts of the `~/.ssh/config` in the active space and asks its source at once. */
  const addSshGroup = useCallback(() => {
    setPaletteOpen(false);
    setSearchText(null);
    store.getState().dispatch({
      type: "group/create",
      spaceId: activeSpaceOf(store.getState().workspace).id,
      name: t("live.ssh.name"),
      live: { source: "ssh" },
    });
    void refreshLiveGroups();
    focusTerminal();
  }, [store, focusTerminal]);
  /** Makes a live group of the running containers in the active space and asks its source at once. */
  const addDockerGroup = useCallback(() => {
    setPaletteOpen(false);
    setSearchText(null);
    store.getState().dispatch({
      type: "group/create",
      spaceId: activeSpaceOf(store.getState().workspace).id,
      name: t("live.docker.name"),
      live: { source: "docker" },
    });
    void refreshLiveGroups();
    focusTerminal();
  }, [store, focusTerminal]);
  /** Closes the dialog of a worktree and gives the keyboard back to the terminal on screen. */
  const closeWorktree = useCallback(() => {
    setWorktreeDialog(null);
    focusTerminal();
  }, [focusTerminal]);
  /** Closes the Agents panel and gives the keyboard back to the terminal of the tab on screen. */
  const closeAgents = useCallback(() => {
    setAgentsOpen(false);
    focusTerminal();
  }, [focusTerminal]);
  /**
   * Goes to an agent: shows its space and tab, focuses its pane and gives it the keyboard. The tab
   * may have been hidden until now, so the terminal is told after the render that shows it.
   */
  const goToAgent = useCallback(
    (row: AgentRow) => {
      setAgentsOpen(false);
      dispatch({ type: "space/set-active-item", spaceId: row.spaceId, itemId: row.itemId });
      dispatch({ type: "space/activate", spaceId: row.spaceId });
      dispatch({ type: "pane/focus", itemId: row.itemId, paneId: row.paneId });
      requestAnimationFrame(() => handles.current.get(row.paneId)?.focus());
    },
    [dispatch],
  );
  /** Goes to the agent that has waited for you longest; with none waiting, a notice says so. */
  const goToWaitingAgent = useCallback(() => {
    const row = firstWaitingAgentOf(store.getState().workspace);
    if (row === undefined) showNotice(t("agents.noneWaiting"));
    else goToAgent(row);
  }, [store, showNotice, goToAgent]);
  /**
   * Brings a tab of the library back where it sat, with its saved output dimmed above a new shell
   * in its folder, and shows it.
   */
  const restoreFromLibrary = useCallback(
    (entry: LibraryEntry) => {
      setLibraryOpen(false);
      void reopenClosed({
        store,
        backend,
        enabled: () => scrollbackAllowed(configManager.state.config.terminal),
        now: () => Date.now(),
        itemId: entry.itemId,
        from: entry.section,
      }).then((found) => {
        if (!found) showNotice(GONE_FROM_LIBRARY_NOTICE);
        focusTerminal();
      });
    },
    [store, showNotice, focusTerminal],
  );
  /** Deletes a tab of the library for good; its saved output goes with it (see the scrollback service). */
  const deleteFromLibrary = useCallback(
    (entry: LibraryEntry) => {
      store.getState().dispatch({
        type: entry.section === "archive" ? "archive/delete" : "closed/delete",
        itemId: entry.itemId,
      });
    },
    [store],
  );
  /** The terminal of the focused pane of the tab on screen. */
  const focusedHandle = useCallback((): TerminalHandle | undefined => {
    const state = store.getState();
    const itemId = activeItemIdOf(state);
    const item = itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
    const pane = item && focusedPane(item);
    return pane ? handles.current.get(pane.id) : undefined;
  }, [store]);

  const aiOn = aiIsOn(configState.config, space);
  // Where the AI is off the panel is gone, and so is the question that was half typed in it.
  useEffect(() => {
    if (!aiOn) {
      setAskOpen(false);
      setAskExplain(undefined);
      setCommandAsk(undefined);
    }
  }, [aiOn]);
  const askShown = askOpen && aiOn;
  /** Shows the Ask panel or hides it; where the AI is off it only says why it cannot open. */
  const toggleAsk = () => {
    if (!aiOn) {
      showNotice(askOffNotice(configState.config, space));
      return;
    }
    setAskOpen(!askOpen);
    if (askOpen) focusTerminal();
  };
  const toggleAskRef = useRef(toggleAsk);
  toggleAskRef.current = toggleAsk;
  const closeAsk = () => {
    setAskOpen(false);
    setAskExplain(undefined);
    focusTerminal();
  };
  /** The Explain button of a failed command: the Ask panel opens on that command and its output. */
  const explainCommand = useCallback((request: ExplainRequest) => {
    setAskExplain((last) => ({ request, seq: (last?.seq ?? 0) + 1 }));
    setAskOpen(true);
  }, []);
  /**
   * A web link of the output of `paneId` was Ctrl+clicked: a browser pane opens beside it, and the
   * keyboard stays with the pane the person was typing in. False for an address a browser pane may
   * not show or a pane that is nowhere, so the click asks the question every link asks; a tab with
   * no room says so and opens nothing.
   */
  const openBrowserBeside = useCallback(
    (paneId: Id, url: string): boolean => {
      if (browserUrlProblem(url) !== undefined) return false;
      const state = store.getState();
      for (const s of state.workspace.spaces) {
        for (const item of Object.values(s.items)) {
          const panes = layoutPanes(item.layout);
          if (!panes.some((pane) => pane.id === paneId)) continue;
          if (panes.length >= DEFAULT_MAX_PANES) {
            showNotice(paneLimitNotice(DEFAULT_MAX_PANES));
            return true;
          }
          state.dispatch({
            type: "pane/split",
            itemId: item.id,
            paneId,
            dir: "row",
            side: "after",
            url,
          });
          state.dispatch({ type: "pane/focus", itemId: item.id, paneId });
          return true;
        }
      }
      return false;
    },
    [store, showNotice],
  );
  /**
   * A file path of the output of `paneId` was Ctrl+clicked: a preview pane opens beside it, and the
   * keyboard stays with the pane the person was typing in. A relative path is read against the folder
   * the pane is in now. A path the preview does not open (a folder on the network, say) or a tab with
   * no room says so in a notice and makes no pane; nothing is read from the disk here, the pane reads
   * its own file when it is drawn.
   */
  const openPreviewBeside = useCallback(
    (paneId: Id, written: string): void => {
      const state = store.getState();
      for (const s of state.workspace.spaces) {
        for (const item of Object.values(s.items)) {
          const panes = layoutPanes(item.layout);
          const source = panes.find((pane) => pane.id === paneId);
          if (source === undefined) continue;
          const resolved = resolveOutputPath(written, source.cwd);
          if (!resolved.ok) {
            showNotice(openPathNotice(resolved.problem));
            return;
          }
          if (panes.length >= DEFAULT_MAX_PANES) {
            showNotice(previewLimitNotice(DEFAULT_MAX_PANES));
            return;
          }
          state.dispatch({
            type: "pane/split",
            itemId: item.id,
            paneId,
            dir: "row",
            side: "after",
            path: resolved.path,
          });
          state.dispatch({ type: "pane/focus", itemId: item.id, paneId });
          return;
        }
      }
    },
    [store, showNotice],
  );
  /**
   * "Show git diff beside this pane": a diff pane opens beside the focused pane of the tab on screen,
   * on the folder that pane is in now (the start folder of the space when it has none), and the
   * keyboard stays with the pane it was in. No folder, a folder git is not run in, or a tab with no
   * room say so in a notice and make no pane; nothing is read here, the pane asks git itself.
   */
  const openDiffBeside = useCallback((): void => {
    const state = store.getState();
    const active = activeSpaceOf(state.workspace);
    const itemId = activeItemIdOf(state);
    const item = itemId === undefined ? undefined : active.items[itemId];
    const source = item && focusedPane(item);
    if (item === undefined || source === undefined) return;
    const cwd = source.cwd ?? active.defaults.cwd;
    if (cwd === undefined || cwd.trim() === "") {
      showNotice(noFolderNotice());
      return;
    }
    if (previewPathProblem(cwd) !== undefined) {
      showNotice(badFolderNotice());
      return;
    }
    if (layoutPanes(item.layout).length >= DEFAULT_MAX_PANES) {
      showNotice(diffLimitNotice(DEFAULT_MAX_PANES));
      return;
    }
    state.dispatch({
      type: "pane/split",
      itemId: item.id,
      paneId: source.id,
      dir: "row",
      side: "after",
      diff: true,
      cwd,
    });
    state.dispatch({ type: "pane/focus", itemId: item.id, paneId: source.id });
  }, [store, showNotice]);
  /**
   * A tab goes to a window of its own: dragged out of the window, or "Move tab to new window" in the
   * palette (the tab on screen). The window gets a space of its own, named after the tab, and the
   * shells of the tab go on in it, and its browser, preview and diff panes are drawn by the page of
   * the window. A tab with a pane no window can draw (none today), too many windows, a
   * page that cannot show other windows and a window the backend refuses say so in a notice and
   * leave the tab where it is.
   */
  const moveTabToNewWindow = useCallback(
    (itemId: Id): void => {
      if (!windowsAvailable()) {
        showNotice(t("window.notice.unavailable"));
        return;
      }
      const problem = windowMoveProblem(store.getState().workspace, itemId);
      if (problem === "panes") {
        showNotice(t("window.notice.panes"));
        return;
      }
      if (problem === "limit") {
        showNotice(t("window.notice.limit"));
        return;
      }
      if (problem !== undefined) return;
      const owner = store.getState().workspace.spaces.find((s) => Object.hasOwn(s.items, itemId));
      void moveItemToNewWindow(
        store,
        backend,
        itemId,
        owner === undefined ? undefined : itemTitle(owner, itemId),
      ).then((result) => {
        if (!result.ok) showNotice(t("window.notice.failed", { reason: result.reason }));
      });
    },
    [store, showNotice],
  );
  /** "Move tab to new window": the tab on screen. */
  const moveActiveTabToWindow = useCallback((): void => {
    const itemId = activeItemIdOf(store.getState());
    if (itemId !== undefined) moveTabToNewWindow(itemId);
  }, [store, moveTabToNewWindow]);
  /** "? text" in the palette: the dialog opens for the shell and the system of the pane in use. */
  const askForCommand = (request: string) => {
    const state = store.getState();
    const itemId = activeItemIdOf(state);
    const item = itemId === undefined ? undefined : activeSpaceOf(state.workspace).items[itemId];
    const pane = item && focusedPane(item);
    setPaletteOpen(false);
    setCommandAsk({
      request,
      shell: shellNameOf(pane?.profileId, profiles),
      os: osNameOf(navigator.userAgent),
    });
  };
  const closeCommandAsk = () => {
    setCommandAsk(undefined);
    focusTerminal();
  };
  /** What the context chips of the Ask panel read: the terminal of the pane in use, and other tabs. */
  const askSources: AskSources = {
    selection: () => focusedHandle()?.selection() ?? "",
    lastOutput: () => {
      const handle = focusedHandle();
      const output = handle?.lastOutput();
      if (handle === undefined || output === undefined) return undefined;
      // The row of the prompt that ended last holds the command line (after the prompt text).
      const command = handle
        .marks()
        .filter((mark) => mark.state === "done")
        .at(-1)
        ?.text.trim();
      return { text: output.text, ...(command !== undefined && command !== "" ? { command } : {}) };
    },
    screen: () => focusedHandle()?.screen() ?? "",
    tab: (itemId) => {
      const item = space.items[itemId];
      const pane = item && focusedPane(item);
      const handle = pane && handles.current.get(pane.id);
      if (handle === undefined) return undefined;
      return {
        title: itemTitle(space, itemId),
        text: handle.readLines().join("\n").replace(/\s+$/, ""),
      };
    },
  };
  const askTabs = itemIds
    .filter((id) => id !== activeId)
    .map((id) => ({ id, title: itemTitle(space, id) }));

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
      if (action.command.kind === "reopen-closed") {
        if (!modalOpen.current) reopenTab();
        return;
      }
      if (action.command.kind === "library") {
        if (!modalOpen.current) openLibrary();
        return;
      }
      if (action.command.kind === "agents") {
        if (!modalOpen.current) openAgents();
        return;
      }
      if (action.command.kind === "agent-waiting") {
        if (!modalOpen.current) goToWaitingAgent();
        return;
      }
      if (action.command.kind === "worktree-new" || action.command.kind === "worktree-remove") {
        if (!modalOpen.current) {
          openWorktree(action.command.kind === "worktree-new" ? "new" : "remove");
        }
        return;
      }
      if (action.command.kind === "live-worktrees") {
        if (!modalOpen.current) addWorktreesGroup();
        return;
      }
      if (action.command.kind === "live-ssh") {
        if (!modalOpen.current) addSshGroup();
        return;
      }
      if (action.command.kind === "live-docker") {
        if (!modalOpen.current) addDockerGroup();
        return;
      }
      if (action.command.kind === "diff-open") {
        if (!modalOpen.current) openDiffBeside();
        return;
      }
      if (action.command.kind === "window-move-tab") {
        if (!modalOpen.current) moveActiveTabToWindow();
        return;
      }
      if (action.command.kind === "quick-toggle") {
        // The window of the quick terminal is not this one: a dialog here does not stand in its way.
        toggleQuick();
        return;
      }
      if (action.command.kind === "import-scheme") {
        if (!modalOpen.current) openSchemePicker();
        return;
      }
      if (action.command.kind === "export-space") {
        if (!modalOpen.current) exportActiveSpace();
        return;
      }
      if (action.command.kind === "import-space") {
        if (!modalOpen.current) openSpacePicker();
        return;
      }
      if (action.command.kind === "sync-pull" || action.command.kind === "sync-push") {
        if (!modalOpen.current) runSync(action.command.kind === "sync-pull" ? "pull" : "push");
        return;
      }
      if (action.command.kind === "focus-sidebar") {
        if (!modalOpen.current) focusSidebar();
        return;
      }
      if (action.command.kind === "ask-toggle") {
        if (!modalOpen.current) toggleAskRef.current();
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
      if (action.command.kind === "screen-reader") {
        if (!modalOpen.current) toggleScreenReader();
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
  }, [
    store,
    showNotice,
    openSearch,
    openSchemePicker,
    focusSidebar,
    focusedHandle,
    terminalAction,
    runLayout,
    toggleScreenReader,
    reopenTab,
    openLibrary,
    openAgents,
    openWorktree,
    openDiffBeside,
    moveActiveTabToWindow,
    goToWaitingAgent,
    toggleQuick,
  ]);

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
      // The spaces the switcher lists: those another window shows are not there.
      const listed = mainWindowSpaces(state.workspace);
      const from = listed.findIndex((s) => s.id === state.workspace.activeSpaceId);
      if (from < 0 || listed[from + step] === undefined) return;
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
        terminalDrawing: () => current()?.drawing(),
        paneDrawing: (paneId) => handles.current.get(paneId)?.drawing(),
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
        setPaneAgent: async (paneId, agentId) => {
          for (const space of store.getState().workspace.spaces) {
            for (const item of Object.values(space.items)) {
              const sessionId = layoutPanes(item.layout).find((p) => p.id === paneId)?.sessionId;
              if (sessionId === undefined) continue;
              fake.setSessionAgent(Number(sessionId), agentId);
              await currentAgentScanner()?.scan();
              return true;
            }
          }
          return false;
        },
        setWorktreeDirty: (path, dirty) => fake.setWorktreeDirty(path, dirty),
        setDockerContainers: (containers, error) => fake.setDockerContainers(containers, error),
        pluginTraffic: () => [...pluginTrafficLog],
        pluginStatus: () => currentPluginHost()?.status() ?? [],
        notifications: () => fake.notifications.map(({ title, body }) => ({ title, body })),
        setWindowFocused: (focused) => fake.setWindowFocused(focused),
        openedLinks: () => [...fake.openedLinks],
        browserViews: () =>
          fake.browserPaneIds().flatMap((paneId) => {
            const view = fake.browserPane(paneId);
            return view === undefined
              ? []
              : [
                  {
                    paneId,
                    url: view.url,
                    bounds: view.bounds,
                    ...(view.windowId !== undefined ? { windowId: view.windowId } : {}),
                  },
                ];
          }),
        browserCalls: () =>
          fake.calls
            .filter((call) => call.method.endsWith("BrowserPane"))
            .map((call) => ({ method: call.method, paneId: String(call.args[0]) })),
        previewReads: () => fake.callsTo("readFilePreview").map((call) => String(call.args[0])),
        gitDiffReads: () => fake.callsTo("readGitDiff").map((call) => String(call.args[0])),
        setGitDiff: (folder, entry) => fake.setGitDiff(folder, entry),
        commandRuns: () => fake.commands.map(({ cwd, command }) => ({ cwd, command })),
        failCommands: (code) => fake.setCommandExitCode(code),
        actionsReads: () => fake.callsTo("readActionsFile").length,
        hardwareReads: () => fake.callsTo("readHardware").length,
        advanceClock: (ms) => {
          if (fake.clock instanceof ManualClock) fake.clock.advance(ms);
        },
        openUrl: (url) => handleDeepLink(url),
        setConfig: (text) => fake.setConfig(text),
        setMod: (name, text) => fake.setMod(name, text),
        syncCalls: () =>
          fake.calls
            .filter((call) => call.method.startsWith("sync"))
            .map((call) => ({
              method: call.method,
              ...(call.method === "syncConnect" ? { remote: String(call.args[0]) } : {}),
            })),
        setSyncRemoteFile: (path, text) => fake.setSyncRemoteFile(path, text ?? undefined),
        setSyncLocalFile: (path, text) => fake.setSyncLocalFile(path, text ?? undefined),
        syncLocalFile: (path) => fake.syncLocalFile(path) ?? null,
        syncRemoteFiles: () => fake.syncRemoteFiles(),
        failSync: (message) =>
          fake.setSyncFailure(message === null ? undefined : new Error(message)),
        putSyncGist: (id, gist) => fake.putSyncGist(id, gist),
        setSyncGistFile: (id, name, text) => fake.setSyncGistFile(id, name, text ?? undefined),
        syncGistFiles: (id) => fake.syncGistFiles(id),
        syncGistIds: () => fake.syncGistIds(),
        failSyncGist: (message) =>
          fake.setSyncGistFailure(message === null ? undefined : new Error(message)),
        aiConfigures: () =>
          fake
            .callsTo("ai.configure")
            .map((call) => (call.args[0] as { id: string }[]).map((provider) => provider.id)),
        aiKeyCalls: () => fake.callsTo("ai.setKey").map((call) => String(call.args[0])),
        storedAiKey: (providerId) => fake.storedAiKey(providerId),
        writes: () =>
          fake.callsTo("write").map((call) => {
            const data = call.args[1];
            return {
              id: Number(call.args[0]),
              data: typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array),
            };
          }),
        aiChats: () =>
          fake.callsTo("ai.chat").map((call) => {
            const request = call.args[0] as {
              providerId: string;
              model?: string;
              messages: { role: string; content: string }[];
            };
            return {
              providerId: request.providerId,
              model: request.model,
              messages: request.messages,
            };
          }),
        aiCancels: () => fake.callsTo("ai.cancel").map((call) => String(call.args[0])),
        setAiReply: (text) => fake.setAiReply(text ?? undefined),
        holdAiAnswer: (held) => fake.holdAiAnswer(held),
        failConfigSaves: (message) =>
          fake.setConfigSaveFailure(message === null ? undefined : new Error(message)),
        configSaves: () => fake.callsTo("saveConfig").length,
        windowEffectCalls: () =>
          fake.callsTo("setWindowEffect").map((call) => ({
            effect: String(call.args[0]),
            scheme: String(call.args[1]),
          })),
        scrollbackFiles: () => ({ ...fake.scrollbackFiles }),
        scrollbackCalls: () =>
          fake.calls
            .filter(
              (call) =>
                call.method === "loadScrollback" ||
                call.method === "saveScrollback" ||
                call.method === "deleteScrollback",
            )
            .map((call) => ({
              method: call.method as "loadScrollback" | "saveScrollback" | "deleteScrollback",
              paneId: String(call.args[0]),
            })),
        scrollbackListCalls: () => fake.callsTo("listScrollback").length,
        setScrollbackFile: (paneId, text) => fake.setScrollback(paneId, text),
        paneSnapshot: (paneId) => handles.current.get(paneId)?.snapshot() ?? "",
        paneDimLines: (paneId) => handles.current.get(paneId)?.dimLines() ?? [],
        focusedSessionId: () => {
          const item = activeItem();
          const pane = item && focusedPane(item);
          return pane?.sessionId === undefined ? undefined : Number(pane.sessionId);
        },
        quickVisible: () => fake.quickVisible,
        quickToggles: () => fake.callsTo("quickToggle").length,
        quickShortcut: () => fake.quickShortcut,
        quickShortcutAsks: () =>
          fake.callsTo("setQuickShortcut").map((call) => call.args[0] as string | null),
        failQuickShortcut: (reason) =>
          fake.setQuickShortcutFailure(reason === null ? undefined : new Error(reason)),
        killedSessions: () => fake.callsTo("kill").map((call) => Number(call.args[0])),
        startDetachedSession: () => fake.createSession({ cols: 80, rows: 24 }),
        promoteSession: (id) => promoteQuickSession(store, fake, id),
        sessionSize: (id) => {
          const info = fake.session(id);
          return info && { cols: info.cols, rows: info.rows };
        },
        sessionResizes: (id) =>
          fake
            .callsTo("resize")
            .filter((call) => call.args[0] === id)
            .map((call) => ({ cols: Number(call.args[1]), rows: Number(call.args[2]) })),
        sshSessions: () => {
          const started = fake.callsTo("createSession").length;
          const sessions = [];
          for (let id = 1; id <= started; id++) {
            const info = fake.session(id);
            if (info?.ssh === undefined) continue;
            sessions.push({
              id,
              profileId: info.profileId,
              ssh: info.ssh,
              link: info.link?.state ?? "connected",
            });
          }
          return sessions;
        },
        setProfileLink: (profileId, link) => fake.setProfileLink(profileId, link),
        setSessionLink: (id, link) => fake.setSessionLink(id, link),
        retriedSessions: () => fake.callsTo("retrySession").map((call) => Number(call.args[0])),
        userProfileSessions: () => {
          const started = fake.callsTo("createSession").length;
          const sessions = [];
          // The fake backend numbers its sessions from 1, in order of start.
          for (let id = 1; id <= started; id++) {
            const info = fake.session(id);
            if (info?.program === undefined) continue;
            sessions.push({
              profileId: info.profileId,
              program: info.program,
              args: info.args ?? [],
              cwd: info.cwd,
            });
          }
          return sessions;
        },
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
      perfMark("app-ready");
      emit("app-ready").catch(() => undefined);
    }
  }, [store]);

  const recordHandle = (paneId: Id, handle: TerminalHandle) => {
    handles.current.set(paneId, handle);
    // The scrollback snapshot asks this terminal for its lines every minute and when the window closes.
    registerTerminalSnapshot(paneId, (lines) => handle.snapshot(lines));
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
  // The screens say their words with `t`: a change of language draws the shell again.
  const language = useLanguage();
  // The quick terminal's global shortcut follows the chord in force: registered at start and again
  // whenever the shortcuts screen or the preset changes it. A refusal (another program has the key)
  // is a notice.
  const quickChord = resolveBindings(keybindings).chords[QUICK_TOGGLE_ACTION];
  useEffect(() => {
    void quickShortcut.sync(quickChord).then((status) => {
      if (status.kind === "refused") {
        showNotice(
          `The quick terminal shortcut ${formatChord(status.chord)} is not available: ${status.reason}`,
        );
      }
    });
  }, [quickChord, showNotice]);
  // The actions the plugins put in the palette; the list is read again whenever a plugin changes it.
  const pluginActions = usePluginActions();
  const paletteEntries = useMemo(
    () =>
      !paletteOpen
        ? []
        : paletteMode === "space-theme"
          ? buildSpaceThemeEntries(space.name, spaceThemeOptions(space.themeId, themes))
          : buildEntries({
              workspace,
              chords: resolveBindings(keybindings).chords,
              home,
              profiles,
              folders: recentFolders(),
              themes: { list: themes, choice: themeChoice },
              aiOn,
              pluginActions,
            }),
    [
      paletteOpen,
      paletteMode,
      space,
      workspace,
      keybindings,
      home,
      profiles,
      themeChoice,
      themes,
      aiOn,
      pluginActions,
      language,
    ],
  );

  /** An entry of the palette: the same calls a click or a shortcut makes. */
  const runPaletteEntry = (entry: PaletteEntry) => {
    if (entry.kind === "tab") showTab(entry.spaceId, entry.itemId);
    else if (entry.kind === "space") activateSpace(entry.spaceId);
    else if (entry.kind === "profile") newTab({ profileId: entry.profileId });
    else if (entry.kind === "folder") newTab({ cwd: entry.path });
    else if (entry.kind === "plugin") currentPluginHost()?.choose(entry.pluginId, entry.actionId);
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
    } else if (entry.action.command.kind === "reopen-closed") {
      // The tab comes back and takes the keyboard like any tab that is shown.
      reopenTab();
    } else if (entry.action.command.kind === "library") {
      // The library takes the keyboard itself; the palette must not hand it to the terminal.
      openLibrary();
      return;
    } else if (entry.action.command.kind === "agents") {
      // The panel takes the keyboard itself; the palette must not hand it to the terminal.
      openAgents();
      return;
    } else if (entry.action.command.kind === "agent-waiting") {
      // The agent's pane takes the keyboard; with none waiting the terminal gets it back.
      goToWaitingAgent();
      setPaletteOpen(false);
      return;
    } else if (
      entry.action.command.kind === "worktree-new" ||
      entry.action.command.kind === "worktree-remove"
    ) {
      // The dialog takes the keyboard itself; the palette must not hand it to the terminal.
      openWorktree(entry.action.command.kind === "worktree-new" ? "new" : "remove");
      return;
    } else if (entry.action.command.kind === "live-worktrees") {
      addWorktreesGroup();
      return;
    } else if (entry.action.command.kind === "live-ssh") {
      addSshGroup();
      return;
    } else if (entry.action.command.kind === "live-docker") {
      addDockerGroup();
      return;
    } else if (entry.action.command.kind === "quick-toggle") {
      // The quick window takes the keyboard itself; the palette closes first so it does not hand
      // the focus back to the terminal of this window.
      setPaletteOpen(false);
      toggleQuick();
      return;
    } else if (entry.action.command.kind === "focus-sidebar") {
      // The tabs take the keyboard; the palette must not hand it to the terminal.
      setPaletteOpen(false);
      focusSidebar();
      return;
    } else if (entry.action.command.kind === "import-scheme") {
      // The file picker takes over; the terminal gets the keyboard back with the palette's close.
      closePalette();
      openSchemePicker();
      return;
    } else if (entry.action.command.kind === "import-space") {
      closePalette();
      openSpacePicker();
      return;
    } else if (entry.action.command.kind === "export-space") {
      closePalette();
      exportActiveSpace();
      return;
    } else if (
      entry.action.command.kind === "sync-pull" ||
      entry.action.command.kind === "sync-push"
    ) {
      closePalette();
      runSync(entry.action.command.kind === "sync-pull" ? "pull" : "push");
      return;
    } else if (entry.action.command.kind === "ask-toggle") {
      // The panel takes the keyboard itself; the palette must not hand it to the terminal.
      setPaletteOpen(false);
      toggleAsk();
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
    } else if (entry.action.command.kind === "screen-reader") {
      toggleScreenReader();
    } else if (entry.action.command.kind === "diff-open") {
      // The diff opens beside the pane in use, which keeps the keyboard.
      openDiffBeside();
    } else if (entry.action.command.kind === "window-move-tab") {
      // The tab on screen goes to a window of its own; the terminal there is another page's now.
      moveActiveTabToWindow();
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
    // Delete in the tree does what "Close" and "Ungroup" in the context menus do.
    onCloseItems: (itemIds: readonly Id[]) => {
      store.getState().closeItems(itemIds);
      clearSelection();
    },
    onUngroup: (groupId: Id) => dispatch({ type: "group/ungroup", groupId }),
    onStartEdit: setEditing,
    onCommitEdit,
    onCancelEdit,
    // Try again on a tab whose connection to its shell on another machine gave up.
    onRetryLink: (itemId: Id) => {
      const item = space.items[itemId];
      if (item !== undefined) void retryFailedLinks(backend, item);
    },
  };

  const close = () => setOverlay(null);
  const overlaySpace =
    overlay?.kind === "menu" ||
    overlay?.kind === "edit" ||
    overlay?.kind === "background" ||
    overlay?.kind === "delete"
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
        themes={spaceThemeOptions(overlaySpace.themeId, themes)}
        mods={spaceModOptions(modFiles, configState.config.mods ?? [], overlaySpace.modIds)}
        point={overlay.point}
        onTheme={(themeId) => {
          dispatch({ type: "space/set-theme", spaceId: overlaySpace.id, themeId });
          close();
        }}
        onMod={(name, on) => {
          dispatch({
            type: "space/set-mods",
            spaceId: overlaySpace.id,
            modIds: withMod(overlaySpace.modIds, name, on),
          });
        }}
        hasBackground={overlaySpace.background !== undefined}
        onBackground={() => setOverlay({ kind: "background", spaceId: overlaySpace.id })}
        onClearBackground={() => {
          dispatch({ type: "space/set-background", spaceId: overlaySpace.id, background: null });
          close();
        }}
        aiOn={configState.config.ai?.enabled === true}
        onAi={(enabled) => {
          dispatch({ type: "space/set-ai", spaceId: overlaySpace.id, enabled });
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
  } else if (overlaySpace !== undefined && overlay?.kind === "background") {
    overlayNode = (
      <SpaceBackgroundDialog
        space={overlaySpace}
        onCancel={close}
        onSubmit={(background) => {
          dispatch({ type: "space/set-background", spaceId: overlaySpace.id, background });
          close();
        }}
        onClear={() => {
          dispatch({ type: "space/set-background", spaceId: overlaySpace.id, background: null });
          close();
        }}
      />
    );
  } else if (overlaySpace !== undefined && overlay?.kind === "delete") {
    const tabsInSpace = spaceItemIds(overlaySpace).length;
    overlayNode = (
      <ConfirmDialog
        title={t("deleteSpace.title")}
        message={t("deleteSpace.message", {
          name: overlaySpace.name,
          tabs: tabCount(tabsInSpace),
        })}
        confirmLabel={t("deleteSpace.confirm")}
        onCancel={close}
        onConfirm={() => {
          deleteSpace(overlaySpace.id);
          close();
        }}
      />
    );
  }

  const { pending } = projectActions;
  modalOpen.current =
    overlay !== null ||
    pending !== null ||
    settingsOpen ||
    libraryOpen ||
    agentsOpen ||
    worktreeDialog !== null ||
    commandAsk !== undefined;
  const confirmNode = pending !== null && (
    <ConfirmDialog
      title={t("runAction.title")}
      message={t(
        pending.action.stop !== undefined ? "runAction.messageWithStop" : "runAction.message",
        {
          label: pending.action.label,
          tab: pending.action.tab,
        },
      )}
      detail={consentText(pending.action)}
      confirmLabel={t("runAction.confirm")}
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
    <ExplainContext.Provider value={explainCommand}>
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
          spaces={listedSpaces}
          favorites={workspace.favorites}
          space={space}
          rows={rows}
          onAction={dispatch}
          paneItemId={activeId}
          onPaneDrop={onPaneDrop}
          onPaneSwap={onPaneSwap}
          {...(windowsAvailable() ? { onDragOut: moveTabToNewWindow } : {})}
        >
          <aside
            ref={sidebarRef}
            className="sidebar"
            data-nr-part="sidebar"
            data-nr-state={autoHide ? (shown ? "revealed" : "hidden") : undefined}
            aria-label={t("window.sidebar")}
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
              <SidebarTree
                {...treeProps}
                rows={rows}
                home={home}
                onPaneClick={onPaneClick}
                onLiveEntryClick={(groupId, key) => {
                  clearSelection();
                  store.getState().openLiveEntry(groupId, key);
                }}
                onPeek={(itemId) => {
                  const item = space.items[itemId];
                  return item !== undefined ? peekLinesOfItem(backend, item) : [];
                }}
              />
            )}
            <div className="sidebar-foot">
              <button type="button" className="new-tab" onClick={() => newTab()}>
                {t("window.newTab")}
              </button>
              <DropZones pinned={space.pinned.length === 0} favorites={favorites.length === 0} />
            </div>
            <SpaceSwitcher
              spaces={listedSpaces}
              activeSpaceId={space.id}
              onActivate={activateSpace}
              onNewSpace={() => setOverlay({ kind: "new" })}
              onMenu={(spaceId, point) => setOverlay({ kind: "menu", spaceId, point })}
            />
          </aside>
          <div className="main">
            {tabsOnTop && <TabBar {...treeProps} onNewTab={() => newTab()} />}
            <section className="content" aria-label={t("window.content")}>
              {/* A space another window shows is drawn by that window's page, not here: a terminal
                  mounted in two pages would take the output of its session back. */}
              {workspace.spaces
                .filter((s) => windowShowing(workspace, s.id) === undefined)
                .map((s) => {
                  const firstId = itemShownIn(s);
                  return (
                    <div key={s.id} className="space-layer" hidden={s.id !== space.id}>
                      {Object.values(s.items).map((item) => (
                        <ItemView
                          key={item.id}
                          store={store}
                          space={s}
                          item={item}
                          shown={s.id === space.id && item.id === activeId}
                          first={item.id === firstId}
                          colors={colors}
                          home={home}
                          onReady={recordHandle}
                          onPaneMenu={(paneId, point) =>
                            setOverlay({ kind: "pane-menu", paneId, point })
                          }
                          onOpenBrowser={openBrowserBeside}
                          onOpenPreview={openPreviewBeside}
                        />
                      ))}
                    </div>
                  );
                })}
              <AnnouncerRegion />
              <div
                className="pane-notice"
                role="status"
                data-nr-part="pane-notice"
                data-nr-state={notice !== "" ? "shown" : "empty"}
              >
                {noticeSilent ? <span aria-hidden="true">{notice}</span> : notice}
              </div>
            </section>
          </div>
          {askShown && (
            <AskPanel
              backend={backend}
              config={configState.config}
              space={space}
              tabs={askTabs}
              sources={askSources}
              explain={askExplain}
              onInsert={(text) => focusedHandle()?.insert(text) ?? false}
              onClose={closeAsk}
            />
          )}
          <PluginPanel />
        </TreeDnd>
        {overlayNode}
        {confirmNode}
        <LinkPrompt backend={backend} />
        <input
          ref={schemeInput}
          type="file"
          hidden
          tabIndex={-1}
          aria-label={t("window.schemeFile")}
          data-nr-part="scheme-file"
          onChange={onSchemeFile}
        />
        <input
          ref={spaceInput}
          type="file"
          hidden
          tabIndex={-1}
          aria-label={t("window.spaceFile")}
          data-nr-part="space-file"
          onChange={onSpaceFile}
        />

        {mru.rows !== undefined && <MruSwitcherView rows={mru.rows} />}
        {searchText !== null && (
          <TabSearch tabs={searchText} onPick={pickSearchHit} onClose={closeSearch} />
        )}
        {libraryOpen && (
          <Library
            workspace={workspace}
            backend={backend}
            home={home}
            onRestore={restoreFromLibrary}
            onDelete={deleteFromLibrary}
            onClose={closeLibrary}
          />
        )}
        {agentsOpen && (
          <AgentsPanel workspace={workspace} onPick={goToAgent} onClose={closeAgents} />
        )}
        {paletteOpen && (
          <CommandPalette
            key={paletteMode}
            entries={paletteEntries}
            {...(paletteMode === "space-theme"
              ? { placeholder: t("palette.placeholderSpaceTheme", { name: space.name }) }
              : {})}
            onRun={runPaletteEntry}
            onClose={closePalette}
            onHighlight={onPaletteHighlight}
            {...(aiOn && paletteMode === "all" ? { onAskCommand: askForCommand } : {})}
          />
        )}
        {commandAsk !== undefined && aiOn && (
          <CommandAskDialog
            backend={backend}
            config={configState.config}
            space={space}
            request={commandAsk.request}
            shell={commandAsk.shell}
            os={commandAsk.os}
            onInsert={(text) => focusedHandle()?.insert(text) ?? false}
            onClose={closeCommandAsk}
          />
        )}
        {worktreeDialog?.kind === "new" && (
          <NewWorktreeDialog
            backend={backend}
            cwd={worktreeDialog.cwd}
            onCreated={(worktree) => {
              // The tab opens in the new folder and takes the keyboard like any new tab.
              setWorktreeDialog(null);
              newTab({ cwd: worktree.path });
              // A live group of worktrees lists the new one now, not at the next round.
              void refreshLiveGroups();
            }}
            onClose={closeWorktree}
          />
        )}
        {worktreeDialog?.kind === "remove" && (
          <RemoveWorktreeDialog
            backend={backend}
            cwd={worktreeDialog.cwd}
            onRemoved={(worktree) => {
              setWorktreeDialog(null);
              showNotice(t("worktree.removed", { path: worktree.path }));
              void refreshLiveGroups();
              focusTerminal();
            }}
            onClose={closeWorktree}
          />
        )}
        {settingsOpen && (
          <SettingsDialog
            backend={backend}
            spaceSync={spaceSync}
            onInsert={(text) => focusedHandle()?.insert(text) ?? false}
            onClose={() => {
              closeSettings();
              focusTerminal();
            }}
          />
        )}
      </div>
    </ExplainContext.Provider>
  );
}

/**
 * The result of the boot, once it is there (`undefined` before). It is read with state and not with
 * `use` inside a Suspense boundary: React holds back the reveal of a boundary that showed its
 * fallback for up to 300 ms (its flash throttle), and the whole first terminal waited for it.
 */
function useBooted(): BootResult | undefined {
  const [result, setResult] = useState<BootResult>();
  useEffect(() => {
    let live = true;
    void booted.then((value) => {
      if (live) setResult(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return result;
}

function Booted() {
  const result = useBooted();
  if (result === undefined) return null;
  perfMarkOnce("app-render");
  if (!result.ok) return <p role="alert">{result.error}</p>;
  return <Shell store={result.store} />;
}

export function App() {
  const theme = useTheme();
  const appearance = useWindowAppearance();
  const picture = usePicture();
  const pictureAddress = pictureUrl(picture);
  const effect = requestedWindowEffect(useConfigState().config);
  const scheme = useWindowScheme();
  // The effect the settings name is asked of the system, painted dark or light like the theme. A
  // system that cannot paint it keeps the window opaque (`appearance.effect` is what the window has).
  useEffect(() => {
    requestWindowEffect(backend, effect, scheme);
  }, [effect, scheme]);
  // Before paint, so the first frame already has the colors.
  useLayoutEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);
  // The picture is read when the window wants a new one; until it is on screen the variable is none.
  useLayoutEffect(() => {
    showBackgroundImage(appearance.background.image);
  }, [appearance.background.image]);
  useLayoutEffect(() => {
    applyWindowVariables(
      document.documentElement,
      windowVariables(appearance, theme, pictureAddress),
    );
  }, [appearance, theme, pictureAddress]);

  return (
    <main
      className="app"
      data-nr-window-effect={appearance.effect}
      data-nr-picture={pictureAddress !== null ? "shown" : undefined}
    >
      <WindowBackground picture={picture} />
      <TitleBar />
      {import.meta.env.VITE_NOREN_DEMO === "1" && <DemoBanner />}
      <ConfigErrorNotice />
      <BackgroundNotice picture={picture} />
      <ModStyles />
      <Booted />
    </main>
  );
}

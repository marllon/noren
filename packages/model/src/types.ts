/** Opaque identifier. Unique within a workspace across spaces, items, groups and panes. */
export type Id = string;

/** State saved in `state.json`. */
export interface Workspace {
  version: 2;
  spaces: Space[];
  activeSpaceId: Id;
  /** Item ids, global (an item of any space). */
  favorites: Id[];
  /**
   * The profiles and project actions in the Favorites bar, after the favorite tabs, in the order they
   * were added (`FavoriteLink`). Absent in a state saved before the bar took them, which is the same
   * as none: kept next to `favorites` and not inside it so that a file of version 2 reads as it is.
   */
  favoriteLinks?: FavoriteLink[];
  /** Recently closed items, newest last, at most `MAX_CLOSED`. */
  closed: ClosedItem[];
  archive: ArchivedItem[];
  /**
   * The windows of the app besides the main one, each showing a space of its own (`AppWindow`). The
   * main window shows `activeSpaceId`. Absent when the app has the one window, and in a state saved
   * before windows existed.
   */
  windows?: AppWindow[];
}

/**
 * What names a shortcut of the Favorites bar that is not a tab: a shell profile (a click opens a new
 * tab with it) or an action of the `.noren/actions.json` of a space (a click runs it, through the
 * same first-run confirmation as its Start button). An action is the one the space's file declares
 * under `actionId`, and nothing else: when the file no longer has it the tile is unavailable.
 */
export type FavoriteLinkRef =
  { kind: "profile"; profileId: string } | { kind: "action"; spaceId: Id; actionId: string };

/**
 * A `FavoriteLinkRef` with the name it had when it was added, so a tile can still say what it was
 * once its profile or action is gone.
 */
export type FavoriteLink = FavoriteLinkRef & { label: string };

/**
 * A window of the app besides the main one. It shows one space, and no other window shows that
 * space (nor does the main window): a terminal is drawn by one page, so the tabs of a space belong
 * to the window that shows it. Moving a tab to a window is moving it into the space the window
 * shows (`window/move-item`). The state lives with the main window, which is the only one that
 * loads and saves it (`docs/ARCHITECTURE.md`, "Windows").
 */
export interface AppWindow {
  /** Names the native window (`windowLabel`), so it is a name: `isWindowId`. */
  id: Id;
  /** The space the window shows; `window-space-missing` when it is not one. */
  spaceId: Id;
  /**
   * Present on a window made for a tab dragged out of a space (`window/open-with-item`): the space
   * the tab came from. Such a window owns the space it shows, which was made for it; closing the
   * window sends the tabs back (`window/return`) to this space, or to the one the main window shows
   * when it is gone or another window shows it, and the space made for the window goes away. A
   * window without it shows a space that was always there, and keeps it when it closes.
   */
  returnSpaceId?: Id;
}

export interface SpaceDefaults {
  profileId?: string;
  cwd?: string;
  env: Record<string, string>;
  gitIdentity?: { name: string; email: string };
}

/**
 * The picture a space shows behind its terminals while it is active. `image` is a file on this
 * computer (`backgroundImageProblem`); `opacity` and `blur` are left out to take the ones of the
 * settings file or of the theme.
 */
export interface SpaceBackground {
  image: string;
  /** From 0 to 1. */
  opacity?: number;
  /** In pixels. */
  blur?: number;
}

export interface Space {
  id: Id;
  name: string;
  icon: string;
  color: string;
  themeId?: string;
  /** The picture behind the terminals of this space; without it the space follows the settings and the theme. */
  background?: SpaceBackground;
  modIds: string[];
  defaults: SpaceDefaults;
  aiEnabled: boolean;
  saveScrollback: boolean;
  /** Item ids, visual order. */
  pinned: Id[];
  /** Sidebar below the pinned items. */
  tree: Node[];
  /** Every item of the space, pinned and in the tree. */
  items: Record<Id, Item>;
  /**
   * The item the space shows. When set it is an item of `items`; the reducer keeps it so while the
   * space has items, and leaves it absent only when the space is empty.
   */
  activeItemId?: Id;
}

export interface ItemNode {
  kind: "item";
  id: Id;
}

/** A group may hold at most one more level of groups (2 levels in total). */
export interface GroupNode {
  kind: "group";
  id: Id;
  name: string;
  color: string;
  collapsed: boolean;
  children: Node[];
  /**
   * Present on a live group: where its entries come from (`LiveGroups`, `live-groups.ts`). The
   * entries are not stored; they are asked again from the source at the start and on an interval.
   * Absent on an ordinary group, and in a state saved before live groups.
   */
  live?: LiveSource;
}

/** Where a live group gets its entries: the worktrees of a repository, the SSH hosts, the containers. */
export type LiveSource =
  { source: "worktrees"; folder: string } | { source: "ssh" } | { source: "docker" };

export type Node = ItemNode | GroupNode;

export interface ItemOrigin {
  cwd: string;
  profileId: string;
  command?: string;
}

export interface Item {
  id: Id;
  title?: string;
  titleLocked: boolean;
  /** One pane is a tab; two to `maxPanes` is a split. */
  layout: LayoutNode;
  focusedPaneId: Id;
  zoomedPaneId?: Id;
  /** Where a pinned item returns to on "reset". */
  origin?: ItemOrigin;
  /**
   * The key of the entry of a live group this tab was opened from (`LiveEntry.key`), so opening the
   * entry again shows this tab instead of making another. Absent on any other tab, and in a state
   * saved before live groups.
   */
  liveKey?: string;
  lastActivityAt: number;
}

export interface PaneLeaf {
  kind: "pane";
  pane: Pane;
}

export interface SplitNode {
  kind: "split";
  dir: "row" | "column";
  /** One entry per child, positive, summing to 100. */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneLeaf | SplitNode;

export interface LastCommand {
  text?: string;
  exitCode?: number;
  durationMs?: number;
}

/** A command the shell is running now; `text` is absent when the shell did not tell the line. */
export interface RunningCommand {
  text?: string;
}

/** What a pane shows: a shell, a web page, a file, or the git diff of a folder. */
export type PaneType = "terminal" | "browser" | "preview" | "diff";

export interface Pane {
  id: Id;
  type: PaneType;
  /**
   * The session of a terminal pane. A browser, preview or diff pane never has one
   * (`browser-has-session`, `preview-has-session`, `diff-has-session`).
   */
  sessionId?: Id;
  /**
   * The shell profile of a terminal pane. A browser, preview or diff pane has no shell and holds
   * the default profile, so a terminal pane made from one (a split) starts the default shell.
   */
  profileId: string;
  /**
   * The page of a browser pane: an `http://` or `https://` address (`browserUrlProblem`). Present on
   * every browser pane and on no other. The web view that shows it belongs to the running app and is
   * made again from this address at the start.
   */
  url?: string;
  /**
   * The file of a preview pane: a full path on this computer (`previewPathProblem`). Present on
   * every preview pane and on no other. The file is read again when the pane is shown, so what the
   * pane shows is what the file holds then, not what it held when the path was saved.
   */
  path?: string;
  /**
   * Folder of the shell; a shell with the Noren integration reports it at every prompt. On a diff
   * pane it is the folder whose git diff the pane shows: a full local path (`previewPathProblem`),
   * present on every diff pane, fixed for the life of the pane (no shell moves it), and read again
   * whenever the pane is shown.
   */
  cwd?: string;
  /**
   * The folder the shell of this pane reported last, even the folder it started in, which `cwd` does
   * not keep (a pane started with no folder is not pinned to where its shell happened to begin). Only
   * used to name the tab (`tabLabel`); it belongs to a shell that is gone, so a restored pane starts
   * without it.
   */
  shellCwd?: string;
  /**
   * Branch of the git repository `cwd` is in (or the short commit of a detached `HEAD`); only
   * shown. Read again from `.git/HEAD` at every prompt and every folder change.
   */
  gitBranch?: string;
  status: "running" | "idle" | "exited";
  /** Exit code of the shell; set only while `status` is `"exited"`. */
  exitCode?: number;
  /** The command line the shell reports it is running; gone when it ends or the shell exits. */
  runningCommand?: RunningCommand;
  /** The command that ended last: its line, exit code and duration (each only when known). */
  lastCommand?: LastCommand;
  /** Something happened here (output that asks for attention) while the pane was not on screen. */
  unread: boolean;
  /** The terminal bell rang while the pane was not on screen. */
  bell: boolean;
  /**
   * When the pane became unread, on the timeline of `Item.lastActivityAt`: the order Ctrl+Shift+U
   * follows. Absent when the pane is not unread, and in a state saved before this field.
   */
  unreadAt?: number;
  /** File of the scrollback snapshot. */
  scrollbackRef?: string;
}

/**
 * The spec does not detail the closed/archived entries. Minimum coherent shape: the whole item (so
 * it can be reopened with its layout, cwd and profile), the space it came from and when.
 */
export interface ClosedItem {
  item: Item;
  spaceId: Id;
  /** Same timeline as `Item.lastActivityAt`. */
  closedAt: number;
  /**
   * Where the item sat in its space when it closed, so reopening can put it back there. Absent for
   * an item that closed with its space, and in a state saved before this field.
   */
  place?: ClosedPlace;
}

/** A slot of a space: among the pinned items, or in the tree (a group, or the top level). */
export interface ClosedPlace {
  /** Which list the item was in. */
  list: "pinned" | "tree";
  /** The group that held it; absent at the top level and among the pinned items. */
  groupId?: Id;
  /** Its position in that list, from 0. */
  index: number;
}

/**
 * An item the auto-archive put away (or `item/archive` did): the whole item without sessions, the
 * space it came from and the slot it left, as a closed item keeps them.
 */
export interface ArchivedItem {
  item: Item;
  spaceId: Id;
  /** Same timeline as `Item.lastActivityAt`. */
  archivedAt: number;
  /** Where the item sat in its space, so restoring can put it back there. Absent when it had none. */
  place?: ClosedPlace;
}

/** Closed stack limit. */
export const MAX_CLOSED = 50;
/**
 * Default for the most panes one item may hold. The settings can change it (`terminal.maxPanes`, see
 * `paneLimitOf`), within `MIN_MAX_PANES` and `MAX_MAX_PANES`.
 */
export const DEFAULT_MAX_PANES = 8;
/** Deepest group nesting allowed in `Space.tree`. */
export const MAX_GROUP_DEPTH = 2;
/** Most windows the app keeps besides the main one. */
export const MAX_EXTRA_WINDOWS = 8;

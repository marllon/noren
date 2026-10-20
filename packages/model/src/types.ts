/** Opaque identifier. Unique within a workspace across spaces, items, groups and panes. */
export type Id = string;

/** State saved in `state.json`. */
export interface Workspace {
  version: 2;
  spaces: Space[];
  activeSpaceId: Id;
  /** Item ids, global (an item of any space). */
  favorites: Id[];
  /** Recently closed items, newest last, at most `MAX_CLOSED`. */
  closed: ClosedItem[];
  archive: ArchivedItem[];
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
}

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

/** What a pane shows: a shell, or a web page. */
export type PaneType = "terminal" | "browser";

export interface Pane {
  id: Id;
  type: PaneType;
  /** The session of a terminal pane. A browser pane never has one (`browser-has-session`). */
  sessionId?: Id;
  /**
   * The shell profile of a terminal pane. A browser pane has no shell and holds the default
   * profile, so a terminal pane made from it (a split) starts the default shell.
   */
  profileId: string;
  /**
   * The page of a browser pane: an `http://` or `https://` address (`browserUrlProblem`). Present on
   * every browser pane and on no terminal pane. The web view that shows it belongs to the running
   * app and is made again from this address at the start.
   */
  url?: string;
  /** Folder of the shell; a shell with the Noren integration reports it at every prompt. */
  cwd?: string;
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
/** Default for the most panes one item may hold. */
export const DEFAULT_MAX_PANES = 4;
/** Deepest group nesting allowed in `Space.tree`. */
export const MAX_GROUP_DEPTH = 2;

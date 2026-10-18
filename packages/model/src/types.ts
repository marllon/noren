/** Opaque identifier. Unique within a workspace across spaces, items, groups and panes. */
export type Id = string;

/** State saved in `state.json`. */
export interface Workspace {
  version: 1;
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

export interface Space {
  id: Id;
  name: string;
  icon: string;
  color: string;
  themeId?: string;
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

export interface Pane {
  id: Id;
  type: "terminal";
  sessionId?: Id;
  profileId: string;
  cwd?: string;
  status: "running" | "idle" | "exited";
  exitCode?: number;
  lastCommand?: LastCommand;
  unread: boolean;
  bell: boolean;
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
}

export interface ArchivedItem {
  item: Item;
  spaceId: Id;
  archivedAt: number;
}

/** Closed stack limit. */
export const MAX_CLOSED = 50;
/** Default for the most panes one item may hold. */
export const DEFAULT_MAX_PANES = 4;
/** Deepest group nesting allowed in `Space.tree`. */
export const MAX_GROUP_DEPTH = 2;

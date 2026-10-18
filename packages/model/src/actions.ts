import type { Clock } from "./clock";
import type { IdGenerator } from "./ids";
import type { Id, Pane } from "./types";

/**
 * Where an item lands in a space. `index` is the final position in the target list (after the item
 * left its old spot); a missing index means the end and one past the end is clamped.
 */
export type Placement =
  | { to: "pinned"; index?: number }
  /** `groupId` absent means the top level of the tree. */
  | { to: "tree"; groupId?: Id; index?: number };

/** What happens to the items of a space that is deleted. */
export type SpaceItemsFate =
  /** Pinned items stay pinned and the tree is appended, groups included. */
  | { mode: "move"; targetSpaceId: Id }
  /** Every item goes to the closed stack, like `item/close`. */
  | { mode: "close" };

/**
 * Every change to a workspace the model knows about. Where a space is optional, it is the active
 * one.
 */
export type Action =
  // Spaces
  | {
      type: "space/create";
      name: string;
      icon?: string;
      color?: string;
      /** Default profile of the space; new items use it. */
      profileId?: string;
      /** Default folder of the space; new items use it. */
      cwd?: string;
      /** Environment of the space; new sessions get it. Names must be valid (see `validEnv`). */
      env?: Record<string, string>;
      /** Becomes the active space unless `false`. */
      activate?: boolean;
    }
  /**
   * Changes the defaults new items of the space start with. A missing field stays as it is; a blank
   * `profileId` or `cwd` clears it; `env`, when given, replaces the whole environment; a
   * `gitIdentity` whose name and email are both blank clears the identity. A NUL in the name or
   * email is refused.
   */
  | {
      type: "space/set-defaults";
      spaceId: Id;
      profileId?: string;
      cwd?: string;
      env?: Record<string, string>;
      gitIdentity?: { name: string; email: string };
    }
  | { type: "space/rename"; spaceId: Id; name: string }
  | { type: "space/set-color"; spaceId: Id; color: string }
  | { type: "space/set-icon"; spaceId: Id; icon: string }
  | { type: "space/move"; spaceId: Id; index: number }
  | { type: "space/activate"; spaceId: Id }
  /**
   * Chooses the item a space shows. The item must belong to that space. The reducer also moves it
   * on its own: a new or reopened item becomes active, and when the active item leaves the space
   * the next one in sidebar order (else the previous one) takes over.
   */
  | { type: "space/set-active-item"; spaceId: Id; itemId: Id }
  | { type: "space/delete"; spaceId: Id; items: SpaceItemsFate }
  // Items
  | {
      type: "item/create";
      spaceId?: Id;
      /** Defaults to the profile of the space, then to `DEFAULT_PROFILE_ID`. */
      profileId?: string;
      /** Defaults to the folder of the space. */
      cwd?: string;
      /** Defaults to the end of the tree. */
      placement?: Placement;
    }
  | { type: "item/close"; itemId: Id }
  /** Reopens the given closed item, or the most recently closed one. */
  | { type: "item/reopen"; itemId?: Id }
  | {
      type: "item/rename";
      itemId: Id;
      /** Blank clears the title. */
      title: string;
      /**
       * `user` (default) sets the title and locks it, or unlocks it when `title` is blank.
       * `process` is the title the running program asks for; ignored while the title is locked.
       */
      source?: "user" | "process";
    }
  | {
      type: "item/move";
      itemId: Id;
      /** Target space; defaults to the item's own. */
      spaceId?: Id;
      /** Defaults to the end of the tree. */
      placement?: Placement;
    }
  | { type: "item/pin"; itemId: Id; index?: number }
  | { type: "item/unpin"; itemId: Id; index?: number }
  /**
   * Takes a pinned item back to its origin: the focused pane is replaced by a new one in the folder
   * and profile the item had when it was pinned (its session is dropped). Without an origin, or
   * for an item that is not pinned, nothing changes.
   */
  | { type: "item/reset"; itemId: Id }
  | { type: "item/favorite"; itemId: Id }
  | { type: "item/unfavorite"; itemId: Id }
  // Groups
  | {
      type: "group/create";
      spaceId?: Id;
      name: string;
      /** Defaults to the color of the space. */
      color?: string;
      /** A top-level group to nest in (the second and last level). */
      parentGroupId?: Id;
      index?: number;
    }
  | {
      type: "group/create-from-selection";
      /** Tree items (not pinned ones) of one space. */
      itemIds: Id[];
      name: string;
      color?: string;
    }
  | { type: "group/ungroup"; groupId: Id }
  /**
   * Moves a group, children included, within its space. `parentGroupId` is the top-level group to
   * nest it in (absent: the top level); a group that holds a group cannot nest, and nothing nests in
   * itself. `index` is the final position in the target list (after the group left its old spot);
   * a missing index means the end and one past the end is clamped.
   */
  | { type: "group/move"; groupId: Id; parentGroupId?: Id; index?: number }
  | { type: "group/set-collapsed"; groupId: Id; collapsed: boolean }
  | { type: "group/rename"; groupId: Id; name: string }
  | { type: "group/set-color"; groupId: Id; color: string }
  // Splits. A pane is named by its item and its own id.
  /**
   * Splits `paneId` in two: `dir` is the axis the panes line up on (`row`: side by side, `column`:
   * stacked) and `side` puts the new pane before (left/top) or after (right/bottom) it. The new
   * pane takes focus and ends zoom. It inherits `profileId` and `cwd` from the split pane unless
   * given. Over `maxPanes` is invalid.
   */
  | {
      type: "pane/split";
      itemId: Id;
      paneId: Id;
      dir: "row" | "column";
      side: "before" | "after";
      profileId?: string;
      cwd?: string;
    }
  /** Closes the pane and the layout collapses. Closing the only pane closes the item. */
  | { type: "pane/close"; itemId: Id; paneId: Id }
  /** Moves the pane, session included, to a new item right after the item it came from. */
  | { type: "pane/detach"; itemId: Id; paneId: Id }
  /**
   * Merges item `itemId` into item `targetItemId`, beside `targetPaneId` (dropping on a pane edge).
   * The source item leaves its space; its panes and sessions live on in the target.
   */
  | {
      type: "item/join";
      itemId: Id;
      targetItemId: Id;
      targetPaneId: Id;
      dir: "row" | "column";
      side: "before" | "after";
    }
  /**
   * Sets the sizes of one split. `path` is the child index at each level from the root (`[]` is
   * the root split). `sizes` need not sum to 100: they are normalized.
   */
  | { type: "pane/resize"; itemId: Id; path: number[]; sizes: number[] }
  /** Toggles zoom on `paneId` (default: the zoomed pane, else the focused one). */
  | { type: "pane/zoom"; itemId: Id; paneId?: Id }
  | { type: "pane/swap"; itemId: Id; paneId: Id; otherPaneId: Id }
  /** Focus a pane (ends zoom unless it is the zoomed pane). */
  | { type: "pane/focus"; itemId: Id; paneId: Id }
  /**
   * Records what the pane's shell is doing. `exitCode` is kept only with `"exited"` (other statuses
   * clear it). An unknown pane or a value that changes nothing leaves the workspace as it is.
   */
  | {
      type: "pane/set-status";
      itemId: Id;
      paneId: Id;
      status: Pane["status"];
      exitCode?: number;
    }
  /** Focus the neighbor by layout geometry (ends zoom); no neighbor, no change. */
  | { type: "pane/focus-direction"; itemId: Id; direction: "left" | "right" | "up" | "down" };

export type ActionType = Action["type"];

/** What the reducer needs from the outside, so it stays free of randomness and wall-clock time. */
export interface ReducerContext {
  /** Fresh ids. Ids already in the workspace are skipped, so a restarted counter is safe. */
  newId: IdGenerator;
  /** Source of `lastActivityAt` and `closedAt`. */
  clock: Pick<Clock, "now">;
  /** Most panes one item may hold; an action that would pass it changes nothing. Default 4. */
  maxPanes?: number;
}

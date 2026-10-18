import type { Clock } from "./clock";
import type { IdGenerator } from "./ids";
import type { Id } from "./types";

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
 * Every change to a workspace the model knows about (splits join in NOR-F3-03). Where a space is
 * optional, it is the active one.
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
      /** Becomes the active space unless `false`. */
      activate?: boolean;
    }
  | { type: "space/rename"; spaceId: Id; name: string }
  | { type: "space/set-color"; spaceId: Id; color: string }
  | { type: "space/set-icon"; spaceId: Id; icon: string }
  | { type: "space/move"; spaceId: Id; index: number }
  | { type: "space/activate"; spaceId: Id }
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
  | { type: "group/set-collapsed"; groupId: Id; collapsed: boolean }
  | { type: "group/rename"; groupId: Id; name: string }
  | { type: "group/set-color"; groupId: Id; color: string };

export type ActionType = Action["type"];

/** What the reducer needs from the outside, so it stays free of randomness and wall-clock time. */
export interface ReducerContext {
  /** Fresh ids. Ids already in the workspace are skipped, so a restarted counter is safe. */
  newId: IdGenerator;
  /** Source of `lastActivityAt` and `closedAt`. */
  clock: Pick<Clock, "now">;
}

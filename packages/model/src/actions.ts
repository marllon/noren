import type { Clock } from "./clock";
import type { IdGenerator } from "./ids";
import type { SpaceFile } from "./space-file";
import type { FavoriteLink, FavoriteLinkRef, Id, LiveSource, Pane, SpaceBackground } from "./types";

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
  /**
   * Adds the space a `.noren-space.json` file describes (`space-file.ts`) as a new space at the end:
   * the space, its items, groups and panes all get fresh ids, so nothing collides with the
   * workspace, and every tab starts with no session. The file is checked again (`validateSpaceFile`
   * with the `maxPanes` of the context); one that is not valid, or has a tab with more panes than
   * the limit, changes nothing. The profiles of the file are not part of the workspace (see
   * `planProfiles`). Becomes the active space unless `activate` is `false`.
   */
  | { type: "space/import"; file: SpaceFile; activate?: boolean }
  /**
   * Makes a space again from a `.noren-space.json` file (`space-file.ts`): the space keeps its id,
   * its place in the list, whether it is the active one, the window that shows it and the picture
   * behind its terminals, and takes the rest from the file (name, tabs, groups, defaults) with fresh
   * ids for the tabs, groups and panes. The tabs it had go to the closed stack, so they can be
   * reopened, and their sessions are dropped. This is what a pull of the sync does with a space
   * whose file changed on another computer. A space that does not exist, and a file that is not
   * valid (or has a tab over `maxPanes`), change nothing.
   */
  | { type: "space/reimport"; spaceId: Id; file: SpaceFile }
  | { type: "space/rename"; spaceId: Id; name: string }
  | { type: "space/set-color"; spaceId: Id; color: string }
  | { type: "space/set-icon"; spaceId: Id; icon: string }
  /**
   * Gives the space its own theme, which shows while the space is active, or (`themeId` null) takes
   * it back so the space follows the global theme. The id is kept as given (trimmed): whether the
   * build has such a theme is for the interface to say, so a theme from a later build or an
   * importer is not lost. A blank id changes nothing.
   */
  | { type: "space/set-theme"; spaceId: Id; themeId: string | null }
  /**
   * Gives the space a picture behind its terminals, or (`background` null) takes it back so the
   * space follows the settings file and the theme. The path is checked (`backgroundImageProblem`;
   * a web address, a network path or something that is not a picture changes nothing), `opacity`
   * and `blur` are held to their range and left out when they are not numbers.
   */
  | { type: "space/set-background"; spaceId: Id; background: SpaceBackground | null }
  /**
   * Sets the mods the space turns on, as the names of their files in the mods folder, in the order
   * they apply (the one applied last wins; the space's mods come after the global ones). The names
   * are kept as given when they are mod names (`isValidModFileName`), without repeats, so a mod the
   * folder does not have right now stays on the list; anything else in the list is dropped. An
   * empty list turns the space's mods off. A list the space already has changes nothing.
   */
  | { type: "space/set-mods"; spaceId: Id; modIds: readonly string[] }
  /**
   * Turns the AI on or off for the space (`Space.aiEnabled`, on for a new space). Off, no AI function
   * is offered in it and nothing of it is sent to a provider, whatever `ai.enabled` says in the
   * settings (see `aiIsOn`). A value that is not a boolean, or the one the space already has,
   * changes nothing.
   */
  | { type: "space/set-ai"; spaceId: Id; enabled: boolean }
  | { type: "space/move"; spaceId: Id; index: number }
  /**
   * Shows the space in the main window. A space another window shows cannot be shown here too (a
   * terminal is drawn by one page): nothing changes then.
   */
  | { type: "space/activate"; spaceId: Id }
  // Windows
  /**
   * Adds a window that shows the space (`AppWindow`, with a fresh id). Nothing changes when the
   * space does not exist, when the main window or another window shows it already, or when the
   * workspace has `MAX_EXTRA_WINDOWS` windows besides the main one.
   */
  | { type: "window/open"; spaceId: Id }
  /** Takes the window away from the workspace. The space it showed keeps its tabs. */
  | { type: "window/close"; windowId: Id }
  /**
   * Moves the tab to the window: into the space the window shows, at `placement` (the end of the
   * tree by default), and makes it the tab that space shows. The tab keeps its panes and sessions.
   * Nothing changes for a window or a tab that does not exist, or a tab already in that space.
   */
  | { type: "window/move-item"; itemId: Id; windowId: Id; placement?: Placement }
  /**
   * Drags a tab out of the window: makes a space of its own (named `name`, "Window" when left
   * out; it keeps the colors and start folder of the space the tab comes from), a window that
   * shows it and moves the tab in, as the tab that window shows, all in one step. The window
   * remembers where the tab came from (`AppWindow.returnSpaceId`). Nothing changes for a tab that
   * does not exist or has a pane no window can draw (`windowCanShowTab`; every kind there is
   * today can be drawn), or when the workspace has `MAX_EXTRA_WINDOWS` windows besides the main one.
   */
  | { type: "window/open-with-item"; itemId: Id; name?: string }
  /**
   * Closes a window that was made for a tab (`returnSpaceId`) and gives its tabs back: each goes to
   * the end of the space it came from (pinned ones stay pinned), or of the space the main window
   * shows when that one is gone or another window shows it, and the space made for the window goes
   * away. When the main window gets the tabs, the one the window showed becomes its active tab.
   * A window without `returnSpaceId` is closed as by `window/close`.
   */
  | { type: "window/return"; windowId: Id }
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
      /**
       * A session that is already running, for the pane of the new tab to hold (a terminal opened in
       * the quick window and promoted): the tab shows that shell instead of starting one. Nothing
       * is created when an open pane already holds the session. The profile is then the one the
       * session was started with, so pass it; the folder, when left out, is the one of the space.
       */
      sessionId?: Id;
      /** The key of the live entry the tab is opened from (`Item.liveKey`); blank is ignored. */
      liveKey?: string;
    }
  | { type: "item/close"; itemId: Id }
  /**
   * Reopens the given closed item, or the most recently closed one, where it sat when it closed:
   * the same space, and in it the same list (pinned or tree), group and position (clamped to what
   * the list holds now). A group that is gone, or an item with no recorded place, goes to the end
   * of the tree of its space; with that space gone too, to the end of the tree of the active one.
   */
  | { type: "item/reopen"; itemId?: Id }
  /**
   * Puts an open item away in the archive: it leaves its space like a closed one (its sessions are
   * dropped, it stops being a favorite) and the archive keeps it with the slot it left. This is what
   * the auto-archive does to an idle item; the archive has no size limit.
   */
  | { type: "item/archive"; itemId: Id }
  /**
   * Brings an archived item back where it sat, exactly as `item/reopen` does for a closed one: the
   * same space, list, group and position when they still exist, else the end of the tree of its
   * space (or of the active one). The pane comes back clean, without a session.
   */
  | { type: "archive/restore"; itemId: Id }
  /** Forgets an archived item for good (the app removes its scrollback files). */
  | { type: "archive/delete"; itemId: Id }
  /** Forgets a closed item for good, taking it off the stack (the app removes its scrollback files). */
  | { type: "closed/delete"; itemId: Id }
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
  /**
   * Puts a shell profile or a project action in the Favorites bar, after what is there. Nothing
   * changes for a link that is already in it, one with no name or no id, or an action of a space
   * that does not exist (`favoriteLinkProblem`).
   */
  | { type: "favorite/add-link"; link: FavoriteLink }
  /** Takes a profile or an action out of the bar; nothing changes when it is not in it. */
  | { type: "favorite/remove-link"; link: FavoriteLinkRef }
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
      /** Makes the group live (`GroupNode.live`); an invalid source makes no group. */
      live?: LiveSource;
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
  /**
   * Makes the group live on `live`, or an ordinary group again when `live` is absent. The tabs it
   * holds stay; an invalid source changes nothing.
   */
  | { type: "group/set-live"; groupId: Id; live?: LiveSource }
  // Splits. A pane is named by its item and its own id.
  /**
   * Splits `paneId` in two: `dir` is the axis the panes line up on (`row`: side by side, `column`:
   * stacked) and `side` puts the new pane before (left/top) or after (right/bottom) it. The new
   * pane takes focus and ends zoom. It inherits `profileId` and `cwd` from the split pane unless
   * given. Over `maxPanes` is invalid. With `url` the new pane is a browser pane showing that page
   * (see `createBrowserPane`), with no shell and no folder: an address `browserUrlProblem` refuses
   * changes nothing. With `path` it is a preview pane showing that file (`createPreviewPane`), also
   * with no shell and no folder, and a path `previewPathProblem` refuses changes nothing; `url` and
   * `path` together change nothing either. With `diff` set the new pane is a diff pane
   * (`createDiffPane`) showing the git diff of `cwd` (the folder of the split pane when `cwd` is
   * not given), with no shell: a folder `previewPathProblem` refuses, or none at all, changes
   * nothing, and `diff` together with `url` or `path` changes nothing either.
   */
  | {
      type: "pane/split";
      itemId: Id;
      paneId: Id;
      dir: "row" | "column";
      side: "before" | "after";
      profileId?: string;
      cwd?: string;
      url?: string;
      path?: string;
      diff?: boolean;
    }
  /**
   * Points a browser pane at another page. An address `browserUrlProblem` refuses, a pane that is
   * not a browser pane, an unknown pane or the address the pane already has leave the workspace as
   * it is.
   */
  | { type: "pane/set-url"; itemId: Id; paneId: Id; url: string }
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
  /**
   * Records where the pane's shell is: the folder it reports and the git branch of that folder
   * (`gitBranch` absent: the folder is in no repository, so a branch the pane had is cleared). Both
   * are set together, so the sidebar never shows a new folder with the old branch. `cwd` absent
   * keeps the folder the pane has (see `PaneLocation`). A blank `cwd`, an unknown pane or values
   * the pane already has leave the workspace as it is.
   */
  | {
      type: "pane/set-location";
      itemId: Id;
      paneId: Id;
      cwd?: string;
      gitBranch?: string;
    }
  /**
   * Records the folder the pane's shell reported (`Pane.shellCwd`), the moment it reports it and
   * whether or not the pane keeps it as its own folder: it names the tab (`tabLabel`) and nothing
   * else. A blank `cwd`, an unknown pane or a folder the pane already has leave the workspace as it is.
   */
  | { type: "pane/set-shell-folder"; itemId: Id; paneId: Id; cwd: string }
  /**
   * The pane's shell starts running a command (OSC 133;C). `text` is the command line when the
   * shell told it (blank is none, long lines are cut). A pane whose shell exited, an unknown pane
   * or a command the pane already shows as running leave the workspace as it is.
   */
  | { type: "pane/command-start"; itemId: Id; paneId: Id; text?: string }
  /**
   * The pane's command ended (OSC 133;D): the running command goes away and becomes `lastCommand`.
   * `text` absent keeps the line the pane showed as running; `exitCode` and `durationMs` are kept
   * only when they are whole numbers (the duration not negative). An unknown pane or a result the
   * pane already has leave the workspace as it is.
   */
  | {
      type: "pane/command-end";
      itemId: Id;
      paneId: Id;
      text?: string;
      exitCode?: number;
      durationMs?: number;
    }
  /**
   * The pane's program asked for attention (a bell, or an OSC 9 or OSC 777 notification): the pane
   * becomes unread, and `bell` also sets its bell mark. A pane on screen (in the item the active
   * space shows, not hidden by zoom) is where the user is looking, so it is never marked. An unknown
   * pane, or marks the pane already has, leave the workspace as it is.
   */
  | { type: "pane/notify"; itemId: Id; paneId: Id; bell?: boolean }
  /**
   * Records that the pane has a scrollback snapshot on disk (`ref` is the name of its file, see
   * `scrollbackFileName`), or that it no longer has one (`ref` absent). It is only a note of where
   * the file is: the file itself is never found through it. A blank `ref`, an unknown pane or a
   * note the pane already has leave the workspace as it is.
   */
  | { type: "pane/set-scrollback"; itemId: Id; paneId: Id; ref?: string }
  /**
   * Clears the unread and bell marks of `paneId`, or of every pane of the item without it. Nothing
   * to clear leaves the workspace as it is. Showing a pane clears it without this action (see
   * `reduce`).
   */
  | { type: "pane/clear-unread"; itemId: Id; paneId?: Id }
  /** Focus the neighbor by layout geometry (ends zoom); no neighbor, no change. */
  | { type: "pane/focus-direction"; itemId: Id; direction: "left" | "right" | "up" | "down" };

export type ActionType = Action["type"];

/** What the reducer needs from the outside, so it stays free of randomness and wall-clock time. */
export interface ReducerContext {
  /** Fresh ids. Ids already in the workspace are skipped, so a restarted counter is safe. */
  newId: IdGenerator;
  /** Source of `lastActivityAt`, `closedAt` and `archivedAt`. */
  clock: Pick<Clock, "now">;
  /** Most panes one item may hold; an action that would pass it changes nothing. Default 4. */
  maxPanes?: number;
}

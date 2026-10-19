import {
  DEFAULT_PROFILE_ID,
  StateWriter,
  lastUnread,
  layoutPanes,
  liveSessionIds,
  reduce,
  treeGroups,
  treeItemIds,
} from "@noren/model";
import type {
  Action,
  Backend,
  Clock,
  IdGenerator,
  Id,
  Item,
  LayoutNode,
  Pane,
  PaneAttentionEvent,
  PaneCommandEvent,
  PaneLocation,
  Space,
  Workspace,
} from "@noren/model";
import { createStore } from "zustand/vanilla";
import { autoTitleAction } from "./auto-title";
import type { StoreApi } from "zustand/vanilla";

/** What the new-space dialog collects. A missing field leaves the default of the model. */
export interface NewSpaceInput {
  name: string;
  icon?: string;
  color?: string;
  profileId?: string;
  cwd?: string;
  env?: Record<string, string>;
  gitIdentity?: GitIdentity;
}

/** Name and email git records as author and committer. */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * What the edit-space dialog changes. A missing field stays as it is. A blank `cwd` clears the
 * start folder and `env`, when given, replaces the whole environment. A `gitIdentity` with a blank
 * name and a blank email clears the identity.
 */
export interface SpaceEdit {
  name?: string;
  icon?: string;
  color?: string;
  cwd?: string;
  env?: Record<string, string>;
  gitIdentity?: GitIdentity;
}

/** What a new tab can name; what is left out comes from the space. */
export interface NewTabOptions {
  profileId?: string;
  cwd?: string;
}

/** How to start the shell of a pane: its own settings first, then the defaults of its space. */
export interface SessionStartOptions {
  profileId?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkspaceState {
  workspace: Workspace;
  /** Panes whose shell could not start at restore; they have no session. */
  failedPaneIds: Id[];
  /** Runs an action through the reducer, schedules the save and ends the sessions it dropped. */
  dispatch(action: Action): void;
  /**
   * Makes a new tab in the active space and activates it. It starts with the profile and folder of
   * the space unless the options name others.
   */
  newTab(options?: NewTabOptions): void;
  /** Makes a space (active) with its first tab, which starts with the defaults of the space. */
  createSpace(input: NewSpaceInput): void;
  /** Renames, recolors, re-icons or changes the defaults of a space; unknown ids change nothing. */
  editSpace(spaceId: Id, edit: SpaceEdit): void;
  /**
   * Deletes a space: its tabs close, their sessions end and another space becomes active. The last
   * space is never deleted. Returns whether the space was deleted.
   */
  deleteSpace(spaceId: Id): boolean;
  /** Moves a space to a zero-based position of the switcher (clamped); unknown ids change nothing. */
  moveSpace(spaceId: Id, index: number): void;
  /** Shows another space; unknown ids change nothing. */
  activateSpace(spaceId: Id): void;
  /** Shows the space at a zero-based position of the switcher; out of range changes nothing. */
  activateSpaceAt(index: number): void;
  /** Activates a tab of the active space (saved with the workspace). */
  activateItem(itemId: Id): void;
  /**
   * Makes a group of tree items of the active space, taking the place of the first one. Returns the
   * id of the new group, or `undefined` when the items cannot be grouped (nothing changes then).
   */
  groupItems(itemIds: readonly Id[], name: string): Id | undefined;
  /** Closes tabs of the active space; the neighbor rule of the model picks the next active one. */
  closeItems(itemIds: readonly Id[]): void;
  /**
   * Closes every tab of the active space except `keepIds` and the pinned ones. The first kept tab
   * becomes the active one before the others go.
   */
  closeOthers(keepIds: readonly Id[]): void;
  /** Records the session the view started for a pane. Not saved: sessions die with the process. */
  attachSession(paneId: Id, sessionId: Id): void;
  /**
   * Records where the shell of a pane is (its folder and git branch, as the shell reported them; no
   * folder keeps the pane's own). The pane may have moved to another tab since the report started;
   * it is found by its id. A pane that is gone, or a location the pane already has, changes nothing.
   */
  setPaneLocation(paneId: Id, location: PaneLocation): void;
  /**
   * Records that the command of a pane started or ended (see `PaneCommandEvent`). Like
   * `setPaneLocation`, the pane is found by its id and a report that changes nothing changes nothing.
   */
  setPaneCommand(paneId: Id, event: PaneCommandEvent): void;
  /**
   * Records that the program of a pane asked for attention (a bell, or a notification): the pane
   * is marked unread unless it is on screen. The pane is found by its id; a pane that is gone
   * changes nothing.
   */
  notifyPane(paneId: Id, event: PaneAttentionEvent): void;
  /**
   * Shows the pane that became unread last: its space, its tab and the pane itself, which reads
   * it. Returns whether there was one; nothing unread changes nothing.
   */
  showLastUnread(): boolean;
  /** Writes the pending state now (window closing). */
  flush(): Promise<void>;
}

export type WorkspaceStore = StoreApi<WorkspaceState>;

export interface WorkspaceStoreOptions {
  /**
   * `saveState` for the default writer, `kill` for the sessions an action drops and `onExit` to
   * mark the pane of a shell that ended.
   */
  backend: Pick<Backend, "saveState" | "kill" | "onExit">;
  workspace: Workspace;
  failedPaneIds?: Id[];
  /** Defaults to a `StateWriter` on `backend` with the 500 ms debounce. */
  writer?: StateWriter;
  /** Must be unique across runs (the default is `crypto.randomUUID`). */
  newId?: IdGenerator;
  clock?: Pick<Clock, "now">;
  /** The home folder, so the automatic title of a tab in it is `~`. */
  home?: string;
  maxPanes?: number;
  onError?(error: unknown): void;
}

/** Ids of the items of a space in sidebar order: pinned first, then the tree. */
export function spaceItemIds(space: Space): Id[] {
  return [...space.pinned, ...treeItemIds(space.tree)];
}

/**
 * The environment new sessions of a space get: the git identity as author and committer, under the
 * variables of the space, which win on a conflict (names compare ignoring case, as on Windows).
 * A blank name or email leaves its variables out.
 */
export function spaceSessionEnv(space: Space): Record<string, string> {
  const { env, gitIdentity } = space.defaults;
  if (gitIdentity === undefined) return env;
  const taken = new Set(Object.keys(env).map((name) => name.toUpperCase()));
  const fromIdentity: Record<string, string> = {};
  const add = (names: string[], value: string) => {
    if (value === "") return;
    for (const name of names) if (!taken.has(name)) fromIdentity[name] = value;
  };
  add(["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"], gitIdentity.name);
  add(["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"], gitIdentity.email);
  return { ...fromIdentity, ...env };
}

/**
 * The options for the shell of `pane`: profile, folder and environment of the pane, falling back
 * to the defaults of `space`. The default profile is left out so the backend picks it.
 */
export function sessionStartOptions(space: Space, pane: Pane): SessionStartOptions {
  const cwd = pane.cwd ?? space.defaults.cwd;
  const env = spaceSessionEnv(space);
  return {
    ...(pane.profileId !== DEFAULT_PROFILE_ID ? { profileId: pane.profileId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** The space the user is looking at. */
export function activeSpaceOf(ws: Workspace): Space {
  const space = ws.spaces.find((s) => s.id === ws.activeSpaceId) ?? ws.spaces[0];
  if (!space) throw new Error("the workspace has no space");
  return space;
}

/**
 * The tab of the active space that shows in the content area; `undefined` for an empty space. It is
 * the space's `activeItemId`; a space that holds none (a hand-edited file) shows its first tab.
 */
export function activeItemIdOf(state: Pick<WorkspaceState, "workspace">): Id | undefined {
  const space = activeSpaceOf(state.workspace);
  const chosen = space.activeItemId;
  if (chosen !== undefined && space.items[chosen] !== undefined) return chosen;
  return spaceItemIds(space)[0];
}

/** The item and pane that hold a session, among the open items; `undefined` when none does. */
function findPaneBySession(ws: Workspace, sessionId: Id): { itemId: Id; paneId: Id } | undefined {
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      const pane = layoutPanes(item.layout).find((p) => p.sessionId === sessionId);
      if (pane) return { itemId: item.id, paneId: pane.id };
    }
  }
  return undefined;
}

function findItem(ws: Workspace, itemId: Id): Item | undefined {
  for (const space of ws.spaces) {
    const item = space.items[itemId];
    if (item) return item;
  }
  return undefined;
}

/** The item that holds a pane, among the open items; `undefined` when none does. */
function findItemOfPane(ws: Workspace, paneId: Id): Id | undefined {
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      if (layoutPanes(item.layout).some((p) => p.id === paneId)) return item.id;
    }
  }
  return undefined;
}

/** Copy of the layout with the session set on the pane; the same object when the pane is absent. */
function withSession(layout: LayoutNode, paneId: Id, sessionId: Id): LayoutNode {
  if (layout.kind === "pane") {
    return layout.pane.id === paneId
      ? { kind: "pane", pane: { ...layout.pane, sessionId } }
      : layout;
  }
  const children = layout.children.map((child) => withSession(child, paneId, sessionId));
  return children.some((child, index) => child !== layout.children[index])
    ? { ...layout, children }
    : layout;
}

function attachToWorkspace(ws: Workspace, paneId: Id, sessionId: Id): Workspace {
  let changed = false;
  const spaces = ws.spaces.map((space) => {
    const items: Record<Id, Item> = {};
    for (const [id, item] of Object.entries(space.items)) {
      const layout = withSession(item.layout, paneId, sessionId);
      if (layout !== item.layout) changed = true;
      items[id] = layout === item.layout ? item : { ...item, layout };
    }
    return { ...space, items };
  });
  return changed ? { ...ws, spaces } : ws;
}

/** The state of the interface: a thin Zustand store over the pure reducer of `@noren/model`. */
export function createWorkspaceStore(options: WorkspaceStoreOptions): WorkspaceStore {
  const { backend } = options;
  const onError = options.onError ?? (() => undefined);
  const writer = options.writer ?? new StateWriter({ backend, onError });
  const newId = options.newId ?? (() => crypto.randomUUID());
  const clock = options.clock ?? { now: () => Date.now() };
  const context = {
    newId,
    clock,
    ...(options.maxPanes !== undefined ? { maxPanes: options.maxPanes } : {}),
  };

  const kill = (sessionId: Id) => {
    backend.kill(Number(sessionId)).catch(() => undefined);
  };

  return createStore<WorkspaceState>()((set, get) => {
    /** Gives the tab the title its pane asks for (the running program, else the folder). */
    const retitle = (itemId: Id) => {
      const item = findItem(get().workspace, itemId);
      const action = item && autoTitleAction(item, options.home);
      if (action) get().dispatch(action);
    };

    // The store lives as long as the window, so this subscription is never released.
    backend.onExit((exit) => {
      const found = findPaneBySession(get().workspace, String(exit.id));
      if (!found) return;
      get().dispatch({ type: "pane/set-status", ...found, status: "exited", exitCode: exit.code });
    });

    return {
      workspace: options.workspace,
      failedPaneIds: options.failedPaneIds ?? [],

      dispatch(action) {
        const before = get().workspace;
        const after = reduce(before, action, context);
        if (after === before) return;
        set({ workspace: after });
        writer.schedule(after);
        const alive = liveSessionIds(after);
        for (const sessionId of liveSessionIds(before)) {
          if (!alive.has(sessionId)) kill(sessionId);
        }
        // A title the user cleared goes back to what the shell asks for, without waiting for it.
        if (action.type === "item/rename" && (action.source ?? "user") === "user") {
          retitle(action.itemId);
        }
      },

      newTab(options = {}) {
        get().dispatch({
          type: "item/create",
          ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        });
      },

      createSpace(input) {
        const before = get().workspace;
        get().dispatch({
          type: "space/create",
          name: input.name,
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
        });
        const known = new Set(before.spaces.map((space) => space.id));
        const created = get().workspace.spaces.find((space) => !known.has(space.id));
        if (!created) return;
        if (input.gitIdentity !== undefined) {
          get().dispatch({
            type: "space/set-defaults",
            spaceId: created.id,
            gitIdentity: input.gitIdentity,
          });
        }
        get().dispatch({ type: "item/create", spaceId: created.id });
      },

      editSpace(spaceId, edit) {
        const { dispatch } = get();
        if (edit.name !== undefined) dispatch({ type: "space/rename", spaceId, name: edit.name });
        if (edit.color !== undefined)
          dispatch({ type: "space/set-color", spaceId, color: edit.color });
        if (edit.icon !== undefined) dispatch({ type: "space/set-icon", spaceId, icon: edit.icon });
        if (edit.cwd !== undefined || edit.env !== undefined || edit.gitIdentity !== undefined) {
          dispatch({
            type: "space/set-defaults",
            spaceId,
            ...(edit.cwd !== undefined ? { cwd: edit.cwd } : {}),
            ...(edit.env !== undefined ? { env: edit.env } : {}),
            ...(edit.gitIdentity !== undefined ? { gitIdentity: edit.gitIdentity } : {}),
          });
        }
      },

      deleteSpace(spaceId) {
        const before = get().workspace;
        get().dispatch({ type: "space/delete", spaceId, items: { mode: "close" } });
        return get().workspace !== before;
      },

      moveSpace(spaceId, index) {
        get().dispatch({ type: "space/move", spaceId, index });
      },

      activateSpace(spaceId) {
        get().dispatch({ type: "space/activate", spaceId });
      },

      activateSpaceAt(index) {
        const space = get().workspace.spaces[index];
        if (space) get().dispatch({ type: "space/activate", spaceId: space.id });
      },

      activateItem(itemId) {
        const { workspace, dispatch } = get();
        dispatch({ type: "space/set-active-item", spaceId: activeSpaceOf(workspace).id, itemId });
      },

      groupItems(itemIds, name) {
        const space = activeSpaceOf(get().workspace);
        const known = new Set(treeGroups(space.tree).map((group) => group.id));
        get().dispatch({ type: "group/create-from-selection", itemIds: [...itemIds], name });
        const after = activeSpaceOf(get().workspace);
        return treeGroups(after.tree).find((group) => !known.has(group.id))?.id;
      },

      closeItems(itemIds) {
        const { dispatch } = get();
        for (const itemId of itemIds) dispatch({ type: "item/close", itemId });
      },

      closeOthers(keepIds) {
        const { workspace, dispatch } = get();
        const space = activeSpaceOf(workspace);
        const keep = new Set(keepIds);
        const first = keepIds.find((id) => space.items[id] !== undefined);
        if (first === undefined) return;
        dispatch({ type: "space/set-active-item", spaceId: space.id, itemId: first });
        for (const itemId of spaceItemIds(space)) {
          if (!keep.has(itemId) && !space.pinned.includes(itemId)) {
            dispatch({ type: "item/close", itemId });
          }
        }
      },

      attachSession(paneId, sessionId) {
        const { workspace } = get();
        const next = attachToWorkspace(workspace, paneId, sessionId);
        if (next === workspace) {
          // The pane closed while its shell was starting: nobody owns the session.
          kill(sessionId);
          return;
        }
        set({ workspace: next });
      },

      setPaneLocation(paneId, location) {
        const { workspace, dispatch } = get();
        const itemId = findItemOfPane(workspace, paneId);
        if (itemId === undefined) return;
        dispatch({
          type: "pane/set-location",
          itemId,
          paneId,
          ...(location.cwd !== undefined ? { cwd: location.cwd } : {}),
          ...(location.gitBranch !== undefined ? { gitBranch: location.gitBranch } : {}),
        });
        retitle(itemId);
      },

      setPaneCommand(paneId, event) {
        const { workspace, dispatch } = get();
        const itemId = findItemOfPane(workspace, paneId);
        if (itemId === undefined) return;
        if (event.kind === "start") {
          dispatch({
            type: "pane/command-start",
            itemId,
            paneId,
            ...(event.text !== undefined ? { text: event.text } : {}),
          });
        } else {
          dispatch({
            type: "pane/command-end",
            itemId,
            paneId,
            ...(event.text !== undefined ? { text: event.text } : {}),
            ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          });
        }
        retitle(itemId);
      },

      notifyPane(paneId, event) {
        const { workspace, dispatch } = get();
        const itemId = findItemOfPane(workspace, paneId);
        if (itemId === undefined) return;
        dispatch({
          type: "pane/notify",
          itemId,
          paneId,
          ...(event.kind === "bell" ? { bell: true } : {}),
        });
      },

      showLastUnread() {
        const { workspace, dispatch } = get();
        const target = lastUnread(workspace);
        if (target === undefined) return false;
        // The pane gets the focus before its space is shown, so it is the one that is read.
        dispatch({ type: "space/set-active-item", spaceId: target.spaceId, itemId: target.itemId });
        dispatch({ type: "pane/focus", itemId: target.itemId, paneId: target.paneId });
        dispatch({ type: "space/activate", spaceId: target.spaceId });
        return true;
      },

      flush() {
        return writer.flush();
      },
    };
  });
}

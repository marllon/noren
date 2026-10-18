import { DEFAULT_PROFILE_ID, StateWriter, liveSessionIds, reduce, treeItemIds } from "@noren/model";
import type {
  Action,
  Backend,
  Clock,
  IdGenerator,
  Id,
  Item,
  LayoutNode,
  Pane,
  Space,
  Workspace,
} from "@noren/model";
import { createStore } from "zustand/vanilla";
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
  /** Makes a new tab in the active space and activates it. */
  newTab(): void;
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
  /** Records the session the view started for a pane. Not saved: sessions die with the process. */
  attachSession(paneId: Id, sessionId: Id): void;
  /** Writes the pending state now (window closing). */
  flush(): Promise<void>;
}

export type WorkspaceStore = StoreApi<WorkspaceState>;

export interface WorkspaceStoreOptions {
  /** `saveState` for the default writer and `kill` for the sessions an action drops. */
  backend: Pick<Backend, "saveState" | "kill">;
  workspace: Workspace;
  failedPaneIds?: Id[];
  /** Defaults to a `StateWriter` on `backend` with the 500 ms debounce. */
  writer?: StateWriter;
  /** Must be unique across runs (the default is `crypto.randomUUID`). */
  newId?: IdGenerator;
  clock?: Pick<Clock, "now">;
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

  return createStore<WorkspaceState>()((set, get) => ({
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
    },

    newTab() {
      get().dispatch({ type: "item/create" });
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

    flush() {
      return writer.flush();
    },
  }));
}

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

/** Where the interface keeps what is not in `state.json` (only the active tab of each space). */
export type UiStorage = Pick<Storage, "getItem" | "setItem">;

/** Key of the active-tab map in `UiStorage`. */
export const ACTIVE_ITEMS_KEY = "noren.ui.activeItems";

/** What the new-space dialog collects. A missing field leaves the default of the model. */
export interface NewSpaceInput {
  name: string;
  icon?: string;
  color?: string;
  profileId?: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** How to start the shell of a pane: its own settings first, then the defaults of its space. */
export interface SessionStartOptions {
  profileId?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkspaceState {
  workspace: Workspace;
  /**
   * The tab the user picked in each space. The model has no notion of an active item, so this lives
   * beside the workspace; an entry that points to a missing item falls back to the first one.
   */
  activeItems: Record<Id, Id>;
  /** Panes whose shell could not start at restore; they have no session. */
  failedPaneIds: Id[];
  /** Runs an action through the reducer, schedules the save and ends the sessions it dropped. */
  dispatch(action: Action): void;
  /** Makes a new tab in the active space and activates it. */
  newTab(): void;
  /** Makes a space (active) with its first tab, which starts with the defaults of the space. */
  createSpace(input: NewSpaceInput): void;
  /** Shows another space; unknown ids change nothing. */
  activateSpace(spaceId: Id): void;
  /** Shows the space at a zero-based position of the switcher; out of range changes nothing. */
  activateSpaceAt(index: number): void;
  /** Activates a tab of the active space. */
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
  uiStorage?: UiStorage;
  onError?(error: unknown): void;
}

/** Ids of the items of a space in sidebar order: pinned first, then the tree. */
export function spaceItemIds(space: Space): Id[] {
  return [...space.pinned, ...treeItemIds(space.tree)];
}

/**
 * The options for the shell of `pane`: profile, folder and environment of the pane, falling back
 * to the defaults of `space`. The default profile is left out so the backend picks it.
 */
export function sessionStartOptions(space: Space, pane: Pane): SessionStartOptions {
  const cwd = pane.cwd ?? space.defaults.cwd;
  const env = space.defaults.env;
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

/** The tab of the active space that shows in the content area; `undefined` for an empty space. */
export function activeItemIdOf(
  state: Pick<WorkspaceState, "workspace" | "activeItems">,
): Id | undefined {
  const space = activeSpaceOf(state.workspace);
  const chosen = state.activeItems[space.id];
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

/** The item `item/create` added to `spaceId`, if the action made one. */
function createdItemId(before: Workspace, after: Workspace, spaceId: Id): Id | undefined {
  const known = before.spaces.find((s) => s.id === spaceId)?.items ?? {};
  const now = after.spaces.find((s) => s.id === spaceId)?.items ?? {};
  return Object.keys(now).find((id) => !(id in known));
}

function readActiveItems(storage: UiStorage | undefined): Record<Id, Id> {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ACTIVE_ITEMS_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** The state of the interface: a thin Zustand store over the pure reducer of `@noren/model`. */
export function createWorkspaceStore(options: WorkspaceStoreOptions): WorkspaceStore {
  const { backend, uiStorage } = options;
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
  const persistActive = (activeItems: Record<Id, Id>) => {
    try {
      uiStorage?.setItem(ACTIVE_ITEMS_KEY, JSON.stringify(activeItems));
    } catch (error) {
      onError(error);
    }
  };

  return createStore<WorkspaceState>()((set, get) => ({
    workspace: options.workspace,
    activeItems: readActiveItems(uiStorage),
    failedPaneIds: options.failedPaneIds ?? [],

    dispatch(action) {
      const { workspace: before, activeItems } = get();
      const after = reduce(before, action, context);
      if (after === before) return;
      let nextActive = activeItems;
      if (action.type === "item/create") {
        const created = createdItemId(before, after, action.spaceId ?? before.activeSpaceId);
        if (created !== undefined) {
          nextActive = { ...activeItems, [action.spaceId ?? before.activeSpaceId]: created };
        }
      }
      set({ workspace: after, activeItems: nextActive });
      if (nextActive !== activeItems) persistActive(nextActive);
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
      if (created) get().dispatch({ type: "item/create", spaceId: created.id });
    },

    activateSpace(spaceId) {
      get().dispatch({ type: "space/activate", spaceId });
    },

    activateSpaceAt(index) {
      const space = get().workspace.spaces[index];
      if (space) get().dispatch({ type: "space/activate", spaceId: space.id });
    },

    activateItem(itemId) {
      const { workspace, activeItems } = get();
      const space = activeSpaceOf(workspace);
      if (space.items[itemId] === undefined || activeItems[space.id] === itemId) return;
      const next = { ...activeItems, [space.id]: itemId };
      set({ activeItems: next });
      persistActive(next);
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

import type { Action } from "./actions";
import type { ProjectAction } from "./actions-file";
import type { Backend, Unsubscribe } from "./backend";
import { layoutPanes } from "./sessions";
import type { Id, Item, Space, Workspace } from "./types";

/**
 * `stopping` is an action with `stopWaits` whose `stop` command ended with code 0 while the session
 * of its tab is still alive: the action ends when that session does.
 */
export type ActionStatus = "running" | "stopping" | "idle";

/**
 * What `run` did: `started` opened or reused a tab and typed the command into it; `focused` found
 * the action already running and only showed its tab; `abandoned` gave up because the tab was
 * closed (or the executor disposed) before its session came up.
 */
export type RunResult = "started" | "focused" | "abandoned";

export interface RunOptions {
  /**
   * Bring the space onto the screen as well as its tab (the default). With `false` the tab is
   * opened and made the one its space shows, but the space on screen stays the one it is.
   */
  reveal?: boolean;
}

export interface ProjectActionsOptions {
  getWorkspace(): Workspace;
  /** Called after every change of the workspace. */
  subscribe(listener: () => void): Unsubscribe;
  /** Applies the action to the workspace synchronously, so the next `getWorkspace` shows it. */
  dispatch(action: Action): void;
  backend: Pick<Backend, "write" | "kill" | "onExit">;
  /**
   * Runs the `stop` command of an action in a short process with no tab, in the folder of the
   * space, and resolves when it ends. The real one arrives with the Tauri and web backends.
   */
  runStop(cwd: string, command: string): Promise<void>;
}

export interface ProjectActions {
  /**
   * Shows the tab of the action in the space, opening it first when it does not exist, and types
   * `command` followed by Enter into its session. An action that is already running only has its
   * tab shown. Rejects for an unknown space.
   */
  run(spaceId: Id, action: ProjectAction, options?: RunOptions): Promise<RunResult>;
  /**
   * With a `stop` command: runs it through `runStop` in the folder of the space, and once it ends
   * with code 0 ends the sessions of the tab too, unless the action has `stopWaits`: then the
   * sessions stay and the status is `stopping` until they end on their own (`stopNow` ends them).
   * Without a `stop` command (`stopWaits` or not): ends the sessions of the tab. A `stop` command
   * that fails rejects and leaves the sessions alone. Does nothing when there is nothing to end,
   * and when the action is already `stopping`. Rejects for an unknown space, and for a `stop`
   * command in a space with no folder.
   */
  stop(spaceId: Id, action: ProjectAction): Promise<void>;
  /**
   * Ends the sessions of the tab at once, without running the `stop` command: what a click on
   * "stop now" does for an action that is `stopping`. Does nothing when there is nothing to end.
   * Rejects for an unknown space.
   */
  stopNow(spaceId: Id, action: ProjectAction): Promise<void>;
  /**
   * `running` while the session of the action's tab is alive, `stopping` when it is and the action
   * waits for it to end (see `stop`); `idle` without a tab or after it ended.
   */
  status(spaceId: Id, action: ProjectAction): ActionStatus;
  /**
   * Id of the tab of the action in the space: the one this executor opened or found for it, else
   * the tab whose title is the action's `tab` name. `undefined` when there is none.
   */
  tabOf(spaceId: Id, action: ProjectAction): Id | undefined;
  /**
   * Called when a status changes without the workspace changing: a session ends, or an action
   * starts waiting for its sessions to end.
   */
  onExit(listener: () => void): Unsubscribe;
  /** Stops listening to the backend and the workspace; runs waiting for a session give up. */
  dispose(): void;
}

/**
 * The real `runStop`: runs the command through `backend.runCommand`, in a short process with no
 * tab. Rejects when the command cannot run or ends with a code other than 0, so the caller can
 * tell the user the action was not stopped.
 */
export function createRunStop(
  backend: Pick<Backend, "runCommand">,
): ProjectActionsOptions["runStop"] {
  return async (cwd, command) => {
    const code = await backend.runCommand(cwd, command);
    if (code !== 0) throw new Error(`The stop command "${command}" ended with code ${code}`);
  };
}

const ENTER = "\r";

/**
 * The tab of an action is the one this executor opened or found for it (`tabs`), else an item of the
 * space whose title is the `tab` name. Following the item id lets the user rename the tab; the
 * title is the way back to it after a restart, when `tabs` is empty. `run` locks the title it gives
 * a new tab, so a program cannot retitle it.
 */
export function createProjectActions(options: ProjectActionsOptions): ProjectActions {
  const { getWorkspace, dispatch, backend, runStop } = options;
  const tabs = new Map<string, Id>();
  const runs = new Map<string, Promise<RunResult>>();
  const waiters = new Set<() => void>();
  const exited = new Set<Id>();
  /** Actions whose `stop` ended with code 0 and whose sessions are left to end on their own. */
  const stopping = new Set<string>();
  const exitListeners = new Set<() => void>();

  const offExit = backend.onExit((exit) => {
    exited.add(String(exit.id));
    for (const listener of [...exitListeners]) listener();
  });

  const keyOf = (spaceId: Id, action: ProjectAction) => `${spaceId}\u0000${action.id}`;

  const spaceOf = (spaceId: Id): Space => {
    const space = getWorkspace().spaces.find((s) => s.id === spaceId);
    if (!space) throw new Error(`Unknown space: ${spaceId}`);
    return space;
  };

  const findTab = (space: Space, action: ProjectAction): Item | undefined => {
    const key = keyOf(space.id, action);
    const known = tabs.get(key);
    const byId = known === undefined ? undefined : space.items[known];
    if (byId) return byId;
    const byTitle = Object.values(space.items).find((item) => item.title === action.tab);
    if (byTitle) tabs.set(key, byTitle.id);
    else tabs.delete(key);
    return byTitle;
  };

  /** Sessions of the item that are still alive, the focused pane first. */
  const liveSessions = (item: Item): Id[] =>
    layoutPanes(item.layout)
      .sort((a, b) => Number(b.id === item.focusedPaneId) - Number(a.id === item.focusedPaneId))
      .flatMap((pane) =>
        pane.sessionId !== undefined && !exited.has(pane.sessionId) ? [pane.sessionId] : [],
      );

  /** True when a pane of the item once had a session and every one of them has ended. */
  const isDead = (item: Item): boolean => {
    const sessions = layoutPanes(item.layout).flatMap((pane) =>
      pane.sessionId === undefined ? [] : [pane.sessionId],
    );
    return sessions.length > 0 && sessions.every((id) => exited.has(id));
  };

  const show = (spaceId: Id, itemId: Id, reveal: boolean) => {
    if (reveal) dispatch({ type: "space/activate", spaceId });
    dispatch({ type: "space/set-active-item", spaceId, itemId });
  };

  /** Resolves with a live session of the item, or `undefined` once the item left the space. */
  const waitForSession = (spaceId: Id, itemId: Id): Promise<Id | undefined> =>
    new Promise((resolve) => {
      let off: Unsubscribe | undefined;
      let settled = false;
      const finish = (id: Id | undefined) => {
        if (settled) return;
        settled = true;
        waiters.delete(giveUp);
        off?.();
        resolve(id);
      };
      const giveUp = () => finish(undefined);
      const check = () => {
        const item = getWorkspace().spaces.find((s) => s.id === spaceId)?.items[itemId];
        if (!item) return finish(undefined);
        const [session] = liveSessions(item);
        if (session !== undefined) finish(session);
      };
      waiters.add(giveUp);
      check();
      if (!settled) off = options.subscribe(check);
      if (settled) off?.();
    });

  const open = async (space: Space, action: ProjectAction, reveal: boolean): Promise<RunResult> => {
    let item = findTab(space, action);
    if (item && liveSessions(item).length > 0) {
      show(space.id, item.id, reveal);
      return "focused";
    }
    // A new run begins: a wait for the previous sessions to end is over.
    stopping.delete(keyOf(space.id, action));
    if (item && isDead(item)) {
      dispatch({ type: "item/close", itemId: item.id });
      item = undefined;
    }
    if (!item) {
      const before = new Set(Object.keys(space.items));
      dispatch({
        type: "item/create",
        spaceId: space.id,
        ...(space.defaults.cwd !== undefined ? { cwd: space.defaults.cwd } : {}),
      });
      const created = Object.values(spaceOf(space.id).items).find((i) => !before.has(i.id));
      if (!created) throw new Error("item/create did not add a tab to the space");
      item = created;
      tabs.set(keyOf(space.id, action), item.id);
      dispatch({ type: "item/rename", itemId: item.id, title: action.tab });
    }
    show(space.id, item.id, reveal);
    const session = await waitForSession(space.id, item.id);
    if (session === undefined) return "abandoned";
    await backend.write(Number(session), action.command + ENTER);
    return "started";
  };

  const status = (spaceId: Id, action: ProjectAction): ActionStatus => {
    const key = keyOf(spaceId, action);
    const space = getWorkspace().spaces.find((s) => s.id === spaceId);
    const item = space && findTab(space, action);
    if (!item || liveSessions(item).length === 0) {
      // The sessions are gone, so a wait for them to end is over.
      stopping.delete(key);
      return "idle";
    }
    return stopping.has(key) ? "stopping" : "running";
  };

  const stopNow = async (spaceId: Id, action: ProjectAction): Promise<void> => {
    const item = findTab(spaceOf(spaceId), action);
    if (!item) return;
    for (const session of liveSessions(item)) await backend.kill(Number(session));
  };

  const stop = async (spaceId: Id, action: ProjectAction): Promise<void> => {
    const space = spaceOf(spaceId);
    if (status(spaceId, action) === "stopping") return;
    if (action.stop !== undefined) {
      if (space.defaults.cwd === undefined) {
        throw new Error(`Space "${space.name}" has no folder to run the stop command in`);
      }
      // A failing stop command rejects here, so the sessions stay and the caller reports it.
      await runStop(space.defaults.cwd, action.stop);
      if (action.stopWaits === true) {
        // The command ended with code 0: the shells of the tab are left to end on their own. With
        // no live session left (they ended while the command ran) there is nothing to wait for.
        const waiting = findTab(spaceOf(spaceId), action);
        if (waiting && liveSessions(waiting).length > 0) {
          stopping.add(keyOf(spaceId, action));
          for (const listener of [...exitListeners]) listener();
        }
        return;
      }
    }
    // The stop command ended with code 0 (or there is none): the shells of the tab end too, so the
    // status returns to idle and the next run opens the tab again.
    await stopNow(spaceId, action);
  };

  return {
    run(spaceId, action, runOptions) {
      const key = keyOf(spaceId, action);
      // A second run while the first waits for the session must not type the command twice.
      const inFlight = runs.get(key);
      if (inFlight) return inFlight;
      let started: Promise<RunResult>;
      try {
        started = open(spaceOf(spaceId), action, runOptions?.reveal !== false);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const tracked = started.finally(() => runs.delete(key));
      runs.set(key, tracked);
      return tracked;
    },

    stop,

    stopNow,

    status,

    tabOf(spaceId, action) {
      const space = getWorkspace().spaces.find((s) => s.id === spaceId);
      return space && findTab(space, action)?.id;
    },

    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },

    dispose() {
      offExit();
      exitListeners.clear();
      for (const giveUp of [...waiters]) giveUp();
    },
  };
}

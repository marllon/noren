import type { Action } from "./actions";
import type { ProjectAction } from "./actions-file";
import type { Backend, Unsubscribe } from "./backend";
import { layoutPanes } from "./sessions";
import type { Id, Item, Pane, Space, Workspace } from "./types";

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
   * `command` followed by Enter into a pane of it that runs nothing else: that pane becomes the
   * pane of the action. An action that is already running only has its pane shown. Rejects for an
   * unknown space.
   */
  run(spaceId: Id, action: ProjectAction, options?: RunOptions): Promise<RunResult>;
  /**
   * With a `stop` command: runs it through `runStop` in the folder of the space, and once it ends
   * with code 0 ends the session of the pane of the action too, unless the action has `stopWaits`:
   * then the session stays and the status is `stopping` until it ends on its own (`stopNow` ends
   * it). Without a `stop` command (`stopWaits` or not): ends the session of the pane. The other
   * panes of the tab are left alone. A `stop` command that fails rejects and leaves the session
   * alone. Does nothing when there is nothing to end,
   * and when the action is already `stopping`. Rejects for an unknown space, and for a `stop`
   * command in a space with no folder.
   */
  stop(spaceId: Id, action: ProjectAction): Promise<void>;
  /**
   * Ends the session of the pane of the action at once, without running the `stop` command: what a
   * click on "stop now" does for an action that is `stopping`. Does nothing when there is nothing
   * to end. Rejects for an unknown space.
   */
  stopNow(spaceId: Id, action: ProjectAction): Promise<void>;
  /**
   * `running` while the pane the action's command was typed into exists and its session is alive,
   * or while a terminal pane of any space shows that very command running (so a command started
   * by hand counts); `stopping` when the action waits for that session to end (see `stop`); `idle`
   * otherwise. Closing the pane, or its session ending, makes the action idle even when other
   * panes of the tab live on.
   */
  status(spaceId: Id, action: ProjectAction): ActionStatus;
  /**
   * Id of the tab the action runs in: the tab of its pane while it runs, else the one this
   * executor opened or found for it, else the tab whose title is the action's `tab` name.
   * `undefined` when there is none.
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

/** The command line of a pane and of an action compare equal when only their spacing differs. */
const normalizeCommand = (text: string): string => text.trim().replace(/\s+/g, " ");

/** A terminal pane with a live session, and where it is. */
interface LivePane {
  space: Space;
  item: Item;
  pane: Pane;
  session: Id;
}

/**
 * The tab of an action is the one this executor opened or found for it (`tabs`), else an item of the
 * space whose title is the `tab` name. Following the item id lets the user rename the tab; the
 * title is the way back to it after a restart, when `tabs` is empty. `run` locks the title it gives
 * a new tab, so a program cannot retitle it.
 *
 * The state of an action follows a pane, not the tab. The pane is the one `run` typed the command
 * into (`panes`, kept only in memory), else a terminal pane of any space whose running command is
 * the command of the action. Nothing about it is saved: after a restart the pane is found again by
 * the command it runs.
 */
export function createProjectActions(options: ProjectActionsOptions): ProjectActions {
  const { getWorkspace, dispatch, backend, runStop } = options;
  const tabs = new Map<string, Id>();
  /** The pane each action typed its command into, by id: it moves between tabs, its id stays. */
  const panes = new Map<string, Id>();
  /** Order in which panes were first seen running the command of an action, to find the latest. */
  const seen = new Map<string, number>();
  let seenCount = 0;
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

  const isAlive = (pane: Pane): boolean =>
    pane.type === "terminal" && pane.sessionId !== undefined && !exited.has(pane.sessionId);

  /** Terminal panes of the item with a live session, the focused one first. */
  const livePanes = (item: Item): Pane[] =>
    layoutPanes(item.layout)
      .filter(isAlive)
      .sort((a, b) => Number(b.id === item.focusedPaneId) - Number(a.id === item.focusedPaneId));

  /** A live pane of the item that runs nothing, the focused one first: where a command can be typed. */
  const freePane = (item: Item): Pane | undefined =>
    livePanes(item).find((pane) => pane.runningCommand === undefined);

  /** The pane with this id when its session is alive. The id outlives a move to another tab. */
  const findLive = (paneId: Id): LivePane | undefined => {
    for (const space of getWorkspace().spaces) {
      for (const item of Object.values(space.items)) {
        const pane = layoutPanes(item.layout).find((candidate) => candidate.id === paneId);
        if (!pane) continue;
        return isAlive(pane) && pane.sessionId !== undefined
          ? { space, item, pane, session: pane.sessionId }
          : undefined;
      }
    }
    return undefined;
  };

  /**
   * The pane the action runs in. The pane it typed its command into wins while it lives (closing it
   * or its session ending drops it for good). Without one, a terminal pane of any space whose
   * running command is the command of the action, unless that pane belongs to another action; of
   * several, the one seen running it last.
   */
  const paneOf = (key: string, action: ProjectAction): LivePane | undefined => {
    const own = panes.get(key);
    if (own !== undefined) {
      const found = findLive(own);
      if (found) return found;
      panes.delete(key);
    }
    const claimed = new Set(panes.values());
    const wanted = normalizeCommand(action.command);
    const matches: LivePane[] = [];
    for (const space of getWorkspace().spaces) {
      for (const item of Object.values(space.items)) {
        for (const pane of layoutPanes(item.layout)) {
          const text = pane.runningCommand?.text;
          if (text === undefined || !isAlive(pane) || pane.sessionId === undefined) continue;
          if (claimed.has(pane.id) || normalizeCommand(text) !== wanted) continue;
          matches.push({ space, item, pane, session: pane.sessionId });
        }
      }
    }
    const prefix = `${key}\u0000`;
    const current = new Set(matches.map((match) => prefix + match.pane.id));
    for (const stale of [...seen.keys()]) {
      if (stale.startsWith(prefix) && !current.has(stale)) seen.delete(stale);
    }
    let latest: LivePane | undefined;
    let latestAt = -1;
    for (const match of matches) {
      const id = prefix + match.pane.id;
      let at = seen.get(id);
      if (at === undefined) {
        at = ++seenCount;
        seen.set(id, at);
      }
      if (at > latestAt) {
        latest = match;
        latestAt = at;
      }
    }
    return latest;
  };

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

  /** Resolves with a free pane of the item whose session is alive, or `undefined` once the item left the space. */
  const waitForSession = (spaceId: Id, itemId: Id): Promise<Pane | undefined> =>
    new Promise((resolve) => {
      let off: Unsubscribe | undefined;
      let settled = false;
      const finish = (pane: Pane | undefined) => {
        if (settled) return;
        settled = true;
        waiters.delete(giveUp);
        off?.();
        resolve(pane);
      };
      const giveUp = () => finish(undefined);
      const check = () => {
        const item = getWorkspace().spaces.find((s) => s.id === spaceId)?.items[itemId];
        if (!item) return finish(undefined);
        const pane = freePane(item);
        if (pane) finish(pane);
      };
      waiters.add(giveUp);
      check();
      if (!settled) off = options.subscribe(check);
      if (settled) off?.();
    });

  const open = async (space: Space, action: ProjectAction, reveal: boolean): Promise<RunResult> => {
    const key = keyOf(space.id, action);
    const running = paneOf(key, action);
    if (running) {
      show(running.space.id, running.item.id, reveal);
      dispatch({ type: "pane/focus", itemId: running.item.id, paneId: running.pane.id });
      return "focused";
    }
    // A new run begins: a wait for the previous sessions to end is over.
    stopping.delete(key);
    let item = findTab(space, action);
    if (item && isDead(item)) {
      dispatch({ type: "item/close", itemId: item.id });
      item = undefined;
    }
    // A tab whose live panes all run something else (the action's own pane was closed and the user
    // went on in the others) is no place for the command: a new tab is opened.
    if (item && livePanes(item).length > 0 && !freePane(item)) item = undefined;
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
      // The pane the action opened is called by the action, so a split of several of them tells
      // them apart.
      dispatch({
        type: "pane/rename",
        itemId: item.id,
        paneId: created.focusedPaneId,
        name: action.label,
      });
    }
    show(space.id, item.id, reveal);
    const pane = freePane(item) ?? (await waitForSession(space.id, item.id));
    if (pane === undefined || pane.sessionId === undefined) return "abandoned";
    // The pane the command goes into is the pane of the action from now on.
    panes.set(key, pane.id);
    if (pane.name === undefined) {
      dispatch({ type: "pane/rename", itemId: item.id, paneId: pane.id, name: action.label });
    }
    try {
      await backend.write(Number(pane.sessionId), action.command + ENTER);
    } catch (error) {
      if (panes.get(key) === pane.id) panes.delete(key);
      throw error;
    }
    return "started";
  };

  const status = (spaceId: Id, action: ProjectAction): ActionStatus => {
    const key = keyOf(spaceId, action);
    if (!getWorkspace().spaces.some((s) => s.id === spaceId)) return "idle";
    if (!paneOf(key, action)) {
      // The pane is gone, so a wait for its session to end is over.
      stopping.delete(key);
      return "idle";
    }
    return stopping.has(key) ? "stopping" : "running";
  };

  const stopNow = async (spaceId: Id, action: ProjectAction): Promise<void> => {
    spaceOf(spaceId);
    const found = paneOf(keyOf(spaceId, action), action);
    if (found) await backend.kill(Number(found.session));
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
        // The command ended with code 0: the shell of the pane is left to end on its own. With no
        // live session left (it ended while the command ran) there is nothing to wait for.
        if (paneOf(keyOf(spaceId, action), action)) {
          stopping.add(keyOf(spaceId, action));
          for (const listener of [...exitListeners]) listener();
        }
        return;
      }
    }
    // The stop command ended with code 0 (or there is none): the shell of the pane ends too, so the
    // status returns to idle and the next run starts again.
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
      if (!space) return undefined;
      return paneOf(keyOf(spaceId, action), action)?.item.id ?? findTab(space, action)?.id;
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

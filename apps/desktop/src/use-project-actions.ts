import { createProjectActions, createRunStop, watchActionsFile } from "@noren/model";
import type { ActionStatus, Backend, Id, ProjectAction, ProjectActions, Space } from "@noren/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { confirmAction, isConfirmed, loadConsent, saveConsent } from "./action-consent";
import type { ActionConsent } from "./action-consent";
import { realClock } from "./real-clock";
import type { WorkspaceStore } from "./workspace-store";

/** An action waiting for the user to confirm its first run in a space. */
export interface PendingRun {
  spaceId: Id;
  action: ProjectAction;
}

export interface ProjectActionsUi {
  /** The actions of the active space's file; empty without a folder, a file or a valid one. */
  actions: readonly ProjectAction[];
  statusOf(action: ProjectAction): ActionStatus;
  /** The same, for the action of any space (the Favorites bar holds actions of spaces that are not on screen). */
  statusIn(spaceId: Id, action: ProjectAction): ActionStatus;
  /** True while a run or a stop of the action is still going on. */
  isBusy(action: ProjectAction): boolean;
  /** The action the tab belongs to, if the tab is one an action runs in. */
  actionOfTab(itemId: Id): ProjectAction | undefined;
  /** Runs the action, after asking when this exact command was never confirmed in the space. */
  run(action: ProjectAction): void;
  /**
   * The same as `run`, for any space (a link can name a space that is not on screen yet). The
   * action must come from the file of that space.
   */
  runIn(spaceId: Id, action: ProjectAction): void;
  stop(action: ProjectAction): void;
  /** Set while the confirmation dialog is open. */
  pending: PendingRun | null;
  confirmPending(): void;
  cancelPending(): void;
}

interface FileRead {
  /** Space and folder the state is about, so a state of another space is never shown. */
  key: string;
  actions: readonly ProjectAction[];
}

const readKey = (spaceId: Id, cwd: string) => `${spaceId}\u0000${cwd}`;
const busyKey = (spaceId: Id, action: ProjectAction) => `${spaceId}\u0000${action.id}`;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The project actions of the active space: watches its `.noren/actions.json` (only the active
 * folder), runs and stops actions through the executor and asks before the first run of each.
 * A failed run or stop is reported with `onError`. A file that is missing, unreadable or invalid
 * simply has no actions.
 */
export function useProjectActions(
  store: WorkspaceStore,
  backend: Backend,
  space: Space,
  onError: (message: string) => void,
): ProjectActionsUi {
  const [executor, setExecutor] = useState<ProjectActions | undefined>(undefined);
  // The same executor, readable before the render that follows its creation (a link can arrive then).
  const executorRef = useRef<ProjectActions | undefined>(undefined);
  const [fileRead, setFileRead] = useState<FileRead | undefined>(undefined);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<PendingRun | null>(null);
  const [, setTick] = useState(0);
  const consent = useRef<ActionConsent>(loadConsent(storage()));
  const reportError = useRef(onError);
  reportError.current = onError;

  // One executor for the store; a session that ends changes a status without touching the workspace.
  useEffect(() => {
    const created = createProjectActions({
      getWorkspace: () => store.getState().workspace,
      subscribe: (listener) => store.subscribe(listener),
      dispatch: (action) => store.getState().dispatch(action),
      backend,
      runStop: createRunStop(backend),
    });
    const offExit = created.onExit(() => setTick((tick) => tick + 1));
    executorRef.current = created;
    setExecutor(created);
    return () => {
      offExit();
      created.dispose();
      executorRef.current = undefined;
      setExecutor(undefined);
    };
  }, [store, backend]);

  // Only the folder of the active space is watched, and the watcher dies with the space or folder.
  const spaceId = space.id;
  const cwd = space.defaults.cwd;
  useEffect(() => {
    if (cwd === undefined) return undefined;
    const key = readKey(spaceId, cwd);
    const watcher = watchActionsFile({
      backend,
      cwd,
      clock: realClock,
      onChange: (state) =>
        setFileRead({ key, actions: state.status === "ok" ? state.actions : [] }),
    });
    return () => watcher.dispose();
  }, [backend, spaceId, cwd]);

  const actions: readonly ProjectAction[] =
    cwd !== undefined && fileRead?.key === readKey(spaceId, cwd) ? fileRead.actions : [];

  const track = useCallback((key: string, work: Promise<unknown>) => {
    setBusy((current) => new Set(current).add(key));
    work
      .catch((error: unknown) =>
        reportError.current(error instanceof Error ? error.message : String(error)),
      )
      .finally(() =>
        setBusy((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        }),
      );
  }, []);

  const start = useCallback(
    (id: Id, action: ProjectAction) => {
      const current = executorRef.current;
      if (current) track(busyKey(id, action), current.run(id, action));
    },
    [track],
  );

  const runIn = useCallback(
    (id: Id, action: ProjectAction) => {
      if (isConfirmed(consent.current, id, action)) start(id, action);
      else setPending({ spaceId: id, action });
    },
    [start],
  );

  return {
    actions,
    statusOf: (action) => executor?.status(spaceId, action) ?? "idle",
    statusIn: (id, action) => executor?.status(id, action) ?? "idle",
    isBusy: (action) => busy.has(busyKey(spaceId, action)),
    actionOfTab: (itemId) => actions.find((action) => executor?.tabOf(spaceId, action) === itemId),
    run: (action) => runIn(spaceId, action),
    runIn,
    stop: (action) => {
      if (executor) track(busyKey(spaceId, action), executor.stop(spaceId, action));
    },
    pending,
    confirmPending: () => {
      if (!pending) return;
      consent.current = confirmAction(consent.current, pending.spaceId, pending.action);
      saveConsent(storage(), consent.current);
      setPending(null);
      start(pending.spaceId, pending.action);
    },
    cancelPending: () => setPending(null),
  };
}

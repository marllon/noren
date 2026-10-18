import type { Backend, CreateSessionOptions } from "./backend";
import { createDefaultWorkspace } from "./default-workspace";
import type { DefaultWorkspaceOptions } from "./default-workspace";
import { DEFAULT_PROFILE_ID } from "./factories";
import type { InvariantOptions } from "./invariants";
import { layoutPanes } from "./sessions";
import { parseState, workspaceWithoutSessions } from "./state";
import type { Id, LayoutNode, Pane, Space, Workspace } from "./types";

export interface RestoreOptions extends InvariantOptions {
  /** Size of the new sessions. The view fits them to the real size once it shows. Default 80x24. */
  cols?: number;
  rows?: number;
  /** Id source and clock for the default workspace, when the saved state cannot be used. */
  defaults?: DefaultWorkspaceOptions;
}

export interface RestoreResult {
  /** Every terminal pane holds the id of a live session, except those listed in `failedPaneIds`. */
  workspace: Workspace;
  /**
   * `saved`: the file was valid. `fresh`: there was no file. `recovered`: the file was unusable,
   * so it went to quarantine and the default workspace took its place.
   */
  source: "saved" | "fresh" | "recovered";
  /** Why the saved state was rejected (`recovered` only). */
  reason?: string;
  /** Path of the quarantined copy; absent when the copy could not be made. */
  quarantinePath?: string;
  /** Version found in a valid file that needed migrations. */
  migratedFrom?: number;
  /** Panes whose shell could not start even without cwd and profile; they have no session. */
  failedPaneIds: Id[];
}

type RestoreBackend = Pick<Backend, "loadState" | "quarantineState" | "createSession">;

/**
 * Loads `state.json`, migrates and validates it, and starts one session per terminal pane in the
 * folder saved with the pane. Unusable content (broken JSON, wrong shape, broken invariants,
 * unknown version) is quarantined and the default workspace is used instead. A failure to read
 * the file is not handled here: it rejects, and the file is left alone.
 */
export async function restoreWorkspace(
  backend: RestoreBackend,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const text = await backend.loadState();
  let source: RestoreResult["source"] = "fresh";
  let base: Workspace;
  const extra: Pick<RestoreResult, "reason" | "quarantinePath" | "migratedFrom"> = {};

  if (text === null) {
    base = createDefaultWorkspace(options.defaults);
  } else {
    const parsed = parseState(text, options);
    if (parsed.ok) {
      source = "saved";
      base = workspaceWithoutSessions(parsed.workspace);
      if (parsed.migratedFrom !== undefined) extra.migratedFrom = parsed.migratedFrom;
    } else {
      source = "recovered";
      extra.reason = parsed.reason;
      try {
        extra.quarantinePath = await backend.quarantineState();
      } catch {
        // The copy is a courtesy; the app still has to start.
      }
      base = createDefaultWorkspace(options.defaults);
    }
  }

  const { workspace, failedPaneIds } = await startSessions(base, backend, options);
  return { workspace, source, ...extra, failedPaneIds };
}

/** Starts a shell for every pane of the spaces' items and returns the workspace holding them. */
async function startSessions(
  ws: Workspace,
  backend: Pick<Backend, "createSession">,
  options: RestoreOptions,
): Promise<{ workspace: Workspace; failedPaneIds: Id[] }> {
  const started = new Map<Id, Pane>();
  const failedPaneIds: Id[] = [];
  for (const space of ws.spaces) {
    for (const item of Object.values(space.items)) {
      for (const pane of layoutPanes(item.layout)) {
        const next = await startPane(pane, space, backend, options);
        if (next.sessionId === undefined) failedPaneIds.push(pane.id);
        started.set(pane.id, next);
      }
    }
  }
  const replace = (layout: LayoutNode): LayoutNode =>
    layout.kind === "split"
      ? { ...layout, children: layout.children.map(replace) }
      : { kind: "pane", pane: started.get(layout.pane.id) ?? layout.pane };
  return {
    workspace: {
      ...ws,
      spaces: ws.spaces.map((space) => ({
        ...space,
        items: Object.fromEntries(
          Object.entries(space.items).map(([id, item]) => [
            id,
            { ...item, layout: replace(item.layout) },
          ]),
        ),
      })),
    },
    failedPaneIds,
  };
}

/**
 * New shell for one pane: its own profile and cwd (the space's cwd when it has none) and the
 * space's env. If that fails (folder gone, profile unknown), a second try uses the backend's
 * defaults; a pane that still fails keeps no session and shows as exited.
 */
async function startPane(
  pane: Pane,
  space: Space,
  backend: Pick<Backend, "createSession">,
  options: RestoreOptions,
): Promise<Pane> {
  const size = { cols: options.cols ?? 80, rows: options.rows ?? 24 };
  const cwd = pane.cwd ?? space.defaults.cwd;
  const wanted: CreateSessionOptions = {
    ...size,
    ...(pane.profileId !== DEFAULT_PROFILE_ID ? { profileId: pane.profileId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(Object.keys(space.defaults.env).length > 0 ? { env: space.defaults.env } : {}),
  };
  // The old session, exit code and (for a pane that failed) cwd belong to a process that is gone.
  const fresh: Pane = { ...pane, status: "idle" };
  delete fresh.sessionId;
  delete fresh.exitCode;

  for (const attempt of [wanted, size]) {
    try {
      const id = await backend.createSession(attempt);
      const started: Pane = { ...fresh, sessionId: String(id) };
      if (attempt === size) delete started.cwd;
      return started;
    } catch {
      // Try the next set of options.
    }
  }
  return { ...fresh, status: "exited" };
}

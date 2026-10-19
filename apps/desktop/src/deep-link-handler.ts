import {
  ACTIONS_FILE_PATH,
  findSpaceByFolder,
  parseActionsFile,
  parseDeepLink,
  spaceNameForFolder,
} from "@noren/model";
import type { Backend, DeepLink, Id, ProjectAction } from "@noren/model";
import type { WorkspaceStore } from "./workspace-store";

export interface DeepLinkHost {
  store: WorkspaceStore;
  backend: Pick<Backend, "readActionsFile">;
  /**
   * Runs the action in the space through the same path as the Start button: it asks first when
   * this exact command was never confirmed in that space.
   */
  runAction(spaceId: Id, action: ProjectAction): void;
  /** Shows a short message to the user (the notice that already reports a refused split). */
  notify(text: string): void;
}

/** Takes the raw text of a `noren://` link and applies it. Never rejects: problems become notices. */
export type DeepLinkHandler = (url: string) => Promise<void>;

/** Longest piece of the link echoed back in a notice. */
const SHOWN_MAX = 80;

const shown = (text: string): string =>
  text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX)}…` : text;

/**
 * Applies `noren://` links to the workspace:
 *
 * - `open` shows the space whose default folder is the path, or makes one there.
 * - `action` finds the same space, reads its `.noren/actions.json` and runs the action named by
 *   the `id` through `runAction` (and so through the first-run confirmation). The link only ever
 *   names an action; the command is the one written in the file.
 *
 * A link that is refused, an action the file does not declare, a missing or invalid file: a notice,
 * and nothing changes and nothing runs (a space is only made once the action is known to exist).
 */
export function createDeepLinkHandler(host: DeepLinkHost): DeepLinkHandler {
  const { store, backend, runAction, notify } = host;

  const spaceOf = (path: string) => findSpaceByFolder(store.getState().workspace, path);

  /** Shows the space for the folder, making it when there is none. Returns its id. */
  const focusSpace = (path: string): Id | undefined => {
    const existing = spaceOf(path);
    if (existing) {
      store.getState().activateSpace(existing.id);
      return existing.id;
    }
    store.getState().createSpace({ name: spaceNameForFolder(path), cwd: path });
    return spaceOf(path)?.id;
  };

  const apply = async (link: DeepLink): Promise<void> => {
    if (link.kind === "open") {
      if (focusSpace(link.path) === undefined) notify(`Could not open ${shown(link.path)}`);
      return;
    }
    // The file of the folder the space already has, so the link and the header read the same one.
    const folder = spaceOf(link.path)?.defaults.cwd ?? link.path;
    let text: string | null;
    try {
      text = await backend.readActionsFile(folder);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify(`Could not read ${ACTIONS_FILE_PATH} in ${shown(folder)}: ${reason}`);
      return;
    }
    if (text === null) {
      notify(`There is no ${ACTIONS_FILE_PATH} in ${shown(folder)}`);
      return;
    }
    const parsed = parseActionsFile(text);
    if (!parsed.ok) {
      notify(`${ACTIONS_FILE_PATH} in ${shown(folder)} is invalid: ${parsed.reason}`);
      return;
    }
    const action = parsed.actions.find((candidate) => candidate.id === link.id);
    if (!action) {
      notify(`There is no action "${shown(link.id)}" in ${shown(folder)}`);
      return;
    }
    const spaceId = focusSpace(link.path);
    if (spaceId === undefined) {
      notify(`Could not open ${shown(link.path)}`);
      return;
    }
    runAction(spaceId, action);
  };

  return async (url) => {
    const parsed = parseDeepLink(url);
    if (!parsed.ok) {
      notify(`Link refused: ${parsed.reason}`);
      return;
    }
    try {
      await apply(parsed.link);
    } catch (error) {
      notify(`The link failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

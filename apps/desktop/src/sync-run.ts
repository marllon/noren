import { closePushDecision, parseUserThemes } from "@noren/model";
import type { Backend, ClosePushSkip, ClosePushStatus, Clock, SyncMethod } from "@noren/model";
import { t } from "./i18n";
import { setModFiles } from "./mods-store";
import {
  failureMessage,
  notConnectedMessage,
  pullMessage,
  pulledKinds,
  pushMessage,
  reasonOf,
} from "./settings-sync";
import type { SyncMessage } from "./settings-sync";
import {
  importNotes,
  importSpaceFiles,
  spaceStepFailure,
  writeNotes,
  writeSpaceFiles,
} from "./space-sync";
import type { SpaceSyncBackend, SpaceSyncPort } from "./space-sync";
import { setUserThemes } from "./user-themes-store";

// Running a pull or a push for the Sync section and for the palette commands (NOR-F19-01b): asks
// the backend, turns the answer into a sentence and, after a pull that wrote themes or mods, reads
// them again. The method (NOR-F19-02b) is `sync.method` of the settings: git, or a gist; every
// step here asks the calls of the method chosen, and nothing else differs between the two. With the spaces of the window (NOR-F19-01c) a push first writes every space as a file,
// and a pull first writes the spaces that already have one and, once it is done, makes spaces of the
// files that came in. Never rejects: whatever went wrong is the sentence.

export type SyncBackend = Pick<
  Backend,
  | "syncStatus"
  | "syncPull"
  | "syncPush"
  | "syncGistStatus"
  | "syncGistPull"
  | "syncGistPush"
  | "listUserThemes"
  | "listMods"
> &
  SpaceSyncBackend;

/** The calls a push needs, of either method. */
type PushBackend = Pick<Backend, "syncPush" | "syncGistPush"> & SpaceSyncBackend;

/** The pull of the method: the same answer from either. */
const pullOf = (backend: Pick<Backend, "syncPull" | "syncGistPull">, method: SyncMethod) =>
  method === "gist" ? backend.syncGistPull() : backend.syncPull();

/** The push of the method: the same answer from either. */
const pushOf = (backend: Pick<Backend, "syncPush" | "syncGistPush">, method: SyncMethod) =>
  method === "gist" ? backend.syncGistPush() : backend.syncPush();

/**
 * Reads again what a pull wrote. `config.jsonc` and the mods are watched by the backend and the
 * app follows them by itself, but nothing watches `themes/`, so the list of themes is read the way
 * the gallery does after an install. Mods are set from a fresh list too, so the screen is right
 * when the pull ends (a list equal to the one held changes nothing).
 */
export async function reloadPulled(
  backend: Pick<Backend, "listUserThemes" | "listMods">,
  files: readonly string[],
): Promise<void> {
  const kinds = pulledKinds(files);
  if (kinds.themes) setUserThemes(parseUserThemes(await backend.listUserThemes()).themes);
  if (kinds.mods) setModFiles(await backend.listMods());
}

/**
 * Pulls. A conflict is a warning that says nothing changed; a failure carries the text of the
 * backend. With `spaces`, the spaces that already have a file are written first (what was changed
 * here is one side of the merge), and after a pull that does not conflict the files in the folder
 * that are new or changed become spaces; the sentence says how many.
 */
export async function runPull(
  backend: SyncBackend,
  spaces?: SpaceSyncPort,
  method: SyncMethod = "git",
): Promise<SyncMessage> {
  if (spaces !== undefined) {
    try {
      await writeSpaceFiles(backend, spaces, { linkedOnly: true });
    } catch (error) {
      return failureMessage("pull", error);
    }
  }
  let result;
  try {
    result = await pullOf(backend, method);
  } catch (error) {
    return failureMessage("pull", error);
  }
  const message = pullMessage(result, method);
  if (result.kind === "conflict") return message;
  if (result.kind === "updated") {
    try {
      await reloadPulled(backend, result.files);
    } catch (error) {
      return {
        text: `${message.text} ${t("settings.syncReloadFailed", { reason: reasonOf(error) })}`,
        alert: true,
      };
    }
  }
  if (spaces === undefined) return message;
  let imported;
  try {
    imported = await importSpaceFiles(backend, spaces);
  } catch (error) {
    return { text: `${message.text} ${spaceStepFailure(error)}`, alert: true };
  }
  const { notes, changed } = importNotes(imported);
  if (notes.length === 0) return message;
  // Nothing came but a space was made from a file that was already here: do not also say that
  // nothing changed.
  const parts = result.kind === "up_to_date" && changed ? notes : [message.text, ...notes];
  return {
    text: parts.join(" "),
    alert: message.alert || imported.ignored.length > 0 || imported.failed.length > 0,
  };
}

/**
 * Pushes. With `spaces`, every space is written as a file in the config folder first, so the push
 * carries them; a space that could not be written, or whose file left something out because it
 * looked like a secret, is named after the answer. A refusal ("pull first") or a failure carries
 * the text of the backend.
 */
export async function runPush(
  backend: PushBackend,
  spaces?: SpaceSyncPort,
  method: SyncMethod = "git",
): Promise<SyncMessage> {
  let notes: string[] = [];
  if (spaces !== undefined) {
    try {
      notes = writeNotes(await writeSpaceFiles(backend, spaces, { linkedOnly: false }));
    } catch (error) {
      return failureMessage("push", error);
    }
  }
  try {
    const message = pushMessage(await pushOf(backend, method));
    return notes.length === 0 ? message : { text: [message.text, ...notes].join(" "), alert: true };
  } catch (error) {
    return failureMessage("push", error);
  }
}

/** What the push when the app closes did (NOR-F19-01d). */
export type PushOnCloseOutcome =
  | { kind: "skipped"; reason: ClosePushSkip }
  | { kind: "pushed"; files: number }
  | { kind: "failed"; reason: string }
  | { kind: "timeout" };

export interface PushOnCloseDeps {
  backend: Pick<Backend, "syncStatus" | "syncPush" | "syncGistStatus" | "syncGistPush"> &
    SpaceSyncBackend;
  /** `syncMethodOf` of the settings now, read when the close happens; none: git. */
  method?: (() => SyncMethod) | undefined;
  /** The window's spaces, written as files before the push like the Push of the screen; none: no spaces. */
  spaces: SpaceSyncPort | undefined;
  /** `pushOnCloseAllowed` of the settings now, read when the close happens. */
  enabled: () => boolean;
  clock: Pick<Clock, "setTimer">;
  /** The longest the whole of it runs; past it the push is given up and the close goes on. */
  limitMs: number;
  /** Where a failure or a given-up push is recorded. */
  log: (message: string) => void;
}

/**
 * The push of `sync.pushOnClose`, run while the app closes (NOR-F19-01d): nothing when the option is
 * off, when no remote is connected or when nothing waits (`closePushDecision`); otherwise the spaces
 * are written as files (the same step as the Push of the screen) and the push is made. Never
 * rejects, and never runs past `limitMs`: an error or a push that is too slow is recorded with `log`
 * and the close goes on, so a remote that is down never keeps the window open. A push that was given
 * up on may still finish in the background until the app is gone; git leaves the remote as it was
 * when it is cut short.
 */
export async function runPushOnClose(deps: PushOnCloseDeps): Promise<PushOnCloseOutcome> {
  const attempt = async (): Promise<PushOnCloseOutcome> => {
    if (!deps.enabled()) return { kind: "skipped", reason: "off" };
    const method = deps.method?.() ?? "git";
    const status: ClosePushStatus =
      method === "gist" ? await deps.backend.syncGistStatus() : await deps.backend.syncStatus();
    if (!status.connected) return { kind: "skipped", reason: "no-remote" };
    let spaceFilesWritten = 0;
    if (deps.spaces !== undefined) {
      const written = await writeSpaceFiles(deps.backend, deps.spaces, { linkedOnly: false });
      spaceFilesWritten = written.written.length;
      for (const note of writeNotes(written)) deps.log(`push on close: ${note}`);
    }
    const decision = closePushDecision({ enabled: true, status, spaceFilesWritten });
    if (decision.action === "skip") return { kind: "skipped", reason: decision.reason };
    const result = await pushOf(deps.backend, method);
    if (result.committed && !result.pushed) {
      return { kind: "failed", reason: "the files were committed but not sent" };
    }
    return { kind: "pushed", files: result.files.length };
  };
  let cancel: (() => void) | undefined;
  const gaveUp = new Promise<PushOnCloseOutcome>((resolve) => {
    cancel = deps.clock.setTimer(() => resolve({ kind: "timeout" }), deps.limitMs);
  });
  const attempted = attempt().catch((error: unknown): PushOnCloseOutcome => ({
    kind: "failed",
    reason: reasonOf(error),
  }));
  const outcome = await Promise.race([attempted, gaveUp]);
  cancel?.();
  if (outcome.kind === "failed") deps.log(`push on close failed: ${outcome.reason}`);
  if (outcome.kind === "timeout") {
    deps.log(`push on close given up after ${deps.limitMs} ms`);
  }
  return outcome;
}

/**
 * The palette command: a pull or a push for the remote or the gist already connected, by the method.
 * With none connected it says where to connect (and, for a gist, that a token is missing) and asks
 * for nothing; the notice is the sentence.
 */
export async function runSyncCommand(
  backend: SyncBackend,
  command: "pull" | "push",
  spaces?: SpaceSyncPort,
  method: SyncMethod = "git",
): Promise<SyncMessage> {
  try {
    if (method === "gist") {
      const status = await backend.syncGistStatus();
      if (!status.hasToken) return notConnectedMessage("gist", false);
      if (!status.connected) return notConnectedMessage("gist");
    } else if (!(await backend.syncStatus()).connected) {
      return notConnectedMessage("git");
    }
  } catch (error) {
    return failureMessage("status", error);
  }
  return command === "pull" ? runPull(backend, spaces, method) : runPush(backend, spaces, method);
}

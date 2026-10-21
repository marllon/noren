import { parseUserThemes } from "@noren/model";
import type { Backend } from "@noren/model";
import { t } from "./i18n";
import { setModFiles } from "./mods-store";
import { failureMessage, pullMessage, pulledKinds, pushMessage, reasonOf } from "./settings-sync";
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
// them again. With the spaces of the window (NOR-F19-01c) a push first writes every space as a file,
// and a pull first writes the spaces that already have one and, once it is done, makes spaces of the
// files that came in. Never rejects: whatever went wrong is the sentence.

export type SyncBackend = Pick<
  Backend,
  "syncStatus" | "syncPull" | "syncPush" | "listUserThemes" | "listMods"
> &
  SpaceSyncBackend;

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
export async function runPull(backend: SyncBackend, spaces?: SpaceSyncPort): Promise<SyncMessage> {
  if (spaces !== undefined) {
    try {
      await writeSpaceFiles(backend, spaces, { linkedOnly: true });
    } catch (error) {
      return failureMessage("pull", error);
    }
  }
  let result;
  try {
    result = await backend.syncPull();
  } catch (error) {
    return failureMessage("pull", error);
  }
  const message = pullMessage(result);
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
  backend: Pick<Backend, "syncPush"> & SpaceSyncBackend,
  spaces?: SpaceSyncPort,
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
    const message = pushMessage(await backend.syncPush());
    return notes.length === 0 ? message : { text: [message.text, ...notes].join(" "), alert: true };
  } catch (error) {
    return failureMessage("push", error);
  }
}

/**
 * The palette command: a pull or a push for the remote already connected. With no remote it says
 * where to connect and asks for nothing; the notice is the sentence.
 */
export async function runSyncCommand(
  backend: SyncBackend,
  command: "pull" | "push",
  spaces?: SpaceSyncPort,
): Promise<SyncMessage> {
  try {
    const status = await backend.syncStatus();
    if (!status.connected) return { text: t("settings.syncNoRemote"), alert: true };
  } catch (error) {
    return failureMessage("status", error);
  }
  return command === "pull" ? runPull(backend, spaces) : runPush(backend, spaces);
}

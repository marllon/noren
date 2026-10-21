import { parseUserThemes } from "@noren/model";
import type { Backend } from "@noren/model";
import { t } from "./i18n";
import { setModFiles } from "./mods-store";
import { failureMessage, pullMessage, pulledKinds, pushMessage, reasonOf } from "./settings-sync";
import type { SyncMessage } from "./settings-sync";
import { setUserThemes } from "./user-themes-store";

// Running a pull or a push for the Sync section and for the palette commands (NOR-F19-01b): asks
// the backend, turns the answer into a sentence and, after a pull that wrote themes or mods, reads
// them again. Never rejects: whatever went wrong is the sentence.

export type SyncBackend = Pick<
  Backend,
  "syncStatus" | "syncPull" | "syncPush" | "listUserThemes" | "listMods"
>;

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

/** Pulls. A conflict is a warning that says nothing changed; a failure carries the text of the backend. */
export async function runPull(backend: SyncBackend): Promise<SyncMessage> {
  let result;
  try {
    result = await backend.syncPull();
  } catch (error) {
    return failureMessage("pull", error);
  }
  const message = pullMessage(result);
  if (result.kind !== "updated") return message;
  try {
    await reloadPulled(backend, result.files);
  } catch (error) {
    return {
      text: `${message.text} ${t("settings.syncReloadFailed", { reason: reasonOf(error) })}`,
      alert: true,
    };
  }
  return message;
}

/** Pushes. A refusal ("pull first") or a failure carries the text of the backend. */
export async function runPush(backend: Pick<Backend, "syncPush">): Promise<SyncMessage> {
  try {
    return pushMessage(await backend.syncPush());
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
): Promise<SyncMessage> {
  try {
    const status = await backend.syncStatus();
    if (!status.connected) return { text: t("settings.syncNoRemote"), alert: true };
  } catch (error) {
    return failureMessage("status", error);
  }
  return command === "pull" ? runPull(backend) : runPush(backend);
}

import {
  SPACE_FILE_EXTENSION,
  SPACE_FILE_LIMITS,
  parseSpaceFile,
  planProfiles,
} from "@noren/model";
import type {
  ConfigManager,
  ExportRemovals,
  ProfileConflict,
  ProfilePlan,
  SpaceFile,
  UserProfile,
} from "@noren/model";
import { t } from "./i18n";
import type { PickedFile } from "./scheme-import";

// Exporting and importing a space through a file (NOR-F18-03b). The pure core is in
// `@noren/model` (`space-file.ts`); this is what the window adds around it: the name of the file
// that is saved, the sentences that say what was left out, reading a picked file into a plan, and
// writing the profiles the plan adds to `config.jsonc` before the space is made. Choosing the file
// and saving it are in `App.tsx`. Nothing here touches the DOM.

/** Characters a file name cannot hold on the systems Noren runs on, and control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_IN_NAME = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Names Windows will not give to a file (with or without an extension). */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The most characters of the space's name used in the name of the file. */
const MAX_NAME_CHARS = 100;

/**
 * The name of the file saved for a space: its name, with what a file name cannot hold replaced, then
 * `.noren-space.json`. A name with nothing usable in it gives `space.noren-space.json`.
 */
export function exportFileName(spaceName: string): string {
  const cleaned = spaceName
    .replace(UNSAFE_IN_NAME, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    // A name may not end in a dot or a space on Windows.
    .replace(/[. ]+$/, "");
  const base = cleaned === "" || RESERVED_NAME.test(cleaned) ? "space" : cleaned;
  return `${base}${SPACE_FILE_EXTENSION}`;
}

/** What the export took out, in one phrase, or `undefined` when it took nothing out. */
function removedList(removed: ExportRemovals): string | undefined {
  const parts: string[] = [];
  if (removed.env.length > 0) {
    parts.push(t("spaceFile.secretEnv", { names: removed.env.join(", ") }));
  }
  if (removed.commands.length > 0) {
    parts.push(t("spaceFile.secretCommands", { count: removed.commands.length }));
  }
  if (removed.profiles.length > 0) {
    parts.push(t("spaceFile.secretProfiles", { ids: removed.profiles.join(", ") }));
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

/** The sentence shown once the file is handed to the system: where it went and what stayed out. */
export function exportNotice(spaceName: string, fileName: string, removed: ExportRemovals): string {
  const main = t("spaceFile.exported", { name: spaceName, file: fileName });
  const list = removedList(removed);
  return list === undefined ? main : `${main} ${t("spaceFile.secretsLeftOut", { list })}`;
}

export function exportFailureNotice(spaceName: string, reason: string): string {
  return t("spaceFile.exportFailed", { name: spaceName, reason });
}

/** What importing a file would do, once it has been read and checked. */
export interface SpaceImportPlan {
  fileName: string;
  file: SpaceFile;
  profiles: ProfilePlan;
}

export type SpaceImportRead = { ok: true; plan: SpaceImportPlan } | { ok: false; message: string };

function failure(file: PickedFile, reason: string): SpaceImportRead {
  return { ok: false, message: t("spaceFile.failed", { file: file.name, reason }) };
}

/**
 * Reads a picked file as the file of a space and plans its profiles against the ones the user has
 * (`existing`) and every id the window already knows (`takenIds`). Nothing is written. A file that
 * is not a space file gives the sentence for the notice, with the short reason. Never rejects.
 */
export async function readSpaceFile(
  file: PickedFile,
  existing: readonly UserProfile[],
  takenIds: Iterable<string>,
): Promise<SpaceImportRead> {
  if (file.size > SPACE_FILE_LIMITS.bytes) return failure(file, t("spaceFile.tooLarge"));
  let text: string;
  try {
    text = await file.text();
  } catch {
    return failure(file, t("spaceFile.unreadable"));
  }
  const parsed = parseSpaceFile(text);
  if (!parsed.ok) return failure(file, parsed.error);
  return {
    ok: true,
    plan: {
      fileName: file.name,
      file: parsed.file,
      profiles: planProfiles(parsed.file, existing, takenIds),
    },
  };
}

function conflictText(conflict: ProfileConflict): string {
  return t(
    conflict.reason === "taken" ? "spaceFile.conflictTaken" : "spaceFile.conflictDifferent",
    { name: conflict.name, id: conflict.id },
  );
}

/** The sentence shown once the space is made: the profiles added and the ones left out. */
export function importNotice(spaceName: string, profiles: ProfilePlan): string {
  const parts = [t("spaceFile.imported", { name: spaceName })];
  if (profiles.add.length > 0) {
    const names = profiles.add.map((profile) => `"${profile.name}"`).join(", ");
    parts.push(t("spaceFile.profilesAdded", { names }));
  }
  if (profiles.conflicts.length > 0) {
    parts.push(
      t("spaceFile.profilesLeftOut", { list: profiles.conflicts.map(conflictText).join("; ") }),
    );
  }
  return parts.join(" ");
}

export interface SpaceImportDeps {
  /** Where the new profiles are written: `profiles` of `config.jsonc`, comments kept. */
  settings: Pick<ConfigManager, "update">;
  /** Hands the profiles of the settings to the backend, so a pane can start with one at once. */
  syncProfiles?: () => Promise<void>;
  /** Makes the space (the `space/import` action). */
  importSpace(file: SpaceFile): void;
}

/**
 * Does what the plan says: the new profiles are appended to `profiles` in `config.jsonc`, then the
 * space is made. Profiles the user already has are not touched, and the ones in conflict are not
 * added. When the profiles cannot be written nothing is imported. Resolves to the sentence for the
 * notice. Never rejects.
 */
export async function commitSpaceImport(
  plan: SpaceImportPlan,
  deps: SpaceImportDeps,
): Promise<string> {
  if (plan.profiles.add.length > 0) {
    const result = await deps.settings.update([{ path: ["profiles"], append: plan.profiles.add }]);
    if (!result.ok) return t("spaceFile.notSaved", { reason: result.message });
    try {
      await deps.syncProfiles?.();
    } catch {
      // The backend takes them on the next change of the file; the space is made all the same.
    }
  }
  deps.importSpace(plan.file);
  return importNotice(plan.file.space.name, plan.profiles);
}

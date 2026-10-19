import { commandLineOf, importProfiles, userProfilesFromImported } from "@noren/model";
import type { Config, ConfigManager, SkippedProfile, UserProfile } from "@noren/model";
import { t } from "./i18n";
import type { PickedFile } from "./scheme-import";

// Importing the shell profiles of another program's settings file (JSON with comments) in two
// steps: read the file and tell what would be added, then, once the person agrees, add those
// profiles to `profiles` in `config.jsonc`. Reading starts nothing and writes nothing; adding writes
// the settings file only (its comments stay) and starts no session and runs no command. The
// wording speaks of file formats, never of a product.

/** A file bigger than this is not a settings file (the real ones are a few kilobytes). */
export const MAX_PROFILE_FILE_BYTES = 1_000_000;

/** What importing a file would add, shown to the person before anything is written. */
export interface ProfileImportPlan {
  fileName: string;
  /** The profiles that would be added, with the ids they would get. */
  profiles: UserProfile[];
  /** Profiles the file marks as hidden, which are ignored. */
  hidden: number;
  /** Profiles that were read but cannot be imported, with the reason. */
  skipped: SkippedProfile[];
  /** Other things the reader had to say (an entry that is not an object, too many entries). */
  warnings: string[];
}

export type ProfileImportRead =
  { ok: true; plan: ProfileImportPlan } | { ok: false; message: string };

/** Every profile id the window knows: the machine's shells and the user's, from the list and the file. */
export function takenProfileIds(config: Config, listed: readonly { id: string }[]): string[] {
  return [...listed.map((profile) => profile.id), ...(config.profiles ?? []).map((p) => p.id)];
}

function failure(file: PickedFile, reason: string): ProfileImportRead {
  return { ok: false, message: t("profileImport.failed", { file: file.name, reason }) };
}

/** `1 profile`, `3 profiles`: the count with the word for it, in the language in force. */
export function profileCount(count: number): string {
  return count === 1 ? t("count.profile.one") : t("count.profile.other", { count });
}

/**
 * Reads the profiles of `file`. Nothing is written and nothing is started. The answer is the plan,
 * or the sentence for the notice: the file is not a settings file, or there is nothing in it that
 * could be imported (every profile hidden or left out). Never rejects.
 */
export async function readProfileFile(
  file: PickedFile,
  takenIds: Iterable<string>,
): Promise<ProfileImportRead> {
  if (file.size > MAX_PROFILE_FILE_BYTES) {
    return failure(file, t("profileImport.tooLarge"));
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return failure(file, t("profileImport.unreadable"));
  }
  const read = importProfiles(text);
  if (!read.ok) {
    const more = read.errors.length - 1;
    const first = read.errors[0] ?? t("profileImport.notSettings");
    return failure(file, more > 0 ? t("profileImport.moreErrors", { first, count: more }) : first);
  }
  const { profiles, skipped } = userProfilesFromImported(read.profiles, takenIds);
  if (profiles.length === 0) {
    const why = [
      read.hidden > 0
        ? read.hidden === 1
          ? t("profileImport.areHidden.one")
          : t("profileImport.areHidden.other", { count: read.hidden })
        : "",
      skipped.length > 0
        ? t(
            skipped.length === 1
              ? "profileImport.nothingToStart.one"
              : "profileImport.nothingToStart.other",
            {
              count: skipped.length,
              name: skipped[0]?.name ?? "",
              reason: skipped[0]?.reason ?? "",
            },
          )
        : "",
      read.warnings[0] ?? "",
    ].filter((part) => part !== "");
    return failure(
      file,
      why.length > 0
        ? t("profileImport.noneWhy", { why: why.join("; ") })
        : t("profileImport.none"),
    );
  }
  return {
    ok: true,
    plan: { fileName: file.name, profiles, hidden: read.hidden, skipped, warnings: read.warnings },
  };
}

/** The line shown for a profile of the plan: its name and the command line that starts it. */
export function describeProfile(profile: UserProfile): { name: string; command: string } {
  return { name: profile.name, command: commandLineOf(profile) };
}

/** `"A"`, `"A" and "B"`, or the first two and a count. */
function namesOf(profiles: readonly UserProfile[]): string {
  const shown = profiles.slice(0, 2).map((profile) => `"${profile.name}"`);
  const [first = "", second = ""] = shown;
  const rest = profiles.length - shown.length;
  if (rest > 0) return t("profileImport.namesMore", { first, second, rest });
  return second === "" ? first : t("profileImport.namesAnd", { first, second });
}

export type ProfileImportResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Adds the profiles of the plan to the end of `profiles` in `config.jsonc`, through the manager
 * that edits the text (the comments of the file stay). Nothing is started. When the file cannot be
 * edited (it has a problem of its own, or the disk refuses) nothing is written and the answer says
 * why. Never rejects.
 */
export async function commitProfileImport(
  plan: ProfileImportPlan,
  settings: Pick<ConfigManager, "update">,
): Promise<ProfileImportResult> {
  const result = await settings.update([{ path: ["profiles"], append: plan.profiles }]);
  if (!result.ok) return { ok: false, message: result.message };
  return {
    ok: true,
    message: t("profileImport.done", {
      profiles: profileCount(plan.profiles.length),
      names: namesOf(plan.profiles),
    }),
  };
}

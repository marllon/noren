import { RESERVED_PROFILE_IDS, UserProfileSchema, slugify } from "@noren/model";
import type { Config, ConfigEdit, UserProfile } from "@noren/model";

// The pure part of the Profiles section of the settings screen: the rows a person edits (the name,
// the program, the arguments one to a line, the folder), what Save has to write for them (the
// settings of a profile that changed, the profiles taken out, the new ones appended) and the
// problems the schema finds, per row and per box. A profile that is already in the file keeps its
// id; a new one gets the id of the slug of its name, which nothing else uses. Only what changed is
// written, so the comments around the list and the other profiles stay as they are.

/** The boxes of a row. */
export type ProfileField = "name" | "program" | "args" | "cwd";

/** One profile as the screen edits it. */
export interface ProfileRow {
  /** Stays the same while the row is on screen: the id of a profile of the file, else `new-N`. */
  key: string;
  /** Whether the file has this profile (its id is `key`). */
  saved: boolean;
  name: string;
  program: string;
  /** The arguments, one to a line. */
  args: string;
  cwd: string;
}

/** The profiles of the file as rows. */
export function profileRowsOf(config: Config): ProfileRow[] {
  return (config.profiles ?? []).map((profile) => ({
    key: profile.id,
    saved: true,
    name: profile.name,
    program: profile.program,
    args: (profile.args ?? []).join("\n"),
    cwd: profile.cwd ?? "",
  }));
}

/** The rows on screen: the draft when the person touched the list, else the profiles of the file. */
export function shownProfiles(config: Config, draft: readonly ProfileRow[] | undefined) {
  return draft ?? profileRowsOf(config);
}

/** A row with nothing in it, which Save ignores. */
const BLANK = { name: "", program: "", args: "", cwd: "" };

/** `rows` with an empty row at the end; its key is the first `new-N` not in use. */
export function withNewProfile(rows: readonly ProfileRow[]): ProfileRow[] {
  const used = new Set(rows.map((row) => row.key));
  let number = 1;
  while (used.has(`new-${number}`)) number += 1;
  return [...rows, { key: `new-${number}`, saved: false, ...BLANK }];
}

/** `rows` with the boxes of the row `key` changed. */
export function withProfileEdited(
  rows: readonly ProfileRow[],
  key: string,
  patch: Partial<Record<ProfileField, string>>,
): ProfileRow[] {
  return rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
}

/** `rows` without the row `key`. */
export function withoutProfile(rows: readonly ProfileRow[], key: string): ProfileRow[] {
  return rows.filter((row) => row.key !== key);
}

/** The arguments of a box: one to a line, a line with nothing but blanks is not an argument. */
export function argsOfText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
}

/** The id for a new profile: the slug of its name, with a number added when something else has it. */
export function newProfileId(name: string, taken: Set<string>): string {
  const base = slugify(name) || "profile";
  let id = base;
  let number = 1;
  while (taken.has(id)) {
    number += 1;
    id = `${base}-${number}`;
  }
  taken.add(id);
  return id;
}

const isBlank = (row: ProfileRow): boolean =>
  row.name.trim() === "" &&
  row.program.trim() === "" &&
  row.args.trim() === "" &&
  row.cwd.trim() === "";

/** What the row says as a profile of the file (without checking it). */
function profileOfRow(row: ProfileRow, id: string): Record<string, unknown> {
  const args = argsOfText(row.args);
  const cwd = row.cwd.trim();
  return {
    id,
    name: row.name.trim(),
    program: row.program.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(cwd !== "" ? { cwd } : {}),
  };
}

/** What the schema finds wrong with each box of the row (`id` is made by the screen, never wrong). */
function problemsOfRow(candidate: Record<string, unknown>): Partial<Record<ProfileField, string>> {
  const parsed = UserProfileSchema.safeParse(candidate);
  const found: Partial<Record<ProfileField, string>> = {};
  if (parsed.success) return found;
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "name" || field === "program" || field === "cwd") {
      found[field] ??= issue.message;
    } else if (field === "args") {
      found.args ??= issue.message;
    }
  }
  return found;
}

export interface ProfilesPlan {
  /** In the order they apply: settings of the profiles that stay, removals (last first), new profiles. */
  changes: ConfigEdit[];
  /** The problems by the key of the row. */
  problems: Record<string, Partial<Record<ProfileField, string>>>;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * What Save writes for the rows. `takenIds` are the ids of the shells of the machine, which a new
 * profile cannot have. A row is matched to the profile of the file by its id; a profile of the file
 * that has no row is removed, a new row is appended, an empty new row is left out. A box that is
 * not as the file has it is written, and an argument list or a folder that was emptied is taken out
 * of the file. Rows with problems are reported and nothing of them is written.
 */
export function planProfiles(
  config: Config,
  draft: readonly ProfileRow[] | undefined,
  takenIds: Iterable<string> = [],
): ProfilesPlan {
  const plan: ProfilesPlan = { changes: [], problems: {} };
  if (draft === undefined) return plan;
  const file = config.profiles ?? [];
  const taken = new Set<string>([...takenIds, ...RESERVED_PROFILE_IDS, ...file.map((p) => p.id)]);
  const settings: ConfigEdit[] = [];
  const removals: ConfigEdit[] = [];
  const added: UserProfile[] = [];

  for (const row of draft) {
    if (row.saved) {
      const index = file.findIndex((profile) => profile.id === row.key);
      const before = file[index];
      if (before === undefined) continue; // the file changed under the screen: nothing to edit
      const candidate = profileOfRow(row, before.id);
      const problems = problemsOfRow(candidate);
      if (Object.keys(problems).length > 0) {
        plan.problems[row.key] = problems;
        continue;
      }
      const wanted = candidate as unknown as UserProfile;
      const at = ["profiles", index] as const;
      if (wanted.name !== before.name) settings.push({ path: [...at, "name"], value: wanted.name });
      if (wanted.program !== before.program) {
        settings.push({ path: [...at, "program"], value: wanted.program });
      }
      const args = wanted.args ?? [];
      if (!sameList(args, before.args ?? [])) {
        settings.push(
          args.length > 0
            ? { path: [...at, "args"], value: args }
            : { path: [...at, "args"], remove: true },
        );
      }
      if (wanted.cwd !== before.cwd) {
        settings.push(
          wanted.cwd !== undefined
            ? { path: [...at, "cwd"], value: wanted.cwd }
            : { path: [...at, "cwd"], remove: true },
        );
      }
    } else if (!isBlank(row)) {
      const candidate = profileOfRow(row, newProfileId(row.name, taken));
      const problems = problemsOfRow(candidate);
      if (Object.keys(problems).length > 0) plan.problems[row.key] = problems;
      else added.push(candidate as unknown as UserProfile);
    }
  }

  // The profiles of the file that no row has anymore, the last one first so the indexes hold.
  const kept = new Set(draft.filter((row) => row.saved).map((row) => row.key));
  for (let index = file.length - 1; index >= 0; index--) {
    const profile = file[index];
    if (profile !== undefined && !kept.has(profile.id)) {
      removals.push({ path: ["profiles", index], remove: true });
    }
  }

  plan.changes = [
    ...settings,
    ...removals,
    ...(added.length > 0 ? [{ path: ["profiles"], append: added }] : []),
  ];
  return plan;
}

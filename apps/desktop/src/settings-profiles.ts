import {
  RESERVED_PROFILE_IDS,
  ShellUserProfileSchema,
  SshUserProfileSchema,
  isSshProfile,
  slugify,
} from "@noren/model";
import type { Config, ConfigEdit, ConfigValue, UserProfile } from "@noren/model";

// The pure part of the Profiles section of the settings screen: the rows a person edits (the name,
// the program, the arguments one to a line, the folder), what Save has to write for them (the
// settings of a profile that changed, the profiles taken out, the new ones appended) and the
// problems the schema finds, per row and per box. A profile that is already in the file keeps its
// id; a new one gets the id of the slug of its name, which nothing else uses. Only what changed is
// written, so the comments around the list and the other profiles stay as they are.
//
// There are two kinds of row. A shell row has the program, its arguments and the folder. An SSH row
// has the machine, the user, the port, the two files, and the optional program, arguments and
// folder of the shell there. Neither has a box for a password, a passphrase or the text of a key: an
// SSH profile names a key file, and the check is the schema's.

/** The boxes of a row. */
export type ProfileField =
  | "name"
  | "program"
  | "args"
  | "cwd"
  | "host"
  | "user"
  | "port"
  | "identityFile"
  | "knownHostsFile";

/** The boxes only a row of kind ssh has. */
const SSH_BOXES = ["host", "user", "port", "identityFile", "knownHostsFile"] as const;

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
  /**
   * `"ssh"` for a profile whose shell lives on another machine; absent for a shell on this one.
   * The boxes below are only on such a row (`program`, `args` and `cwd` are then optional).
   */
  kind?: "ssh";
  host?: string;
  user?: string;
  /** The port as typed: Save turns it into a number, and says so when it is not one. */
  port?: string;
  identityFile?: string;
  knownHostsFile?: string;
}

/** Whether the row is of kind ssh. */
export const isSshRow = (row: ProfileRow): boolean => row.kind === "ssh";

/** The profiles of the file as rows. */
export function profileRowsOf(config: Config): ProfileRow[] {
  return (config.profiles ?? []).map((profile): ProfileRow => {
    const common = {
      key: profile.id,
      saved: true,
      name: profile.name,
      args: (profile.args ?? []).join("\n"),
      cwd: profile.cwd ?? "",
    };
    return isSshProfile(profile)
      ? {
          ...common,
          kind: "ssh",
          program: profile.program ?? "",
          host: profile.host,
          user: profile.user ?? "",
          port: profile.port === undefined ? "" : String(profile.port),
          identityFile: profile.identityFile ?? "",
          knownHostsFile: profile.knownHostsFile ?? "",
        }
      : { ...common, program: profile.program };
  });
}

/** The rows on screen: the draft when the person touched the list, else the profiles of the file. */
export function shownProfiles(config: Config, draft: readonly ProfileRow[] | undefined) {
  return draft ?? profileRowsOf(config);
}

/** A row with nothing in it, which Save ignores. */
const BLANK = { name: "", program: "", args: "", cwd: "" };
const BLANK_SSH = {
  ...BLANK,
  kind: "ssh" as const,
  host: "",
  user: "",
  port: "",
  identityFile: "",
  knownHostsFile: "",
};

/** `rows` with an empty row at the end (of kind ssh when asked); its key is the first `new-N` not in use. */
export function withNewProfile(rows: readonly ProfileRow[], kind?: "ssh"): ProfileRow[] {
  const used = new Set(rows.map((row) => row.key));
  let number = 1;
  while (used.has(`new-${number}`)) number += 1;
  return [...rows, { key: `new-${number}`, saved: false, ...(kind === "ssh" ? BLANK_SSH : BLANK) }];
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
  [row.name, row.program, row.args, row.cwd, ...SSH_BOXES.map((box) => row[box] ?? "")].every(
    (text) => text.trim() === "",
  );

/** What the row says as a profile of the file (without checking it). */
function profileOfRow(row: ProfileRow, id: string): Record<string, unknown> {
  const args = argsOfText(row.args);
  const cwd = row.cwd.trim();
  const program = row.program.trim();
  if (!isSshRow(row)) {
    return {
      id,
      name: row.name.trim(),
      program,
      ...(args.length > 0 ? { args } : {}),
      ...(cwd !== "" ? { cwd } : {}),
    };
  }
  const text = (box: "user" | "identityFile" | "knownHostsFile"): Record<string, string> => {
    const value = (row[box] ?? "").trim();
    return value !== "" ? { [box]: value } : {};
  };
  const port = (row.port ?? "").trim();
  return {
    kind: "ssh",
    id,
    name: row.name.trim(),
    host: (row.host ?? "").trim(),
    ...text("user"),
    // Text that is not a whole number stays text, which the schema refuses (see `problemsOfRow`).
    ...(port !== "" ? { port: /^\d+$/.test(port) ? Number(port) : port } : {}),
    ...text("identityFile"),
    ...text("knownHostsFile"),
    ...(program !== "" ? { program } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(cwd !== "" ? { cwd } : {}),
  };
}

const BOXES: readonly ProfileField[] = ["name", "program", "args", "cwd", ...SSH_BOXES];

/** What the schema finds wrong with each box of the row (`id` is made by the screen, never wrong). */
function problemsOfRow(candidate: Record<string, unknown>): Partial<Record<ProfileField, string>> {
  const schema = candidate["kind"] === "ssh" ? SshUserProfileSchema : ShellUserProfileSchema;
  const parsed = schema.safeParse(candidate);
  const found: Partial<Record<ProfileField, string>> = {};
  if (parsed.success) return found;
  for (const issue of parsed.error.issues) {
    const field = BOXES.find((box) => box === issue.path[0]);
    if (field === undefined) continue;
    // A port that is not a number reaches the schema as text, and its own message is a type error.
    const notANumber = field === "port" && typeof candidate["port"] === "string";
    found[field] ??= notANumber ? "Must be a whole number" : issue.message;
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

/** The settings of a profile the screen writes, in the order of the schema. */
const SHELL_SETTINGS = ["name", "program", "args", "cwd"] as const;
const SSH_SETTINGS = [
  "name",
  "host",
  "user",
  "port",
  "identityFile",
  "knownHostsFile",
  "program",
  "args",
  "cwd",
] as const;

/**
 * What Save writes for the rows. `takenIds` are the ids of the shells of the machine, which a new
 * profile cannot have. A row is matched to the profile of the file by its id; a profile of the file
 * that has no row is removed, a new row is appended, an empty new row is left out. A box that is
 * not as the file has it is written, and an optional one that was emptied is taken out of the file.
 * Rows with problems are reported and nothing of them is written.
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
      // The file changed under the screen (or the id is a profile of the other kind now): nothing to edit.
      if (before === undefined || isSshProfile(before) !== isSshRow(row)) continue;
      const wanted = profileOfRow(row, before.id);
      const problems = problemsOfRow(wanted);
      if (Object.keys(problems).length > 0) {
        plan.problems[row.key] = problems;
        continue;
      }
      const was: Record<string, unknown> = { ...before };
      const at = ["profiles", index] as const;
      for (const setting of isSshRow(row) ? SSH_SETTINGS : SHELL_SETTINGS) {
        const now = wanted[setting];
        const old = was[setting];
        const same =
          setting === "args"
            ? sameList((now as string[] | undefined) ?? [], (old as string[] | undefined) ?? [])
            : now === old;
        if (same) continue;
        settings.push(
          now === undefined
            ? { path: [...at, setting], remove: true }
            : { path: [...at, setting], value: now as ConfigValue | readonly string[] },
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

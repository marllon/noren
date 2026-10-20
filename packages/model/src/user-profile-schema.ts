import { z } from "zod";

// The profiles of the user: the schema of one entry of the `profiles` list of `config.jsonc`, and
// the checks the backend repeats before it takes a list. Kept apart from the code that imports
// profiles (`user-profiles.ts`) because the schema of the settings file needs this file and that
// code needs the settings file's neighbors. Pure; none of it throws.
//
// There are two kinds. A shell profile (`kind` left out, or `"shell"`) starts a program on this
// machine. An SSH profile (`kind: "ssh"`) opens its shell in a `norend` on another machine, through
// the `ssh` of the system (see `docs/DAEMON.md`); it names the machine, never a password.

/** The ids of profiles are written like the ids of themes: lower case words joined by hyphens. */
export const PROFILE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The longest id of a profile. */
export const MAX_PROFILE_ID = 64;

/**
 * `default` is how a pane says "the profile the machine defaults to" (see `DEFAULT_PROFILE_ID`), so
 * no profile may take it as its id.
 */
export const RESERVED_PROFILE_IDS: readonly string[] = ["default"];

/** The most profiles a settings file may list. */
export const MAX_USER_PROFILES = 200;

/**
 * A host of an SSH profile: a name or an address, letters, digits and `.`, `-`, `_`, `:` (an IPv6
 * address), not starting with `-` (it would be taken for an option). `noren-core` checks the same
 * before anything reaches the command line of `ssh`.
 */
export const SSH_HOST_PATTERN = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]*$/;

/** The user of an SSH profile: the same as a host without `:`. */
export const SSH_USER_PATTERN = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/** The longest host or user of an SSH profile. */
export const MAX_SSH_NAME = 255;

const withoutNul = (text: string): boolean => !text.includes("\0");
const NUL_MESSAGE = "Must not contain a NUL character";
const notBlank = /\S/;
// eslint-disable-next-line no-control-regex -- a control character in a path is what this finds
const hasControl = /[\u0000-\u001f\u007f]/;

const idField = z
  .string()
  .max(MAX_PROFILE_ID)
  .regex(PROFILE_ID_PATTERN, "Must be lower case words joined by hyphens, such as dev-shell")
  .meta({
    description: 'The id of the profile, such as "dev-shell". Unique among the profiles.',
  });

const nameField = z
  .string()
  .max(100)
  .regex(notBlank, "The name is empty")
  .refine(withoutNul, NUL_MESSAGE)
  .meta({ description: "The name shown in the command palette." });

const KIND_TEXT =
  'What the profile opens: "shell" (the default) starts a program on this machine, "ssh" opens a shell in a norend on another machine through ssh.';

const PROGRAM_TEXT =
  'The program that starts the shell, such as "pwsh.exe" or a full path. %NAME% is replaced by the environment variable NAME when a session starts. In an SSH profile it runs on the other machine, nothing in it is replaced, and when left out it is the login shell of the user there.';

const programText = z
  .string()
  .max(1024)
  .regex(notBlank, "The program is empty")
  .refine(withoutNul, NUL_MESSAGE);

const argsField = z
  .array(z.string().max(4096).refine(withoutNul, NUL_MESSAGE))
  .max(200)
  .optional()
  .meta({ description: "The arguments of the program, one item each." });

const cwdField = z
  .string()
  .max(1024)
  .regex(notBlank, "The folder is empty")
  .refine(withoutNul, NUL_MESSAGE)
  .optional()
  .meta({
    description:
      "The folder a session of this profile starts in, unless the space or the tab names one. %NAME% is replaced by the environment variable NAME. In an SSH profile it is a folder on the other machine, taken as written, and when left out the home folder of the user there.",
  });

/** A path of an SSH profile: a file on this machine, written for the system, `%NAME%` expanded. */
const filePath = z
  .string()
  .max(1024)
  .regex(notBlank, "The path is empty")
  .refine((text) => !hasControl.test(text), "Must not contain a control character");

export const ShellUserProfileSchema = z.strictObject({
  kind: z.literal("shell").optional().meta({ description: KIND_TEXT }),
  id: idField,
  name: nameField,
  program: programText.meta({ description: PROGRAM_TEXT }),
  args: argsField,
  cwd: cwdField,
});

export const SshUserProfileSchema = z.strictObject({
  kind: z.literal("ssh").meta({ description: KIND_TEXT }),
  id: idField,
  name: nameField,
  host: z
    .string()
    .min(1, "The host is empty")
    .max(MAX_SSH_NAME)
    .regex(
      SSH_HOST_PATTERN,
      'Must be a host name or an address: letters, digits, ".", "-", "_" and ":", not starting with "-"',
    )
    .meta({
      description:
        'The machine to reach with ssh: a host name or an address (letters, digits, ".", "-", "_" and ":").',
    }),
  user: z
    .string()
    .min(1, "The user is empty")
    .max(MAX_SSH_NAME)
    .regex(SSH_USER_PATTERN, 'Must be letters, digits, ".", "-" and "_", not starting with "-"')
    .optional()
    .meta({
      description:
        "The user to log in as. When left out ssh decides: its own configuration, then the name of the user on this machine.",
    }),
  port: z
    .number()
    .int("Must be a whole number")
    .min(1, "Must be at least 1")
    .max(65535, "Must be at most 65535")
    .optional()
    .meta({
      description:
        "The port of the ssh server. 22, or what the ssh configuration says, when left out.",
    }),
  identityFile: filePath.optional().meta({
    description:
      "The private key to log in with, as a path; only this key is offered. When left out ssh tries its own keys and the agent. A key with a passphrase works only through an agent: Noren never asks for a passphrase and stores none. %NAME% is replaced by the environment variable NAME.",
  }),
  knownHostsFile: filePath.optional().meta({
    description:
      "The file with the keys of the hosts you trust, as a path. When left out the known_hosts file of the user is used. A host that is not in the file is refused, never accepted on the first visit. %NAME% is replaced by the environment variable NAME.",
  }),
  program: programText.optional().meta({ description: PROGRAM_TEXT }),
  args: argsField,
  cwd: cwdField,
});

/**
 * One entry of the `profiles` list. `kind` tells the two apart; a profile without it is a shell
 * profile, as every profile was before there were two kinds.
 */
export const UserProfileSchema = z
  .discriminatedUnion("kind", [ShellUserProfileSchema, SshUserProfileSchema])
  .meta({ description: "A shell profile of your own." });

/** A profile that starts a program on this machine. */
export type ShellUserProfile = z.infer<typeof ShellUserProfileSchema>;

/** A profile that opens its shell in a `norend` on another machine, through ssh. */
export type SshUserProfile = z.infer<typeof SshUserProfileSchema>;

/** A shell profile the user defined. */
export type UserProfile = ShellUserProfile | SshUserProfile;

/** Whether the profile opens its shell on another machine. */
export function isSshProfile(profile: UserProfile): profile is SshUserProfile {
  return profile.kind === "ssh";
}

/** The first problem of a failed parse in a sentence: `program: The program is empty`. */
export function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "it is not a profile";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * Why a list of profiles cannot be taken as it is, in a sentence, or `undefined` when it can. A
 * profile must match `UserProfileSchema`, ids must be unique, `default` is reserved and an id in
 * `takenIds` (the shells the machine has) cannot be used again. The backend runs the same checks.
 */
export function profilesProblem(
  profiles: readonly unknown[],
  takenIds: Iterable<string> = [],
): string | undefined {
  try {
    const taken = new Set(takenIds);
    const seen = new Set<string>();
    if (profiles.length > MAX_USER_PROFILES) {
      return `There are more than ${MAX_USER_PROFILES} profiles`;
    }
    for (const [index, entry] of profiles.entries()) {
      const parsed = UserProfileSchema.safeParse(entry);
      if (!parsed.success) return `Profile ${index + 1}: ${firstProblem(parsed.error)}`;
      const { id, name } = parsed.data;
      if (RESERVED_PROFILE_IDS.includes(id)) return `Profile "${name}": the id "${id}" is reserved`;
      if (taken.has(id)) {
        return `Profile "${name}": the id "${id}" is already a shell of this machine`;
      }
      if (seen.has(id)) return `Profile "${name}": the id "${id}" is used by another profile`;
      seen.add(id);
    }
    return undefined;
  } catch {
    return "The profiles could not be checked";
  }
}

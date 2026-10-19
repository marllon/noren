import { z } from "zod";

// The shell profiles of the user: the schema of one entry of the `profiles` list of `config.jsonc`,
// and the checks the backend repeats before it takes a list. Kept apart from the code that imports
// profiles (`user-profiles.ts`) because the schema of the settings file needs this file and that
// code needs the settings file's neighbors. Pure; none of it throws.

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

const withoutNul = (text: string): boolean => !text.includes("\0");
const NUL_MESSAGE = "Must not contain a NUL character";
const notBlank = /\S/;

export const UserProfileSchema = z
  .strictObject({
    id: z
      .string()
      .max(MAX_PROFILE_ID)
      .regex(PROFILE_ID_PATTERN, "Must be lower case words joined by hyphens, such as dev-shell")
      .meta({
        description: 'The id of the profile, such as "dev-shell". Unique among the profiles.',
      }),
    name: z
      .string()
      .max(100)
      .regex(notBlank, "The name is empty")
      .refine(withoutNul, NUL_MESSAGE)
      .meta({ description: "The name shown in the command palette." }),
    program: z
      .string()
      .max(1024)
      .regex(notBlank, "The program is empty")
      .refine(withoutNul, NUL_MESSAGE)
      .meta({
        description:
          'The program that starts the shell, such as "pwsh.exe" or a full path. %NAME% is replaced by the environment variable NAME when a session starts.',
      }),
    args: z
      .array(z.string().max(4096).refine(withoutNul, NUL_MESSAGE))
      .max(200)
      .optional()
      .meta({ description: "The arguments of the program, one item each." }),
    cwd: z
      .string()
      .max(1024)
      .regex(notBlank, "The folder is empty")
      .refine(withoutNul, NUL_MESSAGE)
      .optional()
      .meta({
        description:
          "The folder a session of this profile starts in, unless the space or the tab names one. %NAME% is replaced by the environment variable NAME.",
      }),
  })
  .meta({ description: "A shell profile of your own." });

/** A shell profile the user defined. */
export type UserProfile = z.infer<typeof UserProfileSchema>;

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

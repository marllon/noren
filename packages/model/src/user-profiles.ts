import type { ImportedProfile } from "./import-json";
import { claimIdentity } from "./theme-derive";
import { RESERVED_PROFILE_IDS, ShellUserProfileSchema, firstProblem } from "./user-profile-schema";
import type { ShellUserProfile } from "./user-profile-schema";

// Getting the shell profiles of another program's settings file into the profiles of the user: a
// command line becomes a program and its arguments, and a profile read from the file (an
// `ImportedProfile`) becomes an entry of the `profiles` list of `config.jsonc`. Pure; none of it
// throws.

/** A program and its arguments, as a command line splits into them. */
export interface CommandLine {
  program: string;
  args: string[];
}

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";

/**
 * Splits a command line into the program and its arguments by the rules of Windows
 * (`CommandLineToArgvW`):
 *
 * - the program is the first word. In quotes it runs to the next quote; unquoted it runs to the
 *   first space or tab. Backslashes in it are plain characters (a path), so `C:\Tools\sh.exe` stays
 *   as it is.
 * - the arguments are separated by spaces and tabs. A double quote opens or closes a quoted part
 *   (the quote itself is not kept) where spaces do not separate; inside a quoted part two quotes in
 *   a row are one literal quote.
 * - backslashes are plain, except right before a double quote: 2n backslashes and a quote are n
 *   backslashes and a quote that opens or closes, 2n+1 backslashes and a quote are n backslashes and
 *   a literal quote.
 * - a quoted part that is never closed runs to the end of the line.
 *
 * `%NAME%` is not expanded here; it is kept as written. The answer is `undefined` when the line has
 * no program (it is empty, or only blanks, or only `""`). Never throws.
 */
export function splitCommandLine(line: string): CommandLine | undefined {
  try {
    return split(line);
  } catch {
    return undefined;
  }
}

function split(line: string): CommandLine | undefined {
  let at = 0;
  while (isBlank(line[at])) at++;

  let program: string;
  if (line[at] === '"') {
    const close = line.indexOf('"', at + 1);
    program = line.slice(at + 1, close < 0 ? line.length : close);
    at = close < 0 ? line.length : close + 1;
  } else {
    const start = at;
    while (at < line.length && !isBlank(line[at])) at++;
    program = line.slice(start, at);
  }
  if (program.trim() === "") return undefined;

  const args: string[] = [];
  while (at < line.length) {
    while (isBlank(line[at])) at++;
    if (at >= line.length) break;
    let arg = "";
    let quoted = false;
    while (at < line.length && (quoted || !isBlank(line[at]))) {
      const char = line.charAt(at);
      if (char === "\\") {
        let slashes = 0;
        while (line[at] === "\\") {
          slashes++;
          at++;
        }
        if (line[at] === '"') {
          arg += "\\".repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) {
            arg += '"';
            at++;
          }
        } else {
          arg += "\\".repeat(slashes);
        }
      } else if (char === '"') {
        if (quoted && line[at + 1] === '"') {
          arg += '"';
          at += 2;
        } else {
          quoted = !quoted;
          at++;
        }
      } else {
        arg += char;
        at++;
      }
    }
    args.push(arg);
  }
  return { program, args };
}

/** A profile of the other program's file that did not become a profile of the user, and why. */
export interface SkippedProfile {
  name: string;
  reason: string;
}

export interface ProfilesFromImport {
  /** The new profiles, with ids that collide with nothing, in the order of the file. */
  profiles: ShellUserProfile[];
  /** What was read but could not become a profile. */
  skipped: SkippedProfile[];
}

/**
 * Turns the profiles read out of another program's settings file into profiles of the user. The
 * command line is split into the program and its arguments (`splitCommandLine`) and the starting
 * directory becomes `cwd`; the color scheme the profile used is not carried over. Each profile gets
 * an id that is a slug of its name and is not in `takenIds` (the shells of the machine and the
 * profiles the user has), not `default`, and not the id of another profile of this result: a number
 * is added to the id (`-2`) and to the name (` (2)`) when the id is taken. A profile with no command
 * line, or that the schema does not accept, is skipped with the reason. Never throws.
 */
export function userProfilesFromImported(
  imported: readonly ImportedProfile[],
  takenIds: Iterable<string> = [],
): ProfilesFromImport {
  const profiles: ShellUserProfile[] = [];
  const skipped: SkippedProfile[] = [];
  try {
    const taken = new Set<string>([...takenIds, ...RESERVED_PROFILE_IDS]);
    for (const entry of imported) {
      try {
        if (entry.commandLine === null) {
          skipped.push({ name: entry.name, reason: "it has no command line" });
          continue;
        }
        const command = splitCommandLine(entry.commandLine);
        if (command === undefined) {
          skipped.push({ name: entry.name, reason: "its command line has no program" });
          continue;
        }
        const identity = claimIdentity(entry.name, "Imported profile", taken);
        const parsed = ShellUserProfileSchema.safeParse({
          id: identity.id,
          name: identity.name,
          program: command.program,
          ...(command.args.length > 0 ? { args: command.args } : {}),
          ...(entry.startingDirectory !== null ? { cwd: entry.startingDirectory } : {}),
        });
        if (!parsed.success) {
          taken.delete(identity.id);
          skipped.push({ name: entry.name, reason: firstProblem(parsed.error) });
          continue;
        }
        profiles.push(parsed.data);
      } catch {
        skipped.push({ name: String(entry.name), reason: "it could not be read" });
      }
    }
  } catch {
    // Nothing above is expected to throw; what was gathered stands.
  }
  return { profiles, skipped };
}

/**
 * The command line of a profile as a person reads it: the program, then each argument, quoted when
 * it needs it. This is for showing; it splits back into the same program and arguments.
 */
export function commandLineOf(profile: Pick<ShellUserProfile, "program" | "args">): string {
  // The backslashes before a quote, and before the closing one, are doubled (see `splitCommandLine`).
  const quote = (text: string): string =>
    text === "" || /[\s"]/.test(text)
      ? `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
      : text;
  const program = /\s/.test(profile.program) ? `"${profile.program}"` : profile.program;
  return [program, ...(profile.args ?? []).map(quote)].join(" ");
}

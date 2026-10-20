import { z } from "zod";

// CLI agents (programs that work for you inside a terminal): the catalog that says what they are,
// and the rule that tells, from the command line the shell reported (OSC 633;E), which one runs in
// a pane. The other half, the process tree of the session, is in `noren-core` (`agents.rs`), which
// reads the same catalog; when both know, the command wins (`resolveAgent`).
//
// The catalog names an agent by the file name of its executable, nothing else: Noren shows that
// name and a generic icon, never a logo. It is data of the user (`agents.catalog` in
// `config.jsonc`), so a program Noren does not know is one entry away.
//
// Pure: no DOM, no Tauri, no dictionary of the interface.

/** Most agents a catalog may list. Repeated in `noren-core` (`MAX_CATALOG_ENTRIES`). */
export const MAX_AGENT_ENTRIES = 64;
/** Most executable names, and most package names, one agent may list. */
export const MAX_AGENT_NAMES = 16;
/** Longest id or name in a catalog, in characters. */
export const MAX_AGENT_NAME_CHARS = 64;

/** An id: lower case letters, digits, `-` and `_`. It is the name the interface shows. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** The name of an executable: no folder, no space. */
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** The name of a package as `npx` or `python -m` takes it, scope included. */
const PACKAGE_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._+-]*(\/[A-Za-z0-9][A-Za-z0-9._+-]*)?$/;

const NAME_LIMIT = { message: `At most ${MAX_AGENT_NAME_CHARS} characters` };

/** One agent of the catalog. */
export const AgentEntrySchema = z
  .strictObject({
    id: z
      .string()
      .max(MAX_AGENT_NAME_CHARS, NAME_LIMIT)
      .regex(AGENT_ID_PATTERN, {
        message:
          "An id is lower case letters, digits, '-' and '_', and starts with a letter or digit",
      })
      .meta({ description: "The name Noren shows for the agent. Unique in the catalog." }),
    executables: z
      .array(
        z.string().max(MAX_AGENT_NAME_CHARS, NAME_LIMIT).regex(EXECUTABLE_PATTERN, {
          message:
            "Not the name of an executable: no folder, no spaces (claude, not /usr/bin/claude)",
        }),
      )
      .min(1, { message: "List at least one executable" })
      .max(MAX_AGENT_NAMES)
      .meta({
        description:
          'File names of the program, without folder, ".exe" or ".cmd" (case does not matter): "claude" matches claude, Claude.exe and claude.cmd, and not claudette.',
      }),
    packages: z
      .array(
        z
          .string()
          .max(MAX_AGENT_NAME_CHARS, NAME_LIMIT)
          .regex(PACKAGE_PATTERN, { message: "Not the name of a package" }),
      )
      .max(MAX_AGENT_NAMES)
      .optional()
      .meta({
        description:
          'Package names that identify the agent when it is started through a runner (node, npx, bunx, python, uv, pipx...): the runner counts as the agent when one of its arguments is the package, as in "npx pkg" or "python -m pkg".',
      }),
  })
  .meta({ description: "A CLI agent Noren recognizes in a tab." });

export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/** The agents of `agents.catalog`: a list of entries whose ids, and whose executables, are all different. */
export const AgentCatalogSchema = z
  .array(AgentEntrySchema)
  .max(MAX_AGENT_ENTRIES)
  .superRefine((entries, context) => {
    const ids = new Set<string>();
    const executables = new Map<string, string>();
    entries.forEach((entry, index) => {
      if (ids.has(entry.id)) {
        context.addIssue({
          code: "custom",
          message: `The id "${entry.id}" is used by another agent`,
          path: [index, "id"],
        });
      }
      ids.add(entry.id);
      entry.executables.forEach((executable, position) => {
        const key = programName(executable);
        const owner = executables.get(key);
        if (owner !== undefined && owner !== entry.id) {
          context.addIssue({
            code: "custom",
            message: `The executable "${executable}" already belongs to the agent "${owner}"`,
            path: [index, "executables", position],
          });
        }
        executables.set(key, entry.id);
      });
    });
  })
  .meta({
    description:
      "The CLI agents Noren recognizes in a tab, by the command being run and by the programs running under the shell. Replaces the built-in list when present, so copy the entries you want to keep.",
  });

export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

/** The agents Noren knows without being told, named by their executable. */
export const DEFAULT_AGENT_CATALOG: AgentCatalog = [
  { id: "claude", executables: ["claude"] },
  { id: "codex", executables: ["codex"] },
  { id: "gemini", executables: ["gemini"] },
  { id: "opencode", executables: ["opencode"] },
  { id: "aider", executables: ["aider"], packages: ["aider"] },
  { id: "goose", executables: ["goose"] },
  { id: "crush", executables: ["crush"] },
  { id: "amp", executables: ["amp"] },
  { id: "qwen", executables: ["qwen"] },
  { id: "cursor-agent", executables: ["cursor-agent"] },
];

/** How often the process tree of the sessions is looked at, by default and at the shortest, in seconds. */
export const DEFAULT_AGENT_SCAN_SECONDS = 3;
export const MIN_AGENT_SCAN_SECONDS = 1;

/** Agent detection is on unless the settings say it is not. */
export const DEFAULT_AGENTS_ENABLED = true;

/** What the settings say about agents, with the defaults filled in. */
export interface AgentSettings {
  enabled: boolean;
  catalog: AgentCatalog;
  /** Milliseconds between two looks at the process tree. */
  scanIntervalMs: number;
}

/**
 * The agent settings in force from the `agents` section of the settings file. An absent
 * `catalog` is the built-in one; a present one (even empty) replaces it. An interval that is not a
 * finite number of at least {@link MIN_AGENT_SCAN_SECONDS} second falls back to the default.
 */
export function agentSettingsOf(
  section:
    | {
        enabled?: boolean | undefined;
        catalog?: AgentCatalog | undefined;
        scanSeconds?: number | undefined;
      }
    | undefined,
): AgentSettings {
  const seconds = section?.scanSeconds;
  const usable =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= MIN_AGENT_SCAN_SECONDS;
  return {
    enabled: section?.enabled ?? DEFAULT_AGENTS_ENABLED,
    catalog: section?.catalog ?? DEFAULT_AGENT_CATALOG,
    scanIntervalMs: Math.round((usable ? seconds : DEFAULT_AGENT_SCAN_SECONDS) * 1000),
  };
}

/** Programs that start other programs: their own name says nothing, their arguments do. */
const RUNNERS = new Set([
  "node",
  "nodejs",
  "npx",
  "bun",
  "bunx",
  "deno",
  "python",
  "python3",
  "py",
  "uv",
  "uvx",
  "pipx",
]);

/** Words in front of a command that run it without being it. */
const PREFIX_WORDS = new Set([
  "sudo",
  "env",
  "time",
  "exec",
  "command",
  "nohup",
  "&",
  "call",
  "start",
]);

const LAUNCHER_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

/**
 * The name of a program for comparing: the file name without its folder (`/` or `\`) and without
 * the ending a Windows launcher adds, in lower case. The same rule as `program_name` in
 * `noren-core`.
 */
export function programName(path: string): string {
  const file = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const lower = file.trim().toLowerCase();
  for (const extension of LAUNCHER_EXTENSIONS) {
    if (lower.endsWith(extension) && lower.length > extension.length) {
      return lower.slice(0, -extension.length);
    }
  }
  return lower;
}

/**
 * Whether `argument` names the package `pkg`: it is the package, or a path or a `name@version`
 * with the package as a whole segment. `my-aider-fork` is not `aider`. The same rule as
 * `mentions_package` in `noren-core`.
 */
export function mentionsPackage(argument: string, pkg: string): boolean {
  const wanted = pkg.trim().toLowerCase().replaceAll("\\", "/");
  if (wanted === "") return false;
  const text = argument.trim().toLowerCase().replaceAll("\\", "/");
  const starts = [0];
  for (let i = text.indexOf("/"); i !== -1; i = text.indexOf("/", i + 1)) starts.push(i + 1);
  return starts.some((start) => {
    const rest = text.slice(start);
    if (rest === wanted) return true;
    if (!rest.startsWith(wanted)) return false;
    const next = rest[wanted.length];
    return next === "@" || next === "/" || next === ".";
  });
}

/**
 * Splits a command line into words the way a person reads it: spaces separate, a pair of quotes
 * (single or double) keeps its content together, `&&`, `||`, `;` and `|` end a command. A
 * backslash is not an escape (a Windows path stays whole). Nothing is expanded or executed.
 */
function commandsOf(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | undefined;
  const endWord = (): void => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === ";" || char === "|" || char === "\n") {
      endCommand();
    } else if (char === "&" && line.charAt(i + 1) === "&") {
      endCommand();
      i++;
    } else {
      word += char;
      started = true;
    }
  }
  endCommand();
  return commands;
}

/** Whether a word is `NAME=value`, which a shell takes as an environment variable of the command. */
const isAssignment = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

function entryOfCommand(words: string[], catalog: AgentCatalog): AgentEntry | undefined {
  let at = 0;
  while (at < words.length) {
    const word = words[at] ?? "";
    if (isAssignment(word) || PREFIX_WORDS.has(word.toLowerCase())) at++;
    else break;
  }
  const program = words[at];
  if (program === undefined) return undefined;
  const name = programName(program);
  if (name === "") return undefined;
  const direct = catalog.find((entry) => entry.executables.some((e) => programName(e) === name));
  if (direct !== undefined) return direct;
  if (!RUNNERS.has(name)) return undefined;
  const args = words.slice(at + 1);
  return catalog.find((entry) =>
    (entry.packages ?? []).some((pkg) => args.some((arg) => mentionsPackage(arg, pkg))),
  );
}

/**
 * The agent a command line starts, or `undefined`. `commandLine` is the text OSC 633;E reported
 * for the command that runs now. The program is the first word after variables and the words that
 * only run another command (`sudo`, `env`...); a folder and `.exe`/`.cmd` do not matter; arguments
 * are ignored, except for a runner (`npx`, `node`, `python`...), which counts when an argument is a
 * package the entry lists. In a line of several commands (`cd app && claude`) the first one that is
 * an agent counts. Only whole names match: `claudette` is not `claude`.
 */
export function detectAgentByCommand(
  commandLine: string | undefined,
  catalog: AgentCatalog,
): string | undefined {
  if (commandLine === undefined || commandLine.trim() === "") return undefined;
  for (const words of commandsOf(commandLine)) {
    const entry = entryOfCommand(words, catalog);
    if (entry !== undefined) return entry.id;
  }
  return undefined;
}

/**
 * The agent of a pane: the one its running command names, else the one the process tree of its
 * session shows. The command wins when both know, since it is what the person typed; the tree
 * covers an agent started some other way (a script, a shell function, another program).
 */
export function resolveAgent(
  commandAgent: string | undefined,
  treeAgent: string | undefined,
): string | undefined {
  return commandAgent ?? treeAgent;
}

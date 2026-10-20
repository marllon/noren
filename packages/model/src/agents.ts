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
/** Most patterns an agent may list for one state, and the longest pattern, in characters. */
export const MAX_AGENT_PATTERNS = 16;
export const MAX_AGENT_PATTERN_CHARS = 200;
/** Longest resume command line, in characters. */
export const MAX_AGENT_RESUME_CHARS = 200;
/** C0 control characters and DEL: a command line typed into a shell has none. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** How long an agent may be silent before it counts as idle: default, shortest and longest, in seconds. */
export const DEFAULT_AGENT_SILENCE_SECONDS = 8;
export const MIN_AGENT_SILENCE_SECONDS = 1;
export const MAX_AGENT_SILENCE_SECONDS = 3600;

/** An id: lower case letters, digits, `-` and `_`. It is the name the interface shows. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/** The name of an executable: no folder, no space. */
const EXECUTABLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** The name of a package as `npx` or `python -m` takes it, scope included. */
const PACKAGE_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._+-]*(\/[A-Za-z0-9][A-Za-z0-9._+-]*)?$/;

const NAME_LIMIT = { message: `At most ${MAX_AGENT_NAME_CHARS} characters` };

/** Flags every pattern is compiled with: case does not matter, `^` and `$` match at each line. */
export const AGENT_PATTERN_FLAGS = "im";

/** The regular expression a pattern text stands for, or `undefined` when it is not one. */
export function compileAgentPattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, AGENT_PATTERN_FLAGS);
  } catch {
    return undefined;
  }
}

const patternList = (description: string) =>
  z
    .array(
      z
        .string()
        .min(1, { message: "A pattern cannot be empty" })
        .max(MAX_AGENT_PATTERN_CHARS, {
          message: `At most ${MAX_AGENT_PATTERN_CHARS} characters`,
        })
        .refine((source) => compileAgentPattern(source) !== undefined, {
          message: "Not a valid regular expression",
        }),
    )
    .max(MAX_AGENT_PATTERNS)
    .optional()
    .meta({ description });

/** The words of the output that tell what an agent is doing, as regular expressions. */
export const AgentPatternsSchema = z
  .strictObject({
    working: patternList(
      "Output that means the agent is working (a status line such as a spinner with its interrupt hint). Wins over idle, and is beaten by waiting.",
    ),
    waiting: patternList(
      "Output that means the agent is asking you something (a permission question, a choice). The tab shows it as waiting for you. Without it, common yes/no questions count.",
    ),
    idle: patternList(
      "Output that means the agent finished and is ready for your next message (its input prompt). Without it, silence is what makes the agent idle.",
    ),
  })
  .meta({
    description:
      "Regular expressions (case-insensitive, ^ and $ match at each line) tried on what the agent prints, with colors and cursor moves removed.",
  });

export type AgentPatterns = z.infer<typeof AgentPatternsSchema>;

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
    patterns: AgentPatternsSchema.optional(),
    resume: z
      .string()
      .max(MAX_AGENT_RESUME_CHARS, { message: `At most ${MAX_AGENT_RESUME_CHARS} characters` })
      .refine((line) => line.trim() !== "", { message: "A resume command cannot be blank" })
      .refine((line) => !CONTROL_CHARACTERS.test(line), {
        message: "A resume command is one line of text: no line breaks or control characters",
      })
      .optional()
      .meta({
        description:
          'The full command line that takes the agent up where it stopped, such as "claude --continue". Noren types it, once, in a new shell of a tab that had this agent running when the machine restarted, and only when agents.resumeOnRestore is on. Without it the agent is not resumed.',
      }),
    silenceSeconds: z
      .number()
      .min(MIN_AGENT_SILENCE_SECONDS)
      .max(MAX_AGENT_SILENCE_SECONDS)
      .optional()
      .meta({
        description:
          "Seconds without output after which this agent counts as idle. Replaces agents.silenceSeconds for this agent.",
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

/**
 * The questions any program asks the same way, tried for an agent whose entry lists no `waiting`
 * patterns of its own: a yes/no choice, "press enter to continue", "do you want to proceed".
 */
export const DEFAULT_WAITING_PATTERNS: readonly string[] = [
  "[\\[(](y/n|yes/no)[\\])]",
  "\\([yn]\\)es\\s*/\\s*\\([yn]\\)o",
  "press (enter|return) to continue",
  "do you want to (proceed|continue)\\?",
];

/**
 * The agents Noren knows without being told, named by their executable. The patterns are the
 * words each prints at a state change (a status line, a permission question, the input prompt); a
 * program that words them differently is one entry in `config.jsonc` away.
 */
export const DEFAULT_AGENT_CATALOG: AgentCatalog = [
  {
    id: "claude",
    executables: ["claude"],
    resume: "claude --continue",
    patterns: {
      working: ["esc to interrupt"],
      waiting: ["do you want to (proceed|make this edit|create|run)", "\\b1\\. yes\\b"],
      idle: ["\\? for shortcuts"],
    },
  },
  {
    id: "codex",
    executables: ["codex"],
    patterns: {
      working: ["esc to interrupt"],
      waiting: ["would you like to run the following command", "allow command\\?"],
      idle: ["send a message|ask codex"],
    },
  },
  { id: "gemini", executables: ["gemini"] },
  { id: "opencode", executables: ["opencode"] },
  {
    id: "aider",
    executables: ["aider"],
    packages: ["aider"],
    patterns: {
      working: ["^(sending|streaming|tokens:|applied edit)"],
      waiting: ["\\(y\\)es/\\(n\\)o", "\\[(yes|no)\\]:\\s*$"],
      idle: ["^(architect|ask|code|help)?\\s*> ?$"],
    },
  },
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

/** Resuming agents after a restart is off unless the settings turn it on: it types a command for you. */
export const DEFAULT_RESUME_ON_RESTORE = false;

/** What the settings say about agents, with the defaults filled in. */
export interface AgentSettings {
  enabled: boolean;
  /** Whether a tab that had an agent running when the machine restarted gets its resume command. */
  resumeOnRestore: boolean;
  catalog: AgentCatalog;
  /** Milliseconds between two looks at the process tree. */
  scanIntervalMs: number;
  /** Milliseconds of silence after which an agent counts as idle, unless its entry says otherwise. */
  silenceMs: number;
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
        resumeOnRestore?: boolean | undefined;
        catalog?: AgentCatalog | undefined;
        scanSeconds?: number | undefined;
        silenceSeconds?: number | undefined;
      }
    | undefined,
): AgentSettings {
  const seconds = section?.scanSeconds;
  const usable =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= MIN_AGENT_SCAN_SECONDS;
  return {
    enabled: section?.enabled ?? DEFAULT_AGENTS_ENABLED,
    resumeOnRestore: section?.resumeOnRestore ?? DEFAULT_RESUME_ON_RESTORE,
    catalog: section?.catalog ?? DEFAULT_AGENT_CATALOG,
    scanIntervalMs: Math.round((usable ? seconds : DEFAULT_AGENT_SCAN_SECONDS) * 1000),
    silenceMs: silenceMsOf(section?.silenceSeconds),
  };
}

/** Milliseconds for a silence in seconds; a value outside the limits (or not a number) is the default. */
export function silenceMsOf(seconds: number | undefined): number {
  const usable =
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds >= MIN_AGENT_SILENCE_SECONDS &&
    seconds <= MAX_AGENT_SILENCE_SECONDS;
  return Math.round((usable ? seconds : DEFAULT_AGENT_SILENCE_SECONDS) * 1000);
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

import { z } from "zod";

// The task suite of the model bench (NOR-F16-01): the format of one task, the check that decides
// whether an answer is right, and the validator of the whole suite. Pure: no DOM, no Tauri, no
// files (the test reads `bench/tasks`) and no network. The check NEVER runs a command: it compares
// text, so a model's answer is read and never executed (D8).

export type BenchShell = "pwsh" | "bash";
export type BenchKind = "command" | "explain" | "summarize";

/** The shape of the suite, checked by the suite test: 60 tasks, 20 of them commands. */
export const BENCH_DISTRIBUTION = {
  total: 60,
  command: { pwsh: 10, bash: 10 },
  explain: 20,
  summarize: 20,
} as const;

const textList = z.array(z.string().min(1));

// How a command answer is compared with the accepted forms. Both sides go through the same
// steps: the line is split into words (quotes removed, `|`, `;`, `&&`, `>` and parentheses are
// words of their own, so spaces around them do not matter), a PowerShell line is lower-cased,
// short flags are split when `splitShortFlags` says so, the words of an alias group become the
// first word of the group, and with `flagOrder: "any"` the flags of each stage are sorted.
const commandCheckSchema = z.strictObject({
  /** Accepted forms of the command (at least one); the answer is right when it equals one of them. */
  accept: z.array(z.string().min(1)).min(1),
  /** Groups of words that mean the same thing (`ls`, `dir`, `Get-ChildItem`); the first is the one kept. */
  aliases: z.array(z.array(z.string().min(1)).min(2)).optional(),
  /** `fixed` (the default) keeps the order of the words; `any` lets the flags of a stage come in any order. */
  flagOrder: z.enum(["fixed", "any"]).optional(),
  /** Flags that take the word after them (`-Filter *.log`), so that the value travels with the flag. */
  flagsWithValue: textList.optional(),
  /** Split a bundle of short flags (`-lat` is `-l -a -t`); only for tools that read them that way. */
  splitShortFlags: z.boolean().optional(),
  /** Words that must not appear anywhere in the answer. */
  forbidden: textList.optional(),
});

// What an explanation or a summary must hold, compared as lower-cased text without caring for
// spaces: every group of `required` needs one of its alternatives, none of `forbidden` may appear.
// A term matches at the start of a word (`permission` matches `permissions`, `rm` not `format`).
const textCheckSchema = z.strictObject({
  required: z.array(textList.min(1)).min(1),
  forbidden: textList.optional(),
  /** The most words the answer may have (a summary is short). */
  maxWords: z.number().int().positive().optional(),
});

const examplesSchema = z.strictObject({
  /** Sample answers that the check must accept. */
  pass: z.array(z.string()).min(1),
  /** Sample answers that the check must refuse (an empty answer is a fine one). */
  fail: z.array(z.string()).min(1),
});

const idSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "an id is lower-case words joined by dashes");

export const benchTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: idSchema,
    kind: z.literal("command"),
    shell: z.enum(["pwsh", "bash"]),
    prompt: z.string().min(1),
    input: z.string().min(1).optional(),
    check: commandCheckSchema,
    examples: examplesSchema,
  }),
  z.strictObject({
    id: idSchema,
    kind: z.literal("explain"),
    prompt: z.string().min(1),
    input: z.string().min(1).optional(),
    check: textCheckSchema,
    examples: examplesSchema,
  }),
  z.strictObject({
    id: idSchema,
    kind: z.literal("summarize"),
    prompt: z.string().min(1),
    input: z.string().min(1).optional(),
    check: textCheckSchema,
    examples: examplesSchema,
  }),
]);

export type BenchTask = z.infer<typeof benchTaskSchema>;
export type CommandBenchTask = Extract<BenchTask, { kind: "command" }>;
export type BenchResult = { ok: true } | { ok: false; reason: string };

const OK: BenchResult = { ok: true };
const fail = (reason: string): BenchResult => ({ ok: false, reason });

// ---- Commands ----

interface Token {
  text: string;
  /** An operator (`|`, `&&`, `;`, `>`, a parenthesis) found outside quotes; a quoted one is plain text. */
  op: boolean;
}

const OPERATOR_CHARS = "|&;<>";
const PAREN_CHARS = "()";

/** Splits a command line into words the way the shell does, without running anything. */
function tokenize(line: string, shell: BenchShell): Token[] | { error: string } {
  const tokens: Token[] = [];
  const escape = shell === "pwsh" ? "`" : "\\";
  let cur = "";
  let has = false;
  const flush = (): void => {
    if (has) tokens.push({ text: cur, op: false });
    cur = "";
    has = false;
  };
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (/\s/.test(ch)) {
      flush();
      i += 1;
    } else if (ch === "'") {
      has = true;
      i += 1;
      for (;;) {
        if (i >= line.length) return { error: "unterminated quote" };
        const c = line.charAt(i);
        if (c === "'") {
          if (shell === "pwsh" && line.charAt(i + 1) === "'") {
            cur += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        cur += c;
        i += 1;
      }
    } else if (ch === '"') {
      has = true;
      i += 1;
      for (;;) {
        if (i >= line.length) return { error: "unterminated quote" };
        const c = line.charAt(i);
        if (c === '"') {
          if (shell === "pwsh" && line.charAt(i + 1) === '"') {
            cur += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (c === escape && i + 1 < line.length) {
          const next = line.charAt(i + 1);
          if (shell === "pwsh" || '"\\$`'.includes(next)) {
            cur += next;
            i += 2;
            continue;
          }
        }
        cur += c;
        i += 1;
      }
    } else if (ch === escape) {
      has = true;
      if (i + 1 < line.length) {
        cur += line.charAt(i + 1);
        i += 2;
      } else {
        cur += ch;
        i += 1;
      }
    } else if (OPERATOR_CHARS.includes(ch)) {
      flush();
      let run = "";
      while (i < line.length && OPERATOR_CHARS.includes(line.charAt(i))) {
        run += line.charAt(i);
        i += 1;
      }
      tokens.push({ text: run, op: true });
    } else if (PAREN_CHARS.includes(ch)) {
      flush();
      tokens.push({ text: ch, op: true });
      i += 1;
    } else {
      cur += ch;
      has = true;
      i += 1;
    }
  }
  flush();
  return tokens;
}

type CommandCheck = CommandBenchTask["check"];

function foldFor(shell: BenchShell): (text: string) => string {
  return shell === "pwsh" ? (text) => text.toLowerCase() : (text) => text;
}

function aliasMap(check: CommandCheck, fold: (text: string) => string): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of check.aliases ?? []) {
    const head = fold(group[0] ?? "");
    for (const word of group) map.set(fold(word), head);
  }
  return map;
}

const isFlag = (text: string): boolean => text.length > 1 && text.startsWith("-");

/** The words of `line` in a form that is equal for two lines that mean the same, or the reason it cannot be read. */
function canonicalCommand(
  line: string,
  shell: BenchShell,
  check: CommandCheck,
): { key: string; words: string[] } | { error: string } {
  const tokens = tokenize(line, shell);
  if ("error" in tokens) return tokens;
  const fold = foldFor(shell);
  const aliases = aliasMap(check, fold);
  const withValue = new Set((check.flagsWithValue ?? []).map(fold));
  const words: string[] = [];
  const stages: string[][] = [[]];
  const parts: (string | number)[] = [];
  for (const token of tokens) {
    if (token.op) {
      stages.push([]);
      parts.push(stages.length - 2, `\u0001${token.text}`);
      continue;
    }
    const folded = fold(token.text);
    const pieces =
      check.splitShortFlags === true && /^-[A-Za-z]{2,}$/.test(token.text)
        ? [...token.text.slice(1)].map((letter) => `-${fold(letter)}`)
        : [folded];
    for (const piece of pieces) {
      const word = aliases.get(piece) ?? piece;
      words.push(word);
      stages[stages.length - 1]?.push(word);
    }
  }
  parts.push(stages.length - 1);
  const rendered = parts.map((part) => {
    if (typeof part === "string") return part;
    const stage = stages[part] ?? [];
    if (check.flagOrder !== "any") return stage.join("\u0000");
    const positionals: string[] = [];
    const flags: string[] = [];
    for (let k = 0; k < stage.length; k += 1) {
      const word = stage[k] ?? "";
      if (!isFlag(word)) {
        positionals.push(word);
      } else if (withValue.has(word) && k + 1 < stage.length) {
        flags.push(`${word}\u0002${stage[k + 1] ?? ""}`);
        k += 1;
      } else {
        flags.push(word);
      }
    }
    return [...positionals, ...flags.sort()].join("\u0000");
  });
  return { key: rendered.join("\u0003"), words };
}

/** Takes the command out of what a model wrote around it: a code fence, backticks, a prompt mark. */
function commandLine(answer: string): { line: string } | { error: string } {
  let text = answer.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)?.[1];
  if (fenced !== undefined) {
    text = fenced.trim();
  } else if (/^`[^`\n]+`$/.test(text)) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^(?:PS[^>\n]*>\s*|\$\s+|>\s+)/, "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0];
  if (first === undefined) return { error: "the answer is empty" };
  if (lines.length > 1) return { error: "the answer is more than one line; a command is one line" };
  return { line: first };
}

function checkCommand(task: CommandBenchTask, answer: string): BenchResult {
  const line = commandLine(answer);
  if ("error" in line) return fail(line.error);
  const { check, shell } = task;
  const got = canonicalCommand(line.line, shell, check);
  if ("error" in got) return fail(got.error);
  const fold = foldFor(shell);
  const aliases = aliasMap(check, fold);
  for (const bad of check.forbidden ?? []) {
    const folded = fold(bad);
    const word = aliases.get(folded) ?? folded;
    if (got.words.includes(word)) return fail(`uses the forbidden word "${bad}"`);
  }
  for (const form of check.accept) {
    const want = canonicalCommand(form, shell, check);
    if (!("error" in want) && want.key === got.key) return OK;
  }
  return fail("is not one of the accepted forms of the command");
}

// ---- Explanations and summaries ----

function normalizeText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether `term` is in `text` starting at the start of a word (both already normalized). */
function hasTerm(text: string, term: string): boolean {
  if (term === "") return false;
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}_]/u.test(text.charAt(at - 1))) return true;
  }
  return false;
}

function checkText(
  check: Extract<BenchTask, { kind: "explain" }>["check"],
  answer: string,
): BenchResult {
  const text = normalizeText(answer);
  if (text === "") return fail("the answer is empty");
  if (check.maxWords !== undefined) {
    const words = text.split(" ").length;
    if (words > check.maxWords)
      return fail(`has ${words} words; at most ${check.maxWords} are allowed`);
  }
  for (const bad of check.forbidden ?? []) {
    if (hasTerm(text, normalizeText(bad))) return fail(`contains the forbidden term "${bad}"`);
  }
  for (const group of check.required) {
    if (!group.some((alternative) => hasTerm(text, normalizeText(alternative)))) {
      return fail(`misses one of: ${group.join(" | ")}`);
    }
  }
  return OK;
}

/**
 * Decides whether `answer` is a right answer to `task`. A command answer is compared with the
 * accepted forms; an explanation or a summary is checked for its required and forbidden terms.
 * It only reads text: it never runs the command (D8).
 */
export function checkBenchAnswer(task: BenchTask, answer: string): BenchResult {
  return task.kind === "command" ? checkCommand(task, answer) : checkText(task.check, answer);
}

// ---- The suite ----

export interface BenchSuiteFile {
  /** The file name, for example `cmd-bash-01.json`. */
  name: string;
  /** What the file holds. */
  text: string;
}

export interface BenchSuiteReport {
  /** The tasks that could be read, in the order of the file names. */
  tasks: BenchTask[];
  /** What is wrong with the suite, one line each; empty when every task and the suite are valid. */
  problems: string[];
}

function idPrefix(task: BenchTask): string {
  return task.kind === "command" ? `cmd-${task.shell}-` : `${task.kind}-`;
}

/**
 * Reads the files of `bench/tasks` and checks them: each is valid JSON of the task format, its id
 * is its file name and starts with its kind, ids are unique and so is each prompt with its input, every accepted form of a
 * command passes its own check, every `pass` example passes, every `fail` example is refused (the
 * check is run on the content, not only the shape), and the count of each kind is the declared one.
 */
export function checkBenchSuite(files: readonly BenchSuiteFile[]): BenchSuiteReport {
  const problems: string[] = [];
  const tasks: BenchTask[] = [];
  const ids = new Set<string>();
  const prompts = new Set<string>();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.name.endsWith(".json")) {
      problems.push(`${file.name}: a task file ends with .json`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(file.text);
    } catch {
      problems.push(`${file.name}: not valid JSON`);
      continue;
    }
    const parsed = benchTaskSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${file.name}: ${issue.path.join(".") || "(task)"}: ${issue.message}`);
      }
      continue;
    }
    const task = parsed.data;
    tasks.push(task);
    if (file.name !== `${task.id}.json`)
      problems.push(`${file.name}: the id "${task.id}" is not the file name`);
    if (!task.id.startsWith(idPrefix(task))) {
      problems.push(`${file.name}: the id of a ${task.kind} task starts with "${idPrefix(task)}"`);
    }
    if (ids.has(task.id)) problems.push(`${file.name}: the id "${task.id}" is used twice`);
    ids.add(task.id);
    const asked = `${task.prompt}\u0000${task.input ?? ""}`;
    if (prompts.has(asked))
      problems.push(`${file.name}: the prompt and input are those of another task`);
    prompts.add(asked);
    if (task.kind === "command") {
      for (const form of task.check.accept) {
        const own = checkBenchAnswer(task, form);
        if (!own.ok)
          problems.push(
            `${file.name}: the accepted form "${form}" fails its own check: ${own.reason}`,
          );
      }
    }
    for (const answer of task.examples.pass) {
      const result = checkBenchAnswer(task, answer);
      if (!result.ok)
        problems.push(`${file.name}: the pass example "${answer}" is refused: ${result.reason}`);
    }
    for (const answer of task.examples.fail) {
      if (checkBenchAnswer(task, answer).ok)
        problems.push(`${file.name}: the fail example "${answer}" is accepted`);
    }
  }
  const count = (match: (task: BenchTask) => boolean): number => tasks.filter(match).length;
  const want = BENCH_DISTRIBUTION;
  const shape: [string, number, number][] = [
    ["tasks", tasks.length, want.total],
    [
      "pwsh command tasks",
      count((t) => t.kind === "command" && t.shell === "pwsh"),
      want.command.pwsh,
    ],
    [
      "bash command tasks",
      count((t) => t.kind === "command" && t.shell === "bash"),
      want.command.bash,
    ],
    ["explain tasks", count((t) => t.kind === "explain"), want.explain],
    ["summarize tasks", count((t) => t.kind === "summarize"), want.summarize],
  ];
  for (const [label, got, expected] of shape) {
    if (got !== expected) problems.push(`the suite has ${got} ${label}; ${expected} are declared`);
  }
  return { tasks, problems };
}

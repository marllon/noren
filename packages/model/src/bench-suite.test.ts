/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BENCH_DISTRIBUTION,
  benchTaskSchema,
  checkBenchAnswer,
  checkBenchSuite,
  type BenchSuiteFile,
  type BenchTask,
  type CommandBenchTask,
} from "./bench-suite";

// The suite in `bench/tasks` (NOR-F16-01), read from disk like config-schema.test.ts reads its file:
// the shape of every task, its id, the declared count of each kind, and, above all, the content:
// the check is run on every example, so a task whose check accepts a wrong answer (or refuses a
// right one) fails here and not later in the runner.

const TASKS_DIR = new URL("../../../bench/tasks/", import.meta.url);

function readSuite(): BenchSuiteFile[] {
  return readdirSync(TASKS_DIR)
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, TASKS_DIR), "utf8") }));
}

// Names of products of other makers that must not be in a task (shell tools such as git, docker or
// npm are fine). A word list for the obvious ones, not a promise to catch every name.
const THIRD_PARTY_NAMES = [
  "chatgpt",
  "openai",
  "anthropic",
  "claude",
  "gemini",
  "copilot",
  "warp",
  "iterm",
  "wezterm",
  "alacritty",
  "chrome",
  "firefox",
  "safari",
  "github",
  "gitlab",
  "nginx",
];

describe("bench/tasks", () => {
  const files = readSuite();
  const report = checkBenchSuite(files);

  it("has no problem: every file is a valid task, its id is its file name, and the count of each kind is the declared one", () => {
    expect(report.problems).toEqual([]);
  });

  it("holds the declared 60 tasks: 20 commands (10 for pwsh, 10 for bash), 20 explanations, 20 summaries", () => {
    expect(BENCH_DISTRIBUTION.total).toBe(60);
    expect(files).toHaveLength(60);
    expect(report.tasks).toHaveLength(60);
    const commands = report.tasks.filter((task) => task.kind === "command");
    expect(commands.filter((task) => task.shell === "pwsh")).toHaveLength(10);
    expect(commands.filter((task) => task.shell === "bash")).toHaveLength(10);
    expect(report.tasks.filter((task) => task.kind === "explain")).toHaveLength(20);
    expect(report.tasks.filter((task) => task.kind === "summarize")).toHaveLength(20);
  });

  it("uses an id equal to the file name, and every id once", () => {
    expect(files.map((file) => file.name)).toEqual(report.tasks.map((task) => `${task.id}.json`));
    expect(new Set(report.tasks.map((task) => task.id)).size).toBe(report.tasks.length);
  });

  it("has an input for every explanation and summary (the error or the output to read)", () => {
    for (const task of report.tasks) {
      if (task.kind !== "command") expect(task.input, task.id).toBeDefined();
    }
  });

  it("gives every task a few examples of each side", () => {
    for (const task of report.tasks) {
      expect(task.examples.pass.length, task.id).toBeGreaterThanOrEqual(2);
      expect(task.examples.fail.length, task.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("names no product of another maker", () => {
    for (const file of files) {
      const text = file.text.toLowerCase();
      for (const name of THIRD_PARTY_NAMES) {
        expect(new RegExp(`\\b${name}\\b`).test(text), `${file.name} mentions ${name}`).toBe(false);
      }
    }
  });

  for (const task of report.tasks) {
    it(`${task.id}: every pass example passes and every fail example is refused`, () => {
      for (const answer of task.examples.pass) {
        expect(checkBenchAnswer(task, answer), `pass: ${answer}`).toEqual({ ok: true });
      }
      for (const answer of task.examples.fail) {
        expect(checkBenchAnswer(task, answer), `fail: ${answer}`).toMatchObject({ ok: false });
      }
    });
  }

  it("refuses every empty answer", () => {
    for (const task of report.tasks) {
      expect(checkBenchAnswer(task, ""), task.id).toMatchObject({ ok: false });
      expect(checkBenchAnswer(task, "  \n "), task.id).toMatchObject({ ok: false });
    }
  });

  it("does not take the answer of another task of the same kind", () => {
    // A pass example of a task is a wrong answer to most tasks of the same kind: the checks are not so loose that anything fits.
    const accepted: string[] = [];
    let tried = 0;
    for (const task of report.tasks) {
      for (const other of report.tasks) {
        if (other.id === task.id || other.kind !== task.kind) continue;
        if (task.kind === "command" && other.kind === "command" && task.shell !== other.shell)
          continue;
        tried += 1;
        if (checkBenchAnswer(task, other.examples.pass[0] ?? "").ok) {
          accepted.push(`${task.id} accepts the answer of ${other.id}`);
        }
      }
    }
    expect(tried).toBeGreaterThan(500);
    expect(accepted).toEqual([]);
  });
});

describe("the check never runs a command (D8)", () => {
  it("imports nothing that can start a process", () => {
    const source = readFileSync(new URL("./bench-suite.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /child_process|from "node:|spawn|execSync|execFile|eval\(|new Function/,
    );
  });

  it("answers a destructive command by comparing text only", () => {
    const task = commandTask({ accept: ["echo hello"] });
    expect(checkBenchAnswer(task, "rm -rf /")).toMatchObject({ ok: false });
    expect(checkBenchAnswer(task, "echo hello")).toEqual({ ok: true });
  });
});

function commandTask(
  check: CommandBenchTask["check"],
  shell: "pwsh" | "bash" = "bash",
): CommandBenchTask {
  return {
    id: "cmd-test-01",
    kind: "command",
    shell,
    prompt: "A command.",
    check,
    examples: { pass: [check.accept[0] ?? ""], fail: ["nope"] },
  };
}

function textTask(check: Extract<BenchTask, { kind: "explain" }>["check"]): BenchTask {
  return {
    id: "explain-test-01",
    kind: "explain",
    prompt: "Explain.",
    check,
    examples: { pass: ["x"], fail: ["y"] },
  };
}

describe("checking a command", () => {
  it("ignores extra spaces and tabs, and the quotes around a word", () => {
    const task = commandTask({ accept: ["grep -n 'a b' file.txt"] });
    expect(checkBenchAnswer(task, 'grep   -n\t"a b"   file.txt  ')).toEqual({ ok: true });
    expect(checkBenchAnswer(task, "grep -n 'a  b' file.txt")).toMatchObject({ ok: false });
    expect(checkBenchAnswer(task, "grep -n a b file.txt")).toMatchObject({ ok: false });
  });

  it("keeps the order of the words unless the flags are declared free", () => {
    const fixed = commandTask({ accept: ["ls -l -a"] });
    expect(checkBenchAnswer(fixed, "ls -a -l")).toMatchObject({ ok: false });
    const free = commandTask({ accept: ["ls -l -a"], flagOrder: "any" });
    expect(checkBenchAnswer(free, "ls -a -l")).toEqual({ ok: true });
    expect(checkBenchAnswer(free, "ls -a")).toMatchObject({ ok: false });
  });

  it("moves a flag with its value, and a flag does not eat a word that is not its value", () => {
    const task = commandTask({
      accept: ["cp -t out a.txt"],
      flagOrder: "any",
      flagsWithValue: ["-t"],
    });
    expect(checkBenchAnswer(task, "cp a.txt -t out")).toEqual({ ok: true });
    expect(checkBenchAnswer(task, "cp -t a.txt out")).toMatchObject({ ok: false });
  });

  it("splits a bundle of short flags only when asked", () => {
    const split = commandTask({ accept: ["ls -l -a"], flagOrder: "any", splitShortFlags: true });
    expect(checkBenchAnswer(split, "ls -al")).toEqual({ ok: true });
    const plain = commandTask({ accept: ["ls -l -a"], flagOrder: "any" });
    expect(checkBenchAnswer(plain, "ls -al")).toMatchObject({ ok: false });
  });

  it("treats the words of an alias group as one", () => {
    const task = commandTask({ accept: ["ls -l"], aliases: [["ls", "dir"]] });
    expect(checkBenchAnswer(task, "dir -l")).toEqual({ ok: true });
    expect(checkBenchAnswer(task, "cat -l")).toMatchObject({ ok: false });
  });

  it("is case-sensitive in bash and not in pwsh", () => {
    expect(checkBenchAnswer(commandTask({ accept: ["ls -R"] }), "ls -r")).toMatchObject({
      ok: false,
    });
    expect(checkBenchAnswer(commandTask({ accept: ["Get-Date"] }, "pwsh"), "get-date")).toEqual({
      ok: true,
    });
  });

  it("sees an operator with or without spaces around it, and not one inside quotes", () => {
    const task = commandTask({ accept: ["cat a | wc -l"] });
    expect(checkBenchAnswer(task, "cat a|wc -l")).toEqual({ ok: true });
    expect(checkBenchAnswer(task, "cat a '|' wc -l")).toMatchObject({ ok: false });
    expect(checkBenchAnswer(task, "cat a || wc -l")).toMatchObject({ ok: false });
  });

  it("takes the command out of a code fence, backticks and a prompt mark", () => {
    const task = commandTask({ accept: ["ls -l"] });
    expect(checkBenchAnswer(task, "```bash\nls -l\n```")).toEqual({ ok: true });
    expect(checkBenchAnswer(task, "`ls -l`")).toEqual({ ok: true });
    expect(checkBenchAnswer(task, "$ ls -l")).toEqual({ ok: true });
    const pwsh = commandTask({ accept: ["Get-Date"] }, "pwsh");
    expect(checkBenchAnswer(pwsh, "PS C:\\Users\\ana> Get-Date")).toEqual({ ok: true });
  });

  it("refuses an empty answer, an answer of several lines and an unterminated quote, with a reason", () => {
    const task = commandTask({ accept: ["ls -l"] });
    expect(checkBenchAnswer(task, "")).toEqual({ ok: false, reason: "the answer is empty" });
    expect(checkBenchAnswer(task, "ls -l\nls -l")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("one line"),
    });
    expect(checkBenchAnswer(task, "ls -l 'x")).toEqual({ ok: false, reason: "unterminated quote" });
  });

  it("refuses a forbidden word even in an accepted form, and sees an alias of it", () => {
    const task = commandTask({
      accept: ["ls -l", "sudo ls -l"],
      aliases: [["rm", "del"]],
      forbidden: ["sudo", "del"],
    });
    expect(checkBenchAnswer(task, "sudo ls -l")).toEqual({
      ok: false,
      reason: 'uses the forbidden word "sudo"',
    });
    expect(checkBenchAnswer(task, "rm")).toEqual({
      ok: false,
      reason: 'uses the forbidden word "del"',
    });
    expect(checkBenchAnswer(task, "ls -l")).toEqual({ ok: true });
  });

  it("reads the escapes of each shell: a backslash in bash, a backtick in pwsh, '' in a pwsh string", () => {
    expect(checkBenchAnswer(commandTask({ accept: ["echo a\\ b"] }), 'echo "a b"')).toEqual({
      ok: true,
    });
    expect(checkBenchAnswer(commandTask({ accept: ["echo 'a b'"] }, "pwsh"), "echo a` b")).toEqual({
      ok: true,
    });
    expect(
      checkBenchAnswer(commandTask({ accept: ['echo "it\'s"'] }, "pwsh"), "echo 'it''s'"),
    ).toEqual({ ok: true });
  });

  it("ignores extra white space between the words (property)", () => {
    const words = ["find", "/var/log", "-name", "*.log", "-mtime", "-1"];
    const task = commandTask({ accept: [words.join(" ")], flagsWithValue: ["-name", "-mtime"] });
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(" ", "  ", "\t", "   ", " \t "), { minLength: 5, maxLength: 5 }),
        fc.constantFrom("", " ", "\t", "  "),
        fc.constantFrom("", " ", "\n"),
        (gaps, before, after) => {
          const line =
            words.reduce((acc, word, index) => acc + (gaps[index - 1] ?? "") + word, before) +
            after;
          return checkBenchAnswer(task, line).ok;
        },
      ),
    );
  });

  it("takes the free flags in any order (property)", () => {
    const task = commandTask({ accept: ["cmd -a -b -c x"], flagOrder: "any" });
    fc.assert(
      fc.property(
        fc.shuffledSubarray(["-a", "-b", "-c"], { minLength: 3, maxLength: 3 }),
        (flags) => checkBenchAnswer(task, `cmd ${flags.join(" ")} x`).ok,
      ),
    );
    fc.assert(
      fc.property(
        fc.shuffledSubarray(["-a", "-b", "-c"], { minLength: 0, maxLength: 2 }),
        (flags) => !checkBenchAnswer(task, `cmd ${flags.join(" ")} x`).ok,
      ),
    );
  });

  it("is not thrown off by a line of any text: it answers, never throws (property)", () => {
    const task = commandTask({ accept: ["ls -l"], flagOrder: "any", splitShortFlags: true });
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (answer) => {
        const result = checkBenchAnswer(task, answer);
        return result.ok || result.reason.length > 0;
      }),
    );
  });
});

describe("checking an explanation or a summary", () => {
  const task = textTask({
    required: [
      ["permission", "not allowed"],
      ["chmod", "executable"],
    ],
    forbidden: ["reboot"],
    maxWords: 12,
  });

  it("does not care about case or spacing", () => {
    expect(checkBenchAnswer(task, "NO  PERMISSION:\n use  CHMOD")).toEqual({ ok: true });
  });

  it("needs one alternative of every group and says which group is missing", () => {
    expect(checkBenchAnswer(task, "It is not allowed.")).toEqual({
      ok: false,
      reason: "misses one of: chmod | executable",
    });
    expect(checkBenchAnswer(task, "Make it executable.")).toEqual({
      ok: false,
      reason: "misses one of: permission | not allowed",
    });
  });

  it("matches a term at the start of a word, so a longer word counts and a part of a word does not", () => {
    expect(checkBenchAnswer(task, "The permissions are executable.")).toEqual({ ok: true });
    const word = textTask({ required: [["rm"]] });
    expect(checkBenchAnswer(word, "use rm now")).toEqual({ ok: true });
    expect(checkBenchAnswer(word, "format the disk")).toMatchObject({ ok: false });
  });

  it("refuses a forbidden term and an answer that is too long", () => {
    expect(checkBenchAnswer(task, "permission executable, then reboot")).toEqual({
      ok: false,
      reason: 'contains the forbidden term "reboot"',
    });
    const long = "permission executable " + "word ".repeat(12);
    expect(checkBenchAnswer(task, long)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("at most 12"),
    });
  });

  it("refuses an empty answer and matches a term with symbols", () => {
    expect(checkBenchAnswer(task, "   ")).toEqual({ ok: false, reason: "the answer is empty" });
    const symbols = textTask({ required: [["--allow-x"], ["97%"]] });
    expect(checkBenchAnswer(symbols, "use --allow-x at 97% full")).toEqual({ ok: true });
  });

  it("does not change its answer when the case of the text changes (property)", () => {
    const loose = textTask({ required: [["permission"], ["chmod"]], forbidden: ["reboot"] });
    fc.assert(
      fc.property(
        fc.constantFrom(
          "no permission, use chmod",
          "chmod fixes the permission",
          "reboot: permission chmod",
        ),
        (text) => {
          const lower = checkBenchAnswer(loose, text.toLowerCase());
          const upper = checkBenchAnswer(loose, text.toUpperCase());
          return lower.ok === upper.ok;
        },
      ),
    );
  });
});

describe("the task format", () => {
  const valid = {
    id: "explain-01",
    kind: "explain",
    prompt: "Explain.",
    input: "error",
    check: { required: [["a"]] },
    examples: { pass: ["a"], fail: ["b"] },
  };

  it("accepts a valid task of each kind", () => {
    expect(benchTaskSchema.safeParse(valid).success).toBe(true);
    expect(
      benchTaskSchema.safeParse({
        id: "cmd-bash-01",
        kind: "command",
        shell: "bash",
        prompt: "Do it.",
        check: { accept: ["ls"] },
        examples: { pass: ["ls"], fail: ["pwd"] },
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown field, a shell outside a command, a command without a shell, and a bad id", () => {
    expect(benchTaskSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(benchTaskSchema.safeParse({ ...valid, shell: "bash" }).success).toBe(false);
    expect(
      benchTaskSchema.safeParse({ ...valid, kind: "command", check: { accept: ["ls"] } }).success,
    ).toBe(false);
    expect(benchTaskSchema.safeParse({ ...valid, id: "Explain 01" }).success).toBe(false);
  });

  it("refuses a check of the wrong kind, an empty group and missing examples", () => {
    expect(benchTaskSchema.safeParse({ ...valid, check: { accept: ["ls"] } }).success).toBe(false);
    expect(benchTaskSchema.safeParse({ ...valid, check: { required: [[]] } }).success).toBe(false);
    expect(benchTaskSchema.safeParse({ ...valid, check: { required: [] } }).success).toBe(false);
    expect(
      benchTaskSchema.safeParse({ ...valid, examples: { pass: ["a"], fail: [] } }).success,
    ).toBe(false);
  });
});

describe("checkBenchSuite", () => {
  function file(task: object, name?: string): BenchSuiteFile {
    const id = (task as { id: string }).id;
    return { name: name ?? `${id}.json`, text: JSON.stringify(task) };
  }
  const explain = (id: string, over: object = {}): object => ({
    id,
    kind: "explain",
    prompt: `Explain ${id}.`,
    input: "error",
    check: { required: [["alpha"]] },
    examples: { pass: ["alpha"], fail: ["beta"] },
    ...over,
  });

  it("reports a pass example that the check refuses (the content is run, not only the shape)", () => {
    const report = checkBenchSuite([
      file(explain("explain-01", { examples: { pass: ["gamma"], fail: ["beta"] } })),
    ]);
    expect(report.problems).toContainEqual(
      expect.stringContaining('the pass example "gamma" is refused'),
    );
  });

  it("reports a fail example that the check accepts", () => {
    const report = checkBenchSuite([
      file(explain("explain-01", { examples: { pass: ["alpha"], fail: ["alpha too"] } })),
    ]);
    expect(report.problems).toContainEqual(
      expect.stringContaining('the fail example "alpha too" is accepted'),
    );
  });

  it("reports an accepted form of a command that fails its own check", () => {
    const report = checkBenchSuite([
      file({
        id: "cmd-bash-01",
        kind: "command",
        shell: "bash",
        prompt: "Do it.",
        check: { accept: ["ls 'x"] },
        examples: { pass: ["ls"], fail: ["pwd"] },
      }),
    ]);
    expect(report.problems).toContainEqual(
      expect.stringContaining("fails its own check: unterminated quote"),
    );
  });

  it("reports an id that is not the file name, an id that does not start with its kind, and a repeated id or prompt", () => {
    const report = checkBenchSuite([
      file(explain("explain-01"), "explain-02.json"),
      file(explain("summarize-01")),
      file(explain("explain-03", { prompt: "Explain explain-01." })),
    ]);
    expect(report.problems).toContainEqual(
      expect.stringContaining('the id "explain-01" is not the file name'),
    );
    expect(report.problems).toContainEqual(expect.stringContaining('starts with "explain-"'));
    expect(report.problems).toContainEqual(
      expect.stringContaining("the prompt and input are those of another task"),
    );
    const twice = checkBenchSuite([
      file(explain("explain-01")),
      file(explain("explain-01"), "explain-01.json"),
    ]);
    expect(twice.problems).toContainEqual(expect.stringContaining('"explain-01" is used twice'));
  });

  it("reports bad JSON, a bad shape, a file that is not .json, and a count that is not the declared one", () => {
    const report = checkBenchSuite([
      { name: "a.json", text: "{" },
      { name: "b.json", text: "{}" },
      { name: "notes.txt", text: "" },
    ]);
    expect(report.problems).toContainEqual("a.json: not valid JSON");
    expect(report.problems).toContainEqual(expect.stringContaining("b.json: kind:"));
    expect(report.problems).toContainEqual("notes.txt: a task file ends with .json");
    expect(report.problems).toContainEqual("the suite has 0 tasks; 60 are declared");
    expect(report.problems).toContainEqual("the suite has 0 pwsh command tasks; 10 are declared");
  });

  it("reports nothing for a task that is right", () => {
    const report = checkBenchSuite([file(explain("explain-01"))]);
    expect(report.problems.filter((line) => !line.startsWith("the suite has"))).toEqual([]);
    expect(report.tasks).toHaveLength(1);
  });
});

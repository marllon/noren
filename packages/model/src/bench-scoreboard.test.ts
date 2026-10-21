/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AiProviderInfo } from "./ai";
import { MAX_AI_MODEL } from "./ai";
import { benchStampOfStartedAt, type SavedBenchRun } from "./bench-results";
import {
  BENCH_RUN_VERSION,
  benchMessages,
  benchRunSchema,
  runBench,
  summarizeBenchTasks,
  type BenchRun,
  type BenchTaskRun,
} from "./bench-runner";
import {
  BENCH_CSV_HEADER,
  benchCsvText,
  benchDefaultEdits,
  benchScoreboard,
  benchScoreboardCsv,
  knownAiProviderIds,
  recommendBenchModel,
  type BenchScoreRow,
} from "./bench-scoreboard";
import { checkBenchSuite, type BenchKind, type BenchTask } from "./bench-suite";
import { parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import { FakeBackend } from "./fake-backend";

// The scoreboard of the bench (NOR-F16-03a): one row for each model from its newest run, the model
// recommended as the default, the edits that make a model the default, and the CSV. The runs are
// real ones made by `runBench` against the fake provider, or built by hand and checked with
// `benchRunSchema`, so every run here is one the app could have saved.

const TASKS_DIR = new URL("../../../bench/tasks/", import.meta.url);

function readSuite(): BenchTask[] {
  const files = readdirSync(TASKS_DIR)
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, TASKS_DIR), "utf8") }));
  const report = checkBenchSuite(files);
  expect(report.problems).toEqual([]);
  return report.tasks;
}

const SUITE = readSuite();
const KINDS: readonly BenchKind[] = ["command", "explain", "summarize"];

// ---- Runs ----

interface RunSpec {
  provider?: string;
  model?: string;
  /** ISO time the run started. */
  at?: string;
  /** Tasks that passed, out of `done`. */
  passed?: number;
  /** Tasks the run did (6 planned). */
  done?: number;
  state?: "complete" | "cancelled";
  /** The total time of every task, in ms. */
  totalMs?: number;
  /** `false`: no task has a time (every call failed). */
  answered?: boolean;
  bytes?: number | null;
  source?: "stream" | "estimate";
}

const PLANNED = 6;

/** A run built by hand: tasks cycle through the three kinds, the first `passed` ones pass. */
function handRun(spec: RunSpec = {}): BenchRun {
  const done = spec.done ?? PLANNED;
  const passed = Math.min(spec.passed ?? 0, done);
  const answered = spec.answered ?? true;
  const tasks: BenchTaskRun[] = Array.from({ length: done }, (_, i) => {
    const ok = answered && i < passed;
    const totalMs = spec.totalMs ?? 100;
    return {
      id: `t-${i}`,
      kind: KINDS[i % 3] as BenchKind,
      ok,
      reason: ok ? null : answered ? "wrong" : "the provider failed: network",
      firstChunkMs: answered ? 10 : null,
      totalMs,
      outputTokens: answered ? 20 : 0,
      tokensSource: spec.source ?? "estimate",
      tokensPerSecond: answered ? Math.round((20 / (totalMs / 1000)) * 100) / 100 : null,
      error: answered ? null : { kind: "network", message: "down" },
    };
  });
  return benchRunSchema.parse({
    version: BENCH_RUN_VERSION,
    startedAt: spec.at ?? "2026-10-20T12:00:00.000Z",
    provider: {
      id: spec.provider ?? "ollama",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    },
    model: spec.model ?? "llama3.2",
    state: spec.state ?? "complete",
    planned: PLANNED,
    tasks,
    totals: summarizeBenchTasks(tasks),
    memory:
      spec.bytes === undefined || spec.bytes === null
        ? null
        : { source: "ollama", bytes: spec.bytes, vramBytes: Math.floor(spec.bytes / 2) },
  });
}

/** The run as a saved file, named from its start time the way the app names it. */
function saved(run: BenchRun, suffix = ""): SavedBenchRun {
  const stamp = benchStampOfStartedAt(run.startedAt);
  if (stamp === undefined) throw new Error(`bad start time ${run.startedAt}`);
  return { name: `${stamp}${suffix}.json`, run };
}

const hand = (spec: RunSpec = {}): SavedBenchRun => saved(handRun(spec));

const idsOf = (rows: readonly BenchScoreRow[]): string[] =>
  rows.map((row) => `${row.provider.id}/${row.model}`);

// ---- The CSV, read back ----

/** A small CSV reader for the tests: quotes, doubled quotes, commas and line breaks inside quotes; `\n` ends a record. */
function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(cell);
      cell = "";
    } else if (char === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += char;
    }
    i += 1;
  }
  if (quoted) throw new Error("a quote was left open");
  if (cell !== "" || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records;
}

// ---- The scoreboard ----

describe("the scoreboard", () => {
  it("is empty when there are no runs", () => {
    expect(benchScoreboard([])).toEqual([]);
  });

  it("has a row for a pair of provider id and model, made from its newest run", () => {
    const older = hand({ at: "2026-10-19T09:00:00.000Z", passed: 5, totalMs: 100 });
    const newer = hand({ at: "2026-10-20T09:00:00.000Z", passed: 2, totalMs: 300 });
    for (const input of [
      [older, newer],
      [newer, older],
    ]) {
      const rows = benchScoreboard(input);
      expect(rows).toHaveLength(1);
      const [row] = rows as [BenchScoreRow];
      expect(row.fileName).toBe(newer.name);
      expect(row.startedAt).toBe(newer.run.startedAt);
      expect(row.accuracy).toBeCloseTo(2 / 6);
      expect(row.medianTotalMs).toBe(300);
      expect(row.runs).toBe(2);
      expect(row.rank).toBe(1);
    }
  });

  it("counts the runs of each pair and keeps another provider or model apart", () => {
    const rows = benchScoreboard([
      hand({ model: "a", at: "2026-10-18T09:00:00.000Z" }),
      hand({ model: "a", at: "2026-10-19T09:00:00.000Z" }),
      hand({ model: "a", at: "2026-10-20T09:00:00.000Z" }),
      hand({ model: "b", at: "2026-10-20T09:00:00.000Z" }),
      hand({ provider: "lmstudio", model: "a", at: "2026-10-20T09:00:00.000Z" }),
    ]);
    expect(idsOf(rows)).toEqual(["lmstudio/a", "ollama/a", "ollama/b"]);
    expect(rows.map((row) => row.runs)).toEqual([1, 3, 1]);
  });

  it("does not mix up a provider id and a model that read the same when joined", () => {
    const rows = benchScoreboard([
      hand({ provider: "a", model: "b/c" }),
      hand({ provider: "a/b", model: "c" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("takes the later file when two runs started at the same moment", () => {
    const first = saved(handRun({ passed: 1 }));
    const second = saved(handRun({ passed: 4 }), "-2");
    for (const input of [
      [first, second],
      [second, first],
    ]) {
      expect(benchScoreboard(input)[0]?.fileName).toBe(second.name);
    }
  });

  it("compares start times as times, with or without a fraction of a second", () => {
    const whole = hand({ at: "2026-10-20T09:00:00Z", passed: 1 });
    const later = hand({ at: "2026-10-20T09:00:00.5Z", passed: 4 });
    expect(benchScoreboard([later, whole])[0]?.fileName).toBe(later.name);
    expect(benchScoreboard([whole, later])[0]?.fileName).toBe(later.name);
  });

  it("orders by accuracy, highest first", () => {
    const rows = benchScoreboard([
      hand({ model: "low", passed: 1 }),
      hand({ model: "high", passed: 5 }),
      hand({ model: "mid", passed: 3 }),
    ]);
    expect(idsOf(rows)).toEqual(["ollama/high", "ollama/mid", "ollama/low"]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it("breaks a tie of accuracy with the lower median total time, a row with none last", () => {
    const rows = benchScoreboard([
      hand({ model: "none", passed: 0, answered: false }),
      hand({ model: "slow", passed: 0, totalMs: 900 }),
      hand({ model: "fast", passed: 0, totalMs: 100 }),
      hand({ model: "mid", passed: 0, totalMs: 400 }),
    ]);
    expect(idsOf(rows)).toEqual(["ollama/fast", "ollama/mid", "ollama/slow", "ollama/none"]);
  });

  it("breaks a tie of accuracy and time with the provider id, then the model", () => {
    const rows = benchScoreboard([
      hand({ provider: "b", model: "x" }),
      hand({ provider: "a", model: "z" }),
      hand({ provider: "a", model: "y" }),
    ]);
    expect(idsOf(rows)).toEqual(["a/y", "a/z", "b/x"]);
  });

  it("lists a cancelled run, with the tasks it did, and does not make it recommendable", () => {
    const rows = benchScoreboard([
      hand({ model: "stopped", state: "cancelled", done: 3, passed: 3 }),
      hand({ model: "whole", passed: 2 }),
    ]);
    expect(idsOf(rows)).toEqual(["ollama/stopped", "ollama/whole"]);
    const [stopped, whole] = rows as [BenchScoreRow, BenchScoreRow];
    expect(stopped.state).toBe("cancelled");
    expect(stopped.done).toBe(3);
    expect(stopped.planned).toBe(6);
    expect(stopped.recommendable).toBe(false);
    expect(whole.recommendable).toBe(true);
  });

  it("shows the accuracy of each kind, the medians and the memory of the run", () => {
    const run = hand({ passed: 3, bytes: 4_000, totalMs: 250 });
    const [row] = benchScoreboard([run]) as [BenchScoreRow];
    expect(row.byKind.command).toEqual({ total: 2, passed: 1, accuracy: 0.5 });
    expect(row.byKind.explain).toEqual({ total: 2, passed: 1, accuracy: 0.5 });
    expect(row.byKind.summarize).toEqual({ total: 2, passed: 1, accuracy: 0.5 });
    expect(row.accuracy).toBe(0.5);
    expect(row.medianFirstChunkMs).toBe(10);
    expect(row.medianTotalMs).toBe(250);
    expect(row.medianTokensPerSecond).toBe(80);
    expect(row.memory).toEqual({ source: "ollama", bytes: 4_000, vramBytes: 2_000 });
    expect(row.provider).toEqual(run.run.provider);
  });

  it("says where the tokens per second come from: stream, estimate, a mix, or nothing", () => {
    const only = (source: "stream" | "estimate"): BenchScoreRow["tokensSource"] =>
      benchScoreboard([hand({ source })])[0]?.tokensSource ?? null;
    expect(only("stream")).toBe("stream");
    expect(only("estimate")).toBe("estimate");
    expect(benchScoreboard([hand({ answered: false })])[0]?.tokensSource).toBeNull();

    const mixedRun = handRun({ passed: 6 });
    const tasks = mixedRun.tasks.map((task, i) =>
      i === 0 ? { ...task, tokensSource: "stream" as const } : task,
    );
    const mixed = benchRunSchema.parse({ ...mixedRun, tasks });
    expect(benchScoreboard([saved(mixed)])[0]?.tokensSource).toBe("mixed");
  });

  describe("with real runs of runBench against the fake provider", () => {
    const pick = (kind: BenchKind, n: number): BenchTask[] =>
      SUITE.filter((task) => task.kind === kind).slice(0, n);
    const TASKS = [...pick("command", 2), ...pick("explain", 2), ...pick("summarize", 2)];

    const OLLAMA: AiProviderInfo = {
      id: "ollama",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "",
      hasKey: false,
    };

    /** A model that answers the first `right` tasks with a passing example and the rest with a failing one. */
    async function realRun(model: string, right: number, stepMs: number, day: number) {
      const backend = new FakeBackend({
        ollamaModels: [model],
        aiReply: (request) => {
          const asked = request.messages.at(-1)?.content ?? "";
          // The whole message, not its start: the prompts of two explain tasks share a start.
          const index = TASKS.findIndex((task) => benchMessages(task)[1]?.content === asked);
          const task = TASKS[index] as BenchTask;
          return index < right
            ? (task.examples.pass[0] as string)
            : (task.examples.fail[0] as string);
        },
        ollamaMemory: { bytes: 1000 * (right + 1), vramBytes: 500 },
      });
      let t = Date.UTC(2026, 9, day, 10, 0, 0);
      return runBench({
        ai: backend.ai,
        provider: OLLAMA,
        model,
        tasks: TASKS,
        now: () => {
          const at = t;
          t += stepMs;
          return at;
        },
      });
    }

    it("lists, ranks and recommends the runs the runner made", async () => {
      const good = await realRun("good", 6, 40, 20);
      const half = await realRun("half", 3, 10, 21);
      const none = await realRun("none", 0, 5, 22);
      const rows = benchScoreboard([good, half, none].map((run) => saved(run)));
      expect(idsOf(rows)).toEqual(["ollama/good", "ollama/half", "ollama/none"]);
      expect(rows.map((row) => row.accuracy)).toEqual([1, 0.5, 0]);
      expect(rows.map((row) => row.done)).toEqual([6, 6, 6]);
      expect(rows[0]?.memory?.bytes).toBe(7000);
      expect(rows[0]?.byKind.command).toEqual({ total: 2, passed: 2, accuracy: 1 });
      expect(rows[1]?.byKind.command.passed).toBe(2);
      expect(rows[1]?.byKind.explain.passed).toBe(1);
      expect(rows[1]?.byKind.summarize.passed).toBe(0);
      expect(recommendBenchModel(rows)?.model).toBe("good");
      // A run of 0 right answers is complete and is not recommended.
      expect(rows[2]?.state).toBe("complete");
      expect(rows[2]?.recommendable).toBe(false);
    });

    it("picks the faster of two models that got the same answers right", async () => {
      const slow = await realRun("slow", 4, 80, 20);
      const fast = await realRun("fast", 4, 8, 20);
      const rows = benchScoreboard([slow, fast].map((run) => saved(run)));
      expect(rows[0]?.accuracy).toBe(rows[1]?.accuracy);
      expect(idsOf(rows)).toEqual(["ollama/fast", "ollama/slow"]);
      expect(recommendBenchModel(rows)?.model).toBe("fast");
    });
  });
});

// ---- The recommendation ----

describe("the recommendation", () => {
  const recommended = (specs: RunSpec[]): string | undefined => {
    const row = recommendBenchModel(benchScoreboard(specs.map((spec) => hand(spec))));
    return row && `${row.provider.id}/${row.model}`;
  };

  it("is nothing when there are no rows", () => {
    expect(recommendBenchModel([])).toBeUndefined();
  });

  it("is nothing when every newest run was cancelled", () => {
    expect(
      recommended([
        { model: "a", state: "cancelled", done: 4, passed: 4 },
        { model: "b", state: "cancelled", done: 2, passed: 2 },
      ]),
    ).toBeUndefined();
  });

  it("is nothing when no model got an answer right", () => {
    expect(
      recommended([
        { model: "a", passed: 0 },
        { model: "b", passed: 0, totalMs: 5 },
      ]),
    ).toBe(undefined);
    expect(recommended([{ model: "a", passed: 0, answered: false }])).toBeUndefined();
  });

  it("is the most accurate model with a complete run", () => {
    expect(
      recommended([
        { model: "a", passed: 2 },
        { model: "b", passed: 5 },
        { model: "c", passed: 3 },
      ]),
    ).toBe("ollama/b");
  });

  it("skips a cancelled run even when it is the most accurate", () => {
    expect(
      recommended([
        { model: "stopped", state: "cancelled", done: 3, passed: 3 },
        { model: "whole", passed: 1 },
      ]),
    ).toBe("ollama/whole");
  });

  it("does not recommend a model whose newest run was cancelled, whatever an older run did", () => {
    expect(
      recommended([
        { model: "a", at: "2026-10-19T09:00:00.000Z", passed: 6 },
        { model: "a", at: "2026-10-20T09:00:00.000Z", state: "cancelled", done: 2, passed: 2 },
        { model: "b", passed: 1 },
      ]),
    ).toBe("ollama/b");
  });

  it("recommends a model by its newest run, not its best one", () => {
    expect(
      recommended([
        { model: "a", at: "2026-10-19T09:00:00.000Z", passed: 6 },
        { model: "a", at: "2026-10-20T09:00:00.000Z", passed: 0 },
        { model: "b", passed: 2 },
      ]),
    ).toBe("ollama/b");
  });

  it("breaks a tie of accuracy with the lower median total time", () => {
    expect(
      recommended([
        { model: "slow", passed: 3, totalMs: 900 },
        { model: "fast", passed: 3, totalMs: 100 },
        { model: "mid", passed: 3, totalMs: 400 },
      ]),
    ).toBe("ollama/fast");
  });

  it("breaks a tie of accuracy and time with the smaller memory, a model with no reading last", () => {
    expect(
      recommended([
        { model: "big", passed: 3, bytes: 9_000 },
        { model: "small", passed: 3, bytes: 2_000 },
        { model: "unknown", passed: 3, bytes: null },
      ]),
    ).toBe("ollama/small");
    expect(
      recommended([
        { model: "unknown", passed: 3, bytes: null },
        { model: "big", passed: 3, bytes: 9_000 },
      ]),
    ).toBe("ollama/big");
  });

  it("breaks a tie that is left with the provider id, then the model", () => {
    expect(
      recommended([
        { provider: "b", model: "x", passed: 3 },
        { provider: "a", model: "z", passed: 3 },
        { provider: "a", model: "y", passed: 3 },
      ]),
    ).toBe("a/y");
  });

  it("is one of the rows it was given", () => {
    const rows = benchScoreboard([
      hand({ model: "a", passed: 2 }),
      hand({ model: "b", passed: 4 }),
    ]);
    expect(rows).toContain(recommendBenchModel(rows));
  });
});

// ---- Apply ----

describe("making a model the default", () => {
  const TARGET = { provider: "ollama", model: "llama3.2:3b" };
  const KNOWN = knownAiProviderIds(undefined);

  it("knows ollama and the providers listed in the settings", () => {
    expect(KNOWN).toEqual(["ollama"]);
    expect(knownAiProviderIds([{ id: "lmstudio" }, { id: "work" }])).toEqual([
      "ollama",
      "lmstudio",
      "work",
    ]);
  });

  it("sets the provider and the model of ask, explain and command", () => {
    const result = benchDefaultEdits(TARGET, KNOWN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edits = result.edits.map((edit) => ({
      path: edit.path,
      value: "value" in edit ? edit.value : undefined,
    }));
    expect(edits).toEqual([
      { path: ["ai", "defaults", "ask", "provider"], value: "ollama" },
      { path: ["ai", "defaults", "ask", "model"], value: "llama3.2:3b" },
      { path: ["ai", "defaults", "explain", "provider"], value: "ollama" },
      { path: ["ai", "defaults", "explain", "model"], value: "llama3.2:3b" },
      { path: ["ai", "defaults", "command", "provider"], value: "ollama" },
      { path: ["ai", "defaults", "command", "model"], value: "llama3.2:3b" },
    ]);
  });

  it("refuses a provider the settings do not know, with no edits", () => {
    expect(benchDefaultEdits({ provider: "lmstudio", model: "m" }, KNOWN)).toEqual({
      ok: false,
      reason: "unknown-provider",
    });
    expect(benchDefaultEdits({ provider: "", model: "m" }, KNOWN)).toEqual({
      ok: false,
      reason: "unknown-provider",
    });
    expect(benchDefaultEdits({ provider: "Ollama", model: "m" }, KNOWN).ok).toBe(false);
    expect(benchDefaultEdits({ provider: "lmstudio", model: "m" }, ["ollama", "lmstudio"]).ok).toBe(
      true,
    );
  });

  it("refuses a blank model and one longer than the settings allow", () => {
    for (const model of ["", "   ", "\t\n", "x".repeat(MAX_AI_MODEL + 1)]) {
      expect(
        benchDefaultEdits({ provider: "ollama", model }, KNOWN),
        JSON.stringify(model),
      ).toEqual({
        ok: false,
        reason: "bad-model",
      });
    }
    expect(
      benchDefaultEdits({ provider: "ollama", model: "x".repeat(MAX_AI_MODEL) }, KNOWN).ok,
    ).toBe(true);
  });

  const COMMENTED = `// My settings, written by hand.
{
  // The language of the interface.
  "language": "pt-BR",

  "ai": {
    /* Off until I say so. */
    "enabled": true,
    "providers": [
      // Local server.
      { "id": "lmstudio", "kind": "openai-compatible", "baseUrl": "http://localhost:1234/v1", "model": "qwen" },
    ],
    "defaults": {
      "ask": { "provider": "lmstudio", "model": "old" }, // the old one
    },
  },
}
`;

  it("gives text that the settings accept, with the comments kept", () => {
    const known = knownAiProviderIds([{ id: "lmstudio" }]);
    const result = benchDefaultEdits({ provider: "lmstudio", model: "qwen2.5-coder" }, known);
    if (!result.ok) throw new Error(result.reason);
    const text = editConfigText(COMMENTED, result.edits);

    const parsed = parseConfigText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = { provider: "lmstudio", model: "qwen2.5-coder" };
    expect(parsed.config.ai?.defaults).toEqual({ ask: target, explain: target, command: target });
    expect(parsed.config.ai?.enabled).toBe(true);
    expect(parsed.config.language).toBe("pt-BR");

    for (const comment of [
      "// My settings, written by hand.",
      "// The language of the interface.",
      "/* Off until I say so. */",
      "// Local server.",
      "// the old one",
    ]) {
      expect(text, comment).toContain(comment);
    }
    expect(text).not.toContain('"old"');
  });

  it("creates the groups when the file has none of them, and from no file at all", () => {
    const result = benchDefaultEdits(TARGET, KNOWN);
    if (!result.ok) throw new Error(result.reason);
    for (const original of [
      null,
      "",
      "// nothing yet\n{}\n",
      '// a note\n{ "language": "en" }\n',
    ]) {
      const text = editConfigText(original, result.edits);
      const parsed = parseConfigText(text);
      expect(parsed.ok, text).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.config.ai?.defaults).toEqual({ ask: TARGET, explain: TARGET, command: TARGET });
      if (original?.startsWith("//"))
        expect(text.startsWith(original.split("\n")[0] as string)).toBe(true);
    }
  });

  it("does not turn the AI on", () => {
    const result = benchDefaultEdits(TARGET, KNOWN);
    if (!result.ok) throw new Error(result.reason);
    const parsed = parseConfigText(editConfigText(null, result.edits));
    expect(parsed.ok && parsed.config.ai?.enabled).toBeFalsy();
  });

  it("applies twice to the same text with no change the second time", () => {
    const result = benchDefaultEdits(TARGET, KNOWN);
    if (!result.ok) throw new Error(result.reason);
    const once = editConfigText(COMMENTED.replace("lmstudio", "ollama"), result.edits);
    expect(editConfigText(once, result.edits)).toBe(once);
  });

  it("gives the recommended row of a board as a target the settings accept", () => {
    const board = benchScoreboard([hand({ provider: "ollama", model: "tiny:1b", passed: 4 })]);
    const row = recommendBenchModel(board);
    if (!row) throw new Error("no recommendation");
    const result = benchDefaultEdits({ provider: row.provider.id, model: row.model }, KNOWN);
    expect(result.ok).toBe(true);
  });
});

// ---- The CSV ----

describe("the CSV", () => {
  const rowsOf = (...specs: RunSpec[]): BenchScoreRow[] =>
    benchScoreboard(specs.map((spec) => hand(spec)));

  it("has the fixed header, then a record for each row, each line ending in a newline", () => {
    const csv = benchScoreboardCsv(rowsOf({ model: "a", passed: 3 }, { model: "b", passed: 1 }));
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv).not.toContain("\r");
    const lines = csv.split("\n");
    expect(lines[0]).toBe(BENCH_CSV_HEADER.join(","));
    expect(lines[0]).toBe(
      "rank,provider_id,model,runs,file,started_at,state,planned,done,errors,accuracy,accuracy_command,accuracy_explain,accuracy_summarize,median_first_chunk_ms,median_total_ms,median_tokens_per_second,tokens_source,memory_bytes,memory_vram_bytes,recommended",
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
  });

  it("has the header alone for an empty board", () => {
    expect(benchScoreboardCsv([])).toBe(`${BENCH_CSV_HEADER.join(",")}\n`);
  });

  it("writes a row's cells, numbers with a point and no grouping, an empty cell for none", () => {
    const [header, record] = readCsv(
      benchScoreboardCsv(rowsOf({ model: "m", passed: 3, totalMs: 1_250, bytes: 5_137_025_024 })),
    ) as [string[], string[]];
    const cell = (name: string): string | undefined => record[header.indexOf(name)];
    expect(cell("rank")).toBe("1");
    expect(cell("provider_id")).toBe("ollama");
    expect(cell("model")).toBe("m");
    expect(cell("runs")).toBe("1");
    expect(cell("file")).toBe("2026-10-20-120000.json");
    expect(cell("started_at")).toBe("2026-10-20T12:00:00.000Z");
    expect(cell("state")).toBe("complete");
    expect(cell("planned")).toBe("6");
    expect(cell("done")).toBe("6");
    expect(cell("errors")).toBe("0");
    expect(cell("accuracy")).toBe("0.5");
    expect(cell("accuracy_command")).toBe("0.5");
    expect(cell("median_first_chunk_ms")).toBe("10");
    expect(cell("median_total_ms")).toBe("1250");
    expect(cell("median_tokens_per_second")).toBe("16");
    expect(cell("tokens_source")).toBe("estimate");
    expect(cell("memory_bytes")).toBe("5137025024");
    expect(cell("memory_vram_bytes")).toBe("2568512512");
    expect(cell("recommended")).toBe("true");

    const [, none] = readCsv(
      benchScoreboardCsv(rowsOf({ model: "m", passed: 0, answered: false })),
    ) as [string[], string[]];
    expect(none[header.indexOf("median_total_ms")]).toBe("");
    expect(none[header.indexOf("tokens_source")]).toBe("");
    expect(none[header.indexOf("memory_bytes")]).toBe("");
    expect(none[header.indexOf("recommended")]).toBe("false");
  });

  it("marks only the recommended row", () => {
    const records = readCsv(
      benchScoreboardCsv(
        rowsOf({ model: "a", passed: 1 }, { model: "b", passed: 5 }, { model: "c", passed: 0 }),
      ),
    ).slice(1);
    expect(records.map((record) => [record[2], record.at(-1)])).toEqual([
      ["b", "true"],
      ["a", "false"],
      ["c", "false"],
    ]);
  });

  describe("quoting (RFC 4180)", () => {
    it("leaves a plain text alone", () => {
      expect(benchCsvText("llama3.2:3b")).toBe("llama3.2:3b");
      expect(benchCsvText("")).toBe("");
      expect(benchCsvText("a b")).toBe("a b");
    });

    it("puts a text with a comma, a quote or a line break in quotes, and doubles the quotes", () => {
      expect(benchCsvText("a,b")).toBe('"a,b"');
      expect(benchCsvText('say "hi"')).toBe('"say ""hi"""');
      expect(benchCsvText('"')).toBe('""""');
      expect(benchCsvText("a\nb")).toBe('"a\nb"');
      expect(benchCsvText("a\r\nb")).toBe('"a\r\nb"');
      expect(benchCsvText("a\rb")).toBe('"a\rb"');
    });

    it("reads back the same model from a record, whatever is in its name", () => {
      for (const model of ["a,b", 'q"uote', "two\nlines", 'all, "of"\r\nthem', "plain", "é ü 漢"]) {
        const records = readCsv(benchScoreboardCsv(rowsOf({ model, passed: 1 })));
        expect(records).toHaveLength(2);
        expect(records[1]).toHaveLength(BENCH_CSV_HEADER.length);
        expect(records[1]?.[2], JSON.stringify(model)).toBe(model);
      }
    });
  });

  describe("a cell a spreadsheet would run as a formula", () => {
    it("gets an apostrophe in front when it starts with = + - @ a tab or a carriage return", () => {
      expect(benchCsvText("=1+1")).toBe("'=1+1");
      expect(benchCsvText("+1")).toBe("'+1");
      expect(benchCsvText("-2")).toBe("'-2");
      expect(benchCsvText("@SUM(A1)")).toBe("'@SUM(A1)");
      expect(benchCsvText("\tcmd")).toBe("'\tcmd");
      expect(benchCsvText("\rcmd")).toBe(`"'\rcmd"`);
    });

    it("is neutralized in a model name and the injected text is still the rest of the cell", () => {
      const evil = '=HYPERLINK("http://example.test","x"),=1';
      const records = readCsv(benchScoreboardCsv(rowsOf({ model: evil, passed: 1 })));
      expect(records[1]?.[2]).toBe(`'${evil}`);
      // No cell of the record starts with a formula character.
      for (const cell of records[1] ?? []) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    });

    it("is neutralized in the provider id too, and a text that only has such a character inside is left alone", () => {
      const records = readCsv(
        benchScoreboardCsv(
          benchScoreboard([hand({ provider: "@evil", model: "a=b-c+d@e", passed: 1 })]),
        ),
      );
      expect(records[1]?.[1]).toBe("'@evil");
      expect(records[1]?.[2]).toBe("a=b-c+d@e");
    });
  });
});

// ---- Properties ----

describe("properties of the board, the recommendation and the CSV", () => {
  const text = fc.oneof(
    fc.string({ minLength: 1, maxLength: 12 }),
    fc.constantFrom("a", "b", "=x", "+y", "-z", "@w", "\tt", 'q"q', "c,c", "n\nn", "r\rr", "ü"),
  );
  const spec = fc.record({
    provider: fc.constantFrom("ollama", "lmstudio", "work", "=odd"),
    model: text,
    at: fc
      .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) })
      .map((ms) => new Date(ms).toISOString()),
    passed: fc.integer({ min: 0, max: 6 }),
    done: fc.integer({ min: 0, max: 6 }),
    state: fc.constantFrom("complete", "cancelled"),
    totalMs: fc.integer({ min: 1, max: 5_000 }),
    answered: fc.boolean(),
    bytes: fc.option(fc.integer({ min: 0, max: 20_000 }), { nil: null }),
  });

  /** A spec that makes a run the schema accepts: a complete run did all the planned tasks. */
  const runOf = (s: RunSpec): SavedBenchRun =>
    hand(
      s.state === "complete"
        ? { ...s, done: PLANNED }
        : { ...s, done: Math.min(s.done ?? 0, PLANNED - 1) },
    );

  it("recommends a row that can be, with the highest accuracy among those", () => {
    fc.assert(
      fc.property(fc.array(spec, { maxLength: 14 }), (specs) => {
        const rows = benchScoreboard(specs.map(runOf));
        const picked = recommendBenchModel(rows);
        const eligible = rows.filter((row) => row.state === "complete" && row.accuracy > 0);
        if (eligible.length === 0) {
          expect(picked).toBeUndefined();
          return;
        }
        expect(picked).toBeDefined();
        expect(rows).toContain(picked);
        expect(picked?.state).toBe("complete");
        expect(picked?.accuracy).toBeGreaterThan(0);
        expect(picked?.recommendable).toBe(true);
        expect(picked?.accuracy).toBe(Math.max(...eligible.map((row) => row.accuracy)));
        // Among the rows of that accuracy, none is faster.
        const sameAccuracy = eligible.filter((row) => row.accuracy === picked?.accuracy);
        const times = sameAccuracy.flatMap((row) =>
          row.medianTotalMs === null ? [] : [row.medianTotalMs],
        );
        if (times.length > 0) expect(picked?.medianTotalMs).toBe(Math.min(...times));
      }),
      { numRuns: 200 },
    );
  });

  it("has one row for each pair, ordered, and the CSV has 1 + rows records", () => {
    fc.assert(
      fc.property(fc.array(spec, { maxLength: 14 }), (specs) => {
        const input = specs.map(runOf);
        const rows = benchScoreboard(input);
        const pairs = new Set(input.map(({ run }) => JSON.stringify([run.provider.id, run.model])));
        expect(rows).toHaveLength(pairs.size);
        expect(rows.reduce((sum, row) => sum + row.runs, 0)).toBe(input.length);
        rows.forEach((row, i) => {
          expect(row.rank).toBe(i + 1);
          const next = rows[i + 1];
          if (next) expect(row.accuracy).toBeGreaterThanOrEqual(next.accuracy);
        });

        const records = readCsv(benchScoreboardCsv(rows));
        expect(records).toHaveLength(1 + rows.length);
        expect(records[0]).toEqual([...BENCH_CSV_HEADER]);
        records.slice(1).forEach((record, i) => {
          const row = rows[i] as BenchScoreRow;
          expect(record).toHaveLength(BENCH_CSV_HEADER.length);
          const safe = (value: string): string =>
            /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
          expect(record[1]).toBe(safe(row.provider.id));
          expect(record[2]).toBe(safe(row.model));
          expect(record[10]).toBe(String(row.accuracy));
        });
      }),
      { numRuns: 200 },
    );
  });
});

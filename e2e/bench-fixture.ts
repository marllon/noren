import type { Page } from "@playwright/test";
import {
  BENCH_RUN_VERSION,
  benchRunSchema,
  summarizeBenchTasks,
} from "../packages/model/src/bench-runner";
import type { BenchRun, BenchTaskRun } from "../packages/model/src/bench-runner";
import { benchStampOfStartedAt } from "../packages/model/src/bench-results";

// Bench results for the tests of the bench scoreboard: runs built by hand and checked with
// `benchRunSchema`, so each one is a file the app could have saved. They are seeded under the
// `noren.web.bench-results` key of the web build, before the page loads.

export const WEB_BENCH_RESULTS_KEY = "noren.web.bench-results";

const KINDS = ["command", "explain", "summarize"] as const;
const PLANNED = 6;

export interface RunSpec {
  provider: string;
  model: string;
  startedAt: string;
  /** Tasks that passed, out of `done`. */
  passed: number;
  /** Tasks the run did, out of 6 planned. */
  done?: number;
  state?: "complete" | "cancelled";
  /** The total time of every task, in ms. */
  totalMs: number;
  source?: "stream" | "estimate";
  /** Memory Ollama held, in bytes; `null` for none. */
  memoryBytes?: number | null;
}

/** A run: the tasks cycle through the three kinds and the first `passed` ones pass. */
export function benchRun(spec: RunSpec): BenchRun {
  const done = spec.done ?? PLANNED;
  const tasks: BenchTaskRun[] = Array.from({ length: done }, (_, i) => {
    const ok = i < spec.passed;
    return {
      id: `t-${i}`,
      kind: KINDS[i % 3] ?? "command",
      ok,
      reason: ok ? null : "wrong answer",
      firstChunkMs: 50,
      totalMs: spec.totalMs,
      outputTokens: 40,
      tokensSource: spec.source ?? "stream",
      tokensPerSecond: Math.round((40 / (spec.totalMs / 1000)) * 100) / 100,
      error: null,
    };
  });
  const bytes = spec.memoryBytes ?? null;
  return benchRunSchema.parse({
    version: BENCH_RUN_VERSION,
    startedAt: spec.startedAt,
    provider: {
      id: spec.provider,
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    },
    model: spec.model,
    state: spec.state ?? "complete",
    planned: PLANNED,
    tasks,
    totals: summarizeBenchTasks(tasks),
    memory: bytes === null ? null : { source: "ollama", bytes, vramBytes: Math.floor(bytes / 2) },
  });
}

/** The file name the app gives a run: its start time. */
export function benchFile(run: BenchRun): string {
  const stamp = benchStampOfStartedAt(run.startedAt);
  if (stamp === undefined) throw new Error(`bad start time ${run.startedAt}`);
  return `${stamp}.json`;
}

/** The best of the finished runs: every task right, though not the fastest. */
export const QWEN = benchRun({
  provider: "ollama",
  model: "qwen2",
  startedAt: "2026-10-20T10:00:00.000Z",
  passed: 6,
  totalMs: 900,
  memoryBytes: 5 * 1024 ** 3,
});
/** Second: 5 of 6 right and faster. */
export const LLAMA = benchRun({
  provider: "ollama",
  model: "llama3",
  startedAt: "2026-10-20T10:10:00.000Z",
  passed: 5,
  totalMs: 300,
  source: "estimate",
});
/** Third: a provider of the settings file, 3 of 6 right. */
export const BIG = benchRun({
  provider: "work",
  model: "big",
  startedAt: "2026-10-20T10:20:00.000Z",
  passed: 3,
  totalMs: 600,
});
/** A run that was stopped: 2 tasks done, both right, and the fastest of all. */
export const PHI_CANCELLED = benchRun({
  provider: "ollama",
  model: "phi3",
  startedAt: "2026-10-20T10:30:00.000Z",
  passed: 2,
  done: 2,
  state: "cancelled",
  totalMs: 200,
});
/** A model of a provider that the settings file does not list. */
export const GONE = benchRun({
  provider: "gone",
  model: "m1",
  startedAt: "2026-10-20T10:40:00.000Z",
  passed: 6,
  totalMs: 100,
});

/** Seeds the runs as result files before the page loads (only on the first load of a test). */
export async function seedBench(page: Page, runs: readonly BenchRun[]): Promise<void> {
  const files = Object.fromEntries(runs.map((run) => [benchFile(run), run]));
  await page.addInitScript(
    ({ key, value }) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    { key: WEB_BENCH_RESULTS_KEY, value: JSON.stringify(files) },
  );
}

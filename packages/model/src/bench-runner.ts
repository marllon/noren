import { z } from "zod";
import {
  AI_ERROR_KINDS,
  AI_PROVIDER_KINDS,
  type AiBackend,
  type AiChatEvent,
  type AiChatMessage,
  type AiErrorKind,
  type AiProviderInfo,
} from "./ai";
import { checkBenchAnswer, type BenchKind, type BenchTask } from "./bench-suite";

// The runner of the model bench (NOR-F16-02a): sends the tasks of the suite, one at a time, to a
// provider through `AiBackend.chat`, checks each answer with `checkBenchAnswer` and measures it. Pure:
// no DOM, no Tauri, no files and no network of its own. Everything that reaches a provider goes
// through the injected `AiBackend`, and the clock is injected too, so a test sets the latencies.
// It only reads the answers: a command that a model wrote is compared with text and never run (D8).
// The run is only for a provider on this computer (see `benchProviderProblem`).

/** The version of the result format; a file of another version is not read as this one. */
export const BENCH_RUN_VERSION = 1;

/** One token is estimated as this many characters of the answer (the usual rule of thumb for English text). */
export const BENCH_CHARS_PER_TOKEN = 4;

/** The folder, in the user's files, where a result is kept (the Backend writes it in NOR-F16-02b). */
export const BENCH_RESULTS_DIR = "bench-results";

const BENCH_KINDS = ["command", "explain", "summarize"] as const satisfies readonly BenchKind[];
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// ---- The result ----

const durationMs = z.number().finite().nonnegative();

const taskRunSchema = z
  .strictObject({
    id: z.string().min(1),
    kind: z.enum(BENCH_KINDS),
    /** The answer passed its check. A task whose provider failed is not ok. */
    ok: z.boolean(),
    /** Why the answer was refused or the call failed; `null` when `ok`. */
    reason: z.string().nullable(),
    /** Milliseconds from the request to the first piece of the answer; `null` when none came. */
    firstChunkMs: durationMs.nullable(),
    /** Milliseconds from the request to its last event. */
    totalMs: durationMs,
    /** The size of the answer in tokens, and where the number comes from. */
    outputTokens: z.number().int().nonnegative(),
    /** `estimate`: characters of the answer divided by `BENCH_CHARS_PER_TOKEN`. `stream`: the count the provider reported in the stream (NOR-F16-02c). */
    tokensSource: z.enum(["estimate", "stream"]),
    /** `outputTokens` over `totalMs`; `null` for a failed call or one with no time or no tokens. */
    tokensPerSecond: durationMs.nullable(),
    /** What the provider said when the call failed; `null` otherwise. It never holds a key. */
    error: z.strictObject({ kind: z.enum(AI_ERROR_KINDS), message: z.string() }).nullable(),
  })
  .superRefine((task, ctx) => {
    if (task.ok && (task.reason !== null || task.error !== null)) {
      ctx.addIssue({ code: "custom", message: "a task that is ok has no reason and no error" });
    }
    if (!task.ok && task.reason === null) {
      ctx.addIssue({ code: "custom", message: "a task that is not ok says why" });
    }
    if (task.error !== null && task.ok) {
      ctx.addIssue({ code: "custom", message: "a failed call is not ok" });
    }
  });

export type BenchTaskRun = z.infer<typeof taskRunSchema>;

const totalsSchema = z.strictObject({
  /** The tasks that ran. */
  total: z.number().int().nonnegative(),
  /** The ones whose answer passed. */
  passed: z.number().int().nonnegative(),
  /** The ones whose call to the provider failed (a subset of the ones that did not pass). */
  errors: z.number().int().nonnegative(),
  /** `passed` over `total`; 0 when nothing ran. */
  accuracy: z.number().min(0).max(1),
  /** The medians are over the tasks whose call did not fail; `null` when there are none. */
  medianFirstChunkMs: durationMs.nullable(),
  medianTotalMs: durationMs.nullable(),
  medianTokensPerSecond: durationMs.nullable(),
});

export type BenchTotals = z.infer<typeof totalsSchema>;

const kindTotalsSchema = z.strictObject({
  command: totalsSchema,
  explain: totalsSchema,
  summarize: totalsSchema,
});

function sameNumber(a: number | null, b: number | null): boolean {
  return a === b;
}

function sameTotals(a: BenchTotals, b: BenchTotals): boolean {
  return (
    a.total === b.total &&
    a.passed === b.passed &&
    a.errors === b.errors &&
    a.accuracy === b.accuracy &&
    sameNumber(a.medianFirstChunkMs, b.medianFirstChunkMs) &&
    sameNumber(a.medianTotalMs, b.medianTotalMs) &&
    sameNumber(a.medianTokensPerSecond, b.medianTokensPerSecond)
  );
}

export const benchRunSchema = z
  .strictObject({
    version: z.literal(BENCH_RUN_VERSION),
    /** When the run started, ISO 8601 in UTC. */
    startedAt: z.iso.datetime(),
    /** The provider, without a key: `AiProviderInfo` minus `hasKey` and its default model. */
    provider: z.strictObject({
      id: z.string().min(1),
      kind: z.enum(AI_PROVIDER_KINDS),
      baseUrl: z.string().min(1),
    }),
    model: z.string().min(1),
    /** `complete`: every task ran. `cancelled`: the run was stopped; `tasks` holds the ones that were done. */
    state: z.enum(["complete", "cancelled"]),
    /** How many tasks the run was asked to do. */
    planned: z.number().int().nonnegative(),
    tasks: z.array(taskRunSchema),
    totals: z.strictObject({ overall: totalsSchema, byKind: kindTotalsSchema }),
    /** The memory the model used, measured in NOR-F16-02b; `null` until then. */
    memory: z.null(),
  })
  .superRefine((run, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (run.tasks.length > run.planned) issue("more tasks ran than were planned");
    if (run.state === "complete" && run.tasks.length !== run.planned) {
      issue("a complete run did every planned task");
    }
    if (new Set(run.tasks.map((task) => task.id)).size !== run.tasks.length) {
      issue("a task is in the result twice");
    }
    const want = summarizeBenchTasks(run.tasks);
    if (!sameTotals(run.totals.overall, want.overall))
      issue("the overall totals are not the tasks'");
    for (const kind of BENCH_KINDS) {
      if (!sameTotals(run.totals.byKind[kind], want.byKind[kind])) {
        issue(`the ${kind} totals are not the tasks'`);
      }
    }
  });

export type BenchRun = z.infer<typeof benchRunSchema>;

// ---- Totals ----

/** The middle value of `values` (the mean of the two in the middle when there is an even number), or `null` when there are none. */
export function benchMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const high = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return high;
  return ((sorted[mid - 1] ?? 0) + high) / 2;
}

function totalsOf(tasks: readonly BenchTaskRun[]): BenchTotals {
  const answered = tasks.filter((task) => task.error === null);
  const passed = tasks.filter((task) => task.ok).length;
  return {
    total: tasks.length,
    passed,
    errors: tasks.length - answered.length,
    accuracy: tasks.length === 0 ? 0 : passed / tasks.length,
    medianFirstChunkMs: benchMedian(
      answered.flatMap((task) => (task.firstChunkMs === null ? [] : [task.firstChunkMs])),
    ),
    medianTotalMs: benchMedian(answered.map((task) => task.totalMs)),
    medianTokensPerSecond: benchMedian(
      answered.flatMap((task) => (task.tokensPerSecond === null ? [] : [task.tokensPerSecond])),
    ),
  };
}

/** The totals of the tasks as a whole and for each kind. */
export function summarizeBenchTasks(tasks: readonly BenchTaskRun[]): {
  overall: BenchTotals;
  byKind: Record<BenchKind, BenchTotals>;
} {
  return {
    overall: totalsOf(tasks),
    byKind: {
      command: totalsOf(tasks.filter((task) => task.kind === "command")),
      explain: totalsOf(tasks.filter((task) => task.kind === "explain")),
      summarize: totalsOf(tasks.filter((task) => task.kind === "summarize")),
    },
  };
}

// ---- The messages ----

const SHELL_NAMES = { pwsh: "PowerShell", bash: "bash" } as const;

/** The messages sent for a task: a system message for its kind, then the prompt with its input. */
export function benchMessages(task: BenchTask): AiChatMessage[] {
  let system: string;
  switch (task.kind) {
    case "command":
      system = `You write one ${SHELL_NAMES[task.shell]} command for the task. Answer with the command alone on one line: no explanation, no code fence, no comment.`;
      break;
    case "explain":
      system =
        "You explain errors of the command line. Say what the error means and how to fix it, in a few short sentences.";
      break;
    case "summarize":
      system =
        "You summarize the output of a command. Answer with one short sentence that holds the facts that matter, and nothing else.";
      break;
  }
  const user =
    task.input === undefined ? task.prompt : `${task.prompt}\n\n\`\`\`\n${task.input}\n\`\`\``;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---- The provider ----

/** The host of an http(s) address, lower-cased, without port; `undefined` when it is not a plain address or has a user name or password. */
function hostOf(address: string): string | undefined {
  const match = /^https?:\/\/([^/?#]*)/i.exec(address.trim());
  const authority = match?.[1];
  if (authority === undefined || authority.includes("@")) return undefined;
  const host = /^(\[[^\]]*\]|[^:]*)(?::\d*)?$/.exec(authority)?.[1];
  return host === undefined || host === "" ? undefined : host.toLowerCase();
}

/**
 * Why the bench cannot run against `provider` with `model`, in a sentence, or `undefined` when it can.
 * The bench is only for a model on this computer: the address must be `localhost`, `127.0.0.1` or
 * `::1` (a remote provider would be sent 60 prompts and billed for them), with no user name or password
 * in it, and a model must be named.
 */
export function benchProviderProblem(provider: AiProviderInfo, model: string): string | undefined {
  const host = hostOf(provider.baseUrl);
  if (host === undefined) return `the address of \`${provider.id}\` is not a plain http address`;
  if (!LOOPBACK_HOSTS.includes(host)) {
    return `the bench runs only against a provider on this computer (localhost, 127.0.0.1 or ::1); \`${provider.id}\` is at ${host}`;
  }
  if (model.trim() === "") return "name the model to run the bench with";
  return undefined;
}

/** The run was refused before any request: `message` says why. */
export class BenchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchRefusedError";
  }
}

// ---- The run ----

/** The part of an `AbortSignal` the runner uses; a real `AbortSignal` is one. */
export interface BenchAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** What `onProgress` is told: a task is about to be asked, or has been answered and judged. */
export type BenchProgress =
  | { type: "start"; index: number; total: number; taskId: string }
  | { type: "done"; index: number; total: number; result: BenchTaskRun };

export interface RunBenchOptions {
  ai: AiBackend;
  provider: AiProviderInfo;
  /** The model to ask; blank takes the default model of the provider. */
  model: string;
  tasks: readonly BenchTask[];
  /** The clock, in milliseconds (`Date.now` outside the tests). */
  now: () => number;
  signal?: BenchAbortSignal | undefined;
  onProgress?: ((progress: BenchProgress) => void) | undefined;
}

/** The size of an answer in tokens by the documented rule: its characters over `BENCH_CHARS_PER_TOKEN`, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / BENCH_CHARS_PER_TOKEN);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Ending = { ok: true } | { ok: false; kind: AiErrorKind; message: string };

let runCounter = 0;

/**
 * Runs `tasks` against `provider`, one at a time, and returns the result (checked by `benchRunSchema`).
 *
 * - Each task is one `ai.chat` with a request id of its own; the deltas are joined into the answer,
 *   which `checkBenchAnswer` judges. The time to the first non-empty delta and to the last event are
 *   read from `now`; the tokens per second are the count over the total time: the one the provider
 *   reported with `done` (`tokensSource: "stream"`), or else the estimate of `estimateTokens`.
 * - A call that fails (an `error` event, or `chat` rejecting) is a failed task with the kind of the
 *   error, and the run goes on with the next task.
 * - When `signal` aborts, the request in flight is cancelled with `ai.cancel`, no further task is
 *   sent, and the result is `cancelled` with the tasks that were done (the one cut short is not one
 *   of them).
 * - Rejects with `BenchRefusedError`, before any request, for a provider that is not on this
 *   computer, a blank model or tasks that share an id.
 */
export async function runBench(options: RunBenchOptions): Promise<BenchRun> {
  const { ai, provider, tasks, now, signal, onProgress } = options;
  const model = options.model.trim() === "" ? provider.model.trim() : options.model.trim();
  const problem = benchProviderProblem(provider, model);
  if (problem !== undefined) throw new BenchRefusedError(problem);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new BenchRefusedError("two tasks share an id");
  }

  const startMs = now();
  runCounter += 1;
  const prefix = `bench-${Math.max(0, Math.trunc(startMs)).toString(36)}-${runCounter}`;
  const results: BenchTaskRun[] = [];
  let state: BenchRun["state"] = "complete";
  let inFlight: string | undefined;
  let cancelling: Promise<unknown> | undefined;
  const onAbort = (): void => {
    if (inFlight !== undefined) cancelling = ai.cancel(inFlight).catch(() => false);
  };
  // A function, not a read of `signal.aborted` in place: the signal changes while a request is awaited.
  const isAborted = (): boolean => signal?.aborted === true;
  signal?.addEventListener("abort", onAbort, { once: true });
  const progress = (event: BenchProgress): void => {
    try {
      onProgress?.(event);
    } catch {
      // A watcher that throws does not stop the run.
    }
  };

  try {
    for (const [index, task] of tasks.entries()) {
      if (isAborted()) {
        state = "cancelled";
        break;
      }
      progress({ type: "start", index, total: tasks.length, taskId: task.id });
      const requestId = `${prefix}-${index}`;
      const started = now();
      const seen: {
        firstMs: number | null;
        endMs: number;
        text: string;
        /** The count of tokens the provider reported with `done`, when it did. */
        tokens: number | null;
        ending: Ending | null;
      } = {
        firstMs: null,
        endMs: started,
        text: "",
        tokens: null,
        ending: null,
      };
      const onEvent = (event: AiChatEvent): void => {
        if (seen.ending !== null) return;
        if (event.type === "delta") {
          if (seen.firstMs === null && event.text !== "") seen.firstMs = now() - started;
          seen.text += event.text;
          return;
        }
        seen.endMs = now();
        if (event.type === "done" && event.outputTokens !== undefined) {
          seen.tokens = event.outputTokens;
        }
        seen.ending =
          event.type === "done"
            ? { ok: true }
            : { ok: false, kind: event.kind, message: event.message };
      };

      inFlight = requestId;
      try {
        await ai.chat(
          { requestId, providerId: provider.id, model, messages: benchMessages(task) },
          onEvent,
        );
      } catch (error) {
        if (seen.ending === null) {
          seen.endMs = now();
          seen.ending = { ok: false, kind: "invalid-request", message: errorText(error) };
        }
      } finally {
        inFlight = undefined;
      }
      await cancelling;
      cancelling = undefined;

      const ending: Ending = seen.ending ?? {
        ok: false,
        kind: "protocol",
        message: "the provider ended the answer without saying it was done",
      };
      if (seen.ending === null) seen.endMs = now();
      if (isAborted() && !ending.ok && ending.kind === "cancelled") {
        state = "cancelled";
        break;
      }

      const totalMs = seen.endMs - started;
      // A count the provider reported wins over the estimate. A count of 0 next to an answer with
      // text says nothing, so the estimate stays; so does a count that is not a whole number.
      const reported =
        ending.ok && seen.tokens !== null && Number.isSafeInteger(seen.tokens) && seen.tokens > 0
          ? seen.tokens
          : null;
      const outputTokens = reported ?? estimateTokens(seen.text);
      const checked = ending.ok ? checkBenchAnswer(task, seen.text) : undefined;
      const result: BenchTaskRun = {
        id: task.id,
        kind: task.kind,
        ok: checked?.ok === true,
        reason: ending.ok
          ? checked !== undefined && !checked.ok
            ? checked.reason
            : null
          : `the provider failed: ${ending.kind}`,
        firstChunkMs: seen.firstMs,
        totalMs,
        outputTokens,
        tokensSource: reported === null ? "estimate" : "stream",
        tokensPerSecond:
          ending.ok && totalMs > 0 && outputTokens > 0
            ? round2(outputTokens / (totalMs / 1000))
            : null,
        error: ending.ok ? null : { kind: ending.kind, message: ending.message },
      };
      results.push(result);
      progress({ type: "done", index, total: tasks.length, result });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  return benchRunSchema.parse({
    version: BENCH_RUN_VERSION,
    startedAt: new Date(startMs).toISOString(),
    provider: { id: provider.id, kind: provider.kind, baseUrl: provider.baseUrl },
    model,
    state,
    planned: tasks.length,
    tasks: results,
    totals: summarizeBenchTasks(results),
    memory: null,
  });
}

// ---- The file ----

/**
 * The path of the file that keeps a run, `bench-results/<YYYY-MM-DD-HHmmss>.json`, from the time it
 * started (UTC, so the name does not depend on the time zone of the computer).
 */
export function benchResultPath(startedAt: string): string {
  const time = Date.parse(startedAt);
  if (Number.isNaN(time)) throw new Error(`\`${startedAt}\` is not a date`);
  const iso = new Date(time).toISOString();
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(":", "")}`;
  return `${BENCH_RESULTS_DIR}/${stamp}.json`;
}

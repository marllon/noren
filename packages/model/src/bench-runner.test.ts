/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AiBackend,
  AiChatEvent,
  AiChatRequest,
  AiConnectionResult,
  AiErrorKind,
  AiProviderInfo,
  OllamaModels,
} from "./ai";
import {
  BENCH_CHARS_PER_TOKEN,
  BENCH_RUN_VERSION,
  BenchRefusedError,
  benchMedian,
  benchMessages,
  benchProviderProblem,
  benchResultPath,
  benchRunSchema,
  estimateTokens,
  runBench,
  summarizeBenchTasks,
  type BenchProgress,
  type BenchRun,
  type BenchTaskRun,
} from "./bench-runner";
import { checkBenchSuite, type BenchTask } from "./bench-suite";
import { FakeBackend } from "./fake-backend";

// The runner of the bench (NOR-F16-02a) against the real suite in `bench/tasks` and a fake provider:
// no network, no file written. The clock is injected, so the latencies are exact.

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
const task = (id: string): BenchTask => {
  const found = SUITE.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no task ${id}`);
  return found;
};

const OLLAMA: AiProviderInfo = {
  id: "ollama",
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "",
  hasKey: false,
};

/** A clock that moves 10 ms at every read, for the tests that do not care about the times. */
function steppingClock(start = 1_760_000_000_000): () => number {
  let t = start;
  return () => {
    t += 10;
    return t;
  };
}

/** The user message of a request tells which task it is for. */
function taskOf(request: AiChatRequest): BenchTask {
  const user = request.messages.find((m) => m.role === "user")?.content;
  const found = SUITE.find((t) => benchMessages(t)[1]?.content === user);
  if (found === undefined) throw new Error("a request that is not of a task of the suite");
  return found;
}

const rightAnswer = (t: BenchTask): string => t.examples.pass[0] ?? "";
const wrongAnswer = (t: BenchTask): string => t.examples.fail[0] ?? "";

function fakeWithReplies(reply: (request: AiChatRequest) => string): FakeBackend {
  return new FakeBackend({ ollamaModels: ["llama3.2"], aiReply: reply });
}

// ---- A fake provider with a script, for the exact latencies and the failures ----

interface Script {
  /** The pieces of the answer and the time each one takes to arrive (ms after the previous event). */
  deltas: { after: number; text: string }[];
  /** The time from the last piece to the end. */
  endAfter: number;
  /** The end: `done`, an `error` event of this kind, `reject` (chat rejects) or `silent` (no end event). */
  end?: "done" | "reject" | "silent" | { error: AiErrorKind; message: string };
  /** The count of tokens the provider reports with `done`; left out of the event when absent. */
  outputTokens?: number;
}

class ScriptedAi implements AiBackend {
  readonly requests: AiChatRequest[] = [];
  readonly cancels: string[] = [];
  readonly #cancelled = new Set<string>();

  constructor(
    private readonly clock: { t: number },
    private readonly script: (request: AiChatRequest, index: number) => Script,
    /** Runs while the answer of request `index` is in the middle (after its first piece). */
    private readonly onMiddle?: (index: number) => void,
    private readonly honoursCancel = true,
  ) {}

  async providers(): Promise<AiProviderInfo[]> {
    return [OLLAMA];
  }
  async configure(): Promise<void> {
    throw new Error("not used");
  }
  async setKey(): Promise<void> {
    throw new Error("not used");
  }
  async listOllamaModels(): Promise<OllamaModels> {
    return { found: false };
  }
  async ollamaMemory(): Promise<null> {
    return null;
  }
  async testConnection(): Promise<AiConnectionResult> {
    return { ok: true };
  }

  async chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void): Promise<void> {
    const index = this.requests.length;
    this.requests.push(request);
    const script = this.script(request, index);
    for (const [at, delta] of script.deltas.entries()) {
      this.clock.t += delta.after;
      onEvent({ type: "delta", text: delta.text });
      await Promise.resolve();
      if (at === 0) this.onMiddle?.(index);
      await Promise.resolve();
      if (this.honoursCancel && this.#cancelled.has(request.requestId)) {
        onEvent({ type: "error", kind: "cancelled", message: "cancelled" });
        return;
      }
    }
    this.clock.t += script.endAfter;
    const end = script.end ?? "done";
    if (end === "reject") throw new Error("the provider is not there");
    if (end === "silent") return;
    if (end === "done") {
      onEvent(
        script.outputTokens === undefined
          ? { type: "done" }
          : { type: "done", outputTokens: script.outputTokens },
      );
    } else onEvent({ type: "error", kind: end.error, message: end.message });
  }

  async cancel(requestId: string): Promise<boolean> {
    this.cancels.push(requestId);
    this.#cancelled.add(requestId);
    return true;
  }
}

/** A script that answers the task with its right answer in one piece. */
const rightInOne =
  (after = 100, endAfter = 50) =>
  (request: AiChatRequest): Script => ({
    deltas: [{ after, text: rightAnswer(taskOf(request)) }],
    endAfter,
  });

// ---- Tests ----

describe("benchMessages", () => {
  it("has a system message by kind and a user message with the prompt and the input", () => {
    const bash = task("cmd-bash-10");
    const pwsh = task("cmd-pwsh-01");
    const explain = task("explain-02");
    const summarize = task("summarize-03");
    const system = (t: BenchTask): string => benchMessages(t)[0]?.content ?? "";
    expect(system(bash)).toContain("bash command");
    expect(system(pwsh)).toContain("PowerShell command");
    expect(system(explain)).toMatch(/explain/i);
    expect(system(summarize)).toMatch(/summarize/i);
    expect(new Set([system(bash), system(pwsh), system(explain), system(summarize)]).size).toBe(4);
    for (const t of [bash, pwsh, explain, summarize]) {
      const messages = benchMessages(t);
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(messages[1]?.content).toContain(t.prompt);
    }
    expect(benchMessages(explain)[1]?.content).toContain("zsh: command not found: pnpm");
    expect(benchMessages(bash)[1]?.content).toBe(bash.prompt);
  });

  it("tells a command task to answer with the command alone", () => {
    expect(benchMessages(task("cmd-bash-01"))[0]?.content).toMatch(/alone|only/);
    expect(benchMessages(task("cmd-bash-01"))[0]?.content).toMatch(/no code fence/);
  });
});

describe("runBench: counting the right answers", () => {
  it("counts exactly the right answers of the suite, by kind, over all 60 tasks", async () => {
    // Every other task is answered wrongly (with a fail example of the suite itself).
    const wrongIds = new Set(SUITE.filter((_, i) => i % 2 === 1).map((t) => t.id));
    const backend = fakeWithReplies((request) => {
      const t = taskOf(request);
      return wrongIds.has(t.id) ? wrongAnswer(t) : rightAnswer(t);
    });
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "llama3.2",
      tasks: SUITE,
      now: steppingClock(),
    });

    const expectedPassed = (kind?: string): number =>
      SUITE.filter((t) => !wrongIds.has(t.id) && (kind === undefined || t.kind === kind)).length;
    expect(run.state).toBe("complete");
    expect(run.planned).toBe(60);
    expect(run.tasks).toHaveLength(60);
    expect(run.totals.overall).toMatchObject({ total: 60, passed: expectedPassed(), errors: 0 });
    expect(run.totals.byKind.command).toMatchObject({
      total: 20,
      passed: expectedPassed("command"),
    });
    expect(run.totals.byKind.explain).toMatchObject({
      total: 20,
      passed: expectedPassed("explain"),
    });
    expect(run.totals.byKind.summarize).toMatchObject({
      total: 20,
      passed: expectedPassed("summarize"),
    });
    for (const result of run.tasks) {
      expect(result.ok).toBe(!wrongIds.has(result.id));
      expect(result.reason === null).toBe(result.ok);
      expect(result.error).toBeNull();
    }
    expect(run.totals.overall.accuracy).toBe(expectedPassed() / 60);
  });

  it("sends one request per task, in order, each with its own id, the model and the messages of the task", async () => {
    const backend = fakeWithReplies((request) => rightAnswer(taskOf(request)));
    const tasks = SUITE.slice(0, 5);
    await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "  llama3.2  ",
      tasks,
      now: steppingClock(),
    });
    const sent = backend.callsTo("ai.chat").map((call) => call.args[0] as AiChatRequest);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((r) => r.requestId)).size).toBe(5);
    for (const [i, request] of sent.entries()) {
      expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(request.providerId).toBe("ollama");
      expect(request.model).toBe("llama3.2");
      expect(request.messages).toEqual(benchMessages(tasks[i] as BenchTask));
    }
  });

  it("uses a different request id in each run", async () => {
    const ids: string[] = [];
    const backend = fakeWithReplies((request) => {
      ids.push(request.requestId);
      return rightAnswer(taskOf(request));
    });
    const once = () =>
      runBench({
        ai: backend.ai,
        provider: OLLAMA,
        model: "m",
        tasks: SUITE.slice(0, 2),
        now: steppingClock(),
      });
    await once();
    await once();
    expect(new Set(ids).size).toBe(4);
  });

  it("falls back to the default model of the provider when the model is blank", async () => {
    const backend = fakeWithReplies((request) => rightAnswer(taskOf(request)));
    const run = await runBench({
      ai: backend.ai,
      provider: { ...OLLAMA, id: "ollama", model: "qwen2.5" },
      model: " ",
      tasks: SUITE.slice(0, 1),
      now: steppingClock(),
    });
    expect(run.model).toBe("qwen2.5");
    expect((backend.callsTo("ai.chat")[0]?.args[0] as AiChatRequest).model).toBe("qwen2.5");
  });
});

describe("runBench: measuring", () => {
  it("reads the exact latencies and the tokens per second from the clock", async () => {
    const clock = { t: 5_000 };
    const a = task("cmd-bash-10"); // "chmod +x deploy.sh" is 18 characters: 5 tokens
    const ai = new ScriptedAi(clock, (request) => {
      const t = taskOf(request);
      if (t.id === a.id) {
        return {
          deltas: [
            { after: 120, text: "chmod +x " },
            { after: 80, text: "deploy.sh" },
          ],
          endAfter: 200,
        };
      }
      // The second task: a wrong answer in three pieces.
      return {
        deltas: [
          { after: 40, text: wrongAnswer(t).slice(0, 4) },
          { after: 10, text: wrongAnswer(t).slice(4) },
        ],
        endAfter: 50,
      };
    });
    const b = task("explain-02");
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [a, b],
      now: () => clock.t,
    });
    const [first, second] = run.tasks;
    expect(first).toMatchObject({
      id: "cmd-bash-10",
      ok: true,
      reason: null,
      firstChunkMs: 120,
      totalMs: 400,
      outputTokens: Math.ceil("chmod +x deploy.sh".length / BENCH_CHARS_PER_TOKEN),
      tokensSource: "estimate",
      error: null,
    });
    expect(first?.tokensPerSecond).toBe(12.5); // 5 tokens over 0.4 s
    expect(second).toMatchObject({ id: "explain-02", ok: false, firstChunkMs: 40, totalMs: 100 });
    expect(second?.reason).not.toBeNull();
    expect(second?.tokensPerSecond).toBe(
      Math.round((estimateTokens(wrongAnswer(b)) / 0.1) * 100) / 100,
    );
    // The medians are over the two tasks: the mean of the two middle values.
    expect(run.totals.overall.medianFirstChunkMs).toBe(80);
    expect(run.totals.overall.medianTotalMs).toBe(250);
    expect(run.totals.byKind.command.medianTotalMs).toBe(400);
    expect(run.totals.byKind.summarize.medianTotalMs).toBeNull();
    expect(run.startedAt).toBe(new Date(5_000).toISOString());
  });

  it("takes the first delta that has text for the first chunk", async () => {
    const clock = { t: 0 };
    const t = task("cmd-bash-10");
    const ai = new ScriptedAi(clock, () => ({
      deltas: [
        { after: 30, text: "" },
        { after: 70, text: "chmod +x deploy.sh" },
      ],
      endAfter: 0,
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [t],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({ firstChunkMs: 100, totalMs: 100, ok: true });
  });

  it("estimates a token as 4 characters of the answer, rounded up", () => {
    expect(BENCH_CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("😀😀😀😀")).toBe(1); // characters, not UTF-16 units
  });

  it("gives no tokens per second for an answer that took no time", async () => {
    const clock = { t: 0 };
    const ai = new ScriptedAi(clock, rightInOne(0, 0));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [task("cmd-bash-10")],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({ totalMs: 0, ok: true, tokensPerSecond: null });
  });
});

describe("runBench: the count of tokens the provider reports", () => {
  it("uses the count of the stream for the tokens and the tokens per second", async () => {
    const clock = { t: 1_000 };
    const t = task("cmd-bash-10");
    const ai = new ScriptedAi(clock, (request) => ({
      deltas: [{ after: 100, text: rightAnswer(taskOf(request)) }],
      endAfter: 400,
      outputTokens: 20,
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [t],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({
      ok: true,
      totalMs: 500,
      outputTokens: 20,
      tokensSource: "stream",
      tokensPerSecond: 40, // 20 tokens over 0.5 s, not the estimate of the characters
    });
    expect(estimateTokens(rightAnswer(t))).not.toBe(20);
    expect(benchRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("keeps the estimate when the provider reports no count", async () => {
    const clock = { t: 0 };
    const t = task("cmd-bash-10");
    const ai = new ScriptedAi(clock, rightInOne(100, 300));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [t],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({
      outputTokens: estimateTokens(rightAnswer(t)),
      tokensSource: "estimate",
      tokensPerSecond: 12.5,
    });
  });

  it("mixes the two in one run, each task by what its provider said", async () => {
    const clock = { t: 0 };
    const tasks = SUITE.slice(0, 6);
    // Tasks 0, 2 and 4 report a count (7, 8, 9); 1, 3 and 5 do not.
    const ai = new ScriptedAi(clock, (request, index) => ({
      deltas: [{ after: 50, text: rightAnswer(taskOf(request)) }],
      endAfter: 50,
      ...(index % 2 === 0 ? { outputTokens: 7 + index / 2 } : {}),
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks,
      now: () => clock.t,
    });
    expect(run.tasks.map((r) => r.tokensSource)).toEqual([
      "stream",
      "estimate",
      "stream",
      "estimate",
      "stream",
      "estimate",
    ]);
    expect(run.tasks.filter((_, i) => i % 2 === 0).map((r) => r.outputTokens)).toEqual([7, 8, 9]);
    for (const [i, r] of run.tasks.entries()) {
      if (i % 2 === 1)
        expect(r.outputTokens).toBe(estimateTokens(rightAnswer(tasks[i] as BenchTask)));
      expect(r.tokensPerSecond).toBe(Math.round((r.outputTokens / 0.1) * 100) / 100);
    }
    // The schema takes both sources in one result, and so does a round trip through JSON.
    expect(benchRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("keeps the estimate for a count of 0 next to an answer with text", async () => {
    const clock = { t: 0 };
    const t = task("cmd-bash-10");
    const ai = new ScriptedAi(clock, () => ({
      deltas: [{ after: 10, text: rightAnswer(t) }],
      endAfter: 10,
      outputTokens: 0,
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [t],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({
      outputTokens: estimateTokens(rightAnswer(t)),
      tokensSource: "estimate",
    });
  });

  it("does not use a count for a call that failed", async () => {
    const clock = { t: 0 };
    const t = task("cmd-bash-10");
    const ai = new ScriptedAi(clock, () => ({
      deltas: [{ after: 10, text: "chmod" }],
      endAfter: 10,
      end: { error: "network", message: "reset" },
      outputTokens: 99,
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [t],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({
      ok: false,
      tokensSource: "estimate",
      tokensPerSecond: null,
    });
    expect(run.tasks[0]?.outputTokens).toBe(estimateTokens("chmod"));
  });

  it("works through the fake backend when it reports a count per request", async () => {
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: (request) => rightAnswer(taskOf(request)),
      aiTokens: (request) => (taskOf(request).kind === "command" ? 11 : undefined),
    });
    const tasks = [task("cmd-bash-10"), task("explain-02")];
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "llama3.2",
      tasks,
      now: steppingClock(),
    });
    expect(run.tasks.map((r) => r.tokensSource)).toEqual(["stream", "estimate"]);
    expect(run.tasks[0]?.outputTokens).toBe(11);
    expect(benchRunSchema.safeParse(run).success).toBe(true);
  });
});

describe("runBench: a provider that fails", () => {
  it("counts an error event as a failure with its kind and goes on with the next task", async () => {
    const clock = { t: 0 };
    const tasks = [task("cmd-bash-10"), task("cmd-bash-01"), task("explain-02")];
    const ai = new ScriptedAi(clock, (request, index) =>
      index === 1
        ? { deltas: [], endAfter: 30, end: { error: "network", message: "connection refused" } }
        : rightInOne(100, 20)(request),
    );
    const run = await runBench({ ai, provider: OLLAMA, model: "m", tasks, now: () => clock.t });
    expect(ai.requests).toHaveLength(3);
    expect(run.state).toBe("complete");
    expect(run.tasks.map((r) => r.ok)).toEqual([true, false, true]);
    expect(run.tasks[1]).toMatchObject({
      id: "cmd-bash-01",
      kind: "command",
      ok: false,
      reason: "the provider failed: network",
      firstChunkMs: null,
      totalMs: 30,
      outputTokens: 0,
      tokensPerSecond: null,
      error: { kind: "network", message: "connection refused" },
    });
    expect(run.totals.overall).toMatchObject({ total: 3, passed: 2, errors: 1 });
    expect(run.totals.byKind.command).toMatchObject({ total: 2, passed: 1, errors: 1 });
    // The failed call is not in the medians.
    expect(run.totals.byKind.command.medianTotalMs).toBe(120);
  });

  it("never counts a partial answer as right when the stream breaks", async () => {
    const clock = { t: 0 };
    const t = task("cmd-bash-10");
    const ai = new ScriptedAi(clock, () => ({
      deltas: [{ after: 10, text: "chmod +x deploy.sh" }],
      endAfter: 5,
      end: { error: "timeout", message: "no answer in time" },
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [t],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({
      ok: false,
      firstChunkMs: 10,
      error: { kind: "timeout" },
    });
  });

  it("counts a chat that rejects as a failure and goes on", async () => {
    const clock = { t: 0 };
    const tasks = [task("cmd-bash-10"), task("explain-02")];
    const ai = new ScriptedAi(clock, (request, index) =>
      index === 0 ? { deltas: [], endAfter: 7, end: "reject" } : rightInOne()(request),
    );
    const run = await runBench({ ai, provider: OLLAMA, model: "m", tasks, now: () => clock.t });
    expect(run.tasks[0]).toMatchObject({
      ok: false,
      totalMs: 7,
      error: { kind: "invalid-request", message: "the provider is not there" },
    });
    expect(run.tasks[1]?.ok).toBe(true);
  });

  it("counts an answer that ends without done or error as a protocol failure", async () => {
    const clock = { t: 0 };
    const ai = new ScriptedAi(clock, () => ({
      deltas: [{ after: 10, text: "chmod +x deploy.sh" }],
      endAfter: 5,
      end: "silent",
    }));
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: [task("cmd-bash-10")],
      now: () => clock.t,
    });
    expect(run.tasks[0]).toMatchObject({ ok: false, error: { kind: "protocol" } });
  });

  it("counts the real fake provider with no Ollama as a failure of every task", async () => {
    const backend = new FakeBackend(); // no Ollama installed: every chat ends with a network error
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 3),
      now: steppingClock(),
    });
    expect(run.tasks.map((r) => r.error?.kind)).toEqual(["network", "network", "network"]);
    expect(run.totals.overall).toMatchObject({ total: 3, passed: 0, errors: 3, accuracy: 0 });
  });
});

describe("runBench: cancelling", () => {
  it("cancels the request in flight, sends no further task and keeps the ones that were done", async () => {
    const controller = new AbortController();
    let asked = 0;
    const backend = fakeWithReplies((request) => {
      asked += 1;
      if (asked === 3) controller.abort(); // the third request is under way
      return rightAnswer(taskOf(request));
    });
    const progress: BenchProgress[] = [];
    const tasks = SUITE.slice(0, 6);
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks,
      now: steppingClock(),
      signal: controller.signal,
      onProgress: (p) => progress.push(p),
    });
    const sent = backend.callsTo("ai.chat").map((call) => call.args[0] as AiChatRequest);
    expect(sent).toHaveLength(3);
    expect(backend.callsTo("ai.cancel").map((call) => call.args[0])).toEqual([sent[2]?.requestId]);
    expect(run.state).toBe("cancelled");
    expect(run.planned).toBe(6);
    expect(run.tasks.map((r) => r.id)).toEqual(tasks.slice(0, 2).map((t) => t.id));
    expect(run.totals.overall.total).toBe(2);
    expect(progress.filter((p) => p.type === "done")).toHaveLength(2);
    expect(progress.filter((p) => p.type === "start")).toHaveLength(3);
  });

  it("sends nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = fakeWithReplies((request) => rightAnswer(taskOf(request)));
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 3),
      now: steppingClock(),
      signal: controller.signal,
    });
    expect(backend.callsTo("ai.chat")).toHaveLength(0);
    expect(backend.callsTo("ai.cancel")).toHaveLength(0);
    expect(run.state).toBe("cancelled");
    expect(run.tasks).toEqual([]);
    expect(run.totals.overall).toMatchObject({ total: 0, accuracy: 0, medianTotalMs: null });
  });

  it("keeps a task that ended with done even when the cancel came too late, and stops after it", async () => {
    const clock = { t: 0 };
    const controller = new AbortController();
    const ai = new ScriptedAi(
      clock,
      rightInOne(),
      (index) => {
        if (index === 1) controller.abort();
      },
      false, // this provider does not stop for a cancel: the answer goes on to its done
    );
    const run = await runBench({
      ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 4),
      now: () => clock.t,
      signal: controller.signal,
    });
    expect(ai.cancels).toHaveLength(1);
    expect(ai.requests).toHaveLength(2);
    expect(run.state).toBe("cancelled");
    expect(run.tasks.map((r) => r.ok)).toEqual([true, true]);
  });

  it("does not leave a listener on the signal", async () => {
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: () => {
        added += 1;
      },
      removeEventListener: () => {
        removed += 1;
      },
    };
    const backend = fakeWithReplies((request) => rightAnswer(taskOf(request)));
    await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 1),
      now: steppingClock(),
      signal,
    });
    expect([added, removed]).toEqual([1, 1]);
  });
});

describe("runBench: the memory of the model", () => {
  const LOADED = { bytes: 5_137_025_024, vramBytes: 4_000_000_000 };
  const LM_STUDIO: AiProviderInfo = {
    id: "lmstudio",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    model: "",
    hasKey: false,
  };
  const answer = (request: AiChatRequest): string => rightAnswer(taskOf(request));

  it("fills memory with what Ollama says, asked once after the last task", async () => {
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: answer,
      ollamaMemory: LOADED,
    });
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "llama3.2",
      tasks: SUITE.slice(0, 3),
      now: steppingClock(),
    });
    expect(run.state).toBe("complete");
    expect(run.memory).toEqual({ source: "ollama", ...LOADED });
    const asked = backend.callsTo("ai.ollamaMemory");
    expect(asked.map((call) => call.args)).toEqual([["llama3.2"]]);
    // After every task: the model is loaded by then.
    const methods = backend.calls.map((call) => call.method);
    expect(methods.lastIndexOf("ai.chat")).toBeLessThan(methods.indexOf("ai.ollamaMemory"));
    expect(benchRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("asks for the model of the run, also when the model comes from the provider", async () => {
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: answer,
      ollamaMemory: LOADED,
    });
    await runBench({
      ai: backend.ai,
      provider: { ...OLLAMA, model: " qwen2.5:7b " },
      model: " ",
      tasks: SUITE.slice(0, 1),
      now: steppingClock(),
    });
    expect(backend.callsTo("ai.ollamaMemory").map((call) => call.args)).toEqual([["qwen2.5:7b"]]);
  });

  it("is null when Ollama does not have the model loaded, and the run is complete", async () => {
    const backend = new FakeBackend({ ollamaModels: ["llama3.2"], aiReply: answer });
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "llama3.2",
      tasks: SUITE.slice(0, 3),
      now: steppingClock(),
    });
    expect(backend.callsTo("ai.ollamaMemory")).toHaveLength(1);
    expect(run.memory).toBeNull();
    expect(run.state).toBe("complete");
    expect(run.tasks).toHaveLength(3);
  });

  it("is null when asking rejects, and the run is complete with every task", async () => {
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: answer,
      ollamaMemory: () => {
        throw new Error("the bridge is gone");
      },
    });
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "llama3.2",
      tasks: SUITE.slice(0, 3),
      now: steppingClock(),
    });
    expect(backend.callsTo("ai.ollamaMemory")).toHaveLength(1);
    expect(run.memory).toBeNull();
    expect(run.state).toBe("complete");
    expect(run.tasks.map((r) => r.ok)).toEqual([true, true, true]);
  });

  it("is null for a backend that has no such method, or one that answers something invalid", async () => {
    const base = new FakeBackend({ ollamaModels: ["llama3.2"], aiReply: answer });
    const options = {
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 2),
    };
    const without = Object.create(base.ai) as AiBackend;
    (without as { ollamaMemory?: unknown }).ollamaMemory = undefined;
    expect((await runBench({ ...options, ai: without, now: steppingClock() })).memory).toBeNull();
    const bad: unknown[] = [
      { bytes: -1, vramBytes: 0 },
      { bytes: 1.5, vramBytes: 0 },
      { bytes: "9", vramBytes: 0 },
      { bytes: 9, vramBytes: Number.NaN },
      { bytes: Number.MAX_SAFE_INTEGER + 1, vramBytes: 0 },
      { bytes: 9 },
      undefined,
    ];
    for (const reading of bad) {
      const ai = Object.create(base.ai) as AiBackend;
      ai.ollamaMemory = () => Promise.resolve(reading as never);
      const run = await runBench({ ...options, ai, now: steppingClock() });
      expect(run.memory, JSON.stringify(reading)).toBeNull();
      expect(run.state).toBe("complete");
    }
  });

  it("never asks for a provider that is not Ollama", async () => {
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: answer,
      ollamaMemory: LOADED,
    });
    const run = await runBench({
      ai: backend.ai,
      provider: LM_STUDIO,
      model: "m",
      tasks: SUITE.slice(0, 2),
      now: steppingClock(),
    });
    expect(backend.callsTo("ai.ollamaMemory")).toHaveLength(0);
    expect(run.memory).toBeNull();
  });

  it("measures a run that was cancelled with some tasks done", async () => {
    const controller = new AbortController();
    let asked = 0;
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: (request) => {
        asked += 1;
        if (asked === 3) controller.abort();
        return rightAnswer(taskOf(request));
      },
      ollamaMemory: LOADED,
    });
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 6),
      now: steppingClock(),
      signal: controller.signal,
    });
    expect(run.state).toBe("cancelled");
    expect(run.tasks).toHaveLength(2);
    expect(backend.callsTo("ai.ollamaMemory")).toHaveLength(1);
    expect(run.memory).toEqual({ source: "ollama", ...LOADED });
    expect(benchRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
  });

  it("does not ask when no task was done", async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: answer,
      ollamaMemory: LOADED,
    });
    const cancelled = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 3),
      now: steppingClock(),
      signal: controller.signal,
    });
    expect(cancelled.tasks).toEqual([]);
    const empty = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: [],
      now: steppingClock(),
    });
    expect(empty.tasks).toEqual([]);
    expect(backend.callsTo("ai.ollamaMemory")).toHaveLength(0);
    expect([cancelled.memory, empty.memory]).toEqual([null, null]);
  });

  it("asks also when every call failed, since the tasks were done (and failed)", async () => {
    // No Ollama on the fake computer: every chat ends with an error event.
    const backend = new FakeBackend({ ollamaMemory: LOADED });
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks: SUITE.slice(0, 2),
      now: steppingClock(),
    });
    expect(run.tasks.every((r) => r.error !== null)).toBe(true);
    expect(backend.callsTo("ai.ollamaMemory")).toHaveLength(1);
  });

  it("reports the memory of the model the function names, per model", async () => {
    const backend = new FakeBackend({
      ollamaModels: ["llama3.2"],
      aiReply: answer,
      ollamaMemory: (model) => (model === "big" ? { bytes: 9, vramBytes: 3 } : null),
    });
    const options = { ai: backend.ai, provider: OLLAMA, tasks: SUITE.slice(0, 1) };
    const big = await runBench({ ...options, model: "big", now: steppingClock() });
    const small = await runBench({ ...options, model: "small", now: steppingClock() });
    expect(big.memory).toEqual({ source: "ollama", bytes: 9, vramBytes: 3 });
    expect(small.memory).toBeNull();
  });
});

describe("runBench: a provider that is not on this computer", () => {
  const remote: [string, string][] = [
    ["a hosted API", "https://api.openai.com/v1"],
    ["an address of the local network", "http://192.168.1.5:11434/v1"],
    ["a name that starts with localhost", "http://localhost.evil.example/v1"],
    ["a host written before an @", "http://127.0.0.1@evil.example/v1"],
    ["a user name and password", "http://user:secret@localhost:11434/v1"],
    ["a name that is not an address", "localhost:11434"],
    ["another scheme", "ftp://localhost/v1"],
  ];

  for (const [label, baseUrl] of remote) {
    it(`refuses ${label} without sending anything`, async () => {
      const backend = fakeWithReplies((request) => rightAnswer(taskOf(request)));
      await expect(
        runBench({
          ai: backend.ai,
          provider: { ...OLLAMA, id: "remote", baseUrl },
          model: "m",
          tasks: SUITE.slice(0, 2),
          now: steppingClock(),
        }),
      ).rejects.toBeInstanceOf(BenchRefusedError);
      expect(backend.callsTo("ai.chat")).toHaveLength(0);
    });
  }

  for (const baseUrl of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:11434/v1",
    "HTTP://LOCALHOST/v1",
    "https://localhost:8443",
  ]) {
    it(`accepts ${baseUrl}`, () => {
      expect(benchProviderProblem({ ...OLLAMA, baseUrl }, "m")).toBeUndefined();
    });
  }

  it("says why in the message of the refusal", async () => {
    const backend = fakeWithReplies(() => "");
    await expect(
      runBench({
        ai: backend.ai,
        provider: { ...OLLAMA, id: "my-openai", baseUrl: "https://api.openai.com/v1" },
        model: "m",
        tasks: SUITE.slice(0, 1),
        now: steppingClock(),
      }),
    ).rejects.toThrow(/only against a provider on this computer.*my-openai.*api\.openai\.com/);
  });

  it("refuses when no model is named and the provider has no default", async () => {
    const backend = fakeWithReplies(() => "");
    await expect(
      runBench({
        ai: backend.ai,
        provider: OLLAMA,
        model: "  ",
        tasks: SUITE.slice(0, 1),
        now: steppingClock(),
      }),
    ).rejects.toThrow(/name the model/);
    expect(backend.callsTo("ai.chat")).toHaveLength(0);
  });

  it("refuses two tasks with the same id", async () => {
    const backend = fakeWithReplies(() => "");
    const one = task("cmd-bash-10");
    await expect(
      runBench({
        ai: backend.ai,
        provider: OLLAMA,
        model: "m",
        tasks: [one, one],
        now: steppingClock(),
      }),
    ).rejects.toThrow(/share an id/);
    expect(backend.callsTo("ai.chat")).toHaveLength(0);
  });
});

describe("the result", () => {
  async function sampleRun(): Promise<BenchRun> {
    const backend = fakeWithReplies((request) => {
      const t = taskOf(request);
      return t.kind === "summarize" ? wrongAnswer(t) : rightAnswer(t);
    });
    return runBench({
      ai: backend.ai,
      provider: { ...OLLAMA, hasKey: true },
      model: "llama3.2",
      tasks: SUITE,
      now: steppingClock(1_760_000_000_000),
    });
  }

  it("passes the schema and comes back equal from JSON", async () => {
    const run = await sampleRun();
    expect(benchRunSchema.parse(run)).toEqual(run);
    const again = benchRunSchema.parse(JSON.parse(JSON.stringify(run)));
    expect(again).toEqual(run);
    expect(run.version).toBe(BENCH_RUN_VERSION);
    expect(run.memory).toBeNull();
  });

  it("holds the provider without a key, only its id, kind and address", async () => {
    const run = await sampleRun();
    expect(run.provider).toEqual({
      id: "ollama",
      kind: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(JSON.stringify(run)).not.toMatch(/hasKey|apiKey|api_key|secret/i);
  });

  it("refuses a result that is not what the tasks add up to", async () => {
    const run = await sampleRun();
    const bump = (mutate: (copy: BenchRun) => void): boolean => {
      const copy = structuredClone(run);
      mutate(copy);
      return benchRunSchema.safeParse(copy).success;
    };
    expect(bump(() => undefined)).toBe(true);
    expect(bump((c) => void (c.totals.overall.passed += 1))).toBe(false);
    expect(bump((c) => void (c.totals.byKind.command.total -= 1))).toBe(false);
    expect(bump((c) => void (c.totals.overall.medianTotalMs = 1))).toBe(false);
    expect(bump((c) => void (c.state = "cancelled"))).toBe(true); // 60 of 60 done is a fine cancelled run
    expect(bump((c) => void (c.planned = 61))).toBe(false); // complete, but not every task was done
    expect(bump((c) => void c.tasks.pop())).toBe(false);
    expect(bump((c) => void (c.tasks[1] = structuredClone(c.tasks[0] as BenchTaskRun)))).toBe(
      false,
    );
    expect(bump((c) => void (c.tasks[0] = { ...(c.tasks[0] as BenchTaskRun), ok: false }))).toBe(
      false,
    );
  });

  it("refuses keys it does not know, a wrong version and a date that is not one", async () => {
    const run = await sampleRun();
    expect(benchRunSchema.safeParse({ ...run, apiKey: "x" }).success).toBe(false);
    expect(
      benchRunSchema.safeParse({ ...run, provider: { ...run.provider, hasKey: true } }).success,
    ).toBe(false);
    expect(benchRunSchema.safeParse({ ...run, version: 2 }).success).toBe(false);
    expect(benchRunSchema.safeParse({ ...run, startedAt: "yesterday" }).success).toBe(false);
    expect(benchRunSchema.safeParse({ ...run, memory: { mb: 100 } }).success).toBe(false);
  });

  it("takes memory as null or as the strict object of Ollama, and refuses the rest", async () => {
    const run = await sampleRun();
    const withMemory = (memory: unknown): boolean =>
      benchRunSchema.safeParse({ ...run, memory }).success;
    expect(withMemory(null)).toBe(true);
    expect(withMemory({ source: "ollama", bytes: 5_137_025_024, vramBytes: 0 })).toBe(true);
    expect(withMemory({ source: "ollama", bytes: 0, vramBytes: 0 })).toBe(true);
    expect(withMemory({ source: "ollama", bytes: Number.MAX_SAFE_INTEGER, vramBytes: 1 })).toBe(
      true,
    );
    expect(withMemory({ source: "ollama", bytes: -1, vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: 10, vramBytes: -1 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: 1.5, vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: 10, vramBytes: 0.1 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: "10", vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: Number.NaN, vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: Number.POSITIVE_INFINITY, vramBytes: 0 })).toBe(
      false,
    );
    expect(withMemory({ source: "ollama", bytes: 2 ** 60, vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: 10 })).toBe(false);
    expect(withMemory({ bytes: 10, vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "lmstudio", bytes: 10, vramBytes: 0 })).toBe(false);
    expect(withMemory({ source: "ollama", bytes: 10, vramBytes: 0, mb: 1 })).toBe(false);
    expect(withMemory(undefined)).toBe(false);
    expect(withMemory(12)).toBe(false);
  });

  it("keeps the version and reads a file written before the memory was measured", async () => {
    const run = await sampleRun();
    const old = JSON.parse(JSON.stringify({ ...run, memory: null })) as unknown;
    expect(benchRunSchema.parse(old).memory).toBeNull();
    expect(BENCH_RUN_VERSION).toBe(1);
    const withMemory = { ...run, memory: { source: "ollama", bytes: 7, vramBytes: 3 } };
    expect(benchRunSchema.parse(JSON.parse(JSON.stringify(withMemory)))).toEqual(withMemory);
  });

  it("names the file from the date alone, in UTC", () => {
    expect(benchResultPath("2026-10-20T14:25:30.123Z")).toBe(
      "bench-results/2026-10-20-142530.json",
    );
    expect(benchResultPath("2026-01-02T03:04:05Z")).toBe("bench-results/2026-01-02-030405.json");
    // A date with an offset is read as the same instant: 23:59:59 at -03:00 is the next day in UTC.
    expect(benchResultPath("2026-10-20T23:59:59-03:00")).toBe(
      "bench-results/2026-10-21-025959.json",
    );
    expect(() => benchResultPath("not a date")).toThrow(/not a date/);
  });

  it("names the file of a run from its start", async () => {
    const run = await sampleRun();
    const stamp = new Date(run.startedAt).toISOString();
    expect(benchResultPath(run.startedAt)).toBe(
      `bench-results/${stamp.slice(0, 10)}-${stamp.slice(11, 19).replaceAll(":", "")}.json`,
    );
  });
});

describe("progress", () => {
  it("tells each task before and after, and a watcher that throws does not stop the run", async () => {
    const backend = fakeWithReplies((request) => rightAnswer(taskOf(request)));
    const events: BenchProgress[] = [];
    const tasks = SUITE.slice(0, 2);
    const run = await runBench({
      ai: backend.ai,
      provider: OLLAMA,
      model: "m",
      tasks,
      now: steppingClock(),
      onProgress: (p) => {
        events.push(p);
        throw new Error("a watcher that fails");
      },
    });
    expect(run.tasks).toHaveLength(2);
    expect(events.map((e) => `${e.type}:${e.index}/${e.total}`)).toEqual([
      "start:0/2",
      "done:0/2",
      "start:1/2",
      "done:1/2",
    ]);
    const done = events[1];
    expect(done?.type === "done" && done.result.id).toBe(tasks[0]?.id);
  });
});

describe("benchMedian", () => {
  it("is the middle value, the mean of the two middle ones, or null", () => {
    expect(benchMedian([])).toBeNull();
    expect(benchMedian([7])).toBe(7);
    expect(benchMedian([9, 1, 5])).toBe(5);
    expect(benchMedian([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("the totals", () => {
  const outcome = fc.constantFrom("pass", "wrong", "error");
  const taskRun = fc.record({
    kind: fc.constantFrom("command", "explain", "summarize"),
    outcome,
    first: fc.option(fc.integer({ min: 0, max: 60_000 }), { nil: null }),
    total: fc.integer({ min: 0, max: 120_000 }),
    tokens: fc.integer({ min: 0, max: 5_000 }),
  });

  const build = (
    rows: readonly {
      kind: BenchTaskRun["kind"];
      outcome: string;
      first: number | null;
      total: number;
      tokens: number;
    }[],
  ): BenchTaskRun[] =>
    rows.map((row, i) => ({
      id: `t-${i}`,
      kind: row.kind,
      ok: row.outcome === "pass",
      reason: row.outcome === "pass" ? null : "x",
      firstChunkMs: row.outcome === "error" ? null : row.first,
      totalMs: row.total,
      outputTokens: row.tokens,
      tokensSource: "estimate",
      tokensPerSecond:
        row.outcome === "error" || row.total === 0 || row.tokens === 0
          ? null
          : Math.round((row.tokens / (row.total / 1000)) * 100) / 100,
      error: row.outcome === "error" ? { kind: "network", message: "down" } : null,
    }));

  it("add up: the total, the passed and the errors are the sum over the kinds", () => {
    fc.assert(
      fc.property(fc.array(taskRun, { maxLength: 40 }), (rows) => {
        const tasks = build(rows);
        const { overall, byKind } = summarizeBenchTasks(tasks);
        const kinds = [byKind.command, byKind.explain, byKind.summarize];
        const sum = (pick: (t: (typeof kinds)[number]) => number): number =>
          kinds.reduce((acc, t) => acc + pick(t), 0);
        expect(overall.total).toBe(tasks.length);
        expect(overall.total).toBe(sum((t) => t.total));
        expect(overall.passed).toBe(sum((t) => t.passed));
        expect(overall.errors).toBe(sum((t) => t.errors));
        expect(overall.passed).toBe(tasks.filter((t) => t.ok).length);
        expect(overall.accuracy).toBeGreaterThanOrEqual(0);
        expect(overall.accuracy).toBeLessThanOrEqual(1);
        // Whatever the tasks are, a complete run built from them is a result the schema accepts.
        const run = {
          version: BENCH_RUN_VERSION,
          startedAt: "2026-10-20T12:00:00.000Z",
          provider: {
            id: "ollama",
            kind: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
          },
          model: "m",
          state: "complete",
          planned: tasks.length,
          tasks,
          totals: { overall, byKind },
          memory: null,
        };
        expect(benchRunSchema.safeParse(run).success).toBe(true);
        expect(benchRunSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run);
      }),
    );
  });
});

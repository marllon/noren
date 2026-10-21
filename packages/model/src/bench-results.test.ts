/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AiProviderInfo } from "./ai";
import {
  MAX_BENCH_RESULT_BYTES,
  MAX_BENCH_RESULTS,
  MAX_BENCH_SUFFIX,
  benchFileName,
  benchStampOfStartedAt,
  benchStartedAtOf,
  compareBenchFileNamesNewestFirst,
  freeBenchFileName,
  isBenchResultText,
  isBenchStamp,
  loadBenchRuns,
  parseBenchFileName,
  parseBenchResult,
  saveBenchRun,
  serializeBenchRun,
} from "./bench-results";
import { benchResultPath, benchRunSchema, runBench, type BenchRun } from "./bench-runner";
import { checkBenchSuite, type BenchTask } from "./bench-suite";
import { FakeBackend } from "./fake-backend";

// The files of the bench results (NOR-F16-02b): the rules for their names, the FakeBackend that
// follows the same rules as `crates/noren-core/src/bench.rs`, and the page's check of a run with
// `benchRunSchema` before it is written and after it is read. No network and no real file.

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

const OLLAMA: AiProviderInfo = {
  id: "ollama",
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "",
  hasKey: false,
};

/** A real run of the first tasks of the suite, made by `runBench` against the fake provider. */
async function aRun(startMs = Date.UTC(2026, 9, 20, 14, 5, 9, 123)): Promise<BenchRun> {
  const backend = new FakeBackend({
    ollamaModels: ["llama3.2"],
    aiReply: () => "chmod +x deploy.sh",
  });
  let t = startMs;
  return runBench({
    ai: backend.ai,
    provider: OLLAMA,
    model: "llama3.2",
    tasks: SUITE.slice(0, 6),
    now: () => {
      const at = t;
      t += 10;
      return at;
    },
  });
}

/** The run with another start time (the schema does not tie it to anything else). */
const startedAt = (run: BenchRun, iso: string): BenchRun => ({ ...run, startedAt: iso });

describe("the names of the result files", () => {
  it("accepts a stamp YYYY-MM-DD-HHmmss with a real month, day and time", () => {
    for (const stamp of ["2026-10-20-140509", "0001-01-01-000000", "9999-12-31-235959"]) {
      expect(isBenchStamp(stamp), stamp).toBe(true);
    }
  });

  it("refuses a stamp that is a path, has another shape or an impossible time", () => {
    for (const stamp of [
      "",
      "..",
      "../escape",
      "..\\escape",
      "../../2026-10-20-14050",
      "2026-10-20-140509/../x",
      "/2026-10-20-140509",
      "C:/2026-10-20-140509",
      "2026-10-20-140509.json",
      "2026-10-20-140509-2",
      "2026-10-20-14050",
      "2026-10-20T140509",
      "2026-10-20-1405090",
      "2026-13-20-140509",
      "2026-00-20-140509",
      "2026-10-00-140509",
      "2026-10-32-140509",
      "2026-10-20-240000",
      "2026-10-20-146000",
      "2026-10-20-140560",
      "2026-10-20-140509\n",
      "2026-10-20-14050\u00e9",
      "con",
    ]) {
      expect(isBenchStamp(stamp), JSON.stringify(stamp)).toBe(false);
    }
  });

  it("takes the stamp from a start time written the way toISOString writes it, in UTC only", () => {
    expect(benchStampOfStartedAt("2026-10-20T14:05:09.123Z")).toBe("2026-10-20-140509");
    expect(benchStampOfStartedAt("2026-10-20T14:05:09Z")).toBe("2026-10-20-140509");
    expect(benchStampOfStartedAt("2026-10-20T14:05:09.123456Z")).toBe("2026-10-20-140509");
    for (const bad of [
      "",
      "yesterday",
      "2026-10-20",
      "2026-10-20T14:05:09",
      "2026-10-20T14:05:09+02:00",
      "2026-10-20T14:05:09.Z",
      "2026-10-20 14:05:09Z",
      "2026-13-20T14:05:09Z",
      "2026-10-20T24:05:09Z",
      "2026-10-20T14:05:60Z",
      "../../2026-10-20T14:05:09Z",
      "2026-10-20T14:05:09Z/../x",
      "2026-10-20T14:05:09Z\n",
      "\u0662026-10-20T14:05:09Z",
    ]) {
      expect(benchStampOfStartedAt(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("agrees with benchResultPath on every instant the schema accepts (a property)", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("0001-01-01T00:00:00.000Z"),
          max: new Date("9999-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        (date) => {
          const iso = date.toISOString();
          const stamp = benchStampOfStartedAt(iso);
          expect(stamp).toBeDefined();
          expect(benchResultPath(iso)).toBe(`bench-results/${benchFileName(stamp ?? "")}`);
          expect(parseBenchFileName(benchFileName(stamp ?? ""))).toEqual({ stamp, n: 1 });
        },
      ),
    );
  });

  it("writes <stamp>.json, then <stamp>-2.json, and reads those names back", () => {
    expect(benchFileName("2026-10-20-140509")).toBe("2026-10-20-140509.json");
    expect(benchFileName("2026-10-20-140509", 1)).toBe("2026-10-20-140509.json");
    expect(benchFileName("2026-10-20-140509", 2)).toBe("2026-10-20-140509-2.json");
    for (const n of [1, 2, 10, 999]) {
      const name = benchFileName("2026-10-20-140509", n);
      expect(parseBenchFileName(name), name).toEqual({ stamp: "2026-10-20-140509", n });
    }
  });

  it("does not read a name the app would never write", () => {
    for (const name of [
      "notes.json",
      "2026-10-20-140509.txt",
      "2026-10-20-140509.JSON",
      "2026-10-20-140509.json.tmp",
      "2026-10-20-140509-0.json",
      "2026-10-20-140509-1.json",
      "2026-10-20-140509-02.json",
      "2026-10-20-140509-x.json",
      "2026-10-20-140509-1000.json",
      "2026-13-20-140509.json",
      "../2026-10-20-140509.json",
      "bench-results/2026-10-20-140509.json",
      "",
    ]) {
      expect(parseBenchFileName(name), name).toBeUndefined();
    }
  });

  it("gives the first free name and never one that is taken", () => {
    const stamp = "2026-10-20-140509";
    expect(freeBenchFileName(stamp, new Set())).toBe("2026-10-20-140509.json");
    expect(freeBenchFileName(stamp, new Set(["2026-10-20-140509.json"]))).toBe(
      "2026-10-20-140509-2.json",
    );
    // A gap is filled, as the Rust side does.
    expect(freeBenchFileName(stamp, new Set(["2026-10-20-140509-2.json"]))).toBe(
      "2026-10-20-140509.json",
    );
    const all = new Set(
      Array.from({ length: MAX_BENCH_SUFFIX }, (_, i) => benchFileName(stamp, i + 1)),
    );
    expect(freeBenchFileName(stamp, all)).toBeUndefined();
  });

  it("orders names newest first, a suffix before the file it follows", () => {
    const names = [
      "2025-12-31-235959.json",
      "2026-10-20-140509.json",
      "2026-10-21-000000.json",
      "2026-10-20-140509-3.json",
      "2026-10-20-140509-2.json",
    ];
    expect([...names].sort(compareBenchFileNamesNewestFirst)).toEqual([
      "2026-10-21-000000.json",
      "2026-10-20-140509-3.json",
      "2026-10-20-140509-2.json",
      "2026-10-20-140509.json",
      "2025-12-31-235959.json",
    ]);
  });

  it("orders any set of names the same way whatever their starting order (a property)", () => {
    const name = fc
      .tuple(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2100-01-01T00:00:00Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 1, max: 5 }),
      )
      .map(([date, n]) => benchFileName(benchStampOfStartedAt(date.toISOString()) ?? "", n));
    fc.assert(
      fc.property(fc.uniqueArray(name, { maxLength: 12 }), (names) => {
        const sorted = [...names].sort(compareBenchFileNamesNewestFirst);
        expect([...names].reverse().sort(compareBenchFileNamesNewestFirst)).toEqual(sorted);
        const keys = sorted.map((n) => {
          const parsed = parseBenchFileName(n);
          return `${parsed?.stamp}/${String(parsed?.n).padStart(4, "0")}`;
        });
        expect(keys).toEqual([...keys].sort().reverse());
      }),
    );
  });

  it("reads the start time of a run, and nothing from text that is not one", () => {
    expect(benchStartedAtOf('{"startedAt":"2026-10-20T14:05:09Z"}')).toBe("2026-10-20T14:05:09Z");
    for (const text of [
      "",
      "nope",
      "[]",
      "null",
      "5",
      "{}",
      '{"startedAt":5}',
      '{"startedAt":null}',
    ]) {
      expect(benchStartedAtOf(text), text).toBe("");
    }
  });

  it("takes a text as a result file only when it is shaped like a JSON object", () => {
    for (const text of ["{}", ' {"a":1}\n', "\ufeff{}"]) expect(isBenchResultText(text)).toBe(true);
    for (const text of ["", "[]", "nope", "{", "}", "null"])
      expect(isBenchResultText(text)).toBe(false);
  });
});

describe("FakeBackend: saving and listing bench results", () => {
  it("names the file from the start time of the run and lists it back as written", async () => {
    const backend = new FakeBackend();
    expect(await backend.listBenchResults()).toEqual([]);
    const run = await aRun();
    const text = serializeBenchRun(run);
    const name = await backend.saveBenchResult(text);
    expect(name).toBe("2026-10-20-140509.json");
    expect(`bench-results/${name}`).toBe(benchResultPath(run.startedAt));
    expect(await backend.listBenchResults()).toEqual([{ name, text }]);
    expect(backend.benchResultFiles).toEqual({ [name]: text });
    expect(backend.callsTo("saveBenchResult")).toHaveLength(1);
    expect(backend.callsTo("listBenchResults")).toHaveLength(2);
  });

  it("gives a second run in the same second a suffix and never replaces a file", async () => {
    const backend = new FakeBackend();
    const run = await aRun();
    const names = [];
    for (const marker of ["first", "second", "third"]) {
      names.push(await backend.saveBenchResult(JSON.stringify({ ...run, model: marker })));
    }
    expect(names).toEqual([
      "2026-10-20-140509.json",
      "2026-10-20-140509-2.json",
      "2026-10-20-140509-3.json",
    ]);
    const files = await backend.listBenchResults();
    expect(files.map((f) => (JSON.parse(f.text) as BenchRun).model)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("lists the newest first, whatever the order they were saved in", async () => {
    const backend = new FakeBackend();
    const run = await aRun();
    for (const iso of [
      "2026-10-20T14:05:09.000Z",
      "2025-12-31T23:59:59.000Z",
      "2026-10-20T14:05:09.500Z",
      "2026-10-21T00:00:00.000Z",
    ]) {
      await backend.saveBenchResult(serializeBenchRun(startedAt(run, iso)));
    }
    expect((await backend.listBenchResults()).map((f) => f.name)).toEqual([
      "2026-10-21-000000.json",
      "2026-10-20-140509-2.json",
      "2026-10-20-140509.json",
      "2025-12-31-235959.json",
    ]);
  });

  it("refuses text that is no run of a known time, and writes nothing", async () => {
    const backend = new FakeBackend();
    for (const text of [
      "",
      "not json",
      "[]",
      "{}",
      '{"startedAt": 5}',
      '{"startedAt":"yesterday"}',
      '{"startedAt":"2026-10-20T14:05:09+02:00"}',
      '{"startedAt":"../../outside/escape"}',
      '{"startedAt":"2026-10-20T14:05:09Z/../x"}',
    ]) {
      await expect(backend.saveBenchResult(text), text).rejects.toThrow(/not a run/);
    }
    expect(backend.benchResultFiles).toEqual({});
  });

  it("refuses a text over the ceiling and writes one at the ceiling", async () => {
    const backend = new FakeBackend();
    const head = '{"startedAt":"2026-10-20T14:05:09Z","pad":"';
    const tail = '"}';
    const fill = (total: number): string =>
      head + "a".repeat(total - head.length - tail.length) + tail;
    await expect(backend.saveBenchResult(fill(MAX_BENCH_RESULT_BYTES + 1))).rejects.toThrow(
      /larger than/,
    );
    expect(backend.benchResultFiles).toEqual({});
    await backend.saveBenchResult(fill(MAX_BENCH_RESULT_BYTES));
    expect(await backend.listBenchResults()).toHaveLength(1);
  });

  it("counts the ceiling in bytes, not in characters", async () => {
    const backend = new FakeBackend();
    const head = '{"startedAt":"2026-10-20T14:05:09Z","pad":"';
    const tail = '"}';
    // Two bytes a character: half as many characters fill the ceiling.
    const pad = "\u00e9".repeat(
      Math.floor((MAX_BENCH_RESULT_BYTES - head.length - tail.length) / 2) + 1,
    );
    await expect(backend.saveBenchResult(head + pad + tail)).rejects.toThrow(/larger than/);
  });

  it("lists only what the real folder would list", async () => {
    const good = '{"startedAt":"2026-10-20T14:05:09Z"}';
    const big = `{${" ".repeat(MAX_BENCH_RESULT_BYTES)}}`;
    const backend = new FakeBackend({
      benchResults: {
        "2026-10-20-140509.json": good,
        "notes.json": good,
        "2026-10-20-140509.txt": good,
        "2026-10-20-140509-1.json": good,
        "2026-10-20-140509-02.json": good,
        "../2026-10-20-140509.json": good,
        "2026-10-20-140511.json": "[1]",
        "2026-10-20-140512.json": "",
        "2026-10-20-140513.json": big,
      },
    });
    expect(await backend.listBenchResults()).toEqual([
      { name: "2026-10-20-140509.json", text: good },
    ]);
    backend.setBenchResult("2026-10-20-140509.json", null);
    expect(await backend.listBenchResults()).toEqual([]);
  });

  it("lists at most the newest MAX_BENCH_RESULTS, and what is skipped does not use them up", async () => {
    const backend = new FakeBackend();
    for (let i = 0; i < MAX_BENCH_RESULTS + 20; i += 1) {
      const minute = String(i % 60).padStart(2, "0");
      const hour = String(10 + Math.floor(i / 60)).padStart(2, "0");
      backend.setBenchResult(`2026-10-20-${hour}${minute}00.json`, "{}");
    }
    backend.setBenchResult("2026-10-20-235959.json", "nope");
    const files = await backend.listBenchResults();
    expect(files).toHaveLength(MAX_BENCH_RESULTS);
    expect(files[0]?.name).toBe("2026-10-20-115900.json");
    expect(files.at(-1)?.name).toBe("2026-10-20-102000.json");
  });

  it("fails like a disk that refuses, on request", async () => {
    const backend = new FakeBackend();
    const run = await aRun();
    backend.setBenchSaveFailure(new Error("disk full"));
    await expect(backend.saveBenchResult(serializeBenchRun(run))).rejects.toThrow("disk full");
    expect(backend.benchResultFiles).toEqual({});
    backend.setBenchSaveFailure(undefined);
    await backend.saveBenchResult(serializeBenchRun(run));
    backend.setBenchListFailure(new Error("access denied"));
    await expect(backend.listBenchResults()).rejects.toThrow("access denied");
    backend.setBenchListFailure(undefined);
    expect(await backend.listBenchResults()).toHaveLength(1);
  });
});

describe("the page: a run is checked before it is written and after it is read", () => {
  it("writes a run of runBench and reads it back equal, through the schema", async () => {
    const backend = new FakeBackend();
    const run = await aRun();
    const name = await saveBenchRun(backend, run);
    expect(name).toBe("2026-10-20-140509.json");
    expect(backend.benchResultFiles[name]).toBe(serializeBenchRun(run));
    expect(backend.benchResultFiles[name]?.endsWith("}\n")).toBe(true);
    expect(await loadBenchRuns(backend)).toEqual([{ name, run }]);
    expect(benchRunSchema.parse(JSON.parse(backend.benchResultFiles[name] ?? ""))).toEqual(run);
  });

  it("refuses to write what is not a valid run, and the backend is never called", async () => {
    const backend = new FakeBackend();
    const run = await aRun();
    const bad: unknown[] = [
      null,
      "{}",
      {},
      { ...run, version: 2 },
      { ...run, startedAt: "yesterday" },
      { ...run, memory: { mb: 5 } },
      { ...run, extra: true },
      { ...run, totals: { ...run.totals, overall: { ...run.totals.overall, passed: 99 } } },
      { ...run, tasks: [...run.tasks, ...run.tasks] },
    ];
    for (const value of bad) {
      await expect(
        saveBenchRun(backend, value),
        JSON.stringify(value)?.slice(0, 40),
      ).rejects.toThrow();
    }
    expect(backend.callsTo("saveBenchResult")).toHaveLength(0);
    expect(backend.benchResultFiles).toEqual({});
  });

  it("lets a refusal of the backend reach the caller", async () => {
    const backend = new FakeBackend();
    backend.setBenchSaveFailure(new Error("disk full"));
    await expect(saveBenchRun(backend, await aRun())).rejects.toThrow("disk full");
  });

  it("leaves out a file that is not a valid run and keeps the rest, in order", async () => {
    const run = await aRun();
    const older = startedAt(run, "2026-10-19T10:00:00.000Z");
    const newer = startedAt(run, "2026-10-21T10:00:00.000Z");
    const backend = new FakeBackend({
      benchResults: {
        "2026-10-19-100000.json": serializeBenchRun(older),
        "2026-10-20-100000.json": '{"startedAt":"2026-10-20T10:00:00Z"}',
        "2026-10-20-110000.json": "{ not json }",
        "2026-10-20-120000.json": JSON.stringify({ ...run, totals: { overall: 1 } }),
        "2026-10-20-130000.json": JSON.stringify({ ...run, memory: 12 }),
        "2026-10-21-100000.json": serializeBenchRun(newer),
        "2026-10-21-110000.json": `\ufeff${serializeBenchRun(older)}`,
      },
    });
    const runs = await loadBenchRuns(backend);
    expect(runs.map((r) => r.name)).toEqual([
      "2026-10-21-110000.json",
      "2026-10-21-100000.json",
      "2026-10-19-100000.json",
    ]);
    expect(runs.map((r) => r.run.startedAt)).toEqual([
      older.startedAt,
      newer.startedAt,
      older.startedAt,
    ]);
  });

  it("an empty folder is no runs, and a folder that cannot be read rejects", async () => {
    const backend = new FakeBackend();
    expect(await loadBenchRuns(backend)).toEqual([]);
    backend.setBenchListFailure(new Error("access denied"));
    await expect(loadBenchRuns(backend)).rejects.toThrow("access denied");
  });

  it("parses the text of a result, with or without a byte order mark, and nothing else", async () => {
    const run = await aRun();
    expect(parseBenchResult(serializeBenchRun(run))).toEqual(run);
    expect(parseBenchResult(`\ufeff${JSON.stringify(run)}`)).toEqual(run);
    for (const text of ["", "nope", "[]", "{}", JSON.stringify({ ...run, state: "paused" })]) {
      expect(parseBenchResult(text), text).toBeUndefined();
    }
  });
});

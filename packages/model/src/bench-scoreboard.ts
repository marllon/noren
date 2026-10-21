import { MAX_AI_MODEL, OLLAMA_PROVIDER_ID, AI_FUNCTIONS } from "./ai";
import type { BenchMemory, BenchRun, BenchTotals } from "./bench-runner";
import { compareBenchFileNamesNewestFirst, type SavedBenchRun } from "./bench-results";
import type { BenchKind } from "./bench-suite";
import type { ConfigEdit } from "./config-edit";

// The scoreboard of the model bench (NOR-F16-03a): the saved runs turned into one row per model,
// the model recommended as the default, the edits of the settings file that make a model the
// default of every AI function, and the table as CSV. Pure: no DOM, no Tauri, no file and no
// network. The screen that shows this comes in NOR-F16-03b; nothing here changes a setting by
// itself, `benchDefaultEdits` only says what the edit would be.

const BENCH_KINDS = ["command", "explain", "summarize"] as const satisfies readonly BenchKind[];

/** Where the tokens per second of a row come from: all `stream`, all `estimate`, a mix of both, or no reading. */
export type BenchTokensSource = "stream" | "estimate" | "mixed" | null;

/** What a row says about one kind of task. */
export interface BenchKindScore {
  /** Tasks of the kind that ran. */
  total: number;
  passed: number;
  /** `passed` over `total`; 0 when none ran. */
  accuracy: number;
}

/** A model on the scoreboard: the newest run of one provider and model, and how many runs there were. */
export interface BenchScoreRow {
  /** Position on the board, from 1. */
  rank: number;
  provider: BenchRun["provider"];
  model: string;
  /** How many saved runs this provider and model has (the newest one is the one shown). */
  runs: number;
  /** The result file of the newest run. */
  fileName: string;
  startedAt: string;
  /** `complete`, or `cancelled` (listed, never recommended). */
  state: BenchRun["state"];
  planned: number;
  /** Tasks the newest run did. */
  done: number;
  errors: number;
  accuracy: number;
  byKind: Record<BenchKind, BenchKindScore>;
  medianFirstChunkMs: number | null;
  medianTotalMs: number | null;
  medianTokensPerSecond: number | null;
  tokensSource: BenchTokensSource;
  memory: BenchMemory | null;
  /** The newest run is complete and got at least one task right: the row may be recommended. */
  recommendable: boolean;
}

function kindScore(totals: BenchTotals): BenchKindScore {
  return { total: totals.total, passed: totals.passed, accuracy: totals.accuracy };
}

/** Where the tokens per second of a run come from: the tasks that count in their median. */
function tokensSourceOf(run: BenchRun): BenchTokensSource {
  let stream = false;
  let estimate = false;
  for (const task of run.tasks) {
    if (task.error !== null || task.tokensPerSecond === null) continue;
    if (task.tokensSource === "stream") stream = true;
    else estimate = true;
  }
  if (stream && estimate) return "mixed";
  if (stream) return "stream";
  return estimate ? "estimate" : null;
}

/** The time a run started, in milliseconds (`startedAt` is ISO 8601 in UTC, which may or may not have a fraction). */
function startedMs(run: BenchRun): number {
  return Date.parse(run.startedAt);
}

/** Whether `a` is newer than `b`: by start time, then by file (`-2` is after the file with no suffix). */
function isNewer(a: SavedBenchRun, b: SavedBenchRun): boolean {
  const left = startedMs(a.run);
  const right = startedMs(b.run);
  if (left !== right) return left > right;
  return compareBenchFileNamesNewestFirst(a.name, b.name) < 0;
}

/** Compares numbers with `null` last. */
function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The order of the board: more accurate first, then the faster median total time, then the provider id and the model. */
function compareRows(a: Omit<BenchScoreRow, "rank">, b: Omit<BenchScoreRow, "rank">): number {
  return (
    b.accuracy - a.accuracy ||
    compareNullable(a.medianTotalMs, b.medianTotalMs) ||
    compareText(a.provider.id, b.provider.id) ||
    compareText(a.model, b.model)
  );
}

/**
 * The scoreboard of the saved runs: one row for each pair of provider id and model, made from its
 * newest run (`startedAt`; the same moment goes to the newer file), with the number of runs that
 * pair has. Ordered by accuracy (highest first), then the median total time (lowest first, a row
 * with none last), then the provider id and the model; `rank` numbers the rows from 1. A run that was
 * cancelled is listed like the others and is never `recommendable`.
 */
export function benchScoreboard(saved: readonly SavedBenchRun[]): BenchScoreRow[] {
  const newest = new Map<string, { saved: SavedBenchRun; runs: number }>();
  for (const entry of saved) {
    // JSON of a pair that cannot clash: the id and the model are free text.
    const key = JSON.stringify([entry.run.provider.id, entry.run.model]);
    const seen = newest.get(key);
    if (!seen) newest.set(key, { saved: entry, runs: 1 });
    else {
      seen.runs += 1;
      if (isNewer(entry, seen.saved)) seen.saved = entry;
    }
  }
  const rows = [...newest.values()].map(({ saved: entry, runs }) => {
    const { run } = entry;
    const { overall, byKind } = run.totals;
    return {
      provider: run.provider,
      model: run.model,
      runs,
      fileName: entry.name,
      startedAt: run.startedAt,
      state: run.state,
      planned: run.planned,
      done: overall.total,
      errors: overall.errors,
      accuracy: overall.accuracy,
      byKind: {
        command: kindScore(byKind.command),
        explain: kindScore(byKind.explain),
        summarize: kindScore(byKind.summarize),
      },
      medianFirstChunkMs: overall.medianFirstChunkMs,
      medianTotalMs: overall.medianTotalMs,
      medianTokensPerSecond: overall.medianTokensPerSecond,
      tokensSource: tokensSourceOf(run),
      memory: run.memory,
      recommendable: run.state === "complete" && overall.accuracy > 0,
    } satisfies Omit<BenchScoreRow, "rank">;
  });
  rows.sort(compareRows);
  return rows.map((row, index) => ({ rank: index + 1, ...row }));
}

/**
 * The model to suggest as the default: among the rows whose newest run is complete and got
 * something right, the most accurate; a tie goes to the lower median total time, then to the
 * smaller memory (a row with no reading of either comes after one that has it), then to the
 * provider id and the model. `undefined` when no row can be recommended (no runs, only cancelled
 * ones, or none with an answer right).
 */
export function recommendBenchModel(rows: readonly BenchScoreRow[]): BenchScoreRow | undefined {
  let best: BenchScoreRow | undefined;
  for (const row of rows) {
    if (!row.recommendable) continue;
    if (!best || compareRecommended(row, best) < 0) best = row;
  }
  return best;
}

function compareRecommended(a: BenchScoreRow, b: BenchScoreRow): number {
  return (
    b.accuracy - a.accuracy ||
    compareNullable(a.medianTotalMs, b.medianTotalMs) ||
    compareNullable(a.memory?.bytes ?? null, b.memory?.bytes ?? null) ||
    compareText(a.provider.id, b.provider.id) ||
    compareText(a.model, b.model)
  );
}

// ---- Apply ----

/** The provider and model to make the default. */
export interface BenchTarget {
  provider: string;
  model: string;
}

export type BenchApplyResult =
  { ok: true; edits: ConfigEdit[] } | { ok: false; reason: "unknown-provider" | "bad-model" };

/**
 * The ids of the providers the settings know: `ollama` and the ones listed in `ai.providers`
 * (`undefined` when the file lists none).
 */
export function knownAiProviderIds(
  providers: readonly { readonly id: string }[] | undefined,
): string[] {
  return [OLLAMA_PROVIDER_ID, ...(providers ?? []).map((provider) => provider.id)];
}

/**
 * The edits of the settings file that make `target` the default of every AI function
 * (`ai.defaults.ask`, `.explain` and `.command`, the provider and the model of each), for
 * `editConfigText`. Refused, with no edits, when the provider is not one of `knownProviderIds`
 * (the settings would not be valid) or when the model is blank or longer than the settings allow.
 * It does not turn the AI on (`ai.enabled`): that stays the person's choice.
 */
export function benchDefaultEdits(
  target: BenchTarget,
  knownProviderIds: readonly string[],
): BenchApplyResult {
  if (!knownProviderIds.includes(target.provider)) return { ok: false, reason: "unknown-provider" };
  if (!/\S/.test(target.model) || target.model.length > MAX_AI_MODEL) {
    return { ok: false, reason: "bad-model" };
  }
  const edits: ConfigEdit[] = AI_FUNCTIONS.flatMap((fn) => [
    { path: ["ai", "defaults", fn, "provider"], value: target.provider },
    { path: ["ai", "defaults", fn, "model"], value: target.model },
  ]);
  return { ok: true, edits };
}

// ---- CSV ----

/** The columns of the CSV, in order. Fixed: a script that reads the file can count on them. */
export const BENCH_CSV_HEADER = [
  "rank",
  "provider_id",
  "model",
  "runs",
  "file",
  "started_at",
  "state",
  "planned",
  "done",
  "errors",
  "accuracy",
  "accuracy_command",
  "accuracy_explain",
  "accuracy_summarize",
  "median_first_chunk_ms",
  "median_total_ms",
  "median_tokens_per_second",
  "tokens_source",
  "memory_bytes",
  "memory_vram_bytes",
  "recommended",
] as const;

/** A cell that a spreadsheet reads as a formula when it starts with one of these. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * A text as a cell of the CSV (RFC 4180). A text that starts with `=`, `+`, `-`, `@`, a tab or a
 * carriage return gets an apostrophe in front so that a spreadsheet shows it as text instead of
 * running it (a model name comes from the provider); a cell with a comma, a quote or a line break
 * is put in quotes, with each quote doubled.
 */
export function benchCsvText(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** A number as a cell: plain digits with a point, whatever the language of the computer; empty for none. */
function csvNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

/**
 * The scoreboard as CSV: the fixed header and a record for each row, comma between cells and `\n`
 * at the end of every line (the last one too). Numbers are written with `String`, never with a
 * locale; an empty cell is a number there is no reading for. The `recommended` column is `true`
 * for the row `recommendBenchModel` picks.
 */
export function benchScoreboardCsv(rows: readonly BenchScoreRow[]): string {
  const picked = recommendBenchModel(rows);
  const lines = [BENCH_CSV_HEADER.join(",")];
  for (const row of rows) {
    const cells = [
      csvNumber(row.rank),
      benchCsvText(row.provider.id),
      benchCsvText(row.model),
      csvNumber(row.runs),
      benchCsvText(row.fileName),
      benchCsvText(row.startedAt),
      row.state,
      csvNumber(row.planned),
      csvNumber(row.done),
      csvNumber(row.errors),
      csvNumber(row.accuracy),
      ...BENCH_KINDS.map((kind) => csvNumber(row.byKind[kind].accuracy)),
      csvNumber(row.medianFirstChunkMs),
      csvNumber(row.medianTotalMs),
      csvNumber(row.medianTokensPerSecond),
      row.tokensSource ?? "",
      csvNumber(row.memory?.bytes ?? null),
      csvNumber(row.memory?.vramBytes ?? null),
      row === picked ? "true" : "false",
    ];
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

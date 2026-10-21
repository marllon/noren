/**
 * The bench results on disk, as far as the interface is concerned: the rules for the name of a
 * result file (the same ones `crates/noren-core/src/bench.rs` applies, which the `FakeBackend`
 * follows) and the two things the page does around `Backend.saveBenchResult` and
 * `Backend.listBenchResults`: it checks a run with `benchRunSchema` before it is written, and
 * checks every file again when it is read, leaving out the ones that are not a run.
 *
 * Pure TypeScript: no file, no DOM, no Tauri.
 */

import type { Backend, BenchResultFile } from "./backend";
import { type BenchRun, benchRunSchema } from "./bench-runner";

/** The largest result file written or listed, in bytes. A run of the 60 tasks is about 30 KiB. */
export const MAX_BENCH_RESULT_BYTES = 1024 * 1024;

/** The most results `listBenchResults` returns (the newest). */
export const MAX_BENCH_RESULTS = 100;

/** The highest number a file of the same second gets (`<stamp>-999.json`). */
export const MAX_BENCH_SUFFIX = 999;

const STAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const STARTED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const FILE_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}-\d{6})(?:-(\d{1,3}))?\.json$/;

/**
 * Whether `stamp` is `YYYY-MM-DD-HHmmss`: digits and hyphens in exactly those places, with a month
 * from 1 to 12, a day from 1 to 31, an hour up to 23, and minutes and seconds up to 59.
 */
export function isBenchStamp(stamp: string): boolean {
  const match = STAMP_PATTERN.exec(stamp);
  if (!match) return false;
  const [month, day, hour, minute, second] = match.slice(2).map(Number);
  return (
    month !== undefined &&
    day !== undefined &&
    hour !== undefined &&
    minute !== undefined &&
    second !== undefined &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

/**
 * The stamp of the time a run started, `startedAt` written the way `Date.toISOString` writes it
 * (`YYYY-MM-DDTHH:mm:ss`, an optional fraction of a second, `Z`); `undefined` for any other form,
 * an offset included.
 */
export function benchStampOfStartedAt(startedAt: string): string | undefined {
  const match = STARTED_AT_PATTERN.exec(startedAt);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const stamp = `${year}-${month}-${day}-${hour}${minute}${second}`;
  return isBenchStamp(stamp) ? stamp : undefined;
}

/**
 * The `startedAt` of the run in `text`, or `""` when the text is not the JSON of an object that has
 * one (which `benchStampOfStartedAt` then refuses).
 */
export function benchStartedAtOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
    const startedAt = (value as { startedAt?: unknown }).startedAt;
    return typeof startedAt === "string" ? startedAt : "";
  } catch {
    return "";
  }
}

/**
 * The file name of the result of `stamp` that is number `n` in its second: `<stamp>.json` for the
 * first, `<stamp>-2.json` for the second one.
 */
export function benchFileName(stamp: string, n = 1): string {
  return n <= 1 ? `${stamp}.json` : `${stamp}-${n}.json`;
}

/**
 * Reads a file name written by the app: the stamp and the number in its second (1 for no suffix).
 * A name the app would never write (another extension, a suffix that is 0, 1, has a leading zero
 * or is past `MAX_BENCH_SUFFIX`, a stamp that is not a time) is `undefined`.
 */
export function parseBenchFileName(name: string): { stamp: string; n: number } | undefined {
  const match = FILE_NAME_PATTERN.exec(name);
  const stamp = match?.[1];
  if (!match || stamp === undefined || !isBenchStamp(stamp)) return undefined;
  const suffix = match[2];
  if (suffix === undefined) return { stamp, n: 1 };
  if (suffix.startsWith("0")) return undefined;
  const n = Number(suffix);
  return n >= 2 && n <= MAX_BENCH_SUFFIX ? { stamp, n } : undefined;
}

/**
 * The first free name for a result of `stamp`: `<stamp>.json`, else `-2`, `-3`, ... (a name in
 * `taken` is never reused, so no file is overwritten); `undefined` when `MAX_BENCH_SUFFIX` files
 * already hold that second.
 */
export function freeBenchFileName(stamp: string, taken: ReadonlySet<string>): string | undefined {
  for (let n = 1; n <= MAX_BENCH_SUFFIX; n += 1) {
    const name = benchFileName(stamp, n);
    if (!taken.has(name)) return name;
  }
  return undefined;
}

/**
 * Orders result file names newest first: by stamp, then by the number in the second (so
 * `<stamp>-2.json` comes before `<stamp>.json`, which a plain comparison of the names would get
 * the other way round). A name that is not a result name sorts last.
 */
export function compareBenchFileNamesNewestFirst(a: string, b: string): number {
  const left = parseBenchFileName(a);
  const right = parseBenchFileName(b);
  if (!left || !right) return left ? -1 : right ? 1 : a < b ? -1 : a > b ? 1 : 0;
  if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1;
  return right.n - left.n;
}

/** The text of a file that can be a result: shaped like a JSON object (the page checks the rest). */
export function isBenchResultText(text: string): boolean {
  const body = (text.startsWith("﻿") ? text.slice(1) : text).trim();
  return body.startsWith("{") && body.endsWith("}");
}

/** `run` as the text of a result file: indented JSON with a final newline. */
export function serializeBenchRun(run: BenchRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

/**
 * Checks `run` with `benchRunSchema` and writes it through the backend; resolves with the name of
 * the file written. Rejects, writing nothing, when `run` is not a valid run (the error is the one
 * of the schema) and when the backend refuses.
 */
export async function saveBenchRun(
  backend: Pick<Backend, "saveBenchResult">,
  run: unknown,
): Promise<string> {
  const checked = benchRunSchema.parse(run);
  return backend.saveBenchResult(serializeBenchRun(checked));
}

/** A result read back from disk: the file it came from and the run in it. */
export interface SavedBenchRun {
  name: string;
  run: BenchRun;
}

/** The text of a result file as a run, or `undefined` when it is not JSON or not a valid run. */
export function parseBenchResult(text: string): BenchRun | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  const parsed = benchRunSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The runs saved so far, newest first. A file that is not a valid run is left out and never
 * stops the others; whatever the backend rejects with (the folder could not be read) is passed on.
 */
export async function loadBenchRuns(
  backend: Pick<Backend, "listBenchResults">,
): Promise<SavedBenchRun[]> {
  const files: BenchResultFile[] = await backend.listBenchResults();
  const runs: SavedBenchRun[] = [];
  for (const { name, text } of files) {
    const run = parseBenchResult(text);
    if (run) runs.push({ name, run });
  }
  return runs;
}

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Median of a list of numbers (the mean of the two in the middle when the count is even). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const low = sorted[mid - 1] ?? 0;
  const high = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? high : (low + high) / 2;
}

/** The value under which `fraction` (0 to 1) of the list falls, by the nearest rank. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export interface Summary {
  n: number;
  median: number;
  min: number;
  max: number;
  p95: number;
  /** Every value in the order measured, kept when there are 12 or fewer (one per repetition). */
  values?: number[];
}

/** The median and the spread of a list: what `docs/PERF.md` quotes for each measurement. */
export function summarize(values: readonly number[]): Summary {
  return {
    n: values.length,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    p95: percentile(values, 0.95),
    ...(values.length <= 12 ? { values: [...values] } : {}),
  };
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Prints one measurement as a `PERF e2e <name> {json}` line and, when `NOREN_PERF_OUT` names a file,
 * appends the same JSON there (one line per measurement), for `scripts/perf.mjs` to collect.
 */
export function report(name: string, values: Record<string, unknown>): void {
  const entry = { name, ...values };
  const text = JSON.stringify(entry, (_key, value: unknown) =>
    typeof value === "number" ? round(value) : value,
  );
  console.log(`PERF e2e ${text}`);
  const out = process.env["NOREN_PERF_OUT"];
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    appendFileSync(out, `${text}\n`);
  }
}

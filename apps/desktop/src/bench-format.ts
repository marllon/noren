import type { BenchTokensSource } from "@noren/model";

// How the bench scoreboard writes its numbers: plain digits with a point, whatever the language of
// the computer (the same as the CSV), and a dash for a number there is no reading for.

/** What a cell shows for a number with no reading. */
export const NO_READING = "—";

/** `0.85` as `85%`. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Milliseconds as `850 ms`, or `1.2 s` from a second up. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return NO_READING;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Tokens per second with one decimal. */
export function formatTokensPerSecond(value: number | null): string {
  return value === null ? NO_READING : value.toFixed(1);
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Bytes as `4.7 GiB` (`512 B` below a KiB). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** The key of the words that say where the tokens per second come from. */
export function tokensSourceKey(
  source: Exclude<BenchTokensSource, null>,
): "bench.source.stream" | "bench.source.estimate" | "bench.source.mixed" {
  return `bench.source.${source}`;
}

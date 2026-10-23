import { validEnv } from "@noren/model";

/** Colors the new-space dialog offers; the first is the default. */
export const SPACE_COLORS: readonly { name: string; value: string }[] = [
  { name: "Blue", value: "#6b8afd" },
  { name: "Coral", value: "#e07a5f" },
  { name: "Green", value: "#4caf7d" },
  { name: "Amber", value: "#e5a93d" },
  { name: "Violet", value: "#a77bdc" },
  { name: "Teal", value: "#3fb5b0" },
  { name: "Rose", value: "#e0679a" },
  { name: "Slate", value: "#8a93a6" },
  // The four highlight colors of the glass design, after the older ones so the default stays Blue.
  { name: "Mint", value: "#5ee6c8" },
  { name: "Lilac", value: "#a99bff" },
  { name: "Gold", value: "#f5b84b" },
  { name: "Blush", value: "#ff8fa3" },
  // The four highlight colors of the dense design.
  { name: "Cyan", value: "#2ee6d6" },
  { name: "Lime", value: "#b4ff39" },
  { name: "Apricot", value: "#ffb547" },
  { name: "Fuchsia", value: "#ff5ca8" },
];

/** Lucide icons the new-space dialog offers (their kebab-case names); the first is the default. */
export const SPACE_ICON_NAMES = [
  "terminal",
  "folder",
  "code",
  "rocket",
  "briefcase",
  "house",
  "book-open",
  "flask-conical",
  "server",
  "globe",
] as const;

export type SpaceIconName = (typeof SPACE_ICON_NAMES)[number];

export type EnvParse = { ok: true; env: Record<string, string> } | { ok: false; error: string };

/**
 * Reads environment variables from text with one `KEY=value` per line. Blank lines are skipped, the
 * value is everything after the first `=` (it may be empty) and a later line wins over an earlier
 * one with the same name.
 */
export function parseEnvLines(text: string): EnvParse {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === "") continue;
    const at = raw.indexOf("=");
    const name = at < 0 ? raw.trim() : raw.slice(0, at).trim();
    const value = at < 0 ? "" : raw.slice(at + 1);
    if (at < 0) return { ok: false, error: `Line ${index + 1}: expected NAME=value.` };
    if (!validEnv({ [name]: value })) {
      return { ok: false, error: `Line ${index + 1}: "${name}" is not a valid variable name.` };
    }
    env[name] = value;
  }
  return { ok: true, env };
}

/** The inverse of `parseEnvLines`: one `KEY=value` per line. */
export function formatEnvLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

/** True when `text` is one user-perceived character (an emoji, with its modifiers and joiners). */
export function isSingleGlyph(text: string): boolean {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  return segments.length === 1;
}

/** The slice of a wheel event the space gesture reads. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/**
 * Horizontal travel of a wheel event in pixels, positive to the right: `deltaX` when the gesture is
 * mostly horizontal, or `deltaY` while Shift is held (some platforms already turn that into
 * `deltaX`). A plain vertical wheel is 0.
 */
export function wheelTravel(event: WheelLike): number {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return event.deltaX * scale;
  return event.shiftKey ? event.deltaY * scale : 0;
}

/** Pixels of horizontal travel that make one step, and the pause that ends a gesture. */
export const WHEEL_THRESHOLD = 60;
export const WHEEL_IDLE_MS = 200;

/**
 * Turns a stream of horizontal wheel travel into at most one step (-1 left, +1 right) per gesture:
 * the travel must add up to `threshold` first, and once a step fired the rest of the gesture (a
 * trackpad keeps sending events with momentum) is ignored until `idleMs` pass with no event.
 */
export function createWheelGesture(
  threshold = WHEEL_THRESHOLD,
  idleMs = WHEEL_IDLE_MS,
): (travel: number, now: number) => -1 | 0 | 1 {
  let sum = 0;
  let last = Number.NEGATIVE_INFINITY;
  let spent = false;
  return (travel, now) => {
    if (now - last > idleMs) {
      sum = 0;
      spent = false;
    }
    last = now;
    if (travel === 0 || spent) return 0;
    if (Math.sign(travel) !== Math.sign(sum)) sum = 0;
    sum += travel;
    if (Math.abs(sum) < threshold) return 0;
    spent = true;
    const step = sum > 0 ? 1 : -1;
    sum = 0;
    return step;
  };
}

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

/** The slice of a keyboard event the space shortcut reads. */
export interface ShortcutEvent {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Zero-based space position for Ctrl+Alt+1..9; `undefined` for any other key. */
export function spaceShortcutIndex(event: ShortcutEvent): number | undefined {
  if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return undefined;
  const match = /^Digit([1-9])$/.exec(event.code);
  return match?.[1] === undefined ? undefined : Number(match[1]) - 1;
}

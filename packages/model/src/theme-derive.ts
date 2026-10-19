import { BACKGROUND, FONT, THEMES } from "./builtin-themes";
import { SYSTEM_THEME } from "./config";
import { contrastRatio, parseTheme } from "./theme";
import type { ParseThemeResult } from "./theme";

// What an imported color scheme becomes. A scheme gives the colors of the terminal (foreground,
// background, cursor, selection and the sixteen ANSI colors); a theme also has the tokens of the
// interface (surface, text, muted, accent, border). Those are derived here from the colors of the
// terminal, so the window around the terminal looks like it, and are held to the same contrast the
// built-in themes meet: the text of the interface 4.5:1 on its background, the muted text and the
// accent 3:1. The colors of the terminal are kept as the scheme gives them, even when a scheme
// chose a low contrast: that is the scheme's choice and the terminal is where it applies.

/** The colors of a scheme, each one `#rrggbb` (the selection may be `#rrggbbaa`). */
export interface SchemeColors {
  foreground: string;
  background: string;
  /** Left out: the cursor takes the foreground color. */
  cursor?: string | undefined;
  /** Left out: the selection is the background drawn a quarter of the way to the foreground. */
  selection?: string | undefined;
  /** The sixteen ANSI colors: 8 normal, then 8 bright. The schema rejects any other length. */
  ansi: readonly string[];
}

export interface ColorOptions {
  /** Accept `#rrggbbaa` and keep the alpha (the selection); otherwise the alpha is dropped. */
  alpha?: boolean;
  /** Accept a color with no `#` in front (`1d1f21`). */
  bare?: boolean;
}

/**
 * A color as `#rrggbb` (or `#rrggbbaa`) in lower case, or `undefined` when `value` is not one.
 * Reads `#rgb`, `#rrggbb` and `#rrggbbaa`.
 */
export function normalizeColor(value: unknown, options: ColorOptions = {}): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(#?)([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (match === null) return undefined;
  if (match[1] === "" && options.bare !== true) return undefined;
  const digits = (match[2] ?? "").toLowerCase();
  if (digits.length === 3) {
    return `#${[...digits].map((digit) => digit + digit).join("")}`;
  }
  if (digits.length === 8) {
    return options.alpha === true ? `#${digits}` : `#${digits.slice(0, 6)}`;
  }
  return `#${digits}`;
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function hexOf(values: readonly number[]): string {
  return `#${values
    .map((value) =>
      Math.round(Math.min(255, Math.max(0, value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** `from` moved `weight` (0 to 1) of the way to `to`; both `#rrggbb`. */
export function mixColors(from: string, to: string, weight: number): string {
  const a = channels(from);
  const b = channels(to);
  return hexOf(a.map((value, index) => value + ((b[index] ?? value) - value) * weight));
}

/** `color` pushed toward `extreme` (white or black) until it has `minimum` contrast on `background`. */
function withContrast(color: string, background: string, minimum: number, extreme: string): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = step === 20 ? extreme : mixColors(color, extreme, step / 20);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return extreme;
}

/** Whether a background is a dark one: white text reads on it better than black text does. */
function isDark(background: string): boolean {
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#000000");
}

/**
 * The theme of a scheme: the colors of the terminal as given, and the tokens of the interface
 * derived from them (see the top of this file). Goes through `ThemeSchema`, so what comes back is
 * either a valid theme or the reasons it is not (a color that is not a color, not sixteen ANSI colors).
 */
export function deriveTheme(colors: SchemeColors, id: string, name: string): ParseThemeResult {
  const { foreground, background } = colors;
  const dark = isDark(background);
  const extreme = dark ? "#ffffff" : "#000000";

  const text = withContrast(foreground, background, 4.5, extreme);
  const muted = withContrast(mixColors(text, background, 0.4), background, 3, extreme);
  // The accent is the scheme's blue where it reads, then its other bright colors, then the cursor.
  const ansi = colors.ansi;
  const cursor = colors.cursor ?? foreground;
  const accent =
    [ansi[4], ansi[12], ansi[6], ansi[14], ansi[5], cursor, foreground].find(
      (candidate): candidate is string =>
        candidate !== undefined && contrastRatio(candidate, background) >= 3,
    ) ?? withContrast(ansi[4] ?? foreground, background, 3, extreme);

  return parseTheme({
    id,
    name,
    kind: dark ? "dark" : "light",
    ui: {
      bg: background,
      surface: mixColors(background, text, 0.06),
      text,
      muted,
      accent,
      border: mixColors(background, text, 0.15),
      radius: 10,
      blur: 18,
      opacity: 0.92,
    },
    terminal: {
      foreground,
      background,
      cursor,
      selection: colors.selection ?? mixColors(background, foreground, 0.25),
      ansi: [...ansi],
    },
    font: FONT,
    background: BACKGROUND,
  });
}

/** Longest id a generated slug may have, so a long name does not make a long file name. */
const MAX_SLUG = 48;

/** `Solarized Dark (v2)` as `solarized-dark-v2`; empty when the name has no letter or digit. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
}

/** The name as a person reads it: control characters out, blanks folded, no longer than the schema allows. */
export function cleanName(name: string): string {
  return name
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

/** Ids no imported theme may take: the built-in themes, and `system`, which means "follow the system". */
export function reservedThemeIds(): Set<string> {
  return new Set([...THEMES.map((theme) => theme.id), SYSTEM_THEME]);
}

/**
 * Gives a theme an id and a name that collide with nothing in `taken` (which grows by the id it
 * hands out, so the next call sees it). The id is the slug of the name, or `fallback` when the name
 * has none; when it is taken a number is added (`-2`, `-3`, ...) to the id and ` (2)` to the name.
 */
export function claimIdentity(
  name: string,
  fallback: string,
  taken: Set<string>,
): { id: string; name: string } {
  const cleaned = cleanName(name) || fallback;
  const base = slugify(cleaned) || slugify(fallback);
  let number = 1;
  let id = base;
  while (taken.has(id)) {
    number += 1;
    id = `${base}-${number}`;
  }
  taken.add(id);
  const label = number === 1 ? cleaned : `${cleaned.slice(0, 54).trim()} (${number})`;
  return { id, name: label };
}

// The options of the terminal that come from `config.jsonc` (`terminal`): the font, the cursor, how
// much scrollback is kept and what the bell does. Pure: the schema in `config.ts` uses the limits
// and the font rule from here, and the interface turns the settings in force into the options of
// xterm with `terminalOptionsOf`.
//
// The defaults are what the terminal did before the options existed (a fixed font, 14 px, a
// blinking block, 10,000 lines, a bell that only marks the tab), so a file that says nothing changes
// nothing.
//
// The name of a font is text from a file the person edits (and could come from a theme file that
// was downloaded), so it is never trusted: only the names of font families get through, written
// into the CSS `font-family` value always as names, never as anything the CSS parser could read as
// a rule (see `parseFontFamilies`).

/** Smallest and largest font size, in pixels. The zoom shortcuts stop at the same limits. */
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 72;
export const DEFAULT_FONT_SIZE = 14;

/** The line height is a multiple of the font size; the terminal cannot draw a row shorter than the text. */
export const MIN_LINE_HEIGHT = 1;
export const MAX_LINE_HEIGHT = 3;
export const DEFAULT_LINE_HEIGHT = 1;

/** Lines kept above the screen. A line costs memory in every terminal, so there is a ceiling. */
export const MIN_SCROLLBACK = 0;
export const MAX_SCROLLBACK = 100_000;
export const DEFAULT_SCROLLBACK = 10_000;

export const CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];
export const DEFAULT_CURSOR_STYLE: CursorStyle = "block";
export const DEFAULT_CURSOR_BLINK = true;

/**
 * What the terminal does when a program rings the bell: nothing, a flash of the pane, a short beep
 * or both. Whatever it is, the tab is still marked (see `unread.ts`).
 */
export const BELL_STYLES = ["none", "visual", "sound", "both"] as const;
export type BellStyle = (typeof BELL_STYLES)[number];
export const DEFAULT_BELL_STYLE: BellStyle = "none";

/** Font names, comma separated, the first one found on the machine wins. */
export const DEFAULT_FONT_FAMILY = "Cascadia Mono, Consolas, DejaVu Sans Mono, monospace";

/** The ligatures of the font are accepted as a setting but not drawn yet (see `docs/CONFIG.md`). */
export const DEFAULT_LIGATURES = false;

/** Longest `terminal.font.family`, the most names in it and the longest name. */
export const MAX_FONT_FAMILY_LENGTH = 300;
export const MAX_FONT_FAMILIES = 12;
const MAX_FONT_NAME_LENGTH = 64;

/** The generic families of CSS: written without quotes they are not a name but a kind of font. */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

/**
 * The letters, digits, marks and the few signs that real family names use ("Source Code Pro",
 * "M+ 1m", "Noto Sans Mono CJK JP", "Hack Nerd Font Mono"). No quote, backslash, parenthesis,
 * semicolon, brace, colon, slash or angle bracket: with none of those a name cannot be a URL, a
 * function or the end of a CSS declaration.
 */
const FONT_NAME_PATTERN = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} _.+&-]*$/u;

/** A name CSS reads as one plain word, so it needs no quotes ("Consolas" but not "DejaVu Sans Mono"). */
const PLAIN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** True when `name` is, on its own, the name of a font family (no quotes, no commas). */
export function isFontName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_FONT_NAME_LENGTH && FONT_NAME_PATTERN.test(name);
}

/**
 * A list of installed font families as the backend promises it (`Backend.listMonospaceFonts`):
 * only the items that are the name of a font, once each (upper and lower case alike), in
 * alphabetical order. For a list that came from outside (the Rust side, a fake) and is not trusted.
 */
export function fontNameList(names: readonly unknown[]): string[] {
  const byKey = new Map<string, string>();
  for (const item of names) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!isFontName(name)) continue;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, name]) => name);
}

/** One item of a font list: a family name, or a generic family of CSS. */
export type FontFamily = { kind: "name"; name: string } | { kind: "generic"; name: string };

export type FontFamiliesResult =
  { ok: true; families: FontFamily[] } | { ok: false; problem: string };

/** `"Fira Code"` and `'Fira Code'` are the name Fira Code; anything else is left as it is. */
function unquote(item: string): { text: string; quoted: boolean } {
  const first = item.charAt(0);
  if (item.length >= 2 && (first === '"' || first === "'") && item.endsWith(first)) {
    return { text: item.slice(1, -1).trim(), quoted: true };
  }
  return { text: item, quoted: false };
}

/**
 * Reads a list of font names, such as `Cascadia Code, "JetBrains Mono", monospace`. Never throws.
 * A name may be written with or without quotes; a generic family (`monospace`) written without
 * quotes stays a generic family. Anything that is not the name of a font family comes back as a
 * problem in words: an empty list or item, a character a family name does not have (so no `url(...)`,
 * no semicolon, no braces), a name or a list that is too long.
 */
export function parseFontFamilies(text: string): FontFamiliesResult {
  if (text.length > MAX_FONT_FAMILY_LENGTH) {
    return {
      ok: false,
      problem: `A font list is at most ${MAX_FONT_FAMILY_LENGTH} characters long`,
    };
  }
  if (text.trim() === "") {
    return { ok: false, problem: "Needs at least one font name, such as Consolas" };
  }
  const families: FontFamily[] = [];
  for (const raw of text.split(",")) {
    const { text: name, quoted } = unquote(raw.trim());
    if (name === "") {
      return { ok: false, problem: "A font list cannot have an empty name between commas" };
    }
    if (name.length > MAX_FONT_NAME_LENGTH) {
      return {
        ok: false,
        problem: `A font name is at most ${MAX_FONT_NAME_LENGTH} characters long`,
      };
    }
    if (!isFontName(name)) {
      return {
        ok: false,
        problem: `"${name.slice(0, 40)}" is not the name of a font: names have letters, digits, spaces and . _ + & - only (no quotes, brackets, semicolons or addresses)`,
      };
    }
    families.push(
      !quoted && GENERIC_FAMILIES.has(name.toLowerCase())
        ? { kind: "generic", name: name.toLowerCase() }
        : { kind: "name", name },
    );
  }
  if (families.length > MAX_FONT_FAMILIES) {
    return { ok: false, problem: `A font list has at most ${MAX_FONT_FAMILIES} names` };
  }
  return { ok: true, families };
}

/** Why `text` is not a list of font names, or `undefined` when it is one. */
export function fontFamilyProblem(text: string): string | undefined {
  const result = parseFontFamilies(text);
  return result.ok ? undefined : result.problem;
}

/**
 * The CSS value of `font-family` for a list of font names: every name is quoted unless it is a
 * plain word that CSS reads as a name (`Consolas`), and a generic family stays bare. Because the
 * names cannot hold a quote or a backslash, the result is always only names and keywords.
 */
export function cssFontFamily(families: readonly FontFamily[]): string {
  return families
    .map(({ kind, name }) =>
      kind === "generic" ||
      (PLAIN_NAME_PATTERN.test(name) && !GENERIC_FAMILIES.has(name.toLowerCase()))
        ? name
        : `"${name}"`,
    )
    .join(", ");
}

/**
 * The `font-family` value for `text` (a list of font names), or the default font when `text` is
 * not one. Never throws and never returns anything but names, so it is safe for text that was not
 * checked first.
 */
export function safeFontFamily(text: string): string {
  const result = parseFontFamilies(text);
  if (result.ok) return cssFontFamily(result.families);
  const fallback = parseFontFamilies(DEFAULT_FONT_FAMILY);
  return fallback.ok ? cssFontFamily(fallback.families) : "monospace";
}

/** The `font-family` value the terminal has when nothing is set. */
export const DEFAULT_FONT_FAMILY_CSS = safeFontFamily(DEFAULT_FONT_FAMILY);

/** `size` kept between the smallest and the largest font size. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

/** How many pixels one press of a zoom shortcut changes the font size. */
export const FONT_ZOOM_STEP = 1;

/**
 * The font size after the zoom: `base` (the size of the settings) moved by `zoom` pixels, kept
 * between the limits.
 */
export function zoomedFontSize(base: number, zoom: number): number {
  return clampFontSize(base + zoom);
}

/**
 * The zoom (pixels over the size of the settings) that gives the font size one step bigger
 * (`direction` 1) or smaller (`-1`) than the size shown now. It starts from the size on screen,
 * not from the stored zoom, so a press at a limit does not pile up steps that would have to be
 * undone before the size moves again.
 */
export function nextZoom(base: number, zoom: number, direction: 1 | -1): number {
  const target = clampFontSize(zoomedFontSize(base, zoom) + direction * FONT_ZOOM_STEP);
  return target - clampFontSize(base);
}

/** The settings of the terminal as `config.jsonc` holds them: every part optional. */
export interface TerminalSettings {
  font?:
    | {
        family?: string | undefined;
        size?: number | undefined;
        lineHeight?: number | undefined;
        ligatures?: boolean | undefined;
      }
    | undefined;
  cursor?:
    | {
        style?: CursorStyle | undefined;
        blink?: boolean | undefined;
      }
    | undefined;
  scrollback?: number | undefined;
  bell?: BellStyle | undefined;
  /** Whether a snapshot of the scrollback of every pane is kept (see `scrollback.ts`). Default true. */
  saveScrollback?: boolean | undefined;
}

/** What the terminal is given: every option has a value. */
export interface TerminalOptions {
  /** A CSS `font-family` value made only of names (see `safeFontFamily`). */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  ligatures: boolean;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  bell: BellStyle;
}

export const DEFAULT_TERMINAL_OPTIONS: Readonly<TerminalOptions> = {
  fontFamily: DEFAULT_FONT_FAMILY_CSS,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: DEFAULT_LINE_HEIGHT,
  ligatures: DEFAULT_LIGATURES,
  cursorStyle: DEFAULT_CURSOR_STYLE,
  cursorBlink: DEFAULT_CURSOR_BLINK,
  scrollback: DEFAULT_SCROLLBACK,
  bell: DEFAULT_BELL_STYLE,
};

/**
 * The options of the terminal for the settings in force: what the file sets over the defaults. A
 * value out of range (the schema refuses those, so this is for callers that skipped it) is kept
 * in range rather than handed to xterm, which throws on a line height under 1.
 */
export function terminalOptionsOf(settings: TerminalSettings | undefined): TerminalOptions {
  const defaults = DEFAULT_TERMINAL_OPTIONS;
  const size = settings?.font?.size;
  const lineHeight = settings?.font?.lineHeight;
  const scrollback = settings?.scrollback;
  const family = settings?.font?.family;
  return {
    fontFamily: family !== undefined ? safeFontFamily(family) : defaults.fontFamily,
    fontSize: size !== undefined ? clampFontSize(size) : defaults.fontSize,
    lineHeight:
      lineHeight !== undefined && Number.isFinite(lineHeight)
        ? Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, lineHeight))
        : defaults.lineHeight,
    ligatures: settings?.font?.ligatures ?? defaults.ligatures,
    cursorStyle: settings?.cursor?.style ?? defaults.cursorStyle,
    cursorBlink: settings?.cursor?.blink ?? defaults.cursorBlink,
    scrollback:
      scrollback !== undefined && Number.isFinite(scrollback)
        ? Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(scrollback)))
        : defaults.scrollback,
    bell: settings?.bell ?? defaults.bell,
  };
}

import { MAX_BACKGROUND_BLUR, backgroundImageProblem } from "./background";
import { MIN_TEXT_CONTRAST, contrastRatio } from "./theme";
import type { AnsiPalette, Theme } from "./theme";
import { normalizeColor } from "./theme-derive";

// What the theme editor of the settings screen does with a theme before it is saved, as pure
// functions. The editor holds a theme that is valid at every moment (the one its preview draws) and
// the text of the boxes the person is typing in; a box is read with `readThemeField` (a color, a
// number in its range, the font list, the path of a picture), and a text that is not valid leaves the
// theme as it was and comes back with the reason, so the preview never shows a half-typed value and
// Save waits for the box to be fixed. What is written to `themes/` is still checked by the schema of
// the theme (`duplicateTheme` and `renameTheme` of `theme-actions.ts` answer a theme that went
// through it again), so these readers can never be the only thing between a typo and a file.

/** The ANSI colors of a theme, by place in its palette: 8 normal, then 8 bright. */
export type AnsiIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/** Every place of the ANSI palette. */
export const ANSI_INDEXES: readonly AnsiIndex[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

export type AnsiField = `terminal.ansi.${AnsiIndex}`;

/** The field of the color at `index` of the ANSI palette. */
export const ansiField = (index: AnsiIndex): AnsiField => `terminal.ansi.${index}`;

/** The colors of the interface. */
export type UiColorField =
  "ui.accent" | "ui.bg" | "ui.surface" | "ui.text" | "ui.muted" | "ui.border";

/** The colors of the terminal besides the ANSI palette. */
export type TerminalColorField =
  "terminal.background" | "terminal.foreground" | "terminal.cursor" | "terminal.selection";

/** A box that holds a color: `#rrggbb`, or `#rrggbbaa` for the selection. */
export type ColorField = UiColorField | TerminalColorField | AnsiField;

/** A box that holds a number. */
export type NumberField =
  | "ui.radius"
  | "ui.blur"
  | "ui.opacity"
  | "font.size"
  | "font.lineHeight"
  | "background.opacity"
  | "background.blur";

/** A box that holds text: the list of font names and the path of the picture. */
export type TextField = "font.family" | "background.image";

/** Everything the editor has a box for. The name, the kind and the ligatures have a control of their own. */
export type ThemeField = ColorField | NumberField | TextField;

/** What a number box accepts. */
export interface NumberRange {
  min: number;
  max: number;
  /** The step of the slider that goes with the box. */
  step: number;
  /** The box may be empty: the theme then says nothing for it. */
  optional?: boolean;
}

/**
 * The range of each number box, which is what the schema of the theme allows (the editor is never
 * wider than the schema; where the schema only says "above 0" the editor asks for at least the
 * smallest font size the terminal takes, 6).
 */
export const NUMBER_RANGES: Readonly<Record<NumberField, NumberRange>> = {
  "ui.radius": { min: 0, max: 32, step: 1 },
  "ui.blur": { min: 0, max: 100, step: 1 },
  "ui.opacity": { min: 0, max: 1, step: 0.05 },
  "font.size": { min: 6, max: 96, step: 1 },
  "font.lineHeight": { min: 0.8, max: 3, step: 0.05 },
  "background.opacity": { min: 0, max: 1, step: 0.05 },
  "background.blur": { min: 0, max: MAX_BACKGROUND_BLUR, step: 1, optional: true },
};

/** Why the text of a box is not a value for it. The interface says it in the language in force. */
export type FieldProblem =
  | { kind: "color"; alpha: boolean }
  | { kind: "number" }
  | { kind: "range"; min: number; max: number }
  | { kind: "empty" }
  | { kind: "picture"; reason: string };

/** What a box's text says: a value for its field, or the reason it is not one. */
export type FieldReading =
  { ok: true; value: string | number | null | undefined } | { ok: false; problem: FieldProblem };

const NUMBER_TEXT = /^-?(\d+(\.\d+)?|\.\d+)$/;

/** The number a box holds, or `undefined` for text that is not one. A comma works as the decimal point. */
function numberOf(text: string): number | undefined {
  const folded = text.trim();
  const dotted = /^[^.]*,[^.,]*$/.test(folded) ? folded.replace(",", ".") : folded;
  if (!NUMBER_TEXT.test(dotted)) return undefined;
  const value = Number(dotted);
  return Number.isFinite(value) ? value : undefined;
}

/** A number as a box shows it: at most two decimals, no trailing zeros. */
export function numberText(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** Whether `field` holds a number. */
export function isNumber(field: ThemeField): field is NumberField {
  return Object.hasOwn(NUMBER_RANGES, field);
}

/** Whether `field` holds a color: all of the terminal's fields are colors, and so are the ui ones that are not numbers. */
export function isColor(field: ThemeField): field is ColorField {
  return field.startsWith("terminal.") || (field.startsWith("ui.") && !isNumber(field));
}

/**
 * Reads the text of the box of `field`. A color is `#rgb`, `#rrggbb` or (the selection only)
 * `#rrggbbaa`, any case, and comes back as `#rrggbb` in lower case; a number must be in the range of
 * its field; the font is a list of names that is not empty; the picture is empty (none) or the path
 * of a picture the app can show (see `backgroundImageProblem`). Never throws.
 */
export function readThemeField(field: ThemeField, text: string): FieldReading {
  if (isNumber(field)) {
    const range = NUMBER_RANGES[field];
    if (text.trim() === "" && range.optional === true) return { ok: true, value: undefined };
    const value = numberOf(text);
    if (value === undefined) return { ok: false, problem: { kind: "number" } };
    if (value < range.min || value > range.max) {
      return { ok: false, problem: { kind: "range", min: range.min, max: range.max } };
    }
    return { ok: true, value };
  }
  if (isColor(field)) {
    const alpha = field === "terminal.selection";
    const color = normalizeColor(text, { alpha: true, bare: true });
    // `#rrggbbaa` is for the selection alone: another color would lose its alpha without a word.
    if (color === undefined || (!alpha && color.length !== 7)) {
      return { ok: false, problem: { kind: "color", alpha } };
    }
    return { ok: true, value: color };
  }
  if (field === "font.family") {
    const family = text.trim();
    return family === "" ? { ok: false, problem: { kind: "empty" } } : { ok: true, value: family };
  }
  const path = text.trim();
  if (path === "") return { ok: true, value: null };
  const reason = backgroundImageProblem(path);
  return reason === undefined
    ? { ok: true, value: path }
    : { ok: false, problem: { kind: "picture", reason } };
}

/** The text a box shows for the value `theme` has in `field`. */
export function fieldText(theme: Theme, field: ThemeField): string {
  switch (field) {
    case "font.family":
      return theme.font.family;
    case "background.image":
      return theme.background.image ?? "";
    case "background.blur":
      return theme.background.blur === undefined ? "" : numberText(theme.background.blur);
    default:
      break;
  }
  const [group, key, index] = field.split(".") as [string, string, string | undefined];
  const value =
    group === "terminal" && key === "ansi"
      ? theme.terminal.ansi[Number(index)]
      : (theme[group as "ui" | "terminal" | "font" | "background"] as Record<string, unknown>)[key];
  return typeof value === "number" ? numberText(value) : String(value);
}

/**
 * `theme` with `value` (as `readThemeField` read it) in `field`. A new theme: the one that came in
 * is never changed. A value that is not the kind the field holds is not checked here; the schema
 * judges the theme when it is saved.
 */
export function setThemeField(
  theme: Theme,
  field: ThemeField,
  value: string | number | null | undefined,
): Theme {
  if (field === "background.blur") {
    const { image, opacity } = theme.background;
    return {
      ...theme,
      background: typeof value === "number" ? { image, opacity, blur: value } : { image, opacity },
    };
  }
  const [group, key, index] = field.split(".") as [string, string, string | undefined];
  if (group === "terminal" && key === "ansi") {
    const ansi = [...theme.terminal.ansi] as unknown as AnsiPalette;
    ansi[Number(index) as AnsiIndex] = String(value);
    return { ...theme, terminal: { ...theme.terminal, ansi } };
  }
  const part = group as "ui" | "terminal" | "font" | "background";
  return { ...theme, [part]: { ...theme[part], [key]: value } };
}

/**
 * Types `text` into the box of `field`: the theme with the value when the text is one, else the
 * theme as it was and the reason.
 */
export function typeIntoField(
  theme: Theme,
  field: ThemeField,
  text: string,
): { theme: Theme; problem: FieldProblem | undefined } {
  const read = readThemeField(field, text);
  return read.ok
    ? { theme: setThemeField(theme, field, read.value), problem: undefined }
    : { theme, problem: read.problem };
}

// ---------------------------------------------------------------------------------------------
// Contrast

/** The pairs of colors of a theme whose contrast is held to a minimum. */
export type ContrastCheck = "text" | "sidebar" | "muted" | "accent" | "terminal";

/** A pair of colors that reads worse than it should. */
export interface ContrastWarning {
  check: ContrastCheck;
  ratio: number;
  minimum: number;
}

/** The contrast the colors of a theme are held to, as the built-in themes meet it. */
const CONTRAST_CHECKS: readonly {
  check: ContrastCheck;
  minimum: number;
  colors(theme: Theme): [string, string];
}[] = [
  { check: "text", minimum: MIN_TEXT_CONTRAST, colors: (t) => [t.ui.text, t.ui.bg] },
  // The text on the surface of the sidebar: Noren Dune, which ships with the app, reads 4.4:1 there.
  { check: "sidebar", minimum: 3, colors: (t) => [t.ui.text, t.ui.surface] },
  { check: "muted", minimum: 3, colors: (t) => [t.ui.muted, t.ui.bg] },
  { check: "accent", minimum: 3, colors: (t) => [t.ui.accent, t.ui.bg] },
  {
    check: "terminal",
    minimum: MIN_TEXT_CONTRAST,
    colors: (t) => [t.terminal.foreground, t.terminal.background],
  },
];

/**
 * The pairs of colors of `theme` that read worse than the built-in themes do (the text 4.5:1 on its
 * background, the muted text and the accent 3:1; the cursor is not held to anything, Noren Oat has a
 * pale one). It only warns: a theme with a low
 * contrast is a choice, and the editor still saves it.
 */
export function themeContrastWarnings(theme: Theme): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  for (const { check, minimum, colors } of CONTRAST_CHECKS) {
    const [front, back] = colors(theme);
    const ratio = contrastRatio(front, back);
    if (ratio < minimum) warnings.push({ check, ratio, minimum });
  }
  return warnings;
}

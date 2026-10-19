import { z } from "zod";
import { MAX_BACKGROUND_BLUR, MAX_BACKGROUND_PATH, backgroundImageProblem } from "./background";

// The format of a theme (spec section 8, `themes/*.json`) as a zod schema; the `Theme` type comes
// from it. A theme is data: the tokens of the interface, the colors of the terminal, the font and
// the background. Everything that reads a theme (the built-in ones, and later the importers and
// the files of the user) goes through `ThemeSchema`, so a theme that is not valid never reaches
// the screen.

/** `#rrggbb`. */
const OPAQUE_COLOR = /^#[0-9a-f]{6}$/i;
/** `#rrggbb` or `#rrggbbaa`: a color that may be see-through, such as the selection. */
const ALPHA_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
/** `noren-dusk`: lower case words joined by single hyphens. */
export const THEME_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const color = z.string().regex(OPAQUE_COLOR, "Expected a color like #1a2b3c");
const colorWithAlpha = z.string().regex(ALPHA_COLOR, "Expected a color like #1a2b3c or #1a2b3c80");
const unit = z.number().min(0).max(1);

export const ThemeSchema = z.strictObject({
  id: z.string().regex(THEME_ID_PATTERN, "Expected lower case words joined by hyphens"),
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["dark", "light"]),
  ui: z.strictObject({
    bg: color,
    surface: color,
    text: color,
    muted: color,
    accent: color,
    border: color,
    /** Corner radius in px. */
    radius: z.number().min(0).max(32),
    blur: z.number().min(0).max(100),
    opacity: unit,
  }),
  terminal: z.strictObject({
    foreground: color,
    background: color,
    cursor: color,
    selection: colorWithAlpha,
    /** Sixteen ANSI colors in the usual order: 8 normal, then 8 bright. */
    ansi: z.tuple([
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
      color,
    ]),
  }),
  font: z.strictObject({
    family: z.string().trim().min(1),
    size: z.number().positive().max(96),
    lineHeight: z.number().min(0.8).max(3),
    ligatures: z.boolean(),
  }),
  background: z.strictObject({
    /**
     * A picture file on this computer (see `backgroundImageProblem`), or null for none. A path that
     * is a web address, a network path or not a picture makes the whole theme invalid.
     */
    image: z
      .string()
      .min(1)
      .max(MAX_BACKGROUND_PATH)
      .superRefine((path, context) => {
        const problem = backgroundImageProblem(path);
        if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
      })
      .nullable(),
    /** How much of the picture shows, from 0 to 1. */
    opacity: unit,
    /** How blurred the picture is, in pixels; none when the theme does not say. */
    blur: z.number().min(0).max(MAX_BACKGROUND_BLUR).optional(),
  }),
});

/** A theme, as the schema says it is. */
export type Theme = z.infer<typeof ThemeSchema>;

/** Sixteen ANSI colors in the usual order: 8 normal, then 8 bright. */
export type AnsiPalette = Theme["terminal"]["ansi"];

export type ParseThemeResult = { ok: true; theme: Theme } | { ok: false; errors: string[] };

/** Checks a theme read from anywhere. Never throws; each problem says where it is. */
export function parseTheme(value: unknown): ParseThemeResult {
  const parsed = ThemeSchema.safeParse(value);
  if (parsed.success) return { ok: true, theme: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    }),
  };
}

/** The 0 to 255 channels of a `#rrggbb` color (an alpha, if any, is ignored). */
function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.x relative luminance of a `#rrggbb` color, from 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors: 1 (the same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const [lighter, darker] = first >= second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The smallest contrast WCAG asks of normal text (level AA). */
export const MIN_TEXT_CONTRAST = 4.5;

import { normalizeColor } from "./theme-derive";
import type { SchemeColors } from "./theme-derive";

// Color schemes in the text format of one `key = value` per line (the theme files of some
// terminals). The lines the scheme uses:
//
//   palette = 0=#1d1f21        the ANSI color 0 to 15 (all sixteen are required)
//   background = #1d1f21
//   foreground = #c5c8c6
//   cursor-color = #c5c8c6     optional
//   selection-background = #373b41   optional
//
// A line that starts with `#` is a comment (a `#` later in the line is the start of a color).
// Colors are `#rgb`, `#rrggbb`, or `rrggbb` with no `#`. Any other key is ignored, so a theme file
// that also sets other things is still read for its colors. Never throws.

export type KeyValueSchemeResult =
  { ok: true; colors: SchemeColors; warnings: string[] } | { ok: false; errors: string[] };

/** The value without a pair of quotes around it. */
function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted !== null ? (quoted[2] ?? "") : value;
}

/** Whether a line of the text looks like `key = value` (used to tell this format from others). */
export function looksLikeKeyValue(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => /^\s*[A-Za-z][\w-]*\s*=/.test(line) && !line.trimStart().startsWith("#"));
}

export function keyValueSchemeColors(text: string): KeyValueSchemeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const palette = new Map<number, string>();
  const single = new Map<string, string>();

  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const at = `line ${index + 1}`;
    const equals = line.indexOf("=");
    if (equals <= 0) {
      warnings.push(`${at}: not a "key = value" line, ignored`);
      return;
    }
    const key = line.slice(0, equals).trim().toLowerCase();
    const value = unquote(line.slice(equals + 1).trim());
    if (key === "palette") {
      const pair = /^(\d{1,3})\s*=\s*(.+)$/.exec(value);
      if (pair === null) {
        errors.push(`${at}: palette needs a number and a color, like palette = 0=#1d1f21`);
        return;
      }
      const number = Number(pair[1]);
      // Only the sixteen ANSI colors are part of a theme; the rest of the 256 are ignored.
      if (number > 15) return;
      const color = normalizeColor(pair[2], { bare: true });
      if (color === undefined) errors.push(`${at}: "${pair[2] ?? ""}" is not a color`);
      else palette.set(number, color);
      return;
    }
    if (
      key === "background" ||
      key === "foreground" ||
      key === "cursor-color" ||
      key === "selection-background"
    ) {
      const color = normalizeColor(value, { bare: true, alpha: key === "selection-background" });
      if (color === undefined) errors.push(`${at}: "${value}" is not a color`);
      else single.set(key, color);
    }
  });

  for (const key of ["foreground", "background"]) {
    if (!single.has(key)) errors.push(`"${key}" is missing`);
  }
  const missing = Array.from({ length: 16 }, (_, number) => number).filter(
    (number) => !palette.has(number),
  );
  if (missing.length > 0) {
    errors.push(
      `palette is missing the color${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    colors: {
      foreground: single.get("foreground") ?? "#000000",
      background: single.get("background") ?? "#000000",
      cursor: single.get("cursor-color"),
      selection: single.get("selection-background"),
      ansi: Array.from({ length: 16 }, (_, number) => palette.get(number) ?? "#000000"),
    },
    warnings,
  };
}

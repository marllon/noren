import { parseTheme } from "./theme";
import type { Theme } from "./theme";
import { reservedThemeIds } from "./theme-derive";

// The themes of the user live in the folder `themes/` next to `config.jsonc`, one JSON file per
// theme (`themes/<id>.json`, the format of spec section 8). The backend lists and saves the text of
// the files; this module is the other half: what a file's text must be to count as a theme, and the
// text a theme is saved as.

/** The largest theme file the app reads, writes or exports (the limit of the core, `MAX_THEME_BYTES`). */
export const MAX_THEME_BYTES = 256 * 1024;

/**
 * Why `text` cannot be exported as a theme file, or `undefined` when it can: the same checks the
 * core makes before the save chooser opens (at most `MAX_THEME_BYTES`, shaped like a JSON object).
 * Whether it is a valid theme is not asked here: the file is read back by the importers.
 */
export function themeExportProblem(text: string): string | undefined {
  if (new TextEncoder().encode(text).length > MAX_THEME_BYTES) {
    return `the theme is larger than ${MAX_THEME_BYTES} bytes`;
  }
  const body = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  return body.startsWith("{") && body.endsWith("}")
    ? undefined
    : "the text to export is not a theme file";
}

/** The path an export writes for the one the person chose: `.json` is added to a name without that extension. */
export function exportedThemePath(path: string): string {
  return /\.json$/i.test(path) ? path : `${path}.json`;
}

/** The text a theme is saved as: the JSON of the theme, indented, with a final line break. */
export function serializeTheme(theme: Theme): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}

export interface UserThemesResult {
  /** The valid themes, in the order the palette lists them (by name). */
  themes: Theme[];
  /** One sentence per file that was left out and why; the files are not touched. */
  ignored: string[];
}

/**
 * The themes in the texts of the files of `themes/`. A file that is not JSON, is not a valid theme
 * (`ThemeSchema`), takes the id of a built-in theme (or `system`) or repeats the id of a file
 * before it is left out. Never throws.
 */
export function parseUserThemes(texts: readonly string[]): UserThemesResult {
  const taken = reservedThemeIds();
  const themes: Theme[] = [];
  const ignored: string[] = [];
  for (const text of texts) {
    let value: unknown;
    try {
      value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      ignored.push("A file of the themes folder is not JSON");
      continue;
    }
    const parsed = parseTheme(value);
    if (!parsed.ok) {
      ignored.push(`A file of the themes folder is not a valid theme: ${parsed.errors[0] ?? ""}`);
      continue;
    }
    if (taken.has(parsed.theme.id)) {
      ignored.push(`The theme "${parsed.theme.id}" is left out: another theme already has that id`);
      continue;
    }
    taken.add(parsed.theme.id);
    themes.push(parsed.theme);
  }
  themes.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id, "en"),
  );
  return { themes, ignored };
}

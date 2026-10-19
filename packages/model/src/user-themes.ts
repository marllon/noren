import { parseTheme } from "./theme";
import type { Theme } from "./theme";
import { reservedThemeIds } from "./theme-derive";

// The themes of the user live in the folder `themes/` next to `config.jsonc`, one JSON file per
// theme (`themes/<id>.json`, the format of spec section 8). The backend lists and saves the text of
// the files; this module is the other half: what a file's text must be to count as a theme, and the
// text a theme is saved as.

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

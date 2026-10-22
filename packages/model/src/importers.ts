import { jsonProfiles, jsonSchemes, readJsonText } from "./import-json";
import type { ProfilesResult } from "./import-json";
import { keyValueSchemeColors, looksLikeKeyValue } from "./import-keyvalue";
import { parsePlist, plistSchemeColors } from "./import-plist";
import { claimIdentity, deriveTheme, reservedThemeIds } from "./theme-derive";
import type { SchemeColors } from "./theme-derive";
import { parseTheme } from "./theme";
import type { Theme } from "./theme";

// The importers: a file in one of the formats Noren reads becomes themes (or, for profiles, a
// list of shells). Everything here is pure and never throws; the file is read by the interface,
// which hands the text over, and a result that is not `ok` says why in sentences a person can read.
//
// The formats are told apart by what is in the file, not by its name (a file may have no extension):
//   - an XML property list (the `.itermcolors` files)
//   - JSON with comments: `{ "schemes": [...] }`, a list of schemes, or one scheme
//   - a theme of Noren itself, the JSON of a file of `themes/` (what "Export" writes), which is read
//     back whole instead of being derived from colors
//   - text with one `key = value` per line (`palette = 0=#1d1f21`, `background = #1d1f21`, ...)

export type ImportFormat = "plist" | "json" | "key-value";

/** The text of a color scheme or a settings file is a few kilobytes; a file past this is not one. */
export const MAX_IMPORT_CHARS = 1_000_000;

export const UNKNOWN_FORMAT_MESSAGE =
  'This file is not a color scheme Noren can read. It reads plist (.itermcolors), JSON and "key = value" text files.';

const FORMAT_LABEL: Readonly<Record<ImportFormat, string>> = {
  plist: "plist",
  json: "JSON",
  "key-value": "key-value",
};

/**
 * Which format the text is, from its content: `binary-plist` for a binary property list (which is
 * not read), `undefined` when it looks like none of them.
 */
export function detectFormat(text: string): ImportFormat | "binary-plist" | undefined {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const head = source.trimStart();
  if (head.startsWith("bplist")) return "binary-plist";
  if (/^<(\?xml|!doctype|plist|!--)/i.test(head)) return "plist";
  if (
    head.startsWith("{") ||
    head.startsWith("[") ||
    head.startsWith("//") ||
    head.startsWith("/*")
  ) {
    return "json";
  }
  if (looksLikeKeyValue(source)) return "key-value";
  return undefined;
}

export interface ImportOptions {
  /**
   * The name to give a scheme the file does not name (a plist or a key-value file never does):
   * usually the name of the file without its extension.
   */
  name?: string;
  /** Ids already in use (the themes the user has), which an imported theme must not take. */
  takenIds?: Iterable<string>;
}

export type ImportResult =
  | { ok: true; format: ImportFormat; themes: Theme[]; warnings: string[] }
  | { ok: false; errors: string[] };

interface ReadScheme {
  name: string;
  colors: SchemeColors;
}

function readSchemes(
  format: ImportFormat,
  text: string,
): { ok: true; schemes: ReadScheme[]; warnings: string[] } | { ok: false; errors: string[] } {
  if (format === "plist") {
    const plist = parsePlist(text);
    if (!plist.ok) return { ok: false, errors: [plist.error] };
    const colors = plistSchemeColors(plist.value);
    return colors.ok
      ? { ok: true, schemes: [{ name: "", colors: colors.colors }], warnings: [] }
      : colors;
  }
  if (format === "key-value") {
    const colors = keyValueSchemeColors(text);
    return colors.ok
      ? { ok: true, schemes: [{ name: "", colors: colors.colors }], warnings: colors.warnings }
      : colors;
  }
  const json = readJsonText(text);
  if (!json.ok) return json;
  return jsonSchemes(json.value);
}

/** A JSON object shaped like a file of `themes/`: it has the `ui` and `terminal` parts a color scheme of another program does not. */
function looksLikeThemeFile(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const part = (key: string): unknown =>
    Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
  const isObject = (x: unknown): boolean =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  return isObject(part("ui")) && isObject(part("terminal"));
}

/**
 * A theme exported from Noren (the file `themes/<id>.json` or the one "Export" writes) read back:
 * it is held to the whole schema, one that is not valid is refused with where it is wrong, and it
 * keeps everything it says (the font, the background, the radius). It keeps its id when no other
 * theme has it; otherwise it takes a new id and name like a copy does (`-2`, ` (2)`), the name the
 * notice then shows, so importing a file never replaces a theme of the person.
 */
function importThemeFile(value: Record<string, unknown>, taken: Set<string>): ImportResult {
  const parsed = parseTheme(value);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors.slice(0, 5).map((error) => `This theme file is not valid: ${error}`),
    };
  }
  const { theme } = parsed;
  if (!taken.has(theme.id)) {
    taken.add(theme.id);
    return { ok: true, format: "json", themes: [theme], warnings: [] };
  }
  const identity = claimIdentity(theme.name, "imported theme", taken);
  const renamed = parseTheme({ ...theme, id: identity.id, name: identity.name });
  if (!renamed.ok) return { ok: false, errors: renamed.errors };
  return { ok: true, format: "json", themes: [renamed.theme], warnings: [] };
}

function importSchemes(text: string, options: ImportOptions): ImportResult {
  if (text.length > MAX_IMPORT_CHARS) {
    return { ok: false, errors: ["This file is too large to be a color scheme"] };
  }
  const format = detectFormat(text);
  if (format === undefined) return { ok: false, errors: [UNKNOWN_FORMAT_MESSAGE] };
  if (format === "binary-plist") {
    return {
      ok: false,
      errors: ["This is a binary property list; export the XML form of the file and import that"],
    };
  }
  const taken = reservedThemeIds();
  for (const id of options.takenIds ?? []) taken.add(id);
  if (format === "json") {
    const json = readJsonText(text);
    if (json.ok && looksLikeThemeFile(json.value)) return importThemeFile(json.value, taken);
  }
  const read = readSchemes(format, text);
  if (!read.ok) return read;

  const fallback = `Imported ${FORMAT_LABEL[format]} scheme`;
  const themes: Theme[] = [];
  const warnings = [...read.warnings];
  for (const scheme of read.schemes) {
    const identity = claimIdentity(scheme.name || options.name || fallback, fallback, taken);
    const derived = deriveTheme(scheme.colors, identity.id, identity.name);
    if (derived.ok) {
      themes.push(derived.theme);
    } else {
      // Not expected (the readers check every color), but a theme that is not valid is never kept.
      taken.delete(identity.id);
      warnings.push(`"${identity.name}" is not a valid theme: ${derived.errors.join("; ")}`);
    }
  }
  if (themes.length === 0) return { ok: false, errors: warnings };
  return { ok: true, format, themes, warnings };
}

/**
 * The themes a file holds. A JSON file may hold several; the ones that are not valid are left out
 * with a warning, and the result is not `ok` only when none is. Each theme has an id that is a slug
 * of its name and is not one of the built-in themes, not in `takenIds` and not another theme of
 * this result. Never throws.
 */
export function importColorSchemes(text: string, options: ImportOptions = {}): ImportResult {
  try {
    return importSchemes(text, options);
  } catch {
    return { ok: false, errors: ["This file could not be read as a color scheme"] };
  }
}

/**
 * The shell profiles a JSON settings file lists, the hidden ones left out. Never throws. The
 * profiles are only read here; putting them in the list of profiles is another step.
 */
export function importProfiles(text: string): ProfilesResult {
  try {
    if (text.length > MAX_IMPORT_CHARS) {
      return { ok: false, errors: ["This file is too large to be a settings file"] };
    }
    const json = readJsonText(text);
    if (!json.ok) return json;
    return jsonProfiles(json.value);
  } catch {
    return { ok: false, errors: ["This file could not be read as a list of profiles"] };
  }
}

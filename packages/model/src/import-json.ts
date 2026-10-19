import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { normalizeColor } from "./theme-derive";
import type { SchemeColors } from "./theme-derive";

// Color schemes and shell profiles in a JSON file with comments and trailing commas, the shape of
// the settings file of a terminal: `schemes` is a list of objects with a name and the colors by
// name (`foreground`, `background`, `cursorColor`, `selectionBackground`, then `black`, `red`,
// `green`, `yellow`, `blue`, `purple`, `cyan`, `white` and the `bright` form of each), and
// `profiles` is a list (or an object with a `list`) of objects with a name and a command line. A
// file that is just one scheme, or a list of schemes, is read too. Never throws.

/** The color names in ANSI order, 0 to 15. `purple` is also written `magenta`. */
const ANSI_NAMES: readonly (readonly string[])[] = [
  ["black"],
  ["red"],
  ["green"],
  ["yellow"],
  ["blue"],
  ["purple", "magenta"],
  ["cyan"],
  ["white"],
  ["brightBlack"],
  ["brightRed"],
  ["brightGreen"],
  ["brightYellow"],
  ["brightBlue"],
  ["brightPurple", "brightMagenta"],
  ["brightCyan"],
  ["brightWhite"],
];

/** The most schemes (or profiles) read from one file; a settings file has a few dozen at most. */
const MAX_ENTRIES = 200;

/** Where an offset in `text` is, as `line 3, column 7`. */
function placeOf(text: string, offset: number): string {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let index = 0; index < end; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return `line ${line}, column ${end - lineStart + 1}`;
}

export type JsonTextResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

/** Reads JSON with comments and trailing commas. The first few syntax problems come back with their place. */
export function readJsonText(text: string): JsonTextResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const syntax: ParseError[] = [];
  const value: unknown = parse(source, syntax, { allowTrailingComma: true });
  if (syntax.length > 0) {
    return {
      ok: false,
      errors: syntax.slice(0, 5).map((error) => {
        const code = printParseErrorCode(error.error)
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .toLowerCase();
        return `${placeOf(source, error.offset)}: ${code.charAt(0).toUpperCase()}${code.slice(1)}`;
      }),
    };
  }
  return { ok: true, value };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property of a parsed object; the prototype chain is never read. */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** A scheme read from the file; `name` is empty when the file gives none. */
export interface JsonScheme {
  name: string;
  colors: SchemeColors;
}

function schemeOf(entry: unknown, position: string): { scheme?: JsonScheme; problems: string[] } {
  if (!isObject(entry)) return { problems: [`${position} is not an object`] };
  const nameValue = own(entry, "name");
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  const label = name !== "" ? `Scheme "${name}"` : position;
  const problems: string[] = [];

  const need = (key: string): string => {
    const raw = own(entry, key);
    const color = normalizeColor(raw);
    if (color === undefined) {
      problems.push(
        raw === undefined ? `${label}: "${key}" is missing` : `${label}: "${key}" is not a color`,
      );
    }
    return color ?? "#000000";
  };
  const foreground = need("foreground");
  const background = need("background");
  const ansi = ANSI_NAMES.map((names) => {
    const key = names.find((candidate) => own(entry, candidate) !== undefined) ?? names[0] ?? "";
    return need(key);
  });
  if (problems.length > 0) return { problems };

  return {
    scheme: {
      name,
      colors: {
        foreground,
        background,
        cursor: normalizeColor(own(entry, "cursorColor")),
        selection: normalizeColor(own(entry, "selectionBackground"), { alpha: true }),
        ansi,
      },
    },
    problems,
  };
}

export type JsonSchemesResult =
  { ok: true; schemes: JsonScheme[]; warnings: string[] } | { ok: false; errors: string[] };

/** The schemes of a JSON value already read: `{ schemes: [...] }`, a list of schemes, or one scheme. */
export function jsonSchemes(value: unknown): JsonSchemesResult {
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (isObject(value) && Array.isArray(own(value, "schemes"))) {
    entries = own(value, "schemes") as unknown[];
  } else if (
    isObject(value) &&
    own(value, "schemes") === undefined &&
    own(value, "background") !== undefined
  ) {
    entries = [value];
  } else if (
    isObject(value) &&
    own(value, "profiles") !== undefined &&
    own(value, "schemes") === undefined
  ) {
    return { ok: false, errors: ["This JSON file has profiles but no color schemes"] };
  } else {
    return { ok: false, errors: ["This JSON file has no color schemes"] };
  }

  const schemes: JsonScheme[] = [];
  const warnings: string[] = [];
  entries.slice(0, MAX_ENTRIES).forEach((entry, index) => {
    const read = schemeOf(entry, `Scheme ${index + 1}`);
    if (read.scheme !== undefined) schemes.push(read.scheme);
    else warnings.push(...read.problems);
  });
  if (entries.length > MAX_ENTRIES) {
    warnings.push(`Only the first ${MAX_ENTRIES} schemes were read`);
  }
  if (schemes.length === 0) {
    return {
      ok: false,
      errors: entries.length === 0 ? ["The list of color schemes is empty"] : warnings,
    };
  }
  return { ok: true, schemes, warnings };
}

/** A shell profile as the file describes it. What is not in the file is `null`. */
export interface ImportedProfile {
  name: string;
  /** The command that starts the shell, as written (arguments included). */
  commandLine: string | null;
  startingDirectory: string | null;
  /** The name of the color scheme the profile used. */
  colorScheme: string | null;
}

export type ProfilesResult =
  | { ok: true; profiles: ImportedProfile[]; hidden: number; warnings: string[] }
  | { ok: false; errors: string[] };

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The profiles of a JSON value already read: `profiles` is a list, or an object whose `list` is
 * one. A profile with `hidden: true` is left out (and counted), the way the program the file comes
 * from hides it. An entry with no name is left out with a warning.
 */
export function jsonProfiles(value: unknown): ProfilesResult {
  const holder = isObject(value) ? own(value, "profiles") : undefined;
  const list = Array.isArray(holder) ? holder : isObject(holder) ? own(holder, "list") : undefined;
  if (!Array.isArray(list))
    return { ok: false, errors: ["This JSON file has no list of profiles"] };

  const profiles: ImportedProfile[] = [];
  const warnings: string[] = [];
  let hidden = 0;
  list.slice(0, MAX_ENTRIES).forEach((entry, index) => {
    if (!isObject(entry)) {
      warnings.push(`Profile ${index + 1} is not an object, left out`);
      return;
    }
    if (own(entry, "hidden") === true) {
      hidden++;
      return;
    }
    const name = textOf(own(entry, "name"));
    if (name === null) {
      warnings.push(`Profile ${index + 1} has no name, left out`);
      return;
    }
    profiles.push({
      name,
      commandLine: textOf(own(entry, "commandline")),
      startingDirectory: textOf(own(entry, "startingDirectory")),
      colorScheme: textOf(own(entry, "colorScheme")),
    });
  });
  if (list.length > MAX_ENTRIES) warnings.push(`Only the first ${MAX_ENTRIES} profiles were read`);
  return { ok: true, profiles, hidden, warnings };
}

import { findNodeAtLocation, getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";
import type { Node as JsonNode, ParseError } from "jsonc-parser";
import { z } from "zod";
import { MAX_MODS, MOD_FILE_NAME_PATTERN, isReservedModName } from "./mods";
import { THEME_ID_PATTERN } from "./theme";
import { MAX_USER_PROFILES, RESERVED_PROFILE_IDS, UserProfileSchema } from "./user-profile-schema";

// The settings file `config.jsonc`: its schema, and reading its text. The file is JSON with
// comments and trailing commas (the person edits it by hand); everything is optional, so a file
// holds only what its owner wants different from the defaults. The defaults live where each
// setting is used, not here: a key that is missing means "not set here".
//
// `docs/config.schema.json` is generated from this schema (`pnpm --filter @noren/model config:schema`), and a test fails
// when the two drift apart.

/** Narrowest and widest the sidebar can be, in pixels. */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

/** An optional setting with the words the generated JSON Schema shows in an editor. */
const setting = <T extends z.ZodType>(schema: T, description: string, defaultValue: unknown) =>
  schema.optional().meta({ description, default: defaultValue });

const sidebarSchema = z
  .strictObject({
    position: setting(
      z.enum(["left", "right"]),
      "Which side of the window the sidebar is on.",
      "left",
    ),
    width: setting(
      z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
      "Width of the sidebar in pixels.",
      200,
    ),
    compact: setting(
      z.boolean(),
      "Compact mode: the sidebar leaves the layout and shows over it when the pointer touches the edge of the window.",
      false,
    ),
    keepOpen: setting(
      z.boolean(),
      "In compact mode, keeps the sidebar open instead of hiding it.",
      false,
    ),
  })
  .meta({ description: "The sidebar." });

/** The value of `appearance.theme` that follows the color scheme of the system, as a missing one does. */
export const SYSTEM_THEME = "system";

const appearanceSchema = z
  .strictObject({
    theme: setting(
      z.union([z.literal(SYSTEM_THEME), z.string().regex(THEME_ID_PATTERN)]),
      'The id of the theme, such as "noren-dusk". "system", or no value, follows the light or dark scheme of the system. An id Noren does not have also follows the system.',
      SYSTEM_THEME,
    ),
    sidebar: sidebarSchema.optional(),
    density: setting(
      z.enum(["comfortable", "compact"]),
      "How much room the rows of the sidebar take.",
      "comfortable",
    ),
    tabs: setting(
      z.enum(["sidebar", "top"]),
      "Where the tabs are: the tree in the sidebar, or a bar above the terminal.",
      "sidebar",
    ),
    paneHeaders: setting(
      z.boolean(),
      "Shows a header with the title and the buttons on every pane of a tab.",
      false,
    ),
  })
  .meta({ description: "How the window looks and is laid out." });

const MOD_NAME_MESSAGE =
  'Not a mod file name: letters, digits, ".", "_" and "-" (the first a letter or digit), ending in ".css", and not a device name such as "con"';

/** The mods turned on for every space, in the order they are applied. */
const modsSchema = z
  .array(
    z
      .string()
      .regex(MOD_FILE_NAME_PATTERN, { message: MOD_NAME_MESSAGE })
      .refine((name) => !isReservedModName(name), { message: MOD_NAME_MESSAGE }),
  )
  .max(MAX_MODS)
  .superRefine((names, context) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (seen.has(name)) {
        context.addIssue({
          code: "custom",
          message: `The mod "${name}" is listed twice`,
          path: [index],
        });
      }
      seen.add(name);
    });
  })
  .meta({
    description:
      'The CSS files of the mods folder (next to this file) that are turned on for every space, as file names such as "compact-tabs.css", in the order they are applied: the last one wins. A file that is not in the folder is ignored.',
  });

const notificationsSchema = z
  .strictObject({
    enabled: setting(z.boolean(), "Off: Noren never asks the system to show a notification.", true),
    longCommandSeconds: setting(
      z.number().min(0),
      "A command that runs longer than this many seconds notifies when it ends out of sight.",
      30,
    ),
  })
  .meta({ description: "System notifications." });

const keybindingsSchema = z
  .strictObject({
    preset: setting(
      z.enum(["safe", "browser"]),
      "Which set of shortcuts is in force: safe keeps the keys a shell uses, browser takes the keys of a web browser.",
      "safe",
    ),
  })
  .meta({ description: "Keyboard shortcuts." });

/** The shells of your own, which join the ones Noren finds on the machine. */
const profilesSchema = z
  .array(UserProfileSchema)
  .max(MAX_USER_PROFILES)
  .superRefine((profiles, context) => {
    const seen = new Set<string>();
    profiles.forEach((profile, index) => {
      if (RESERVED_PROFILE_IDS.includes(profile.id)) {
        context.addIssue({
          code: "custom",
          message: `The id "${profile.id}" is reserved`,
          path: [index, "id"],
        });
      } else if (seen.has(profile.id)) {
        context.addIssue({
          code: "custom",
          message: `The id "${profile.id}" is used by another profile`,
          path: [index, "id"],
        });
      }
      seen.add(profile.id);
    });
  })
  .meta({
    description:
      "Shell profiles of your own, listed in the command palette after the ones Noren finds on the machine. An id the machine already has is refused when the profiles are loaded.",
  });

export const ConfigSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .meta({ description: "Where the JSON Schema of this file is, for the editor." }),
    appearance: appearanceSchema.optional(),
    mods: modsSchema.optional(),
    profiles: profilesSchema.optional(),
    keybindings: keybindingsSchema.optional(),
    notifications: notificationsSchema.optional(),
  })
  .meta({
    title: "Noren settings",
    description: "The settings file of Noren (config.jsonc). Every setting is optional.",
  });

/** What a valid `config.jsonc` says. A setting the file does not mention is `undefined`. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * The JSON Schema of `config.jsonc`, in draft 7 (the one editors know best), describing what a
 * person may write: no setting is required.
 */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { target: "draft-7", io: "input" });
}

/** One thing wrong with the text of the file, with the place when it can be told. */
export interface ConfigError {
  /** What is wrong, in a sentence. */
  message: string;
  /** The setting it is about, such as `appearance.sidebar.position`; empty for the file as a whole. */
  path: string;
  /** Line of the problem in the text, from 1. Absent when the problem is not in the text (a failed read). */
  line?: number;
  /** Column of the problem in its line, from 1. */
  column?: number;
}

export type ParseConfigResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

/** Most problems reported for one text: a broken file can produce a flood after the first one. */
const MAX_ERRORS = 20;

/** `CloseBraceExpected` as `Close brace expected`. */
function words(codeName: string): string {
  const spaced = codeName.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** `appearance.sidebar.position`; a list index is written `[0]`. */
function describePath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (out, part) =>
      typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part),
    "",
  );
}

/** Where an offset in `text` is: line and column, both from 1. */
function placeOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

/** The node of the deepest part of `path` the text has, so a missing part points at its parent. */
function nodeNear(root: JsonNode, path: readonly (string | number)[]): JsonNode {
  for (let length = path.length; length > 0; length--) {
    const found = findNodeAtLocation(root, path.slice(0, length) as (string | number)[]);
    if (found) return found;
  }
  return root;
}

/** The name (the key) of `key` in the object at `objectPath`, when the text has it. */
function keyNode(root: JsonNode, objectPath: readonly (string | number)[], key: string) {
  const object = findNodeAtLocation(root, objectPath as (string | number)[]);
  for (const property of object?.children ?? []) {
    const name = property.children?.[0];
    if (name?.value === key) return name;
  }
  return undefined;
}

/**
 * Reads the text of `config.jsonc`. Never throws: a text that is not JSON with comments, a setting
 * of the wrong kind, out of its range or that the schema does not know comes back as
 * `{ ok: false, errors }`, each error with its line. An empty file, or one with only comments, is a
 * valid file that sets nothing.
 */
export function parseConfigText(text: string): ParseConfigResult {
  // A byte order mark (Notepad adds one) is not part of the text.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const syntax: ParseError[] = [];
  const root = parseTree(source, syntax, { allowTrailingComma: true, allowEmptyContent: true });

  if (syntax.length > 0) {
    return {
      ok: false,
      errors: syntax.slice(0, MAX_ERRORS).map((error) => ({
        message: words(printParseErrorCode(error.error)),
        path: "",
        ...placeOf(source, error.offset),
      })),
    };
  }
  // Nothing but whitespace and comments.
  if (root === undefined) return { ok: true, config: {} };

  const parsed = ConfigSchema.safeParse(getNodeValue(root));
  if (parsed.success) return { ok: true, config: parsed.data };

  const found: { offset: number; error: ConfigError }[] = [];
  const report = (offset: number, message: string, path: string) =>
    found.push({ offset, error: { message, path, ...placeOf(source, offset) } });
  for (const issue of parsed.error.issues) {
    const path = issue.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    );
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const at = keyNode(root, path, key) ?? nodeNear(root, path);
        report(at.offset, `Unknown setting "${key}"`, describePath([...path, key]));
      }
    } else {
      report(nodeNear(root, path).offset, issue.message, describePath(path));
    }
  }
  // In the order of the text, which is the order a person fixes them in.
  found.sort((a, b) => a.offset - b.offset);
  return { ok: false, errors: found.slice(0, MAX_ERRORS).map(({ error }) => error) };
}

/**
 * One line for a person: `line 4, column 7: appearance.sidebar.position: Invalid option: ...`.
 * The line is left out when the problem is not in the text.
 */
export function describeConfigError(error: ConfigError): string {
  const where = error.line !== undefined ? `line ${error.line}, column ${error.column ?? 1}: ` : "";
  const what = error.path !== "" ? `${error.path}: ${error.message}` : error.message;
  return where + what;
}

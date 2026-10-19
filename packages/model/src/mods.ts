import type { ModFile } from "./backend";

// Mods: CSS files of the user in the `mods/` folder next to `config.jsonc`. The folder is read by
// the backend (`listMods`); this file is the pure part that decides what a file must be to count, how
// its text is put in the cascade and which mods are in force for a space. Nothing here touches a
// document or a file.
//
// The cascade. The stylesheet of the app is one `@layer` of its own (`base`, and the CSS of the
// terminal library in `vendor` before it), and every mod is wrapped in `@layer mods`, declared after
// both. A rule in a later layer wins over a rule in an earlier one whatever its specificity, so a
// mod with a plain selector beats the app's style, and the mods win over each other in the order they
// are applied (the one applied last wins).

/** The layer every mod is wrapped in. */
export const MOD_LAYER = "mods";

/**
 * The statement that fixes the order of the layers, before any of them is used. The stylesheet of
 * the app starts with the same statement, and every mod repeats it, so the order holds whichever
 * of them the browser reads first.
 */
export const MOD_LAYER_ORDER = "@layer vendor, base, mods;";

/** The most mods listed, and the most a list of enabled mods may hold. */
export const MAX_MODS = 100;

/** The largest mod file read, in bytes. */
export const MAX_MOD_BYTES = 256 * 1024;

/** What a mod file name looks like: ASCII, a letter or digit first, `.css` in lower case last. */
export const MOD_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.css$/;

/** Device names Windows reserves; a file called `con.css` is the console there. */
const RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Whether the part of `name` before its first dot is a reserved device name, in any case. */
export function isReservedModName(name: string): boolean {
  return RESERVED_NAMES.has((name.split(".")[0] ?? "").toLowerCase());
}

/**
 * Whether `name` is the file name of a mod (the same rule as `is_valid_mod_file_name` in
 * `noren-core`): it becomes the id of the mod, so it is never a path and never a device name.
 */
export function isValidModFileName(name: unknown): name is string {
  return typeof name === "string" && MOD_FILE_NAME_PATTERN.test(name) && !isReservedModName(name);
}

/** The text of a mod ready for a style element, or why it cannot be used. */
export type WrapModResult = { ok: true; css: string } | { ok: false; reason: string };

/** The line (from 1) of the character at `offset` in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const isNameChar = (ch: string): boolean =>
  ch !== "" && (/[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80);
const isNewline = (ch: string): boolean => ch === "\n" || ch === "\r" || ch === "\f";

/**
 * The run of name characters and escapes that starts at `at`: where it ends and what it spells,
 * the escapes decoded (`\75 rl` spells `url`). CSS reads an escape as a letter of the name, which is
 * why a brace written as an escape is not a brace, and why `url(` can be written with escapes.
 */
function nameRun(source: string, at: number): { end: number; value: string } {
  let i = at;
  let value = "";
  while (i < source.length) {
    const ch = source.charAt(i);
    if (isNameChar(ch)) {
      value += ch;
      i++;
    } else if (ch === "\\" && i + 1 < source.length && !isNewline(source.charAt(i + 1))) {
      const hex = /^[0-9A-Fa-f]{1,6}/.exec(source.slice(i + 1, i + 7));
      if (hex === null) {
        value += source.charAt(i + 1);
        i += 2;
      } else {
        const code = Number.parseInt(hex[0], 16);
        const valid = code !== 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
        value += valid ? String.fromCodePoint(code) : "�";
        i += 1 + hex[0].length;
        // One white space after a hex escape belongs to it.
        if (source.startsWith("\r\n", i)) i += 2;
        else if (/[ \t\n\r\f]/.test(source.charAt(i))) i++;
      }
    } else {
      break;
    }
  }
  return { end: i, value };
}

/**
 * Where the address of a `url(` whose parenthesis is at `open` ends, just after its closing
 * parenthesis; `undefined` when the address is in quotes (a string, which the caller reads on its
 * own). CSS reads an address with no quotes as one token, so a brace inside it is not a brace.
 */
function afterUrlAddress(source: string, open: number): number | undefined {
  let i = open + 1;
  while (/\s/.test(source.charAt(i))) i++;
  if (source.charAt(i) === '"' || source.charAt(i) === "'") return undefined;
  while (i < source.length && source.charAt(i) !== ")") i += source.charAt(i) === "\\" ? 2 : 1;
  return i + 1;
}

/**
 * Puts the CSS of a mod in `@layer mods`. The wrapper is text, so the one thing that could take a
 * mod out of its layer is a `}` that closes the wrapper early. The text is read the way CSS reads
 * it: comments, strings, `url(...)` (written with escapes or not), names and escapes hide their
 * braces, and a mod with a closing brace that closes nothing is refused. That is enough: CSS
 * closes a block only with a brace that matches one it opened, and every `}` the reader counts is
 * one the browser can count too, so a text whose braces never close more than they open cannot end
 * the layer. A block the mod leaves open, a comment or a string it does not end is closed here, so
 * what follows in the wrapper stays where it belongs. Never throws.
 */
export function wrapModCss(text: string): WrapModResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let depth = 0;
  let inComment = false;
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (ch === "/" && source.charAt(i + 1) === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close < 0) {
        inComment = true;
        break;
      }
      i = close + 2;
    } else if (ch === '"' || ch === "'") {
      // A string ends at its quote, or at a line break that is not escaped.
      i++;
      while (i < source.length) {
        const inner = source.charAt(i);
        if (inner === "\\") i += 2;
        else if (inner === ch) {
          i++;
          break;
        } else if (inner === "\n" || inner === "\r" || inner === "\f") break;
        else i++;
      }
    } else if (ch === "#" || ch === "@") {
      // A hash or an at-keyword: the name after it is part of it, whatever it spells.
      i = nameRun(source, i + 1).end;
    } else if (isNameChar(ch) || ch === "\\") {
      const run = nameRun(source, i);
      if (run.end === i) {
        // A backslash before a line break escapes nothing.
        i++;
      } else if (run.value.toLowerCase() === "url" && source.charAt(run.end) === "(") {
        i = afterUrlAddress(source, run.end) ?? run.end + 1;
      } else {
        i = run.end;
      }
    } else if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) {
        return {
          ok: false,
          reason: `line ${lineAt(source, i)} has a "}" that closes nothing, which would end the mod's layer early`,
        };
      }
      i++;
    } else {
      i++;
    }
  }
  // What the mod left open is closed on a line of its own, before the brace of the wrapper.
  const tail = `${inComment ? "*/" : ""}\n${depth > 0 ? `${"}".repeat(depth)}\n` : ""}`;
  return {
    ok: true,
    css: `${MOD_LAYER_ORDER}\n@layer ${MOD_LAYER} {\n${source}${tail}}\n`,
  };
}

/** A mod that is in force: its file name and the CSS to put in a style element. */
export interface AppliedMod {
  readonly name: string;
  readonly css: string;
}

/** What the lists of mods come to for one space. */
export interface ModPlan {
  /** The mods to apply, in the order of the cascade: the last one wins. */
  readonly applied: readonly AppliedMod[];
  /** Names that are turned on but have no file in the mods folder (or are not a mod name at all). */
  readonly missing: readonly string[];
  /** Mods whose file cannot be used, with the reason. */
  readonly rejected: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * The mods in force: the global list, then the list of the space, so the space can override the
 * whole. A mod in both lists is applied once, where the later list puts it. A name with no file in
 * `files` is `missing` and a file that cannot be wrapped is `rejected`; neither stops the others.
 */
export function planMods(
  global: readonly string[],
  space: readonly string[],
  files: readonly ModFile[],
): ModPlan {
  // Keeping the last place of a name: walk backwards, and flip the result back.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...global, ...space].reverse()) {
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  names.reverse();

  const byName = new Map(files.map((file) => [file.name, file]));
  const applied: AppliedMod[] = [];
  const missing: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const name of names) {
    const file = isValidModFileName(name) ? byName.get(name) : undefined;
    if (file === undefined) {
      missing.push(name);
      continue;
    }
    const wrapped = wrapModCss(file.text);
    if (wrapped.ok) applied.push({ name, css: wrapped.css });
    else rejected.push({ name, reason: wrapped.reason });
  }
  return { applied, missing, rejected };
}

/** The sentences that tell a person what a plan left out; empty when it left nothing out. */
export function modWarnings(plan: ModPlan): string[] {
  return [
    ...plan.missing.map(
      (name) => `The mod "${name}" is turned on but is not in the mods folder, so it is ignored.`,
    ),
    ...plan.rejected.map(({ name, reason }) => `The mod "${name}" is ignored: ${reason}.`),
  ];
}

/** `list` with `name` turned on (added at the end, if it was not there) or off. */
export function withMod(list: readonly string[], name: string, on: boolean): string[] {
  if (!on) return list.filter((entry) => entry !== name);
  return list.includes(name) ? [...list] : [...list, name];
}

/** `list` with `name` moved `delta` places (negative: earlier); it stays where it is at an end. */
export function movedMod(list: readonly string[], name: string, delta: number): string[] {
  const from = list.indexOf(name);
  const next = [...list];
  if (from < 0) return next;
  const to = Math.min(Math.max(from + delta, 0), next.length - 1);
  next.splice(from, 1);
  next.splice(to, 0, name);
  return next;
}

/** The same names in the same order. */
export function sameModList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

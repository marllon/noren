import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";
import type { Node as JsonNode } from "jsonc-parser";
import { z } from "zod";
import { ConfigSchema } from "./config";

// Writing the settings file from the interface. The text is edited, never regenerated: a setting
// the file already has gets only its value replaced (`modify` and `applyEdits` of `jsonc-parser`),
// and a setting it does not have is inserted as a line of its own, so the comments, the blank
// lines, the order of the settings and the trailing commas of a file written by hand stay as they
// are. Pure: the file itself is read and written through the backend (see `ConfigManager.update`).
//
// A new setting is not left to `modify`'s own formatting: it formats every line it touches, which
// would move the comment at the end of the previous line onto the new setting and open up an
// object the person wrote on one line.

/** The place of a setting in the file: names, and the index of an item where the path goes through a list. */
export type ConfigPath = readonly (string | number)[];

/** A value a setting can hold (`null` is a setting that says "not set", such as no picture). */
export type ConfigValue = string | number | boolean | null;

/**
 * One setting to set, by its path in the file (`["appearance", "sidebar", "width"]`). A value that
 * is a list of names (`["mods"]`) replaces the list the file has, on one line: the comments
 * inside the old list go with it, the ones around it stay.
 */
export interface ConfigChange {
  readonly path: ConfigPath;
  readonly value: ConfigValue | readonly string[];
}

/** What a list in the file holds: JSON, with `undefined` standing for a key that is left out. */
export type ConfigJson =
  ConfigValue | readonly ConfigJson[] | { readonly [name: string]: ConfigJson | undefined };

/**
 * Items to add to the end of a list setting (`["profiles"]`), by its path in the file. The items
 * already in the list stay as they are; a list the file does not have yet is created with them.
 */
export interface ConfigAppend {
  readonly path: ConfigPath;
  readonly append: readonly ConfigJson[];
}

/**
 * A setting or a list item to take out of the file (`["profiles", 2]`, `["profiles", 0, "cwd"]`). What
 * is not in the file is left alone. Only the entry goes: the comments around it stay. Edits run in
 * order, so the indexes of the items after a removed one move down by one for the edits that follow.
 */
export interface ConfigRemove {
  readonly path: ConfigPath;
  readonly remove: true;
}

/** One edit of the file: a setting set to a value, items added to a list, or an entry taken out. */
export type ConfigEdit = ConfigChange | ConfigAppend | ConfigRemove;

type Shape = Record<string, z.ZodType>;

/**
 * The settings an object of the schema has, when `schema` is one (an optional one counts). The kinds
 * of a union of objects (the shell and the SSH profile) give the settings they have together, in an
 * order that keeps the order of each kind: a setting only one kind has goes after the setting that
 * comes before it in that kind.
 */
function shapeOf(schema: z.ZodType): Shape | undefined {
  let inner = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
  if (inner instanceof z.ZodObject) return inner.shape as Shape;
  if (!(inner instanceof z.ZodDiscriminatedUnion)) return undefined;
  const order: string[] = [];
  const merged: Shape = {};
  for (const option of inner.options) {
    if (!(option instanceof z.ZodObject)) continue;
    const shape = option.shape as Shape;
    let after = -1;
    for (const key of Object.keys(shape)) {
      const at = order.indexOf(key);
      if (at >= 0) {
        after = at;
      } else {
        after += 1;
        order.splice(after, 0, key);
        merged[key] = shape[key] as z.ZodType;
      }
    }
  }
  return Object.fromEntries(order.map((key) => [key, merged[key] as z.ZodType]));
}

/** The schema of the items of a list, when `schema` is one (an optional one counts). */
function itemOf(schema: z.ZodType): z.ZodType | undefined {
  let inner = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
  return inner instanceof z.ZodArray ? (inner.element as z.ZodType) : undefined;
}

/** The names of the settings of the object at `path`, in the order the schema lists them. */
function schemaOrder(path: ConfigPath): readonly string[] {
  let schema: z.ZodType = ConfigSchema;
  for (const key of path) {
    const next = typeof key === "number" ? itemOf(schema) : shapeOf(schema)?.[key];
    if (next === undefined) return [];
    schema = next;
  }
  return Object.keys(shapeOf(schema) ?? {});
}

/**
 * Where a new setting goes among the ones an object already has: before the first that the schema
 * lists after it, so a file grows in the order of the documentation. A setting the schema does not
 * list goes last.
 */
function insertionIndex(parentPath: ConfigPath, key: string, names: string[]): number {
  const order = schemaOrder(parentPath);
  const rankOf = (name: string): number => {
    const rank = order.indexOf(name);
    return rank < 0 ? Number.POSITIVE_INFINITY : rank;
  };
  const rank = rankOf(key);
  if (rank === Number.POSITIVE_INFINITY) return names.length;
  const later = names.findIndex((name) => rankOf(name) > rank);
  return later < 0 ? names.length : later;
}

/** What a group of new settings is made of: a value, a list, or settings by name. */
type Tree = ConfigJson;

/** `{ "appearance": { "sidebar": { "width": 300 } } }` for the path `appearance.sidebar.width`. */
function nest(path: ConfigPath, value: ConfigJson): Tree {
  const [first, ...rest] = path;
  if (first === undefined) return value;
  return { [first]: nest(rest, value) };
}

/** A list, as far as the type checker can tell (`Array.isArray` loses `readonly` lists). */
function isList(tree: Tree): tree is readonly ConfigJson[] {
  return Array.isArray(tree);
}

/** The settings of a group that have a value (a key left `undefined` is not written). */
function entriesOf(tree: {
  readonly [name: string]: ConfigJson | undefined;
}): [string, ConfigJson][] {
  return Object.entries(tree).filter(
    (entry): entry is [string, ConfigJson] => entry[1] !== undefined,
  );
}

/** On one line: `{ "width": 300 }`. */
function renderInline(tree: Tree): string {
  if (tree === null || typeof tree !== "object") return JSON.stringify(tree);
  if (isList(tree)) return `[${tree.map(renderInline).join(", ")}]`;
  const entries = entriesOf(tree).map(
    ([name, sub]) => `${JSON.stringify(name)}: ${renderInline(sub)}`,
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/**
 * One setting to a line, the groups opened over several lines, nested by `unit` from `indent`. A
 * list of plain values stays on one line (`["-NoLogo"]`); a list of groups opens, one group to
 * each item.
 */
function renderBlock(tree: Tree, indent: string, unit: string, eol: string): string {
  if (tree === null || typeof tree !== "object") return JSON.stringify(tree);
  const inner = indent + unit;
  if (isList(tree)) {
    if (tree.length === 0) return "[]";
    if (tree.every((item) => item === null || typeof item !== "object")) return renderInline(tree);
    const items = tree.map((item) => `${inner}${renderBlock(item, inner, unit, eol)}`);
    return `[${eol}${items.join(`,${eol}`)}${eol}${indent}]`;
  }
  const entries = entriesOf(tree).map(
    ([name, sub]) => `${inner}${JSON.stringify(name)}: ${renderBlock(sub, inner, unit, eol)}`,
  );
  return entries.length === 0 ? "{}" : `{${eol}${entries.join(`,${eol}`)}${eol}${indent}}`;
}

/** The indentation the file already uses for one level (two spaces when it has none to show). */
function detectUnit(text: string): string {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent === undefined) return "  ";
  return indent.startsWith("\t") ? "\t" : " ".repeat(Math.min(8, indent.length));
}

/** Start of the line `offset` is on. */
function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** The white space a line begins with. */
function leadingSpace(text: string, start: number): string {
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

/**
 * Where the line that ends at `from` finishes: the first line break after `from`, passing a comma,
 * spaces and comments on the way, and whether a comma was among them. `undefined` when something
 * else comes first (the next setting or the closing brace on the same line).
 */
function lineEndAfter(text: string, from: number): { at: number; comma: boolean } | undefined {
  let comma = false;
  let i = from;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === " " || ch === "\t") {
      i++;
    } else if (ch === ",") {
      comma = true;
      i++;
    } else if (ch === "\r" || ch === "\n") {
      return { at: i, comma };
    } else if (text.startsWith("//", i)) {
      // A line comment runs to the line break, which is where the line ends.
      const lf = text.indexOf("\n", i);
      const end = lf < 0 ? text.length : lf;
      return { at: end > i && text.charAt(end - 1) === "\r" ? end - 1 : end, comma };
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) return undefined;
      i = close + 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** Where a line of its own for a new setting goes, above the first setting and the comments over it. */
function startAboveComments(text: string, first: JsonNode, openAt: number): number | undefined {
  let start = lineStart(text, first.offset);
  if (text.slice(start, first.offset).trim() !== "") return undefined;
  const floor = lineStart(text, openAt);
  while (start > floor) {
    const before = lineStart(text, start - 1);
    if (before <= floor) break;
    const line = text.slice(before, start).trim();
    const isComment = line.startsWith("//") || (line.startsWith("/*") && line.endsWith("*/"));
    if (!isComment) break;
    start = before;
  }
  return start;
}

/**
 * Inserts the setting `name` (with `tree` as its value) into the object `parent`, in the place the
 * schema lists it. In an object written over several lines it takes a line of its own, indented like
 * the other settings; in one written on a single line it stays on that line.
 */
function insertInto(
  text: string,
  parent: JsonNode,
  parentPath: ConfigPath,
  name: string,
  tree: Tree,
  unit: string,
  eol: string,
): string {
  const props = parent.children ?? [];
  const names = props.map((prop) => String(prop.children?.[0]?.value));
  const index = insertionIndex(parentPath, name, names);
  const baseIndent = leadingSpace(text, lineStart(text, parent.offset));
  const opening = parent.offset + 1;
  const closing = parent.offset + parent.length - 1;
  const inline = (): string => `${JSON.stringify(name)}: ${renderInline(tree)}`;
  const block = (indent: string): string =>
    `${JSON.stringify(name)}: ${renderBlock(tree, indent, unit, eol)}`;

  const first = props[0];
  if (first === undefined) {
    // An empty object opens up when it holds nothing but space, else the setting follows the brace.
    const childIndent = baseIndent + unit;
    const inside = text.slice(opening, closing);
    if (inside.trim() === "") {
      const content = `${eol}${childIndent}${block(childIndent)}${eol}${baseIndent}`;
      return applyEdits(text, [{ offset: opening, length: inside.length, content }]);
    }
    return applyEdits(text, [
      { offset: opening, length: 0, content: `${eol}${childIndent}${block(childIndent)}` },
    ]);
  }

  const multiline = text.slice(opening, first.offset).includes("\n");
  const childIndent = multiline
    ? leadingSpace(text, lineStart(text, first.offset))
    : baseIndent + unit;

  if (multiline) {
    if (index === 0) {
      const start = startAboveComments(text, first, parent.offset);
      if (start !== undefined) {
        const content = `${childIndent}${block(childIndent)},${eol}`;
        return applyEdits(text, [{ offset: start, length: 0, content }]);
      }
    } else {
      // Under the line of the setting before it, which keeps its comment at the end of the line.
      const previous = props[index - 1] as JsonNode;
      const next = props[index];
      const previousEnd = previous.offset + previous.length;
      const ends = lineEndAfter(text, previousEnd);
      if (ends !== undefined && ends.at <= (next?.offset ?? closing)) {
        const trailingComma = ends.comma || next !== undefined;
        const line = `${eol}${childIndent}${block(childIndent)}${trailingComma ? "," : ""}`;
        const withLine = applyEdits(text, [{ offset: ends.at, length: 0, content: line }]);
        // The setting before it had no comma yet: it has one now that something follows it.
        return ends.comma
          ? withLine
          : applyEdits(withLine, [{ offset: previousEnd, length: 0, content: "," }]);
      }
    }
  }

  // On one line with the others.
  const next = props[index];
  if (next !== undefined) {
    return applyEdits(text, [{ offset: next.offset, length: 0, content: `${inline()}, ` }]);
  }
  const last = props[props.length - 1] as JsonNode;
  return applyEdits(text, [
    { offset: last.offset + last.length, length: 0, content: `, ${inline()}` },
  ]);
}

/**
 * Adds `items` after the last item of the list `array`, each on a line of its own when the list is
 * written over several lines (indented like the items it has, under the line of the last one, so a
 * comment at the end of that line stays with it), else on the same line. A trailing comma the list
 * has is kept, and one it lacks is not added.
 */
function appendInto(
  text: string,
  array: JsonNode,
  items: readonly ConfigJson[],
  unit: string,
  eol: string,
): string {
  const elements = array.children ?? [];
  const baseIndent = leadingSpace(text, lineStart(text, array.offset));
  const opening = array.offset + 1;
  const closing = array.offset + array.length - 1;
  const first = elements[0];

  if (first === undefined) {
    // An empty list opens up when it holds nothing but space, else the items follow the bracket.
    const childIndent = baseIndent + unit;
    const lines = items
      .map((item) => `${childIndent}${renderBlock(item, childIndent, unit, eol)}`)
      .join(`,${eol}`);
    const inside = text.slice(opening, closing);
    if (inside.trim() === "") {
      return applyEdits(text, [
        { offset: opening, length: inside.length, content: `${eol}${lines}${eol}${baseIndent}` },
      ]);
    }
    return applyEdits(text, [{ offset: opening, length: 0, content: `${eol}${lines}` }]);
  }

  const last = elements[elements.length - 1] as JsonNode;
  const lastEnd = last.offset + last.length;
  const multiline = text.slice(opening, first.offset).includes("\n");
  if (multiline) {
    const childIndent = leadingSpace(text, lineStart(text, first.offset));
    const ends = lineEndAfter(text, lastEnd);
    if (ends !== undefined && ends.at <= closing) {
      const lines = items
        .map(
          (item, index) =>
            `${eol}${childIndent}${renderBlock(item, childIndent, unit, eol)}${
              ends.comma || index < items.length - 1 ? "," : ""
            }`,
        )
        .join("");
      const withLines = applyEdits(text, [{ offset: ends.at, length: 0, content: lines }]);
      // The item before them had no comma yet: it has one now that something follows it.
      return ends.comma
        ? withLines
        : applyEdits(withLines, [{ offset: lastEnd, length: 0, content: "," }]);
    }
  }
  // On one line with the others.
  return applyEdits(text, [
    { offset: lastEnd, length: 0, content: `, ${items.map(renderInline).join(", ")}` },
  ]);
}

/** One list edit applied to `text` (without a byte order mark). */
function applyAppend(text: string, edit: ConfigAppend, unit: string, eol: string): string {
  if (edit.append.length === 0) return text;
  const root = parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true });
  // No file yet, or only comments: the list goes after them.
  if (root === undefined) return applyChange(text, edit.path, edit.append, unit, eol);
  if (root.type !== "object") throw new Error("the settings file does not hold an object");
  const list = findNodeAtLocation(root, [...edit.path]);
  // A list the file lacks is created, with the items in it.
  if (list === undefined) return applyChange(text, edit.path, edit.append, unit, eol);
  if (list.type !== "array") throw new Error(`${edit.path.join(".")} is not a list`);
  return appendInto(text, list, edit.append, unit, eol);
}

/** Whether a part of a path is the index of a list item. */
const isIndex = (part: string | number): boolean => typeof part === "number";

/**
 * One removal applied to `text` (without a byte order mark): the setting or list item at `path`
 * goes, with the comma that separated it. `modify` takes out the entry alone, so the comments on
 * the lines around it stay. What the text does not have is not an error.
 */
function applyRemove(text: string, path: ConfigPath): string {
  const root = parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true });
  if (root === undefined) return text;
  if (root.type !== "object") throw new Error("the settings file does not hold an object");
  const value = findNodeAtLocation(root, [...path]);
  if (value === undefined) return text;
  // The entry is the whole `"name": value` of a setting, or the item of a list.
  const entry = value.parent?.type === "property" ? value.parent : value;
  const siblings = entry.parent?.children ?? [];
  const start = lineStart(text, entry.offset);
  const ends = lineEndAfter(text, entry.offset + entry.length);
  if (text.slice(start, entry.offset).trim() === "" && ends !== undefined) {
    // An entry that has its own lines goes whole, with the comment at the end of its last line.
    let end = ends.at;
    if (text.startsWith("\r\n", end)) end += 2;
    else if (text.startsWith("\n", end)) end += 1;
    let result = applyEdits(text, [{ offset: start, length: end - start, content: "" }]);
    // The last entry took the end of the list with it: the one before it must not keep a comma
    // the file did not have after its own last entry.
    const index = siblings.indexOf(entry);
    const previous = index > 0 ? siblings[index - 1] : undefined;
    if (previous !== undefined && index === siblings.length - 1 && !ends.comma) {
      const after = previous.offset + previous.length;
      const comma = /^[ \t]*,/.exec(result.slice(after));
      if (comma !== null) {
        result = applyEdits(result, [{ offset: after, length: comma[0].length, content: "" }]);
      }
    }
    return result;
  }
  return applyEdits(text, modify(text, [...path], undefined, {}));
}

/** One change applied to `text` (without a byte order mark): `value` is put at `path`. */
function applyChange(
  text: string,
  path: ConfigPath,
  value: ConfigJson,
  unit: string,
  eol: string,
): string {
  const root = parseTree(text, [], { allowTrailingComma: true, allowEmptyContent: true });

  if (root === undefined) {
    // No file yet, or only comments: the object goes after them.
    if (path.some((part) => typeof part === "number")) {
      throw new Error(`${path.join(".")} is not in the settings file`);
    }
    const object = renderBlock(nest(path, value), "", unit, eol);
    const lead = text === "" || text.endsWith("\n") ? "" : eol;
    return `${text}${lead}${object}${eol}`;
  }
  if (root.type !== "object") throw new Error("the settings file does not hold an object");

  // The setting is there already: only its value changes.
  const existing = findNodeAtLocation(root, [...path]);
  if (existing !== undefined) {
    if (isList(value)) {
      // A whole list is written the way a new one is, so it reads the same wherever it comes from.
      const indent = leadingSpace(text, lineStart(text, existing.offset));
      const content = renderBlock(value, indent, unit, eol);
      return applyEdits(text, [{ offset: existing.offset, length: existing.length, content }]);
    }
    return applyEdits(text, modify(text, [...path], value, {}));
  }

  // Else the first part of the path the file lacks goes into the deepest group it has.
  let depth = 0;
  let parent = root;
  for (; depth < path.length - 1; depth++) {
    const next = findNodeAtLocation(root, path.slice(0, depth + 1) as (string | number)[]);
    if (next === undefined) break;
    parent = next;
  }
  const name = path[depth];
  // A setting is inserted into an object; an item of a list that is not there cannot be.
  if (typeof name !== "string" || parent.type !== "object" || path.slice(depth).some(isIndex)) {
    throw new Error(`${path.join(".")} is not in the settings file`);
  }
  return insertInto(
    text,
    parent,
    path.slice(0, depth),
    name,
    nest(path.slice(depth + 1), value),
    unit,
    eol,
  );
}

/**
 * The text of `config.jsonc` with `changes` made, in order. `text` is the file as it is (`null`:
 * there is no file yet, and the result is a new one) and must be a valid file (`parseConfigText`).
 * A setting the text holds has only its value replaced; a new one is inserted where the schema
 * lists it, creating the groups it sits in. Items to append are added after the last item of the
 * list (the list is created when the text lacks it). An entry to remove (a setting, or an item of a
 * list by its index) is taken out alone. Whatever else the text holds is left as it is.
 */
export function editConfigText(text: string | null, changes: readonly ConfigEdit[]): string {
  const source = text ?? "";
  const bom = source.charCodeAt(0) === 0xfeff ? "﻿" : "";
  let edited = bom === "" ? source : source.slice(1);
  const eol = edited.includes("\r\n") ? "\r\n" : "\n";
  const unit = detectUnit(edited);
  for (const change of changes) {
    if (change.path.length === 0) continue;
    edited =
      "remove" in change
        ? applyRemove(edited, change.path)
        : "append" in change
          ? applyAppend(edited, change, unit, eol)
          : applyChange(edited, change.path, change.value, unit, eol);
  }
  return bom + edited;
}

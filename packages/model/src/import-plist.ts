import { normalizeColor } from "./theme-derive";
import type { SchemeColors } from "./theme-derive";

// Color schemes in an XML property list (the `.itermcolors` files). The reader below covers the
// part of the format those files use (dict, array, key, string, real, integer, true, false, data and
// date), with no dependency, and never throws: a text that is not a property list, is nested too
// deep or is too big is a `{ ok: false }`. A binary property list is told apart (it starts with
// `bplist`) so the message can say to export the XML one.

/** A value of a property list. A dictionary is a `Map`, so a key such as `__proto__` is only a key. */
export type PlistValue = string | number | boolean | PlistValue[] | Map<string, PlistValue>;

/** Deepest nesting the reader follows. A color file is three levels deep. */
const MAX_DEPTH = 24;

class PlistError extends Error {}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/** A reader over the text: what is left is read from `position` on. */
class Reader {
  position = 0;

  constructor(readonly text: string) {}

  /** Skips blanks, comments, the `<?xml ?>` line and the `<!DOCTYPE>` line. */
  skipMisc(): void {
    for (;;) {
      while (this.position < this.text.length && /\s/.test(this.text.charAt(this.position))) {
        this.position++;
      }
      if (this.text.startsWith("<!--", this.position)) {
        const end = this.text.indexOf("-->", this.position + 4);
        if (end < 0) throw new PlistError("an XML comment is never closed");
        this.position = end + 3;
      } else if (this.text.startsWith("<?", this.position)) {
        const end = this.text.indexOf("?>", this.position + 2);
        if (end < 0) throw new PlistError("an XML declaration is never closed");
        this.position = end + 2;
      } else if (this.text.startsWith("<!DOCTYPE", this.position)) {
        // A DOCTYPE with an internal subset (`[ ... ]`) is skipped whole; nothing in it is expanded.
        const open = this.text.indexOf("[", this.position);
        const close = this.text.indexOf(">", this.position);
        if (close < 0) throw new PlistError("the DOCTYPE is never closed");
        if (open >= 0 && open < close) {
          const end = this.text.indexOf("]>", open);
          if (end < 0) throw new PlistError("the DOCTYPE is never closed");
          this.position = end + 2;
        } else {
          this.position = close + 1;
        }
      } else {
        return;
      }
    }
  }

  atEnd(): boolean {
    this.skipMisc();
    return this.position >= this.text.length;
  }

  /** The tag at the cursor (an opening, a closing or a self-closing one), after any blanks. */
  tag(): Tag {
    this.skipMisc();
    if (this.text.charAt(this.position) !== "<") {
      throw new PlistError("expected an XML tag");
    }
    const end = this.text.indexOf(">", this.position);
    if (end < 0) throw new PlistError("a tag is never closed");
    const body = this.text.slice(this.position + 1, end);
    this.position = end + 1;
    const match = /^(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)$/.exec(body);
    if (match === null) throw new PlistError("an XML tag is not readable");
    return {
      name: (match[2] ?? "").toLowerCase(),
      closing: match[1] === "/",
      selfClosing: match[3] === "/",
    };
  }

  /** The text up to the next `<`, with the entities decoded. */
  content(): string {
    const end = this.text.indexOf("<", this.position);
    if (end < 0) throw new PlistError("an element is never closed");
    const raw = this.text.slice(this.position, end);
    this.position = end;
    return decodeEntities(raw);
  }

  /** The closing tag of `name`, which must be next. */
  close(name: string): void {
    const tag = this.tag();
    if (!tag.closing || tag.name !== name) throw new PlistError(`expected </${name}>`);
  }
}

function readLeaf(reader: Reader, name: string, tag: Tag): string {
  if (tag.selfClosing) return "";
  const text = reader.content();
  reader.close(name);
  return text;
}

function readValue(reader: Reader, depth: number): PlistValue {
  if (depth > MAX_DEPTH) throw new PlistError("the property list is nested too deep");
  const tag = reader.tag();
  if (tag.closing) throw new PlistError(`unexpected </${tag.name}>`);
  switch (tag.name) {
    case "dict": {
      const dict = new Map<string, PlistValue>();
      if (tag.selfClosing) return dict;
      for (;;) {
        const next = reader.tag();
        if (next.closing && next.name === "dict") return dict;
        if (next.closing || next.name !== "key")
          throw new PlistError("expected a <key> in a <dict>");
        const key = readLeaf(reader, "key", next).trim();
        dict.set(key, readValue(reader, depth + 1));
      }
    }
    case "array": {
      const list: PlistValue[] = [];
      if (tag.selfClosing) return list;
      for (;;) {
        // An array ends at its closing tag; anything else is a value.
        const before = reader.position;
        const next = reader.tag();
        if (next.closing && next.name === "array") return list;
        reader.position = before;
        list.push(readValue(reader, depth + 1));
      }
    }
    case "string":
    case "data":
    case "date":
      return readLeaf(reader, tag.name, tag);
    case "integer":
    case "real": {
      const text = readLeaf(reader, tag.name, tag).trim();
      const number = Number(text);
      if (text === "" || !Number.isFinite(number))
        throw new PlistError(`"${text}" is not a number`);
      return number;
    }
    case "true":
    case "false":
      if (!tag.selfClosing) reader.close(tag.name);
      return tag.name === "true";
    default:
      throw new PlistError(`<${tag.name}> is not part of a property list`);
  }
}

export type ParsePlistResult = { ok: true; value: PlistValue } | { ok: false; error: string };

/** Reads an XML property list. Never throws. */
export function parsePlist(text: string): ParsePlistResult {
  try {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (source.startsWith("bplist")) {
      return {
        ok: false,
        error: "This is a binary property list; export the XML form of the file and import that",
      };
    }
    const reader = new Reader(source);
    const first = reader.tag();
    if (first.closing || first.name !== "plist") {
      return { ok: false, error: "This is not a property list (no <plist> element)" };
    }
    const value = first.selfClosing ? new Map<string, PlistValue>() : readValue(reader, 0);
    if (!first.selfClosing) reader.close("plist");
    if (!reader.atEnd()) return { ok: false, error: "There is more after the </plist> element" };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof PlistError)
      return { ok: false, error: `Not a readable property list: ${error.message}` };
    return { ok: false, error: "Not a readable property list" };
  }
}

/** The names of the sixteen ANSI colors in a plist color scheme, index 0 to 15. */
const ANSI_KEYS = Array.from({ length: 16 }, (_, index) => `Ansi ${index} Color`);

function component(color: Map<string, PlistValue>, key: string): number | undefined {
  const value = color.get(key);
  return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

/** A color entry (`Red Component`, `Green Component`, `Blue Component`, 0 to 1) as `#rrggbb`. */
function colorOf(entry: PlistValue | undefined, alpha: boolean): string | undefined {
  if (!(entry instanceof Map)) return undefined;
  const parts = ["Red Component", "Green Component", "Blue Component"].map((key) =>
    component(entry, key),
  );
  if (parts.some((part) => part === undefined)) return undefined;
  const hex = parts
    .map((part) =>
      Math.round((part ?? 0) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  // The alpha of the selection color is kept when the file says the color is see-through.
  const opacity = component(entry, "Alpha Component");
  if (alpha && opacity !== undefined && opacity < 1) {
    return `#${hex}${Math.round(opacity * 255)
      .toString(16)
      .padStart(2, "0")}`;
  }
  return normalizeColor(`#${hex}`);
}

export type PlistSchemeResult =
  { ok: true; colors: SchemeColors } | { ok: false; errors: string[] };

/**
 * The colors of a plist color scheme. The color space the file names is not converted (the
 * components are read as sRGB), which is what makes a color differ a little between programs.
 * The sixteen ANSI colors, the foreground and the background are required; the cursor and the
 * selection are used when the file has them.
 */
export function plistSchemeColors(value: PlistValue): PlistSchemeResult {
  if (!(value instanceof Map)) {
    return { ok: false, errors: ["The property list is not a dictionary of colors"] };
  }
  const errors: string[] = [];
  const need = (key: string, alpha = false): string => {
    const color = colorOf(value.get(key), alpha);
    if (color === undefined) {
      errors.push(
        value.has(key)
          ? `"${key}" is not a color (red, green and blue components from 0 to 1)`
          : `"${key}" is missing`,
      );
    }
    return color ?? "#000000";
  };
  const ansi = ANSI_KEYS.map((key) => need(key));
  const foreground = need("Foreground Color");
  const background = need("Background Color");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    colors: {
      foreground,
      background,
      cursor: colorOf(value.get("Cursor Color"), false),
      selection: colorOf(value.get("Selection Color"), true),
      ansi,
    },
  };
}

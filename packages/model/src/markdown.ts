// A small Markdown parser for the answers of the AI. It reads only what a chat answer is made of:
// paragraphs, headings (`#`), lists (`-`, `*`, `+`, `1.`), **strong**, *emphasis*, `inline code` and
// fenced code blocks (``` or ~~~, with a language). Everything else stays what it was typed: a link,
// a table, a quote or a line of HTML is plain text. The result is a tree of data with no markup in
// it: the interface turns it into React elements, so the text of the model can never become HTML.
// Pure; it never throws, and it runs in time proportional to the text (a work budget stops the
// formatting of a text built to be slow, and the rest of that text is shown as it is).
//
// It is made for answers that arrive in pieces: a code block whose fence has not closed yet is a
// code block with `open: true`, and a `**` or a backtick that has no partner yet is plain text until
// the partner arrives.

/** The inline parts of a line of text. */
export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; text: string };

/** A fenced code block: the text between the fences, exactly, with no line break at the end. */
export interface MdCode {
  type: "code";
  /** The word after the opening fence when it is a plain name (`sh`, `c++`), else empty. */
  lang: string;
  text: string;
  /** The closing fence has not come: the answer is still being written (or ended inside the block). */
  open: boolean;
}

export type MdBlock =
  | { type: "paragraph"; children: MdInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdInline[] }
  /** `start` is the number of the first item of an ordered list; each item is a list of blocks. */
  | { type: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | MdCode;

/** Emphasis inside emphasis stops here; deeper marks are plain text. */
const MAX_NESTING = 4;

/** Steps the inline scanner may take in one paragraph, per character of it, plus a floor. */
const WORK_PER_CHAR = 24;
const WORK_FLOOR = 2000;

/** The longest language name kept from a fence. */
const MAX_LANG = 32;

interface Budget {
  left: number;
}

const isSpace = (char: string | undefined): boolean => char === undefined || /\s/.test(char);

// ---------------------------------------------------------------------------------------------
// Inline

/** How many times `char` repeats from `at`. */
function runLength(text: string, at: number, char: string): number {
  let end = at;
  while (text[end] === char) end++;
  return end - at;
}

/** Where a run of exactly `size` backticks starts, from `from` on; -1 when there is none. */
function findBacktickRun(text: string, from: number, size: number, budget: Budget): number {
  let at = from;
  while (at < text.length) {
    budget.left--;
    if (budget.left <= 0) return -1;
    const found = text.indexOf("`", at);
    if (found < 0) return -1;
    const run = runLength(text, found, "`");
    if (run === size) return found;
    at = found + run;
  }
  return -1;
}

/** The text of a code span: line breaks become spaces, and one space on each side is dropped. */
function codeSpanText(raw: string): string {
  const flat = raw.replace(/\n/g, " ");
  return flat.length >= 2 && flat.startsWith(" ") && flat.endsWith(" ") && flat.trim() !== ""
    ? flat.slice(1, -1)
    : flat;
}

/**
 * Where the mark that closes an emphasis opened before `from` is: the index of its first `*` (of
 * `marker` stars). A closer follows a character that is not a space, a `*` pair inside an `*`
 * emphasis is skipped as a whole, and a code span is skipped. -1 when nothing closes it.
 */
function findCloser(text: string, from: number, marker: 1 | 2, budget: Budget): number {
  let at = from;
  while (at < text.length) {
    budget.left--;
    if (budget.left <= 0) return -1;
    const char = text[at];
    if (char === "\\" && (text[at + 1] === "*" || text[at + 1] === "`")) {
      at += 2;
    } else if (char === "`") {
      const size = runLength(text, at, "`");
      const close = findBacktickRun(text, at + size, size, budget);
      at = close >= 0 ? close + size : at + size;
    } else if (char === "*") {
      const size = runLength(text, at, "*");
      const afterText = !isSpace(text[at - 1]);
      if (marker === 2) {
        if (size >= 2 && afterText) return at + size - 2;
        at += size;
      } else if (size === 1) {
        if (afterText) return at;
        at += 1;
      } else {
        // A strong pair inside the emphasis belongs to itself; a lone run of stars is skipped.
        const inner = !isSpace(text[at + 2]) ? findCloser(text, at + 2, 2, budget) : -1;
        at = inner >= 0 ? inner + 2 : at + size;
      }
    } else {
      at++;
    }
  }
  return -1;
}

function parseInline(text: string, budget: Budget, depth: number): MdInline[] {
  const out: MdInline[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push({ type: "text", text: plain });
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    budget.left--;
    if (budget.left <= 0) {
      plain += text.slice(at);
      break;
    }
    const char = text[at] as string;
    if (char === "\\" && (text[at + 1] === "*" || text[at + 1] === "`")) {
      plain += text[at + 1];
      at += 2;
    } else if (char === "`") {
      const size = runLength(text, at, "`");
      const close = findBacktickRun(text, at + size, size, budget);
      if (close >= 0) {
        flush();
        out.push({ type: "code", text: codeSpanText(text.slice(at + size, close)) });
        at = close + size;
      } else {
        plain += "`".repeat(size);
        at += size;
      }
    } else if (char === "*" && depth < MAX_NESTING) {
      const size = runLength(text, at, "*");
      const marker: 1 | 2 = size >= 2 && !isSpace(text[at + 2]) ? 2 : 1;
      const open = at + marker;
      // The opener needs text right after it that is not a space; a lone `*` between spaces is plain.
      const closer = isSpace(text[open]) ? -1 : findCloser(text, open + 1, marker, budget);
      if (closer >= 0) {
        flush();
        const children = parseInline(text.slice(open, closer), budget, depth + 1);
        out.push({ type: marker === 2 ? "strong" : "em", children });
        at = closer + marker;
      } else {
        plain += "*".repeat(size);
        at += size;
      }
    } else {
      plain += char;
      at++;
    }
  }
  flush();
  return out;
}

/** The inline parts of `text` (a paragraph, a heading or an item, line breaks kept as `\n`). */
function inlineOf(text: string): MdInline[] {
  const budget: Budget = { left: Math.max(WORK_FLOOR, text.length * WORK_PER_CHAR) };
  return parseInline(text, budget, 0);
}

// ---------------------------------------------------------------------------------------------
// Blocks

const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

interface Fence {
  indent: number;
  char: string;
  size: number;
  lang: string;
}

/** The opening fence a line makes, if it is one. A backtick fence cannot hold a backtick in its info string. */
function openingFence(line: string): Fence | undefined {
  const match = FENCE.exec(line);
  if (match === null) return undefined;
  const [, indent = "", fence = "", info = ""] = match;
  const char = fence.charAt(0);
  if (char === "`" && info.includes("`")) return undefined;
  const word = info.trim().split(/\s+/, 1)[0] ?? "";
  const lang = /^[\w+#.-]+$/.test(word) && word.length <= MAX_LANG ? word : "";
  return { indent: indent.replace(/\t/g, "    ").length, char, size: fence.length, lang };
}

/** Whether `line` closes the fence `open`: the same character, at least as many, and nothing else. */
function closesFence(line: string, open: Fence): boolean {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  const fence = match?.[1];
  return fence !== undefined && fence.charAt(0) === open.char && fence.length >= open.size;
}

/** Whether `line` is only some of the characters of a closing fence of `open`, not yet enough to close it. */
function isPartOfFence(line: string | undefined, open: Fence): boolean {
  const trimmed = line?.trim() ?? "";
  return trimmed !== "" && trimmed.length < open.size && [...trimmed].every((c) => c === open.char);
}

/** A line of a code block without the indent the fence had (at most that much). */
function dedent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && (line[cut] === " " || line[cut] === "\t")) cut++;
  return line.slice(cut);
}

interface OpenList {
  ordered: boolean;
  start: number;
  items: MdBlock[][];
  /** The lines of the paragraph the last item is writing, joined when it ends. */
  lines: string[];
}

/** Turns Markdown text into blocks. Does not throw. */
export function parseMarkdown(source: string): MdBlock[] {
  try {
    return parseBlocks(source);
  } catch {
    // Not expected; the text is still shown, as it is.
    return [{ type: "paragraph", children: [{ type: "text", text: source }] }];
  }
}

function parseBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let list: OpenList | undefined;
  // A blank line was seen since the last item or text line of the list.
  let gap = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", children: inlineOf(paragraph.join("\n")) });
    }
    paragraph = [];
  };
  const flushItemText = () => {
    if (list === undefined || list.lines.length === 0) return;
    list.items[list.items.length - 1]?.push({
      type: "paragraph",
      children: inlineOf(list.lines.join("\n")),
    });
    list.lines = [];
  };
  const closeList = () => {
    if (list === undefined) return;
    flushItemText();
    blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items });
    list = undefined;
    gap = false;
  };

  let at = 0;
  while (at < lines.length) {
    const line = lines[at] as string;
    const fence = openingFence(line);
    // A fence indented under an item belongs to it; any other fence is a block of its own.
    if (fence !== undefined) {
      if (list !== undefined && fence.indent < 2) closeList();
      const body: string[] = [];
      let closed = false;
      at++;
      while (at < lines.length) {
        const inner = lines[at] as string;
        at++;
        if (closesFence(inner, fence)) {
          closed = true;
          break;
        }
        body.push(dedent(inner, fence.indent));
      }
      // The closing fence may have arrived in part (`` of ```): it is not code, and it would flash
      // in the block until the rest comes.
      if (!closed && isPartOfFence(body[body.length - 1], fence)) body.pop();
      const code: MdCode = { type: "code", lang: fence.lang, text: body.join("\n"), open: !closed };
      if (list !== undefined) {
        flushItemText();
        list.items[list.items.length - 1]?.push(code);
        gap = false;
      } else {
        flushParagraph();
        blocks.push(code);
      }
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushItemText();
      if (list !== undefined) gap = true;
      at++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null && (heading[2] ?? "") !== "") {
      flushParagraph();
      closeList();
      blocks.push({
        type: "heading",
        level: (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6,
        children: inlineOf(heading[2] as string),
      });
      at++;
      continue;
    }

    const item = ITEM.exec(line);
    if (item !== null && (item[1] ?? "").length < 4) {
      const marker = item[2] as string;
      const ordered = /\d/.test(marker);
      flushParagraph();
      if (list !== undefined && list.ordered !== ordered) closeList();
      if (list === undefined) {
        list = {
          ordered,
          start: ordered ? Number.parseInt(marker, 10) : 1,
          items: [],
          lines: [],
        };
      }
      flushItemText();
      list.items.push([]);
      const text = (item[3] ?? "").trim();
      if (text !== "") list.lines.push(text);
      gap = false;
      at++;
      continue;
    }

    // A plain line. Inside a list it goes on with the item, unless a blank line came first and the
    // line is not indented under it; otherwise it starts or goes on with a paragraph.
    if (list !== undefined && (!gap || /^(?: {2,}|\t)/.test(line))) {
      if (gap) flushItemText();
      list.lines.push(line.trim());
      gap = false;
      at++;
      continue;
    }
    closeList();
    paragraph.push(line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""));
    at++;
  }
  flushParagraph();
  closeList();
  return blocks;
}

// ---------------------------------------------------------------------------------------------
// Text of a tree

function inlineText(parts: readonly MdInline[]): string {
  return parts
    .map((part) =>
      part.type === "strong" || part.type === "em" ? inlineText(part.children) : part.text,
    )
    .join("");
}

function blockText(block: MdBlock): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return inlineText(block.children);
    case "code":
      return block.text;
    case "list":
      return block.items.map((item) => item.map(blockText).join("\n")).join("\n");
  }
}

/**
 * The text a tree shows, with no marks: the blocks one after the other with a blank line between,
 * the items of a list on lines of their own. What the marks of the Markdown ate is not in it.
 */
export function markdownText(blocks: readonly MdBlock[]): string {
  return blocks.map(blockText).join("\n\n");
}

/** The fenced code blocks of a tree, in order, including the ones inside list items. */
export function codeBlocksOf(blocks: readonly MdBlock[]): MdCode[] {
  const found: MdCode[] = [];
  for (const block of blocks) {
    if (block.type === "code") found.push(block);
    else if (block.type === "list")
      for (const item of block.items) found.push(...codeBlocksOf(item));
  }
  return found;
}

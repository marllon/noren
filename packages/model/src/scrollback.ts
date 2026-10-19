// The scrollback snapshot of a pane: what is kept of a terminal when the app closes and every
// minute, how it is cleaned, and the text that shows it again when the pane opens. Pure: the
// terminal, the clock and the disk belong to the interface and the backend.
//
// A snapshot is the text the serialize addon of xterm makes of the last lines of a terminal: the
// characters and the colors (SGR), and the cursor moves it needs to put blank cells back. It is
// saved in `scrollback/<paneId>.txt` and comes back as data from disk, so it is **never trusted**:
// every snapshot goes through `cleanSnapshot` on its way out (before it is written) and again on its
// way in (before it is written to a terminal), and the cleaned text holds only
//
// - printable text, tabs and line breaks, and
// - colors and text styles (an SGR sequence, `ESC [ ... m`, with only digits, `;` and `:` in it).
//
// Nothing else survives: no sequence that changes a mode of the terminal (the alternate screen,
// mouse tracking, bracketed paste), sets the title, writes to the clipboard (OSC 52), moves the
// cursor, resets the terminal or makes it answer (a report of the cursor position, a device
// attributes request), and no control character at all, the eight-bit controls included. So whatever
// the file holds, what reaches xterm cannot change how the terminal behaves and cannot send a byte to
// the shell.

import { layoutPanes } from "./sessions";
import type { Item, Workspace } from "./types";
import { encodeUtf8 } from "./utf8";

/** How many lines of a terminal a snapshot keeps (the last ones). */
export const SCROLLBACK_SAVE_LINES = 2000;

/** How often the panes that had activity are saved, in milliseconds. */
export const SCROLLBACK_SAVE_INTERVAL_MS = 60_000;

/** The largest snapshot: the same limit the Rust store has (`MAX_SCROLLBACK_BYTES`), in bytes of UTF-8. */
export const MAX_SCROLLBACK_BYTES = 4 * 1024 * 1024;

/** A snapshot is kept unless the settings or the space say it never is. */
export const DEFAULT_SAVE_SCROLLBACK = true;

/** The longest line kept, in UTF-16 units (the colors of a full line of a busy program are a few KB). */
export const MAX_SNAPSHOT_LINE = 16 * 1024;

/** The longest SGR sequence kept (a foreground and a background color and every style is about 60). */
const MAX_SGR_PARAMS = 128;

/** The most blanks one cursor move over empty cells becomes. */
const MAX_BLANKS = 1000;

/** The longest pane id (it is a file name). */
const MAX_PANE_ID = 64;

/** Device names Windows reserves: a file called `con.txt` is the console there. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Whether `id` can name a snapshot file, by the same rule as the store in Rust
 * (`is_valid_pane_id`): ASCII letters, digits, `-` and `_`, 1 to 64 characters, and not a device
 * name. The id of a pane made by the app (a UUID) is one.
 */
export function isScrollbackPaneId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_PANE_ID &&
    /^[A-Za-z0-9_-]+$/.test(id) &&
    !RESERVED_NAMES.has(id.toLowerCase())
  );
}

/** The name of the snapshot file of a pane, which is what `Pane.scrollbackRef` holds. */
export function scrollbackFileName(paneId: string): string {
  return `${paneId}.txt`;
}

/** Whether the settings of the app allow snapshots: they do unless `terminal.saveScrollback` is false. */
export function scrollbackAllowed(
  terminal: { saveScrollback?: boolean | undefined } | undefined,
): boolean {
  return terminal?.saveScrollback ?? DEFAULT_SAVE_SCROLLBACK;
}

/**
 * Whether a pane's snapshot may be kept: the setting of the app and the setting of the pane's space
 * must both allow it. Either one off means nothing is saved, and a snapshot already on disk goes.
 */
export function savesScrollback(settingOn: boolean, spaceOn: boolean): boolean {
  return settingOn && spaceOn;
}

// ---------------------------------------------------------------------------------------------
// Cleaning

const SGR_PATTERN = /\x1b\[[0-9;:]*m/g; // eslint-disable-line no-control-regex

/** Where an escape sequence ends, and what of it is kept (a color or style, or blanks). */
interface Escape {
  end: number;
  keep: string;
}

const code = (text: string, index: number): number => text.charCodeAt(index);

/** `ESC [`: kept when it is a color or a style, or a move to the right (empty cells); dropped otherwise. */
function readCsi(raw: string, start: number): Escape {
  const length = raw.length;
  let j = start + 2;
  const paramsStart = j;
  while (j < length && j - paramsStart < 256 && code(raw, j) >= 0x30 && code(raw, j) <= 0x3f) j++;
  const paramsEnd = j;
  while (j < length && j - paramsEnd < 16 && code(raw, j) >= 0x20 && code(raw, j) <= 0x2f) j++;
  const hasIntermediates = j > paramsEnd;
  if (j >= length || code(raw, j) < 0x40 || code(raw, j) > 0x7e) return { end: j, keep: "" };
  const final = raw.charAt(j);
  const params = raw.slice(paramsStart, paramsEnd);
  const end = j + 1;
  if (hasIntermediates) return { end, keep: "" };
  if (final === "m" && params.length <= MAX_SGR_PARAMS && /^[0-9;:]*$/.test(params)) {
    return { end, keep: raw.slice(start, end) };
  }
  // The serializer skips empty cells with a move to the right; they come back as blanks, which have
  // the color of the cell in force (so a colored gap stays colored).
  if (final === "C" && /^[0-9]*$/.test(params)) {
    const count = params === "" ? 1 : Number.parseInt(params, 10);
    return { end, keep: " ".repeat(Math.min(Math.max(count, 1), MAX_BLANKS)) };
  }
  return { end, keep: "" };
}

/** The end of a string sequence (`ESC ]`, `ESC P`, ...) whose body starts at `from`. It never runs past its line. */
function endOfString(raw: string, from: number): number {
  const length = raw.length;
  for (let j = from; j < length; j++) {
    const c = code(raw, j);
    if (c === 0x07 || c === 0x9c) return j + 1;
    if (c === 0x1b) return raw.charAt(j + 1) === "\\" ? j + 2 : j;
    if (c === 0x0a || c === 0x0d) return j;
  }
  return length;
}

/** Reads the escape sequence that starts at `start` (where the text has an ESC). */
function readEscape(raw: string, start: number): Escape {
  const length = raw.length;
  if (start + 1 >= length) return { end: length, keep: "" };
  const kind = code(raw, start + 1);
  if (kind === 0x5b) return readCsi(raw, start);
  // OSC, DCS, SOS, PM and APC: a string up to its terminator.
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    return { end: endOfString(raw, start + 2), keep: "" };
  }
  // Any other escape: intermediates, then one final character (`ESC ( B`, `ESC c`, `ESC =`).
  let j = start + 1;
  while (j < length && code(raw, j) >= 0x20 && code(raw, j) <= 0x2f) j++;
  if (j < length && code(raw, j) >= 0x30 && code(raw, j) <= 0x7e) j++;
  return { end: j, keep: "" };
}

/** The text of a line without its colors. */
function plain(line: string): string {
  return line.replace(SGR_PATTERN, "");
}

export interface CleanSnapshotOptions {
  /** The most lines kept, the last ones. Default {@link SCROLLBACK_SAVE_LINES}. */
  maxLines?: number;
  /** The most bytes of UTF-8 kept, dropping the oldest lines. Default {@link MAX_SCROLLBACK_BYTES}. */
  maxBytes?: number;
}

/**
 * The snapshot text for `raw`, which is the output of the serialize addon or the content of a file
 * from disk: lines separated by `\n` that hold only printable text, tabs and colors (see the top of
 * this file). Never throws, whatever `raw` is. The result is the same when it is cleaned again.
 *
 * - Escape sequences other than colors and styles are dropped whole (a string sequence such as OSC
 *   52 up to its end, never past the end of its line); a move to the right over empty cells (what
 *   the serializer writes for blanks) becomes blanks.
 * - Control characters, DEL, the eight-bit controls and the characters that reorder text are
 *   dropped; a lone surrogate becomes U+FFFD; `\r\n`, `\r` and `\n` are all one line break.
 * - A line is cut at {@link MAX_SNAPSHOT_LINE}; blank lines at the end go; only the last
 *   `maxLines` lines are kept, and the oldest go until the text fits `maxBytes`.
 */
export function cleanSnapshot(raw: string, options: CleanSnapshotOptions = {}): string {
  const maxLines = Math.max(0, Math.floor(options.maxLines ?? SCROLLBACK_SAVE_LINES));
  const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? MAX_SCROLLBACK_BYTES));
  const lines: string[] = [];
  let line = "";
  const add = (text: string) => {
    if (line.length + text.length <= MAX_SNAPSHOT_LINE) line += text;
  };
  const length = raw.length;
  let i = 0;
  while (i < length) {
    const c = code(raw, i);
    if (c === 0x1b) {
      const escape = readEscape(raw, i);
      add(escape.keep);
      i = Math.max(escape.end, i + 1);
      continue;
    }
    if (c === 0x0d || c === 0x0a) {
      if (c === 0x0d && code(raw, i + 1) === 0x0a) i++;
      lines.push(line);
      line = "";
    } else if (c === 0x09) {
      add("\t");
    } else if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      // A control character: nothing a terminal should be handed.
    } else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      // Characters that reorder text: a line could show something other than what it holds.
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const low = code(raw, i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        add(raw.slice(i, i + 2));
        i++;
      } else {
        add("�");
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      add("�");
    } else {
      add(raw.charAt(i));
    }
    i++;
  }
  lines.push(line);

  while (lines.length > 0 && plain(lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  let kept = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  // The oldest lines go until the text fits: one pass over the sizes, not one encoding per line.
  const sizes = kept.map((text) => encodeUtf8(text).length + 1);
  let total = sizes.reduce((sum, size) => sum + size, 0) - (sizes.length > 0 ? 1 : 0);
  let drop = 0;
  while (total > maxBytes && drop < kept.length) {
    total -= sizes[drop] ?? 0;
    drop++;
  }
  if (drop > 0) kept = kept.slice(drop);
  return kept.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Showing it again

/** Dim (faint) text: the old output is shown less bright than the new. */
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const two = (n: number): string => String(n).padStart(2, "0");

/** `2026-10-19 14:32`, in the time zone of the computer. */
export function formatRestoreTime(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The line that tells the output above it is from an earlier session. */
export function restoredMarker(at: number): string {
  return `session restored ${formatRestoreTime(at)}`;
}

/**
 * What is written to a terminal to show `snapshot` again: the saved lines dimmed, and under them the
 * line `session restored <date and time>` (`at` is when the pane was restored), each line ended with
 * a carriage return and a line feed, so the shell of the new session starts on the next line. An
 * empty snapshot gives an empty text: a pane that has nothing to show shows no marker.
 *
 * `snapshot` is cleaned again here, so even a text that never went through `cleanSnapshot` can only
 * show text and colors. The dimming is put back after every color sequence, because a reset in the
 * saved text would otherwise end it; the colors themselves are kept (dim red is red, dimmed). The
 * style is not reset between lines, since the serializer leaves out a color that did not change
 * from one line to the next.
 */
export function restoredTerminalText(snapshot: string, at: number): string {
  const clean = cleanSnapshot(snapshot);
  if (clean === "") return "";
  const dimmed = clean
    .split("\n")
    .map((line) => line.replace(SGR_PATTERN, (sgr) => sgr + DIM))
    .join("\r\n");
  return `${RESET}${DIM}${dimmed}${RESET}\r\n${DIM}${restoredMarker(at)}${RESET}\r\n`;
}

// ---------------------------------------------------------------------------------------------
// Searching and sweeping

/**
 * The text of a snapshot as a person reads it, for searching: `raw` cleaned like any snapshot from
 * disk (`cleanSnapshot`) and then stripped of its colors, so what is left is printable text and line
 * breaks and nothing in it can be taken for markup or for an escape. Never throws.
 */
export function snapshotSearchText(raw: string): string {
  return plain(cleanSnapshot(raw));
}

/**
 * The ids in `listed` (the files in the `scrollback/` folder) that no pane claims: not a pane of an
 * open tab, of a closed tab or of an archived tab of `workspace`. Only a valid file name
 * (`isScrollbackPaneId`) can be an orphan, since nothing else is a snapshot; the answer has each id
 * once, in the order listed. A pane claims its file by its id, whether it says it has one
 * (`scrollbackRef`) or not: a note not yet written to `state.json` must not cost the snapshot.
 */
export function orphanScrollbackIds(workspace: Workspace, listed: readonly string[]): string[] {
  const claimed = new Set<string>();
  const claim = (item: Item) => {
    for (const pane of layoutPanes(item.layout)) claimed.add(pane.id);
  };
  for (const space of workspace.spaces) Object.values(space.items).forEach(claim);
  for (const entry of workspace.closed) claim(entry.item);
  for (const entry of workspace.archive) claim(entry.item);
  const orphans = new Set<string>();
  for (const id of listed) {
    if (isScrollbackPaneId(id) && !claimed.has(id)) orphans.add(id);
  }
  return [...orphans];
}

// ---------------------------------------------------------------------------------------------
// Peek

/** How many lines the peek of a tab shows (the last ones that hold something). */
export const PEEK_LINES = 15;

/** The longest line of a peek, in characters; a longer one is cut and ends in an ellipsis. */
export const PEEK_LINE_CHARS = 200;

/**
 * The last `count` lines of a snapshot that hold something, for the peek of a tab: `raw` cleaned
 * like any snapshot (`cleanSnapshot`), stripped of its colors, with the empty lines left out and
 * each line cut to `PEEK_LINE_CHARS` (trailing blanks dropped first). What comes back is plain text
 * that nothing can take for markup or for an escape. Never throws; `count` below 1 gives no lines.
 */
export function peekLines(
  raw: string,
  count: number = PEEK_LINES,
  maxChars: number = PEEK_LINE_CHARS,
): string[] {
  const wanted = Math.floor(count);
  if (!(wanted >= 1)) return [];
  const limit = Math.max(1, Math.floor(maxChars));
  const kept: string[] = [];
  const lines = snapshotSearchText(raw).split("\n");
  for (let i = lines.length - 1; i >= 0 && kept.length < wanted; i--) {
    const text = (lines[i] ?? "").trimEnd();
    if (text.trim() === "") continue;
    kept.push(cutLine(text, limit));
  }
  return kept.reverse();
}

/** `text` cut to `limit` characters with an ellipsis at the end, without splitting a surrogate pair. */
function cutLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  const last = code(text, end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

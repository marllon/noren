import { decodeUtf8, encodeUtf8 } from "./utf8";

// Shell integration: a shell with the Noren scripts reports what it is doing through OSC
// sequences (`ESC ] <payload> BEL`, or `ESC \` as terminator instead of BEL):
//
//   OSC 7 ; file://host/path        the folder the shell is in
//   OSC 9 ; 9 ; path                the folder, as cmd reports it (other OSC 9 are not ours)
//   OSC 133 ; A                     the prompt starts
//   OSC 133 ; B                     the prompt ended, the user types
//   OSC 133 ; C                     the command starts running
//   OSC 133 ; D [; code]            the command ended, with its exit code
//   OSC 633 ; E ; command line      the command line, escaped (see `unescapeCommandLine`)
//
// The parser turns the output of a terminal session into those events. It reads bytes, so a
// sequence that arrives cut anywhere (even inside a multi-byte character) gives the same events
// as the same bytes in one piece. Everything else in the stream, and every other OSC, is ignored.
// The text of a sequence comes from a program running in the terminal, so nothing in it is trusted.

/** The shell reported its working folder (OSC 7). `path` is a plain path, `C:/x` on Windows. */
export interface CwdEvent {
  readonly kind: "cwd";
  readonly path: string;
}

/** The prompt starts (OSC 133;A). */
export interface PromptStartEvent {
  readonly kind: "prompt-start";
}

/** The prompt ended and the user types the command (OSC 133;B). */
export interface PromptEndEvent {
  readonly kind: "prompt-end";
}

/** The command starts running (OSC 133;C). */
export interface CommandStartEvent {
  readonly kind: "command-start";
}

/** The command ended (OSC 133;D). `exitCode` is `undefined` when the shell did not tell. */
export interface CommandEndEvent {
  readonly kind: "command-end";
  readonly exitCode: number | undefined;
}

/** The command line that is about to run (OSC 633;E), already unescaped. */
export interface CommandLineEvent {
  readonly kind: "command-line";
  readonly text: string;
}

export type ShellEvent =
  | CwdEvent
  | PromptStartEvent
  | PromptEndEvent
  | CommandStartEvent
  | CommandEndEvent
  | CommandLineEvent;

/** Largest payload (bytes between `ESC ]` and the terminator) that is kept; longer is dropped. */
export const DEFAULT_MAX_OSC_BYTES = 8192;

/** Longest folder path taken from OSC 7; anything longer is not a folder a person works in. */
const MAX_PATH = 4096;

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const RIGHT_BRACKET = 0x5d; // ]
const BACKSLASH = 0x5c;

/**
 * Where the parser is. `ground`: outside any sequence. `escape`: after ESC. `osc`: collecting the
 * payload of an OSC. `osc-escape`: in an OSC, after an ESC (`\` ends it, anything else abandons
 * it). `discard` and `discard-escape`: the same two for an OSC that is too long, whose bytes are
 * dropped up to its end.
 */
type Mode = "ground" | "escape" | "osc" | "osc-escape" | "discard" | "discard-escape";

export interface ShellIntegrationParserOptions {
  /** Largest OSC payload kept, in bytes. Default {@link DEFAULT_MAX_OSC_BYTES}. */
  readonly maxOscBytes?: number;
}

/**
 * Stateful parser of shell integration sequences. Feed it the output of a session in order, in
 * chunks of any size; it returns the events that finished in that chunk. The only thing it keeps
 * between calls is the start of a sequence that did not end yet, at most `maxOscBytes` bytes.
 */
export class ShellIntegrationParser {
  readonly #max: number;
  #mode: Mode = "ground";
  #payload: number[] = [];

  constructor(options: ShellIntegrationParserOptions = {}) {
    this.#max = Math.max(1, Math.floor(options.maxOscBytes ?? DEFAULT_MAX_OSC_BYTES));
  }

  /** Bytes of an unfinished sequence that are being held (0 outside a sequence). */
  get pendingBytes(): number {
    return this.#payload.length;
  }

  /** Forgets any unfinished sequence, for example when the session is replaced. */
  reset(): void {
    this.#mode = "ground";
    this.#payload = [];
  }

  /** Reads a chunk of output (bytes, or text which is read as its UTF-8 bytes). */
  feed(chunk: Uint8Array | string): ShellEvent[] {
    const bytes = typeof chunk === "string" ? encodeUtf8(chunk) : chunk;
    const events: ShellEvent[] = [];
    for (const byte of bytes) this.#step(byte, events);
    return events;
  }

  #step(byte: number, events: ShellEvent[]): void {
    switch (this.#mode) {
      case "ground":
        if (byte === ESC) this.#mode = "escape";
        return;
      case "escape":
        this.#afterEscape(byte);
        return;
      case "osc":
        if (byte === BEL) this.#finish(events);
        else if (byte === ESC) this.#mode = "osc-escape";
        else if (byte === CAN || byte === SUB) this.reset();
        else this.#collect(byte);
        return;
      case "osc-escape":
        if (byte === BACKSLASH) this.#finish(events);
        else {
          // ESC followed by anything but `\` abandons the sequence and starts a new one.
          this.#payload = [];
          this.#afterEscape(byte);
        }
        return;
      case "discard":
        if (byte === BEL) this.reset();
        else if (byte === ESC) this.#mode = "discard-escape";
        else if (byte === CAN || byte === SUB) this.reset();
        return;
      case "discard-escape":
        if (byte === BACKSLASH) this.reset();
        else this.#afterEscape(byte);
        return;
    }
  }

  /** Handles the byte after an ESC that is not part of an OSC being collected. */
  #afterEscape(byte: number): void {
    this.#payload = [];
    if (byte === RIGHT_BRACKET) this.#mode = "osc";
    else if (byte === ESC) this.#mode = "escape";
    else this.#mode = "ground";
  }

  #collect(byte: number): void {
    if (this.#payload.length >= this.#max) {
      this.#payload = [];
      this.#mode = "discard";
      return;
    }
    this.#payload.push(byte);
  }

  #finish(events: ShellEvent[]): void {
    const payload = decodeUtf8(Uint8Array.from(this.#payload));
    this.reset();
    const event = parseOsc(payload);
    if (event !== undefined) events.push(event);
  }
}

/** The event for the payload of one OSC (`7;file://...`, `133;D;1`, ...), if it is one of ours. */
export function parseOsc(payload: string): ShellEvent | undefined {
  const split = payload.indexOf(";");
  const code = split < 0 ? payload : payload.slice(0, split);
  const rest = split < 0 ? "" : payload.slice(split + 1);
  switch (code) {
    case "7": {
      const path = pathFromFileUri(rest);
      return path === undefined ? undefined : { kind: "cwd", path };
    }
    case "9": {
      // OSC 9 is also the notification sequence (and 9;4 a progress bar): only `9;9;path`, the
      // folder reported by cmd, is read here. Everything else after `9;` is left alone.
      if (!rest.startsWith("9;")) return undefined;
      const path = pathFromPlainPath(rest.slice(2));
      return path === undefined ? undefined : { kind: "cwd", path };
    }
    case "133":
      return parseMark(rest);
    case "633":
      return parseExtension(rest);
    default:
      return undefined;
  }
}

function parseMark(params: string): ShellEvent | undefined {
  const parts = params.split(";");
  switch (parts[0]) {
    case "A":
      return { kind: "prompt-start" };
    case "B":
      return { kind: "prompt-end" };
    case "C":
      return { kind: "command-start" };
    case "D": {
      const code = parts[1];
      const exitCode = code !== undefined && /^-?\d{1,10}$/.test(code) ? Number(code) : undefined;
      return { kind: "command-end", exitCode };
    }
    default:
      return undefined;
  }
}

function parseExtension(params: string): ShellEvent | undefined {
  if (params !== "E" && !params.startsWith("E;")) return undefined;
  // Anything after the next `;` (an optional nonce) is not part of the command line.
  const escaped = params.slice(2).split(";")[0] ?? "";
  return { kind: "command-line", text: unescapeCommandLine(escaped) };
}

/**
 * Undoes the escaping of OSC 633;E: `\\` is a backslash and `\xNN` is the character with that
 * code (the script escapes `;` and control characters that way). Other text is kept as it is.
 */
export function unescapeCommandLine(escaped: string): string {
  return escaped.replace(/\\(?:\\|x([0-9a-fA-F]{2}))/g, (_whole, hex: string | undefined) =>
    hex === undefined ? "\\" : String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * The folder named by the data of an `OSC 9;9` sequence (`C:\Users\me`, as cmd writes it with
 * `$P`, optionally in double quotes), or `undefined` when it is not an absolute path. Backslashes
 * become `/`, so the result looks like the one from OSC 7: `C:/Users/me`, `//server/share/dir`.
 */
export function pathFromPlainPath(data: string): string | undefined {
  let text = data.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  // eslint-disable-next-line no-control-regex
  if (text === "" || text.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  const path = text.replaceAll("\\", "/");
  // A drive letter, or a root (a Unix path, or `//server/share`): nothing else is a folder here.
  return /^[A-Za-z]:(\/|$)/.test(path) || path.startsWith("/") ? path : undefined;
}

/**
 * The folder named by the data of an OSC 7 sequence (`file://host/C:/Users/me`), or `undefined`
 * when there is none. The host is ignored, percent escapes are decoded, and the slash before a
 * Windows drive letter is dropped (`/C:/Users/me` becomes `C:/Users/me`).
 */
export function pathFromFileUri(data: string): string | undefined {
  const match = /^file:\/\/([^/]*)(\/.*)$/i.exec(data.trim());
  if (match === null) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(match[2] ?? "");
  } catch {
    return undefined;
  }
  // A control character in a path is never a folder the user is in.
  // eslint-disable-next-line no-control-regex
  if (path.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const windows = /^\/[A-Za-z]:(\/|$)/.test(path);
  const result = windows ? path.slice(1) : path;
  return result === "" ? undefined : result;
}

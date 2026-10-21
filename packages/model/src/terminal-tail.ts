import { TerminalTextStripper } from "./terminal-text";

// The last lines a terminal printed, as plain text, for `terminal.read` of the local API
// (NOR-F17-01b). The bytes of each session go through a `TerminalTextStripper` (no colors, no cursor
// moves, no marks of the shell integration) and only the end is kept, so a program that prints
// forever costs the same as one that printed a page. Pure: the caller feeds it the output it
// already receives (`Backend.onOutput`); it subscribes to nothing.

/** Most lines kept for a session. */
export const TAIL_MAX_LINES = 10_000;
/** Longest line kept, in characters; the rest of a longer line is dropped. */
export const TAIL_MAX_LINE_CHARS = 2_000;

export interface TerminalTailOptions {
  maxLines?: number;
  maxLineChars?: number;
}

interface Tail {
  stripper: TerminalTextStripper;
  /** Finished lines, oldest first. */
  lines: string[];
  /** The line still being written (a prompt stays open). */
  open: string;
}

/** The end of the output of any number of sessions. */
export class TerminalTail {
  readonly #maxLines: number;
  readonly #maxLineChars: number;
  readonly #tails = new Map<number, Tail>();

  constructor(options: TerminalTailOptions = {}) {
    this.#maxLines = Math.max(1, Math.floor(options.maxLines ?? TAIL_MAX_LINES));
    this.#maxLineChars = Math.max(1, Math.floor(options.maxLineChars ?? TAIL_MAX_LINE_CHARS));
  }

  /** Takes a chunk of the output of the session. */
  feed(sessionId: number, chunk: Uint8Array | string): void {
    let tail = this.#tails.get(sessionId);
    if (tail === undefined) {
      tail = { stripper: new TerminalTextStripper(), lines: [], open: "" };
      this.#tails.set(sessionId, tail);
    }
    const text = tail.stripper.feed(chunk);
    if (text === "") return;
    const parts = (tail.open + text).split("\n");
    tail.open = (parts.pop() ?? "").slice(0, this.#maxLineChars);
    for (const part of parts) tail.lines.push(part.slice(0, this.#maxLineChars));
    if (tail.lines.length > this.#maxLines)
      tail.lines.splice(0, tail.lines.length - this.#maxLines);
  }

  /**
   * The last `count` lines of the session, oldest first: the finished lines and then the one being
   * written, if it has anything on it. Blank lines at the end are not lines. A session never fed is
   * an empty list.
   */
  read(sessionId: number, count: number): string[] {
    const tail = this.#tails.get(sessionId);
    if (tail === undefined || !Number.isFinite(count) || count < 1) return [];
    const all = tail.open === "" ? tail.lines : [...tail.lines, tail.open];
    let end = all.length;
    while (end > 0 && (all[end - 1] ?? "").trim() === "") end--;
    return all.slice(Math.max(0, end - Math.floor(count)), end);
  }

  /** Forgets a session (it ended, or its pane closed). */
  forget(sessionId: number): void {
    this.#tails.delete(sessionId);
  }

  /** How many sessions are held. */
  get size(): number {
    return this.#tails.size;
  }
}

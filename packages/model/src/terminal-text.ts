import { decodeUtf8, encodeUtf8 } from "./utf8";

// The text a person would read in the output of a program: the bytes of a session without the
// control sequences (colors, cursor moves, window titles, the shell integration marks...). The
// agent state classifier (`agent-state.ts`) reads this, since its patterns are written against
// words, not against escape codes.
//
// Pure: no DOM, no Tauri. A sequence may be split between two chunks; the stripper remembers where
// it is. Nothing is buffered beyond one character of UTF-8, so a sequence that never ends cannot
// grow memory.

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const CR = 0x0d;
const LF = 0x0a;
const TAB = 0x09;

/**
 * Where the stripper is. `ground`: plain text. `escape`: after ESC. `escape-intermediate`: after
 * ESC and a byte of 0x20-0x2f (the final byte follows). `csi`: inside `ESC [`, up to its final byte.
 * `osc`: inside `ESC ]`, up to BEL or ST. `string`: inside `ESC P`, `ESC X`, `ESC ^` or `ESC _`
 * (DCS, SOS, PM, APC), up to ST. `osc-escape` and `string-escape`: the two after an ESC met in
 * one of those (`\` ends it).
 */
type Mode =
  | "ground"
  | "escape"
  | "escape-intermediate"
  | "csi"
  | "osc"
  | "osc-escape"
  | "string"
  | "string-escape";

/** How many bytes a UTF-8 character that starts with `lead` takes (1 for anything else). */
function sequenceLength(lead: number): number {
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc2 && lead < 0xe0) return 2;
  return 1;
}

/**
 * Turns chunks of terminal output into plain text. Line ends (`\n`, `\r\n` and a lone `\r`, which a
 * program uses to redraw a line) come out as `\n`; a tab stays; other control characters and every
 * escape sequence are dropped.
 */
export class TerminalTextStripper {
  #mode: Mode = "ground";
  /** The bytes of a UTF-8 character cut by the end of the last chunk. */
  #held: number[] = [];
  #pendingCr = false;

  /** The plain text of a chunk (bytes, or a string for a test). May be empty. */
  feed(chunk: Uint8Array | string): string {
    const bytes = typeof chunk === "string" ? encodeUtf8(chunk) : chunk;
    const kept: number[] = [...this.#held];
    this.#held = [];
    for (const byte of bytes) this.#take(byte, kept);
    // A character cut in half waits for the rest.
    let cut = kept.length;
    for (let back = 1; back <= 3 && back <= kept.length; back++) {
      const byte = kept[kept.length - back] ?? 0;
      if ((byte & 0xc0) === 0x80) continue;
      if (byte >= 0xc2 && sequenceLength(byte) > back) cut = kept.length - back;
      break;
    }
    this.#held = kept.slice(cut);
    return decodeUtf8(Uint8Array.from(kept.slice(0, cut)));
  }

  #take(byte: number, out: number[]): void {
    // CAN and SUB abandon any sequence, wherever it is.
    if (byte === CAN || byte === SUB) {
      this.#mode = "ground";
      return;
    }
    switch (this.#mode) {
      case "ground":
        this.#ground(byte, out);
        return;
      case "escape":
        if (byte === 0x5b)
          this.#mode = "csi"; // [
        else if (byte === 0x5d)
          this.#mode = "osc"; // ]
        else if (byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f)
          this.#mode = "string"; // P X ^ _
        else if (byte >= 0x20 && byte <= 0x2f) this.#mode = "escape-intermediate";
        else if (byte === ESC) this.#mode = "escape";
        else this.#mode = "ground";
        return;
      case "escape-intermediate":
        if (byte < 0x20 || byte > 0x2f) this.#mode = "ground";
        return;
      case "csi":
        // Parameters and intermediates are 0x20-0x3f; the final byte is 0x40-0x7e.
        if (byte >= 0x40 && byte <= 0x7e) this.#mode = "ground";
        else if (byte === ESC) this.#mode = "escape";
        return;
      case "osc":
        if (byte === BEL) this.#mode = "ground";
        else if (byte === ESC) this.#mode = "osc-escape";
        return;
      case "string":
        if (byte === ESC) this.#mode = "string-escape";
        return;
      case "osc-escape":
      case "string-escape":
        // `ESC \` ends the sequence; another ESC changes nothing; any other byte after ESC
        // abandons the sequence and is the start of a new one.
        if (byte === 0x5c) {
          this.#mode = "ground";
        } else if (byte !== ESC) {
          this.#mode = "escape";
          this.#take(byte, out);
        }
        return;
    }
  }

  #ground(byte: number, out: number[]): void {
    if (byte === ESC) {
      this.#mode = "escape";
      this.#pendingCr = false;
      return;
    }
    if (byte === CR) {
      out.push(LF);
      this.#pendingCr = true;
      return;
    }
    if (byte === LF) {
      // `\r\n` is one line end, already written for the `\r`.
      if (!this.#pendingCr) out.push(LF);
      this.#pendingCr = false;
      return;
    }
    this.#pendingCr = false;
    if (byte === TAB || byte >= 0x20) {
      if (byte !== 0x7f) out.push(byte);
    }
  }
}

/** Pure helpers for pasting into the terminal. */

/** What to do with text that is about to be pasted. */
export type PasteDecision = "ignore" | "send" | "confirm";

/**
 * Number of lines in `text`. CRLF, CR and LF each end a line; one trailing line break does not
 * start a new (empty) line, so `"ls\n"` is a single line and `""` has none.
 */
export function countLines(text: string): number {
  if (text === "") return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** True when pasting `text` could run more than one command, so the user must confirm first. */
export function needsPasteConfirmation(text: string): boolean {
  return countLines(text) > 1;
}

/** Empty text is ignored, a single line goes straight through, several lines ask first. */
export function decidePaste(text: string): PasteDecision {
  if (countLines(text) === 0) return "ignore";
  return needsPasteConfirmation(text) ? "confirm" : "send";
}

/** Tab, line feed and carriage return: the only control characters text may carry into the terminal. */
const KEPT_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

/** A control character of the C0 or C1 range, or DEL. */
function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * The text of a code block the AI wrote, made fit to be put at the prompt: the line breaks at its
 * two ends are dropped (so what lands is never a finished command) and every control character
 * other than tab and the line breaks is taken out. An answer is untrusted, and Escape, Ctrl+C or
 * Ctrl+D typed into a shell by an answer would be a key press the person did not make. Line breaks
 * inside the text stay: `decidePaste` makes the person confirm text that has more than one line.
 */
export function insertableText(text: string): string {
  const clean = [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return KEPT_CONTROLS.has(code) || !isControl(code);
    })
    .join("");
  return clean.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "");
}

export interface PastePreview {
  /** First lines of the text, each cut to `maxColumns` characters. */
  lines: string[];
  /** Lines of the text that `lines` leaves out. */
  hidden: number;
  total: number;
}

/** A short, bounded excerpt of the pasted text for the confirmation dialog. */
export function previewPaste(text: string, maxLines = 6, maxColumns = 100): PastePreview {
  const all = text === "" ? [] : text.split(/\r\n|\r|\n/);
  if (all[all.length - 1] === "") all.pop();
  const lines = all
    .slice(0, maxLines)
    .map((line) => (line.length > maxColumns ? `${line.slice(0, maxColumns)}…` : line));
  return { lines, hidden: all.length - lines.length, total: all.length };
}

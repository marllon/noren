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

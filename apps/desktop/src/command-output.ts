// The words of the command-mark actions that end in a notice, and what a "copy" puts on the
// clipboard. Pure, so the rules can be tested without a terminal.

import type { CommandOutput } from "./command-marks-view";

/** A prompt step asked for from the palette or a menu, with no command mark in the pane. */
export const NO_PROMPT_NOTICE = "No command prompts in this pane yet";

/** "Select output" with no finished command that printed anything. */
export const NO_OUTPUT_TO_SELECT_NOTICE = "No finished command with output to select in this pane";

/** The clipboard refused the text. */
export const COPY_FAILED_NOTICE = "Could not copy: the clipboard refused the text";

/** What "copy the output of the last command" does: the text for the clipboard, and what to tell. */
export interface CopyPlan {
  /** Absent when there is nothing to copy. */
  text?: string;
  notice: string;
}

export function planCopy(output: CommandOutput | undefined): CopyPlan {
  if (output === undefined) return { notice: "No command has finished in this pane yet" };
  if (output.rows === 0) return { notice: "The last command printed no output" };
  return {
    text: output.text,
    notice: output.truncated
      ? "Copied the end of the output: the start is past the scrollback limit"
      : "Copied the output of the last command",
  };
}

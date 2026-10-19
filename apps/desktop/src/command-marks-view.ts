// The command marks of one xterm.js terminal: a marker and a decoration on the prompt of every
// command the shell reported (OSC 133), a red mark in the overview ruler for the ones that failed,
// the jump between prompts and the rows of an output. The logic that says which command is where is
// `CommandMarks` in `@noren/model`; this file gives it the terminal's cursor and draws the result.
//
// The shell's sequences are read by xterm.js itself (an OSC handler), not from the copy of the
// output the pane tracker parses: only the terminal knows which row its cursor is on at the moment a
// sequence is read, and a marker made there follows that row while the scrollback trims and the
// terminal reflows. The text of a sequence goes through the same `parseOsc` the tracker uses.

import { CommandMarks, joinRows, markFailed, parseOsc } from "@noren/model";
import type { CommandMark, MarkChange, MarkView } from "@noren/model";
import type { IDecoration, IDisposable, IMarker, ITheme, Terminal } from "@xterm/xterm";

/** The colors of the marks: a command that ran well, one that failed, one that still runs. */
export interface MarkColors {
  ok: string;
  failed: string;
  running: string;
}

const FALLBACK_COLORS: MarkColors = { ok: "#98c379", failed: "#e06c75", running: "#e5c07b" };

/** The mark colors of a terminal theme: its green, red and yellow. */
export function markColors(theme: ITheme): MarkColors {
  return {
    ok: theme.green ?? FALLBACK_COLORS.ok,
    failed: theme.red ?? FALLBACK_COLORS.failed,
    running: theme.yellow ?? FALLBACK_COLORS.running,
  };
}

/** One command mark, as tests and diagnostics read it. */
export interface CommandMarkInfo {
  /** The row of the prompt in the buffer (0 is the oldest row kept). */
  row: number;
  /** The text of that row: the prompt and the command line. */
  text: string;
  state: "running" | "done";
  /** The exit code the shell reported; absent while the command runs or when the shell did not say. */
  exitCode?: number;
  /** The command ended with a code other than 0. */
  failed: boolean;
  /** The mark is also drawn in the overview ruler. */
  ruler: boolean;
  /** The prompt the user stepped to last. */
  current: boolean;
  /** How many rows of output the command left in the buffer (0 for a command that did not end). */
  outputRows: number;
}

/** The output of a command, as text. */
export interface CommandOutput {
  /** The rows of the output joined into lines, without a trailing line break. */
  text: string;
  /** How many buffer rows the output takes. */
  rows: number;
  /** The start of the output was trimmed from the scrollback, so `text` is only the end of it. */
  truncated: boolean;
  /** The exit code of the command, when the shell reported it. */
  exitCode?: number;
}

/** A marker that is already gone, for a terminal that cannot place one (the alternate screen). */
const deadMarker = (): IMarker => ({
  id: -1,
  isDisposed: true,
  line: -1,
  onDispose: () => ({ dispose: () => undefined }),
  dispose: () => undefined,
});

/** The marks of one terminal. Make it with {@link attachCommandMarks} and dispose it before the terminal. */
export class TerminalCommandMarks {
  readonly #term: Terminal;
  readonly #marks: CommandMarks<IMarker>;
  readonly #decorations = new Map<number, IDecoration>();
  readonly #elements = new Map<number, HTMLElement>();
  readonly #handlers: IDisposable[];
  #colors: MarkColors;
  /** The command whose decoration is flagged as the current one. */
  #shownId: number | undefined;

  constructor(term: Terminal, colors: MarkColors) {
    this.#term = term;
    this.#colors = colors;
    this.#marks = new CommandMarks<IMarker>({ onChange: (change) => this.#changed(change) });
    this.#handlers = [
      term.parser.registerOscHandler(133, (data) => {
        this.#read(data);
        return true;
      }),
      // A full reset (ESC c) empties the buffer without disposing its markers: the marks go too.
      // Returning false lets the terminal do the reset itself.
      term.parser.registerEscHandler({ final: "c" }, () => {
        this.#marks.clear();
        return false;
      }),
      // The prompt stepped to is only "current" while the view is on it.
      term.onScroll(() => this.#showCurrent()),
    ];
  }

  /** The commands that started and whose prompt is still in the buffer, oldest first. */
  marks(): CommandMarkInfo[] {
    const buffer = this.#term.buffer.active;
    const current = this.#marks.currentIn(this.#view());
    return this.#marks.commands().map((mark) => ({
      row: mark.prompt.line,
      text: buffer.getLine(mark.prompt.line)?.translateToString(true) ?? "",
      state: mark.state === "running" ? "running" : "done",
      ...(mark.exitCode !== undefined ? { exitCode: mark.exitCode } : {}),
      failed: markFailed(mark),
      ruler: this.#decorations.get(mark.id)?.options.overviewRulerOptions !== undefined,
      current: mark === current,
      outputRows: this.#marks.outputRows(mark)?.count ?? 0,
    }));
  }

  /**
   * Scrolls to the prompt before or after the one in view. False when there is no command mark (or
   * the terminal shows its alternate screen, where a program other than the shell has the keys): the
   * key is not ours then.
   */
  jump(direction: "previous" | "next"): boolean {
    const buffer = this.#term.buffer.active;
    if (buffer.type !== "normal" || this.#marks.commands().length === 0) return false;
    const step = this.#marks.step(direction, this.#view());
    if (step.kind === "mark") this.#term.scrollToLine(step.mark.prompt.line);
    else if (step.kind === "bottom") this.#term.scrollToBottom();
    this.#showCurrent();
    return true;
  }

  /**
   * Selects the output of a command: the prompt the user stepped to if it ended, else the last
   * command that ended. False when there is none or it printed nothing.
   */
  selectOutput(): boolean {
    const current = this.#marks.currentIn(this.#view());
    const mark = current?.state === "done" ? current : this.#marks.lastFinished();
    const rows = mark === undefined ? undefined : this.#marks.outputRows(mark);
    if (rows === undefined || rows.count === 0) return false;
    this.#term.selectLines(rows.first, rows.first + rows.count - 1);
    const view = this.#term.buffer.active.viewportY;
    if (rows.first < view || rows.first >= view + this.#term.rows) {
      this.#term.scrollToLine(rows.first);
    }
    return true;
  }

  /** The output of the last command that ended; undefined when none did. */
  lastOutput(): CommandOutput | undefined {
    const mark = this.#marks.lastFinished();
    const rows = mark === undefined ? undefined : this.#marks.outputRows(mark);
    if (mark === undefined || rows === undefined) return undefined;
    const buffer = this.#term.buffer.active;
    const text = joinRows(
      (row) => {
        const line = buffer.getLine(row);
        return line === undefined
          ? undefined
          : { text: line.translateToString(true), wrapped: line.isWrapped };
      },
      rows.first,
      rows.count,
    );
    return {
      text,
      rows: rows.count,
      truncated: rows.truncated,
      ...(mark.exitCode !== undefined ? { exitCode: mark.exitCode } : {}),
    };
  }

  /** A new theme: the marks are drawn again in its colors. */
  setColors(colors: MarkColors): void {
    this.#colors = colors;
    for (const mark of this.#marks.commands()) this.#decorate(mark);
  }

  dispose(): void {
    for (const handler of this.#handlers) handler.dispose();
    this.#marks.dispose();
    for (const decoration of this.#decorations.values()) decoration.dispose();
    this.#decorations.clear();
    this.#elements.clear();
  }

  #view(): MarkView {
    const buffer = this.#term.buffer.active;
    return { top: buffer.viewportY, bottom: buffer.baseY };
  }

  #read(data: string): void {
    const event = parseOsc(`133;${data}`);
    const buffer = this.#term.buffer.active;
    // A program on the alternate screen is not the shell: nothing it prints is a prompt of ours.
    if (event === undefined || buffer.type !== "normal") return;
    this.#marks.handle(event, {
      anchor: (offset) => this.#anchor(offset),
      column: buffer.cursorX,
    });
  }

  #anchor(offset = 0): IMarker {
    return this.#term.registerMarker(offset) ?? deadMarker();
  }

  #changed(change: MarkChange<IMarker>): void {
    if (change.kind === "remove") {
      this.#decorations.get(change.mark.id)?.dispose();
      this.#decorations.delete(change.mark.id);
      this.#elements.delete(change.mark.id);
    } else {
      this.#decorate(change.mark);
    }
  }

  /** Draws a command: a mark on its prompt row, and a red one in the ruler when it failed. */
  #decorate(mark: CommandMark<IMarker>): void {
    this.#decorations.get(mark.id)?.dispose();
    this.#elements.delete(mark.id);
    const decoration = this.#term.registerDecoration({
      marker: mark.prompt,
      x: 0,
      ...(markFailed(mark)
        ? { overviewRulerOptions: { color: this.#colors.failed, position: "full" as const } }
        : {}),
    });
    if (decoration === undefined) return;
    this.#decorations.set(mark.id, decoration);
    decoration.onRender((element) => this.#style(element, mark));
    decoration.onDispose(() => {
      if (this.#decorations.get(mark.id) === decoration) this.#decorations.delete(mark.id);
      this.#elements.delete(mark.id);
    });
  }

  #style(element: HTMLElement, mark: CommandMark<IMarker>): void {
    this.#elements.set(mark.id, element);
    const state = markFailed(mark) ? "failed" : mark.state === "running" ? "running" : "done";
    element.classList.add("command-mark");
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("data-nr-part", "command-mark");
    element.setAttribute("data-nr-state", state);
    element.style.setProperty("--nr-mark-color", this.#colors[state === "done" ? "ok" : state]);
    if (mark.id === this.#shownId) element.setAttribute("data-nr-current", "true");
    else element.removeAttribute("data-nr-current");
  }

  /** Marks the decoration of the prompt stepped to, so it can be told from the others. */
  #showCurrent(): void {
    const current = this.#marks.currentIn(this.#view())?.id;
    if (current === this.#shownId) return;
    if (this.#shownId !== undefined)
      this.#elements.get(this.#shownId)?.removeAttribute("data-nr-current");
    this.#shownId = current;
    if (current !== undefined) this.#elements.get(current)?.setAttribute("data-nr-current", "true");
  }
}

/** Starts reading the shell marks of `term`. */
export function attachCommandMarks(term: Terminal, colors: MarkColors): TerminalCommandMarks {
  return new TerminalCommandMarks(term, colors);
}

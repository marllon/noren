import type { ShellEvent } from "./shell-integration";

// Command marks: where each command a shell reported sits in the buffer of a terminal. The shell
// says a prompt starts (OSC 133;A), the command starts running (C) and the command ended (D); the
// terminal says where its cursor is at the moment each of those is read, as a *line anchor*, a place
// that follows its line while the buffer scrolls (an xterm.js marker). From that this module keeps
// the list of commands and answers the questions of the interface: which prompt comes before or
// after the one in view, and which rows hold the output of a command.
//
// It is pure: it never reads a terminal. The caller hands each event over together with the cursor
// the terminal had then, so the marks are exact even when output arrives in any size of chunk.

/**
 * A place in the buffer that moves with its line. `line` is the row (0 is the oldest row kept) and
 * becomes -1 once the row is trimmed from the scrollback. An xterm.js `IMarker` is one.
 */
export interface LineAnchor {
  readonly line: number;
  dispose(): void;
}

/** `prompt`: shown, no command yet. `running`: the command started. `done`: it ended. */
export type MarkState = "prompt" | "running" | "done";

/** One command, from its prompt to its end. */
export interface CommandMark<A extends LineAnchor = LineAnchor> {
  readonly id: number;
  readonly state: MarkState;
  /** The row where the prompt starts (OSC 133;A). */
  readonly prompt: A;
  /** The row where the output starts: the cursor when the command started (133;C). */
  readonly output: A | undefined;
  /** The row of the cursor when the command ended (133;D), or when the next prompt showed. */
  readonly end: A | undefined;
  /** True when the cursor was not at the start of its row at the end: the last output row is that row. */
  readonly endsMidLine: boolean;
  /** The exit code the shell reported; undefined when it did not say (or the command is not done). */
  readonly exitCode: number | undefined;
}

/** True for a command that ended with a code other than 0. A command whose code is unknown did not fail. */
export function markFailed(mark: Pick<CommandMark, "state" | "exitCode">): boolean {
  return mark.state === "done" && mark.exitCode !== undefined && mark.exitCode !== 0;
}

/** What the terminal tells about its cursor when an event is read. */
export interface MarkCursor<A extends LineAnchor> {
  /**
   * A new anchor on the row of the cursor, or on the row `offset` rows from it (-1 is the row
   * above). Called only when the mark needs one.
   */
  anchor(offset?: number): A;
  /** The column of the cursor (0 is the start of the row). */
  readonly column: number;
}

/** A change the interface draws: a command started or ended, or its mark is gone. */
export type MarkChange<A extends LineAnchor> =
  | { readonly kind: "start"; readonly mark: CommandMark<A> }
  | { readonly kind: "end"; readonly mark: CommandMark<A> }
  | { readonly kind: "remove"; readonly mark: CommandMark<A> };

export interface CommandMarksOptions<A extends LineAnchor> {
  /** Called after the marks changed, in the order the changes happened. */
  onChange?(change: MarkChange<A>): void;
}

/** The rows of a terminal that matter to moving between prompts. */
export interface MarkView {
  /** The row at the top of what is on screen. */
  readonly top: number;
  /** The largest `top` there is: the row at the top when the view follows the live output. */
  readonly bottom: number;
}

/** Where a step between prompts lands. */
export type MarkStep<A extends LineAnchor> =
  | { readonly kind: "mark"; readonly mark: CommandMark<A> }
  /** Past the last prompt: the live end of the terminal. */
  | { readonly kind: "bottom" }
  /** Nowhere to go (already at the first prompt, or at the end). */
  | { readonly kind: "none" };

/** The rows that hold the output of a command. */
export interface OutputRows {
  /** The first row. */
  readonly first: number;
  /** How many rows; 0 when the command printed nothing. */
  readonly count: number;
  /** True when the start of the output was trimmed from the scrollback: `first` is the oldest row kept. */
  readonly truncated: boolean;
}

interface MutableMark<A extends LineAnchor> {
  id: number;
  state: MarkState;
  prompt: A;
  output: A | undefined;
  end: A | undefined;
  endsMidLine: boolean;
  exitCode: number | undefined;
  /** The interface was told about this mark (it started). */
  announced: boolean;
}

/**
 * The commands of one terminal. Feed it the events of the shell with the cursor of each
 * ({@link handle}); read the commands, the step between prompts and the rows of an output from it.
 *
 * - A prompt (A) opens a mark in the `prompt` state. A prompt that comes before any command started
 *   (an empty line) replaces it: marks are commands, not prompts.
 * - C opens the output and makes the mark a command (`running`). C with no prompt before it (the
 *   terminal was cleared, or came up after the prompt was shown) takes the row above as the prompt:
 *   the line the user typed, which the shell has just ended.
 * - D ends the running command with its exit code. A D with no command running is not a command and
 *   is ignored. A prompt that comes while a command runs ends it without an exit code.
 * - Marks follow the scrollback: a mark whose rows are all gone is dropped, and one whose output
 *   start is gone has a truncated output.
 */
export class CommandMarks<A extends LineAnchor> {
  readonly #options: CommandMarksOptions<A>;
  readonly #marks: MutableMark<A>[] = [];
  #nextId = 1;
  #current: MutableMark<A> | undefined;

  constructor(options: CommandMarksOptions<A> = {}) {
    this.#options = options;
  }

  /** Reads one event of the shell, with the cursor the terminal had when it was read. */
  handle(event: ShellEvent, at: MarkCursor<A>): void {
    this.#prune();
    switch (event.kind) {
      case "prompt-start":
        this.#promptStart(at);
        return;
      case "command-start":
        this.#commandStart(at);
        return;
      case "command-end":
        this.#commandEnd(event.exitCode, at);
        return;
      default:
        return;
    }
  }

  /** The commands that started and whose prompt row is still kept, oldest first. */
  commands(): readonly CommandMark<A>[] {
    this.#prune();
    return this.#marks.filter((mark) => mark.state !== "prompt" && mark.prompt.line >= 0);
  }

  /** The newest command that ended (even one whose prompt row is gone), if any. */
  lastFinished(): CommandMark<A> | undefined {
    this.#prune();
    for (let i = this.#marks.length - 1; i >= 0; i--) {
      const mark = this.#marks[i];
      if (mark?.state === "done") return mark;
    }
    return undefined;
  }

  /** The command the user last stepped to, while it is kept. */
  get current(): CommandMark<A> | undefined {
    this.#prune();
    return this.#current;
  }

  /**
   * The command stepped to, while the view is still on its prompt (a prompt too near the end to
   * reach the top counts as reached when the view is at the end). Once the user scrolled or typed
   * the view moves away from it and there is no current command any more.
   */
  currentIn(view: MarkView): CommandMark<A> | undefined {
    const mark = this.current;
    return mark !== undefined && Math.min(mark.prompt.line, view.bottom) === view.top
      ? mark
      : undefined;
  }

  /** Forgets the command stepped to. */
  clearCurrent(): void {
    this.#current = undefined;
  }

  /**
   * Moves to the previous or next prompt of a command and remembers it as the current one.
   *
   * From a prompt stepped to (while the view is still on it) the neighbor in the list is the target;
   * past the last one is the live end of the terminal. When the view is somewhere else the target is
   * relative to the top of the view: the nearest prompt above it, or below it. A view that follows the
   * live output has the last prompt as the previous one and nothing after it.
   */
  step(direction: "previous" | "next", view: MarkView): MarkStep<A> {
    const list = this.commands();
    if (list.length === 0) return { kind: "none" };
    const reached = this.currentIn(view);
    const at = reached === undefined ? -1 : list.indexOf(reached);
    let target: CommandMark<A> | "bottom" | undefined;
    if (at >= 0) {
      target = direction === "previous" ? list[at - 1] : (list[at + 1] ?? "bottom");
    } else if (view.top >= view.bottom) {
      target = direction === "previous" ? list[list.length - 1] : undefined;
    } else if (direction === "previous") {
      target = [...list].reverse().find((mark) => mark.prompt.line < view.top);
    } else {
      target = list.find((mark) => mark.prompt.line > view.top) ?? "bottom";
    }
    if (target === undefined) return { kind: "none" };
    if (target === "bottom") {
      this.#current = undefined;
      return { kind: "bottom" };
    }
    this.#current = target as MutableMark<A>;
    return { kind: "mark", mark: target };
  }

  /**
   * The rows that hold the output of a command that ended, or `undefined` when it has not ended or
   * none of its rows is kept any more.
   */
  outputRows(mark: CommandMark<A>): OutputRows | undefined {
    if (mark.state !== "done" || mark.output === undefined || mark.end === undefined) {
      return undefined;
    }
    const endLine = mark.end.line;
    if (endLine < 0) return undefined;
    const last = mark.endsMidLine ? endLine : endLine - 1;
    const truncated = mark.output.line < 0;
    const first = truncated ? 0 : mark.output.line;
    return { first, count: Math.max(0, last - first + 1), truncated };
  }

  /** Drops every mark, telling the interface (the terminal was cleared or reset). */
  clear(): void {
    for (const mark of this.#marks.splice(0)) this.#release(mark, false);
    this.#current = undefined;
  }

  /** Drops every mark and releases its anchors, without telling the interface (it is going away too). */
  dispose(): void {
    for (const mark of this.#marks.splice(0)) this.#release(mark, true);
    this.#current = undefined;
  }

  #promptStart(at: MarkCursor<A>): void {
    this.#endRunning(undefined, at);
    // A prompt that never got a command (an empty line): the new prompt takes its place.
    const pending = this.#last();
    if (pending?.state === "prompt") this.#drop(pending);
    const prompt = at.anchor();
    this.#dropOverwritten(prompt.line);
    this.#marks.push(this.#create(prompt));
  }

  /**
   * A prompt on a row that older commands occupy means the screen was cleared (or redrawn from the
   * top): those commands are not there any more. Keeps the marks in the order of their rows.
   */
  #dropOverwritten(row: number): void {
    if (row < 0) return;
    for (let last = this.#last(); last !== undefined && last.prompt.line >= row;) {
      this.#drop(last);
      last = this.#last();
    }
  }

  #commandStart(at: MarkCursor<A>): void {
    this.#endRunning(undefined, at);
    const output = at.anchor();
    let mark = this.#last();
    if (mark?.state !== "prompt") {
      const prompt = this.#typedLine(at);
      this.#dropOverwritten(prompt.line);
      mark = this.#create(prompt);
      this.#marks.push(mark);
    }
    mark.output = output;
    mark.state = "running";
    mark.announced = true;
    this.#options.onChange?.({ kind: "start", mark });
  }

  /**
   * The prompt of a command whose prompt was never seen: the row above the cursor, where the user
   * typed the line, unless that row is above rows the last command used (the terminal went back up
   * and it is not the typed line), then the row of the cursor.
   */
  #typedLine(at: MarkCursor<A>): A {
    const above = at.anchor(-1);
    const previous = this.#last();
    const floor = Math.max(
      -1,
      previous?.prompt.line ?? -1,
      previous?.output?.line ?? -1,
      previous?.end?.line ?? -1,
    );
    if (above.line >= floor) return above;
    above.dispose();
    return at.anchor();
  }

  #commandEnd(exitCode: number | undefined, at: MarkCursor<A>): void {
    this.#endRunning(exitCode, at);
  }

  /**
   * The newest mark. A prompt waiting for its command or a command that runs is always the newest:
   * a new prompt only comes after the command running before it was ended.
   */
  #last(): MutableMark<A> | undefined {
    return this.#marks[this.#marks.length - 1];
  }

  /** Ends the command that is running, if there is one. */
  #endRunning(exitCode: number | undefined, at: MarkCursor<A>): void {
    const mark = this.#last();
    if (mark?.state !== "running") return;
    mark.end = at.anchor();
    mark.endsMidLine = at.column > 0;
    mark.exitCode = exitCode;
    mark.state = "done";
    this.#options.onChange?.({ kind: "end", mark });
  }

  #create(prompt: A): MutableMark<A> {
    return {
      id: this.#nextId++,
      state: "prompt",
      prompt,
      output: undefined,
      end: undefined,
      endsMidLine: false,
      exitCode: undefined,
      announced: false,
    };
  }

  /**
   * Removes the oldest marks none of whose rows is kept any more (the scrollback trims from the
   * top, so a newer mark never outlives an older one). A command that still runs stays: its output
   * may have scrolled past the whole scrollback, and its end is still to come.
   */
  #prune(): void {
    for (let first = this.#marks[0]; first !== undefined; first = this.#marks[0]) {
      const rows = [first.prompt, first.output, first.end];
      if (
        first.state === "running" ||
        rows.some((anchor) => anchor !== undefined && anchor.line >= 0)
      ) {
        return;
      }
      this.#drop(first);
    }
  }

  #drop(mark: MutableMark<A>): void {
    const at = this.#marks.indexOf(mark);
    if (at >= 0) this.#marks.splice(at, 1);
    this.#release(mark, false);
  }

  #release(mark: MutableMark<A>, silent: boolean): void {
    if (this.#current === mark) this.#current = undefined;
    mark.prompt.dispose();
    mark.output?.dispose();
    mark.end?.dispose();
    if (mark.announced && !silent) this.#options.onChange?.({ kind: "remove", mark });
  }
}

/** One row of a terminal buffer, as a terminal gives it. */
export interface BufferRow {
  /** The text of the row without the empty cells at its end. */
  readonly text: string;
  /** True when the row continues the line above it (a long line the terminal wrapped). */
  readonly wrapped: boolean;
}

/**
 * The text of `count` rows from `first`: one line per logical line, so a line the terminal wrapped
 * is joined again. Rows that do not exist give no text; the result has no trailing line break.
 */
export function joinRows(
  read: (row: number) => BufferRow | undefined,
  first: number,
  count: number,
): string {
  let text = "";
  for (let i = 0; i < count; i++) {
    const row = read(first + i);
    if (row === undefined) continue;
    if (i > 0 && !row.wrapped) text += "\n";
    text += row.text;
  }
  return text;
}

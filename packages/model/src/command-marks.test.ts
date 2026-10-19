import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CommandMarks, joinRows, markFailed } from "./command-marks";
import type { CommandMark, LineAnchor, MarkChange, MarkView } from "./command-marks";
import type { ShellEvent } from "./shell-integration";

/** An anchor whose row the test moves or trims (`line = -1`) by hand. */
class Anchor implements LineAnchor {
  disposed = false;
  constructor(public line: number) {}
  dispose(): void {
    this.disposed = true;
    this.line = -1;
  }
}

const A: ShellEvent = { kind: "prompt-start" };
const C: ShellEvent = { kind: "command-start" };
const D = (exitCode?: number): ShellEvent => ({ kind: "command-end", exitCode });

/** A terminal reduced to its cursor: rows go down as lines are printed. */
function setup() {
  const anchors: Anchor[] = [];
  const changes: MarkChange<Anchor>[] = [];
  const marks = new CommandMarks<Anchor>({ onChange: (change) => changes.push(change) });
  let row = 0;
  let column = 0;
  const at = () => ({
    anchor: (offset = 0) => {
      const anchor = new Anchor(row + offset);
      anchors.push(anchor);
      return anchor;
    },
    column,
  });
  const screen = {
    get row() {
      return row;
    },
    /** The shell reports `event` with the cursor where it is. */
    event(event: ShellEvent): void {
      marks.handle(event, at());
    },
    /** Text on the current row. */
    print(text: string): void {
      column += text.length;
    },
    /** Line breaks (the cursor goes to the start of a later row). */
    newline(count = 1): void {
      row += count;
      column = 0;
    },
    /** The cursor goes back up to the start of an earlier row (a clear, a redraw from the top). */
    moveTo(target: number): void {
      row = Math.max(0, target);
      column = 0;
    },
    /** A full command: prompt, typed line, output rows, end. */
    command(output: number, exitCode?: number): CommandMark<Anchor> {
      screen.event(A);
      screen.print("$ cmd");
      screen.newline();
      screen.event(C);
      screen.newline(output);
      screen.event(D(exitCode));
      const mark = marks.commands().at(-1);
      if (mark === undefined) throw new Error("no command");
      return mark;
    },
  };
  return { marks, screen, anchors, changes };
}

const view = (top: number, bottom: number): MarkView => ({ top, bottom });

describe("CommandMarks", () => {
  it("follows a command from its prompt to its end", () => {
    const { marks, screen, changes } = setup();
    screen.event(A);
    screen.print("$ ls");
    screen.newline();
    expect(marks.commands()).toEqual([]);
    screen.event(C);
    expect(marks.commands().map((mark) => mark.state)).toEqual(["running"]);
    screen.newline(3);
    screen.event(D(0));

    const [mark] = marks.commands();
    expect(mark?.state).toBe("done");
    expect(mark?.exitCode).toBe(0);
    expect(mark?.prompt.line).toBe(0);
    expect(mark?.output?.line).toBe(1);
    expect(mark?.end?.line).toBe(4);
    expect(mark && marks.outputRows(mark)).toEqual({ first: 1, count: 3, truncated: false });
    expect(changes.map((change) => change.kind)).toEqual(["start", "end"]);
    expect(markFailed(mark ?? { state: "prompt", exitCode: undefined })).toBe(false);
  });

  it("marks a command that ended with a code other than 0 as failed, and one with no code as not", () => {
    const { marks, screen } = setup();
    screen.command(0, 1);
    screen.command(0, 0);
    screen.command(0, undefined);
    screen.command(0, -1);
    expect(marks.commands().map((mark) => markFailed(mark))).toEqual([true, false, false, true]);
    expect(markFailed({ state: "running", exitCode: 1 })).toBe(false);
  });

  it("a command with no output has no rows", () => {
    const { marks, screen } = setup();
    const mark = screen.command(0, 1);
    expect(marks.outputRows(mark)).toEqual({ first: 1, count: 0, truncated: false });
  });

  it("the row of the end is part of the output when the cursor is not at its start", () => {
    const { marks, screen } = setup();
    screen.event(A);
    screen.newline();
    screen.event(C);
    screen.print("no newline at the end");
    screen.event(D(0));
    const [mark] = marks.commands();
    expect(mark && marks.outputRows(mark)).toEqual({ first: 1, count: 1, truncated: false });
  });

  it("a prompt with no command is not a mark, and the next prompt replaces it", () => {
    const { marks, screen, anchors, changes } = setup();
    screen.event(A);
    screen.print("$ ");
    screen.newline();
    screen.event(A);
    screen.newline();
    screen.event(A);
    expect(marks.commands()).toEqual([]);
    expect(changes).toEqual([]);
    // The first two prompts were let go; only the last one keeps its anchor.
    expect(anchors.map((anchor) => anchor.disposed)).toEqual([true, true, false]);
  });

  it("a prompt on a row that older commands occupy drops them: the screen was cleared", () => {
    const { marks, screen, changes } = setup();
    screen.command(3, 0);
    screen.command(3, 1);
    screen.command(3, 0);
    expect(marks.commands().map((mark) => mark.prompt.line)).toEqual([0, 4, 8]);
    // A `clear` homes the cursor: the next prompt is on row 4, over the second command.
    screen.moveTo(4);
    screen.event(A);
    expect(marks.commands().map((mark) => mark.prompt.line)).toEqual([0]);
    expect(changes.filter((change) => change.kind === "remove")).toHaveLength(2);
    screen.print("$ ");
    screen.newline();
    screen.event(C);
    screen.newline();
    screen.event(D(0));
    expect(marks.commands().map((mark) => mark.prompt.line)).toEqual([0, 4]);
  });

  it("a prompt back at the very top drops every mark", () => {
    const { marks, screen } = setup();
    screen.command(2, 0);
    screen.command(2, 1);
    screen.moveTo(0);
    screen.event(A);
    expect(marks.commands()).toEqual([]);
  });

  it("a start with no prompt keeps the marks in order when the cursor went back up", () => {
    const { marks, screen } = setup();
    screen.command(3, 0);
    screen.moveTo(1);
    screen.event(C);
    screen.newline();
    screen.event(D(0));
    const lines = marks.commands().map((mark) => mark.prompt.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("an empty prompt between two commands does not get in the way", () => {
    const { marks, screen } = setup();
    screen.command(1, 0);
    screen.event(A);
    screen.newline();
    screen.command(2, 3);
    expect(marks.commands().map((mark) => mark.exitCode)).toEqual([0, 3]);
  });

  it("an end with no command running is not a command", () => {
    const { marks, screen, changes } = setup();
    // The first prompt of some shells ends a command that never was.
    screen.event(D(0));
    screen.event(A);
    screen.event(D(2));
    expect(marks.commands()).toEqual([]);
    expect(changes).toEqual([]);
    // The prompt is still there for the command that follows.
    screen.newline();
    screen.event(C);
    screen.newline();
    screen.event(D(5));
    expect(marks.commands().map((mark) => [mark.prompt.line, mark.exitCode])).toEqual([[0, 5]]);
  });

  it("a command that starts with no prompt before it takes the row above as its prompt", () => {
    const { marks, screen } = setup();
    screen.newline(4);
    screen.event(C);
    screen.newline();
    screen.event(D(0));
    const [mark] = marks.commands();
    expect(mark?.prompt.line).toBe(3);
    expect(mark && marks.outputRows(mark)).toEqual({ first: 4, count: 1, truncated: false });
  });

  it("a command that starts on the first row has no prompt row to go to, but keeps its output", () => {
    const { marks, screen } = setup();
    screen.event(C);
    screen.newline(2);
    screen.event(D(1));
    expect(marks.commands()).toEqual([]);
    const done = marks.lastFinished();
    expect(done && marks.outputRows(done)).toEqual({ first: 0, count: 2, truncated: false });
  });

  it("a prompt that shows while a command runs ends it without an exit code", () => {
    const { marks, screen, changes } = setup();
    screen.event(A);
    screen.newline();
    screen.event(C);
    screen.newline(2);
    screen.event(A);
    const [mark] = marks.commands();
    expect(mark?.state).toBe("done");
    expect(mark?.exitCode).toBeUndefined();
    expect(mark && markFailed(mark)).toBe(false);
    expect(mark && marks.outputRows(mark)).toEqual({ first: 1, count: 2, truncated: false });
    expect(changes.map((change) => change.kind)).toEqual(["start", "end"]);
  });

  it("a second start ends the first command", () => {
    const { marks, screen } = setup();
    screen.event(A);
    screen.newline();
    screen.event(C);
    screen.newline();
    screen.event(C);
    screen.newline();
    screen.event(D(0));
    expect(marks.commands().map((mark) => mark.state)).toEqual(["done", "done"]);
  });

  it("reports the last command that ended, not one that still runs", () => {
    const { marks, screen } = setup();
    const first = screen.command(1, 0);
    screen.event(A);
    screen.newline();
    screen.event(C);
    expect(marks.lastFinished()).toBe(first);
    expect(marks.commands().at(-1)?.state).toBe("running");
  });

  describe("scrollback that is trimmed", () => {
    it("drops a command from the prompts but keeps its output while the output rows are kept", () => {
      const { marks, screen } = setup();
      const mark = screen.command(2, 0);
      mark.prompt.dispose();
      expect(marks.commands()).toEqual([]);
      expect(marks.lastFinished()).toBe(mark);
      expect(marks.outputRows(mark)).toEqual({ first: 1, count: 2, truncated: false });
    });

    it("an output whose start is trimmed begins at the oldest row kept and says so", () => {
      const { marks, screen } = setup();
      const mark = screen.command(5, 0);
      mark.prompt.dispose();
      mark.output?.dispose();
      // Rows 0 to 2 are gone; the end anchor moved up to row 3 with the buffer.
      if (mark.end instanceof Anchor) mark.end.line = 3;
      expect(marks.outputRows(mark)).toEqual({ first: 0, count: 3, truncated: true });
    });

    it("a command whose rows are all trimmed is gone, and the interface is told once", () => {
      const { marks, screen, changes } = setup();
      const mark = screen.command(1, 0);
      screen.command(1, 0);
      for (const anchor of [mark.prompt, mark.output, mark.end]) anchor?.dispose();
      expect(marks.commands()).toHaveLength(1);
      expect(marks.lastFinished()).not.toBe(mark);
      expect(changes.filter((change) => change.kind === "remove")).toHaveLength(1);
      expect(changes.at(-1)?.mark).toBe(mark);
      expect(marks.outputRows(mark)).toBeUndefined();
    });

    it("a command that runs keeps its mark when its rows scroll away, and still ends", () => {
      const { marks, screen, changes } = setup();
      screen.event(A);
      screen.newline();
      screen.event(C);
      const [mark] = [...marks.commands()];
      for (const anchor of [mark?.prompt, mark?.output]) anchor?.dispose();
      screen.newline(50);
      expect(marks.commands()).toEqual([]);
      screen.event(D(2));
      expect(changes.map((change) => change.kind)).toEqual(["start", "end"]);
      const done = marks.lastFinished();
      expect(done?.exitCode).toBe(2);
      expect(done && marks.outputRows(done)).toEqual({ first: 0, count: 51, truncated: true });
    });

    it("rows that scroll away one at a time", () => {
      const { marks, screen } = setup();
      const first = screen.command(2, 0);
      const second = screen.command(2, 1);
      const rows = (mark: CommandMark<Anchor>) =>
        [mark.prompt, mark.output, mark.end].map((a) => a?.line);
      expect(rows(first)).toEqual([0, 1, 3]);
      expect(rows(second)).toEqual([3, 4, 6]);
      // The buffer drops its oldest 2 rows: markers on them are disposed, the others move up.
      for (const anchor of [first.prompt, first.output]) anchor?.dispose();
      for (const mark of [first, second]) {
        for (const anchor of [mark.end, mark.prompt, mark.output]) {
          if (anchor instanceof Anchor && anchor.line >= 0) anchor.line -= 2;
        }
      }
      expect(marks.commands()).toEqual([second]);
      expect(marks.outputRows(first)).toEqual({ first: 0, count: 1, truncated: true });
      expect(marks.outputRows(second)).toEqual({ first: 2, count: 2, truncated: false });
    });
  });

  describe("steps between prompts", () => {
    /** Three commands with prompts on rows 0, 4 and 8; the cursor ends on row 12. */
    function three() {
      const { marks, screen } = setup();
      const commands = [screen.command(3, 0), screen.command(3, 1), screen.command(3, 0)];
      return { marks, commands };
    }

    it("puts the prompts on the rows the other tests rely on", () => {
      const { commands } = three();
      expect(commands.map((mark) => mark.prompt.line)).toEqual([0, 4, 8]);
    });

    it("from the live end the previous prompt is the last command, and again the one before", () => {
      const { marks, commands } = three();
      expect(marks.step("previous", view(10, 10))).toEqual({ kind: "mark", mark: commands[2] });
      expect(marks.current).toBe(commands[2]);
      // The view now sits on that prompt (row 8), as the terminal would have scrolled it.
      expect(marks.step("previous", view(8, 10))).toEqual({ kind: "mark", mark: commands[1] });
      expect(marks.step("previous", view(4, 10))).toEqual({ kind: "mark", mark: commands[0] });
      expect(marks.step("previous", view(0, 10))).toEqual({ kind: "none" });
      expect(marks.current).toBe(commands[0]);
    });

    it("goes forward and past the last prompt to the live end", () => {
      const { marks, commands } = three();
      marks.step("previous", view(10, 10));
      marks.step("previous", view(8, 10));
      expect(marks.step("next", view(4, 10))).toEqual({ kind: "mark", mark: commands[2] });
      expect(marks.step("next", view(8, 10))).toEqual({ kind: "bottom" });
      expect(marks.current).toBeUndefined();
      expect(marks.step("next", view(10, 10))).toEqual({ kind: "none" });
    });

    it("a prompt too near the end to reach the top still counts as reached", () => {
      const { marks, commands } = three();
      // Row 8 cannot be at the top of a view that can only go down to row 6.
      marks.step("previous", view(6, 6));
      expect(marks.current).toBe(commands[2]);
      expect(marks.step("previous", view(6, 6))).toEqual({ kind: "mark", mark: commands[1] });
    });

    it("after the user scrolled, the step is relative to the top of the view", () => {
      const { marks, commands } = three();
      marks.step("previous", view(10, 10));
      // The view is on row 6, not where the last step put it.
      expect(marks.step("previous", view(6, 10))).toEqual({ kind: "mark", mark: commands[1] });
      marks.clearCurrent();
      expect(marks.step("next", view(6, 10))).toEqual({ kind: "mark", mark: commands[2] });
      marks.clearCurrent();
      expect(marks.step("next", view(9, 10))).toEqual({ kind: "bottom" });
      marks.clearCurrent();
      expect(marks.step("previous", view(0, 10))).toEqual({ kind: "none" });
      expect(marks.step("previous", view(3, 10))).toEqual({ kind: "mark", mark: commands[0] });
    });

    it("the current command is only current while the view is on its prompt", () => {
      const { marks, commands } = three();
      expect(marks.currentIn(view(10, 10))).toBeUndefined();
      marks.step("previous", view(10, 10));
      expect(marks.currentIn(view(8, 10))).toBe(commands[2]);
      // Clamped at the end: row 8 cannot be the top of a view that goes down to row 6 only.
      expect(marks.currentIn(view(6, 6))).toBe(commands[2]);
      // The user scrolled, or typed and the view went back to the live end.
      expect(marks.currentIn(view(5, 10))).toBeUndefined();
      expect(marks.currentIn(view(10, 10))).toBeUndefined();
      // The command is still the one stepped from, though, once the view is back on it.
      expect(marks.currentIn(view(8, 10))).toBe(commands[2]);
    });

    it("has nowhere to go with no command, and forgets a current command that was trimmed", () => {
      const { marks, commands } = three();
      const none = setup().marks;
      expect(none.step("previous", view(0, 0))).toEqual({ kind: "none" });
      expect(none.step("next", view(0, 0))).toEqual({ kind: "none" });

      marks.step("previous", view(10, 10));
      for (const mark of commands) {
        for (const anchor of [mark.prompt, mark.output, mark.end]) anchor?.dispose();
      }
      expect(marks.current).toBeUndefined();
      expect(marks.step("previous", view(10, 10))).toEqual({ kind: "none" });
    });
  });

  it("clears every mark and tells the interface about the ones it drew", () => {
    const { marks, screen, anchors, changes } = setup();
    const first = screen.command(1, 0);
    screen.command(1, 1);
    screen.event(A);
    marks.step("previous", view(10, 10));
    marks.clear();
    expect(anchors.every((anchor) => anchor.disposed)).toBe(true);
    expect(
      changes.filter((change) => change.kind === "remove").map((change) => change.mark.id),
    ).toEqual([first.id, first.id + 1]);
    expect(marks.commands()).toEqual([]);
    expect(marks.current).toBeUndefined();
    // It works again afterwards.
    screen.command(1, 0);
    expect(marks.commands()).toHaveLength(1);
  });

  it("releases every anchor on dispose, without telling the interface", () => {
    const { marks, screen, anchors, changes } = setup();
    screen.command(1, 0);
    screen.event(A);
    const before = changes.length;
    marks.dispose();
    expect(anchors.every((anchor) => anchor.disposed)).toBe(true);
    expect(changes).toHaveLength(before);
    expect(marks.commands()).toEqual([]);
  });

  it("keeps its invariants under any order of events", () => {
    const event = fc.oneof(
      fc.constant<ShellEvent>(A),
      fc.constant<ShellEvent>(C),
      fc.constant<ShellEvent>({ kind: "prompt-end" }),
      fc.constant<ShellEvent>({ kind: "command-line", text: "x" }),
      fc.constantFrom<ShellEvent>(D(0), D(1), D(undefined)),
    );
    const step = fc.record({
      event,
      rows: fc.integer({ min: 0, max: 3 }),
      text: fc.boolean(),
      back: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const { marks, screen } = setup();
        for (const { event: e, rows, text, back } of steps) {
          if (back !== undefined) screen.moveTo(back);
          if (text) screen.print("x");
          screen.newline(rows);
          screen.event(e);
        }
        const commands = marks.commands();
        // At most one command runs, the prompts are in order and a finished command has output rows.
        expect(commands.filter((mark) => mark.state === "running").length).toBeLessThanOrEqual(1);
        const lines = commands.map((mark) => mark.prompt.line);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
        for (const mark of commands) {
          if (mark.state === "done") {
            const rows = marks.outputRows(mark);
            expect(rows?.count).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("joinRows", () => {
  const rows = [
    { text: "one", wrapped: false },
    { text: "two ", wrapped: false },
    { text: "continued", wrapped: true },
    { text: "", wrapped: false },
    { text: "five", wrapped: false },
  ];
  const read = (row: number) => rows[row];

  it("joins the rows with line breaks and a wrapped row to the one above it", () => {
    expect(joinRows(read, 0, 5)).toBe("one\ntwo continued\n\nfive");
    expect(joinRows(read, 1, 2)).toBe("two continued");
  });

  it("has no text for no rows and skips rows that do not exist", () => {
    expect(joinRows(read, 2, 0)).toBe("");
    expect(joinRows(read, 4, 3)).toBe("five");
  });
});

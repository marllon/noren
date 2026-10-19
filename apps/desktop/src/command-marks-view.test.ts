import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCommandMarks, markColors } from "./command-marks-view";
import type { TerminalCommandMarks } from "./command-marks-view";

// The terminal of xterm.js runs without a page, so these tests read the shell marks from the real
// parser, the real markers and the real scrollback, with no window.

const ESC = "\x1b";
const BEL = "\x07";
const osc = (body: string): string => `${ESC}]${body}${BEL}`;

const RED = "#e06c75";
const COLORS = { ok: "#98c379", failed: RED, running: "#e5c07b" };

/** What the fake shell of the web build prints for one command line: prompt, line, output, end. */
function command(line: string, output: string[], exitCode: number): string {
  return (
    osc("133;A") +
    "fake$ " +
    osc("133;B") +
    line +
    "\r\n" +
    osc(`633;E;${line}`) +
    osc("133;C") +
    output.map((text) => `${text}\r\n`).join("") +
    osc(`133;D;${exitCode}`)
  );
}

const THREE =
  command("echo one", ["one"], 0) + command("false", [], 1) + command("ls", ["a  b", "c"], 0);

const terminals: Terminal[] = [];
const attached: TerminalCommandMarks[] = [];

function make(options: { rows?: number; cols?: number; scrollback?: number } = {}) {
  const term = new Terminal({
    allowProposedApi: true,
    cols: options.cols ?? 40,
    rows: options.rows ?? 10,
    scrollback: options.scrollback ?? 100,
  });
  const marks = attachCommandMarks(term, COLORS);
  terminals.push(term);
  attached.push(marks);
  return { term, marks };
}

/** Writes in order and waits until the terminal has parsed it all. */
function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

afterEach(() => {
  for (const marks of attached.splice(0)) marks.dispose();
  for (const term of terminals.splice(0)) term.dispose();
});

describe("the marks of a terminal", () => {
  it("marks every command at its prompt and the failed one in red, in the ruler too", async () => {
    const { term, marks } = make();
    await write(term, THREE);
    expect(marks.marks()).toEqual([
      {
        row: 0,
        text: "fake$ echo one",
        state: "done",
        exitCode: 0,
        failed: false,
        ruler: false,
        current: false,
        outputRows: 1,
      },
      {
        row: 2,
        text: "fake$ false",
        state: "done",
        exitCode: 1,
        failed: true,
        ruler: true,
        current: false,
        outputRows: 0,
      },
      {
        row: 3,
        text: "fake$ ls",
        state: "done",
        exitCode: 0,
        failed: false,
        ruler: false,
        current: false,
        outputRows: 2,
      },
    ]);
  });

  it("gives the same marks however the output is cut", async () => {
    const bytes = new TextEncoder().encode(THREE + osc("133;A") + "fake$ ");
    const whole = make();
    await write(whole.term, bytes);
    const expected = whole.marks.marks();
    const expectedOutput = whole.marks.lastOutput();
    expect(expected).toHaveLength(3);
    expect(expectedOutput?.text).toBe("a  b\nc");

    for (let cut = 1; cut < bytes.length; cut++) {
      const { term, marks } = make();
      await write(term, bytes.subarray(0, cut));
      await write(term, bytes.subarray(cut));
      expect(marks.marks(), `cut at byte ${cut}`).toEqual(expected);
      expect(marks.lastOutput(), `cut at byte ${cut}`).toEqual(expectedOutput);
      marks.dispose();
      term.dispose();
    }
  }, 30_000);

  it("shows a command that runs as running, with no ruler mark, until it ends", async () => {
    const { term, marks } = make();
    await write(term, osc("133;A") + "fake$ sleep 3\r\n" + osc("133;C"));
    expect(marks.marks().map((m) => [m.state, m.failed, m.ruler, m.outputRows])).toEqual([
      ["running", false, false, 0],
    ]);
    expect(marks.lastOutput()).toBeUndefined();
    await write(term, osc("133;D;2"));
    expect(marks.marks().map((m) => [m.state, m.failed, m.ruler])).toEqual([["done", true, true]]);
  });

  it("an empty prompt is not a mark", async () => {
    const { term, marks } = make();
    await write(term, osc("133;A") + "fake$ \r\n" + osc("133;A") + "fake$ \r\n" + osc("133;A"));
    expect(marks.marks()).toEqual([]);
    expect(marks.jump("previous")).toBe(false);
    expect(marks.lastOutput()).toBeUndefined();
    await write(term, command("true", [], 0));
    expect(marks.marks().map((m) => m.text)).toEqual(["fake$ true"]);
  });

  it("an end with no start is not a command, and the next one still is", async () => {
    const { term, marks } = make();
    await write(term, osc("133;D;1") + osc("133;A") + "fake$ \r\n" + osc("133;D;3"));
    expect(marks.marks()).toEqual([]);
    await write(term, command("echo x", ["x"], 0));
    expect(marks.marks().map((m) => [m.row, m.exitCode])).toEqual([[1, 0]]);
  });

  it("a command whose prompt was never seen takes the row of the typed line as its prompt", async () => {
    const { term, marks } = make();
    // The terminal came up after the prompt was shown: only the start and the end arrive.
    await write(term, "fake$ ls\r\n" + osc("133;C") + "a  b\r\n" + osc("133;D;0"));
    expect(marks.marks().map((m) => [m.row, m.text, m.outputRows])).toEqual([[0, "fake$ ls", 1]]);
    expect(marks.lastOutput()?.text).toBe("a  b");
  });

  it("reads the output of a command that ends in the middle of a row", async () => {
    const { term, marks } = make();
    await write(term, osc("133;A") + "fake$ printf hi\r\n" + osc("133;C") + "hi" + osc("133;D;0"));
    expect(marks.lastOutput()).toEqual({ text: "hi", rows: 1, truncated: false, exitCode: 0 });
  });

  it("joins a long line the terminal wrapped, and keeps blank lines", async () => {
    const { term, marks } = make({ cols: 10 });
    await write(
      term,
      osc("133;A") + "$ x\r\n" + osc("133;C") + "0123456789abcdef\r\n\r\nend\r\n" + osc("133;D;0"),
    );
    expect(marks.lastOutput()?.text).toBe("0123456789abcdef\n\nend");
    expect(marks.lastOutput()?.rows).toBe(4);
  });

  it("ignores the marks of a program on the alternate screen", async () => {
    const { term, marks } = make();
    await write(term, `${ESC}[?1049h` + command("inside", ["x"], 1) + `${ESC}[?1049l`);
    expect(marks.marks()).toEqual([]);
    expect(marks.jump("previous")).toBe(false);
  });

  it("ignores sequences that are not marks, and marks with a bad code", async () => {
    const { term, marks } = make();
    await write(term, osc("133;Z") + osc("133;") + osc("133") + osc("9;4;1;50"));
    await write(term, command("odd", ["o"], 0).replace(";D;0", ";D;abc"));
    expect(marks.marks().map((m) => [m.state, m.exitCode, m.failed])).toEqual([
      ["done", undefined, false],
    ]);
  });
});

describe("scrollback that is trimmed", () => {
  it("drops the marks that scrolled out and keeps the rest, with a truncated output", async () => {
    const { term, marks } = make({ rows: 4, scrollback: 6 });
    await write(term, command("first", ["f1"], 0));
    await write(term, command("second", ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"], 1));
    // 12 rows in a buffer of 4 + 6: the oldest two rows are gone with the first command.
    const rows = marks.marks();
    expect(rows.map((m) => m.text)).toEqual(["fake$ second"]);
    expect(rows[0]?.failed).toBe(true);
    expect(rows[0]?.outputRows).toBe(8);
    expect(marks.lastOutput()?.text).toBe("s1\ns2\ns3\ns4\ns5\ns6\ns7\ns8");
    expect(marks.lastOutput()?.truncated).toBe(false);
  });

  it("an output longer than the scrollback gives its end and says it was cut", async () => {
    const { term, marks } = make({ rows: 4, scrollback: 6 });
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`);
    await write(term, command("seq", lines, 0));
    expect(marks.marks()).toEqual([]);
    const output = marks.lastOutput();
    expect(output?.truncated).toBe(true);
    expect(output?.text.split("\n").at(-1)).toBe("row 30");
    expect(output?.rows).toBeLessThanOrEqual(10);
    expect(output?.text.startsWith("row 1\n")).toBe(false);
  });

  it("forgets the commands whose rows the terminal clears from its scrollback", async () => {
    const { term, marks } = make({ rows: 4 });
    await write(term, THREE);
    expect(marks.marks()).toHaveLength(3);
    // Seven rows in a view of four: the first three are scrollback, and `CSI 3 J` erases them.
    await write(term, `${ESC}[3J`);
    expect(marks.marks().map((m) => [m.row, m.text])).toEqual([[0, "fake$ ls"]]);
    expect(marks.lastOutput()?.text).toBe("a  b\nc");
  });

  it("forgets the commands that a clear screen wiped, and goes on with the new prompt", async () => {
    const { term, marks } = make({ rows: 10 });
    await write(term, THREE);
    expect(marks.marks()).toHaveLength(3);
    // `clear`: the cursor homes, the screen is erased, and the next prompt is on the first row.
    await write(
      term,
      osc("133;A") +
        "fake$ clear\r\n" +
        osc("133;C") +
        `${ESC}[H${ESC}[2J` +
        osc("133;D;0") +
        osc("133;A") +
        "fake$ ",
    );
    expect(marks.marks()).toEqual([]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("fake$ ");
    await write(term, "echo new\r\n" + osc("133;C") + "new\r\n" + osc("133;D;0"));
    expect(marks.marks().map((m) => [m.row, m.text, m.outputRows])).toEqual([
      [0, "fake$ echo new", 1],
    ]);
    expect(marks.lastOutput()?.text).toBe("new");
  });

  it("forgets everything when the terminal is reset", async () => {
    const { term, marks } = make({ rows: 4 });
    await write(term, THREE);
    expect(marks.marks()).toHaveLength(3);
    await write(term, `${ESC}c`);
    expect(marks.marks()).toEqual([]);
    expect(marks.lastOutput()).toBeUndefined();
    // The shell goes on after the reset.
    await write(term, command("again", ["x"], 0));
    expect(marks.marks().map((m) => m.text)).toEqual(["fake$ again"]);
  });
});

describe("moving between prompts", () => {
  /** Ten commands on a terminal 5 rows tall, so the view can sit anywhere in the scrollback. */
  async function many() {
    const made = make({ rows: 5 });
    let text = "";
    for (let i = 1; i <= 10; i++)
      text += command(`cmd ${i}`, [`out ${i}a`, `out ${i}b`], i === 4 ? 1 : 0);
    await write(made.term, text + osc("133;A") + "fake$ ");
    return made;
  }

  it("goes to the previous prompt, step by step, and back to the live end", async () => {
    const { term, marks } = await many();
    const buffer = term.buffer.active;
    expect(buffer.viewportY).toBe(buffer.baseY);
    const rows = marks.marks().map((m) => m.row);
    expect(rows).toHaveLength(10);

    expect(marks.jump("previous")).toBe(true);
    expect(marks.marks().findIndex((m) => m.current)).toBe(9);
    expect(buffer.viewportY).toBe(Math.min(rows[9] ?? 0, buffer.baseY));
    expect(marks.jump("previous")).toBe(true);
    expect(marks.marks().findIndex((m) => m.current)).toBe(8);
    expect(buffer.viewportY).toBe(rows[8]);
    expect(marks.jump("next")).toBe(true);
    expect(marks.marks().findIndex((m) => m.current)).toBe(9);
    expect(marks.jump("next")).toBe(true);
    expect(marks.marks().some((m) => m.current)).toBe(false);
    expect(buffer.viewportY).toBe(buffer.baseY);
  });

  it("stops at the first prompt and still answers true: the key belongs to us", async () => {
    const { term, marks } = await many();
    for (let i = 0; i < 20; i++) marks.jump("previous");
    expect(marks.marks().findIndex((m) => m.current)).toBe(0);
    expect(term.buffer.active.viewportY).toBe(0);
    expect(marks.jump("previous")).toBe(true);
    expect(term.buffer.active.viewportY).toBe(0);
  });

  it("steps from where the view was scrolled to", async () => {
    const { term, marks } = await many();
    term.scrollToLine(12);
    expect(marks.jump("previous")).toBe(true);
    const current = marks.marks().find((m) => m.current);
    expect(current?.row).toBeLessThan(12);
    expect(term.buffer.active.viewportY).toBe(current?.row);
    term.scrollToLine(12);
    expect(marks.jump("next")).toBe(true);
    expect(marks.marks().find((m) => m.current)?.row).toBeGreaterThan(12);
  });
});

describe("the output of a command", () => {
  it("selects the output rows of the last command that ended", async () => {
    const { term, marks } = make();
    const select = vi.spyOn(term, "selectLines");
    await write(term, THREE + osc("133;A") + "fake$ ");
    expect(marks.selectOutput()).toBe(true);
    // `ls` printed 2 rows, from row 4 to row 5.
    expect(select).toHaveBeenLastCalledWith(4, 5);
  });

  it("selects the output of the prompt the user stepped to", async () => {
    const { term, marks } = make();
    const select = vi.spyOn(term, "selectLines");
    await write(term, THREE + osc("133;A") + "fake$ ");
    marks.jump("previous");
    marks.jump("previous");
    // The middle command, `false`, printed nothing; the step after it is `echo one` with 1 row.
    expect(marks.selectOutput()).toBe(false);
    marks.jump("previous");
    expect(marks.selectOutput()).toBe(true);
    expect(select).toHaveBeenLastCalledWith(1, 1);
  });

  it("has nothing to select or copy before a command ends", async () => {
    const { term, marks } = make();
    await write(term, osc("133;A") + "fake$ ");
    expect(marks.selectOutput()).toBe(false);
    expect(marks.lastOutput()).toBeUndefined();
  });

  it("gives the text of the last command and empty text for a command with no output", async () => {
    const { term, marks } = make();
    await write(term, command("echo hello world", ["hello world"], 0));
    expect(marks.lastOutput()).toEqual({
      text: "hello world",
      rows: 1,
      truncated: false,
      exitCode: 0,
    });
    await write(term, command("false", [], 1));
    expect(marks.lastOutput()).toEqual({ text: "", rows: 0, truncated: false, exitCode: 1 });
  });
});

describe("colors", () => {
  it("come from the theme and fall back when it has none", () => {
    expect(markColors({ red: "#111111", green: "#222222", yellow: "#333333" })).toEqual({
      failed: "#111111",
      ok: "#222222",
      running: "#333333",
    });
    expect(markColors({})).toEqual({ failed: "#e06c75", ok: "#98c379", running: "#e5c07b" });
  });

  it("repaint the ruler mark of a failed command when the theme changes", async () => {
    const { term, marks } = make();
    await write(term, command("false", [], 1));
    const before = marks.marks();
    marks.setColors({ ...COLORS, failed: "#ff0000" });
    expect(marks.marks()).toEqual(before);
  });
});

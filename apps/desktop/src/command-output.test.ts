import { describe, expect, it } from "vitest";
import { planCopy } from "./command-output";

describe("planCopy", () => {
  it("copies the text of the last command", () => {
    expect(planCopy({ text: "hello", rows: 1, truncated: false, exitCode: 0 })).toEqual({
      text: "hello",
      notice: "Copied the output of the last command",
    });
  });

  it("copies what is left of an output that was cut, and says so", () => {
    const plan = planCopy({ text: "tail", rows: 1, truncated: true });
    expect(plan.text).toBe("tail");
    expect(plan.notice).toContain("start is past the scrollback limit");
  });

  it("copies nothing for a command that printed nothing, and says so", () => {
    const plan = planCopy({ text: "", rows: 0, truncated: false, exitCode: 1 });
    expect(plan.text).toBeUndefined();
    expect(plan.notice).toBe("The last command printed no output");
  });

  it("copies nothing before a command has ended", () => {
    const plan = planCopy(undefined);
    expect(plan.text).toBeUndefined();
    expect(plan.notice).toBe("No command has finished in this pane yet");
  });

  it("keeps blank lines and the exact text", () => {
    const text = "a\n\n  indented\n";
    expect(planCopy({ text, rows: 4, truncated: false }).text).toBe(text);
  });
});

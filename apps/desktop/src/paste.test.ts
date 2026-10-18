import { describe, expect, it } from "vitest";
import { countLines, decidePaste, needsPasteConfirmation, previewPaste } from "./paste";

describe("countLines", () => {
  it("counts no lines in empty text", () => {
    expect(countLines("")).toBe(0);
  });

  it("counts a single line with or without a trailing break", () => {
    expect(countLines("ls")).toBe(1);
    expect(countLines("ls\n")).toBe(1);
    expect(countLines("ls\r\n")).toBe(1);
  });

  it("counts lines separated by LF, CR and CRLF", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\rb\rc")).toBe(3);
    expect(countLines("a\r\nb\r\nc")).toBe(3);
    expect(countLines("a\r\nb\nc\rd")).toBe(4);
  });

  it("counts blank lines in the middle", () => {
    expect(countLines("a\n\nb")).toBe(3);
    expect(countLines("\n")).toBe(1);
  });
});

describe("needsPasteConfirmation", () => {
  it("only asks for more than one line", () => {
    expect(needsPasteConfirmation("")).toBe(false);
    expect(needsPasteConfirmation("one")).toBe(false);
    expect(needsPasteConfirmation("one\n")).toBe(false);
    expect(needsPasteConfirmation("one\ntwo")).toBe(true);
    expect(needsPasteConfirmation("one\ntwo\nthree")).toBe(true);
  });
});

describe("decidePaste", () => {
  it("ignores empty text, sends one line and confirms several", () => {
    expect(decidePaste("")).toBe("ignore");
    expect(decidePaste("pwd")).toBe("send");
    expect(decidePaste("pwd\n")).toBe("send");
    expect(decidePaste("pwd\nls")).toBe("confirm");
  });
});

describe("previewPaste", () => {
  it("shows every line of a short paste", () => {
    expect(previewPaste("a\nb\nc")).toEqual({ lines: ["a", "b", "c"], hidden: 0, total: 3 });
  });

  it("limits the lines and reports how many are hidden", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const preview = previewPaste(text, 4);
    expect(preview.lines).toHaveLength(4);
    expect(preview.hidden).toBe(6);
    expect(preview.total).toBe(10);
  });

  it("cuts long lines", () => {
    const preview = previewPaste("x".repeat(30), 6, 10);
    expect(preview.lines).toEqual([`${"x".repeat(10)}…`]);
  });
});

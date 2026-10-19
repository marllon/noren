import { describe, expect, it } from "vitest";
import {
  countLines,
  decidePaste,
  insertableText,
  needsPasteConfirmation,
  previewPaste,
} from "./paste";

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

describe("insertableText", () => {
  it("leaves a command as it is", () => {
    expect(insertableText("ls -la ~/projects")).toBe("ls -la ~/projects");
    expect(insertableText("\tindented  ")).toBe("\tindented  ");
  });

  it("drops the line breaks at both ends, so what lands is never a finished command", () => {
    expect(insertableText("ls\n")).toBe("ls");
    expect(insertableText("ls\r\n")).toBe("ls");
    expect(insertableText("\n\nls\r\r\n")).toBe("ls");
    expect(insertableText("\n\r\n")).toBe("");
    expect(insertableText("")).toBe("");
  });

  it("keeps the line breaks inside, for the confirmation of a paste of several lines", () => {
    expect(insertableText("cd /tmp\nls\n")).toBe("cd /tmp\nls");
    expect(decidePaste(insertableText("cd /tmp\nls\n"))).toBe("confirm");
    expect(decidePaste(insertableText("ls\n"))).toBe("send");
  });

  it("takes out the control characters an answer could use as key presses", () => {
    // Escape, Ctrl+C, Ctrl+D, backspace, bell, DEL, a C1 character.
    expect(insertableText("ls\x1b[2J\x03\x04\b\x07\x7f\x9b -l")).toBe("ls[2J -l");
  });

  it("keeps ordinary non-ASCII text", () => {
    expect(insertableText("echo 'olá, mundo' # 日本語 🙂")).toBe("echo 'olá, mundo' # 日本語 🙂");
  });

  it("lets no character through that is below a space or in the C1 range, except tab and the line breaks", () => {
    for (let code = 0; code <= 0xa0; code++) {
      const char = String.fromCodePoint(code);
      const out = insertableText(`a${char}b`);
      const kept = code === 0x09 || (code >= 0x20 && code < 0x7f) || code === 0xa0;
      const lineBreak = code === 0x0a || code === 0x0d;
      expect(out).toBe(kept || lineBreak ? `a${char}b` : "ab");
    }
  });
});

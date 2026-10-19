import { describe, expect, it } from "vitest";
import { watchFirstPrompt } from "./first-prompt";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("watchFirstPrompt", () => {
  it("answers true for the chunk that holds the mark of the prompt, once", () => {
    const watch = watchFirstPrompt();
    expect(watch(bytes("banner\r\n"))).toBe(false);
    expect(watch(bytes("\x1b]133;A\x07PS> "))).toBe(true);
    expect(watch(bytes("\x1b]133;A\x07PS> "))).toBe(false);
  });

  it("finds a mark that is split between two chunks", () => {
    const watch = watchFirstPrompt();
    expect(watch(bytes("hello\x1b]13"))).toBe(false);
    expect(watch(bytes("3;A\x07"))).toBe(true);
  });

  it("does not take other marks or plain text for the prompt", () => {
    const watch = watchFirstPrompt();
    expect(watch(bytes("\x1b]133;B\x07\x1b]133;C\x07\x1b]7;file:///c\x07"))).toBe(false);
    expect(watch(bytes("133;A"))).toBe(false);
    expect(watch(new Uint8Array())).toBe(false);
  });
});

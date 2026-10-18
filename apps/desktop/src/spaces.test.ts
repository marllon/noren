import { describe, expect, it } from "vitest";
import {
  SPACE_COLORS,
  SPACE_ICON_NAMES,
  formatEnvLines,
  isSingleGlyph,
  parseEnvLines,
  spaceShortcutIndex,
} from "./spaces";

const key = (code: string, flags: Partial<Parameters<typeof spaceShortcutIndex>[0]> = {}) => ({
  code,
  ctrlKey: true,
  altKey: true,
  shiftKey: false,
  metaKey: false,
  ...flags,
});

describe("parseEnvLines", () => {
  it("reads KEY=value lines, skipping blanks and keeping everything after the first =", () => {
    expect(parseEnvLines("A=1\n\n  B = two words \r\nURL=http://x/?a=b\nEMPTY=")).toEqual({
      ok: true,
      env: { A: "1", B: " two words ", URL: "http://x/?a=b", EMPTY: "" },
    });
  });

  it("an empty text is an empty environment and a later line wins", () => {
    expect(parseEnvLines("")).toEqual({ ok: true, env: {} });
    expect(parseEnvLines("A=1\nA=2")).toEqual({ ok: true, env: { A: "2" } });
  });

  it("names the line of a missing = or an unusable name", () => {
    expect(parseEnvLines("A=1\nNOVALUE")).toEqual({
      ok: false,
      error: "Line 2: expected NAME=value.",
    });
    expect(parseEnvLines("=x")).toMatchObject({
      ok: false,
      error: expect.stringContaining("Line 1"),
    });
    expect(parseEnvLines("A B=x")).toMatchObject({ ok: false });
  });
});

describe("spaceShortcutIndex", () => {
  it("maps Ctrl+Alt+1..9 to positions 0..8", () => {
    expect(spaceShortcutIndex(key("Digit1"))).toBe(0);
    expect(spaceShortcutIndex(key("Digit9"))).toBe(8);
  });

  it("ignores other keys and other modifier sets", () => {
    expect(spaceShortcutIndex(key("Digit0"))).toBeUndefined();
    expect(spaceShortcutIndex(key("KeyA"))).toBeUndefined();
    expect(spaceShortcutIndex(key("Digit1", { altKey: false }))).toBeUndefined();
    expect(spaceShortcutIndex(key("Digit1", { ctrlKey: false }))).toBeUndefined();
    expect(spaceShortcutIndex(key("Digit1", { shiftKey: true }))).toBeUndefined();
    expect(spaceShortcutIndex(key("Digit1", { metaKey: true }))).toBeUndefined();
  });
});

describe("space choices", () => {
  it("have unique colors and icons", () => {
    expect(new Set(SPACE_COLORS.map((c) => c.value)).size).toBe(SPACE_COLORS.length);
    expect(new Set(SPACE_ICON_NAMES).size).toBe(SPACE_ICON_NAMES.length);
  });
});

describe("formatEnvLines", () => {
  it("writes one KEY=value per line and parseEnvLines reads it back", () => {
    const env = { STAGE: "beta", TOKEN: "a=b", EMPTY: "" };
    expect(formatEnvLines(env)).toBe("STAGE=beta\nTOKEN=a=b\nEMPTY=");
    expect(parseEnvLines(formatEnvLines(env))).toEqual({ ok: true, env });
    expect(formatEnvLines({})).toBe("");
  });
});

describe("isSingleGlyph", () => {
  it("accepts one emoji, with modifiers or joiners, and one letter", () => {
    for (const glyph of ["🚀", "👍🏽", "👨‍👩‍👧", "🇧🇷", "N"]) expect(isSingleGlyph(glyph)).toBe(true);
  });

  it("refuses empty text and more than one character", () => {
    for (const text of ["", "🚀🚀", "ab", "🚀 "]) expect(isSingleGlyph(text)).toBe(false);
  });
});

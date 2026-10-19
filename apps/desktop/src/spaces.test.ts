import { describe, expect, it } from "vitest";
import {
  SPACE_COLORS,
  SPACE_ICON_NAMES,
  formatEnvLines,
  isSingleGlyph,
  parseEnvLines,
  createWheelGesture,
  wheelTravel,
} from "./spaces";

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

describe("wheelTravel", () => {
  const wheel = (
    deltaX: number,
    deltaY: number,
    flags: Partial<Parameters<typeof wheelTravel>[0]> = {},
  ) => ({
    deltaX,
    deltaY,
    deltaMode: 0,
    shiftKey: false,
    ...flags,
  });

  it("uses deltaX for a mostly horizontal gesture and ignores a vertical one", () => {
    expect(wheelTravel(wheel(80, 10))).toBe(80);
    expect(wheelTravel(wheel(-80, 10))).toBe(-80);
    expect(wheelTravel(wheel(0, 100))).toBe(0);
    expect(wheelTravel(wheel(10, 100))).toBe(0);
  });

  it("reads deltaY as horizontal travel while Shift is held", () => {
    expect(wheelTravel(wheel(0, 100, { shiftKey: true }))).toBe(100);
    expect(wheelTravel(wheel(0, -100, { shiftKey: true }))).toBe(-100);
  });

  it("scales lines and pages to pixels", () => {
    expect(wheelTravel(wheel(3, 0, { deltaMode: 1 }))).toBe(48);
    expect(wheelTravel(wheel(1, 0, { deltaMode: 2 }))).toBe(100);
  });
});

describe("createWheelGesture", () => {
  it("waits for the travel to add up to the threshold", () => {
    const step = createWheelGesture(60, 200);
    expect(step(25, 0)).toBe(0);
    expect(step(25, 10)).toBe(0);
    expect(step(25, 20)).toBe(1);
  });

  it("steps once per gesture, however long the momentum lasts", () => {
    const step = createWheelGesture(60, 200);
    const fired = [100, 100, 100, 100, 100].map((travel, i) => step(travel, i * 16));
    expect(fired).toEqual([1, 0, 0, 0, 0]);
  });

  it("steps again after a pause, in either direction", () => {
    const step = createWheelGesture(60, 200);
    expect(step(100, 0)).toBe(1);
    expect(step(100, 100)).toBe(0);
    expect(step(100, 400)).toBe(1);
    expect(step(-100, 1000)).toBe(-1);
  });

  it("forgets travel that stopped short of the threshold", () => {
    const step = createWheelGesture(60, 200);
    expect(step(40, 0)).toBe(0);
    expect(step(40, 500)).toBe(0);
    expect(step(-40, 520)).toBe(0);
    expect(step(-40, 540)).toBe(-1);
  });
});

import { describe, expect, it } from "vitest";
import { NOREN_DUSK, NOREN_PAPER, setThemeField } from "@noren/model";
import type { Theme } from "@noren/model";
import { themeChanges } from "./theme-changes";

// How many things the dense theme editor says are unsaved (NOR-F20-21c): every box whose value differs
// from the theme the editor opened with, the kind, the ligatures and the name.

const count = (edited: Theme, name = "Name", startName = "Name"): number =>
  themeChanges(NOREN_DUSK, edited, name, startName);

describe("themeChanges", () => {
  it("is nothing for the theme the editor opened with", () => {
    expect(count(NOREN_DUSK)).toBe(0);
    expect(count({ ...NOREN_DUSK })).toBe(0);
  });

  it("counts a color of the interface, of the terminal and of the palette once each", () => {
    expect(count(setThemeField(NOREN_DUSK, "ui.accent", "#112233"))).toBe(1);
    expect(count(setThemeField(NOREN_DUSK, "terminal.cursor", "#112233"))).toBe(1);
    expect(count(setThemeField(NOREN_DUSK, "terminal.ansi.15", "#112233"))).toBe(1);
    let edited = setThemeField(NOREN_DUSK, "ui.bg", "#010203");
    edited = setThemeField(edited, "terminal.ansi.0", "#040506");
    edited = setThemeField(edited, "terminal.selection", "#07080955");
    expect(count(edited)).toBe(3);
  });

  it("counts a number, the font names and the picture", () => {
    expect(count(setThemeField(NOREN_DUSK, "ui.radius", 3))).toBe(1);
    expect(count(setThemeField(NOREN_DUSK, "font.size", 19))).toBe(1);
    expect(count(setThemeField(NOREN_DUSK, "font.family", "Fira Code"))).toBe(1);
    expect(count(setThemeField(NOREN_DUSK, "background.image", "pictures/sky.png"))).toBe(1);
    // A picture blur that was not set is not the same as one set to 0.
    expect(count(setThemeField(NOREN_DUSK, "background.blur", 0))).toBe(1);
  });

  it("counts the kind and the ligatures, which have no box of their own", () => {
    expect(count({ ...NOREN_DUSK, kind: "light" })).toBe(1);
    expect(
      count({ ...NOREN_DUSK, font: { ...NOREN_DUSK.font, ligatures: !NOREN_DUSK.font.ligatures } }),
    ).toBe(1);
  });

  it("counts the name against the name the editor opened with", () => {
    expect(count(NOREN_DUSK, "Another", "Name")).toBe(1);
    expect(count(NOREN_DUSK, "Name", "Name")).toBe(0);
    // Putting a value back is not a change.
    const edited = setThemeField(NOREN_DUSK, "ui.accent", "#112233");
    expect(count(setThemeField(edited, "ui.accent", NOREN_DUSK.ui.accent))).toBe(0);
  });

  it("adds them up", () => {
    let edited: Theme = setThemeField(NOREN_DUSK, "ui.accent", "#112233");
    edited = { ...edited, kind: "light" };
    edited = setThemeField(edited, "ui.opacity", 0.5);
    expect(count(edited, "Other", "Name")).toBe(4);
  });

  it("is everything for a theme that is nothing like the one the editor opened with", () => {
    // Two built-in themes differ in every color and the kind (at least): many boxes, all counted.
    expect(themeChanges(NOREN_DUSK, NOREN_PAPER, "a", "a")).toBeGreaterThan(20);
  });
});

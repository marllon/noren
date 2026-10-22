import { describe, expect, it } from "vitest";
import { PICTURE_PANEL_OPACITY } from "./background";
import { THEMES } from "./builtin-themes";
import { contrastRatio } from "./theme";
import {
  DEFAULT_WINDOW_EFFECT,
  MIN_WINDOW_OPACITY,
  WINDOW_EFFECTS,
  WINDOW_EFFECT_LABELS,
  clampNumber,
  interfaceOpacity,
  isWindowEffect,
} from "./window-effect";

describe("the window effects", () => {
  it("are none, mica, acrylic and vibrancy, with a label each", () => {
    expect([...WINDOW_EFFECTS]).toEqual(["none", "mica", "acrylic", "vibrancy"]);
    expect(DEFAULT_WINDOW_EFFECT).toBe("none");
    for (const effect of WINDOW_EFFECTS) expect(WINDOW_EFFECT_LABELS[effect]).toBeTruthy();
  });

  it("are told apart from anything else", () => {
    for (const effect of WINDOW_EFFECTS) expect(isWindowEffect(effect)).toBe(true);
    for (const other of ["", "Mica", "blur", "tabbed", null, undefined, 1, {}, ["mica"]]) {
      expect(isWindowEffect(other), String(other)).toBe(false);
    }
  });
});

describe("clampNumber", () => {
  it("holds a number to the range and gives the fallback for anything else", () => {
    expect(clampNumber(0.5, 0.3, 1, 1)).toBe(0.5);
    expect(clampNumber(0, 0.3, 1, 1)).toBe(0.3);
    expect(clampNumber(7, 0.3, 1, 1)).toBe(1);
    expect(clampNumber(Number.NaN, 0.3, 1, 0.9)).toBe(0.9);
    expect(clampNumber("0.5", 0.3, 1, 0.9)).toBe(0.9);
    expect(clampNumber(Number.POSITIVE_INFINITY, 0.3, 1, 0.9)).toBe(0.9);
  });
});

describe("interfaceOpacity", () => {
  const themeOpacity = 0.92;

  it("is solid without an effect and without a setting", () => {
    expect(interfaceOpacity({ configured: undefined, applied: "none", themeOpacity })).toBe(1);
    expect(interfaceOpacity({ configured: null, applied: "none", themeOpacity })).toBe(1);
  });

  it("takes the opacity of the theme while the window has an effect", () => {
    for (const applied of ["mica", "acrylic", "vibrancy"] as const) {
      expect(interfaceOpacity({ configured: undefined, applied, themeOpacity })).toBe(0.92);
      expect(interfaceOpacity({ configured: null, applied, themeOpacity })).toBe(0.92);
    }
  });

  it("lets a window that fell back to opaque stay solid: the effect that was asked for does not count", () => {
    // `applied` is what the system did; a Mica that could not be painted comes in as `none`.
    expect(interfaceOpacity({ configured: undefined, applied: "none", themeOpacity: 0.5 })).toBe(1);
  });

  it("always takes a value in the settings, with or without an effect", () => {
    expect(interfaceOpacity({ configured: 0.6, applied: "none", themeOpacity })).toBe(0.6);
    expect(interfaceOpacity({ configured: 0.6, applied: "mica", themeOpacity })).toBe(0.6);
    expect(interfaceOpacity({ configured: 1, applied: "mica", themeOpacity })).toBe(1);
  });

  it("lets the panels through while a picture shows, with or without an effect", () => {
    for (const applied of ["none", "mica"] as const) {
      expect(
        interfaceOpacity({ configured: undefined, applied, themeOpacity, picture: true }),
      ).toBe(PICTURE_PANEL_OPACITY);
      expect(interfaceOpacity({ configured: null, applied, themeOpacity, picture: true })).toBe(
        PICTURE_PANEL_OPACITY,
      );
    }
    // The picture that is only wanted (it could not be read) leaves the window as it was.
    expect(
      interfaceOpacity({ configured: undefined, applied: "none", themeOpacity, picture: false }),
    ).toBe(1);
  });

  it("is a value that lets the picture through, but not all of it", () => {
    expect(PICTURE_PANEL_OPACITY).toBeGreaterThan(MIN_WINDOW_OPACITY);
    expect(PICTURE_PANEL_OPACITY).toBeLessThan(1);
  });

  it("takes a value in the settings over the default of a picture", () => {
    expect(
      interfaceOpacity({ configured: 0.8, applied: "none", themeOpacity, picture: true }),
    ).toBe(0.8);
    expect(interfaceOpacity({ configured: 1, applied: "none", themeOpacity, picture: true })).toBe(
      1,
    );
  });

  it("never goes below the lowest opacity nor above solid", () => {
    expect(interfaceOpacity({ configured: 0.01, applied: "none", themeOpacity })).toBe(
      MIN_WINDOW_OPACITY,
    );
    expect(interfaceOpacity({ configured: 5, applied: "none", themeOpacity })).toBe(1);
    expect(interfaceOpacity({ configured: undefined, applied: "mica", themeOpacity: 0 })).toBe(
      MIN_WINDOW_OPACITY,
    );
    expect(interfaceOpacity({ configured: Number.NaN, applied: "none", themeOpacity })).toBe(1);
  });
});

/** `over` laid on `under` at `alpha`, as `#rrggbb`. */
function laidOn(over: string, alpha: number, under: string): string {
  const channel = (hex: string, start: number) => parseInt(hex.slice(start, start + 2), 16);
  const mixed = [1, 3, 5].map((start) =>
    Math.round(alpha * channel(over, start) + (1 - alpha) * channel(under, start))
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${mixed.join("")}`;
}

describe("legibility at the lowest opacity", () => {
  // The window lets the backdrop through, so what the text sits on is the surface laid on it. The
  // effect is painted dark or light like the theme (`WindowScheme`), so the backdrop worst for a
  // theme is the extreme of its own kind: black behind a dark theme, white behind a light one.
  // (A backdrop of the other kind cannot be made readable by any opacity, which is why the
  // effect follows the theme and not the system.)
  const own = (kind: "dark" | "light") => (kind === "dark" ? "#000000" : "#ffffff");

  it.each(THEMES.map((theme) => [theme.id, theme] as const))(
    "%s keeps its text at 4.5:1 and its muted text at 3:1 over the backdrop of its kind",
    (_id, theme) => {
      const backdrop = own(theme.kind);
      for (const color of [theme.ui.bg, theme.ui.surface]) {
        const sits = laidOn(color, MIN_WINDOW_OPACITY, backdrop);
        expect(contrastRatio(theme.ui.text, sits)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.ui.muted, sits)).toBeGreaterThanOrEqual(3);
      }
      const terminal = laidOn(theme.terminal.background, MIN_WINDOW_OPACITY, backdrop);
      expect(contrastRatio(theme.terminal.foreground, terminal)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("keeps the theme's own opacity above the lowest", () => {
    for (const theme of THEMES) expect(theme.ui.opacity).toBeGreaterThanOrEqual(MIN_WINDOW_OPACITY);
  });
});

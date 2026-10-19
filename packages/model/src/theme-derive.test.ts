import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { THEMES } from "./builtin-themes";
import { contrastRatio, parseTheme } from "./theme";
import {
  claimIdentity,
  cleanName,
  deriveTheme,
  mixColors,
  normalizeColor,
  reservedThemeIds,
  slugify,
} from "./theme-derive";
import type { SchemeColors } from "./theme-derive";

const ANSI = [
  "#1b2631",
  "#e5596d",
  "#6ec98a",
  "#e8c35a",
  "#5aa3e8",
  "#b583e0",
  "#4ec9c0",
  "#c7d3df",
  "#46586b",
  "#ff7a8c",
  "#8ee6a8",
  "#ffd97a",
  "#7fbcff",
  "#cfa3f5",
  "#74e3da",
  "#f4f8fb",
];

const colors = (overrides: Partial<SchemeColors> = {}): SchemeColors => ({
  foreground: "#d6e2ee",
  background: "#101820",
  ansi: ANSI,
  ...overrides,
});

describe("normalizeColor", () => {
  it("reads #rgb, #rrggbb and #rrggbbaa in lower case", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#1A2B3C")).toBe("#1a2b3c");
    expect(normalizeColor(" #1a2b3c ")).toBe("#1a2b3c");
    expect(normalizeColor("#1a2b3c80", { alpha: true })).toBe("#1a2b3c80");
  });

  it("drops the alpha unless it is asked for", () => {
    expect(normalizeColor("#1a2b3c80")).toBe("#1a2b3c");
  });

  it("wants the # unless a bare color is allowed", () => {
    expect(normalizeColor("1a2b3c")).toBeUndefined();
    expect(normalizeColor("1a2b3c", { bare: true })).toBe("#1a2b3c");
  });

  it("refuses what is not a color", () => {
    for (const value of [
      "",
      "#12",
      "#12345",
      "#gggggg",
      "red",
      "rgb(1,2,3)",
      12,
      null,
      undefined,
    ]) {
      expect(normalizeColor(value)).toBeUndefined();
    }
  });
});

describe("slugify and claimIdentity", () => {
  it("turns a name into a slug the theme schema accepts", () => {
    expect(slugify("Solarized Dark (v2)")).toBe("solarized-dark-v2");
    expect(slugify("  Été   Ñandú  ")).toBe("ete-nandu");
    expect(slugify("---")).toBe("");
    expect(slugify("日本語")).toBe("");
    expect(slugify("a".repeat(200))).toHaveLength(48);
  });

  it("cleans a name of control characters, blanks and length", () => {
    expect(cleanName("  A\u0000\tB\n C ")).toBe("A B C");
    expect(cleanName("x".repeat(100))).toHaveLength(60);
  });

  it("numbers an id and a name that are taken, and remembers what it handed out", () => {
    const taken = new Set(["lagoon"]);
    expect(claimIdentity("Lagoon", "Imported scheme", taken)).toEqual({
      id: "lagoon-2",
      name: "Lagoon (2)",
    });
    expect(claimIdentity("Lagoon", "Imported scheme", taken)).toEqual({
      id: "lagoon-3",
      name: "Lagoon (3)",
    });
    expect(claimIdentity("Bay", "Imported scheme", taken)).toEqual({ id: "bay", name: "Bay" });
  });

  it("takes the id from the fallback when the name has no letter or digit, and keeps the name", () => {
    const taken = new Set<string>();
    expect(claimIdentity("日本語", "Imported plist scheme", taken)).toEqual({
      id: "imported-plist-scheme",
      name: "日本語",
    });
    expect(claimIdentity("", "Imported plist scheme", taken)).toEqual({
      id: "imported-plist-scheme-2",
      name: "Imported plist scheme (2)",
    });
  });

  it("keeps the built-in ids and `system` out of reach", () => {
    const taken = reservedThemeIds();
    for (const theme of THEMES) expect(taken.has(theme.id)).toBe(true);
    expect(taken.has("system")).toBe(true);
    expect(claimIdentity("System", "x", taken).id).toBe("system-2");
    expect(claimIdentity("Noren Dusk", "x", taken).id).toBe("noren-dusk-2");
  });
});

describe("deriveTheme", () => {
  it("keeps the colors of the terminal as given and derives the interface from them", () => {
    const result = deriveTheme(
      colors({ cursor: "#f2c14e", selection: "#2b3f55" }),
      "lagoon",
      "Lagoon",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { theme } = result;
    expect(theme.id).toBe("lagoon");
    expect(theme.name).toBe("Lagoon");
    expect(theme.kind).toBe("dark");
    expect(theme.terminal).toEqual({
      foreground: "#d6e2ee",
      background: "#101820",
      cursor: "#f2c14e",
      selection: "#2b3f55",
      ansi: ANSI,
    });
    expect(theme.ui.bg).toBe("#101820");
    expect(theme.ui.text).toBe("#d6e2ee");
    expect(theme.ui.accent).toBe(ANSI[4]);
  });

  it("takes the foreground for the cursor and a blend for the selection when the scheme has none", () => {
    const result = deriveTheme(colors(), "lagoon", "Lagoon");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.terminal.cursor).toBe("#d6e2ee");
    expect(result.theme.terminal.selection).toBe(mixColors("#101820", "#d6e2ee", 0.25));
  });

  it("tells a light scheme from a dark one", () => {
    const light = deriveTheme(
      colors({ background: "#fdf6e3", foreground: "#586e75" }),
      "dune-like",
      "Dune-like",
    );
    expect(light.ok && light.theme.kind).toBe("light");
  });

  it("holds the interface to the contrast of the built-in themes, even for a scheme that does not", () => {
    // Gray on gray: the terminal keeps it, the interface does not.
    const result = deriveTheme(
      colors({ background: "#808080", foreground: "#8a8a8a", ansi: ANSI.map(() => "#858585") }),
      "faint",
      "Faint",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { ui, terminal } = result.theme;
    expect(terminal.foreground).toBe("#8a8a8a");
    expect(contrastRatio(ui.text, ui.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ui.muted, ui.bg)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ui.accent, ui.bg)).toBeGreaterThanOrEqual(3);
  });

  it("refuses sixteen colors that are not sixteen, and a color that is not a color", () => {
    expect(deriveTheme(colors({ ansi: ANSI.slice(0, 15) }), "x", "X").ok).toBe(false);
    expect(deriveTheme(colors({ foreground: "red" }), "x", "X").ok).toBe(false);
  });

  it("always makes a valid theme with a legible interface, for any colors", () => {
    const hexColor = fc
      .tuple(fc.nat(255), fc.nat(255), fc.nat(255))
      .map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    fc.assert(
      fc.property(
        hexColor,
        hexColor,
        fc.array(hexColor, { minLength: 16, maxLength: 16 }),
        (foreground, background, ansi) => {
          const result = deriveTheme({ foreground, background, ansi }, "any", "Any");
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const { ui } = result.theme;
          expect(parseTheme(result.theme).ok).toBe(true);
          expect(contrastRatio(ui.text, ui.bg)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(ui.muted, ui.bg)).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(ui.accent, ui.bg)).toBeGreaterThanOrEqual(3);
        },
      ),
      { numRuns: 300 },
    );
  });
});

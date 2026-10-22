import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NOREN_DUSK, NOREN_PAPER, THEMES } from "./builtin-themes";
import { importColorSchemes } from "./importers";
import { ThemeSchema, parseTheme } from "./theme";
import type { Theme } from "./theme";
import { duplicateTheme, renameTheme } from "./theme-actions";
import {
  ANSI_INDEXES,
  NUMBER_RANGES,
  ansiField,
  fieldText,
  isColor,
  isNumber,
  numberText,
  readThemeField,
  setThemeField,
  themeContrastWarnings,
  typeIntoField,
} from "./theme-edit";
import type { NumberField, ThemeField } from "./theme-edit";
import { parseUserThemes, serializeTheme } from "./user-themes";

// The theme the editor saves has to be a valid theme file whatever the person typed: every box is
// read before it reaches the theme, the theme is held to the schema again when it is saved, and a
// file written from it comes back whole through the loader of the themes folder and through the
// importer ("Import theme...") that reads what Export writes (the lesson of NOR-F20-09a: a format
// the app writes must be one the app reads).

const COLOR_FIELDS: ThemeField[] = [
  "ui.accent",
  "ui.bg",
  "ui.surface",
  "ui.text",
  "ui.muted",
  "ui.border",
  "terminal.background",
  "terminal.foreground",
  "terminal.cursor",
  "terminal.selection",
  ...ANSI_INDEXES.map(ansiField),
];
const NUMBER_FIELDS = Object.keys(NUMBER_RANGES) as NumberField[];
const ALL_FIELDS: ThemeField[] = [
  ...COLOR_FIELDS,
  ...NUMBER_FIELDS,
  "font.family",
  "background.image",
];

/** A theme the person made from the built-in `base`, with a value of its own in every box. */
function editedEverywhere(base: Theme): Theme {
  let theme: Theme = base;
  const type = (field: ThemeField, text: string): void => {
    const typed = typeIntoField(theme, field, text);
    expect(typed.problem, `${field} <- ${text}`).toBeUndefined();
    theme = typed.theme;
  };
  COLOR_FIELDS.forEach((field, at) => {
    type(field, `#${((0x102030 + at * 0x0a0b0c) % 0x1000000).toString(16).padStart(6, "0")}`);
  });
  type("terminal.selection", "#ffaa0080");
  type("ui.radius", "0");
  type("ui.blur", "40");
  type("ui.opacity", "0.5");
  type("font.family", "Fira Code, Consolas, monospace");
  type("font.size", "17");
  type("font.lineHeight", "1.35");
  type("background.image", "backgrounds/sky.png");
  type("background.opacity", "0.25");
  type("background.blur", "12");
  return { ...theme, kind: base.kind === "dark" ? "light" : "dark" };
}

function saved(theme: Theme, name: string, takenIds: string[] = []): Theme {
  const result = duplicateTheme(theme, name, takenIds);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.theme;
}

describe("readThemeField: colors", () => {
  it("reads #rgb, #rrggbb and a color with no # in any case, and answers #rrggbb in lower case", () => {
    expect(readThemeField("ui.accent", "#E07A5F")).toEqual({ ok: true, value: "#e07a5f" });
    expect(readThemeField("ui.accent", "e07a5f")).toEqual({ ok: true, value: "#e07a5f" });
    expect(readThemeField("ui.accent", "  #f80 ")).toEqual({ ok: true, value: "#ff8800" });
    expect(readThemeField("terminal.ansi.15", "#FFF")).toEqual({ ok: true, value: "#ffffff" });
  });

  it("keeps the alpha of the selection and refuses an alpha anywhere else instead of dropping it", () => {
    expect(readThemeField("terminal.selection", "#E07A5F55")).toEqual({
      ok: true,
      value: "#e07a5f55",
    });
    expect(readThemeField("terminal.selection", "#e07a5f")).toEqual({
      ok: true,
      value: "#e07a5f",
    });
    for (const field of COLOR_FIELDS.filter((field) => field !== "terminal.selection")) {
      expect(readThemeField(field, "#e07a5f55"), field).toEqual({
        ok: false,
        problem: { kind: "color", alpha: false },
      });
    }
    expect(readThemeField("terminal.selection", "#zzz")).toEqual({
      ok: false,
      problem: { kind: "color", alpha: true },
    });
  });

  it("refuses what is not a color, and says which kind of color the box wants", () => {
    for (const text of ["", " ", "red", "#12", "#12345", "#1234567", "#12345g", "rgb(1,2,3)"]) {
      expect(readThemeField("ui.bg", text), text).toEqual({
        ok: false,
        problem: { kind: "color", alpha: false },
      });
    }
  });
});

describe("readThemeField: numbers", () => {
  it("accepts the two ends of every range and refuses the numbers just outside", () => {
    for (const field of NUMBER_FIELDS) {
      const { min, max } = NUMBER_RANGES[field];
      expect(readThemeField(field, String(min)), `${field} min`).toEqual({ ok: true, value: min });
      expect(readThemeField(field, String(max)), `${field} max`).toEqual({ ok: true, value: max });
      for (const outside of [min - 0.01, max + 0.01]) {
        expect(readThemeField(field, String(outside)), `${field} ${outside}`).toEqual({
          ok: false,
          problem: { kind: "range", min, max },
        });
      }
    }
  });

  it("reads blanks around a number and a comma as the decimal point", () => {
    expect(readThemeField("ui.opacity", " 0.5 ")).toEqual({ ok: true, value: 0.5 });
    expect(readThemeField("ui.opacity", "0,5")).toEqual({ ok: true, value: 0.5 });
    expect(readThemeField("font.lineHeight", ".9")).toEqual({ ok: true, value: 0.9 });
    expect(readThemeField("ui.opacity", "1,000.5")).toEqual({
      ok: false,
      problem: { kind: "number" },
    });
  });

  it("refuses text that is not a number", () => {
    for (const text of ["", "  ", "abc", "1e2", "0x10", "--1", "1.2.3", "5px", "NaN", "Infinity"]) {
      expect(readThemeField("ui.radius", text), text).toEqual({
        ok: false,
        problem: { kind: "number" },
      });
    }
  });

  it("lets only the blur of the picture be empty, which leaves the theme saying nothing for it", () => {
    expect(readThemeField("background.blur", "")).toEqual({ ok: true, value: undefined });
    expect(readThemeField("background.blur", "   ")).toEqual({ ok: true, value: undefined });
    for (const field of NUMBER_FIELDS.filter((field) => field !== "background.blur")) {
      expect(readThemeField(field, "").ok, field).toBe(false);
    }
  });

  it("never asks for more than the schema allows", () => {
    for (const field of NUMBER_FIELDS) {
      const { min, max } = NUMBER_RANGES[field];
      for (const value of [min, max]) {
        const theme = setThemeField(NOREN_DUSK, field, value);
        expect(ThemeSchema.safeParse(theme).success, `${field} ${value}`).toBe(true);
      }
    }
    // Where the range is the schema's own, one step outside it is refused by the schema too.
    for (const [field, outside] of [
      ["ui.radius", -1],
      ["ui.radius", 33],
      ["ui.blur", -1],
      ["ui.blur", 101],
      ["ui.opacity", -0.1],
      ["ui.opacity", 1.1],
      ["font.size", 97],
      ["font.lineHeight", 0.7],
      ["font.lineHeight", 3.1],
      ["background.opacity", 1.1],
      ["background.blur", 101],
    ] as const) {
      const theme = setThemeField(NOREN_DUSK, field, outside);
      expect(ThemeSchema.safeParse(theme).success, `${field} ${outside}`).toBe(false);
    }
  });
});

describe("readThemeField: the font and the picture", () => {
  it("needs a font list that is not empty and trims it", () => {
    expect(readThemeField("font.family", "  Fira Code, monospace  ")).toEqual({
      ok: true,
      value: "Fira Code, monospace",
    });
    expect(readThemeField("font.family", "   ")).toEqual({ ok: false, problem: { kind: "empty" } });
  });

  it("takes an empty path as no picture, and a path the app can show as it is", () => {
    expect(readThemeField("background.image", "")).toEqual({ ok: true, value: null });
    expect(readThemeField("background.image", " backgrounds/sky.png ")).toEqual({
      ok: true,
      value: "backgrounds/sky.png",
    });
    expect(readThemeField("background.image", "C:\\Pictures\\sky.JPG")).toEqual({
      ok: true,
      value: "C:\\Pictures\\sky.JPG",
    });
  });

  it("refuses a web address, a network path, a path out of the folder and a file that is not a picture, with the reason", () => {
    for (const text of [
      "https://example.com/a.png",
      "\\\\server\\share\\a.png",
      "../a.png",
      "notes.txt",
    ]) {
      const read = readThemeField("background.image", text);
      expect(read.ok, text).toBe(false);
      if (!read.ok) {
        expect(read.problem.kind).toBe("picture");
        expect(read.problem.kind === "picture" && read.problem.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("fieldText and setThemeField", () => {
  it("shows every box of every theme that ships with the app as a text the box reads back to the same value", () => {
    for (const theme of THEMES) {
      for (const field of ALL_FIELDS) {
        const read = readThemeField(field, fieldText(theme, field));
        expect(read.ok, `${theme.id} ${field}`).toBe(true);
        if (read.ok)
          expect(setThemeField(theme, field, read.value), `${theme.id} ${field}`).toEqual(theme);
      }
    }
  });

  it("puts a value in its own place and nowhere else", () => {
    const base = NOREN_DUSK;
    const cases: [ThemeField, string | number | null, (theme: Theme) => unknown][] = [
      ["ui.accent", "#123456", (t) => t.ui.accent],
      ["ui.bg", "#123456", (t) => t.ui.bg],
      ["ui.surface", "#123456", (t) => t.ui.surface],
      ["ui.text", "#123456", (t) => t.ui.text],
      ["ui.muted", "#123456", (t) => t.ui.muted],
      ["ui.border", "#123456", (t) => t.ui.border],
      ["ui.radius", 3, (t) => t.ui.radius],
      ["ui.blur", 7, (t) => t.ui.blur],
      ["ui.opacity", 0.4, (t) => t.ui.opacity],
      ["terminal.background", "#123456", (t) => t.terminal.background],
      ["terminal.foreground", "#123456", (t) => t.terminal.foreground],
      ["terminal.cursor", "#123456", (t) => t.terminal.cursor],
      ["terminal.selection", "#12345678", (t) => t.terminal.selection],
      ["terminal.ansi.0", "#123456", (t) => t.terminal.ansi[0]],
      ["terminal.ansi.9", "#123456", (t) => t.terminal.ansi[9]],
      ["terminal.ansi.15", "#123456", (t) => t.terminal.ansi[15]],
      ["font.family", "Fira Code", (t) => t.font.family],
      ["font.size", 20, (t) => t.font.size],
      ["font.lineHeight", 1.5, (t) => t.font.lineHeight],
      ["background.image", "a.png", (t) => t.background.image],
      ["background.opacity", 0.9, (t) => t.background.opacity],
      ["background.blur", 9, (t) => t.background.blur],
    ];
    for (const [field, value, read] of cases) {
      const next = setThemeField(base, field, value);
      expect(read(next), field).toBe(value);
      expect(read(base), `${field} on the original`).not.toBe(value);
      // Everything else is as it was: put the old value back and the theme is the original.
      const original = read(base) as string | number | null | undefined;
      expect(setThemeField(next, field, original), field).toEqual(base);
    }
  });

  it("keeps the ANSI palette at sixteen colors, changes one place and leaves the palette of the original alone", () => {
    const before = [...NOREN_DUSK.terminal.ansi];
    for (const index of ANSI_INDEXES) {
      const next = setThemeField(NOREN_DUSK, ansiField(index), "#010203");
      expect(next.terminal.ansi).toHaveLength(16);
      next.terminal.ansi.forEach((color, at) => {
        expect(color).toBe(at === index ? "#010203" : before[at]);
      });
    }
    expect([...NOREN_DUSK.terminal.ansi]).toEqual(before);
  });

  it("takes the blur of the picture away from the theme when the box is emptied, so the file does not say it", () => {
    const blurred = setThemeField(NOREN_DUSK, "background.blur", 20);
    expect(blurred.background.blur).toBe(20);
    const cleared = setThemeField(blurred, "background.blur", undefined);
    expect("blur" in cleared.background).toBe(false);
    expect(serializeTheme(cleared)).not.toContain('"blur": 20');
    expect(ThemeSchema.safeParse(cleared).success).toBe(true);
  });

  it("types a text into a box: the theme with the value, or the theme as it was and the reason", () => {
    const ok = typeIntoField(NOREN_DUSK, "ui.accent", "#00ff00");
    expect(ok.problem).toBeUndefined();
    expect(ok.theme.ui.accent).toBe("#00ff00");
    const bad = typeIntoField(ok.theme, "ui.accent", "#00ff0");
    expect(bad.problem).toEqual({ kind: "color", alpha: false });
    expect(bad.theme).toBe(ok.theme);
  });

  it("formats numbers with at most two decimals and no trailing zeros", () => {
    expect(numberText(13)).toBe("13");
    expect(numberText(1.2)).toBe("1.2");
    expect(numberText(0.9200000000000002)).toBe("0.92");
    expect(numberText(0.5)).toBe("0.5");
  });

  it("tells colors from numbers", () => {
    for (const field of COLOR_FIELDS) {
      expect(isColor(field), field).toBe(true);
      expect(isNumber(field), field).toBe(false);
    }
    for (const field of NUMBER_FIELDS) {
      expect(isNumber(field), field).toBe(true);
      expect(isColor(field), field).toBe(false);
    }
    expect(isColor("font.family") || isColor("background.image")).toBe(false);
  });
});

describe("the theme the editor saves", () => {
  it("is a theme the schema accepts for each theme that ships with the app, with a value of its own in every box", () => {
    for (const base of THEMES) {
      const edited = editedEverywhere(base);
      expect(ThemeSchema.safeParse(edited).success, base.id).toBe(true);
      const copy = saved(edited, `${base.name} mine`);
      expect(parseTheme(copy).ok, base.id).toBe(true);
      // Each box landed in the file.
      expect(copy.ui.radius).toBe(0);
      expect(copy.terminal.selection).toBe("#ffaa0080");
      expect(copy.font).toEqual({
        family: "Fira Code, Consolas, monospace",
        size: 17,
        lineHeight: 1.35,
        ligatures: base.font.ligatures,
      });
      expect(copy.background).toEqual({ image: "backgrounds/sky.png", opacity: 0.25, blur: 12 });
      expect(copy.kind).not.toBe(base.kind);
    }
  });

  it("is read back whole by the loader of the themes folder, and rewritten as the same text", () => {
    for (const base of THEMES) {
      const copy = saved(editedEverywhere(base), "Mine");
      const text = serializeTheme(copy);
      const listed = parseUserThemes([text]);
      expect(listed.ignored, base.id).toEqual([]);
      expect(listed.themes, base.id).toEqual([copy]);
      expect(serializeTheme(listed.themes[0] as Theme)).toBe(text);
    }
  });

  it("is read back whole by the importer that reads what Export writes", () => {
    for (const base of THEMES) {
      const copy = saved(editedEverywhere(base), "Mine");
      const result = importColorSchemes(serializeTheme(copy));
      expect(result, base.id).toEqual({ ok: true, format: "json", themes: [copy], warnings: [] });
    }
  });

  it("gets a new id for a new theme and keeps the id of one that is edited in place", () => {
    const edited = editedEverywhere(NOREN_DUSK);
    const fresh = saved(edited, "Noren Dusk", ["mine"]);
    expect(fresh.id).toBe("noren-dusk-2");
    expect(fresh.id).not.toBe(NOREN_DUSK.id);
    const own: Theme = { ...NOREN_PAPER, id: "mine", name: "Mine" };
    const again = renameTheme(editedEverywhere(own), "Mine, better");
    expect(again.ok && again.theme.id).toBe("mine");
    expect(again.ok && again.theme.name).toBe("Mine, better");
  });

  it("refuses what the schema refuses even when a box was bypassed, so a bad theme is never written", () => {
    const broken = { ...NOREN_DUSK, ui: { ...NOREN_DUSK.ui, accent: "red" } } as Theme;
    const result = duplicateTheme(broken, "Broken", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^ui\.accent:/);
    expect(renameTheme({ ...NOREN_DUSK, ui: { ...NOREN_DUSK.ui, radius: 99 } }, "Broken").ok).toBe(
      false,
    );
  });

  it("holds for any value the boxes take: whatever is typed, the theme is valid and survives the file", () => {
    const hex = fc
      .integer({ min: 0, max: 0xffffff })
      .map((n) => `#${n.toString(16).padStart(6, "0")}`);
    const alpha = fc
      .integer({ min: 0, max: 0xffffffff })
      .map((n) => `#${n.toString(16).padStart(8, "0")}`);
    const number = (field: NumberField) => {
      const { min, max } = NUMBER_RANGES[field];
      return fc.double({ min, max, noNaN: true, noDefaultInfinity: true }).map(numberText);
    };
    const typed = fc.record({
      colors: fc.array(hex, { minLength: COLOR_FIELDS.length, maxLength: COLOR_FIELDS.length }),
      selection: alpha,
      numbers: fc.tuple(...NUMBER_FIELDS.map(number)),
      family: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,20}$/),
      name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
      base: fc.constantFrom(...THEMES),
    });
    fc.assert(
      fc.property(typed, ({ colors, selection, numbers, family, name, base }) => {
        let theme: Theme = base;
        COLOR_FIELDS.forEach((field, at) => {
          theme = typeIntoField(theme, field, colors[at] as string).theme;
        });
        theme = typeIntoField(theme, "terminal.selection", selection).theme;
        NUMBER_FIELDS.forEach((field, at) => {
          const typedNumber = typeIntoField(theme, field, numbers[at] as string);
          expect(typedNumber.problem, `${field} ${numbers[at]}`).toBeUndefined();
          theme = typedNumber.theme;
        });
        theme = typeIntoField(theme, "font.family", family).theme;
        expect(ThemeSchema.safeParse(theme).success).toBe(true);
        const copy = duplicateTheme(theme, name, []);
        expect(copy.ok).toBe(true);
        if (!copy.ok) return;
        const text = serializeTheme(copy.theme);
        expect(parseUserThemes([text]).themes).toEqual([copy.theme]);
        const imported = importColorSchemes(text);
        expect(imported.ok && imported.themes).toEqual([copy.theme]);
      }),
      { numRuns: 60 },
    );
  });
});

describe("themeContrastWarnings", () => {
  it("has nothing to say about the themes that ship with the app", () => {
    for (const theme of THEMES) expect(themeContrastWarnings(theme), theme.id).toEqual([]);
  });

  it("names the pair that reads badly, with its contrast and the minimum", () => {
    const flat: Theme = {
      ...NOREN_DUSK,
      ui: { ...NOREN_DUSK.ui, text: NOREN_DUSK.ui.bg },
      terminal: { ...NOREN_DUSK.terminal, foreground: NOREN_DUSK.terminal.background },
    };
    const warnings = themeContrastWarnings(flat);
    const names = warnings.map((warning) => warning.check);
    expect(names).toContain("text");
    expect(names).toContain("sidebar");
    expect(names).toContain("terminal");
    expect(names).not.toContain("muted");
    const text = warnings.find((warning) => warning.check === "text");
    expect(text?.ratio).toBeCloseTo(1, 5);
    expect(text?.minimum).toBe(4.5);
    expect(warnings.find((warning) => warning.check === "terminal")?.minimum).toBe(4.5);
    expect(warnings.find((warning) => warning.check === "sidebar")?.minimum).toBe(3);
  });

  it("holds the muted text and the accent to 3:1 and the terminal text to 4.5:1", () => {
    const theme = typeIntoField(
      typeIntoField(NOREN_PAPER, "ui.muted", "#f0eadc").theme,
      "terminal.foreground",
      "#e8e4d8",
    ).theme;
    const names = themeContrastWarnings(theme).map((warning) => warning.check);
    expect(names).toContain("muted");
    expect(names).toContain("terminal");
    expect(names).not.toContain("accent");
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_FAMILY_CSS,
  DEFAULT_TERMINAL_OPTIONS,
  MAX_FONT_FAMILIES,
  MAX_FONT_FAMILY_LENGTH,
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  clampFontSize,
  cssFontFamily,
  fontFamilyProblem,
  fontNameList,
  isFontName,
  nextZoom,
  parseFontFamilies,
  safeFontFamily,
  terminalOptionsOf,
  zoomedFontSize,
} from "./terminal-options";

// The options of the terminal. The defaults are what the terminal did before the settings existed,
// and the name of a font is text from a file, so it must never get anything but names through.

/** What `TerminalView.tsx` hard-coded before the options existed. */
const BEFORE = {
  fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  scrollback: 10_000,
  cursorBlink: true,
};

describe("the defaults", () => {
  it("are what the terminal had before the options existed", () => {
    expect(DEFAULT_TERMINAL_OPTIONS.fontFamily).toBe(BEFORE.fontFamily);
    expect(DEFAULT_TERMINAL_OPTIONS.fontSize).toBe(BEFORE.fontSize);
    expect(DEFAULT_TERMINAL_OPTIONS.scrollback).toBe(BEFORE.scrollback);
    expect(DEFAULT_TERMINAL_OPTIONS.cursorBlink).toBe(BEFORE.cursorBlink);
    expect(DEFAULT_TERMINAL_OPTIONS.cursorStyle).toBe("block");
    expect(DEFAULT_TERMINAL_OPTIONS.lineHeight).toBe(1);
    expect(DEFAULT_TERMINAL_OPTIONS.bell).toBe("none");
    expect(DEFAULT_TERMINAL_OPTIONS.ligatures).toBe(false);
  });

  it("are what settings that say nothing give", () => {
    expect(terminalOptionsOf(undefined)).toEqual(DEFAULT_TERMINAL_OPTIONS);
    expect(terminalOptionsOf({})).toEqual(DEFAULT_TERMINAL_OPTIONS);
    expect(terminalOptionsOf({ font: {}, cursor: {} })).toEqual(DEFAULT_TERMINAL_OPTIONS);
  });

  it("write the default font list into the same CSS value", () => {
    expect(DEFAULT_FONT_FAMILY_CSS).toBe(BEFORE.fontFamily);
    expect(safeFontFamily(DEFAULT_FONT_FAMILY)).toBe(BEFORE.fontFamily);
  });
});

describe("a list of font names", () => {
  const names = (text: string) => {
    const result = parseFontFamilies(text);
    if (!result.ok) throw new Error(result.problem);
    return result.families.map((family) => `${family.kind}:${family.name}`);
  };

  it("reads names with or without quotes and keeps a bare generic family generic", () => {
    expect(names("Cascadia Code, JetBrains Mono, monospace")).toEqual([
      "name:Cascadia Code",
      "name:JetBrains Mono",
      "generic:monospace",
    ]);
    expect(names(`"Fira Code", 'Hack', Consolas`)).toEqual([
      "name:Fira Code",
      "name:Hack",
      "name:Consolas",
    ]);
    expect(names("Monospace")).toEqual(["generic:monospace"]);
    expect(names("  Consolas  ")).toEqual(["name:Consolas"]);
  });

  it("keeps a quoted generic word as a name", () => {
    expect(names('"monospace"')).toEqual(["name:monospace"]);
    expect(cssFontFamily([{ kind: "name", name: "monospace" }])).toBe('"monospace"');
  });

  it("accepts the names real fonts have", () => {
    for (const name of [
      "M+ 1m",
      "Noto Sans Mono CJK JP",
      "Source Code Pro",
      "Hack Nerd Font Mono",
      "PT Mono",
      "ＭＳ ゴシック",
      "等线",
      "3270 Nerd Font",
      "Fira Code-Retina",
      "A&B.c_d",
    ]) {
      expect(fontFamilyProblem(name), name).toBeUndefined();
      expect(isFontName(name), name).toBe(true);
    }
  });

  it("refuses an address, a function, a semicolon, braces and the other ways out of a name", () => {
    for (const text of [
      "url(https://example.com/x.woff)",
      "https://example.com/x.woff",
      "//example.com/x",
      "Evil; background: red",
      "Evil } body { display: none",
      "Evil{",
      "a\\b",
      'Evil"Font',
      "Evil'Font",
      "Evil`Font",
      "Evil\nFont",
      "Evil\tFont",
      "Evil\u0000Font",
      "<script>",
      "a:b",
      "a/b",
      "a@b",
      "a!important",
      "a(b)",
      "a=b",
      "a|b",
      `a${String.fromCharCode(0x2028)}b`,
    ]) {
      expect(fontFamilyProblem(text), JSON.stringify(text)).toBeDefined();
    }
  });

  it("refuses an empty list and an empty item", () => {
    expect(fontFamilyProblem("")).toMatch(/at least one/);
    expect(fontFamilyProblem("   ")).toMatch(/at least one/);
    expect(fontFamilyProblem("Consolas,")).toMatch(/empty/);
    expect(fontFamilyProblem(",Consolas")).toMatch(/empty/);
    expect(fontFamilyProblem("Consolas, , Hack")).toMatch(/empty/);
    expect(fontFamilyProblem('""')).toMatch(/empty/);
  });

  it("refuses a name that starts with a sign and a list or name that is too long", () => {
    expect(fontFamilyProblem("-Hack")).toBeDefined();
    expect(fontFamilyProblem(" . Hack")).toBeDefined();
    expect(fontFamilyProblem("x".repeat(65))).toMatch(/at most 64/);
    expect(fontFamilyProblem("x".repeat(64))).toBeUndefined();
    expect(fontFamilyProblem(`${"a, ".repeat(MAX_FONT_FAMILIES)}z`)).toMatch(/at most 12/);
    expect(fontFamilyProblem(Array.from({ length: MAX_FONT_FAMILIES }, () => "a").join(","))).toBe(
      undefined,
    );
    expect(fontFamilyProblem("a,".repeat(MAX_FONT_FAMILY_LENGTH))).toMatch(/at most 300/);
  });

  it("says which name it did not like without echoing a long text", () => {
    const problem = fontFamilyProblem(`${"x".repeat(60)};${"y".repeat(60)}`);
    expect(problem).toBeDefined();
    expect((problem ?? "").length).toBeLessThan(220);
  });

  it("is written as quoted names and bare keywords", () => {
    expect(safeFontFamily("Cascadia Code, JetBrains Mono, monospace")).toBe(
      '"Cascadia Code", "JetBrains Mono", monospace',
    );
    expect(safeFontFamily("Consolas")).toBe("Consolas");
    expect(safeFontFamily("M+ 1m, 3270 Nerd Font")).toBe('"M+ 1m", "3270 Nerd Font"');
  });

  it("never turns text that is not a font list into anything but the default font", () => {
    expect(safeFontFamily("url(https://example.com/x.woff)")).toBe(DEFAULT_FONT_FAMILY_CSS);
    expect(safeFontFamily("a; b")).toBe(DEFAULT_FONT_FAMILY_CSS);
    expect(safeFontFamily("")).toBe(DEFAULT_FONT_FAMILY_CSS);
  });

  it("only ever produces names, whatever the text (property)", () => {
    // Whatever text goes in, the CSS value that comes out holds no way out of a font-family
    // value: no semicolon, brace, parenthesis, backslash, angle bracket or line break, and every
    // quote is one of the pairs around a name.
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const css = safeFontFamily(text);
        expect(css).not.toMatch(/[;{}()\\<>\n\r\p{Zl}\p{Zp}]/u);
        const quotes = css.match(/"/g)?.length ?? 0;
        expect(quotes % 2).toBe(0);
        const inside = css.replace(/"[^"]*"/g, "");
        expect(inside).not.toContain('"');
        // A plain name may spell "url" ("URl" is a font name); what must never come out is the
        // function, `url(`, which would load something.
        expect(css).not.toMatch(/url\s*\(/i);
      }),
      { numRuns: 500 },
    );
  });

  it("only ever produces names for text built from the dangerous characters (property)", () => {
    const danger = fc.stringMatching(/^[a-z ,;{}()"'\\/:@<>=!\n]{0,60}$/);
    fc.assert(
      fc.property(danger, (text) => {
        const result = parseFontFamilies(text);
        if (!result.ok) return;
        const css = cssFontFamily(result.families);
        expect(css).not.toMatch(/[;{}()\\<>:/@=!\n']/);
      }),
      { numRuns: 500 },
    );
  });
});

describe("the font size", () => {
  it("is kept between the smallest and the largest", () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(500)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(15)).toBe(15);
    expect(clampFontSize(13.5)).toBe(13.5);
    expect(clampFontSize(Number.NaN)).toBe(14);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(14);
  });

  it("is the size of the settings moved by the zoom, kept in range", () => {
    expect(zoomedFontSize(14, 0)).toBe(14);
    expect(zoomedFontSize(14, 3)).toBe(17);
    expect(zoomedFontSize(14, -3)).toBe(11);
    expect(zoomedFontSize(14, 1000)).toBe(MAX_FONT_SIZE);
    expect(zoomedFontSize(14, -1000)).toBe(MIN_FONT_SIZE);
  });

  it("steps one pixel at a time from the size on screen", () => {
    expect(nextZoom(14, 0, 1)).toBe(1);
    expect(nextZoom(14, 1, 1)).toBe(2);
    expect(nextZoom(14, 2, -1)).toBe(1);
    expect(nextZoom(14, 1, -1)).toBe(0);
    expect(nextZoom(14, 0, -1)).toBe(-1);
  });

  it("stops at the limits without piling up steps that would have to be undone", () => {
    // At the largest size a press changes nothing, and one press back moves one step.
    const atMax = MAX_FONT_SIZE - 14;
    expect(nextZoom(14, atMax, 1)).toBe(atMax);
    expect(nextZoom(14, atMax + 50, -1)).toBe(atMax - 1);
    const atMin = MIN_FONT_SIZE - 14;
    expect(nextZoom(14, atMin, -1)).toBe(atMin);
    expect(nextZoom(14, atMin - 50, 1)).toBe(atMin + 1);
  });

  it("follows a size of the settings that changed (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIN_FONT_SIZE, max: MAX_FONT_SIZE }),
        fc.integer({ min: -100, max: 100 }),
        fc.constantFrom(1 as const, -1 as const),
        (base, zoom, direction) => {
          const shown = zoomedFontSize(base, zoom);
          const next = zoomedFontSize(base, nextZoom(base, zoom, direction));
          expect(next).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
          expect(next).toBeLessThanOrEqual(MAX_FONT_SIZE);
          expect(next).toBe(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, shown + direction)));
        },
      ),
    );
  });
});

describe("the options of the settings", () => {
  it("take what the file sets and the default for the rest", () => {
    const options = terminalOptionsOf({
      font: { family: "Fira Code, monospace", size: 16 },
      cursor: { style: "bar" },
      scrollback: 500,
      bell: "visual",
    });
    expect(options).toEqual({
      ...DEFAULT_TERMINAL_OPTIONS,
      fontFamily: '"Fira Code", monospace',
      fontSize: 16,
      cursorStyle: "bar",
      scrollback: 500,
      bell: "visual",
    });
  });

  it("take the cursor blink, the line height and the ligatures as given", () => {
    const options = terminalOptionsOf({
      font: { lineHeight: 1.4, ligatures: true },
      cursor: { blink: false },
    });
    expect(options.cursorBlink).toBe(false);
    expect(options.lineHeight).toBe(1.4);
    expect(options.ligatures).toBe(true);
  });

  it("keep a value that skipped the schema in range, because xterm throws on a line height under 1", () => {
    expect(terminalOptionsOf({ font: { lineHeight: 0.5 } }).lineHeight).toBe(MIN_LINE_HEIGHT);
    expect(terminalOptionsOf({ font: { lineHeight: 9 } }).lineHeight).toBe(MAX_LINE_HEIGHT);
    expect(terminalOptionsOf({ font: { lineHeight: Number.NaN } }).lineHeight).toBe(1);
    expect(terminalOptionsOf({ font: { size: 1 } }).fontSize).toBe(MIN_FONT_SIZE);
    expect(terminalOptionsOf({ font: { size: 1000 } }).fontSize).toBe(MAX_FONT_SIZE);
    expect(terminalOptionsOf({ scrollback: -5 }).scrollback).toBe(0);
    expect(terminalOptionsOf({ scrollback: 1e9 }).scrollback).toBe(MAX_SCROLLBACK);
    expect(terminalOptionsOf({ scrollback: 12.6 }).scrollback).toBe(13);
    expect(terminalOptionsOf({ font: { family: "url(x)" } }).fontFamily).toBe(
      DEFAULT_FONT_FAMILY_CSS,
    );
  });
});

describe("a list of installed fonts", () => {
  it("keeps the names of fonts once each, in alphabetical order, whatever the case", () => {
    expect(
      fontNameList(["Consolas", "cascadia mono", "Courier New", "consolas", "  Hack  ", "Hack"]),
    ).toEqual(["cascadia mono", "Consolas", "Courier New", "Hack"]);
  });

  it("leaves out what is not the name of a font", () => {
    expect(
      fontNameList([
        "Consolas",
        "",
        "   ",
        'Evil"Font',
        "a;b",
        "url(http://x)",
        "a,b",
        42,
        null,
        { name: "Hack" },
        "x".repeat(65),
      ]),
    ).toEqual(["Consolas"]);
  });

  it("is empty for no names", () => {
    expect(fontNameList([])).toEqual([]);
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { THEMES } from "./builtin-themes";
import { jsonProfiles, jsonSchemes } from "./import-json";
import {
  JSON_BROKEN,
  JSON_ONE_SCHEME,
  JSON_PROFILES_ONLY,
  JSON_SCHEME_LIST,
  JSON_SETTINGS,
  KEY_VALUE_BAD_COLOR,
  KEY_VALUE_LAGOON,
  KEY_VALUE_NO_BACKGROUND,
  LAGOON_COLORS,
  NOT_A_SCHEME,
  PLIST_BINARY,
  PLIST_LAGOON,
  PLIST_MISSING_COLOR,
  PLIST_TRUNCATED,
} from "./import-fixtures";
import { keyValueSchemeColors } from "./import-keyvalue";
import { parsePlist, plistSchemeColors } from "./import-plist";
import {
  UNKNOWN_FORMAT_MESSAGE,
  detectFormat,
  importColorSchemes,
  importProfiles,
} from "./importers";
import { THEME_ID_PATTERN, parseTheme } from "./theme";
import type { Theme } from "./theme";

/** The byte order mark an editor may put at the start of a file. */
const BOM = String.fromCharCode(0xfeff);

/** The result of an import that must have worked. */
function themesOf(text: string, options?: Parameters<typeof importColorSchemes>[1]): Theme[] {
  const result = importColorSchemes(text, options);
  if (!result.ok) throw new Error(`the import failed: ${result.errors.join(" | ")}`);
  return result.themes;
}

/** What every theme an import gives must be. */
function expectSound(themes: readonly Theme[]): void {
  const ids = themes.map((theme) => theme.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const theme of themes) {
    expect(parseTheme(theme).ok).toBe(true);
    expect(theme.id).toMatch(THEME_ID_PATTERN);
    expect(THEMES.some((builtin) => builtin.id === theme.id)).toBe(false);
    expect(theme.id).not.toBe("system");
  }
}

function expectLagoon(theme: Theme): void {
  expect(theme.terminal.background).toBe(LAGOON_COLORS.background);
  expect(theme.terminal.foreground).toBe(LAGOON_COLORS.foreground);
  expect(theme.terminal.cursor).toBe(LAGOON_COLORS.cursor);
  expect(theme.terminal.selection).toBe(LAGOON_COLORS.selection);
  expect(theme.terminal.ansi).toEqual(LAGOON_COLORS.ansi);
  expect(theme.kind).toBe("dark");
}

describe("detectFormat", () => {
  it("tells the formats apart by what is in the file", () => {
    expect(detectFormat(PLIST_LAGOON)).toBe("plist");
    expect(detectFormat(`${BOM}  ${PLIST_LAGOON}`)).toBe("plist");
    expect(detectFormat(JSON_SETTINGS)).toBe("json");
    expect(detectFormat(JSON_SCHEME_LIST)).toBe("json");
    expect(detectFormat(KEY_VALUE_LAGOON)).toBe("key-value");
    expect(detectFormat(PLIST_BINARY)).toBe("binary-plist");
  });

  it("finds nothing in text that is none of them", () => {
    expect(detectFormat(NOT_A_SCHEME)).toBeUndefined();
    expect(detectFormat("")).toBeUndefined();
    expect(detectFormat("   \n  ")).toBeUndefined();
    expect(detectFormat("# only a comment\n")).toBeUndefined();
  });
});

describe("plist color schemes", () => {
  it("reads a valid file into a valid theme with the colors of the file", () => {
    const [theme, ...rest] = themesOf(PLIST_LAGOON, { name: "Lagoon" });
    expect(rest).toHaveLength(0);
    expect(theme).toBeDefined();
    if (!theme) return;
    expectLagoon(theme);
    expect(theme.id).toBe("lagoon");
    expect(theme.name).toBe("Lagoon");
    expectSound([theme]);
  });

  it("names a file that has no name after its format, never after a product", () => {
    const [theme] = themesOf(PLIST_LAGOON);
    expect(theme?.name).toBe("Imported plist scheme");
    expect(theme?.id).toBe("imported-plist-scheme");
  });

  it("keeps the alpha of the selection color", () => {
    const see = PLIST_LAGOON.replace(
      /(<key>Selection Color<\/key>[\s\S]*?<key>Alpha Component<\/key>\s*<real>)1(<\/real>)/,
      "$10.5$2",
    );
    expect(see).not.toBe(PLIST_LAGOON);
    expect(themesOf(see)[0]?.terminal.selection).toBe("#2b3f5580");
  });

  it("reports what is missing", () => {
    const result = importColorSchemes(PLIST_MISSING_COLOR);
    expect(result).toEqual({ ok: false, errors: ['"Ansi 3 Color" is missing'] });
  });

  it("reports a file that is cut off, binary, or not a property list", () => {
    for (const text of [PLIST_TRUNCATED, PLIST_BINARY, "<?xml version='1.0'?><html></html>"]) {
      const result = importColorSchemes(text);
      expect(result.ok).toBe(false);
    }
    const binary = importColorSchemes(PLIST_BINARY);
    expect(!binary.ok && binary.errors[0]).toMatch(/binary property list/);
  });

  it("reads entities, comments, an empty string, a self-closing value and any number type", () => {
    const parsed = parsePlist(`<?xml version="1.0"?>
<!-- a comment -->
<plist version="1.0"><dict>
  <key>a &amp; b</key><string>x &lt; y &#65; &#x42;</string>
  <key>empty</key><string/>
  <key>list</key><array><integer>1</integer><real>2.5</real><true/><false></false></array>
  <key>nested</key><dict></dict>
</dict></plist>`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !(parsed.value instanceof Map)) return;
    expect(parsed.value.get("a & b")).toBe("x < y A B");
    expect(parsed.value.get("empty")).toBe("");
    expect(parsed.value.get("list")).toEqual([1, 2.5, true, false]);
    expect(parsed.value.get("nested")).toEqual(new Map());
  });

  it("does not follow a nesting deeper than a color file has, and keeps __proto__ a plain key", () => {
    const deep = `<plist>${"<array>".repeat(500)}${"</array>".repeat(500)}</plist>`;
    expect(parsePlist(deep)).toEqual({
      ok: false,
      error: "Not a readable property list: the property list is nested too deep",
    });
    const proto = parsePlist("<plist><dict><key>__proto__</key><string>x</string></dict></plist>");
    expect(proto.ok && proto.value instanceof Map && proto.value.get("__proto__")).toBe("x");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("refuses a color with a component out of range or not a number", () => {
    const parsed = parsePlist(
      PLIST_LAGOON.replace("<real>0.0627450980392157</real>", "<real>2</real>"),
    );
    expect(parsed.ok).toBe(true);
    const bad = parsePlist(
      "<plist><dict><key>Ansi 0 Color</key><dict><key>Red Component</key><real>abc</real></dict></dict></plist>",
    );
    expect(bad.ok).toBe(false);
    expect(plistSchemeColors(new Map()).ok).toBe(false);
    expect(plistSchemeColors("x").ok).toBe(false);
  });
});

describe("key = value color schemes", () => {
  it("reads a valid file into a valid theme with the colors of the file", () => {
    const [theme, ...rest] = themesOf(KEY_VALUE_LAGOON, { name: "Lagoon" });
    expect(rest).toHaveLength(0);
    expect(theme).toBeDefined();
    if (!theme) return;
    expectLagoon(theme);
    expect(theme.id).toBe("lagoon");
    expectSound([theme]);
  });

  it("ignores the colors past the sixteenth and the keys it does not use, and tolerates a bare color and quotes", () => {
    const text = KEY_VALUE_LAGOON.replace("background = #101820", 'background = "101820"');
    expectLagoon(themesOf(text)[0] as Theme);
  });

  it("names a file that has no name after its format", () => {
    expect(themesOf(KEY_VALUE_LAGOON)[0]?.name).toBe("Imported key-value scheme");
  });

  it("derives the cursor and the selection when the file has neither", () => {
    const text = KEY_VALUE_LAGOON.split("\n")
      .filter(
        (line) => !line.startsWith("cursor-color") && !line.startsWith("selection-background"),
      )
      .join("\n");
    const theme = themesOf(text)[0];
    expect(theme?.terminal.cursor).toBe(LAGOON_COLORS.foreground);
    expect(theme?.terminal.selection).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("reports a color that is not one, with its line", () => {
    const result = importColorSchemes(KEY_VALUE_BAD_COLOR);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(" ")).toMatch(/line \d+: "lagoon-blue" is not a color/);
  });

  it("reports what is missing", () => {
    expect(importColorSchemes(KEY_VALUE_NO_BACKGROUND)).toEqual({
      ok: false,
      errors: ['"background" is missing'],
    });
    const some = importColorSchemes(
      "background = #000000\nforeground = #ffffff\npalette = 0=#000000\n",
    );
    expect(!some.ok && some.errors[0]).toMatch(/palette is missing the colors 1, 2, 3/);
  });

  it("warns about a line that is not key = value", () => {
    const result = keyValueSchemeColors(`oops\n${KEY_VALUE_LAGOON}`);
    expect(result.ok && result.warnings).toEqual(['line 1: not a "key = value" line, ignored']);
  });
});

describe("JSON color schemes and profiles", () => {
  it("reads the valid schemes of a settings file and leaves out the broken one with a warning", () => {
    const result = importColorSchemes(JSON_SETTINGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.format).toBe("json");
    expect(result.themes.map((theme) => theme.name)).toEqual(["Lagoon", "Noren Dusk (2)"]);
    expect(result.warnings).toEqual(['Scheme "Broken": "red" is missing']);
    expectLagoon(result.themes[0] as Theme);
    expectSound(result.themes);
  });

  it("reads a bare list of schemes and a single scheme", () => {
    expectLagoon(themesOf(JSON_SCHEME_LIST)[0] as Theme);
    const [one] = themesOf(JSON_ONE_SCHEME);
    expectLagoon(one as Theme);
    expect(one?.id).toBe("lagoon");
  });

  it("takes the name of the file for a scheme that has no name", () => {
    const nameless = JSON_ONE_SCHEME.replace('"name": "Lagoon",', "");
    expect(themesOf(nameless, { name: "My Colors" })[0]?.name).toBe("My Colors");
    expect(themesOf(nameless)[0]?.name).toBe("Imported JSON scheme");
  });

  it("reports a syntax error with its line, and a file with no schemes", () => {
    const broken = importColorSchemes(JSON_BROKEN);
    expect(!broken.ok && broken.errors[0]).toMatch(/^line 1, column \d+: /);
    expect(importColorSchemes(JSON_PROFILES_ONLY)).toEqual({
      ok: false,
      errors: ["This JSON file has profiles but no color schemes"],
    });
    expect(importColorSchemes("{}")).toEqual({
      ok: false,
      errors: ["This JSON file has no color schemes"],
    });
    expect(importColorSchemes("[]")).toEqual({
      ok: false,
      errors: ["The list of color schemes is empty"],
    });
  });

  it("reads the profiles of a settings file and leaves out the hidden ones", () => {
    const result = importProfiles(JSON_SETTINGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profiles).toEqual([
      {
        name: "Command Prompt",
        commandLine: "cmd.exe",
        startingDirectory: "%USERPROFILE%",
        colorScheme: "Lagoon",
      },
      {
        name: "Dev Shell",
        commandLine: "pwsh.exe -NoLogo",
        startingDirectory: null,
        colorScheme: null,
      },
      { name: "No Command", commandLine: null, startingDirectory: null, colorScheme: null },
    ]);
    expect(result.hidden).toBe(1);
    expect(result.profiles.map((profile) => profile.name)).not.toContain("Hidden Shell");
    expect(result.warnings).toEqual(["Profile 5 has no name, left out"]);
  });

  it("reads profiles given as a bare list, and refuses a file without any", () => {
    const bare = importProfiles(JSON_PROFILES_ONLY);
    expect(bare.ok && bare.profiles.map((profile) => profile.name)).toEqual(["Shell"]);
    expect(importProfiles(JSON_SCHEME_LIST)).toEqual({
      ok: false,
      errors: ["This JSON file has no list of profiles"],
    });
    const broken = importProfiles(JSON_BROKEN);
    expect(broken.ok).toBe(false);
  });
});

describe("ids", () => {
  it("never take the id of a built-in theme", () => {
    for (const theme of THEMES) {
      const [imported] = themesOf(KEY_VALUE_LAGOON, { name: theme.name });
      expect(imported?.id).toBe(`${theme.id}-2`);
      expect(imported?.name).toBe(`${theme.name} (2)`);
    }
  });

  it("never take the id of a theme the user has", () => {
    const [imported] = themesOf(PLIST_LAGOON, { name: "Lagoon", takenIds: ["lagoon", "lagoon-2"] });
    expect(imported?.id).toBe("lagoon-3");
  });

  it("never take `system`, which means to follow the system", () => {
    expect(themesOf(PLIST_LAGOON, { name: "System" })[0]?.id).toBe("system-2");
  });

  it("do not repeat inside one file", () => {
    const twice = `[ ${JSON_ONE_SCHEME}, ${JSON_ONE_SCHEME}, ${JSON_ONE_SCHEME} ]`;
    const themes = themesOf(twice);
    expect(themes.map((theme) => theme.id)).toEqual(["lagoon", "lagoon-2", "lagoon-3"]);
    expect(themes.map((theme) => theme.name)).toEqual(["Lagoon", "Lagoon (2)", "Lagoon (3)"]);
    expectSound(themes);
  });

  it("are slugs of the name, with the accents and symbols taken out", () => {
    expect(themesOf(PLIST_LAGOON, { name: "Café Nuit #2" })[0]?.id).toBe("cafe-nuit-2");
  });

  it("never name a product: what is generated speaks of the file format", () => {
    const generated = [
      PLIST_LAGOON,
      KEY_VALUE_LAGOON,
      JSON_ONE_SCHEME.replace('"name": "Lagoon",', ""),
    ].map((text) => themesOf(text)[0]);
    for (const theme of generated) {
      expect(`${theme?.id} ${theme?.name}`).toMatch(
        /^imported-(plist|key-value|json)-scheme Imported/,
      );
    }
    expect(UNKNOWN_FORMAT_MESSAGE).toMatch(/plist \(\.itermcolors\), JSON and "key = value"/);
  });
});

describe("what is not a scheme", () => {
  it("is told so in a sentence", () => {
    expect(importColorSchemes(NOT_A_SCHEME)).toEqual({
      ok: false,
      errors: [UNKNOWN_FORMAT_MESSAGE],
    });
    expect(importColorSchemes("")).toEqual({ ok: false, errors: [UNKNOWN_FORMAT_MESSAGE] });
  });

  it("is refused when it is too large to be one", () => {
    const result = importColorSchemes(`${"# padding\n".repeat(120_000)}${KEY_VALUE_LAGOON}`);
    expect(result).toEqual({ ok: false, errors: ["This file is too large to be a color scheme"] });
    expect(importProfiles(" ".repeat(1_000_001))).toEqual({
      ok: false,
      errors: ["This file is too large to be a settings file"],
    });
  });
});

describe("the importers never throw", () => {
  const fixtures = [
    PLIST_LAGOON,
    KEY_VALUE_LAGOON,
    JSON_SETTINGS,
    JSON_SCHEME_LIST,
    PLIST_MISSING_COLOR,
    KEY_VALUE_BAD_COLOR,
    JSON_BROKEN,
  ];

  /** Whatever came out, it is a result with sound themes or sentences. */
  function expectResult(text: string): void {
    const result = importColorSchemes(text, { name: "Whatever", takenIds: ["whatever"] });
    if (result.ok) {
      expect(result.themes.length).toBeGreaterThan(0);
      expectSound(result.themes);
    } else {
      expect(result.errors.length).toBeGreaterThan(0);
      for (const error of result.errors) expect(typeof error).toBe("string");
    }
    const profiles = importProfiles(text);
    expect(typeof profiles.ok).toBe("boolean");
  }

  it("for any text", () => {
    fc.assert(fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" })), expectResult), {
      numRuns: 500,
    });
  });

  it("for a file cut off anywhere, or with a character changed", () => {
    const cut = fc
      .constantFrom(...fixtures)
      .chain((text) => fc.nat(text.length).map((length) => text.slice(0, length)));
    const changed = fc
      .constantFrom(...fixtures)
      .chain((text) =>
        fc
          .tuple(fc.nat(text.length), fc.string({ minLength: 0, maxLength: 3 }))
          .map(([at, insert]) => text.slice(0, at) + insert + text.slice(at + 1)),
      );
    fc.assert(fc.property(fc.oneof(cut, changed), expectResult), { numRuns: 1500 });
  });

  it("for any value a JSON file can hold", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(typeof jsonSchemes(value).ok).toBe("boolean");
        expect(typeof jsonProfiles(value).ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });

  it("for a deeply nested file", () => {
    expectResult(`[`.repeat(5000));
    expectResult(`<plist>${"<dict><key>a</key>".repeat(2000)}`);
    expectResult(`{"schemes":${"[".repeat(3000)}`);
  });
});

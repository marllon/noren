import { describe, expect, it } from "vitest";
import { findTheme, NOREN_DUSK, NOREN_PAPER, THEMES } from "./builtin-themes";
import { importColorSchemes } from "./importers";
import { ThemeSchema, parseTheme } from "./theme";
import type { Theme } from "./theme";
import { MAX_THEME_NAME, duplicateTheme, renameTheme } from "./theme-actions";
import { parseUserThemes, serializeTheme } from "./user-themes";

// The theme that is made by duplicating or renaming one has to be a valid theme file: what the
// settings screen writes to `themes/` is checked here against the schema, the built-in themes'
// copies included, and a theme exported and imported again comes back whole.

/** The theme of a copy that must be valid: fails the test with where it is wrong. */
function copyOf(theme: Theme, name: string, taken: Iterable<string> = []): Theme {
  const result = duplicateTheme(theme, name, taken);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.theme;
}

describe("duplicateTheme", () => {
  it("copies every theme that ships with the app into a valid theme of its own", () => {
    for (const theme of THEMES) {
      const copy = copyOf(theme, `${theme.name} copy`);
      expect(ThemeSchema.safeParse(copy).success, theme.id).toBe(true);
      expect(copy.id).toBe(`${theme.id}-copy`);
      expect(copy.name).toBe(`${theme.name} copy`);
      // Everything but the identity is the original's, so it looks the same until it is edited.
      expect({ ...copy, id: theme.id, name: theme.name }).toEqual(theme);
    }
  });

  it("is a new object: changing the copy never changes the original", () => {
    const original = findTheme("noren-dusk");
    if (original === undefined) throw new Error("the built-in theme is gone");
    const before = JSON.stringify(original);
    const copy = copyOf(original, "Mine");
    copy.ui.accent = "#00ff00";
    copy.terminal.ansi[1] = "#00ff00";
    copy.font.size = 30;
    expect(JSON.stringify(original)).toBe(before);
  });

  it("takes an id nothing else has: the built-in ids, system and the ids given", () => {
    expect(copyOf(NOREN_DUSK, "Noren Dusk").id).toBe("noren-dusk-2");
    expect(copyOf(NOREN_DUSK, "Noren Dusk").name).toBe("Noren Dusk (2)");
    expect(copyOf(NOREN_DUSK, "System").id).toBe("system-2");
    const taken = ["mine", "mine-2", "mine-3"];
    expect(copyOf(NOREN_DUSK, "Mine", taken).id).toBe("mine-4");
    expect(copyOf(NOREN_DUSK, "Mine", taken).name).toBe("Mine (4)");
    expect(copyOf(NOREN_DUSK, "Mine", ["other"]).id).toBe("mine");
  });

  it("gives the same answer for a second copy only when the first is in the ids given", () => {
    const first = copyOf(NOREN_PAPER, "Noren Paper copy");
    expect(copyOf(NOREN_PAPER, "Noren Paper copy").id).toBe(first.id);
    expect(copyOf(NOREN_PAPER, "Noren Paper copy", [first.id]).id).toBe(`${first.id}-2`);
  });

  it("makes an id from a name with accents, symbols or nothing to make one from", () => {
    expect(copyOf(NOREN_DUSK, "Cópia do Crepúsculo").id).toBe("copia-do-crepusculo");
    expect(copyOf(NOREN_DUSK, "Cópia do Crepúsculo").name).toBe("Cópia do Crepúsculo");
    expect(copyOf(NOREN_DUSK, "!!!").id).toBe("theme");
    expect(copyOf(NOREN_DUSK, "   ").name.length).toBeGreaterThan(0);
  });

  it("keeps the id within the schema and the name within 60 characters, whatever the name", () => {
    const long = "a long name ".repeat(20);
    const copy = copyOf(NOREN_DUSK, long);
    expect(copy.id.length).toBeLessThanOrEqual(64);
    expect(copy.name.length).toBeLessThanOrEqual(MAX_THEME_NAME);
    expect(parseTheme(copy).ok).toBe(true);
  });

  it("is a theme the loader of the files of the folder accepts, and writes the same text back", () => {
    const copy = copyOf(NOREN_DUSK, "Mine");
    const listed = parseUserThemes([serializeTheme(copy)]);
    expect(listed.ignored).toEqual([]);
    expect(listed.themes).toEqual([copy]);
  });

  it("keeps the background and the font of a theme the person made, not only the built-in ones", () => {
    const own: Theme = {
      ...NOREN_PAPER,
      id: "mine",
      name: "Mine",
      font: { family: "Fira Code", size: 15, lineHeight: 1.4, ligatures: false },
      background: { image: "backgrounds/sky.png", opacity: 0.4, blur: 6 },
      ui: { ...NOREN_PAPER.ui, radius: 0, accent: "#112233" },
    };
    const copy = copyOf(own, "Mine copy", ["mine"]);
    expect(copy).toEqual({ ...own, id: "mine-copy", name: "Mine copy" });
  });
});

describe("renameTheme", () => {
  const mine: Theme = { ...NOREN_DUSK, id: "mine", name: "Mine" };

  it("changes the name and nothing else, the id included", () => {
    const result = renameTheme(mine, "Better name");
    expect(result).toEqual({ ok: true, theme: { ...mine, name: "Better name" } });
    expect(mine.name).toBe("Mine");
  });

  it("cleans the name as an imported one is: blanks folded, ends trimmed, control characters out", () => {
    for (const [typed, shown] of [
      ["  Spaced   out  ", "Spaced out"],
      ["Tab\there", "Tab here"],
      ["Line\nbreak", "Line break"],
      ["Nul\u0000l", "Nul l"],
    ] as const) {
      const result = renameTheme(mine, typed);
      expect(result.ok, typed).toBe(true);
      if (result.ok) expect(result.theme.name).toBe(shown);
    }
  });

  it("refuses a name that is empty after cleaning, and says so", () => {
    for (const typed of ["", "   ", "\n\t", "\u0000"]) {
      expect(renameTheme(mine, typed)).toEqual({
        ok: false,
        errors: ["name: A theme needs a name"],
      });
    }
  });

  it("refuses a name past the limit of the schema instead of cutting it", () => {
    const exact = "x".repeat(MAX_THEME_NAME);
    expect(renameTheme(mine, exact).ok).toBe(true);
    expect(renameTheme(mine, `${exact}y`)).toEqual({
      ok: false,
      errors: [`name: At most ${MAX_THEME_NAME} characters`],
    });
  });

  it("answers a theme the schema accepts, for every theme that ships with the app", () => {
    for (const theme of THEMES) {
      const result = renameTheme(theme, "Another");
      expect(result.ok, theme.id).toBe(true);
      if (result.ok) expect(ThemeSchema.safeParse(result.theme).success).toBe(true);
    }
  });

  it("writes a file the loader reads back as the same theme under its new name", () => {
    const result = renameTheme(mine, "Renamed");
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(parseUserThemes([serializeTheme(result.theme)]).themes).toEqual([
      { ...mine, name: "Renamed" },
    ]);
  });
});

describe("importing a theme that was exported", () => {
  const exported = (theme: Theme): string => serializeTheme(theme);
  const mine: Theme = {
    ...NOREN_PAPER,
    id: "mine",
    name: "Mine",
    font: { family: "Fira Code", size: 15, lineHeight: 1.4, ligatures: false },
    background: { image: "backgrounds/sky.png", opacity: 0.4, blur: 6 },
    ui: { ...NOREN_PAPER.ui, radius: 2, accent: "#112233" },
  };

  it("comes back whole: the colors, the font, the radius and the background are not derived again", () => {
    const result = importColorSchemes(exported(mine));
    expect(result).toEqual({ ok: true, format: "json", themes: [mine], warnings: [] });
  });

  it("keeps the id when no other theme has it, and takes a new one when the id is taken", () => {
    const free = importColorSchemes(exported(mine), { takenIds: ["other"] });
    expect(free.ok && free.themes[0]?.id).toBe("mine");
    const taken = importColorSchemes(exported(mine), { takenIds: ["mine"] });
    if (!taken.ok) throw new Error(taken.errors.join("; "));
    expect(taken.themes).toHaveLength(1);
    expect(taken.themes[0]?.id).toBe("mine-2");
    expect(taken.themes[0]?.name).toBe("Mine (2)");
    expect(taken.warnings).toEqual([]);
    expect(parseTheme(taken.themes[0]).ok).toBe(true);
  });

  it("never takes the id of a theme that ships with the app, so an import cannot shadow one", () => {
    const shadow = importColorSchemes(exported({ ...NOREN_DUSK }));
    if (!shadow.ok) throw new Error(shadow.errors.join("; "));
    expect(shadow.themes[0]?.id).toBe("noren-dusk-2");
    expect(THEMES.map((theme) => theme.id)).not.toContain(shadow.themes[0]?.id);
  });

  it("refuses a file shaped like a theme that is not a valid one, and says where", () => {
    const broken = JSON.stringify({ ...mine, ui: { ...mine.ui, accent: "red" } });
    const result = importColorSchemes(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^This theme file is not valid: ui\.accent:/);
    }
    const noName = JSON.stringify({ ...mine, name: "" });
    expect(importColorSchemes(noName).ok).toBe(false);
  });

  it("reads a theme file with comments and a byte order mark, as the folder's loader does", () => {
    const text = `${String.fromCharCode(0xfeff)}// my theme\n${exported(mine)}`;
    const result = importColorSchemes(text);
    expect(result.ok && result.themes[0]).toEqual(mine);
  });

  it("leaves the other JSON files to the importers they always went to", () => {
    // A scheme of another program has `background` and the colors by name, and no `ui` or `terminal`.
    const scheme = JSON.stringify({
      name: "Other",
      foreground: "#cccccc",
      background: "#1e1e1e",
      black: "#000000",
      red: "#cd3131",
      green: "#0dbc79",
      yellow: "#e5e510",
      blue: "#2472c8",
      purple: "#bc3fbc",
      cyan: "#11a8cd",
      white: "#e5e5e5",
      brightBlack: "#666666",
      brightRed: "#f14c4c",
      brightGreen: "#23d18b",
      brightYellow: "#f5f543",
      brightBlue: "#3b8eea",
      brightPurple: "#d670d6",
      brightCyan: "#29b8db",
      brightWhite: "#e5e5e5",
    });
    const result = importColorSchemes(scheme);
    expect(result.ok && result.themes[0]?.name).toBe("Other");
    expect(result.ok && result.themes[0]?.id).toBe("other");
    expect(importColorSchemes('{ "ui": 1 }').ok).toBe(false);
  });
});

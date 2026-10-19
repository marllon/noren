/// <reference types="node" />
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NOREN_DUSK, NOREN_PAPER, THEMES, findTheme } from "./builtin-themes";
import { parseConfigText } from "./config";
import {
  MIN_TEXT_CONTRAST,
  ThemeSchema,
  contrastRatio,
  parseTheme,
  relativeLuminance,
} from "./theme";

const NOTICES_FILE = new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url);

interface NoticeRow {
  theme: string;
  /** The scheme it is based on, without the variant in parentheses. */
  origin: string;
  repository: string;
  license: string;
  holder: string;
}

/** The rows of the table of themes in THIRD_PARTY_NOTICES.md. */
function notices(): NoticeRow[] {
  return readFileSync(NOTICES_FILE, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| Noren "))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        theme: cells[1] ?? "",
        origin: (cells[2] ?? "").replace(/\s*\(.*\)\s*$/, ""),
        repository: cells[3] ?? "",
        license: cells[5] ?? "",
        holder: cells[6] ?? "",
      };
    });
}

/** A deep copy of a theme to break on purpose. */
interface Draft {
  [key: string]: unknown;
  ui: Record<string, unknown>;
  terminal: Record<string, unknown> & { ansi: unknown[] };
  font: Record<string, unknown>;
  background: Record<string, unknown>;
}

function copyOf(): Draft {
  return structuredClone(NOREN_DUSK) as unknown as Draft;
}

describe("ThemeSchema", () => {
  it("accepts a valid theme and the example of the spec", () => {
    expect(parseTheme(NOREN_DUSK)).toEqual({ ok: true, theme: NOREN_DUSK });
    // The example of spec section 8, in the shape of a `themes/*.json` file.
    const fromFile: unknown = JSON.parse(`{
      "id": "noren-dusk", "name": "Noren Dusk", "kind": "dark",
      "ui": { "bg": "#14161b", "surface": "#1b1e25", "text": "#e6e6e6", "muted": "#9aa0aa", "accent": "#e07a5f", "border": "#2a2e37", "radius": 10, "blur": 18, "opacity": 0.92 },
      "terminal": { "foreground": "#e6e6e6", "background": "#14161b", "cursor": "#e07a5f", "selection": "#e07a5f55",
        "ansi": ["#1b1e25","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#dcdfe4","#5c6370","#e06c75","#98c379","#e5c07b","#61afef","#c678dd","#56b6c2","#ffffff"] },
      "font": { "family": "Cascadia Code, JetBrains Mono, monospace", "size": 13, "lineHeight": 1.2, "ligatures": true },
      "background": { "image": null, "opacity": 0.15 }
    }`);
    expect(parseTheme(fromFile)).toEqual({ ok: true, theme: NOREN_DUSK });
  });

  it("accepts a background image path", () => {
    const theme = copyOf();
    theme["background"].image = "images/dusk.png";
    expect(ThemeSchema.safeParse(theme).success).toBe(true);
  });

  it("refuses a theme with a missing field and says which", () => {
    for (const [path, mutate] of [
      ["id", (t: Draft) => delete t["id"]],
      ["kind", (t: Draft) => delete t["kind"]],
      ["ui.accent", (t: Draft) => delete t["ui"].accent],
      ["terminal", (t: Draft) => Reflect.deleteProperty(t, "terminal")],
      ["terminal.cursor", (t: Draft) => delete t["terminal"].cursor],
      ["font.family", (t: Draft) => delete t["font"].family],
      ["background", (t: Draft) => Reflect.deleteProperty(t, "background")],
    ] as const) {
      const theme = copyOf();
      mutate(theme);
      const result = parseTheme(theme);
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.errors.join("\n"), path).toContain(path);
    }
  });

  it("refuses an invalid color, in the interface, the terminal and the ANSI palette", () => {
    for (const bad of [
      "red",
      "#fff",
      "#12345",
      "#1234567",
      "14161b",
      "#gggggg",
      "",
      "#14161b00ff",
    ]) {
      for (const set of [
        (t: Draft) => (t["ui"].bg = bad),
        (t: Draft) => (t["terminal"].foreground = bad),
        (t: Draft) => (t["terminal"].ansi[7] = bad),
        (t: Draft) => (t["terminal"].selection = bad),
      ]) {
        const theme = copyOf();
        set(theme);
        expect(parseTheme(theme).ok, bad).toBe(false);
      }
    }
    const theme = copyOf();
    theme["ui"].accent = "orange";
    const result = parseTheme(theme);
    expect(result.ok ? [] : result.errors).toEqual(["ui.accent: Expected a color like #1a2b3c"]);
  });

  it("allows an alpha only in the selection", () => {
    const withAlpha = copyOf();
    withAlpha["terminal"].selection = "#e07a5f80";
    expect(parseTheme(withAlpha).ok).toBe(true);
    const inUi = copyOf();
    inUi["ui"].bg = "#14161bff";
    expect(parseTheme(inUi).ok).toBe(false);
  });

  it("refuses the wrong number of ANSI colors, an unknown kind, a bad id and numbers out of range", () => {
    const short = copyOf();
    short["terminal"].ansi = short["terminal"].ansi.slice(0, 15);
    const long = copyOf();
    long["terminal"].ansi = [...long["terminal"].ansi, "#000000"];
    const kind = copyOf();
    kind["kind"] = "sepia";
    const badIds = ["Noren Dusk", "noren_dusk", "-dusk", "dusk-", "dusk--2", ""].map((id) => {
      const theme = copyOf();
      theme["id"] = id;
      return theme;
    });
    const opacity = copyOf();
    opacity["ui"].opacity = 1.5;
    const radius = copyOf();
    radius["ui"].radius = -1;
    const size = copyOf();
    size["font"].size = 0;
    const lineHeight = copyOf();
    lineHeight["font"].lineHeight = "tall";
    for (const theme of [short, long, kind, ...badIds, opacity, radius, size, lineHeight]) {
      expect(parseTheme(theme).ok).toBe(false);
    }
  });

  it("refuses a field it does not know, and values that are not objects", () => {
    const extra = copyOf();
    extra["ui"].glow = "#ffffff";
    expect(parseTheme(extra).ok).toBe(false);
    const top = copyOf();
    top["author"] = "someone";
    expect(parseTheme(top).ok).toBe(false);
    for (const value of [null, undefined, 3, "dusk", [], true]) {
      expect(parseTheme(value).ok).toBe(false);
    }
  });

  it("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => parseTheme(value)).not.toThrow();
      }),
    );
  });
});

describe("contrast", () => {
  it("measures black on white as 21 and a color on itself as 1", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#14161b", "#14161b")).toBe(1);
  });

  it("is symmetric and matches a value known from the WCAG formula", () => {
    expect(contrastRatio("#ffffff", "#767676")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  it("ignores an alpha channel", () => {
    expect(contrastRatio("#000000ff", "#ffffff00")).toBeCloseTo(21, 5);
  });

  it("is always between 1 and 21 and symmetric", () => {
    const hex = fc
      .integer({ min: 0, max: 0xffffff })
      .map((n) => `#${n.toString(16).padStart(6, "0")}`);
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const ratio = contrastRatio(a, b);
        expect(ratio).toBeGreaterThanOrEqual(1);
        expect(ratio).toBeLessThanOrEqual(21.0000001);
        expect(ratio).toBeCloseTo(contrastRatio(b, a), 10);
      }),
    );
  });
});

describe("the built-in themes", () => {
  it("are eight, with their own names and ids, five dark and three light", () => {
    expect(THEMES).toHaveLength(8);
    expect(THEMES.map((theme) => theme.id)).toEqual([
      "noren-dusk",
      "noren-paper",
      "noren-nightshade",
      "noren-fjord",
      "noren-midnight",
      "noren-meadow",
      "noren-dune",
      "noren-oat",
    ]);
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(8);
    expect(new Set(THEMES.map((theme) => theme.name)).size).toBe(8);
    for (const theme of THEMES) expect(theme.name).toMatch(/^Noren [A-Z][a-z]+$/);
    expect(THEMES.filter((theme) => theme.kind === "dark")).toHaveLength(5);
    expect(THEMES.filter((theme) => theme.kind === "light")).toHaveLength(3);
  });

  it("keep the names of the schemes they come from out of the interface and the ids", () => {
    // The origin of a port is named in THIRD_PARTY_NOTICES.md only (rule D9). The names to keep
    // out are read from there, so this test does not name them either.
    const rows = notices();
    expect(rows.map((row) => row.theme)).toEqual(
      THEMES.filter((theme) => !["noren-dusk", "noren-paper"].includes(theme.id)).map(
        (theme) => theme.name,
      ),
    );
    for (const theme of THEMES) {
      const text = `${theme.id} ${theme.name}`.toLowerCase();
      for (const { origin } of rows) {
        expect(text).not.toContain(origin.toLowerCase());
        expect(text).not.toContain(origin.toLowerCase().replaceAll(" ", "-"));
      }
    }
  });

  it("have a license and an attribution in THIRD_PARTY_NOTICES.md for every port", () => {
    const text = readFileSync(NOTICES_FILE, "utf8");
    for (const row of notices()) {
      expect(row.license, row.theme).toBe("MIT");
      expect(row.repository, row.theme).toMatch(/^<https:\/\/github\.com\/[\w.-]+\/[\w.-]+>$/);
      expect(row.holder, row.theme).not.toBe("");
    }
    // The full license text of each of the six is there.
    expect(text.match(/Permission is hereby granted, free of charge/g)).toHaveLength(6);
  });

  it.each(THEMES.map((theme) => [theme.name, theme] as const))(
    "%s passes the schema",
    (_name, theme) => {
      expect(ThemeSchema.safeParse(theme).success).toBe(true);
    },
  );

  it.each(THEMES.map((theme) => [theme.name, theme] as const))(
    "%s has text on the background of at least 4.5:1, in the interface and in the terminal",
    (_name, theme) => {
      expect(contrastRatio(theme.ui.text, theme.ui.bg)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      expect(
        contrastRatio(theme.terminal.foreground, theme.terminal.background),
      ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    },
  );

  it.each(THEMES.map((theme) => [theme.name, theme] as const))(
    "%s reads its muted text and its accent on the background (at least 3:1)",
    (_name, theme) => {
      expect(contrastRatio(theme.ui.muted, theme.ui.bg)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.ui.accent, theme.ui.bg)).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(THEMES.map((theme) => [theme.name, theme] as const))(
    "%s tells its kind by its background",
    (_name, theme) => {
      const light = relativeLuminance(theme.ui.bg) > 0.4;
      expect(theme.kind).toBe(light ? "light" : "dark");
      expect(theme.terminal.background).toBe(theme.ui.bg);
      expect(new Set(theme.terminal.ansi.slice(0, 8)).size).toBe(8);
    },
  );

  it("find themes by id", () => {
    expect(findTheme("noren-paper")).toBe(NOREN_PAPER);
    expect(findTheme("no-such-theme")).toBeUndefined();
  });
});

describe("appearance.theme in the settings file", () => {
  it("accepts an id of the right form, or system", () => {
    for (const value of ["noren-dusk", "noren-paper", "system", "my-theme-2", "x"]) {
      expect(parseConfigText(`{ "appearance": { "theme": "${value}" } }`)).toEqual({
        ok: true,
        config: { appearance: { theme: value } },
      });
    }
  });

  it("refuses a value that is not an id, with its line", () => {
    for (const value of ['"Noren Dusk"', '""', "3", "null", "true", '"dusk_1"']) {
      const result = parseConfigText(`{\n  "appearance": {\n    "theme": ${value}\n  }\n}`);
      expect(result.ok, value).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toMatchObject({ path: "appearance.theme", line: 3 });
      }
    }
  });

  it("takes every built-in id", () => {
    for (const theme of THEMES) {
      expect(parseConfigText(`{ "appearance": { "theme": "${theme.id}" } }`).ok).toBe(true);
    }
  });
});

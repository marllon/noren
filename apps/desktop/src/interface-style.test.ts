import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERFACE_STYLES, NOREN_DUSK, NOREN_PAPER } from "@noren/model";
import type { InterfaceStyle } from "@noren/model";
import {
  DEFAULT_INTERFACE_STYLE,
  DENSE_MAX_RADIUS,
  PACKAGED_FONTS,
  STYLE_ACCENTS,
  STYLE_ATTRIBUTE,
  STYLE_FONT,
  applyInterfaceStyle,
  styleRadius,
} from "./interface-style";
import { applyTheme, themeVariables } from "./theme";

// The interface style: the attribute on the root, the token set of each style (style-tokens.css), the
// fonts that ship with the app (fonts.css) and the words docs/THEMING.md says about them. The
// stylesheets are read as text, so what the page would paint cannot drift from what is tested here.
// (That the page really draws with them is e2e/interface-style.spec.ts.)

const here = new URL("./", import.meta.url);
const root = new URL("../../../", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, here), "utf8");
const tokensCss = read("style-tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
const fontsCss = read("fonts.css").replace(/\/\*[\s\S]*?\*\//g, "");
const doc = readFileSync(new URL("docs/THEMING.md", root), "utf8");

/** The text between the braces of the rule that starts with `selector`, at the top of the sheet. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule "${selector}"`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** The custom properties a block of declarations sets, name to value. */
function declarations(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/(--nr-[a-z-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) found.set(name, value.trim());
  }
  return found;
}

const SELECTOR = (style: InterfaceStyle): string => `:root[${STYLE_ATTRIBUTE}="${style}"]`;
const tokens = (style: InterfaceStyle): Map<string, string> =>
  declarations(block(tokensCss, SELECTOR(style)));

describe("the interface styles", () => {
  it("start from glass, which is the default of the schema", () => {
    expect(DEFAULT_INTERFACE_STYLE).toBe("glass");
    expect([...INTERFACE_STYLES]).toEqual(["glass", "dense"]);
  });

  it("are told apart by an attribute of the root element", () => {
    expect(STYLE_ATTRIBUTE).toBe("data-nr-style");
    const set: [string, string][] = [];
    const root = { setAttribute: (name: string, value: string) => set.push([name, value]) };
    applyInterfaceStyle(root, "dense");
    applyInterfaceStyle(root, "glass");
    expect(set).toEqual([
      ["data-nr-style", "dense"],
      ["data-nr-style", "glass"],
    ]);
  });

  it("are glass before the settings are read: the page says so itself", () => {
    const html = readFileSync(new URL("apps/desktop/index.html", root), "utf8");
    expect(html).toContain(`<html lang="en" ${STYLE_ATTRIBUTE}="${DEFAULT_INTERFACE_STYLE}">`);
  });
});

describe("the radius both the theme and the style have a say in", () => {
  it("is the radius of the theme under glass, whatever it is", () => {
    for (const radius of [0, 2, 10, 32]) expect(styleRadius("glass", radius)).toBe(radius);
  });

  it("is at most three pixels under dense, and never raises a corner the theme made smaller", () => {
    expect(DENSE_MAX_RADIUS).toBe(3);
    expect(styleRadius("dense", 10)).toBe(3);
    expect(styleRadius("dense", 32)).toBe(3);
    expect(styleRadius("dense", 3)).toBe(3);
    expect(styleRadius("dense", 2)).toBe(2);
    expect(styleRadius("dense", 0)).toBe(0);
  });

  it("is the one theme variable the style changes", () => {
    for (const theme of [NOREN_DUSK, NOREN_PAPER]) {
      const glass = themeVariables(theme, "glass");
      const dense = themeVariables(theme, "dense");
      expect(themeVariables(theme)).toEqual(glass);
      expect(glass["--nr-radius"]).toBe(`${theme.ui.radius}px`);
      expect(dense["--nr-radius"]).toBe(`${Math.min(theme.ui.radius, 3)}px`);
      const rest = (variables: Record<string, string>) =>
        Object.fromEntries(Object.entries(variables).filter(([name]) => name !== "--nr-radius"));
      expect(rest(dense)).toEqual(rest(glass));
    }
  });

  it("is written with the theme, and again when the style changes", () => {
    const style: Record<string, string> = {};
    const target = {
      style: { setProperty: (name: string, value: string) => (style[name] = value) },
    };
    applyTheme(target, NOREN_DUSK, "dense");
    expect(style["--nr-radius"]).toBe("3px");
    applyTheme(target, NOREN_DUSK, "glass");
    expect(style["--nr-radius"]).toBe("10px");
    // The accent is the theme's, in either style: the style has its own highlight token.
    expect(style["--nr-accent"]).toBe(NOREN_DUSK.ui.accent);
  });
});

describe("style-tokens.css", () => {
  it("has a token set for each style, with the same names in both", () => {
    const glass = [...tokens("glass").keys()].sort();
    const dense = [...tokens("dense").keys()].sort();
    expect(glass.length).toBeGreaterThanOrEqual(15);
    expect(dense).toEqual(glass);
  });

  it("sets nothing the theme or the window sets, so the two never fight over a variable", () => {
    const theirs = new Set([
      ...Object.keys(themeVariables(NOREN_DUSK)),
      "--nr-opacity",
      "--nr-bg-glass",
      "--nr-surface-glass",
      "--nr-terminal-glass",
      "--nr-panel-blur",
    ]);
    for (const style of INTERFACE_STYLES) {
      for (const name of tokens(style).keys()) {
        expect(theirs.has(name), `${style}: ${name}`).toBe(false);
        expect(name).not.toMatch(/^--nr-background-/);
      }
    }
  });

  it("gives each style its own highlight, the first of the colors the designs offer", () => {
    for (const style of INTERFACE_STYLES) {
      const accents = STYLE_ACCENTS[style];
      expect(accents).toHaveLength(4);
      expect(new Set(accents).size).toBe(4);
      for (const color of accents) expect(color).toMatch(/^#[0-9A-F]{6}$/);
      expect(tokens(style).get("--nr-style-accent")?.toLowerCase()).toBe(accents[0]?.toLowerCase());
    }
    expect(STYLE_ACCENTS.glass[0]).not.toBe(STYLE_ACCENTS.dense[0]);
  });

  it("draws glass with rounded cards and a blur, and dense with square panels and no glass", () => {
    const glass = tokens("glass");
    const dense = tokens("dense");
    expect(glass.get("--nr-radius-side")).toBe("14px");
    expect(glass.get("--nr-radius-panel")).toBe("12px");
    expect(glass.get("--nr-gap")).toBe("8px");
    expect(glass.get("--nr-glass-blur-side")).toBe("blur(30px) saturate(160%)");
    expect(dense.get("--nr-radius-side")).toBe("0px");
    expect(dense.get("--nr-radius-panel")).toBe("0px");
    expect(dense.get("--nr-gap")).toBe("1px");
    expect(dense.get("--nr-glass-blur-side")).toBe("none");
    expect(dense.get("--nr-glass-blur-panel")).toBe("none");
    // The dense fills are the solid colors of the theme.
    expect(dense.get("--nr-glass-side")).toBe("var(--nr-surface)");
    expect(dense.get("--nr-glass-panel")).toBe("var(--nr-bg)");
  });

  it("types the interface with the font of the style, falling back to what the system has", () => {
    for (const style of INTERFACE_STYLES) {
      const ui = tokens(style).get("--nr-font-ui") ?? "";
      expect(ui.startsWith(`"${STYLE_FONT[style]}"`), style).toBe(true);
    }
    expect(tokens("glass").get("--nr-font-mono")).toMatch(/^"Geist Mono", /);
    expect(tokens("glass").get("--nr-font-ui")).toContain("system-ui");
    // One monospaced font for everything under dense.
    expect(tokens("dense").get("--nr-font-mono")).toBe("var(--nr-font-ui)");
  });

  it("makes the glass opaque with prefers-reduced-transparency, and only the glass", () => {
    const media = tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)");
    expect(media).toBeGreaterThan(0);
    const inner = declarations(block(tokensCss.slice(media), SELECTOR("glass")));
    expect([...inner.keys()].sort()).toEqual([
      "--nr-glass-blur-panel",
      "--nr-glass-blur-side",
      "--nr-glass-panel",
      "--nr-glass-side",
    ]);
    expect(inner.get("--nr-glass-side")).toBe("var(--nr-surface)");
    expect(inner.get("--nr-glass-panel")).toBe("var(--nr-bg)");
    expect(inner.get("--nr-glass-blur-side")).toBe("none");
    expect(inner.get("--nr-glass-blur-panel")).toBe("none");
    // Dense is solid already: nothing to override there.
    expect(tokensCss.slice(media)).not.toContain(SELECTOR("dense"));
  });

  it("is what docs/THEMING.md lists as the style variables, both columns", () => {
    const start = doc.indexOf("\n#### Style variables\n");
    expect(start).toBeGreaterThan(0);
    // The first table under the heading: its lines run until the first line that is not a row.
    const lines = doc.slice(start + 1).split("\n");
    const first = lines.findIndex((line) => line.startsWith("|"));
    const rows: string[] = [];
    for (const line of lines.slice(first)) {
      if (!line.startsWith("|")) break;
      rows.push(line);
    }
    // The first row names the columns and the second is the rule under them.
    rows.splice(0, 2);
    const documented = rows.map((row) => /`(--nr-[a-z-]+)`/.exec(row)?.[1]);
    expect(documented.sort()).toEqual([...tokens("glass").keys()].sort());
    // The highlight in the table is the one the stylesheet has.
    const accentRow = rows.find((row) => row.includes("`--nr-style-accent`")) ?? "";
    expect(accentRow.toLowerCase()).toContain(STYLE_ACCENTS.glass[0]?.toLowerCase());
    expect(accentRow.toLowerCase()).toContain(STYLE_ACCENTS.dense[0]?.toLowerCase());
  });
});

describe("fonts.css", () => {
  const faces = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
  const field = (face: string, name: string): string =>
    new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(face)?.[1]?.trim() ?? "";

  it("holds one face for every font and weight that ships, and nothing else", () => {
    const declared = faces.map((face) => ({
      family: field(face, "font-family").replace(/"/g, ""),
      weight: Number(field(face, "font-weight")),
    }));
    const key = (font: { family: string; weight: number }) => `${font.family} ${font.weight}`;
    expect(declared.map(key).sort()).toEqual(PACKAGED_FONTS.map(key).sort());
  });

  it("reads every font from a woff2 file of the app that is there, and never from the network", () => {
    expect(faces.length).toBe(PACKAGED_FONTS.length);
    for (const face of faces) {
      const src = field(face, "src");
      const urls = [...src.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");
      expect(urls.length, src).toBe(1);
      const url = urls[0] ?? "";
      expect(url).toMatch(/\.woff2$/);
      expect(url).not.toMatch(/^[a-z]+:/i);
      expect(url).not.toMatch(/^\/\//);
      expect(src).toContain('format("woff2")');
      expect(existsSync(new URL(url, here)), url).toBe(true);
      // A web view swaps to the font once it is read; it never waits on one.
      expect(field(face, "font-display")).toBe("swap");
    }
  });

  it("covers the first font of each style, which is the one the tokens ask for", () => {
    const families = new Set(PACKAGED_FONTS.map((font) => font.family));
    for (const style of INTERFACE_STYLES) expect(families.has(STYLE_FONT[style])).toBe(true);
    expect(families.has("Geist Mono")).toBe(true);
  });

  it("is the only font the interface asks for by name that is not the system's", () => {
    const named = new Set<string>();
    for (const name of readdirSync(here).filter((file) => file.endsWith(".css"))) {
      for (const [, list] of read(name).matchAll(/font-family:\s*([^;]+);/g)) {
        // `var(--nr-font-mono, "Cascadia Mono", ...)` asks for the fonts of its fallback, too.
        const flat = (list ?? "").replace(/var\(--[a-z-]+,?\s*/g, "").replace(/\)/g, "");
        for (const family of flat.split(",")) {
          const clean = family.trim().replace(/"/g, "");
          if (clean !== "" && !clean.startsWith("var(")) named.add(clean);
        }
      }
    }
    const packaged = new Set(PACKAGED_FONTS.map((font) => font.family));
    for (const family of named) {
      expect(
        packaged.has(family) ||
          ["system-ui", "sans-serif", "monospace", "ui-monospace", "inherit"].includes(family) ||
          ["Cascadia Mono", "Consolas", "DejaVu Sans Mono"].includes(family),
        family,
      ).toBe(true);
    }
  });
});

describe("what the app fetches for its look", () => {
  it("is nothing: no stylesheet and no page names an address on the network", () => {
    const files = [
      ...readdirSync(here)
        .filter((name) => name.endsWith(".css"))
        .map((name) => read(name)),
      readFileSync(new URL("apps/desktop/index.html", root), "utf8"),
    ];
    for (const text of files) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  it("keeps the font packages as dependencies of the app, with their attribution in the notices", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("apps/desktop/package.json", root), "utf8"),
    ) as { dependencies: Record<string, string> };
    const notices = readFileSync(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
    for (const name of ["geist", "geist-mono", "jetbrains-mono"]) {
      expect(manifest.dependencies[`@fontsource/${name}`], name).toBeDefined();
      expect(notices).toContain(`@fontsource/${name}`);
    }
    expect(notices).toContain("SIL Open Font License");
    for (const family of ["Geist", "Geist Mono", "JetBrains Mono"]) {
      expect(notices).toContain(family);
    }
  });
});

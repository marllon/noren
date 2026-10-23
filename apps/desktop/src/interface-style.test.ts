import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GLASS_PANEL_OPACITY,
  GLASS_SIDE_MIN_OPACITY,
  GLASS_SIDE_OPACITY_STEP,
  GLASS_SIDE_SOLID_RAMP,
  INTERFACE_STYLES,
  NOREN_DUSK,
  NOREN_PAPER,
  THEMES,
  contrastRatio,
  pictureUnderPanel,
} from "@noren/model";
import type { InterfaceStyle } from "@noren/model";
import {
  BACKDROP_PALETTES,
  DEFAULT_INTERFACE_STYLE,
  DENSE_MAX_RADIUS,
  PACKAGED_FONTS,
  STYLE_ACCENTS,
  SCHEME_ATTRIBUTE,
  STYLE_ATTRIBUTE,
  STYLE_FONT,
  applyColorScheme,
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
      "--nr-glass-blur-sheet",
      "--nr-glass-blur-side",
      "--nr-glass-panel",
      "--nr-glass-sheet",
      "--nr-glass-side",
    ]);
    expect(inner.get("--nr-glass-side")).toBe("var(--nr-surface)");
    expect(inner.get("--nr-glass-panel")).toBe("var(--nr-bg)");
    expect(inner.get("--nr-glass-sheet")).toBe("var(--nr-bg)");
    expect(inner.get("--nr-glass-blur-side")).toBe("none");
    expect(inner.get("--nr-glass-blur-panel")).toBe("none");
    expect(inner.get("--nr-glass-blur-sheet")).toBe("none");
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

describe("the glass surfaces (NOR-F20-18a)", () => {
  const stylesCss = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

  it("tells the kind of the theme to the stylesheet with an attribute of the root", () => {
    expect(SCHEME_ATTRIBUTE).toBe("data-nr-scheme");
    const set: [string, string][] = [];
    const target = { setAttribute: (name: string, value: string) => set.push([name, value]) };
    applyColorScheme(target, "dark");
    applyColorScheme(target, "light");
    expect(set).toEqual([
      ["data-nr-scheme", "dark"],
      ["data-nr-scheme", "light"],
    ]);
  });

  it("uses light-dark() nowhere: the build of the app rewrites it to follow the system, not the theme", () => {
    for (const name of readdirSync(here).filter((file) => file.endsWith(".css"))) {
      const code = read(name).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, name).not.toMatch(/light-dark\(/);
    }
  });

  it("works the fills of the glass out from --nr-opacity with the numbers of the model", () => {
    const glass = tokens("glass");
    const panel = glass.get("--nr-glass-panel") ?? "";
    const side = glass.get("--nr-glass-side") ?? "";
    // Both fall back to the opacity of the glass when the app has not set the variable yet.
    for (const text of [panel, side]) {
      const fallbacks = [...text.matchAll(/var\(--nr-opacity, ([0-9.]+)\)/g)].map((m) =>
        Number(m[1]),
      );
      expect(fallbacks.length).toBeGreaterThan(0);
      for (const fallback of fallbacks) expect(fallback).toBe(GLASS_PANEL_OPACITY);
    }
    expect(panel).toContain("var(--nr-bg)");
    expect(side).toContain("var(--nr-surface)");
    // The sidebar: max(opacity - STEP * min(1, (1 - opacity) / RAMP), MIN), the sum of glassSideOpacity.
    const sum =
      /max\(\s*var\(--nr-opacity, [0-9.]+\) - ([0-9.]+) \* min\(1, \(1 - var\(--nr-opacity, [0-9.]+\)\) \/ ([0-9.]+)\),\s*([0-9.]+)\s*\)/.exec(
        side,
      );
    expect(sum, side).not.toBeNull();
    expect(Number(sum?.[1])).toBe(GLASS_SIDE_OPACITY_STEP);
    expect(Number(sum?.[2])).toBe(GLASS_SIDE_SOLID_RAMP);
    expect(Number(sum?.[3])).toBe(GLASS_SIDE_MIN_OPACITY);
  });

  it("has the color of the active space as the highlight of both styles, falling back to the style's own", () => {
    for (const style of INTERFACE_STYLES) {
      expect(tokens(style).get("--nr-highlight")).toBe(
        "var(--nr-space-color, var(--nr-style-accent))",
      );
    }
  });

  it("makes the glass opaque the same way for the system switch as for the media feature", () => {
    const media = tokensCss.indexOf("@media (prefers-reduced-transparency: reduce)");
    const fromMedia = declarations(block(tokensCss.slice(media), SELECTOR("glass")));
    const fromSwitch = declarations(
      block(tokensCss, `${SELECTOR("glass")}[data-nr-transparency="reduced"]`),
    );
    expect([...fromSwitch.entries()].sort()).toEqual([...fromMedia.entries()].sort());
    expect(fromSwitch.size).toBe(6);
  });

  it("keeps the backdrop of the design for a dark theme, and every color of the pale one light enough to read on", () => {
    for (const kind of ["dark", "light"] as const) {
      for (const color of Object.values(BACKDROP_PALETTES[kind])) {
        expect(color).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
    // The night landscape of vidro-janela.
    expect(BACKDROP_PALETTES.dark).toEqual({
      base: "#191C3A",
      sky: "#1D2046",
      moon: "#F1E6CC",
      star: "#FFFFFF",
      far: "#343A78",
      middle: "#4A3474",
      near: "#11132A",
    });
    // Under the glass of the sidebar the text and the secondary text of a theme with room for them stay at
    // 4.5:1 over every color of the backdrop of its kind that can be behind a sidebar (the moon is at the
    // right of the window), and the text of a pane over all of them (what axe measures). The stars are
    // dots of 2 or 3 pixels that the blur of the glass spreads to nothing, so they are not measured.
    let measured = 0;
    for (const theme of THEMES) {
      if (contrastRatio(theme.ui.muted, theme.ui.surface) < 4.6) continue;
      if (contrastRatio(theme.ui.text, theme.ui.bg) < 7.5) continue;
      measured++;
      for (const [name, color] of Object.entries(BACKDROP_PALETTES[theme.kind])) {
        if (name === "star") continue;
        const pane = pictureUnderPanel(color, {
          bg: color,
          panel: theme.ui.bg,
          imageOpacity: 1,
          panelOpacity: 0.62,
          veil: 0,
        });
        expect(
          contrastRatio(theme.terminal.foreground, pane),
          `${theme.id} terminal text over ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
        if (name === "moon") continue;
        const side = pictureUnderPanel(color, {
          bg: color,
          panel: theme.ui.surface,
          imageOpacity: 1,
          panelOpacity: 0.42,
          veil: 0,
        });
        expect(
          contrastRatio(theme.ui.muted, side),
          `${theme.id} muted over ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(theme.ui.text, side),
          `${theme.id} text over ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(measured).toBeGreaterThanOrEqual(2);
    expect(THEMES.some((theme) => theme.id === NOREN_PAPER.id)).toBe(true);
  });

  it("keeps every rule of the glass section under the glass attribute, so the dense style does not move", () => {
    const start = stylesCss.indexOf(".glass-backdrop {");
    expect(start).toBeGreaterThan(0);
    const section = stylesCss.slice(start);
    const selectors = [...section.matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].flatMap((match) =>
      (match[1] ?? "")
        .split(",")
        .map((selector) => selector.trim())
        .filter((selector) => selector !== ""),
    );
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) {
      expect(
        selector.startsWith(':root[data-nr-style="glass"]') ||
          selector.startsWith(".glass-backdrop"),
        selector,
      ).toBe(true);
    }
  });
});

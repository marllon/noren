import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NOREN_DUSK,
  NOREN_PAPER,
  THEMES,
  applySpaceColor,
  applyTheme,
  terminalTheme,
  themeForScheme,
} from "./theme";
import type { Theme } from "./theme";

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function recorder() {
  const vars = new Map<string, string>();
  return { vars, root: { style: { setProperty: (n: string, v: string) => void vars.set(n, v) } } };
}

describe("themes", () => {
  it("ships Dusk (dark) and Paper (light) with the spec's colors for Dusk", () => {
    expect(THEMES.map((t) => [t.id, t.kind])).toEqual([
      ["noren-dusk", "dark"],
      ["noren-paper", "light"],
    ]);
    expect(NOREN_DUSK.ui).toMatchObject({
      bg: "#14161b",
      surface: "#1b1e25",
      text: "#e6e6e6",
      muted: "#9aa0aa",
      accent: "#e07a5f",
      border: "#2a2e37",
      radius: 10,
    });
  });

  it.each(THEMES.map((t) => [t.name, t] as const))("%s has every field", (_name, theme: Theme) => {
    for (const key of ["bg", "surface", "text", "muted", "accent", "border"] as const) {
      expect(theme.ui[key]).toMatch(HEX);
    }
    expect(theme.ui.radius).toBeGreaterThan(0);
    for (const key of ["foreground", "background", "cursor", "selection"] as const) {
      expect(theme.terminal[key]).toMatch(HEX);
    }
    expect(theme.terminal.ansi).toHaveLength(16);
    for (const color of theme.terminal.ansi) expect(color).toMatch(HEX);
    expect(new Set(theme.terminal.ansi.slice(0, 8)).size).toBe(8);
    expect(theme.font.family).not.toBe("");
    expect(theme.font.size).toBeGreaterThan(0);
    expect(theme.font.lineHeight).toBeGreaterThan(0);
    expect(typeof theme.font.ligatures).toBe("boolean");
    expect(theme.background.opacity).toBeGreaterThanOrEqual(0);
  });

  it("the light theme is lighter than the dark one", () => {
    const luminance = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(luminance(NOREN_PAPER.ui.bg)).toBeGreaterThan(luminance(NOREN_DUSK.ui.bg));
    expect(luminance(NOREN_PAPER.ui.text)).toBeLessThan(luminance(NOREN_DUSK.ui.text));
  });

  it("picks the theme from the color scheme", () => {
    expect(themeForScheme(true)).toBe(NOREN_DUSK);
    expect(themeForScheme(false)).toBe(NOREN_PAPER);
  });
});

describe("applyTheme", () => {
  it("turns the theme into --nr-* variables on the root", () => {
    const { vars, root } = recorder();
    applyTheme(root, NOREN_DUSK);
    expect(Object.fromEntries(vars)).toEqual({
      "--nr-bg": "#14161b",
      "--nr-surface": "#1b1e25",
      "--nr-text": "#e6e6e6",
      "--nr-muted": "#9aa0aa",
      "--nr-accent": "#e07a5f",
      "--nr-border": "#2a2e37",
      "--nr-radius": "10px",
      "--nr-space-color": "#e07a5f",
      "color-scheme": "dark",
    });
  });

  it("switching theme replaces every value", () => {
    const { vars, root } = recorder();
    applyTheme(root, NOREN_DUSK);
    applyTheme(root, NOREN_PAPER);
    expect(vars.get("--nr-bg")).toBe(NOREN_PAPER.ui.bg);
    expect(vars.get("--nr-space-color")).toBe(NOREN_PAPER.ui.accent);
    expect(vars.get("color-scheme")).toBe("light");
  });
});

describe("terminalTheme", () => {
  it("maps the 16 ansi colors and the base colors for xterm", () => {
    const xterm = terminalTheme(NOREN_DUSK);
    const names = [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const;
    expect(names.map((name) => xterm[name])).toEqual([...NOREN_DUSK.terminal.ansi]);
    expect(xterm.background).toBe(NOREN_DUSK.terminal.background);
    expect(xterm.foreground).toBe(NOREN_DUSK.terminal.foreground);
    expect(xterm.cursor).toBe(NOREN_DUSK.terminal.cursor);
    expect(xterm.selectionBackground).toBe(NOREN_DUSK.terminal.selection);
    // Fully transparent: the ruler of command marks draws marks, not a line.
    expect(xterm.overviewRulerBorder).toBe("#00000000");
  });
});

describe("styles.css", () => {
  it("has no literal color: every color comes from a --nr-* token", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(/i);
  });
});

describe("applySpaceColor", () => {
  it("overrides --nr-space-color with the space's color and falls back to the accent", () => {
    const { vars, root } = recorder();
    applyTheme(root, NOREN_DUSK);
    expect(vars.get("--nr-space-color")).toBe(NOREN_DUSK.ui.accent);
    applySpaceColor(root, NOREN_DUSK, "#4caf7d");
    expect(vars.get("--nr-space-color")).toBe("#4caf7d");
    applySpaceColor(root, NOREN_DUSK);
    expect(vars.get("--nr-space-color")).toBe(NOREN_DUSK.ui.accent);
  });
});

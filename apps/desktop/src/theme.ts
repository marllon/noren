import type { ITheme } from "@xterm/xterm";

/** Sixteen ANSI colors in the usual order: 8 normal, then 8 bright. */
export type AnsiPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** Theme data in the shape of `themes/*.json` (spec section 8). */
export interface Theme {
  id: string;
  name: string;
  kind: "dark" | "light";
  ui: {
    bg: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    border: string;
    /** Corner radius in px. */
    radius: number;
    blur: number;
    opacity: number;
  };
  terminal: {
    foreground: string;
    background: string;
    cursor: string;
    selection: string;
    ansi: AnsiPalette;
  };
  font: {
    family: string;
    size: number;
    lineHeight: number;
    ligatures: boolean;
  };
  background: {
    image: string | null;
    opacity: number;
  };
}

export const NOREN_DUSK: Theme = {
  id: "noren-dusk",
  name: "Noren Dusk",
  kind: "dark",
  ui: {
    bg: "#14161b",
    surface: "#1b1e25",
    text: "#e6e6e6",
    muted: "#9aa0aa",
    accent: "#e07a5f",
    border: "#2a2e37",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#e6e6e6",
    background: "#14161b",
    cursor: "#e07a5f",
    selection: "#e07a5f55",
    ansi: [
      "#1b1e25",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#dcdfe4",
      "#5c6370",
      "#e06c75",
      "#98c379",
      "#e5c07b",
      "#61afef",
      "#c678dd",
      "#56b6c2",
      "#ffffff",
    ],
  },
  font: {
    family: "Cascadia Code, JetBrains Mono, monospace",
    size: 13,
    lineHeight: 1.2,
    ligatures: true,
  },
  background: { image: null, opacity: 0.15 },
};

export const NOREN_PAPER: Theme = {
  id: "noren-paper",
  name: "Noren Paper",
  kind: "light",
  ui: {
    bg: "#f6f3ec",
    surface: "#ece8dd",
    text: "#23262d",
    muted: "#5d6470",
    accent: "#b8472c",
    border: "#d4cfc1",
    radius: 10,
    blur: 18,
    opacity: 0.92,
  },
  terminal: {
    foreground: "#23262d",
    background: "#f6f3ec",
    cursor: "#b8472c",
    selection: "#b8472c33",
    ansi: [
      "#23262d",
      "#c62828",
      "#2e7d32",
      "#8a5a00",
      "#1565c0",
      "#8e24aa",
      "#00796b",
      "#6b717b",
      "#4a505a",
      "#d32f2f",
      "#388e3c",
      "#9a6700",
      "#1976d2",
      "#9c27b0",
      "#00897b",
      "#14161b",
    ],
  },
  font: {
    family: "Cascadia Code, JetBrains Mono, monospace",
    size: 13,
    lineHeight: 1.2,
    ligatures: true,
  },
  background: { image: null, opacity: 0.15 },
};

export const THEMES: readonly Theme[] = [NOREN_DUSK, NOREN_PAPER];

/** Until the config (phase 8) picks a theme, the operating system's color scheme does. */
export function themeForScheme(prefersDark: boolean): Theme {
  return prefersDark ? NOREN_DUSK : NOREN_PAPER;
}

/** The CSS custom properties of the theme API (`--nr-*`); mods and the stylesheet read these. */
export function themeVariables(theme: Theme): Record<string, string> {
  const { ui } = theme;
  return {
    "--nr-bg": ui.bg,
    "--nr-surface": ui.surface,
    "--nr-text": ui.text,
    "--nr-muted": ui.muted,
    "--nr-accent": ui.accent,
    "--nr-border": ui.border,
    "--nr-radius": `${ui.radius}px`,
    // The color of the active space; `applySpaceColor` overrides it with the space's own.
    "--nr-space-color": ui.accent,
  };
}

/** The slice of an element's `style` that `applyTheme` needs (a plain object works in tests). */
export interface StyleTarget {
  style: { setProperty(name: string, value: string): void };
}

export function applyTheme(root: StyleTarget, theme: Theme): void {
  for (const [name, value] of Object.entries(themeVariables(theme))) {
    root.style.setProperty(name, value);
  }
  root.style.setProperty("color-scheme", theme.kind);
}

/** Sets `--nr-space-color` to the color of the active space, or back to the accent without one. */
export function applySpaceColor(root: StyleTarget, theme: Theme, spaceColor?: string): void {
  root.style.setProperty("--nr-space-color", spaceColor ?? theme.ui.accent);
}

/** The colors xterm.js draws with. */
export function terminalTheme(theme: Theme): ITheme {
  const { terminal } = theme;
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = terminal.ansi;
  return {
    foreground: terminal.foreground,
    background: terminal.background,
    cursor: terminal.cursor,
    selectionBackground: terminal.selection,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

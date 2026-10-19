import { NOREN_DUSK, NOREN_PAPER, THEMES } from "@noren/model";
import type { Theme } from "@noren/model";
import type { ITheme } from "@xterm/xterm";

// The theme is data and lives in `@noren/model` (the schema and the built-in themes). This file
// turns a theme into what the window uses: the `--nr-*` variables and the colors of xterm.js.

export { NOREN_DUSK, NOREN_PAPER, THEMES };
export type { Theme };

/** With no theme chosen in the settings file, the color scheme of the operating system picks one. */
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

/** `#rrggbb` with an alpha for `opacity` (1 stays `#rrggbb`, so a solid terminal is as it was). */
function withAlpha(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return `${color}${alpha.toString(16).padStart(2, "0")}`;
}

/** Whether an xterm.js color is see-through (`#rrggbbaa` with an alpha below ff). */
export function isTranslucent(color: string | undefined): boolean {
  return color !== undefined && /^#[0-9a-f]{6}(?!ff)[0-9a-f]{2}$/i.test(color);
}

/**
 * The colors xterm.js draws with. `opacity` is how opaque the background of the terminal is (1,
 * solid, by default; 0 lets a picture behind the terminal show through); the text is never faded.
 */
export function terminalTheme(theme: Theme, opacity = 1): ITheme {
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
    background: withAlpha(terminal.background, opacity),
    cursor: terminal.cursor,
    selectionBackground: terminal.selection,
    // The ruler of command marks beside the scrollbar has no line of its own: it shows marks only.
    overviewRulerBorder: "#00000000",
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

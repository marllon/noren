import { interfaceOpacity, resolveBackground } from "@noren/model";
import type {
  BackgroundLayer,
  Config,
  ResolvedBackground,
  SpaceBackground,
  Theme,
  WindowEffect,
} from "@noren/model";

// What the window looks like beyond the colors of the theme: how opaque the interface is, the
// effect the system paints behind it, and the picture behind the terminals. Pure: the stores say
// what the system did (`window-effect-store.ts`) and whether the picture could be read
// (`background-image-store.ts`); this file turns the settings, the theme and the space into the
// variables the stylesheet reads (`--nr-opacity` and the others of `windowVariables`).

/** Everything that decides the look of the window. */
export interface WindowAppearance {
  /** From 0.3 to 1: how opaque the surfaces of the window are. */
  opacity: number;
  /** The effect the window has, which is not always the one that was asked for. */
  effect: WindowEffect;
  /** The picture and how it shows, before it is known whether the file could be read. */
  background: ResolvedBackground;
}

export interface WindowSources {
  config: Config;
  theme: Theme;
  /** The effect the window has (`none` until the system painted one). */
  applied: WindowEffect;
  /** The picture of the active space, if it has one. */
  spaceBackground?: SpaceBackground | undefined;
}

/** What the theme says about the picture, as the lowest layer of the background. */
function themeLayer(theme: Theme): BackgroundLayer {
  return {
    image: theme.background.image,
    opacity: theme.background.opacity,
    blur: theme.background.blur,
  };
}

export function windowAppearance({
  config,
  theme,
  applied,
  spaceBackground,
}: WindowSources): WindowAppearance {
  return {
    opacity: interfaceOpacity({
      configured: config.appearance?.window?.opacity,
      applied,
      themeOpacity: theme.ui.opacity,
    }),
    effect: applied,
    // The theme, then the settings file, then the space: the last one that says something wins.
    background: resolveBackground([
      themeLayer(theme),
      config.appearance?.background,
      spaceBackground,
    ]),
  };
}

/**
 * `#rrggbb` at `opacity` as a CSS color: the color itself when it is solid, so a window at full
 * opacity is painted exactly as it always was, else `rgb(r g b / alpha)`.
 */
export function withOpacity(color: string, opacity: number): string {
  if (opacity >= 1) return color;
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
  const alpha = Math.round(Math.max(0, opacity) * 1000) / 1000;
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

/**
 * The custom properties for the window, to set on the root element next to the ones of the theme.
 * `imageUrl` is the picture once the backend gave it (a `blob:` address of bytes held in memory),
 * `null` while there is none: then the picture variable is `none`.
 *
 * - `--nr-opacity`: the opacity of the interface, a number;
 * - `--nr-bg-glass` and `--nr-surface-glass`: `--nr-bg` and `--nr-surface` at that opacity, which the
 *   window, the title bar, the sidebar and the tab bar are painted with;
 * - `--nr-background-image`, `--nr-background-opacity` and `--nr-background-blur`: the picture
 *   behind the terminals, how much of it shows and how blurred it is (with its unit).
 */
export function windowVariables(
  appearance: WindowAppearance,
  theme: Theme,
  imageUrl: string | null,
): Record<string, string> {
  return {
    "--nr-opacity": String(appearance.opacity),
    "--nr-bg-glass": withOpacity(theme.ui.bg, appearance.opacity),
    "--nr-surface-glass": withOpacity(theme.ui.surface, appearance.opacity),
    "--nr-background-image": imageUrl === null ? "none" : `url("${imageUrl}")`,
    "--nr-background-opacity": String(appearance.background.opacity),
    "--nr-background-blur": `${appearance.background.blur}px`,
  };
}

/** The slice of an element's `style` that `applyWindowVariables` needs (a plain object works in tests). */
export interface VariableTarget {
  style: { setProperty(name: string, value: string): void };
}

/** Sets the variables of `windowVariables` on `root`. */
export function applyWindowVariables(
  root: VariableTarget,
  variables: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}

/**
 * How opaque the background of the terminals is: transparent while a picture shows behind them
 * (`pictureShown`: it is on screen, not only wanted), else the opacity of the interface.
 */
export function terminalOpacity(appearance: WindowAppearance, pictureShown: boolean): number {
  return pictureShown ? 0 : appearance.opacity;
}

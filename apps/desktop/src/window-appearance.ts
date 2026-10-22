import { BACKGROUND_VEIL, GLASS_VEIL, interfaceOpacity, resolveBackground } from "@noren/model";
import type {
  BackgroundLayer,
  Config,
  ResolvedBackground,
  SpaceBackground,
  Theme,
  WindowEffect,
} from "@noren/model";
import type { AppearancePreview } from "./appearance-preview";

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
  /** A picture is on screen (not only wanted): the panels let it through unless the settings say otherwise. */
  pictureShown?: boolean | undefined;
  /** The interface style is glass: the panels are glass whatever is behind them (see `interfaceOpacity`). */
  glass?: boolean | undefined;
  /** The numbers a screen is trying out (the sliders), laid over the settings and the space. */
  preview?: AppearancePreview | undefined;
}

/** What the theme says about the picture, as the lowest layer of the background. */
function themeLayer(theme: Theme): BackgroundLayer {
  return {
    image: theme.background.image,
    opacity: theme.background.opacity,
    blur: theme.background.blur,
  };
}

/**
 * `layer` with the numbers (and the picture) of the preview over its own; what the preview does not
 * try out stays.
 */
function withPreview(
  layer: BackgroundLayer | undefined,
  opacity: number | null | undefined,
  blur: number | null | undefined,
  image?: string | null,
): BackgroundLayer | undefined {
  if (opacity === undefined && blur === undefined && image === undefined) return layer;
  return {
    ...layer,
    ...(opacity !== undefined ? { opacity } : {}),
    ...(blur !== undefined ? { blur } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}

export function windowAppearance({
  config,
  theme,
  applied,
  spaceBackground,
  pictureShown = false,
  glass = false,
  preview,
}: WindowSources): WindowAppearance {
  return {
    opacity: interfaceOpacity({
      configured:
        preview?.windowOpacity !== undefined
          ? preview.windowOpacity
          : config.appearance?.window?.opacity,
      applied,
      themeOpacity: theme.ui.opacity,
      picture: pictureShown,
      glass,
    }),
    effect: applied,
    // The theme, then the settings file, then the space: the last one that says something wins.
    background: resolveBackground([
      themeLayer(theme),
      withPreview(
        config.appearance?.background,
        preview?.backgroundOpacity,
        preview?.backgroundBlur,
        preview?.backgroundImage,
      ),
      withPreview(spaceBackground, preview?.spaceOpacity, preview?.spaceBlur),
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
 *   window, the title bar, the sidebar and the tab bar are painted with (`--nr-bg-glass` is the solid
 *   `--nr-bg` under glass with no system effect, where the backdrop covers the window);
 * - `--nr-terminal-glass`: the background of the terminal at that opacity, which the pane of a terminal
 *   is painted with while a picture shows behind it (the terminal itself draws no background then);
 * - `--nr-background-image`, `--nr-background-opacity` and `--nr-background-blur`: the picture
 *   behind the terminals, how much of it shows and how blurred it is (with its unit);
 * - `--nr-background-veil`: how much of the background of the theme is drawn over the picture (the
 *   veil of the glass style, `GLASS_VEIL`, under glass: the glass lets more through, so the veil is stronger);
 * - `--nr-background-backing`: what the picture is drawn on, the solid background of the theme (the
 *   glass of the window while it has an effect, so the effect shows through);
 * - `--nr-panel-blur`: how much the sidebar blurs the picture it lets through (`ui.blur` of the theme).
 */
export function windowVariables(
  appearance: WindowAppearance,
  theme: Theme,
  imageUrl: string | null,
  glass = false,
): Record<string, string> {
  return {
    "--nr-opacity": String(appearance.opacity),
    // Under glass with no system effect the window itself is solid: the backdrop (the illustration or the
    // picture over its solid backing) covers it, and the glass is the panels, not the page behind them.
    "--nr-bg-glass":
      glass && appearance.effect === "none"
        ? theme.ui.bg
        : withOpacity(theme.ui.bg, appearance.opacity),
    "--nr-surface-glass": withOpacity(theme.ui.surface, appearance.opacity),
    "--nr-terminal-glass": withOpacity(theme.terminal.background, appearance.opacity),
    "--nr-background-image": imageUrl === null ? "none" : `url("${imageUrl}")`,
    "--nr-background-opacity": String(appearance.background.opacity),
    "--nr-background-blur": `${appearance.background.blur}px`,
    "--nr-background-veil": String(glass ? GLASS_VEIL : BACKGROUND_VEIL),
    "--nr-background-backing":
      appearance.effect === "none" ? theme.ui.bg : withOpacity(theme.ui.bg, appearance.opacity),
    "--nr-panel-blur": `${theme.ui.blur}px`,
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

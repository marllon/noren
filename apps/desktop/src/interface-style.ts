import { DEFAULT_INTERFACE_STYLE } from "@noren/model";
import type { InterfaceStyle } from "@noren/model";

// The interface style (`appearance.style` of config.jsonc): glass or dense. The theme says the colors;
// the style says the typography, the corners, the gaps and the effects, so any theme works in either
// style. The style reaches the page as an attribute on the root element,
// `data-nr-style="glass"` or `data-nr-style="dense"`, and the token set of that attribute
// (`style-tokens.css`, described in docs/THEMING.md) is what the stylesheet reads. This file is the
// pure part: the attribute, the one token the theme and the style share (the corner radius) and the
// data the other files hold to the stylesheet.

export { DEFAULT_INTERFACE_STYLE };

/** The attribute of the root element that picks the token set of a style. */
export const STYLE_ATTRIBUTE = "data-nr-style";

/** The most a theme's corners may round under the dense style, in pixels: its corners are square. */
export const DENSE_MAX_RADIUS = 3;

/**
 * The highlight each style starts from, then the other three the designs offer (the accent of a
 * space is the highlight of the window). The first of each is `--nr-style-accent` in the stylesheet.
 */
export const STYLE_ACCENTS: Readonly<
  Record<InterfaceStyle, readonly [string, string, string, string]>
> = {
  glass: ["#5EE6C8", "#A99BFF", "#F5B84B", "#FF8FA3"],
  dense: ["#2EE6D6", "#B4FF39", "#FFB547", "#FF5CA8"],
};

/** One weight of a packaged font: the family name the stylesheet gives it, and its weight. */
export interface PackagedFont {
  family: string;
  weight: number;
}

/**
 * The fonts that ship inside the app (`fonts.css`): nothing is fetched from the network when the
 * window opens. Geist and Geist Mono are the type of the glass style, JetBrains Mono the type of the
 * dense one. Each is the Latin subset, which covers English and Portuguese.
 */
export const PACKAGED_FONTS: readonly PackagedFont[] = [
  { family: "Geist", weight: 400 },
  { family: "Geist", weight: 500 },
  { family: "Geist", weight: 600 },
  { family: "Geist Mono", weight: 400 },
  { family: "Geist Mono", weight: 500 },
  { family: "JetBrains Mono", weight: 400 },
  { family: "JetBrains Mono", weight: 500 },
  { family: "JetBrains Mono", weight: 700 },
];

/** The family each style draws the interface with first (the first of `--nr-font-ui`). */
export const STYLE_FONT: Readonly<Record<InterfaceStyle, string>> = {
  glass: "Geist",
  dense: "JetBrains Mono",
};

/**
 * The corner radius the interface uses, in pixels, for a theme that asks for `themeRadius`: the
 * theme's own under glass, and no more than `DENSE_MAX_RADIUS` under dense. It is the one token
 * the theme and the style both have a say in, which is why it is worked out here and set with the
 * theme (`themeVariables`) and not given by the stylesheet of the style.
 */
export function styleRadius(style: InterfaceStyle, themeRadius: number): number {
  return style === "dense" ? Math.min(themeRadius, DENSE_MAX_RADIUS) : themeRadius;
}

/** The slice of an element that `applyInterfaceStyle` needs (a plain object works in tests). */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
}

/** Puts `style` on `root`, which picks the token set of that style. */
export function applyInterfaceStyle(root: AttributeTarget, style: InterfaceStyle): void {
  root.setAttribute(STYLE_ATTRIBUTE, style);
}

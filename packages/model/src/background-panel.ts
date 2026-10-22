import { BACKGROUND_VEIL } from "./background";
import { mixColors } from "./theme-derive";

// How the window adds up while a picture shows behind it, bottom to top: the solid background of the
// theme, the picture at its opacity, the veil (the background of the theme again, at
// `BACKGROUND_VEIL`) and the panel (the sidebar or the terminal: its own color at the opacity of the
// interface). The stylesheet paints the layers in this order; this is the same sum for one pixel of
// the picture, so what the text has behind it can be measured (`background-panel.test.ts` does, for
// the worst pixel a picture can have).

/** What one panel is made of. All colors are `#rrggbb`. */
export interface PanelOverPicture {
  /** The solid background of the theme (`ui.bg`): under the picture and the color of the veil. */
  bg: string;
  /** The color of the panel itself (`ui.surface` for the sidebar, `terminal.background` for a terminal). */
  panel: string;
  /** How much of the picture shows, from 0 to 1. */
  imageOpacity: number;
  /** How opaque the panel is, from 0 (clear glass) to 1 (solid). */
  panelOpacity: number;
  /** The veil over the picture; the one of every window unless a test asks for another. */
  veil?: number;
}

/**
 * The color that shows where a pixel of the picture (`pixel`, `#rrggbb`) is under the panel: what
 * the text of the panel is read against.
 */
export function pictureUnderPanel(pixel: string, layers: PanelOverPicture): string {
  const veil = layers.veil ?? BACKGROUND_VEIL;
  const picture = mixColors(layers.bg, pixel, layers.imageOpacity);
  const veiled = mixColors(picture, layers.bg, veil);
  return mixColors(veiled, layers.panel, layers.panelOpacity);
}

/**
 * The pixel of a picture that is the hardest to read on: the one that comes closest to the color of
 * the text in brightness. Text lighter than the background (a dark theme) is read worst on white,
 * and darker text (a light theme) on black.
 */
export function worstPixel(kind: "dark" | "light"): string {
  return kind === "dark" ? "#ffffff" : "#000000";
}

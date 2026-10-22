// The numbers of the glass interface style (`appearance.style` "glass", D23) that are not a color or a
// size of the stylesheet: how see-through the glass is when nothing says, how much more the sidebar
// lets through than the panels, and the veil that keeps text readable over any picture. Pure. The
// stylesheet (`style-tokens.css`) works the fills out from `--nr-opacity` the same way
// `glassSideOpacity` does; a test reads the stylesheet and holds the two together.

/**
 * How opaque the glass panels are when nothing says (the opacity of the interface under glass): 0.62,
 * the `opacidadePaineis` default of the design. A value in the settings always counts, and so does
 * the theme's own opacity while the window has a system effect behind it.
 */
export const GLASS_PANEL_OPACITY = 0.62;

/** How much more see-through the sidebar is than the panels (0.2 of opacity less)... */
export const GLASS_SIDE_OPACITY_STEP = 0.2;

/** ...but never less opaque than this, so the sidebar stays a surface when the panels are nearly clear. */
export const GLASS_SIDE_MIN_OPACITY = 0.2;

/**
 * The veil of the glass style: the background of the theme laid over the picture (or the illustrated
 * backdrop of the window) at this opacity. With the glass of the sidebar and the panels on top, it
 * is what keeps the text of the interface at 4.5:1 over any picture a person can choose, however
 * bright (`glass.test.ts` measures it for the worst pixel of every built-in theme). Stronger than the
 * veil of the dense style (`BACKGROUND_VEIL`), because the glass lets more through.
 */
export const GLASS_VEIL = 0.55;

/**
 * Over the last 0.05 of opacity the step above fades out, so panels at 1 (fully opaque, the end of
 * the slider) have a sidebar at 1 too, and not 0.8.
 */
export const GLASS_SIDE_SOLID_RAMP = 0.05;

/** The opacity of the sidebar under glass, for panels of opacity `panel` (0 to 1). */
export function glassSideOpacity(panel: number): number {
  const ramp = Math.max(0, Math.min(1, (1 - panel) / GLASS_SIDE_SOLID_RAMP));
  return Math.max(GLASS_SIDE_MIN_OPACITY, panel - GLASS_SIDE_OPACITY_STEP * ramp);
}

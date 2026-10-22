// The interface style (`appearance.style` of config.jsonc): which of the two looks of the window is
// drawn. The theme says the colors; the style says the typography, the corners, the gaps and the
// effects, so any theme works in either style. Pure: the app turns the choice into an attribute on
// the root element and the token set of that attribute (`apps/desktop/src/interface-style.ts`).

/**
 * The styles of the interface. `glass` is panels of glass over the picture of the window (the
 * default); `dense` is the technical look: square corners, 1 px lines, a monospaced font everywhere.
 */
export const INTERFACE_STYLES = ["glass", "dense"] as const;

export type InterfaceStyle = (typeof INTERFACE_STYLES)[number];

/** The style of a window whose settings do not name one. */
export const DEFAULT_INTERFACE_STYLE: InterfaceStyle = "glass";

export function isInterfaceStyle(value: unknown): value is InterfaceStyle {
  return (INTERFACE_STYLES as readonly unknown[]).includes(value);
}

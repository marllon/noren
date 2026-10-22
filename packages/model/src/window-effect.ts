import { PICTURE_PANEL_OPACITY } from "./background";

// The look of the window itself: the effect the system paints behind it (Mica, Acrylic, vibrancy)
// and how opaque the interface is on top of it. Pure: the effect is applied by the shell
// (`Backend.setWindowEffect`), and the opacity reaches the page as the `--nr-opacity` variable.

/**
 * The effects a window can have. `mica` and `acrylic` are Windows 11 (Acrylic also works on a
 * recent Windows 10), `vibrancy` is macOS; `none` is the plain opaque window every system has.
 */
export const WINDOW_EFFECTS = ["none", "mica", "acrylic", "vibrancy"] as const;

export type WindowEffect = (typeof WINDOW_EFFECTS)[number];

/**
 * The dark or light look an effect is painted in. The system paints its effects by its own mode;
 * `dark` and `light` (the kind of a theme that was chosen, `Theme["kind"]`) tell the window to
 * paint them in that look instead, so a dark theme never sits on a light Mica and the other way
 * round, which would make the text unreadable. `system` leaves the window as it is: it follows the
 * mode of the system, which is what a theme that follows the system follows too.
 */
export type WindowScheme = "dark" | "light" | "system";

export function isWindowScheme(value: unknown): value is WindowScheme {
  return value === "dark" || value === "light" || value === "system";
}

/** The effect of a window whose settings do not name one. */
export const DEFAULT_WINDOW_EFFECT: WindowEffect = "none";

/** The words the settings screen and the notices use for each effect. */
export const WINDOW_EFFECT_LABELS: Readonly<Record<WindowEffect, string>> = {
  none: "None",
  mica: "Mica",
  acrylic: "Acrylic",
  vibrancy: "Vibrancy",
};

/**
 * The lowest opacity of the interface. Text stays readable over a busy desktop only while the
 * window keeps most of its color, so the setting stops here instead of letting the window vanish.
 */
export const MIN_WINDOW_OPACITY = 0.3;

export function isWindowEffect(value: unknown): value is WindowEffect {
  return typeof value === "string" && (WINDOW_EFFECTS as readonly string[]).includes(value);
}

/**
 * What the shell did with a request for an effect. `applied` is what the window has now: the
 * requested effect, or `none` when the system cannot paint it (Mica before Windows 11, vibrancy
 * anywhere but macOS), in which case `reason` says why and the window stays opaque.
 */
export interface WindowEffectReport {
  requested: WindowEffect;
  applied: WindowEffect;
  reason?: string;
}

/** A number held to `min` and `max`; a value that is not a finite number comes back as `fallback`. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** What decides how opaque the interface is. */
export interface OpacitySources {
  /** `appearance.window.opacity` of the settings file (`null` or missing: not set). */
  configured: number | null | undefined;
  /** The effect the window has, not the one that was asked for. */
  applied: WindowEffect;
  /** `ui.opacity` of the theme in force. */
  themeOpacity: number;
  /**
   * A picture shows behind the window (it is on screen, not only wanted). The panels then let it
   * through unless something says otherwise. Left out: no picture.
   */
  picture?: boolean | undefined;
}

/**
 * How opaque the interface is, from `MIN_WINDOW_OPACITY` to 1 (solid). A value in the settings
 * always counts. Without one the window is solid, except while it has an effect (then the theme says,
 * `ui.opacity`, since an effect is only seen through a window that lets some of it through) or a
 * picture shows behind it (then the panels are `PICTURE_PANEL_OPACITY`, which lets the picture
 * through).
 */
export function interfaceOpacity({
  configured,
  applied,
  themeOpacity,
  picture = false,
}: OpacitySources): number {
  if (typeof configured === "number") {
    return clampNumber(configured, MIN_WINDOW_OPACITY, 1, 1);
  }
  if (picture) return PICTURE_PANEL_OPACITY;
  return applied === "none" ? 1 : clampNumber(themeOpacity, MIN_WINDOW_OPACITY, 1, 1);
}

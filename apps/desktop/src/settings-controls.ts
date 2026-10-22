import {
  MAX_BACKGROUND_BLUR,
  MAX_FONT_SIZE,
  MAX_LINE_HEIGHT,
  MAX_MAX_PANES,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MIN_MAX_PANES,
  MIN_SCROLLBACK,
  MIN_WINDOW_OPACITY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@noren/model";
import type { RangeSpec, SliderSpec } from "./SettingsFields";
import { numberOfText } from "./settings-sections";

// The controls of the settings screen that depend on what the schema of `config.jsonc` says about a
// number: which numbers get a slider beside their box, over what range and in what steps. Pure: the
// screen draws what this says, and a test holds each range to the schema (a handle can never reach a
// value the file would refuse, and a value the file takes can always be reached).
//
// A slider is for a quantity that has both ends in the schema and that a hand can drag through. The
// numbers left with a box alone are the ones the schema bounds only below (the seconds of a long
// command, the hours of the auto-archive), and a port of an ssh server, which is a name for a
// service and not a quantity: dragging through 65535 of them chooses nothing.

/** The numbers of the settings screen that have a slider, with the range of each in the schema. */
export const NUMBER_RANGES = {
  /** `appearance.sidebar.width`, in whole pixels. */
  width: { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH, step: 1 },
  /** `appearance.window.opacity`. */
  windowOpacity: { min: MIN_WINDOW_OPACITY, max: 1, step: 0.01 },
  /** `appearance.background.opacity`. */
  backgroundOpacity: { min: 0, max: 1, step: 0.01 },
  /** `appearance.background.blur`, in pixels. */
  backgroundBlur: { min: 0, max: MAX_BACKGROUND_BLUR, step: 1 },
  /** `terminal.font.size`, in pixels. */
  fontSize: { min: MIN_FONT_SIZE, max: MAX_FONT_SIZE, step: 1 },
  /** `terminal.font.lineHeight`. */
  lineHeight: { min: MIN_LINE_HEIGHT, max: MAX_LINE_HEIGHT, step: 0.05 },
  /** `terminal.scrollback`, in whole lines (a step of a hundred: a hand does not drag line by line). */
  scrollback: { min: MIN_SCROLLBACK, max: MAX_SCROLLBACK, step: 100 },
  /** `terminal.maxPanes`, in whole panes. */
  maxPanes: { min: MIN_MAX_PANES, max: MAX_MAX_PANES, step: 1 },
} as const satisfies Record<string, RangeSpec>;

export type RangedNumber = keyof typeof NUMBER_RANGES;

/**
 * Where the handle stands for the text of a box: the number in it, or `fallback` (the value in force)
 * when the box is empty or holds half a number, kept inside the range (a value out of range, which
 * the box tells is refused, leaves the handle at the end it is nearest to).
 */
export function handleAt(text: string, range: RangeSpec, fallback: number): number {
  const at = numberOfText(text) ?? fallback;
  return Math.min(range.max, Math.max(range.min, at));
}

/** An opacity as the percent a screen reader says: 0.55 is "55%". */
export const asPercent = (value: number): string => `${Math.round(value * 100)}%`;

/** A number of pixels as a screen reader says it: "14 px". */
export const asPixels = (value: number): string => `${value} px`;

/**
 * The slider of a number: its name for a screen reader, its range, and where it stands for the text
 * of the box. `format` says the value for a screen reader ("55%", "14 px"); without one the value is
 * said as the number it is.
 */
export function sliderFor(
  key: RangedNumber,
  label: string,
  text: string,
  fallback: number,
  format?: (value: number) => string,
): SliderSpec {
  const range: RangeSpec = NUMBER_RANGES[key];
  const value = handleAt(text, range, fallback);
  return {
    label,
    ...range,
    value,
    ...(format !== undefined ? { valueText: format(value) } : {}),
  };
}

/** How a choice is drawn: a row of buttons with the chosen one marked, or a drop-down list. */
export type ChoiceControl = "segmented" | "list";

/**
 * The control of each choice of the screen. The rule: two or three options with short names are a row
 * of buttons (everything is in view, one click chooses); four or more, or names that would not fit
 * a third of the column, are a list. The control of a field is the same in every language, so it is
 * written down here (a test holds it to the options and to the names in both languages) and not
 * measured from the text on screen.
 */
export const CHOICE_CONTROLS = {
  language: "list",
  sidebarSide: "segmented",
  tabPosition: "segmented",
  favoritesPosition: "segmented",
  interfaceStyle: "segmented",
  density: "segmented",
  windowEffect: "list",
  cursorShape: "segmented",
  bell: "list",
  rightClick: "list",
  keyPreset: "segmented",
  /** The theme section: the whole app or only the active space. */
  themeScope: "segmented",
} as const satisfies Record<string, ChoiceControl>;

export type ChoiceId = keyof typeof CHOICE_CONTROLS;

/** The most options a row of buttons has, and the longest name (in characters) one of them holds. */
export const SEGMENTS_MAX = 3;
export const SEGMENT_NAME_MAX = 16;

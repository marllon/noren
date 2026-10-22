import { describe, expect, it } from "vitest";
import {
  BELL_STYLES,
  CURSOR_STYLES,
  LANGUAGES,
  RIGHT_CLICK_ACTIONS,
  WINDOW_EFFECTS,
} from "@noren/model";
import { en } from "./i18n/en";
import { ptBR } from "./i18n/pt-BR";
import {
  CHOICE_CONTROLS,
  NUMBER_RANGES,
  SEGMENTS_MAX,
  SEGMENT_NAME_MAX,
  asPercent,
  asPixels,
  handleAt,
  sliderFor,
} from "./settings-controls";
import type { ChoiceId, RangedNumber } from "./settings-controls";
import { OPTIONAL_PATHS, SETTING_PATHS } from "./settings-screen";
import { TERMINAL_PATHS, schemaProblem } from "./settings-sections";

// Which controls the settings screen gives its numbers and its choices. The slider of a number is held
// to the schema of the file (a handle can never reach a value the file would refuse, and a value the
// file takes can always be reached), and the control of a choice is held to its options and to the
// width of their names in both languages.

/** Where each ranged number lives in `config.jsonc`. */
const PATHS: Readonly<Record<RangedNumber, readonly string[]>> = {
  width: SETTING_PATHS.width,
  windowOpacity: OPTIONAL_PATHS.windowOpacity,
  backgroundOpacity: OPTIONAL_PATHS.backgroundOpacity,
  backgroundBlur: OPTIONAL_PATHS.backgroundBlur,
  fontSize: TERMINAL_PATHS.fontSize,
  lineHeight: TERMINAL_PATHS.lineHeight,
  scrollback: TERMINAL_PATHS.scrollback,
  maxPanes: TERMINAL_PATHS.maxPanes,
};

const RANGED = Object.keys(NUMBER_RANGES) as RangedNumber[];

describe("the range of a slider is the range of the schema", () => {
  it("has a slider for the eight numbers the schema bounds on both ends", () => {
    expect(RANGED.sort()).toEqual(
      [
        "backgroundBlur",
        "backgroundOpacity",
        "fontSize",
        "lineHeight",
        "maxPanes",
        "scrollback",
        "width",
        "windowOpacity",
      ].sort(),
    );
  });

  for (const key of RANGED) {
    const { min, max, step } = NUMBER_RANGES[key];

    it(`${key}: the schema takes the two ends, and refuses a value a step past either`, () => {
      const path = PATHS[key];
      expect(schemaProblem(path, min), `${key} at ${min}`).toBeUndefined();
      expect(schemaProblem(path, max), `${key} at ${max}`).toBeUndefined();
      expect(schemaProblem(path, Number((min - step).toFixed(2))), `${key} under`).toBeDefined();
      expect(schemaProblem(path, Number((max + step).toFixed(2))), `${key} over`).toBeDefined();
    });

    it(`${key}: every value the handle lands on, from the bottom to the top, is one the schema takes`, () => {
      const path = PATHS[key];
      const stops = Math.round((max - min) / step);
      // The ends, the first and the last steps, and a few in between (a scrollback has 1000 stops).
      const picks = new Set([0, 1, 2, Math.floor(stops / 2), stops - 1, stops]);
      for (const stop of picks) {
        const value = Number((min + stop * step).toFixed(2));
        expect(schemaProblem(path, value), `${key} at ${value}`).toBeUndefined();
      }
    });

    it(`${key}: the steps divide the range evenly, so the top is a stop of the handle`, () => {
      const stops = (max - min) / step;
      expect(Math.abs(stops - Math.round(stops)), key).toBeLessThan(1e-9);
    });
  }
});

describe("handleAt", () => {
  const range = NUMBER_RANGES.width;

  it("stands where the box says", () => {
    expect(handleAt("300", range, 200)).toBe(300);
    expect(handleAt(" 250 ", range, 200)).toBe(250);
  });

  it("stands at the value in force when the box is empty or holds half a number", () => {
    expect(handleAt("", range, 200)).toBe(200);
    expect(handleAt("2.", range, 200)).toBe(200);
    expect(handleAt("abc", range, 200)).toBe(200);
  });

  it("stays inside the range: a value out of it leaves the handle at the end it is nearest to", () => {
    expect(handleAt("9999", range, 200)).toBe(480);
    expect(handleAt("30", range, 200)).toBe(180);
    expect(handleAt("-5", range, 200)).toBe(180);
    // And so does the value in force, if the file somehow held one outside.
    expect(handleAt("", range, 9999)).toBe(480);
  });
});

describe("sliderFor", () => {
  it("is the range of the number, where the box puts the handle, and the name of the slider", () => {
    expect(sliderFor("fontSize", "Font size", "20", 14)).toEqual({
      label: "Font size",
      min: 6,
      max: 72,
      step: 1,
      value: 20,
    });
  });

  it("says the value in its unit for a screen reader, when it has one", () => {
    expect(sliderFor("fontSize", "Font size", "20", 14, asPixels).valueText).toBe("20 px");
    expect(sliderFor("windowOpacity", "Opacity", "0.55", 1, asPercent).valueText).toBe("55%");
    expect(sliderFor("scrollback", "Scrollback", "", 10000).valueText).toBeUndefined();
  });

  it("follows the value in force while the box is empty", () => {
    expect(sliderFor("backgroundOpacity", "Image", "", 0.6, asPercent).value).toBe(0.6);
  });
});

/** The names of the options of a choice, from a dictionary. */
const names = (dictionary: Record<string, string>, ...keys: string[]): string[] =>
  keys.map((key) => {
    const text = dictionary[key];
    if (text === undefined) throw new Error(`no ${key}`);
    return text;
  });

/** How many options each choice has and what they are called, in a language. */
function choices(dictionary: Record<string, string>): Record<ChoiceId, string[]> {
  return {
    language: [
      ...names(dictionary, "settings.language.system"),
      "English",
      "Português (Brasil)",
    ].slice(0, 1 + LANGUAGES.length),
    sidebarSide: names(dictionary, "settings.left", "settings.right"),
    tabPosition: names(dictionary, "settings.inSidebar", "settings.onTop"),
    density: names(dictionary, "settings.comfortable", "settings.compact"),
    windowEffect: WINDOW_EFFECTS.map((effect) => dictionary[`settings.effect.${effect}`] ?? ""),
    cursorShape: CURSOR_STYLES.map((style) => dictionary[`settings.cursor.${style}`] ?? ""),
    bell: BELL_STYLES.map((style) => dictionary[`settings.bell.${style}`] ?? ""),
    rightClick: RIGHT_CLICK_ACTIONS.map(
      (action) => dictionary[`settings.rightClick.${action}`] ?? "",
    ),
    keyPreset: names(dictionary, "settings.preset.safe", "settings.preset.browser"),
    themeScope: names(dictionary, "themes.scopeApp", "themes.scopeSpace"),
  };
}

describe("the control of a choice", () => {
  for (const [language, dictionary] of [
    ["en", en],
    ["pt-BR", ptBR],
  ] as const) {
    const options = choices(dictionary);

    for (const id of Object.keys(CHOICE_CONTROLS) as ChoiceId[]) {
      it(`${language}, ${id}: is ${CHOICE_CONTROLS[id]} for ${options[id].length} options`, () => {
        const list = options[id];
        expect(
          list.every((name) => name.trim() !== ""),
          `${id} names`,
        ).toBe(true);
        if (CHOICE_CONTROLS[id] === "segmented") {
          // A row of buttons: two or three options, each name short enough for a third of the column.
          expect(list.length).toBeGreaterThanOrEqual(2);
          expect(list.length).toBeLessThanOrEqual(SEGMENTS_MAX);
          for (const name of list) expect(name.length, name).toBeLessThanOrEqual(SEGMENT_NAME_MAX);
        } else {
          // A list: four or more options, or names that would not fit a button.
          const tooMany = list.length > SEGMENTS_MAX;
          const tooLong = list.some((name) => name.length > SEGMENT_NAME_MAX);
          expect(tooMany || tooLong, `${id} is a list for a reason`).toBe(true);
        }
      });
    }
  }

  it("is the same in both languages (a field keeps its control when the language changes)", () => {
    // The rule is written once, in CHOICE_CONTROLS, and does not read the text on screen; so the two
    // languages above are held to the same table.
    expect(Object.keys(CHOICE_CONTROLS).sort()).toEqual(Object.keys(choices(en)).sort());
    expect(Object.keys(CHOICE_CONTROLS).sort()).toEqual(Object.keys(choices(ptBR)).sort());
  });

  it("draws every choice with four or more options as a list", () => {
    const counts = choices(en);
    for (const id of Object.keys(CHOICE_CONTROLS) as ChoiceId[]) {
      if (counts[id].length >= 4) expect(CHOICE_CONTROLS[id], id).toBe("list");
    }
  });
});

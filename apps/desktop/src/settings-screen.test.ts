import { describe, expect, it } from "vitest";
import type { Config } from "@noren/model";
import { DEFAULT_LAYOUT } from "./layout";
import {
  BACKGROUND_BLUR_PROBLEM,
  BACKGROUND_OPACITY_PROBLEM,
  DEFAULT_SETTINGS,
  OPTIONAL_PATHS,
  SECONDS_PROBLEM,
  SETTING_PATHS,
  WIDTH_PROBLEM,
  WINDOW_OPACITY_PROBLEM,
  compactAvailable,
  keepOpenAvailable,
  parseBackgroundBlur,
  parseBackgroundOpacity,
  parseSeconds,
  parseWidth,
  parseWindowOpacity,
  planSave,
  settingsOf,
  settingsSetBy,
  shownSettings,
} from "./settings-screen";
import type { SettingKey } from "./settings-screen";

/** What a plan says about the sections with their own boxes when none has a problem. */
const NO_SECTION_PROBLEMS = {
  terminalProblems: {},
  archiveProblems: {},
  aiProblems: {},
  profileProblems: {},
};

const EVERYTHING: Config = {
  language: "pt-BR",
  appearance: {
    sidebar: { position: "right", width: 333, compact: true, keepOpen: true },
    density: "compact",
    tabs: "top",
    paneHeaders: true,
    window: { effect: "mica", opacity: 0.8 },
    background: { image: "backgrounds/sky.png", opacity: 0.4, blur: 6 },
  },
  keybindings: { preset: "browser" },
  notifications: { enabled: false, longCommandSeconds: 90 },
};

describe("settingsOf", () => {
  it("is the defaults for a file that says nothing", () => {
    expect(settingsOf({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      ...DEFAULT_LAYOUT,
      preset: "safe",
      notifications: true,
      longCommandSeconds: 30,
      windowEffect: "none",
      language: "system",
    });
  });

  it("takes every setting the file has and the default for the rest", () => {
    expect(settingsOf(EVERYTHING)).toEqual({
      side: "right",
      width: 333,
      compact: true,
      keepOpen: true,
      density: "compact",
      tabs: "top",
      paneHeaders: true,
      preset: "browser",
      notifications: false,
      longCommandSeconds: 90,
      windowEffect: "mica",
      language: "pt-BR",
    });
    expect(settingsOf({ keybindings: { preset: "browser" } })).toEqual({
      ...DEFAULT_SETTINGS,
      preset: "browser",
    });
  });

  it("keeps a value that is falsy: off and zero are choices, not gaps", () => {
    const set = settingsOf({ notifications: { enabled: false, longCommandSeconds: 0 } });
    expect(set.notifications).toBe(false);
    expect(set.longCommandSeconds).toBe(0);
  });
});

describe("settingsSetBy", () => {
  it("lists the settings the file mentions, and none for an empty file", () => {
    expect(settingsSetBy({}).size).toBe(0);
    expect([...settingsSetBy(EVERYTHING)].sort()).toEqual(
      (Object.keys(SETTING_PATHS) as SettingKey[]).sort(),
    );
    expect([...settingsSetBy({ appearance: { sidebar: { width: 250 } } })]).toEqual(["width"]);
    expect([...settingsSetBy({ notifications: { enabled: true } })]).toEqual(["notifications"]);
    expect([...settingsSetBy({ appearance: { window: { effect: "none" } } })]).toEqual([
      "windowEffect",
    ]);
  });
});

describe("SETTING_PATHS", () => {
  it("names a place in the schema for every setting, and none twice", () => {
    const places = Object.values(SETTING_PATHS).map((path) => path.join("."));
    expect(new Set(places).size).toBe(places.length);
    expect(places).toContain("appearance.sidebar.position");
    expect(places).toContain("keybindings.preset");
    expect(places).toContain("notifications.longCommandSeconds");
    expect(places).toContain("appearance.window.effect");
  });

  it("does not repeat a place of the optional settings either", () => {
    const places = [...Object.values(SETTING_PATHS), ...Object.values(OPTIONAL_PATHS)].map((path) =>
      path.join("."),
    );
    expect(new Set(places).size).toBe(places.length);
    expect(Object.values(OPTIONAL_PATHS).map((path) => path.join("."))).toEqual([
      "appearance.window.opacity",
      "appearance.background.image",
      "appearance.background.opacity",
      "appearance.background.blur",
    ]);
  });
});

describe("shownSettings", () => {
  it("shows the settings in force where nothing was changed, the numbers as text", () => {
    const shown = shownSettings(EVERYTHING, {});
    expect(shown.side).toBe("right");
    expect(shown.width).toBe("333");
    expect(shown.longCommandSeconds).toBe("90");
  });

  it("shows the draft over them", () => {
    const shown = shownSettings(EVERYTHING, { side: "left", width: "2", paneHeaders: false });
    expect(shown).toMatchObject({
      side: "left",
      width: "2",
      paneHeaders: false,
      density: "compact",
    });
  });

  it("follows the file for what was not touched, so another program's edit shows", () => {
    const draft = { density: "comfortable" } as const;
    expect(shownSettings({}, draft).tabs).toBe("sidebar");
    expect(shownSettings({ appearance: { tabs: "top" } }, draft)).toMatchObject({
      tabs: "top",
      density: "comfortable",
    });
  });
});

describe("compact mode boxes", () => {
  it("disables compact mode with top tabs, and keep-open without compact mode or with top tabs", () => {
    expect(compactAvailable({ tabs: "sidebar" })).toBe(true);
    expect(compactAvailable({ tabs: "top" })).toBe(false);
    expect(keepOpenAvailable({ tabs: "sidebar", compact: true })).toBe(true);
    expect(keepOpenAvailable({ tabs: "sidebar", compact: false })).toBe(false);
    expect(keepOpenAvailable({ tabs: "top", compact: true })).toBe(false);
  });
});

describe("parseWidth and parseSeconds", () => {
  it("accept whole pixels in range, with blanks around", () => {
    expect(parseWidth("180")).toBe(180);
    expect(parseWidth(" 480 ")).toBe(480);
    for (const bad of ["", "179", "481", "200.5", "-200", "abc", "1e3", "２００"]) {
      expect(parseWidth(bad), bad).toBeUndefined();
    }
  });

  it("accept seconds of zero or more, whole or not", () => {
    expect(parseSeconds("0")).toBe(0);
    expect(parseSeconds("12.5")).toBe(12.5);
    expect(parseSeconds(" 30 ")).toBe(30);
    for (const bad of ["", "-1", ".5", "5.", "abc", "1e3", "Infinity", "NaN"]) {
      expect(parseSeconds(bad), bad).toBeUndefined();
    }
  });
});

describe("planSave", () => {
  it("writes nothing for an untouched draft", () => {
    expect(planSave({}, {})).toEqual({ changes: [], problems: {}, ...NO_SECTION_PROBLEMS });
  });

  it("writes the language at the top of the file, and nothing when it is the one in force", () => {
    expect(planSave({}, { language: "pt-BR" }).changes).toEqual([
      { path: ["language"], value: "pt-BR" },
    ]);
    expect(planSave({ language: "pt-BR" }, { language: "pt-BR" }).changes).toEqual([]);
    expect(planSave({ language: "pt-BR" }, { language: "system" }).changes).toEqual([
      { path: ["language"], value: "system" },
    ]);
  });

  it("writes only the settings that differ from the ones in force", () => {
    const plan = planSave(
      { appearance: { tabs: "top" } },
      { tabs: "top", density: "compact", side: "left", paneHeaders: true },
    );
    // Tabs on top and the left side are what is in force already; the others change.
    expect(plan.changes).toEqual([
      { path: ["appearance", "density"], value: "compact" },
      { path: ["appearance", "paneHeaders"], value: true },
    ]);
  });

  it("writes in the order of the file, whatever the order of the draft", () => {
    const plan = planSave(
      {},
      {
        longCommandSeconds: "60",
        preset: "browser",
        notifications: false,
        width: "300",
        side: "right",
      },
    );
    expect(plan.changes.map((change) => change.path.join("."))).toEqual([
      "appearance.sidebar.position",
      "appearance.sidebar.width",
      "keybindings.preset",
      "notifications.enabled",
      "notifications.longCommandSeconds",
    ]);
    expect(plan.changes.map((change) => ("value" in change ? change.value : undefined))).toEqual([
      "right",
      300,
      "browser",
      false,
      60,
    ]);
  });

  it("does not write a setting put back where it was", () => {
    expect(planSave({}, { side: "left", width: "200", notifications: true })).toEqual({
      changes: [],
      problems: {},
      ...NO_SECTION_PROBLEMS,
    });
  });

  it("writes the default when the file says something else", () => {
    // The file says right; asking for left (the default) is a real change.
    expect(
      planSave({ appearance: { sidebar: { position: "right" } } }, { side: "left" }).changes,
    ).toEqual([{ path: ["appearance", "sidebar", "position"], value: "left" }]);
  });

  it("reads the numbers from their text", () => {
    const plan = planSave({}, { width: " 250 ", longCommandSeconds: "12.5" });
    expect(plan.changes).toEqual([
      { path: ["appearance", "sidebar", "width"], value: 250 },
      { path: ["notifications", "longCommandSeconds"], value: 12.5 },
    ]);
  });

  it("reports a box that cannot be used, and writes nothing for it", () => {
    const plan = planSave({}, { width: "9000", longCommandSeconds: "soon", density: "compact" });
    expect(plan.problems).toEqual({ width: WIDTH_PROBLEM, longCommandSeconds: SECONDS_PROBLEM });
    expect(plan.changes).toEqual([{ path: ["appearance", "density"], value: "compact" }]);
  });

  it("keeps off and zero: they are values to write", () => {
    const plan = planSave({}, { notifications: false, longCommandSeconds: "0" });
    expect(plan.changes).toEqual([
      { path: ["notifications", "enabled"], value: false },
      { path: ["notifications", "longCommandSeconds"], value: 0 },
    ]);
  });
});

describe("the window and the background in the settings screen", () => {
  it("shows the boxes empty for a file that says nothing, and the file's text otherwise", () => {
    expect(shownSettings({}, {})).toMatchObject({
      windowEffect: "none",
      windowOpacity: "",
      backgroundImage: "",
      backgroundOpacity: "",
      backgroundBlur: "",
    });
    expect(shownSettings(EVERYTHING, {})).toMatchObject({
      windowEffect: "mica",
      windowOpacity: "0.8",
      backgroundImage: "backgrounds/sky.png",
      backgroundOpacity: "0.4",
      backgroundBlur: "6",
    });
    // A null in the file is a setting that is not set: the box is empty.
    expect(
      shownSettings({ appearance: { window: { opacity: null }, background: { image: null } } }, {}),
    ).toMatchObject({ windowOpacity: "", backgroundImage: "" });
  });

  it("shows the draft over the file", () => {
    expect(shownSettings(EVERYTHING, { windowOpacity: "0.5", backgroundImage: "" })).toMatchObject({
      windowOpacity: "0.5",
      backgroundImage: "",
      backgroundBlur: "6",
    });
  });

  it("writes the effect like any other choice, only when it differs", () => {
    expect(planSave({}, { windowEffect: "acrylic" }).changes).toEqual([
      { path: ["appearance", "window", "effect"], value: "acrylic" },
    ]);
    expect(planSave({}, { windowEffect: "none" }).changes).toEqual([]);
    expect(planSave(EVERYTHING, { windowEffect: "mica" }).changes).toEqual([]);
  });

  it("writes the numbers and the path from their text, in the order of the file", () => {
    const plan = planSave(
      {},
      {
        backgroundBlur: "4",
        backgroundOpacity: ".5",
        backgroundImage: "C:\\Pictures\\sky.png",
        windowOpacity: " 0.9 ",
      },
    );
    expect(plan.problems).toEqual({});
    expect(plan.changes).toEqual([
      { path: ["appearance", "window", "opacity"], value: 0.9 },
      { path: ["appearance", "background", "image"], value: "C:\\Pictures\\sky.png" },
      { path: ["appearance", "background", "opacity"], value: 0.5 },
      { path: ["appearance", "background", "blur"], value: 4 },
    ]);
  });

  it("writes null for a box emptied where the file has a value, and nothing where it has none", () => {
    expect(
      planSave(EVERYTHING, {
        windowOpacity: "",
        backgroundImage: "  ",
        backgroundOpacity: "",
        backgroundBlur: "",
      }).changes,
    ).toEqual([
      { path: ["appearance", "window", "opacity"], value: null },
      { path: ["appearance", "background", "image"], value: null },
      { path: ["appearance", "background", "opacity"], value: null },
      { path: ["appearance", "background", "blur"], value: null },
    ]);
    expect(
      planSave({}, { windowOpacity: "", backgroundImage: "", backgroundOpacity: "" }).changes,
    ).toEqual([]);
    // A null already in the file is the same as an empty box.
    expect(
      planSave({ appearance: { background: { image: null } } }, { backgroundImage: "" }).changes,
    ).toEqual([]);
  });

  it("does not write a value put back where it was", () => {
    expect(
      planSave(EVERYTHING, { windowOpacity: "0.8", backgroundOpacity: "0.40", backgroundBlur: "6" })
        .changes,
    ).toEqual([]);
  });

  it("reports a box that cannot be used, and writes nothing for it", () => {
    const plan = planSave(
      {},
      {
        windowOpacity: "0.1",
        backgroundOpacity: "1.5",
        backgroundBlur: "400",
        backgroundImage: "https://example.com/sky.png",
        windowEffect: "vibrancy",
      },
    );
    expect(plan.problems.windowOpacity).toBe(WINDOW_OPACITY_PROBLEM);
    expect(plan.problems.backgroundOpacity).toBe(BACKGROUND_OPACITY_PROBLEM);
    expect(plan.problems.backgroundBlur).toBe(BACKGROUND_BLUR_PROBLEM);
    expect(plan.problems.backgroundImage).toMatch(/web addresses/);
    expect(plan.changes).toEqual([{ path: ["appearance", "window", "effect"], value: "vibrancy" }]);
  });

  it("reads each number box within its range", () => {
    expect(parseWindowOpacity("0.3")).toBe(0.3);
    expect(parseWindowOpacity("1")).toBe(1);
    for (const bad of ["", "0.29", "1.01", "-1", "abc", "1e0", "0,5", "NaN", "Infinity"]) {
      expect(parseWindowOpacity(bad), bad).toBeUndefined();
    }
    expect(parseBackgroundOpacity("0")).toBe(0);
    expect(parseBackgroundOpacity(".25")).toBe(0.25);
    for (const bad of ["", "1.1", "-0.1", "x"])
      expect(parseBackgroundOpacity(bad), bad).toBeUndefined();
    expect(parseBackgroundBlur("100")).toBe(100);
    expect(parseBackgroundBlur("0")).toBe(0);
    for (const bad of ["", "100.5", "-1", "x"])
      expect(parseBackgroundBlur(bad), bad).toBeUndefined();
  });
});

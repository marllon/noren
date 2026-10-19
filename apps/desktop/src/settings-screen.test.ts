import { describe, expect, it } from "vitest";
import type { Config } from "@noren/model";
import { DEFAULT_LAYOUT } from "./layout";
import {
  DEFAULT_SETTINGS,
  SECONDS_PROBLEM,
  SETTING_PATHS,
  WIDTH_PROBLEM,
  compactAvailable,
  keepOpenAvailable,
  parseSeconds,
  parseWidth,
  planSave,
  settingsOf,
  settingsSetBy,
  shownSettings,
} from "./settings-screen";
import type { SettingKey } from "./settings-screen";

const EVERYTHING: Config = {
  appearance: {
    sidebar: { position: "right", width: 333, compact: true, keepOpen: true },
    density: "compact",
    tabs: "top",
    paneHeaders: true,
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
  });
});

describe("SETTING_PATHS", () => {
  it("names a place in the schema for every setting, and none twice", () => {
    const places = Object.values(SETTING_PATHS).map((path) => path.join("."));
    expect(new Set(places).size).toBe(places.length);
    expect(places).toContain("appearance.sidebar.position");
    expect(places).toContain("keybindings.preset");
    expect(places).toContain("notifications.longCommandSeconds");
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
    expect(planSave({}, {})).toEqual({ changes: [], problems: {} });
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
    expect(plan.changes.map((change) => change.value)).toEqual([
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

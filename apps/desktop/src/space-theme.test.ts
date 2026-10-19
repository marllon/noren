import { THEMES } from "@noren/model";
import { describe, expect, it } from "vitest";
import { buildSpaceThemeEntries, searchEntries } from "./palette";
import { spaceThemeOptions, useGlobalThemeLabel } from "./space-theme";

describe("spaceThemeOptions", () => {
  it("lists the eight themes and Use global theme last", () => {
    const options = spaceThemeOptions(undefined, THEMES);
    expect(options).toHaveLength(9);
    expect(options.slice(0, 8).map((option) => option.themeId)).toEqual(THEMES.map((t) => t.id));
    expect(options.slice(0, 8).map((option) => option.label)).toEqual(THEMES.map((t) => t.name));
    expect(options[8]).toEqual({ themeId: null, label: useGlobalThemeLabel(), current: true });
  });

  it("marks the theme of the space as the current one, and only it", () => {
    const options = spaceThemeOptions("noren-paper", THEMES);
    expect(options.filter((option) => option.current).map((option) => option.themeId)).toEqual([
      "noren-paper",
    ]);
  });

  it("marks Use global theme for a theme id the build does not have", () => {
    const options = spaceThemeOptions("from-a-later-build", THEMES);
    expect(options.filter((option) => option.current).map((option) => option.themeId)).toEqual([
      null,
    ]);
  });
});

describe("buildSpaceThemeEntries", () => {
  const entries = buildSpaceThemeEntries("Work", spaceThemeOptions("noren-dusk", THEMES));

  it("has one entry per option with unique ids", () => {
    expect(entries).toHaveLength(9);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(9);
    expect(entries[8]).toMatchObject({
      title: useGlobalThemeLabel(),
      themeId: null,
      current: false,
    });
  });

  it("says which one is in use in the space", () => {
    const dusk = entries.find((entry) => entry.themeId === "noren-dusk");
    expect(dusk?.detail).toBe("In use in Work");
    expect(dusk?.current).toBe(true);
  });

  it("is searched by the whole title, and Use global theme is found by its words", () => {
    const ids = (query: string) => searchEntries(entries, query).map((entry) => entry.id);
    expect(ids("noren paper")).toEqual(["space-theme:noren-paper"]);
    expect(ids("use global")[0]).toBe("space-theme:global");
  });
});

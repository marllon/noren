import { describe, expect, it } from "vitest";
import type { ModFile } from "@noren/model";
import { settingsModRows, spaceModOptions } from "./mod-options";

const files: ModFile[] = ["a.css", "b.css", "c.css"].map((name) => ({ name, text: "" }));

describe("settingsModRows", () => {
  it("lists the files by name, all off, when none is on", () => {
    expect(settingsModRows(files, [])).toEqual([
      { name: "a.css", on: false, missing: false },
      { name: "b.css", on: false, missing: false },
      { name: "c.css", on: false, missing: false },
    ]);
  });

  it("puts the mods that are on first, in the order they apply, then the others by name", () => {
    expect(settingsModRows(files, ["c.css", "a.css"])).toEqual([
      { name: "c.css", on: true, missing: false },
      { name: "a.css", on: true, missing: false },
      { name: "b.css", on: false, missing: false },
    ]);
  });

  it("keeps a name that is on and has no file, marked, so it can be turned off", () => {
    expect(settingsModRows(files, ["gone.css", "b.css"])).toEqual([
      { name: "gone.css", on: true, missing: true },
      { name: "b.css", on: true, missing: false },
      { name: "a.css", on: false, missing: false },
      { name: "c.css", on: false, missing: false },
    ]);
  });

  it("is empty for an empty folder and nothing on", () => {
    expect(settingsModRows([], [])).toEqual([]);
  });
});

describe("spaceModOptions", () => {
  it("lists every file, on when the space lists it", () => {
    expect(spaceModOptions(files, [], ["b.css"])).toEqual([
      { name: "a.css", on: false, global: false, missing: false },
      { name: "b.css", on: true, global: false, missing: false },
      { name: "c.css", on: false, global: false, missing: false },
    ]);
  });

  it("shows a mod that is on for every space as on and global, whatever the space lists", () => {
    const options = spaceModOptions(files, ["a.css"], ["a.css", "c.css"]);
    expect(options.map(({ name, on, global }) => [name, on, global])).toEqual([
      ["a.css", true, true],
      ["b.css", false, false],
      ["c.css", true, false],
    ]);
  });

  it("adds the names the space lists that the folder lacks, at the end, as missing", () => {
    expect(spaceModOptions(files, [], ["gone.css", "a.css"])).toEqual([
      { name: "a.css", on: true, global: false, missing: false },
      { name: "b.css", on: false, global: false, missing: false },
      { name: "c.css", on: false, global: false, missing: false },
      { name: "gone.css", on: true, global: false, missing: true },
    ]);
  });

  it("is empty for an empty folder and a space with no mods", () => {
    expect(spaceModOptions([], ["x.css"], [])).toEqual([]);
  });
});

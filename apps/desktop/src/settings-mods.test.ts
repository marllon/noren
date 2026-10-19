import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "@noren/model";
import { MODS_PATH, planSave, shownSettings } from "./settings-screen";

// The list of global mods in the draft of the settings screen: shown as the file has it, written
// whole and only when it is not the list in force.

describe("the mods in shownSettings", () => {
  it("are the ones the file lists, in order, else none", () => {
    expect(shownSettings({}, {}).mods).toEqual([]);
    expect(shownSettings({ mods: ["b.css", "a.css"] }, {}).mods).toEqual(["b.css", "a.css"]);
  });

  it("are the draft over the file", () => {
    expect(shownSettings({ mods: ["a.css"] }, { mods: ["b.css"] }).mods).toEqual(["b.css"]);
    expect(shownSettings({ mods: ["a.css"] }, { mods: [] }).mods).toEqual([]);
  });
});

describe("planSave with mods", () => {
  it("writes nothing for an untouched draft or one put back where it was", () => {
    expect(planSave({}, {}).changes).toEqual([]);
    expect(planSave({}, { mods: [] }).changes).toEqual([]);
    expect(planSave({ mods: ["a.css", "b.css"] }, { mods: ["a.css", "b.css"] }).changes).toEqual(
      [],
    );
  });

  it("writes the whole list at the mods key", () => {
    expect(planSave({}, { mods: ["a.css"] }).changes).toEqual([
      { path: MODS_PATH, value: ["a.css"] },
    ]);
    expect(MODS_PATH).toEqual(["mods"]);
  });

  it("writes a list in another order, and an empty list when the file had mods", () => {
    expect(planSave({ mods: ["a.css", "b.css"] }, { mods: ["b.css", "a.css"] }).changes).toEqual([
      { path: ["mods"], value: ["b.css", "a.css"] },
    ]);
    expect(planSave({ mods: ["a.css"] }, { mods: [] }).changes).toEqual([
      { path: ["mods"], value: [] },
    ]);
  });

  it("goes with the other changes, and the text it makes is a valid file", () => {
    const plan = planSave({}, { density: "compact", mods: ["a.css"], preset: "browser" });
    expect(plan.changes.map((change) => change.path.join("."))).toEqual([
      "appearance.density",
      "keybindings.preset",
      "mods",
    ]);
    const text = editConfigText("// mine\n{}\n", plan.changes);
    const parsed = parseConfigText(text);
    expect(parsed).toEqual({
      ok: true,
      config: {
        appearance: { density: "compact" },
        mods: ["a.css"],
        keybindings: { preset: "browser" },
      },
    });
    expect(text).toContain("// mine");
  });
});

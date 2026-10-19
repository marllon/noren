import { describe, expect, it } from "vitest";
import { DEFAULT_MONOSPACE_FONTS, FakeBackend } from "./fake-backend";

// The monospaced fonts the fake computer has, answered the way the real backend promises.

describe("FakeBackend.listMonospaceFonts", () => {
  it("lists the families the terminal falls back to by default", async () => {
    const backend = new FakeBackend();
    expect(await backend.listMonospaceFonts()).toEqual([...DEFAULT_MONOSPACE_FONTS]);
    expect(backend.callsTo("listMonospaceFonts")).toHaveLength(1);
  });

  it("answers the fonts it was given, once each, in alphabetical order, names only", async () => {
    const backend = new FakeBackend({
      monospaceFonts: ["Hack", "consolas", "Consolas", 'Evil"Font', "Cascadia Code", "a;b", ""],
    });
    expect(await backend.listMonospaceFonts()).toEqual(["Cascadia Code", "consolas", "Hack"]);
  });

  it("answers an empty list for a computer with no monospaced font", async () => {
    expect(await new FakeBackend({ monospaceFonts: [] }).listMonospaceFonts()).toEqual([]);
  });

  it("follows the fonts being installed", async () => {
    const backend = new FakeBackend({ monospaceFonts: ["Consolas"] });
    backend.setMonospaceFonts(["Consolas", "Fira Code"]);
    expect(await backend.listMonospaceFonts()).toEqual(["Consolas", "Fira Code"]);
  });

  it("changes nothing it keeps: no config, no state, no theme", async () => {
    const backend = new FakeBackend();
    await backend.listMonospaceFonts();
    expect(backend.configContent).toBeNull();
    expect(backend.stateContent).toBeNull();
    expect(backend.userThemeFiles).toEqual({});
  });
});

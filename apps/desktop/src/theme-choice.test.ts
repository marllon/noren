import { ConfigManager, FakeBackend } from "@noren/model";
import { describe, expect, it } from "vitest";
import { planThemeChoice, runThemeChoice, themeChoiceOf } from "./theme-choice";

async function started(text: string | null) {
  const backend = new FakeBackend({ config: text });
  const manager = new ConfigManager();
  await manager.start(backend);
  return { backend, manager };
}

describe("themeChoiceOf", () => {
  it("is the id of a theme the settings name", () => {
    expect(themeChoiceOf({ appearance: { theme: "noren-paper" } })).toBe("noren-paper");
    expect(themeChoiceOf({ appearance: { theme: "noren-oat" } })).toBe("noren-oat");
  });

  it("follows the system with no value, with system, or with a theme this build does not have", () => {
    expect(themeChoiceOf({})).toBeNull();
    expect(themeChoiceOf({ appearance: {} })).toBeNull();
    expect(themeChoiceOf({ appearance: { theme: "system" } })).toBeNull();
    expect(themeChoiceOf({ appearance: { theme: "no-such-theme" } })).toBeNull();
  });
});

describe("planThemeChoice", () => {
  it("writes the id of a theme at appearance.theme", () => {
    expect(planThemeChoice({}, "noren-paper")).toEqual({
      changes: [{ path: ["appearance", "theme"], value: "noren-paper" }],
    });
  });

  it("writes nothing when the file already says it", () => {
    expect(planThemeChoice({ appearance: { theme: "noren-paper" } }, "noren-paper")).toEqual({
      changes: [],
    });
  });

  it("writes system when the file names something else, and nothing when it names nothing", () => {
    expect(planThemeChoice({ appearance: { theme: "noren-paper" } }, null)).toEqual({
      changes: [{ path: ["appearance", "theme"], value: "system" }],
    });
    expect(planThemeChoice({ appearance: { theme: "no-such-theme" } }, null)).toEqual({
      changes: [{ path: ["appearance", "theme"], value: "system" }],
    });
    expect(planThemeChoice({}, null)).toEqual({ changes: [] });
    expect(planThemeChoice({ appearance: { theme: "system" } }, null)).toEqual({ changes: [] });
  });

  it("refuses a theme this build does not have", () => {
    expect(planThemeChoice({}, "no-such-theme")).toEqual({
      refusal: 'There is no theme "no-such-theme".',
    });
  });
});

describe("runThemeChoice", () => {
  it("writes the choice into the file, keeps its comments and applies it at once", async () => {
    const { backend, manager } = await started(
      '// my settings\n{\n  "appearance": {\n    "tabs": "top", // up there\n  },\n}\n',
    );
    expect(await runThemeChoice(manager, "noren-fjord")).toBeUndefined();
    expect(manager.state.config.appearance).toEqual({ theme: "noren-fjord", tabs: "top" });
    expect(backend.configContent).toBe(
      '// my settings\n{\n  "appearance": {\n    "theme": "noren-fjord",\n    "tabs": "top", // up there\n  },\n}\n',
    );
  });

  it("replaces only the value when the file already has a theme", async () => {
    const { backend, manager } = await started(
      '{\n  "appearance": { "theme": "noren-dusk" /* mine */, "tabs": "top" }\n}\n',
    );
    expect(await runThemeChoice(manager, "noren-oat")).toBeUndefined();
    expect(backend.configContent).toBe(
      '{\n  "appearance": { "theme": "noren-oat" /* mine */, "tabs": "top" }\n}\n',
    );
  });

  it("creates the file when there is none", async () => {
    const { backend, manager } = await started(null);
    expect(await runThemeChoice(manager, "noren-paper")).toBeUndefined();
    expect(backend.configContent).toBe(
      '{\n  "appearance": {\n    "theme": "noren-paper"\n  }\n}\n',
    );
  });

  it("writes nothing when the choice is the one in force", async () => {
    const { backend, manager } = await started('{ "appearance": { "theme": "noren-paper" } }');
    expect(await runThemeChoice(manager, "noren-paper")).toBeUndefined();
    expect(await runThemeChoice(manager, null)).toBeUndefined();
    expect(backend.callsTo("saveConfig")).toHaveLength(1);
    const empty = await started(null);
    expect(await runThemeChoice(empty.manager, null)).toBeUndefined();
    expect(empty.backend.callsTo("saveConfig")).toHaveLength(0);
  });

  it("says why when the file has a problem of its own, and writes nothing", async () => {
    const broken = '{ "appearance": { "tabs": "sideways" } }';
    const { backend, manager } = await started(broken);
    const notice = await runThemeChoice(manager, "noren-paper");
    expect(notice).toEqual(expect.any(String));
    expect(backend.configContent).toBe(broken);
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
  });

  it("says why when the write fails, and the settings in force stay", async () => {
    const { backend, manager } = await started('{ "appearance": { "theme": "noren-dusk" } }');
    backend.setConfigSaveFailure(new Error("disk full"));
    expect(await runThemeChoice(manager, "noren-paper")).toContain("disk full");
    expect(manager.state.config.appearance?.theme).toBe("noren-dusk");
  });

  it("refuses an unknown theme without touching the file", async () => {
    const { backend, manager } = await started(null);
    expect(await runThemeChoice(manager, "nope")).toBe('There is no theme "nope".');
    expect(backend.callsTo("saveConfig")).toHaveLength(0);
  });
});

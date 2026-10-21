import { afterEach, describe, expect, it } from "vitest";
import { ConfigManager, FakeBackend, parseConfigText } from "@noren/model";
import type { Config } from "@noren/model";
import { setLanguage } from "./i18n";
import { ACTIONS } from "./keybindings";
import {
  planScreenReaderToggle,
  runScreenReaderToggle,
  screenReaderModeOn,
} from "./screen-reader-action";

// "Toggle screen reader mode" of the palette: it flips `terminal.screenReaderMode` in the file,
// keeps the comments, and says in a sentence what the mode is now (or why it could not be written).

afterEach(() => setLanguage("en"));

async function started(text: string | null) {
  const backend = new FakeBackend({ config: text });
  const manager = new ConfigManager();
  await manager.start(backend);
  return { backend, manager };
}

function settingsOfText(text: string | null): Config {
  const parsed = parseConfigText(text ?? "");
  if (!parsed.ok) throw new Error("the file has a problem");
  return parsed.config;
}

describe("the action in the registry", () => {
  it("is a Terminal action with no key of its own", () => {
    const action = ACTIONS.find((entry) => entry.id === "terminal.screen-reader");
    expect(action?.title).toBe("Toggle screen reader mode");
    expect(action?.category).toBe("Terminal");
    expect(action?.command).toEqual({ kind: "screen-reader" });
    expect(action?.chords).toEqual({ safe: undefined, browser: undefined });
  });
});

describe("planScreenReaderToggle", () => {
  it("turns it on when it is off or not in the file, and off when it is on", () => {
    expect(screenReaderModeOn({})).toBe(false);
    expect(planScreenReaderToggle({})).toEqual({
      path: ["terminal", "screenReaderMode"],
      value: true,
    });
    expect(planScreenReaderToggle({ terminal: { screenReaderMode: false } }).value).toBe(true);
    expect(planScreenReaderToggle({ terminal: { screenReaderMode: true } }).value).toBe(false);
  });
});

describe("runScreenReaderToggle", () => {
  it("writes the setting, keeps the comments and says the mode is on, then off", async () => {
    const { backend, manager } = await started('// mine\n{ "terminal": { "scrollback": 500 } }\n');
    expect(await runScreenReaderToggle(manager)).toBe("Screen reader mode is on.");
    const on = backend.configContent ?? "";
    expect(on).toContain("// mine");
    expect(settingsOfText(on).terminal).toEqual({ scrollback: 500, screenReaderMode: true });
    expect(screenReaderModeOn(manager.state.config)).toBe(true);

    expect(await runScreenReaderToggle(manager)).toBe("Screen reader mode is off.");
    expect(settingsOfText(backend.configContent).terminal?.screenReaderMode).toBe(false);
  });

  it("makes the file when there is none", async () => {
    const { backend, manager } = await started(null);
    expect(await runScreenReaderToggle(manager)).toBe("Screen reader mode is on.");
    expect(settingsOfText(backend.configContent).terminal?.screenReaderMode).toBe(true);
  });

  it("says it in Brazilian Portuguese when that is the language", async () => {
    setLanguage("pt-BR");
    const { manager } = await started(null);
    expect(await runScreenReaderToggle(manager)).toBe("O modo leitor de tela está ligado.");
  });

  it("gives the reason, and writes nothing, when the file has a problem of its own", async () => {
    const broken = '{ "terminal": { "scrollback": "many" } }';
    const { backend, manager } = await started(broken);
    const sentence = await runScreenReaderToggle(manager);
    expect(sentence).not.toBe("Screen reader mode is on.");
    expect(sentence).not.toBe("");
    expect(backend.configContent).toBe(broken);
  });
});

import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  DEFAULT_KEYBINDINGS,
  KEYBINDINGS_KEY,
  PRESETS,
  chordOf,
  createResolver,
  findConflicts,
  isChord,
  loadKeybindings,
  parseKeybindings,
  resolveBindings,
  saveKeybindings,
} from "./keybindings";
import type { ActionCommand, Keybindings, KeybindingsStorage, ShortcutEvent } from "./keybindings";

function press(code: string, mods: Partial<Omit<ShortcutEvent, "code">> = {}): ShortcutEvent {
  return { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

const ctrl = { ctrlKey: true };
const ctrlShift = { ctrlKey: true, shiftKey: true };
const ctrlAlt = { ctrlKey: true, altKey: true };
const ctrlAltShift = { ctrlKey: true, altKey: true, shiftKey: true };
const alt = { altKey: true };

/** The command a press runs under `keybindings`, or undefined when the key is the terminal's. */
function commandOf(keybindings: Keybindings, event: ShortcutEvent): ActionCommand | undefined {
  return createResolver(resolveBindings(keybindings).chords)(event)?.command;
}

const safe: Keybindings = { preset: "safe", overrides: {} };
const browser: Keybindings = { preset: "browser", overrides: {} };

function memoryStorage(initial: Record<string, string> = {}): KeybindingsStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("the registry", () => {
  it("has unique ids and a title for each action", () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
    for (const action of ACTIONS) expect(action.title).not.toBe("");
  });

  it("has valid chords with no chord bound twice in either preset", () => {
    for (const preset of PRESETS) {
      const chords = ACTIONS.flatMap((action) => {
        const chord = action.chords[preset];
        return chord === undefined ? [] : [chord];
      });
      for (const chord of chords) expect(isChord(chord)).toBe(true);
      expect(new Set(chords).size).toBe(chords.length);
      expect(findConflicts(resolveBindings({ preset, overrides: {} }).chords)).toEqual([]);
    }
  });
});

describe("the recent-tab switcher", () => {
  it("has a next and a previous action with Ctrl+Tab and Ctrl+Shift+Tab in both presets", () => {
    for (const preset of PRESETS) {
      const next = ACTIONS.find((action) => action.id === "tab.mru-next");
      const prev = ACTIONS.find((action) => action.id === "tab.mru-prev");
      expect(next?.chords[preset]).toBe("Ctrl+Tab");
      expect(prev?.chords[preset]).toBe("Ctrl+Shift+Tab");
      expect(next?.command).toEqual({ kind: "mru", delta: 1 });
      expect(prev?.command).toEqual({ kind: "mru", delta: -1 });
      // Holding Tab walks on, like the arrows.
      expect(next?.repeat).toBe(true);
      expect(prev?.repeat).toBe(true);
    }
  });

  it("resolves the presses to the switcher in the safe and the browser preset", () => {
    for (const keybindings of [safe, browser]) {
      expect(commandOf(keybindings, press("Tab", ctrl))).toEqual({ kind: "mru", delta: 1 });
      expect(commandOf(keybindings, press("Tab", ctrlShift))).toEqual({ kind: "mru", delta: -1 });
    }
  });

  it("leaves a Tab with other modifiers to the terminal", () => {
    expect(commandOf(safe, press("Tab"))).toBeUndefined();
    expect(commandOf(safe, press("Tab", { shiftKey: true }))).toBeUndefined();
    expect(commandOf(safe, press("Tab", alt))).toBeUndefined();
  });

  it("can be moved to another chord by an override", () => {
    const moved: Keybindings = { preset: "safe", overrides: { "tab.mru-next": "Alt+KeyJ" } };
    expect(commandOf(moved, press("Tab", ctrl))).toBeUndefined();
    expect(commandOf(moved, press("KeyJ", alt))).toEqual({ kind: "mru", delta: 1 });
  });
});

describe("the search over all tabs", () => {
  it("is one action on Ctrl+Shift+Alt+F in both presets, and it does not repeat", () => {
    const action = ACTIONS.find((a) => a.id === "tab.search-all");
    expect(action?.title).toBe("Search all tabs");
    expect(action?.category).toBe("Tabs");
    expect(action?.command).toEqual({ kind: "search-all" });
    expect(action?.repeat).toBe(false);
    for (const preset of PRESETS) expect(action?.chords[preset]).toBe("Ctrl+Alt+Shift+KeyF");
  });

  it("resolves Ctrl+Shift+Alt+F to it in the safe and the browser preset", () => {
    for (const keybindings of [safe, browser]) {
      expect(commandOf(keybindings, press("KeyF", ctrlAltShift))).toEqual({ kind: "search-all" });
    }
  });

  it("leaves F with other modifiers to the terminal", () => {
    expect(commandOf(safe, press("KeyF"))).toBeUndefined();
    expect(commandOf(safe, press("KeyF", ctrl))).toBeUndefined();
    expect(commandOf(safe, press("KeyF", ctrlShift))).toBeUndefined();
    expect(commandOf(safe, press("KeyF", ctrlAlt))).toBeUndefined();
    expect(commandOf(safe, press("KeyF", { ...ctrlAltShift, metaKey: true }))).toBeUndefined();
  });

  it("can be moved to another chord by an override", () => {
    const moved: Keybindings = { preset: "safe", overrides: { "tab.search-all": "Alt+KeyG" } };
    expect(commandOf(moved, press("KeyF", ctrlAltShift))).toBeUndefined();
    expect(commandOf(moved, press("KeyG", alt))).toEqual({ kind: "search-all" });
  });
});

describe("the command marks", () => {
  const find = (id: string) => ACTIONS.find((action) => action.id === id);

  it("moves between prompts on Ctrl+Up and Ctrl+Down in both presets, and repeats", () => {
    const previous = find("terminal.prompt-previous");
    const next = find("terminal.prompt-next");
    expect(previous?.title).toBe("Previous prompt");
    expect(next?.title).toBe("Next prompt");
    expect(previous?.category).toBe("Terminal");
    expect(next?.category).toBe("Terminal");
    expect(previous?.command).toEqual({ kind: "prompt", direction: "previous" });
    expect(next?.command).toEqual({ kind: "prompt", direction: "next" });
    expect(previous?.repeat).toBe(true);
    expect(next?.repeat).toBe(true);
    for (const preset of PRESETS) {
      expect(previous?.chords[preset]).toBe("Ctrl+ArrowUp");
      expect(next?.chords[preset]).toBe("Ctrl+ArrowDown");
    }
  });

  it("resolves the arrows with Ctrl alone to the prompts, in the safe and the browser preset", () => {
    for (const keybindings of [safe, browser]) {
      expect(commandOf(keybindings, press("ArrowUp", ctrl))).toEqual({
        kind: "prompt",
        direction: "previous",
      });
      expect(commandOf(keybindings, press("ArrowDown", ctrl))).toEqual({
        kind: "prompt",
        direction: "next",
      });
    }
  });

  it("leaves the up and down arrows with any other modifiers to the terminal or to the panes", () => {
    expect(commandOf(safe, press("ArrowUp"))).toBeUndefined();
    expect(commandOf(safe, press("ArrowDown"))).toBeUndefined();
    expect(commandOf(safe, press("ArrowUp", ctrlShift))).toBeUndefined();
    expect(commandOf(safe, press("ArrowUp", ctrlAlt))).toBeUndefined();
    expect(commandOf(safe, press("ArrowUp", { ...ctrl, metaKey: true }))).toBeUndefined();
    // Alt+arrows focus a pane and Ctrl+Alt+Shift+arrows resize one, as before.
    expect(commandOf(safe, press("ArrowUp", alt))).toEqual({ kind: "focus", direction: "up" });
    expect(commandOf(safe, press("ArrowUp", ctrlAltShift))).toEqual({
      kind: "resize",
      direction: "up",
    });
  });

  it("has actions to select and copy the output with no chord, which the user can record", () => {
    const select = find("terminal.select-output");
    const copy = find("terminal.copy-output");
    expect(select?.title).toBe("Select command output");
    expect(copy?.title).toBe("Copy last command output");
    expect(select?.command).toEqual({ kind: "select-output" });
    expect(copy?.command).toEqual({ kind: "copy-output" });
    for (const preset of PRESETS) {
      expect(select?.chords[preset]).toBeUndefined();
      expect(copy?.chords[preset]).toBeUndefined();
    }
    const recorded: Keybindings = {
      preset: "safe",
      overrides: { "terminal.copy-output": "Ctrl+Alt+Shift+KeyC" },
    };
    expect(commandOf(recorded, press("KeyC", ctrlAltShift))).toEqual({ kind: "copy-output" });
    expect(commandOf(safe, press("KeyC", ctrlAltShift))).toBeUndefined();
  });

  it("can have the prompt chords moved or taken away", () => {
    const moved: Keybindings = {
      preset: "safe",
      overrides: { "terminal.prompt-previous": "Alt+KeyK", "terminal.prompt-next": null },
    };
    expect(commandOf(moved, press("ArrowUp", ctrl))).toBeUndefined();
    expect(commandOf(moved, press("ArrowDown", ctrl))).toBeUndefined();
    expect(commandOf(moved, press("KeyK", alt))).toEqual({ kind: "prompt", direction: "previous" });
  });
});

describe("chordOf", () => {
  it("writes the modifiers in a fixed order before the physical key", () => {
    expect(chordOf(press("KeyT", ctrlShift))).toBe("Ctrl+Shift+KeyT");
    expect(chordOf(press("ArrowLeft", ctrlAltShift))).toBe("Ctrl+Alt+Shift+ArrowLeft");
    expect(chordOf(press("Digit1", alt))).toBe("Alt+Digit1");
    expect(chordOf(press("KeyA"))).toBe("KeyA");
  });

  it("has no chord for Meta or for a modifier key on its own", () => {
    expect(chordOf(press("KeyT", { ctrlKey: true, metaKey: true }))).toBeUndefined();
    expect(chordOf(press("ControlLeft", ctrl))).toBeUndefined();
    expect(chordOf(press("ShiftRight", { shiftKey: true }))).toBeUndefined();
    expect(chordOf(press(""))).toBeUndefined();
  });
});

describe("isChord", () => {
  it("accepts a physical key with Ctrl or Alt", () => {
    expect(isChord("Ctrl+KeyT")).toBe(true);
    expect(isChord("Alt+ArrowLeft")).toBe(true);
    expect(isChord("Ctrl+Alt+Shift+Digit9")).toBe(true);
  });

  it("refuses typing, bad order, modifier-only and junk", () => {
    for (const text of [
      "",
      "KeyT",
      "Shift+KeyT",
      "Shift+Ctrl+KeyT",
      "Ctrl+Alt",
      "Ctrl+ControlLeft",
      "ctrl+KeyT",
      "Ctrl+",
      "Ctrl+Key T",
      "Ctrl+Meta+KeyT",
    ]) {
      expect(isChord(text)).toBe(false);
    }
  });
});

describe("the safe preset (the default)", () => {
  it("is the default", () => {
    expect(DEFAULT_KEYBINDINGS).toEqual(safe);
  });

  it("keeps today's split, close, zoom, focus and resize chords", () => {
    expect(commandOf(safe, press("KeyD", ctrlShift))).toEqual({ kind: "split", dir: "row" });
    expect(commandOf(safe, press("KeyE", ctrlShift))).toEqual({ kind: "split", dir: "column" });
    expect(commandOf(safe, press("KeyW", ctrlShift))).toEqual({ kind: "close" });
    expect(commandOf(safe, press("KeyZ", ctrlShift))).toEqual({ kind: "zoom" });
    expect(commandOf(safe, press("ArrowLeft", alt))).toEqual({ kind: "focus", direction: "left" });
    expect(commandOf(safe, press("ArrowDown", alt))).toEqual({ kind: "focus", direction: "down" });
    expect(commandOf(safe, press("ArrowRight", ctrlAltShift))).toEqual({
      kind: "resize",
      direction: "right",
    });
    expect(commandOf(safe, press("ArrowUp", ctrlAltShift))).toEqual({
      kind: "resize",
      direction: "up",
    });
  });

  it("keeps Ctrl+Alt+1..9 for the spaces", () => {
    expect(commandOf(safe, press("Digit1", ctrlAlt))).toEqual({ kind: "space", index: 0 });
    expect(commandOf(safe, press("Digit9", ctrlAlt))).toEqual({ kind: "space", index: 8 });
    expect(commandOf(safe, press("Digit0", ctrlAlt))).toBeUndefined();
    expect(commandOf(safe, press("Digit1", { ...ctrlAlt, shiftKey: true }))).toBeUndefined();
    expect(commandOf(safe, press("Digit1", { ...ctrlAlt, metaKey: true }))).toBeUndefined();
  });

  it("opens a tab on Ctrl+Shift+T and goes to tab 1..9 on Alt+1..9", () => {
    expect(commandOf(safe, press("KeyT", ctrlShift))).toEqual({ kind: "new-tab" });
    expect(commandOf(safe, press("Digit1", alt))).toEqual({ kind: "tab", index: 0 });
    expect(commandOf(safe, press("Digit9", alt))).toEqual({ kind: "tab", index: 8 });
  });

  it("leaves Ctrl+T and Ctrl+W to the terminal", () => {
    expect(commandOf(safe, press("KeyT", ctrl))).toBeUndefined();
    expect(commandOf(safe, press("KeyW", ctrl))).toBeUndefined();
    expect(commandOf(safe, press("Digit1", ctrl))).toBeUndefined();
  });

  it("leaves every other combination to the terminal", () => {
    // Plain keys and the shell's own Ctrl+D, Ctrl+Z.
    expect(commandOf(safe, press("KeyD"))).toBeUndefined();
    expect(commandOf(safe, press("KeyD", ctrl))).toBeUndefined();
    expect(commandOf(safe, press("KeyZ", ctrl))).toBeUndefined();
    expect(commandOf(safe, press("KeyD", { shiftKey: true }))).toBeUndefined();
    // The Alt that belongs to Ctrl+Shift+Alt+T and the like.
    expect(commandOf(safe, press("KeyD", { ...ctrlShift, altKey: true }))).toBeUndefined();
    expect(commandOf(safe, press("KeyD", { ...ctrlShift, metaKey: true }))).toBeUndefined();
    // Arrows with other modifiers: word jumps and selection in the shell.
    expect(commandOf(safe, press("ArrowLeft"))).toBeUndefined();
    expect(commandOf(safe, press("ArrowLeft", ctrl))).toBeUndefined();
    expect(commandOf(safe, press("ArrowLeft", ctrlShift))).toBeUndefined();
    expect(commandOf(safe, press("ArrowLeft", { altKey: true, shiftKey: true }))).toBeUndefined();
    expect(commandOf(safe, press("ArrowLeft", ctrlAlt))).toBeUndefined();
    expect(commandOf(safe, press("ArrowLeft", { altKey: true, metaKey: true }))).toBeUndefined();
  });

  it("repeats only the actions that move (focus, resize, recent tabs, prompts)", () => {
    for (const action of ACTIONS) {
      const moves =
        action.command.kind === "focus" ||
        action.command.kind === "resize" ||
        action.command.kind === "mru" ||
        action.command.kind === "prompt";
      expect(action.repeat).toBe(moves);
    }
  });
});

describe("the browser preset", () => {
  it("opens a tab on Ctrl+T and closes the pane on Ctrl+W", () => {
    expect(commandOf(browser, press("KeyT", ctrl))).toEqual({ kind: "new-tab" });
    expect(commandOf(browser, press("KeyW", ctrl))).toEqual({ kind: "close" });
  });

  it("goes to tab 1..9 on Ctrl+1..9", () => {
    expect(commandOf(browser, press("Digit1", ctrl))).toEqual({ kind: "tab", index: 0 });
    expect(commandOf(browser, press("Digit9", ctrl))).toEqual({ kind: "tab", index: 8 });
  });

  it("frees the chords the safe preset used for those actions", () => {
    expect(commandOf(browser, press("KeyT", ctrlShift))).toBeUndefined();
    expect(commandOf(browser, press("KeyW", ctrlShift))).toBeUndefined();
    expect(commandOf(browser, press("Digit1", alt))).toBeUndefined();
  });

  it("keeps the rest as the safe preset has it", () => {
    for (const action of ACTIONS) {
      if (["tab.new", "pane.close"].includes(action.id) || /^tab\.\d$/.test(action.id)) continue;
      expect(action.chords.browser).toBe(action.chords.safe);
    }
    expect(commandOf(browser, press("KeyD", ctrlShift))).toEqual({ kind: "split", dir: "row" });
    expect(commandOf(browser, press("Digit2", ctrlAlt))).toEqual({ kind: "space", index: 1 });
  });
});

describe("overrides", () => {
  it("moves an action to another chord and frees its preset chord", () => {
    const own: Keybindings = { preset: "safe", overrides: { "pane.zoom": "Ctrl+Alt+KeyM" } };
    expect(commandOf(own, press("KeyM", ctrlAlt))).toEqual({ kind: "zoom" });
    expect(commandOf(own, press("KeyZ", ctrlShift))).toBeUndefined();
    expect(resolveBindings(own).rejected).toEqual([]);
  });

  it("leaves an action without a key when the override is none", () => {
    const own: Keybindings = { preset: "safe", overrides: { "pane.zoom": null } };
    expect(commandOf(own, press("KeyZ", ctrlShift))).toBeUndefined();
    expect(resolveBindings(own).chords["pane.zoom"]).toBeUndefined();
  });

  it("applies on top of the browser preset", () => {
    const own: Keybindings = { preset: "browser", overrides: { "tab.new": "Ctrl+Alt+KeyN" } };
    expect(commandOf(own, press("KeyN", ctrlAlt))).toEqual({ kind: "new-tab" });
    expect(commandOf(own, press("KeyT", ctrl))).toBeUndefined();
    expect(commandOf(own, press("KeyW", ctrl))).toEqual({ kind: "close" });
  });

  it("lets an action take the chord another one gave up in the same set of overrides", () => {
    const own: Keybindings = {
      preset: "safe",
      overrides: { "pane.zoom": "Ctrl+Shift+KeyD", "pane.split-right": null },
    };
    expect(commandOf(own, press("KeyD", ctrlShift))).toEqual({ kind: "zoom" });
    expect(resolveBindings(own).rejected).toEqual([]);
  });
});

describe("conflicts", () => {
  it("reports a chord bound to two actions", () => {
    const chords = { "pane.zoom": "Ctrl+Shift+KeyD", "pane.split-right": "Ctrl+Shift+KeyD" };
    expect(findConflicts(chords)).toEqual([
      { chord: "Ctrl+Shift+KeyD", actionIds: ["pane.split-right", "pane.zoom"] },
    ]);
    expect(findConflicts({ "pane.zoom": "Ctrl+Shift+KeyZ", "pane.close": undefined })).toEqual([]);
  });

  it("does not apply the override that causes a conflict", () => {
    // Ctrl+Shift+D belongs to "Split right": the zoom override is refused and zoom keeps its chord.
    const own: Keybindings = { preset: "safe", overrides: { "pane.zoom": "Ctrl+Shift+KeyD" } };
    const { chords, rejected } = resolveBindings(own);
    expect(rejected).toEqual([
      { actionId: "pane.zoom", chord: "Ctrl+Shift+KeyD", keptBy: ["pane.split-right"] },
    ]);
    expect(chords["pane.zoom"]).toBe("Ctrl+Shift+KeyZ");
    expect(findConflicts(chords)).toEqual([]);
    expect(commandOf(own, press("KeyD", ctrlShift))).toEqual({ kind: "split", dir: "row" });
    expect(commandOf(own, press("KeyZ", ctrlShift))).toEqual({ kind: "zoom" });
  });

  it("refuses an override that takes a chord of the active preset", () => {
    // Ctrl+T is the browser preset's "New tab" but free in the safe one.
    const inSafe: Keybindings = { preset: "safe", overrides: { "pane.zoom": "Ctrl+KeyT" } };
    expect(resolveBindings(inSafe).rejected).toEqual([]);
    expect(commandOf(inSafe, press("KeyT", ctrl))).toEqual({ kind: "zoom" });
    const inBrowser: Keybindings = { preset: "browser", overrides: { "pane.zoom": "Ctrl+KeyT" } };
    expect(resolveBindings(inBrowser).rejected).toHaveLength(1);
    expect(commandOf(inBrowser, press("KeyT", ctrl))).toEqual({ kind: "new-tab" });
  });

  it("treats an override equal to the preset chord as no override", () => {
    const own: Keybindings = {
      preset: "safe",
      overrides: { "pane.zoom": "Ctrl+Shift+KeyZ", "tab.new": "Ctrl+Shift+KeyT" },
    };
    expect(resolveBindings(own)).toEqual(resolveBindings(safe));
  });

  it("gives a chord asked by two overrides to the first action of the registry", () => {
    const own: Keybindings = {
      preset: "safe",
      overrides: { "pane.zoom": "Ctrl+Alt+KeyM", "tab.new": "Ctrl+Alt+KeyM" },
    };
    const { chords, rejected } = resolveBindings(own);
    expect(chords["tab.new"]).toBe("Ctrl+Alt+KeyM");
    expect(chords["pane.zoom"]).toBe("Ctrl+Shift+KeyZ");
    expect(rejected).toEqual([
      { actionId: "pane.zoom", chord: "Ctrl+Alt+KeyM", keptBy: ["tab.new"] },
    ]);
  });

  it("never leaves a conflict in the map, for every one or two overrides drawn from the presets", () => {
    const ids = ACTIONS.map((action) => action.id);
    const pool: (string | null)[] = [
      null,
      ...new Set(
        ACTIONS.flatMap((action) =>
          PRESETS.flatMap((preset) => {
            const chord = action.chords[preset];
            return chord === undefined ? [] : [chord];
          }),
        ),
      ),
    ];
    const check = (preset: Keybindings["preset"], overrides: Record<string, string | null>) => {
      const resolved = resolveBindings({ preset, overrides });
      expect(findConflicts(resolved.chords)).toEqual([]);
      for (const rejection of resolved.rejected) {
        expect(resolved.chords[rejection.actionId]).not.toBe(rejection.chord);
      }
    };
    // Not a dependency of this app: fast-check lives in @noren/model, so walk the cases instead.
    const second = ["pane.zoom", "tab.new", "space.1", "tab.1", "pane.focus-left"];
    for (const preset of PRESETS) {
      for (const id of ids) {
        for (const chord of pool) {
          check(preset, { [id]: chord });
          for (const other of second) {
            if (other === id) continue;
            for (const otherChord of [null, "Ctrl+Shift+KeyD", "Ctrl+KeyT", "Alt+Digit1"]) {
              check(preset, { [id]: chord, [other]: otherChord });
            }
          }
        }
      }
    }
  });
});

describe("parseKeybindings", () => {
  it("gives the default when nothing is saved", () => {
    expect(parseKeybindings(null)).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("gives the default for text that is not an object", () => {
    for (const raw of ["", "{", "null", "7", '"browser"', "[1,2]", "true"]) {
      expect(parseKeybindings(raw)).toEqual(DEFAULT_KEYBINDINGS);
    }
  });

  it("returns a new object, never the shared default", () => {
    expect(parseKeybindings(null)).not.toBe(DEFAULT_KEYBINDINGS);
  });

  it("reads a saved preset and overrides", () => {
    const raw = JSON.stringify({
      preset: "browser",
      overrides: { "pane.zoom": "Ctrl+Alt+KeyM", "pane.close": null },
    });
    expect(parseKeybindings(raw)).toEqual({
      preset: "browser",
      overrides: { "pane.zoom": "Ctrl+Alt+KeyM", "pane.close": null },
    });
  });

  it("falls back per part: an unknown preset, an unknown action or a chord that cannot match", () => {
    const raw = JSON.stringify({
      preset: "emacs",
      overrides: {
        "pane.zoom": "Ctrl+Alt+KeyM",
        "no.such.action": "Ctrl+Alt+KeyN",
        "pane.close": "KeyW",
        "tab.new": 7,
        "pane.split-right": "Shift+Ctrl+KeyD",
      },
    });
    expect(parseKeybindings(raw)).toEqual({
      preset: "safe",
      overrides: { "pane.zoom": "Ctrl+Alt+KeyM" },
    });
    expect(parseKeybindings('{"preset":"browser","overrides":[1]}')).toEqual({
      preset: "browser",
      overrides: {},
    });
    expect(parseKeybindings('{"overrides":"x"}')).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("round-trips through the storage", () => {
    const storage = memoryStorage();
    const own: Keybindings = { preset: "browser", overrides: { "pane.zoom": null } };
    saveKeybindings(storage, own);
    expect(Object.keys(storage.data)).toEqual([KEYBINDINGS_KEY]);
    expect(loadKeybindings(storage)).toEqual(own);
  });
});

describe("the storage", () => {
  it("falls back to the default when the saved value is corrupt", () => {
    for (const raw of ["{not json", "\u0000", "[]", '{"preset":5}']) {
      const loaded = loadKeybindings(memoryStorage({ [KEYBINDINGS_KEY]: raw }));
      expect(loaded).toEqual(DEFAULT_KEYBINDINGS);
      // A corrupt value still resolves to the safe chords.
      expect(commandOf(loaded, press("KeyD", ctrlShift))).toEqual({ kind: "split", dir: "row" });
    }
  });

  it("falls back to the default without a storage or when it throws", () => {
    expect(loadKeybindings(undefined)).toEqual(DEFAULT_KEYBINDINGS);
    const broken: KeybindingsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadKeybindings(broken)).toEqual(DEFAULT_KEYBINDINGS);
    expect(() => saveKeybindings(broken, browser)).not.toThrow();
    expect(() => saveKeybindings(undefined, browser)).not.toThrow();
  });
});

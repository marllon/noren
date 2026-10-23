import { describe, expect, it } from "vitest";
import type { Keybindings } from "./keybindings";
import { DEFAULT_KEYBINDINGS } from "./keybindings";
import { ariaShortcutOf, chordOfAction, denseKeysOf, keycapOf } from "./shortcut-keys";

// The keycap of a shortcut in the glass sidebar (the short form of the design: `Ctrl ⇧ P`), the same
// chord as a value for aria-keyshortcuts, and the chord an action has once the preset and the
// overrides of the person are laid together.

describe("keycapOf", () => {
  it("writes the modifiers first, Shift as its glyph, one space between the keys", () => {
    expect(keycapOf("Ctrl+Shift+KeyP")).toBe("Ctrl ⇧ P");
    expect(keycapOf("Ctrl+Shift+KeyT")).toBe("Ctrl ⇧ T");
  });

  it("reads a letter, a digit and a punctuation key the way a person does", () => {
    expect(keycapOf("Ctrl+KeyT")).toBe("Ctrl T");
    expect(keycapOf("Ctrl+Alt+Digit1")).toBe("Ctrl Alt 1");
    expect(keycapOf("Ctrl+Comma")).toBe("Ctrl ,");
    expect(keycapOf("Alt+Shift+Slash")).toBe("Alt ⇧ /");
  });

  it("keeps a key with no modifier as it is", () => {
    expect(keycapOf("F11")).toBe("F11");
  });
});

describe("ariaShortcutOf", () => {
  it("names the keys the way aria-keyshortcuts does: Control, then the others, joined by a plus", () => {
    expect(ariaShortcutOf("Ctrl+Shift+KeyP")).toBe("Control+Shift+P");
    expect(ariaShortcutOf("Alt+KeyN")).toBe("Alt+N");
    expect(ariaShortcutOf("Ctrl+Alt+Digit1")).toBe("Control+Alt+1");
  });
});

describe("chordOfAction", () => {
  it("is the chord of the preset when the person set nothing", () => {
    expect(chordOfAction(DEFAULT_KEYBINDINGS, "palette.open")).toBe("Ctrl+Shift+KeyP");
    expect(chordOfAction(DEFAULT_KEYBINDINGS, "tab.new")).toBe("Ctrl+Shift+KeyT");
  });

  it("follows the preset: the browser one takes Ctrl+T for a new tab", () => {
    const browser: Keybindings = { preset: "browser", overrides: {} };
    expect(chordOfAction(browser, "tab.new")).toBe("Ctrl+KeyT");
    expect(keycapOf(chordOfAction(browser, "tab.new") ?? "")).toBe("Ctrl T");
  });

  it("is the chord the person set, and nothing when they took the key away", () => {
    const moved: Keybindings = { preset: "safe", overrides: { "palette.open": "Ctrl+Alt+KeyK" } };
    expect(chordOfAction(moved, "palette.open")).toBe("Ctrl+Alt+KeyK");
    const taken: Keybindings = { preset: "safe", overrides: { "palette.open": null } };
    expect(chordOfAction(taken, "palette.open")).toBeUndefined();
  });

  it("is nothing for an action that is not in the registry", () => {
    expect(chordOfAction(DEFAULT_KEYBINDINGS, "no.such.action")).toBeUndefined();
  });
});

describe("denseKeysOf", () => {
  it("writes the chord the way the dense window does: lower case, a plus between the keys, Shift as its glyph", () => {
    expect(denseKeysOf("Ctrl+Shift+KeyP")).toBe("ctrl+⇧+p");
    expect(denseKeysOf("Ctrl+Shift+KeyT")).toBe("ctrl+⇧+t");
    expect(denseKeysOf("Ctrl+Comma")).toBe("ctrl+,");
    expect(denseKeysOf("Ctrl+Alt+Digit1")).toBe("ctrl+alt+1");
  });

  it("keeps a key with no modifier as it is", () => {
    expect(denseKeysOf("F11")).toBe("f11");
  });
});

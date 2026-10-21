import { describe, expect, it } from "vitest";
import { ACTIONS, DEFAULT_KEYBINDINGS, resolveBindings } from "./keybindings";
import type { Keybindings, ShortcutEvent } from "./keybindings";
import {
  changeBinding,
  filterRows,
  formatChord,
  presetShellKeys,
  recordedKey,
  shortcutRows,
} from "./shortcuts-screen";

const press = (code: string, mods: Partial<Omit<ShortcutEvent, "code">> = {}): ShortcutEvent => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

const withOverrides = (
  overrides: Keybindings["overrides"],
  preset: Keybindings["preset"] = "safe",
) => ({ preset, overrides }) satisfies Keybindings;

describe("formatChord", () => {
  it("shows letters, digits and arrows the way a user reads them", () => {
    expect(formatChord("Ctrl+Shift+KeyT")).toBe("Ctrl+Shift+T");
    expect(formatChord("Alt+Digit1")).toBe("Alt+1");
    expect(formatChord("Alt+ArrowLeft")).toBe("Alt+Left");
    expect(formatChord("Ctrl+Backquote")).toBe("Ctrl+`");
    expect(formatChord("Ctrl+F5")).toBe("Ctrl+F5");
  });
});

describe("shortcutRows", () => {
  it("lists every action of the registry with the chord of the preset", () => {
    const rows = shortcutRows(DEFAULT_KEYBINDINGS);
    expect(rows.map((row) => row.id)).toEqual(ACTIONS.map((action) => action.id));
    expect(rows.find((row) => row.id === "tab.new")).toMatchObject({
      title: "New tab",
      category: "Tabs",
      chord: "Ctrl+Shift+KeyT",
      overridden: false,
    });
    const browser = shortcutRows({ preset: "browser", overrides: {} });
    expect(browser.find((row) => row.id === "tab.new")?.chord).toBe("Ctrl+KeyT");
  });

  it("shows the override, and none for an action left without a key", () => {
    const rows = shortcutRows(withOverrides({ "tab.new": "Ctrl+Alt+KeyK", "pane.zoom": null }));
    expect(rows.find((row) => row.id === "tab.new")).toMatchObject({
      chord: "Ctrl+Alt+KeyK",
      presetChord: "Ctrl+Shift+KeyT",
      overridden: true,
    });
    expect(rows.find((row) => row.id === "pane.zoom")).toMatchObject({
      chord: undefined,
      overridden: true,
    });
  });
});

describe("filterRows", () => {
  const rows = shortcutRows(DEFAULT_KEYBINDINGS);
  const ids = (query: string) => filterRows(rows, query).map((row) => row.id);

  it("returns every row for an empty query", () => {
    expect(ids("")).toHaveLength(ACTIONS.length);
    expect(ids("   ")).toHaveLength(ACTIONS.length);
  });

  it("matches the title, ignoring case and spaces", () => {
    expect(ids("split right")).toEqual(["pane.split-right"]);
    expect(ids("SPLITRIGHT")).toEqual(["pane.split-right"]);
  });

  it("matches the category", () => {
    const spaces = ids("spaces");
    expect(spaces).toHaveLength(12);
    expect(spaces.every((id) => id.startsWith("space."))).toBe(true);
  });

  it("matches the chord text however it is typed", () => {
    expect(ids("ctrl+shift+d")).toEqual(["pane.split-right"]);
    expect(ids("Ctrl Shift D")).toEqual(["pane.split-right"]);
    expect(ids("alt+left")).toEqual(["pane.focus-left"]);
  });

  it("finds nothing for text that matches no row", () => {
    expect(ids("nothing like this")).toEqual([]);
  });
});

describe("recordedKey", () => {
  it("turns Ctrl or Alt with a key into its chord", () => {
    expect(recordedKey(press("KeyK", { ctrlKey: true, altKey: true }))).toEqual({
      kind: "chord",
      chord: "Ctrl+Alt+KeyK",
    });
    expect(recordedKey(press("Digit5", { altKey: true }))).toEqual({
      kind: "chord",
      chord: "Alt+Digit5",
    });
  });

  it("ignores a press with no Ctrl or Alt and says why", () => {
    for (const event of [press("KeyK"), press("KeyK", { shiftKey: true }), press("Enter")]) {
      expect(recordedKey(event)).toMatchObject({ kind: "invalid", hint: expect.any(String) });
    }
  });

  it("refuses a press with Meta held", () => {
    expect(recordedKey(press("KeyK", { ctrlKey: true, metaKey: true })).kind).toBe("invalid");
  });

  it("waits while only a modifier key is down", () => {
    expect(recordedKey(press("ControlLeft", { ctrlKey: true }))).toEqual({ kind: "wait" });
    expect(recordedKey(press("ShiftLeft", { shiftKey: true }))).toEqual({ kind: "wait" });
  });

  it("cancels on a bare Escape only", () => {
    expect(recordedKey(press("Escape"))).toEqual({ kind: "cancel" });
    expect(recordedKey(press("Escape", { ctrlKey: true }))).toEqual({
      kind: "chord",
      chord: "Ctrl+Escape",
    });
  });
});

describe("changeBinding", () => {
  it("sets a free chord as an override", () => {
    const result = changeBinding(DEFAULT_KEYBINDINGS, "tab.new", {
      kind: "set",
      chord: "Ctrl+Alt+KeyK",
    });
    expect(result).toEqual({
      ok: true,
      keybindings: { preset: "safe", overrides: { "tab.new": "Ctrl+Alt+KeyK" } },
    });
    if (!result.ok) return;
    const chords = resolveBindings(result.keybindings).chords;
    expect(chords["tab.new"]).toBe("Ctrl+Alt+KeyK");
  });

  it("refuses a chord another action holds, naming it, and changes nothing", () => {
    const before = withOverrides({ "pane.zoom": "Ctrl+Alt+KeyZ" });
    const copy = JSON.stringify(before);
    const result = changeBinding(before, "tab.new", { kind: "set", chord: "Ctrl+Shift+KeyD" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.chord).toBe("Ctrl+Shift+KeyD");
    expect(result.holders.map((holder) => holder.id)).toEqual(["pane.split-right"]);
    expect(JSON.stringify(before)).toBe(copy);
  });

  it("refuses a chord that an override of another action holds, wherever they sit in the registry", () => {
    // Zoom comes after New tab in the registry, so the resolver alone would let New tab steal it.
    const before = withOverrides({ "pane.zoom": "Ctrl+Alt+KeyK" });
    const result = changeBinding(before, "tab.new", { kind: "set", chord: "Ctrl+Alt+KeyK" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.holders.map((holder) => holder.id)).toEqual(["pane.zoom"]);
  });

  it("accepts the chord an action gave up", () => {
    const before = withOverrides({ "pane.split-right": "Ctrl+Alt+KeyR" });
    const result = changeBinding(before, "tab.new", { kind: "set", chord: "Ctrl+Shift+KeyD" });
    expect(result.ok).toBe(true);
  });

  it("drops the override when the chord is the preset's own", () => {
    const before = withOverrides({ "tab.new": "Ctrl+Alt+KeyK" });
    const result = changeBinding(before, "tab.new", { kind: "set", chord: "Ctrl+Shift+KeyT" });
    expect(result).toEqual({ ok: true, keybindings: { preset: "safe", overrides: {} } });
  });

  it("removes a chord as a null override, and resets it back", () => {
    const removed = changeBinding(DEFAULT_KEYBINDINGS, "pane.zoom", { kind: "remove" });
    expect(removed).toEqual({
      ok: true,
      keybindings: { preset: "safe", overrides: { "pane.zoom": null } },
    });
    if (!removed.ok) return;
    expect(resolveBindings(removed.keybindings).chords["pane.zoom"]).toBeUndefined();
    const reset = changeBinding(removed.keybindings, "pane.zoom", { kind: "reset" });
    expect(reset).toEqual({ ok: true, keybindings: { preset: "safe", overrides: {} } });
  });

  it("refuses a reset when another action took the preset chord meanwhile", () => {
    const before = withOverrides({
      "pane.zoom": "Ctrl+Alt+KeyY",
      "tab.new": "Ctrl+Shift+KeyZ",
    });
    const result = changeBinding(before, "pane.zoom", { kind: "reset" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.chord).toBe("Ctrl+Shift+KeyZ");
    expect(result.holders.map((holder) => holder.id)).toEqual(["tab.new"]);
  });

  it("keeps the other overrides and the preset", () => {
    const before = withOverrides({ "pane.zoom": null }, "browser");
    const result = changeBinding(before, "tab.new", { kind: "set", chord: "Ctrl+Alt+KeyK" });
    expect(result).toEqual({
      ok: true,
      keybindings: {
        preset: "browser",
        overrides: { "pane.zoom": null, "tab.new": "Ctrl+Alt+KeyK" },
      },
    });
  });
});

describe("presetShellKeys", () => {
  it("lists the shell keys the browser preset takes, computed from the registry", () => {
    expect(presetShellKeys("browser")).toEqual(["Ctrl+T", "Ctrl+W", "Ctrl+1..9"]);
  });

  it("lists nothing for the safe preset", () => {
    expect(presetShellKeys("safe")).toEqual([]);
  });
});

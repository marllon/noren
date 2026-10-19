import { describe, expect, it } from "vitest";
import type { ShortcutEvent } from "./spaces";
import { splitCommand, typesText } from "./split-keys";

function press(code: string, mods: Partial<Omit<ShortcutEvent, "code">> = {}): ShortcutEvent {
  return { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

const ctrlShift = { ctrlKey: true, shiftKey: true };

describe("splitCommand", () => {
  it("splits right on Ctrl+Shift+D and below on Ctrl+Shift+E", () => {
    expect(splitCommand(press("KeyD", ctrlShift))).toEqual({
      kind: "split",
      dir: "row",
      repeat: false,
    });
    expect(splitCommand(press("KeyE", ctrlShift))).toEqual({
      kind: "split",
      dir: "column",
      repeat: false,
    });
  });

  it("closes the pane on Ctrl+Shift+W and zooms on Ctrl+Shift+Z", () => {
    expect(splitCommand(press("KeyW", ctrlShift))).toEqual({ kind: "close", repeat: false });
    expect(splitCommand(press("KeyZ", ctrlShift))).toEqual({ kind: "zoom", repeat: false });
  });

  it("moves the focus on Alt+arrows", () => {
    expect(splitCommand(press("ArrowLeft", { altKey: true }))).toEqual({
      kind: "focus",
      direction: "left",
      repeat: true,
    });
    expect(splitCommand(press("ArrowDown", { altKey: true }))?.kind).toBe("focus");
  });

  it("resizes on Ctrl+Shift+Alt+arrows", () => {
    expect(splitCommand(press("ArrowRight", { ...ctrlShift, altKey: true }))).toEqual({
      kind: "resize",
      direction: "right",
      repeat: true,
    });
    expect(splitCommand(press("ArrowUp", { ...ctrlShift, altKey: true }))?.kind).toBe("resize");
  });

  it("leaves every other combination to the terminal", () => {
    // Plain keys and the shell's own Ctrl+D, Ctrl+W, Ctrl+Z.
    expect(splitCommand(press("KeyD"))).toBeUndefined();
    expect(splitCommand(press("KeyD", { ctrlKey: true }))).toBeUndefined();
    expect(splitCommand(press("KeyW", { ctrlKey: true }))).toBeUndefined();
    expect(splitCommand(press("KeyZ", { ctrlKey: true }))).toBeUndefined();
    expect(splitCommand(press("KeyD", { shiftKey: true }))).toBeUndefined();
    // The Alt that belongs to Ctrl+Shift+Alt+T and the like.
    expect(splitCommand(press("KeyD", { ...ctrlShift, altKey: true }))).toBeUndefined();
    expect(splitCommand(press("KeyD", { ...ctrlShift, metaKey: true }))).toBeUndefined();
    // Arrows with other modifiers: word jumps and selection in the shell.
    expect(splitCommand(press("ArrowLeft"))).toBeUndefined();
    expect(splitCommand(press("ArrowLeft", { ctrlKey: true }))).toBeUndefined();
    expect(splitCommand(press("ArrowLeft", ctrlShift))).toBeUndefined();
    expect(splitCommand(press("ArrowLeft", { altKey: true, shiftKey: true }))).toBeUndefined();
    expect(splitCommand(press("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeUndefined();
    expect(splitCommand(press("ArrowLeft", { altKey: true, metaKey: true }))).toBeUndefined();
    // Ctrl+Alt+digits is the space shortcut.
    expect(splitCommand(press("Digit1", { ctrlKey: true, altKey: true }))).toBeUndefined();
  });

  it("does not repeat the commands that change the tree", () => {
    for (const code of ["KeyD", "KeyE", "KeyW", "KeyZ"]) {
      expect(splitCommand(press(code, ctrlShift))?.repeat).toBe(false);
    }
  });
});

describe("typesText", () => {
  it("is true for text fields, selects and editable content", () => {
    expect(typesText({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typesText({ tagName: "input" })).toBe(true);
    expect(typesText({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(typesText({ tagName: "SELECT" })).toBe(true);
    expect(typesText({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false for the terminal input, buttons and checkboxes", () => {
    expect(typesText({ tagName: "TEXTAREA" })).toBe(false);
    expect(typesText({ tagName: "BUTTON" })).toBe(false);
    expect(typesText({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(typesText({ tagName: "BODY" })).toBe(false);
    expect(typesText(null)).toBe(false);
  });
});

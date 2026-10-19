import type { ShortcutEvent } from "./spaces";

export type Direction = "left" | "right" | "up" | "down";

/** What a split shortcut asks for. `repeat` is true when holding the key may repeat it. */
export type SplitCommand =
  | { kind: "split"; dir: "row" | "column"; repeat: false }
  | { kind: "close"; repeat: false }
  | { kind: "zoom"; repeat: false }
  | { kind: "focus"; direction: Direction; repeat: true }
  | { kind: "resize"; direction: Direction; repeat: true };

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * The split shortcut a key press stands for, or undefined when the key belongs to the terminal.
 * Keys are read by `code` (Shift and Alt change `key`):
 * Ctrl+Shift+D split right, Ctrl+Shift+E split below, Ctrl+Shift+W close the pane,
 * Ctrl+Shift+Z zoom, Alt+arrows move the focus, Ctrl+Shift+Alt+arrows resize.
 */
export function splitCommand(event: ShortcutEvent): SplitCommand | undefined {
  if (event.metaKey) return undefined;
  const arrow = ARROWS[event.code];
  if (arrow !== undefined) {
    if (event.altKey && !event.ctrlKey && !event.shiftKey) {
      return { kind: "focus", direction: arrow, repeat: true };
    }
    if (event.altKey && event.ctrlKey && event.shiftKey) {
      return { kind: "resize", direction: arrow, repeat: true };
    }
    return undefined;
  }
  if (!event.ctrlKey || !event.shiftKey || event.altKey) return undefined;
  switch (event.code) {
    case "KeyD":
      return { kind: "split", dir: "row", repeat: false };
    case "KeyE":
      return { kind: "split", dir: "column", repeat: false };
    case "KeyW":
      return { kind: "close", repeat: false };
    case "KeyZ":
      return { kind: "zoom", repeat: false };
    default:
      return undefined;
  }
}

/** The slice of an element the check below reads. */
export interface KeyTarget {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range"]);

/**
 * True when the key goes to a field the user is typing in (a rename box, a dialog field), where the
 * split shortcuts must not act. The terminal's own input is not one of them.
 */
export function typesText(target: KeyTarget | null): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === "SELECT") return true;
  return tag === "INPUT" && !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
}

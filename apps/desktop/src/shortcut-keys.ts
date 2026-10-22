import { useMemo } from "react";
import { resolveBindings } from "./keybindings";
import type { Keybindings } from "./keybindings";
import { useKeybindings } from "./keybindings-store";
import { formatChord } from "./shortcuts-screen";

/**
 * A chord as the glass sidebar writes it in the keycap next to a row: `Ctrl+Shift+KeyP` reads
 * `Ctrl ⇧ P` (the modifiers first, Shift as its glyph, a space between the keys). The text of the
 * shortcuts screen and of the palette stays `Ctrl+Shift+P`; this is the short form of the design.
 */
export function keycapOf(chord: string): string {
  return formatChord(chord)
    .split("+")
    .map((key) => (key === "Shift" ? "⇧" : key))
    .join(" ");
}

/** The same chord as the value of aria-keyshortcuts: `Ctrl+Shift+KeyP` is `Control+Shift+P`. */
export function ariaShortcutOf(chord: string): string {
  return formatChord(chord)
    .split("+")
    .map((key) => (key === "Ctrl" ? "Control" : key))
    .join("+");
}

/** The chord an action has under these preferences (preset and overrides laid together), if any. */
export function chordOfAction(keybindings: Keybindings, actionId: string): string | undefined {
  return resolveBindings(keybindings).chords[actionId];
}

/** The chord of an action, kept in step with the shortcuts the person set; `undefined` with no key. */
export function useChord(actionId: string): string | undefined {
  const keybindings = useKeybindings();
  return useMemo(() => chordOfAction(keybindings, actionId), [keybindings, actionId]);
}

/** The keycap of an action; `undefined` when it has no key. */
export function useKeycap(actionId: string): string | undefined {
  const chord = useChord(actionId);
  return chord === undefined ? undefined : keycapOf(chord);
}

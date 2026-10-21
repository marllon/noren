import { useSyncExternalStore } from "react";
import { nextZoom, terminalOptionsOf, zoomedFontSize } from "@noren/model";
import type { TerminalOptions } from "@noren/model";
import { configManager } from "./config-store";

// The options every terminal of the window has: the `terminal` settings in force (config.jsonc),
// with the zoom of the font put over the size. The settings follow the file, so a terminal that is
// already running changes when the file does (`TerminalView` applies them to its xterm without
// starting its session again). The zoom (Ctrl+= / Ctrl+- / Ctrl+0) is only a state of this
// window: it is never written to the file, it is gone when the window closes, and it is a number of
// pixels over the size of the settings, so a size the file changes later still counts.

const listeners = new Set<() => void>();

/** Pixels over `terminal.font.size`; 0 is the size of the settings. */
let zoom = 0;

let view: TerminalOptions | undefined;

function same(a: TerminalOptions, b: TerminalOptions): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.ligatures === b.ligatures &&
    a.cursorStyle === b.cursorStyle &&
    a.cursorBlink === b.cursorBlink &&
    a.scrollback === b.scrollback &&
    a.bell === b.bell &&
    a.screenReaderMode === b.screenReaderMode
  );
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** What the settings say, before the zoom. */
function settingsOptions(): TerminalOptions {
  return terminalOptionsOf(configManager.state.config.terminal);
}

/**
 * The options now. The same object until one of the values changes (a text of the file that leaves
 * the terminal settings alone does not give a new one), which is what lets a view compare by identity.
 */
export function getTerminalOptions(): TerminalOptions {
  const base = settingsOptions();
  const next = zoom === 0 ? base : { ...base, fontSize: zoomedFontSize(base.fontSize, zoom) };
  if (view === undefined || !same(view, next)) view = next;
  return view;
}

/** `onChange` runs when the options may have changed (the file, the zoom). Returns the function that stops it. */
export function subscribeTerminalOptions(onChange: () => void): () => void {
  listeners.add(onChange);
  const stopFollowingConfig = configManager.subscribe(onChange);
  return () => {
    listeners.delete(onChange);
    stopFollowingConfig();
  };
}

/** How the zoom shortcuts change the font size: one step bigger, one step smaller, or back to the settings. */
export type FontZoom = "in" | "out" | "reset";

/**
 * Zooms the font of every terminal of the window. It stops at the smallest and the largest size
 * (`MIN_FONT_SIZE`, `MAX_FONT_SIZE`), and writes nothing: the file keeps the size it has.
 */
export function zoomTerminalFont(change: FontZoom): void {
  const base = settingsOptions().fontSize;
  const next = change === "reset" ? 0 : nextZoom(base, zoom, change === "in" ? 1 : -1);
  if (next === zoom) return;
  zoom = next;
  notify();
}

/** The zoom, in pixels over the size of the settings (0: none). */
export function terminalFontZoom(): number {
  return zoom;
}

/** The options of the terminals; the component renders again when any of them changes. */
export function useTerminalOptions(): TerminalOptions {
  return useSyncExternalStore(subscribeTerminalOptions, getTerminalOptions);
}

/** Forgets the zoom and what was read, so a test starts from nothing. */
export function resetTerminalOptionsStore(): void {
  zoom = 0;
  view = undefined;
}

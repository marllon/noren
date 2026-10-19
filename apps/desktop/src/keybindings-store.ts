import { useSyncExternalStore } from "react";
import { createResolver, loadKeybindings, resolveBindings, saveKeybindings } from "./keybindings";
import type { Keybindings, Resolver, ResolvedBindings } from "./keybindings";

// The shortcut preferences, shared by the layout panel and the keyboard listener. Provisional until
// the settings file (NOR-F8-01) owns them: every change is saved to the browser storage right away.

interface State {
  keybindings: Keybindings;
  resolved: ResolvedBindings;
  resolver: Resolver;
}

const listeners = new Set<() => void>();
let current: State | undefined;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function build(keybindings: Keybindings): State {
  const resolved = resolveBindings(keybindings);
  return { keybindings, resolved, resolver: createResolver(resolved.chords) };
}

function snapshot(): State {
  current ??= build(loadKeybindings(storage()));
  return current;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** Changes some preferences, saves and tells the listeners. */
export function updateKeybindings(patch: Partial<Keybindings>): void {
  const next = build({ ...snapshot().keybindings, ...patch });
  current = next;
  saveKeybindings(storage(), next.keybindings);
  for (const listener of listeners) listener();
}

let recording = false;

/**
 * Tells the keyboard listener that the shortcuts screen is recording a chord: while it is, the
 * listener runs no action, so the chord being pressed is captured and not carried out.
 */
export function setRecording(value: boolean): void {
  recording = value;
}

export function isRecording(): boolean {
  return recording;
}

/** The resolver for the preferences in force right now (the keyboard listener reads it per press). */
export function currentResolver(): Resolver {
  return snapshot().resolver;
}

/** The shortcut preferences; the component renders again when any of them changes. */
export function useKeybindings(): Keybindings {
  return useSyncExternalStore(subscribe, () => snapshot().keybindings);
}

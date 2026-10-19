import { useSyncExternalStore } from "react";
import { configManager } from "./config-store";
import { createResolver, loadKeybindings, resolveBindings, saveKeybindings } from "./keybindings";
import type { Keybindings, Resolver, ResolvedBindings } from "./keybindings";

// The shortcut preferences, shared by the settings screen, the shortcuts screen and the keyboard
// listener. The preset is a setting of the file (`keybindings.preset` in config.jsonc); the user's
// own chords are still provisional and every change of them is saved to the browser storage right
// away.

interface State {
  keybindings: Keybindings;
  resolved: ResolvedBindings;
  resolver: Resolver;
}

const listeners = new Set<() => void>();
let current: State | undefined;
/** The user's own chords, read from the storage the first time they are needed. */
let overrides: Keybindings["overrides"] | undefined;

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
  const config = configManager.state.config;
  overrides ??= loadKeybindings(storage()).overrides;
  const preset = config.keybindings?.preset ?? "safe";
  if (
    current === undefined ||
    current.keybindings.preset !== preset ||
    current.keybindings.overrides !== overrides
  ) {
    current = build({ preset, overrides });
  }
  return current;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const stopFollowingConfig = configManager.subscribe(onChange);
  return () => {
    listeners.delete(onChange);
    stopFollowingConfig();
  };
}

/** Changes the user's own chords, saves them and tells the listeners. */
export function updateKeybindings(patch: Pick<Keybindings, "overrides">): void {
  const { preset } = snapshot().keybindings;
  overrides = patch.overrides;
  current = build({ preset, overrides });
  saveKeybindings(storage(), current.keybindings);
  for (const listener of [...listeners]) listener();
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

/** Forgets what was read, so a test starts from the storage again. */
export function resetKeybindingsStore(): void {
  current = undefined;
  overrides = undefined;
}

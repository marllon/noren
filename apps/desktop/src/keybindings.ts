// Every Noren shortcut: one registry of actions, two presets of chords and one pure resolver that
// says which action (if any) a key press stands for. A key with no action is not ours: the caller
// leaves it alone and it reaches the terminal.
//
// Provisional storage: the browser's `localStorage` under `noren.ui.keybindings`, until the settings
// file of NOR-F8-01 takes over the preset choice and the user's overrides.

import type { Direction } from "@noren/model";

/** Key of the shortcut preferences in the browser storage. */
export const KEYBINDINGS_KEY = "noren.ui.keybindings";

/** The slice of a keyboard event the resolver reads. */
export interface ShortcutEvent {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type Preset = "safe" | "browser";

export const PRESETS: readonly Preset[] = ["safe", "browser"];

export type ActionCategory = "Tabs" | "Panes" | "Spaces";

/** What an action does; the shell turns it into store calls. */
export type ActionCommand =
  | { kind: "new-tab" }
  | { kind: "close" }
  | { kind: "split"; dir: "row" | "column" }
  | { kind: "zoom" }
  | { kind: "focus"; direction: Direction }
  | { kind: "resize"; direction: Direction }
  | { kind: "space"; index: number }
  | { kind: "tab"; index: number };

export interface ActionDef {
  id: string;
  title: string;
  category: ActionCategory;
  command: ActionCommand;
  /** True when holding the key may repeat the action (moving the focus, resizing). */
  repeat: boolean;
  /** The chord in each preset; `undefined` leaves the action without a key there. */
  chords: Readonly<Record<Preset, string | undefined>>;
}

const DIRECTIONS: readonly { direction: Direction; label: string; code: string }[] = [
  { direction: "left", label: "left", code: "ArrowLeft" },
  { direction: "right", label: "right", code: "ArrowRight" },
  { direction: "up", label: "up", code: "ArrowUp" },
  { direction: "down", label: "down", code: "ArrowDown" },
];

const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The registry. Only actions that exist today: later tasks add theirs here. The safe preset keeps
 * the shell's Ctrl+W, Ctrl+T and Ctrl+1..9 for the terminal; the browser preset takes them.
 */
export const ACTIONS: readonly ActionDef[] = [
  {
    id: "tab.new",
    title: "New tab",
    category: "Tabs",
    command: { kind: "new-tab" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyT", browser: "Ctrl+KeyT" },
  },
  {
    id: "pane.close",
    title: "Close pane",
    category: "Panes",
    command: { kind: "close" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyW", browser: "Ctrl+KeyW" },
  },
  {
    id: "pane.split-right",
    title: "Split right",
    category: "Panes",
    command: { kind: "split", dir: "row" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyD", browser: "Ctrl+Shift+KeyD" },
  },
  {
    id: "pane.split-below",
    title: "Split below",
    category: "Panes",
    command: { kind: "split", dir: "column" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyE", browser: "Ctrl+Shift+KeyE" },
  },
  {
    id: "pane.zoom",
    title: "Zoom pane",
    category: "Panes",
    command: { kind: "zoom" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyZ", browser: "Ctrl+Shift+KeyZ" },
  },
  ...DIRECTIONS.map(({ direction, label, code }): ActionDef => ({
    id: `pane.focus-${direction}`,
    title: `Focus pane ${label}`,
    category: "Panes",
    command: { kind: "focus", direction },
    repeat: true,
    chords: { safe: `Alt+${code}`, browser: `Alt+${code}` },
  })),
  ...DIRECTIONS.map(({ direction, label, code }): ActionDef => ({
    id: `pane.resize-${direction}`,
    title: `Resize pane ${label}`,
    category: "Panes",
    command: { kind: "resize", direction },
    repeat: true,
    chords: { safe: `Ctrl+Alt+Shift+${code}`, browser: `Ctrl+Alt+Shift+${code}` },
  })),
  ...DIGITS.map((digit): ActionDef => ({
    id: `space.${digit}`,
    title: `Go to space ${digit}`,
    category: "Spaces",
    command: { kind: "space", index: digit - 1 },
    repeat: false,
    chords: { safe: `Ctrl+Alt+Digit${digit}`, browser: `Ctrl+Alt+Digit${digit}` },
  })),
  ...DIGITS.map((digit): ActionDef => ({
    id: `tab.${digit}`,
    title: `Go to tab ${digit}`,
    category: "Tabs",
    command: { kind: "tab", index: digit - 1 },
    repeat: false,
    chords: { safe: `Alt+Digit${digit}`, browser: `Ctrl+Digit${digit}` },
  })),
];

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OS",
  "AltGraph",
]);

/**
 * The chord a key press makes: modifiers in the fixed order Ctrl, Alt, Shift, then the physical key
 * (`event.code`, which Shift and Alt do not change). `undefined` for a press with Meta held and
 * for a modifier key on its own.
 */
export function chordOf(event: ShortcutEvent): string | undefined {
  if (event.metaKey || event.code === "" || MODIFIER_CODES.has(event.code)) return undefined;
  return [
    event.ctrlKey ? "Ctrl+" : "",
    event.altKey ? "Alt+" : "",
    event.shiftKey ? "Shift+" : "",
    event.code,
  ].join("");
}

/** Modifier names as the chord text spells them: a key cannot be called by one. */
const MODIFIER_NAMES = new Set(["Ctrl", "Alt", "Shift", "Meta"]);

const CHORD_PATTERN = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z][A-Za-z0-9]*)$/;

/**
 * True for a chord the resolver can match: modifiers in the fixed order, a physical key that is not
 * a modifier, and Ctrl or Alt among the modifiers (a bare letter or Shift+letter is typing).
 */
export function isChord(text: string): boolean {
  const match = CHORD_PATTERN.exec(text);
  if (match === null) return false;
  const [, ctrl, alt, , code] = match;
  return (
    (ctrl !== undefined || alt !== undefined) &&
    code !== undefined &&
    !MODIFIER_CODES.has(code) &&
    !MODIFIER_NAMES.has(code)
  );
}

/** The shortcut preferences: the chosen preset and the user's own chords. */
export interface Keybindings {
  preset: Preset;
  /** Action id to chord; `null` leaves the action without a key. Absent: the preset's chord. */
  overrides: Readonly<Record<string, string | null>>;
}

export const DEFAULT_KEYBINDINGS: Keybindings = { preset: "safe", overrides: {} };

const KNOWN_IDS: ReadonlySet<string> = new Set(ACTIONS.map((action) => action.id));

/**
 * Reads the saved preferences. Whatever is missing or invalid (no text, broken JSON, an unknown
 * preset, an override for an unknown action or with a chord that cannot match) falls back to the
 * default for that part.
 */
export function parseKeybindings(raw: string | null): Keybindings {
  if (raw === null) return { ...DEFAULT_KEYBINDINGS };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_KEYBINDINGS };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_KEYBINDINGS };
  }
  const saved = value as Record<string, unknown>;
  const preset = saved["preset"];
  const rawOverrides = saved["overrides"];
  const overrides: Record<string, string | null> = {};
  if (typeof rawOverrides === "object" && rawOverrides !== null && !Array.isArray(rawOverrides)) {
    for (const [id, chord] of Object.entries(rawOverrides)) {
      if (!KNOWN_IDS.has(id)) continue;
      if (chord === null || (typeof chord === "string" && isChord(chord))) overrides[id] = chord;
    }
  }
  return { preset: preset === "safe" || preset === "browser" ? preset : "safe", overrides };
}

export function serializeKeybindings(keybindings: Keybindings): string {
  return JSON.stringify(keybindings);
}

/** The part of the browser storage the shortcuts need (so tests can hand in a plain object). */
export interface KeybindingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved preferences, or the default when there are none, the storage is missing or it throws. */
export function loadKeybindings(storage: KeybindingsStorage | undefined): Keybindings {
  try {
    return parseKeybindings(storage?.getItem(KEYBINDINGS_KEY) ?? null);
  } catch {
    return { ...DEFAULT_KEYBINDINGS };
  }
}

/** Saves the preferences; a storage that refuses (full, blocked) is ignored, they still apply. */
export function saveKeybindings(
  storage: KeybindingsStorage | undefined,
  keybindings: Keybindings,
): void {
  try {
    storage?.setItem(KEYBINDINGS_KEY, serializeKeybindings(keybindings));
  } catch {
    // The preferences only last until the page closes.
  }
}

/** The chord of every action (by id); `undefined` for an action without a key. */
export type ChordMap = Readonly<Record<string, string | undefined>>;

/** A chord bound to more than one action. */
export interface Conflict {
  chord: string;
  actionIds: string[];
}

/** The chords bound to two or more actions in `chords`, in the order of the registry. */
export function findConflicts(chords: ChordMap): Conflict[] {
  const byChord = new Map<string, string[]>();
  for (const action of ACTIONS) {
    const chord = chords[action.id];
    if (chord === undefined) continue;
    byChord.set(chord, [...(byChord.get(chord) ?? []), action.id]);
  }
  return [...byChord]
    .filter(([, ids]) => ids.length > 1)
    .map(([chord, actionIds]) => ({ chord, actionIds }));
}

/** An override that was left out because its chord belongs to another action. */
export interface Rejection {
  actionId: string;
  chord: string;
  /** The actions that keep the chord. */
  keptBy: string[];
}

export interface ResolvedBindings {
  chords: ChordMap;
  rejected: Rejection[];
}

function presetChords(preset: Preset): Record<string, string | undefined> {
  const chords: Record<string, string | undefined> = {};
  for (const action of ACTIONS) chords[action.id] = action.chords[preset];
  return chords;
}

/**
 * The chord of every action once the preset and the overrides are laid together. An override that
 * would bind a chord to two actions is not applied (the action keeps its preset chord) and is
 * reported in `rejected`. Two overrides for the same chord: the first in the registry wins.
 */
export function resolveBindings(keybindings: Keybindings): ResolvedBindings {
  const base = presetChords(keybindings.preset);
  const active = new Map<string, string | null>();
  for (const action of ACTIONS) {
    const override = keybindings.overrides[action.id];
    // An override equal to the preset chord changes nothing: it is not an override.
    if (override !== undefined && override !== base[action.id]) active.set(action.id, override);
  }
  const rejected: Rejection[] = [];
  for (;;) {
    const chords: Record<string, string | undefined> = { ...base };
    for (const [id, chord] of active) chords[id] = chord ?? undefined;
    const conflicts = findConflicts(chords);
    const dropped: string[] = [];
    for (const { chord, actionIds } of conflicts) {
      const overriding = actionIds.filter((id) => active.get(id) === chord);
      // An action that holds the chord without an override owns it; else the first override does.
      const owners = actionIds.filter((id) => !overriding.includes(id));
      const losers = owners.length > 0 ? overriding : overriding.slice(1);
      const keptBy = actionIds.filter((id) => !losers.includes(id));
      for (const id of losers) {
        dropped.push(id);
        rejected.push({ actionId: id, chord, keptBy });
      }
    }
    if (dropped.length === 0) return { chords, rejected };
    for (const id of dropped) active.delete(id);
  }
}

/** What a press resolves to: the action to run, or `undefined` when the key is the terminal's. */
export type Resolver = (event: ShortcutEvent) => ActionDef | undefined;

/** A resolver over a chord map. Chords match `event.code` with exactly the modifiers they name. */
export function createResolver(chords: ChordMap): Resolver {
  const byChord = new Map<string, ActionDef>();
  for (const action of ACTIONS) {
    const chord = chords[action.id];
    if (chord !== undefined && !byChord.has(chord)) byChord.set(chord, action);
  }
  return (event) => {
    const chord = chordOf(event);
    return chord === undefined ? undefined : byChord.get(chord);
  };
}

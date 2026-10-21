// Every Noren shortcut: one registry of actions, two presets of chords and one pure resolver that
// says which action (if any) a key press stands for. A key with no action is not ours: the caller
// leaves it alone and it reaches the terminal.
//
// The choice of preset is a setting of `config.jsonc` (`keybindings.preset`, see `settings-screen.ts`).
// The user's own chords (the overrides) are still provisional: the browser's `localStorage` under
// `noren.ui.keybindings`, until the file gets a place for them.

import type { Direction } from "@noren/model";
import type { LayoutCommand } from "./layout-actions";
import { WIDTH_STEP_LARGE } from "./layout";
import type { FontZoom } from "./terminal-options-store";

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

export type ActionCategory = "General" | "Tabs" | "Panes" | "Spaces" | "Terminal" | "Layout";

/** What an action does; the shell turns it into store calls. */
export type ActionCommand =
  | { kind: "palette" }
  | { kind: "new-tab" }
  | { kind: "reopen-closed" }
  | { kind: "library" }
  | { kind: "agents" }
  | { kind: "agent-waiting" }
  | { kind: "worktree-new" }
  | { kind: "worktree-remove" }
  | { kind: "live-worktrees" }
  | { kind: "live-ssh" }
  | { kind: "live-docker" }
  | { kind: "diff-open" }
  | { kind: "window-move-tab" }
  | { kind: "quick-toggle" }
  | { kind: "ask-toggle" }
  | { kind: "close" }
  | { kind: "split"; dir: "row" | "column" }
  | { kind: "zoom" }
  | { kind: "focus"; direction: Direction }
  | { kind: "resize"; direction: Direction }
  | { kind: "space"; index: number }
  | { kind: "tab"; index: number }
  | { kind: "mru"; delta: 1 | -1 }
  | { kind: "search-all" }
  | { kind: "settings" }
  | { kind: "space-theme" }
  | { kind: "import-scheme" }
  | { kind: "focus-sidebar" }
  | LayoutCommand
  | { kind: "last-unread" }
  | { kind: "prompt"; direction: "previous" | "next" }
  | { kind: "select-output" }
  | { kind: "copy-output" }
  | { kind: "font-zoom"; change: FontZoom };

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

const NO_CHORD = { safe: undefined, browser: undefined } as const;

/**
 * The layout modes. None has a default chord (the settings screen is the place to look; these are
 * for the palette and for a chord the person records). Each writes its own setting into the file.
 */
const LAYOUT_ACTIONS: readonly ActionDef[] = [
  {
    id: "layout.sidebar-side",
    title: "Switch sidebar side",
    category: "Layout",
    command: { kind: "layout", toggle: "side" },
    repeat: false,
    chords: NO_CHORD,
  },
  {
    id: "layout.sidebar-widen",
    title: "Widen sidebar",
    category: "Layout",
    command: { kind: "layout-width", delta: WIDTH_STEP_LARGE },
    repeat: false,
    chords: NO_CHORD,
  },
  {
    id: "layout.sidebar-narrow",
    title: "Narrow sidebar",
    category: "Layout",
    command: { kind: "layout-width", delta: -WIDTH_STEP_LARGE },
    repeat: false,
    chords: NO_CHORD,
  },
  {
    id: "layout.density",
    title: "Switch density",
    category: "Layout",
    command: { kind: "layout", toggle: "density" },
    repeat: false,
    chords: NO_CHORD,
  },
  {
    id: "layout.compact-mode",
    title: "Toggle compact mode",
    category: "Layout",
    command: { kind: "layout", toggle: "compact" },
    repeat: false,
    chords: NO_CHORD,
  },
  {
    id: "layout.keep-sidebar-open",
    title: "Toggle keep sidebar open",
    category: "Layout",
    command: { kind: "layout", toggle: "keepOpen" },
    repeat: false,
    chords: NO_CHORD,
  },
  {
    id: "layout.top-tabs",
    title: "Toggle tabs on top",
    category: "Layout",
    command: { kind: "layout", toggle: "tabs" },
    repeat: false,
    chords: NO_CHORD,
  },
];

/**
 * The registry. Only actions that exist today: later tasks add theirs here. The safe preset keeps
 * the shell's Ctrl+W, Ctrl+T and Ctrl+1..9 for the terminal; the browser preset takes them.
 */
export const ACTIONS: readonly ActionDef[] = [
  {
    id: "palette.open",
    title: "Open palette",
    category: "General",
    command: { kind: "palette" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyP", browser: "Ctrl+Shift+KeyP" },
  },
  {
    id: "tab.new",
    title: "New tab",
    category: "Tabs",
    command: { kind: "new-tab" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyT", browser: "Ctrl+KeyT" },
  },
  {
    id: "tab.reopen-closed",
    title: "Reopen closed tab",
    category: "Tabs",
    command: { kind: "reopen-closed" },
    repeat: false,
    chords: { safe: "Ctrl+Alt+Shift+KeyT", browser: "Ctrl+Shift+KeyT" },
  },
  {
    id: "tab.library",
    title: "Open library",
    category: "Tabs",
    command: { kind: "library" },
    repeat: false,
    chords: { safe: "Ctrl+Alt+Shift+KeyL", browser: "Ctrl+Alt+Shift+KeyL" },
  },
  {
    // The only global one: the Rust side registers it with the system (`quick_shortcut_set`), so it
    // works with any program in front. Here it also answers inside the window, where the system
    // may have refused the key to Noren (another program holds it).
    id: "quick.toggle",
    title: "Show or hide quick terminal",
    category: "General",
    command: { kind: "quick-toggle" },
    repeat: false,
    chords: { safe: "Ctrl+Backquote", browser: "Ctrl+Backquote" },
  },
  {
    // The Ask panel: it opens only where the AI is on (the settings and the space both say so);
    // elsewhere the key says why it does nothing.
    id: "ask.toggle",
    title: "Ask the AI",
    category: "General",
    command: { kind: "ask-toggle" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyA", browser: "Ctrl+Shift+KeyA" },
  },
  {
    id: "tab.mru-next",
    title: "Next recent tab",
    category: "Tabs",
    command: { kind: "mru", delta: 1 },
    repeat: true,
    chords: { safe: "Ctrl+Tab", browser: "Ctrl+Tab" },
  },
  {
    id: "tab.mru-prev",
    title: "Previous recent tab",
    category: "Tabs",
    command: { kind: "mru", delta: -1 },
    repeat: true,
    chords: { safe: "Ctrl+Shift+Tab", browser: "Ctrl+Shift+Tab" },
  },
  {
    id: "tab.last-unread",
    title: "Go to last unread tab",
    category: "Tabs",
    command: { kind: "last-unread" },
    repeat: false,
    chords: { safe: "Ctrl+Shift+KeyU", browser: "Ctrl+Shift+KeyU" },
  },
  {
    id: "tab.search-all",
    title: "Search all tabs",
    category: "Tabs",
    command: { kind: "search-all" },
    repeat: false,
    chords: { safe: "Ctrl+Alt+Shift+KeyF", browser: "Ctrl+Alt+Shift+KeyF" },
  },
  {
    // The Agents panel: the agents of every space with what they do and for how long.
    id: "agents.open",
    title: "Open agents panel",
    category: "General",
    command: { kind: "agents" },
    repeat: false,
    chords: { safe: "Ctrl+Alt+Shift+KeyG", browser: "Ctrl+Alt+Shift+KeyG" },
  },
  {
    // Goes to the agent that has waited for you longest, in any space; with none waiting it only says so.
    id: "agents.focus-waiting",
    title: "Go to the agent waiting for you",
    category: "General",
    command: { kind: "agent-waiting" },
    repeat: false,
    chords: { safe: "Ctrl+Alt+Shift+KeyW", browser: "Ctrl+Alt+Shift+KeyW" },
  },
  {
    // Git worktrees of the repository of the folder on screen; no chord, the palette is the way in.
    id: "worktree.new",
    title: "New worktree",
    category: "General",
    command: { kind: "worktree-new" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "worktree.remove",
    title: "Remove worktree",
    category: "General",
    command: { kind: "worktree-remove" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    // A live group of the worktrees of the repository of the folder on screen (NOR-F17-04b); no chord, the palette is the way in.
    id: "live.worktrees",
    title: "New group of worktrees",
    category: "General",
    command: { kind: "live-worktrees" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    // A live group of the hosts of the ~/.ssh/config (NOR-F17-04c); no chord, the palette is the way in.
    id: "live.ssh",
    title: "New group of SSH hosts",
    category: "General",
    command: { kind: "live-ssh" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    // A live group of the running containers (NOR-F17-04d); no chord, the palette is the way in.
    id: "live.docker",
    title: "New group of running containers",
    category: "General",
    command: { kind: "live-docker" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    // The git diff of the folder of the focused pane, in a pane beside it; no chord, the palette is the way in.
    id: "diff.open",
    title: "Show git diff beside this pane",
    category: "Panes",
    command: { kind: "diff-open" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    // The tab on screen goes to a window of its own, the same way as dragging it out of the window; no chord, the palette is the way in.
    id: "window.move-tab",
    title: "Move tab to new window",
    category: "Tabs",
    command: { kind: "window-move-tab" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "settings.open",
    title: "Open settings",
    category: "General",
    command: { kind: "settings" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "sidebar.focus",
    title: "Focus sidebar",
    category: "General",
    command: { kind: "focus-sidebar" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "themes.import-scheme",
    title: "Import color scheme...",
    category: "General",
    command: { kind: "import-scheme" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "space.set-theme",
    title: "Set theme for this space",
    category: "Spaces",
    command: { kind: "space-theme" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  ...LAYOUT_ACTIONS,
  {
    id: "terminal.prompt-previous",
    title: "Previous prompt",
    category: "Terminal",
    command: { kind: "prompt", direction: "previous" },
    repeat: true,
    chords: { safe: "Ctrl+ArrowUp", browser: "Ctrl+ArrowUp" },
  },
  {
    id: "terminal.prompt-next",
    title: "Next prompt",
    category: "Terminal",
    command: { kind: "prompt", direction: "next" },
    repeat: true,
    chords: { safe: "Ctrl+ArrowDown", browser: "Ctrl+ArrowDown" },
  },
  {
    id: "terminal.select-output",
    title: "Select command output",
    category: "Terminal",
    command: { kind: "select-output" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "terminal.copy-output",
    title: "Copy last command output",
    category: "Terminal",
    command: { kind: "copy-output" },
    repeat: false,
    chords: { safe: undefined, browser: undefined },
  },
  {
    id: "terminal.font-larger",
    title: "Increase font size",
    category: "Terminal",
    command: { kind: "font-zoom", change: "in" },
    repeat: true,
    chords: { safe: "Ctrl+Equal", browser: "Ctrl+Equal" },
  },
  {
    id: "terminal.font-smaller",
    title: "Decrease font size",
    category: "Terminal",
    command: { kind: "font-zoom", change: "out" },
    repeat: true,
    chords: { safe: "Ctrl+Minus", browser: "Ctrl+Minus" },
  },
  {
    id: "terminal.font-reset",
    title: "Reset font size",
    category: "Terminal",
    command: { kind: "font-zoom", change: "reset" },
    repeat: false,
    chords: { safe: "Ctrl+Digit0", browser: "Ctrl+Digit0" },
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
 * default for that part. The preset is only there for text written by earlier builds, which kept
 * it with the overrides: it is moved into the settings file once (`legacy-settings.ts`).
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

/** The text kept in the browser storage: the user's own chords. The preset lives in the file. */
export function serializeKeybindings(keybindings: Keybindings): string {
  return JSON.stringify({ overrides: keybindings.overrides });
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

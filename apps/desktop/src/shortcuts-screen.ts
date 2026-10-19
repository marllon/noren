// The pure parts of the shortcuts screen: the rows it lists, the search over them, what a recorded
// key press may become and the check that refuses a chord another action already holds.

import { t } from "./i18n";
import { actionName, categoryName } from "./i18n/names";
import { ACTIONS, chordOf, findConflicts, isChord, resolveBindings } from "./keybindings";
import type { ActionDef, Keybindings, Preset, ShortcutEvent } from "./keybindings";

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

/** A chord as the screen shows it: `Ctrl+Shift+KeyT` reads `Ctrl+Shift+T`, `Alt+Digit1` reads `Alt+1`. */
export function formatChord(chord: string): string {
  const parts = chord.split("+");
  const code = parts.pop() ?? "";
  const key = KEY_LABELS[code] ?? /^(?:Key|Digit)(.)$/.exec(code)?.[1] ?? code;
  return [...parts, key].join("+");
}

/** One line of the screen: an action and the chord it has right now. */
export interface ShortcutRow {
  id: string;
  title: string;
  category: string;
  /** The chord in force (preset and override laid together); `undefined` for an action without a key. */
  chord: string | undefined;
  /** The chord the current preset gives the action, with no override. */
  presetChord: string | undefined;
  /** True when the user's override is in force for this action. */
  overridden: boolean;
}

/** Every action of the registry with its effective chord, in registry order. */
export function shortcutRows(keybindings: Keybindings): ShortcutRow[] {
  const { chords, rejected } = resolveBindings(keybindings);
  const refused = new Set(rejected.map((rejection) => rejection.actionId));
  return ACTIONS.map((action) => ({
    id: action.id,
    title: actionName(action.id, action.title),
    category: categoryName(action.category),
    chord: chords[action.id],
    presetChord: action.chords[keybindings.preset],
    overridden:
      keybindings.overrides[action.id] !== undefined &&
      keybindings.overrides[action.id] !== action.chords[keybindings.preset] &&
      !refused.has(action.id),
  }));
}

const squash = (text: string): string => text.toLowerCase().replace(/[\s+]/g, "");

/**
 * The rows whose title, category or chord text contains the query. Case, spaces and `+` do not
 * matter, so "ctrl shift t", "Ctrl+Shift+T" and "new tab" all find what they should.
 */
export function filterRows(rows: readonly ShortcutRow[], query: string): ShortcutRow[] {
  const needle = squash(query);
  if (needle === "") return [...rows];
  return rows.filter((row) =>
    [row.title, row.category, row.chord === undefined ? "" : formatChord(row.chord)].some((field) =>
      squash(field).includes(needle),
    ),
  );
}

/** What a recorded key press can be. */
export type RecordedKey =
  | { kind: "chord"; chord: string }
  | { kind: "cancel" }
  /** A modifier key on its own: the user is still building the chord. */
  | { kind: "wait" }
  /** A press that cannot be a shortcut, with the hint to show. */
  | { kind: "invalid"; hint: string };

/** Turns a key press made while recording into a chord, a cancel or a hint. */
export function recordedKey(event: ShortcutEvent): RecordedKey {
  if (
    event.code === "Escape" &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.metaKey
  ) {
    return { kind: "cancel" };
  }
  if (event.metaKey) return { kind: "invalid", hint: t("shortcuts.metaHint") };
  const chord = chordOf(event);
  if (chord === undefined) return { kind: "wait" };
  if (!isChord(chord)) {
    return { kind: "invalid", hint: t("shortcuts.modifierHint") };
  }
  return { kind: "chord", chord };
}

/** What the user asks for an action. */
export type Change =
  | { kind: "set"; chord: string }
  /** Leave the action without a key. */
  | { kind: "remove" }
  /** Back to the chord of the current preset. */
  | { kind: "reset" };

export type ChangeResult =
  { ok: true; keybindings: Keybindings } | { ok: false; chord: string; holders: ActionDef[] };

/**
 * Applies a change to the preferences, or refuses it when the chord it would give the action is
 * held by another action. A refusal changes nothing: the caller keeps the preferences it had.
 */
export function changeBinding(
  keybindings: Keybindings,
  actionId: string,
  change: Change,
): ChangeResult {
  const action = ACTIONS.find((candidate) => candidate.id === actionId);
  if (action === undefined) return { ok: true, keybindings };
  const presetChord = action.chords[keybindings.preset];
  const target =
    change.kind === "set" ? change.chord : change.kind === "reset" ? presetChord : undefined;

  // The override to keep for the action: none when it would equal the preset's own chord.
  const override = target === presetChord ? undefined : (target ?? null);
  const others = Object.entries(keybindings.overrides).filter(([id]) => id !== actionId);
  const overrides = Object.fromEntries(
    override === undefined ? others : [...others, [actionId, override]],
  );
  const next: Keybindings = { ...keybindings, overrides };

  if (target !== undefined) {
    // Lay the action's new chord over what is in force and look for a chord on two actions.
    const candidate = { ...resolveBindings(keybindings).chords, [actionId]: target };
    const clash = findConflicts(candidate).find((conflict) => conflict.chord === target);
    const heldBy = clash?.actionIds.filter((id) => id !== actionId) ?? [];
    if (heldBy.length > 0) {
      return { ok: false, chord: target, holders: ACTIONS.filter((a) => heldBy.includes(a.id)) };
    }
    // The resolver has the last word: if it would still not give the action the chord, refuse.
    const resolved = resolveBindings(next).chords;
    if (resolved[actionId] !== target) {
      return {
        ok: false,
        chord: target,
        holders: ACTIONS.filter((a) => a.id !== actionId && resolved[a.id] === target),
      };
    }
  }
  return { ok: true, keybindings: next };
}

/**
 * The shell keys a preset takes away from the terminal compared with the safe one: the chords the
 * preset gives to an action that the safe preset leaves free. Computed from the registry, in
 * registry order, with a run of digits under the same modifiers shown as `Ctrl+1..9`.
 */
export function presetShellKeys(preset: Preset): string[] {
  const safe = new Set(ACTIONS.map((action) => action.chords["safe"]));
  const keys: { label: string; digits: string[] }[] = [];
  for (const action of ACTIONS) {
    const chord = action.chords[preset];
    if (chord === undefined || safe.has(chord)) continue;
    const digit = /^(.*)\+Digit([0-9])$/.exec(chord);
    if (digit === null) {
      keys.push({ label: formatChord(chord), digits: [] });
      continue;
    }
    const [, modifiers = "", number = ""] = digit;
    const run = keys.find((key) => key.label === modifiers && key.digits.length > 0);
    if (run) run.digits.push(number);
    else keys.push({ label: modifiers, digits: [number] });
  }
  return keys.map(({ label, digits }) =>
    digits.length === 0
      ? label
      : digits.length === 1
        ? `${label}+${digits[0]}`
        : `${label}+${digits[0]}..${digits[digits.length - 1]}`,
  );
}

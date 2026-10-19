import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_WINDOW_EFFECT,
  MAX_BACKGROUND_BLUR,
  MIN_WINDOW_OPACITY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  backgroundImageProblem,
  sameModList,
} from "@noren/model";
import type { Config, ConfigEdit, WindowEffect } from "@noren/model";
import type { Preset } from "./keybindings";
import { DEFAULT_LAYOUT, layoutFromConfig } from "./layout";
import type { Layout } from "./layout";
import { planProfiles, shownProfiles } from "./settings-profiles";
import type { ProfileField, ProfileRow } from "./settings-profiles";
import { planArchive, planTerminal, shownArchive, shownTerminal } from "./settings-sections";
import type {
  ArchiveDraft,
  ArchiveProblems,
  ShownArchive,
  ShownTerminal,
  TerminalDraft,
  TerminalProblems,
} from "./settings-sections";

// The pure part of the settings screen: which setting lives where in `config.jsonc`, the values in
// force (the file over the defaults), and what Save has to write for what the person changed. The
// screen itself (`SettingsDialog.tsx`) only draws this and hands the changes to the file.

/** The settings of the screen. The layout ones are the ones the shell already knows. */
export interface SettingsValues extends Layout {
  /** Which set of shortcuts is in force. */
  preset: Preset;
  /** System notifications on or off. */
  notifications: boolean;
  /** A command that runs longer than this many seconds notifies when it ends out of sight. */
  longCommandSeconds: number;
  /** The effect the system paints behind the window. */
  windowEffect: WindowEffect;
}

export type SettingKey = keyof SettingsValues;

/** The place of each setting in `config.jsonc`, in the order a new setting is written. */
export const SETTING_PATHS: Readonly<Record<SettingKey, readonly string[]>> = {
  side: ["appearance", "sidebar", "position"],
  width: ["appearance", "sidebar", "width"],
  compact: ["appearance", "sidebar", "compact"],
  keepOpen: ["appearance", "sidebar", "keepOpen"],
  density: ["appearance", "density"],
  tabs: ["appearance", "tabs"],
  paneHeaders: ["appearance", "paneHeaders"],
  preset: ["keybindings", "preset"],
  notifications: ["notifications", "enabled"],
  longCommandSeconds: ["notifications", "longCommandSeconds"],
  windowEffect: ["appearance", "window", "effect"],
};

const KEYS = Object.keys(SETTING_PATHS) as SettingKey[];

export const DEFAULT_SETTINGS: SettingsValues = {
  ...DEFAULT_LAYOUT,
  preset: "safe",
  notifications: DEFAULT_NOTIFICATION_SETTINGS.enabled,
  longCommandSeconds: DEFAULT_NOTIFICATION_SETTINGS.longCommandMs / 1000,
  windowEffect: DEFAULT_WINDOW_EFFECT,
};

/** The settings in force: what the file says, and the default for what it does not say. */
export function settingsOf(config: Config): SettingsValues {
  return {
    ...DEFAULT_SETTINGS,
    ...layoutFromConfig(config),
    ...(config.keybindings?.preset !== undefined ? { preset: config.keybindings.preset } : {}),
    ...(config.notifications?.enabled !== undefined
      ? { notifications: config.notifications.enabled }
      : {}),
    ...(config.notifications?.longCommandSeconds !== undefined
      ? { longCommandSeconds: config.notifications.longCommandSeconds }
      : {}),
    ...(config.appearance?.window?.effect !== undefined
      ? { windowEffect: config.appearance.window.effect }
      : {}),
  };
}

/** The settings the file mentions, which the defaults do not stand in for. */
export function settingsSetBy(config: Config): ReadonlySet<SettingKey> {
  const set = new Set<SettingKey>(Object.keys(layoutFromConfig(config)) as SettingKey[]);
  if (config.keybindings?.preset !== undefined) set.add("preset");
  if (config.notifications?.enabled !== undefined) set.add("notifications");
  if (config.notifications?.longCommandSeconds !== undefined) set.add("longCommandSeconds");
  if (config.appearance?.window?.effect !== undefined) set.add("windowEffect");
  return set;
}

/**
 * What the person changed in the screen and has not saved yet. A setting that is not here shows the
 * value in force, so a change of the file by another program still shows through. The two numbers
 * are the text of their boxes, because half a number is a thing a person types on the way.
 */
export type SettingsDraft = Partial<Omit<SettingsValues, "width" | "longCommandSeconds">> & {
  width?: string;
  longCommandSeconds?: string;
  /** The mods that are on for every space, in the order they apply (the file names). */
  mods?: readonly string[];
  /** The Terminal section. */
  terminal?: TerminalDraft;
  /** The Auto-archive section. */
  archive?: ArchiveDraft;
  /** The whole list of profiles as rows, once the person touched it. */
  profiles?: readonly ProfileRow[];
} & Partial<Record<OptionalKey, string>>;

/**
 * The settings that may be left unset, typed in a box (an empty box is "not set"): how opaque the
 * interface is, and the picture behind the terminals with how much of it shows and how blurred it is.
 */
export type OptionalKey =
  "windowOpacity" | "backgroundImage" | "backgroundOpacity" | "backgroundBlur";

/** The place of each optional setting in `config.jsonc`, in the order of the file. */
export const OPTIONAL_PATHS: Readonly<Record<OptionalKey, readonly string[]>> = {
  windowOpacity: ["appearance", "window", "opacity"],
  backgroundImage: ["appearance", "background", "image"],
  backgroundOpacity: ["appearance", "background", "opacity"],
  backgroundBlur: ["appearance", "background", "blur"],
};

const OPTIONAL_KEYS = Object.keys(OPTIONAL_PATHS) as OptionalKey[];

/** What the file holds for an optional setting (`null` for one that is not set). */
function optionalValueOf(config: Config, key: OptionalKey): string | number | null {
  const { window, background } = config.appearance ?? {};
  const value =
    key === "windowOpacity"
      ? window?.opacity
      : key === "backgroundImage"
        ? background?.image
        : key === "backgroundOpacity"
          ? background?.opacity
          : background?.blur;
  return value ?? null;
}

/** The place of the list of global mods in `config.jsonc`. */
export const MODS_PATH: readonly string[] = ["mods"];

/** The two settings typed as numbers. */
export type NumberKey = "width" | "longCommandSeconds";

/** What the boxes and buttons of the screen show: the draft over the settings in force. */
export interface ShownSettings
  extends Omit<SettingsValues, NumberKey>, Record<OptionalKey, string> {
  width: string;
  longCommandSeconds: string;
  mods: readonly string[];
  terminal: ShownTerminal;
  archive: ShownArchive;
  profiles: readonly ProfileRow[];
}

export function shownSettings(config: Config, draft: SettingsDraft): ShownSettings {
  const now = settingsOf(config);
  return {
    ...now,
    ...draft,
    width: draft.width ?? String(now.width),
    longCommandSeconds: draft.longCommandSeconds ?? String(now.longCommandSeconds),
    mods: draft.mods ?? config.mods ?? [],
    terminal: shownTerminal(config, draft.terminal),
    archive: shownArchive(config, draft.archive),
    profiles: shownProfiles(config, draft.profiles),
    ...Object.fromEntries(
      OPTIONAL_KEYS.map((key) => [key, draft[key] ?? String(optionalValueOf(config, key) ?? "")]),
    ),
  } as ShownSettings;
}

/** Whether the compact-mode box can be used: with top tabs the sidebar always hides. */
export function compactAvailable(shown: Pick<ShownSettings, "tabs">): boolean {
  return shown.tabs !== "top";
}

/** Whether the keep-open box can be used: only compact mode has a sidebar to keep open. */
export function keepOpenAvailable(shown: Pick<ShownSettings, "tabs" | "compact">): boolean {
  return shown.compact && shown.tabs !== "top";
}

export const WIDTH_PROBLEM = `Whole pixels, from ${SIDEBAR_MIN_WIDTH} to ${SIDEBAR_MAX_WIDTH}.`;
export const SECONDS_PROBLEM = "A number of seconds, zero or more.";
export const WINDOW_OPACITY_PROBLEM = `A number from ${MIN_WINDOW_OPACITY} to 1, or nothing to let the theme decide.`;
export const BACKGROUND_OPACITY_PROBLEM =
  "A number from 0 to 1, or nothing to let the theme decide.";
export const BACKGROUND_BLUR_PROBLEM = `A number of pixels from 0 to ${MAX_BACKGROUND_BLUR}, or nothing to let the theme decide.`;

/** The width a box holds, or `undefined` when it is not whole pixels in range. */
export function parseWidth(text: string): number | undefined {
  if (!/^\s*\d+\s*$/.test(text)) return undefined;
  const width = Number(text);
  return width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? width : undefined;
}

/** The seconds a box holds, or `undefined` when it is not a number of zero or more. */
export function parseSeconds(text: string): number | undefined {
  if (!/^\s*\d+(\.\d+)?\s*$/.test(text)) return undefined;
  const seconds = Number(text);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** A decimal number in a box, with blanks around: `0.5`, `.5`, `1`. */
function parseDecimal(text: string): number | undefined {
  if (!/^\s*(\d+(\.\d+)?|\.\d+)\s*$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** The opacity of the interface a box holds, from the lowest allowed to 1; `undefined` when it is not one. */
export function parseWindowOpacity(text: string): number | undefined {
  const value = parseDecimal(text);
  return value !== undefined && value >= MIN_WINDOW_OPACITY && value <= 1 ? value : undefined;
}

/** The opacity of the picture a box holds, from 0 to 1; `undefined` when it is not one. */
export function parseBackgroundOpacity(text: string): number | undefined {
  const value = parseDecimal(text);
  return value !== undefined && value <= 1 ? value : undefined;
}

/** The blur of the picture a box holds, in pixels from 0 to the widest; `undefined` when it is not one. */
export function parseBackgroundBlur(text: string): number | undefined {
  const value = parseDecimal(text);
  return value !== undefined && value <= MAX_BACKGROUND_BLUR ? value : undefined;
}

/**
 * What a box of an optional setting holds as a value to write: `null` for an empty box (not set),
 * or the value; `{ problem }` for text that cannot be one.
 */
function optionalFromText(
  key: OptionalKey,
  text: string,
): string | number | null | { problem: string } {
  if (text.trim() === "") return null;
  switch (key) {
    case "windowOpacity":
      return parseWindowOpacity(text) ?? { problem: WINDOW_OPACITY_PROBLEM };
    case "backgroundOpacity":
      return parseBackgroundOpacity(text) ?? { problem: BACKGROUND_OPACITY_PROBLEM };
    case "backgroundBlur":
      return parseBackgroundBlur(text) ?? { problem: BACKGROUND_BLUR_PROBLEM };
    case "backgroundImage": {
      const problem = backgroundImageProblem(text);
      return problem === undefined ? text : { problem };
    }
  }
}

/** What Save would do: the settings to write, and the boxes whose text is not a usable value. */
export interface SavePlan {
  changes: ConfigEdit[];
  problems: Partial<Record<NumberKey | OptionalKey, string>>;
  /** The problems of the Terminal section, by setting. */
  terminalProblems: TerminalProblems;
  /** The problems of the Auto-archive section, by setting. */
  archiveProblems: ArchiveProblems;
  /** The problems of the Profiles section, by the key of the row and the box. */
  profileProblems: Record<string, Partial<Record<ProfileField, string>>>;
}

/** Whether any box of the draft holds a value that cannot be written. */
export function hasProblems(plan: SavePlan): boolean {
  return (
    Object.keys(plan.problems).length > 0 ||
    Object.keys(plan.terminalProblems).length > 0 ||
    Object.keys(plan.archiveProblems).length > 0 ||
    Object.keys(plan.profileProblems).length > 0
  );
}

/** What `planSave` needs to know besides the file and the draft. */
export interface PlanContext {
  /** The ids of the shells of the machine, which a new profile cannot take. */
  takenProfileIds?: Iterable<string>;
}

/**
 * The changes to write for a draft: only the settings whose value is not the one in force, in the
 * order of the file, so a setting put back where it was is not written. A box with a value that
 * cannot be used is a problem and writes nothing.
 */
export function planSave(
  config: Config,
  draft: SettingsDraft,
  context: PlanContext = {},
): SavePlan {
  const now = settingsOf(config);
  const problems: SavePlan["problems"] = {};
  const wanted: Partial<SettingsValues> = {};
  for (const key of KEYS) {
    const value = draft[key];
    if (value === undefined) continue;
    if (key === "width") {
      const width = parseWidth(String(value));
      if (width === undefined) problems.width = WIDTH_PROBLEM;
      else wanted.width = width;
    } else if (key === "longCommandSeconds") {
      const seconds = parseSeconds(String(value));
      if (seconds === undefined) problems.longCommandSeconds = SECONDS_PROBLEM;
      else wanted.longCommandSeconds = seconds;
    } else {
      (wanted as Record<string, unknown>)[key] = value;
    }
  }
  const changes: ConfigEdit[] = [];
  for (const key of KEYS) {
    const value = wanted[key];
    if (value === undefined || value === now[key]) continue;
    changes.push({ path: SETTING_PATHS[key], value });
  }
  // The optional settings: an empty box is "not set", written as null only where the file has a value.
  for (const key of OPTIONAL_KEYS) {
    const text = draft[key];
    if (text === undefined) continue;
    const wanted = optionalFromText(key, text);
    if (typeof wanted === "object" && wanted !== null) {
      problems[key] = wanted.problem;
    } else if (wanted !== optionalValueOf(config, key)) {
      changes.push({ path: OPTIONAL_PATHS[key], value: wanted });
    }
  }
  // The list of mods is written whole, and only when it is not the one in force.
  if (draft.mods !== undefined && !sameModList(draft.mods, config.mods ?? [])) {
    changes.push({ path: MODS_PATH, value: draft.mods });
  }
  // The sections with their own plans, in the order of the file: terminal, profiles, archive.
  const terminal = planTerminal(config, draft.terminal);
  const profiles = planProfiles(config, draft.profiles, context.takenProfileIds);
  const archive = planArchive(config, draft.archive);
  changes.push(...terminal.changes, ...profiles.changes, ...archive.changes);
  return {
    changes,
    problems,
    terminalProblems: terminal.problems,
    archiveProblems: archive.problems,
    profileProblems: profiles.problems,
  };
}

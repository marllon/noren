import { DEFAULT_NOTIFICATION_SETTINGS, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@noren/model";
import type { Config, ConfigChange } from "@noren/model";
import type { Preset } from "./keybindings";
import { DEFAULT_LAYOUT, layoutFromConfig } from "./layout";
import type { Layout } from "./layout";

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
};

const KEYS = Object.keys(SETTING_PATHS) as SettingKey[];

export const DEFAULT_SETTINGS: SettingsValues = {
  ...DEFAULT_LAYOUT,
  preset: "safe",
  notifications: DEFAULT_NOTIFICATION_SETTINGS.enabled,
  longCommandSeconds: DEFAULT_NOTIFICATION_SETTINGS.longCommandMs / 1000,
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
  };
}

/** The settings the file mentions, which the defaults do not stand in for. */
export function settingsSetBy(config: Config): ReadonlySet<SettingKey> {
  const set = new Set<SettingKey>(Object.keys(layoutFromConfig(config)) as SettingKey[]);
  if (config.keybindings?.preset !== undefined) set.add("preset");
  if (config.notifications?.enabled !== undefined) set.add("notifications");
  if (config.notifications?.longCommandSeconds !== undefined) set.add("longCommandSeconds");
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
};

/** The two settings typed as numbers. */
export type NumberKey = "width" | "longCommandSeconds";

/** What the boxes and buttons of the screen show: the draft over the settings in force. */
export interface ShownSettings extends Omit<SettingsValues, NumberKey> {
  width: string;
  longCommandSeconds: string;
}

export function shownSettings(config: Config, draft: SettingsDraft): ShownSettings {
  const now = settingsOf(config);
  return {
    ...now,
    ...draft,
    width: draft.width ?? String(now.width),
    longCommandSeconds: draft.longCommandSeconds ?? String(now.longCommandSeconds),
  };
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

/** What Save would do: the settings to write, and the boxes whose text is not a usable value. */
export interface SavePlan {
  changes: ConfigChange[];
  problems: Partial<Record<NumberKey, string>>;
}

/**
 * The changes to write for a draft: only the settings whose value is not the one in force, in the
 * order of the file, so a setting put back where it was is not written. A box with a value that
 * cannot be used is a problem and writes nothing.
 */
export function planSave(config: Config, draft: SettingsDraft): SavePlan {
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
  const changes: ConfigChange[] = [];
  for (const key of KEYS) {
    const value = wanted[key];
    if (value === undefined || value === now[key]) continue;
    changes.push({ path: SETTING_PATHS[key], value });
  }
  return { changes, problems };
}

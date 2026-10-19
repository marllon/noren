import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import type { Config, ConfigChange, ConfigManager, NotificationSettings } from "@noren/model";
import { KEYBINDINGS_KEY, parseKeybindings, serializeKeybindings } from "./keybindings";
import { LAYOUT_KEY, parseLayout } from "./layout";
import { DEFAULT_SETTINGS, SETTING_PATHS, settingsSetBy } from "./settings-screen";
import type { SettingKey, SettingsValues } from "./settings-screen";

// Before the settings screen, the layout, the notification settings and the shortcut preset lived
// in the browser storage (`noren.ui.layout`, `noren.ui.notifications` and the `preset` of
// `noren.ui.keybindings`). They are in `config.jsonc` now, and the storage is no longer read for
// them. What a person had chosen is moved into the file once, at the first start after the
// upgrade, and the old keys are removed; the user's own shortcuts (`overrides`) stay in the
// storage until they get a place in the file.

/** Key of the notification settings in the browser storage, as earlier builds kept them. */
export const NOTIFICATION_SETTINGS_KEY = "noren.ui.notifications";

/** The raw text of each key of the old storage, `null` when it is not there. */
export interface LegacyStorage {
  layout: string | null;
  notifications: string | null;
  keybindings: string | null;
}

/** What the part of the browser storage the migration needs looks like (so tests can hand in a map). */
export type LegacyStorageArea = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Reads the old notification settings. Anything missing or of the wrong shape falls back to the
 * default for that field, and nothing is thrown.
 */
export function parseNotificationSettings(raw: string | null): NotificationSettings {
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  if (raw === null) return settings;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return settings;
  const { enabled, longCommandSeconds } = value as Record<string, unknown>;
  if (typeof enabled === "boolean") settings.enabled = enabled;
  if (
    typeof longCommandSeconds === "number" &&
    Number.isFinite(longCommandSeconds) &&
    longCommandSeconds >= 0
  ) {
    settings.longCommandMs = Math.round(longCommandSeconds * 1000);
  }
  return settings;
}

const LAYOUT_KEYS: readonly SettingKey[] = [
  "side",
  "width",
  "compact",
  "keepOpen",
  "density",
  "tabs",
  "paneHeaders",
];

/** The settings the old storage held that are not the default: those are the ones a person chose. */
export function legacyValues(stored: LegacyStorage): Partial<SettingsValues> {
  const chosen: Record<string, unknown> = {};
  if (stored.layout !== null) {
    const layout = parseLayout(stored.layout) as unknown as Record<string, unknown>;
    for (const key of LAYOUT_KEYS) {
      if (layout[key] !== DEFAULT_SETTINGS[key]) chosen[key] = layout[key];
    }
  }
  if (stored.notifications !== null) {
    const notifications = parseNotificationSettings(stored.notifications);
    if (notifications.enabled !== DEFAULT_SETTINGS.notifications) {
      chosen["notifications"] = notifications.enabled;
    }
    const seconds = notifications.longCommandMs / 1000;
    if (seconds !== DEFAULT_SETTINGS.longCommandSeconds) chosen["longCommandSeconds"] = seconds;
  }
  if (stored.keybindings !== null) {
    const { preset } = parseKeybindings(stored.keybindings);
    if (preset !== DEFAULT_SETTINGS.preset) chosen["preset"] = preset;
  }
  return chosen as Partial<SettingsValues>;
}

/**
 * The changes that move the old choices into the file: each one a person made, except the ones the
 * file already sets (the file wins), in the order of the file.
 */
export function legacyChanges(stored: LegacyStorage, config: Config): ConfigChange[] {
  const chosen = legacyValues(stored) as Record<string, string | number | boolean>;
  const inFile = settingsSetBy(config);
  const changes: ConfigChange[] = [];
  for (const key of Object.keys(SETTING_PATHS) as SettingKey[]) {
    const value = chosen[key];
    if (value !== undefined && !inFile.has(key)) {
      changes.push({ path: SETTING_PATHS[key], value });
    }
  }
  return changes;
}

/** Whether the stored shortcuts still hold a preset, which the file owns now. */
function holdsPreset(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && "preset" in value;
  } catch {
    return false;
  }
}

function read(storage: LegacyStorageArea, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * `moved`: the old choices are in the file (or there was nothing to move) and the old keys are
 * gone. `nothing`: there was no old key. `postponed`: the file has a problem or could not be
 * written, so the old keys stay for the next start.
 */
export type MigrationOutcome = "nothing" | "moved" | "postponed";

/**
 * Moves what the old storage holds into the file, once. Nothing is written for a choice that is
 * the default, nor for a setting the file already has; the old keys are removed only after the
 * file took the rest, so a failure loses nothing and is tried again at the next start.
 */
export async function migrateLegacySettings(
  storage: LegacyStorageArea | undefined,
  manager: Pick<ConfigManager, "state" | "update">,
): Promise<MigrationOutcome> {
  if (storage === undefined) return "nothing";
  const stored: LegacyStorage = {
    layout: read(storage, LAYOUT_KEY),
    notifications: read(storage, NOTIFICATION_SETTINGS_KEY),
    keybindings: read(storage, KEYBINDINGS_KEY),
  };
  const hasPreset = holdsPreset(stored.keybindings);
  if (stored.layout === null && stored.notifications === null && !hasPreset) return "nothing";

  // A file that does not parse cannot be edited, and a failed move must not lose the old choices.
  if (manager.state.errors.length > 0) return "postponed";
  const changes = legacyChanges(stored, manager.state.config);
  if (changes.length > 0) {
    const result = await manager.update(changes);
    if (!result.ok) return "postponed";
  }
  try {
    storage.removeItem(LAYOUT_KEY);
    storage.removeItem(NOTIFICATION_SETTINGS_KEY);
    if (hasPreset) {
      const { overrides } = parseKeybindings(stored.keybindings);
      if (Object.keys(overrides).length === 0) storage.removeItem(KEYBINDINGS_KEY);
      else storage.setItem(KEYBINDINGS_KEY, serializeKeybindings({ preset: "safe", overrides }));
    }
  } catch {
    // The storage is blocked: the next start finds the keys and moves nothing new (the file wins).
  }
  return "moved";
}

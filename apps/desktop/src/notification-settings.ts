// The settings of the system notifications. The settings file (`notifications` in config.jsonc)
// decides every setting it mentions. The rest stays with the provisional storage, as before: the
// browser's `localStorage` under `noren.ui.notifications`, with JSON such as `{"enabled":false}` or
// `{"longCommandSeconds":60}`, until the settings screen of NOR-F8-01b replaces it.

import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import type { Config, NotificationSettings } from "@noren/model";
import { configManager } from "./config-store";

/** Key of the notification settings in the browser storage. */
export const NOTIFICATION_SETTINGS_KEY = "noren.ui.notifications";

/**
 * Reads the saved settings. Anything missing or of the wrong shape falls back to the default for
 * that field, and nothing is thrown: a hand-edited value never silences or floods the user.
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

/** `settings` with what the settings file says about the notifications put over it. */
export function applyConfigNotifications(
  settings: NotificationSettings,
  config: Config,
): NotificationSettings {
  const section = config.notifications;
  if (section === undefined) return settings;
  const { enabled, longCommandSeconds } = section;
  return {
    enabled: enabled ?? settings.enabled,
    longCommandMs:
      longCommandSeconds !== undefined
        ? Math.round(longCommandSeconds * 1000)
        : settings.longCommandMs,
  };
}

/** The settings now. Read at every event, so a change of the file or of the storage applies at once. */
export function notificationSettings(): NotificationSettings {
  let stored: NotificationSettings;
  try {
    stored = parseNotificationSettings(window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY));
  } catch {
    stored = { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  return applyConfigNotifications(stored, configManager.state.config);
}

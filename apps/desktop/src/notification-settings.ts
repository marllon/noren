// The settings of the system notifications. Provisional, like the layout: the browser's
// `localStorage` under `noren.ui.notifications`, until the settings file of NOR-F8-01 owns them.
// There is no screen for them yet; the value is JSON such as `{"enabled":false}` or
// `{"longCommandSeconds":60}`.

import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import type { NotificationSettings } from "@noren/model";

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

/** The settings now. Read at every event, so a change applies at once. */
export function notificationSettings(): NotificationSettings {
  try {
    return parseNotificationSettings(window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

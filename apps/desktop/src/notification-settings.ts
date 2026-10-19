// The settings of the system notifications. They are settings of the file (`notifications` in
// config.jsonc), which the settings screen writes: this module reads them from the settings in
// force. The browser storage (`noren.ui.notifications`) held them before that; what it held is
// moved into the file once (`legacy-settings.ts`).

import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import type { Config, NotificationSettings } from "@noren/model";
import { configManager } from "./config-store";

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

/** The settings now. Read at every event, so a change of the file applies at once. */
export function notificationSettings(): NotificationSettings {
  return applyConfigNotifications({ ...DEFAULT_NOTIFICATION_SETTINGS }, configManager.state.config);
}

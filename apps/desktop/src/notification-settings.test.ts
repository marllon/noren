import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import { configManager } from "./config-store";
import { applyConfigNotifications, notificationSettings } from "./notification-settings";

describe("applyConfigNotifications", () => {
  const base = { enabled: true, longCommandMs: 45_000 };

  it("leaves the settings as they are when the file says nothing about notifications", () => {
    expect(applyConfigNotifications(base, {})).toBe(base);
    expect(applyConfigNotifications(base, { notifications: {} })).toEqual(base);
  });

  it("puts what the file says over the settings, a setting at a time", () => {
    expect(applyConfigNotifications(base, { notifications: { enabled: false } })).toEqual({
      enabled: false,
      longCommandMs: 45_000,
    });
    expect(applyConfigNotifications(base, { notifications: { longCommandSeconds: 12.5 } })).toEqual(
      { enabled: true, longCommandMs: 12_500 },
    );
    expect(
      applyConfigNotifications(base, {
        notifications: { enabled: false, longCommandSeconds: 0 },
      }),
    ).toEqual({ enabled: false, longCommandMs: 0 });
  });
});

describe("notificationSettings", () => {
  beforeEach(() => {
    configManager.stop();
    configManager.apply(null);
  });

  it("is on with a limit of 30 s with no file", () => {
    expect(notificationSettings()).toEqual({ enabled: true, longCommandMs: 30_000 });
    expect(notificationSettings()).not.toBe(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("is what the file says for the settings it mentions, the default for the others", () => {
    configManager.apply('{ "notifications": { "longCommandSeconds": 10 } }');
    expect(notificationSettings()).toEqual({ enabled: true, longCommandMs: 10_000 });
  });

  it("follows the file at the next event, and keeps the last valid settings when it turns invalid", () => {
    configManager.apply('{ "notifications": { "enabled": false } }');
    expect(notificationSettings().enabled).toBe(false);
    configManager.apply('{ "notifications": { "enabled": "off" } }');
    expect(notificationSettings().enabled).toBe(false);
    configManager.apply('{ "notifications": { "enabled": true } }');
    expect(notificationSettings().enabled).toBe(true);
    configManager.apply(null);
    expect(notificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("does not need the browser storage", () => {
    expect(() => notificationSettings()).not.toThrow();
  });
});

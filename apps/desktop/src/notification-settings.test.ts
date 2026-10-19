import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import { configManager } from "./config-store";
import {
  NOTIFICATION_SETTINGS_KEY,
  applyConfigNotifications,
  notificationSettings,
  parseNotificationSettings,
} from "./notification-settings";

describe("parseNotificationSettings", () => {
  it("is on with a limit of 30 s when nothing is saved", () => {
    expect(parseNotificationSettings(null)).toEqual({ enabled: true, longCommandMs: 30_000 });
    expect(parseNotificationSettings(null)).not.toBe(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("reads the switch and the limit in seconds", () => {
    expect(parseNotificationSettings('{"enabled":false}')).toEqual({
      enabled: false,
      longCommandMs: 30_000,
    });
    expect(parseNotificationSettings('{"longCommandSeconds":60.5}')).toEqual({
      enabled: true,
      longCommandMs: 60_500,
    });
    expect(parseNotificationSettings('{"longCommandSeconds":0}').longCommandMs).toBe(0);
  });

  it("keeps the default of every field that is not usable", () => {
    for (const raw of [
      "",
      "not json",
      "[]",
      "7",
      "null",
      '{"enabled":"no","longCommandSeconds":"60"}',
      '{"longCommandSeconds":-1}',
      '{"longCommandSeconds":null}',
    ]) {
      expect(parseNotificationSettings(raw), raw).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    }
  });
});

describe("applyConfigNotifications", () => {
  const stored = { enabled: true, longCommandMs: 45_000 };

  it("leaves the settings as they are when the file says nothing about notifications", () => {
    expect(applyConfigNotifications(stored, {})).toBe(stored);
    expect(applyConfigNotifications(stored, { notifications: {} })).toEqual(stored);
  });

  it("puts what the file says over the settings, a setting at a time", () => {
    expect(applyConfigNotifications(stored, { notifications: { enabled: false } })).toEqual({
      enabled: false,
      longCommandMs: 45_000,
    });
    expect(
      applyConfigNotifications(stored, { notifications: { longCommandSeconds: 12.5 } }),
    ).toEqual({ enabled: true, longCommandMs: 12_500 });
    expect(
      applyConfigNotifications(stored, {
        notifications: { enabled: false, longCommandSeconds: 0 },
      }),
    ).toEqual({ enabled: false, longCommandMs: 0 });
  });
});

describe("notificationSettings", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => values.get(key) ?? null },
    });
    configManager.stop();
    configManager.apply(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the default with no storage and no file", () => {
    expect(notificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("is the stored choice for what the file does not mention", () => {
    values.set(NOTIFICATION_SETTINGS_KEY, '{"enabled":false,"longCommandSeconds":90}');
    configManager.apply('{ "notifications": { "longCommandSeconds": 10 } }');
    expect(notificationSettings()).toEqual({ enabled: false, longCommandMs: 10_000 });
  });

  it("follows the file at the next event, and falls back to the stored choice when it is invalid", () => {
    configManager.apply('{ "notifications": { "enabled": false } }');
    expect(notificationSettings().enabled).toBe(false);
    configManager.apply('{ "notifications": { "enabled": "off" } }');
    expect(notificationSettings().enabled).toBe(false);
    configManager.apply('{ "notifications": { "enabled": true } }');
    expect(notificationSettings().enabled).toBe(true);
    configManager.apply(null);
    expect(notificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it("does not fail when the browser storage is out of reach", () => {
    vi.unstubAllGlobals();
    expect(notificationSettings()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });
});

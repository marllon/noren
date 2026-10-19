import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@noren/model";
import { parseNotificationSettings } from "./notification-settings";

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

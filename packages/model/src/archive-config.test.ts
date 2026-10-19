import { describe, expect, it } from "vitest";
import { archiveSettingsOf, configJsonSchema, parseConfigText } from "./index";

// The auto-archive settings: `archive` in config.jsonc.

function archiveOf(text: string) {
  const result = parseConfigText(text);
  if (!result.ok) throw new Error(`expected a valid file: ${JSON.stringify(result.errors)}`);
  return result.config.archive;
}

describe("archive in config.jsonc", () => {
  it("is on, after 12 hours, when the file says nothing", () => {
    expect(archiveSettingsOf(archiveOf("{}"))).toEqual({ enabled: true, afterMs: 12 * 3_600_000 });
    expect(archiveSettingsOf(archiveOf('{ "archive": {} }'))).toEqual({
      enabled: true,
      afterMs: 12 * 3_600_000,
    });
  });

  it("takes enabled and afterHours, a fraction too", () => {
    const section = archiveOf('{ "archive": { "enabled": false, "afterHours": 0.25 } }');
    expect(section).toEqual({ enabled: false, afterHours: 0.25 });
    expect(archiveSettingsOf(section)).toEqual({ enabled: false, afterMs: 900_000 });
  });

  it("refuses an afterHours that is not above zero, with the line", () => {
    for (const value of ["0", "-3", '"12"', "null", "true", "[]"]) {
      const text = `{
  "archive": {
    "afterHours": ${value}
  }
}`;
      const result = parseConfigText(text);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("archive.afterHours");
      expect(result.errors[0]?.line, value).toBe(3);
    }
  });

  it("refuses an enabled that is not true or false, and a setting it does not know", () => {
    for (const value of ['"yes"', "0", "1", "null"]) {
      const result = parseConfigText(`{ "archive": { "enabled": ${value} } }`);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.errors[0]?.path, value).toBe("archive.enabled");
    }
    const unknown = parseConfigText('{ "archive": { "afterDays": 2 } }');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]?.message).toBe('Unknown setting "afterDays"');
  });

  it("is in the JSON schema with its defaults and words a person can read", () => {
    const schema = configJsonSchema() as {
      properties: {
        archive: {
          additionalProperties: boolean;
          properties: { enabled: Record<string, unknown>; afterHours: Record<string, unknown> };
        };
      };
    };
    const { archive } = schema.properties;
    expect(archive.additionalProperties).toBe(false);
    expect(archive.properties.enabled["type"]).toBe("boolean");
    expect(archive.properties.enabled["default"]).toBe(true);
    expect(archive.properties.afterHours["type"]).toBe("number");
    expect(archive.properties.afterHours["default"]).toBe(12);
    expect(archive.properties.afterHours["exclusiveMinimum"]).toBe(0);
    expect(String(archive.properties.afterHours["description"])).toContain("fraction");
  });
});

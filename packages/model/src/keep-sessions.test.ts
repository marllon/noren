import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEEP_SESSIONS,
  configJsonSchema,
  keepSessionsAllowed,
  parseConfigText,
} from "./index";

// The switch for keeping the shells of the panes alive when the window closes: `sessions.keepOnClose`
// in config.jsonc, on by default.

function sessionsOf(text: string) {
  const result = parseConfigText(text);
  if (!result.ok) throw new Error(`expected a valid file: ${JSON.stringify(result.errors)}`);
  return result.config.sessions;
}

describe("sessions.keepOnClose", () => {
  it("is on by default, and says so", () => {
    expect(DEFAULT_KEEP_SESSIONS).toBe(true);
    expect(keepSessionsAllowed(undefined)).toBe(true);
  });

  it("is on when the file says nothing about it", () => {
    expect(keepSessionsAllowed(sessionsOf("{}"))).toBe(true);
    expect(keepSessionsAllowed(sessionsOf('{ "sessions": {} }'))).toBe(true);
    expect(keepSessionsAllowed(sessionsOf('{ "terminal": { "scrollback": 500 } }'))).toBe(true);
  });

  it("is on when the file says so, and off when the file says false", () => {
    expect(keepSessionsAllowed(sessionsOf('{ "sessions": { "keepOnClose": true } }'))).toBe(true);
    expect(keepSessionsAllowed(sessionsOf('{ "sessions": { "keepOnClose": false } }'))).toBe(false);
  });

  it("refuses a value that is not true or false, with the line and the place", () => {
    for (const value of ['"no"', "0", "1", "null", '"false"', "[]"]) {
      const result = parseConfigText(`{
  "sessions": {
    "keepOnClose": ${value}
  }
}`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("sessions.keepOnClose");
      expect(result.errors[0]?.line, value).toBe(3);
    }
  });

  it("refuses a setting the section does not have", () => {
    const result = parseConfigText('{ "sessions": { "keepOnClosed": true } }');
    expect(result.ok).toBe(false);
  });

  it("is in the JSON schema with its default and a description a person can read", () => {
    const schema = configJsonSchema() as {
      properties: {
        sessions: {
          additionalProperties: boolean;
          required?: string[];
          properties: { keepOnClose: Record<string, unknown> };
        };
      };
    };
    expect(schema.properties.sessions.additionalProperties).toBe(false);
    expect(schema.properties.sessions.required ?? []).toEqual([]);
    const entry = schema.properties.sessions.properties.keepOnClose;
    expect(entry).toMatchObject({ type: "boolean", default: true });
    const description = String(entry["description"]);
    for (const word of ["closing the window", "shell", "pane", "norend"]) {
      expect(description, word).toContain(word);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  DEFAULT_SCREEN_READER_MODE,
  DEFAULT_TERMINAL_OPTIONS,
  configJsonSchema,
  editConfigText,
  parseConfigText,
  terminalOptionsOf,
} from "./index";

// `terminal.screenReaderMode` of config.jsonc: off by default, a boolean, and handed to the terminal.

describe("terminal.screenReaderMode", () => {
  it("is off when the file says nothing", () => {
    expect(DEFAULT_SCREEN_READER_MODE).toBe(false);
    expect(DEFAULT_TERMINAL_OPTIONS.screenReaderMode).toBe(false);
    expect(terminalOptionsOf(undefined).screenReaderMode).toBe(false);
    expect(terminalOptionsOf({ scrollback: 100 }).screenReaderMode).toBe(false);
  });

  it("is on when the file turns it on, and off when it turns it off", () => {
    const on = parseConfigText('{ "terminal": { "screenReaderMode": true } }');
    if (!on.ok) throw new Error("valid");
    expect(terminalOptionsOf(on.config.terminal).screenReaderMode).toBe(true);
    const off = parseConfigText('{ "terminal": { "screenReaderMode": false } }');
    if (!off.ok) throw new Error("valid");
    expect(terminalOptionsOf(off.config.terminal).screenReaderMode).toBe(false);
  });

  it("changes nothing else of the options", () => {
    const options = terminalOptionsOf({ screenReaderMode: true });
    expect({ ...options, screenReaderMode: false }).toEqual(DEFAULT_TERMINAL_OPTIONS);
  });

  it("refuses a value that is not a boolean, naming the setting", () => {
    for (const value of ['"yes"', "1", "null", "{}"]) {
      const result = parseConfigText(`{ "terminal": { "screenReaderMode": ${value} } }`);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path).toBe("terminal.screenReaderMode");
    }
    expect(ConfigSchema.safeParse({ terminal: { screenReaderMode: true } }).success).toBe(true);
  });

  it("is in the JSON Schema with its description and its default", () => {
    const schema = configJsonSchema() as {
      properties: {
        terminal: { properties: Record<string, { default?: unknown; description?: string }> };
      };
    };
    const entry = schema.properties.terminal.properties["screenReaderMode"];
    expect(entry?.default).toBe(false);
    expect(entry?.description).toContain("screen reader");
  });

  it("is written into the file at its own place, keeping the rest", () => {
    const text = `{
  "terminal": {
    "scrollback": 5000, // mine
  },
}
`;
    const edited = editConfigText(text, [{ path: ["terminal", "screenReaderMode"], value: true }]);
    expect(edited).toContain("// mine");
    expect(edited).toContain('"screenReaderMode": true');
    const parsed = parseConfigText(edited);
    expect(parsed.ok && parsed.config.terminal?.screenReaderMode).toBe(true);
    expect(parsed.ok && parsed.config.terminal?.scrollback).toBe(5000);
  });
});

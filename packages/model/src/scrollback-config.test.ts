import { describe, expect, it } from "vitest";
import { configJsonSchema, parseConfigText, scrollbackAllowed } from "./index";

// The global switch for the scrollback snapshots: `terminal.saveScrollback` in config.jsonc.

function terminalOf(text: string) {
  const result = parseConfigText(text);
  if (!result.ok) throw new Error(`expected a valid file: ${JSON.stringify(result.errors)}`);
  return result.config.terminal;
}

describe("terminal.saveScrollback", () => {
  it("is on when the file says nothing", () => {
    expect(scrollbackAllowed(terminalOf("{}"))).toBe(true);
    expect(scrollbackAllowed(terminalOf('{ "terminal": {} }'))).toBe(true);
    expect(scrollbackAllowed(terminalOf('{ "terminal": { "scrollback": 500 } }'))).toBe(true);
  });

  it("is on when the file says so, and off when the file says false", () => {
    expect(scrollbackAllowed(terminalOf('{ "terminal": { "saveScrollback": true } }'))).toBe(true);
    expect(scrollbackAllowed(terminalOf('{ "terminal": { "saveScrollback": false } }'))).toBe(
      false,
    );
  });

  it("sits beside the number of lines the terminal keeps without changing it", () => {
    const terminal = terminalOf('{ "terminal": { "scrollback": 500, "saveScrollback": false } }');
    expect(terminal).toEqual({ scrollback: 500, saveScrollback: false });
  });

  it("refuses a value that is not true or false, with the line", () => {
    for (const value of ['"no"', "0", "1", "null", '"false"', "[]"]) {
      const text = `{
  "terminal": {
    "saveScrollback": ${value}
  }
}`;
      const result = parseConfigText(text);
      expect(result.ok, value).toBe(false);
      if (result.ok) continue;
      expect(result.errors[0]?.path, value).toBe("terminal.saveScrollback");
      expect(result.errors[0]?.line, value).toBe(3);
    }
  });

  it("is in the JSON schema with its default and a description a person can read", () => {
    const schema = configJsonSchema() as {
      properties: { terminal: { properties: { saveScrollback: Record<string, unknown> } } };
    };
    const entry = schema.properties.terminal.properties.saveScrollback;
    expect(entry["type"]).toBe("boolean");
    expect(entry["default"]).toBe(true);
    expect(String(entry["description"])).toContain("2,000 lines");
    expect(String(entry["description"])).toContain("removes the files");
  });
});

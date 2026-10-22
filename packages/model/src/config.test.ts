import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConfigError } from "./index";
import { describeConfigError, parseConfigText } from "./index";

/** The errors of a text that must be refused. */
function errorsOf(text: string): ConfigError[] {
  const result = parseConfigText(text);
  if (result.ok) throw new Error(`expected the text to be refused: ${text}`);
  return result.errors;
}

describe("parseConfigText accepts", () => {
  it("an empty file, whitespace and a file with only comments: nothing is set", () => {
    for (const text of [
      "",
      "  \n\t\r\n",
      "// all defaults\n",
      "/* nothing\n here */\n// at all\n",
    ]) {
      expect(parseConfigText(text)).toEqual({ ok: true, config: {} });
    }
  });

  it("an empty object", () => {
    expect(parseConfigText("{}")).toEqual({ ok: true, config: {} });
  });

  it("comments and trailing commas, which are what makes the file JSONC", () => {
    const text = `// My settings.
{
  /* the side */
  "appearance": {
    "sidebar": {
      "position": "right", // trailing comment
      "width": 240,
    },
    "density": "compact",
  },
  "notifications": { "enabled": false, "longCommandSeconds": 90, },
}
`;
    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        appearance: { sidebar: { position: "right", width: 240 }, density: "compact" },
        notifications: { enabled: false, longCommandSeconds: 90 },
      },
    });
  });

  it("a byte order mark at the start, as Notepad saves it", () => {
    expect(parseConfigText('﻿{ "appearance": { "tabs": "top" } }')).toEqual({
      ok: true,
      config: { appearance: { tabs: "top" } },
    });
  });

  it("the key that points the editor at the schema", () => {
    expect(parseConfigText('{ "$schema": "./config.schema.json" }')).toEqual({
      ok: true,
      config: { $schema: "./config.schema.json" },
    });
  });

  it("every setting at its edge", () => {
    const text = JSON.stringify({
      appearance: {
        sidebar: { position: "left", width: 180, compact: true, keepOpen: true },
        density: "comfortable",
        tabs: "sidebar",
        favorites: "top",
        paneHeaders: true,
      },
      keybindings: { preset: "browser" },
      notifications: { enabled: true, longCommandSeconds: 0 },
    });
    expect(parseConfigText(text).ok).toBe(true);
    expect(parseConfigText(text.replace("180", "480")).ok).toBe(true);
  });
});

describe("parseConfigText reads the profiles of the user", () => {
  it("a list of profiles, with the arguments and the folder when they are there", () => {
    const result = parseConfigText(`{
  // my shells
  "profiles": [
    { "id": "dev-shell", "name": "Dev Shell", "program": "pwsh.exe", "args": ["-NoLogo"], "cwd": "C:\\\\work", },
    { "id": "plain", "name": "Plain", "program": "sh" },
  ],
}`);
    expect(result).toEqual({
      ok: true,
      config: {
        profiles: [
          {
            id: "dev-shell",
            name: "Dev Shell",
            program: "pwsh.exe",
            args: ["-NoLogo"],
            cwd: "C:\\work",
          },
          { id: "plain", name: "Plain", program: "sh" },
        ],
      },
    });
    expect(parseConfigText('{ "profiles": [] }')).toEqual({ ok: true, config: { profiles: [] } });
  });

  it("refuses an empty program at the line of the program", () => {
    const errors = errorsOf(`{
  "profiles": [
    { "id": "ok", "name": "Ok", "program": "sh" },
    { "id": "bad", "name": "Bad", "program": "" }
  ]
}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "profiles[1].program", line: 4 });
    expect(errors[0]?.message).toBe("The program is empty");
  });

  it("refuses an id used twice, `default`, and an id that is not lower case words", () => {
    const twice = errorsOf(`{
  "profiles": [
    { "id": "a", "name": "A", "program": "sh" },
    { "id": "a", "name": "A again", "program": "sh" }
  ]
}`);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ path: "profiles[1].id", line: 4 });
    expect(twice[0]?.message).toMatch(/used by another profile/);

    const reserved = errorsOf(
      '{ "profiles": [ { "id": "default", "name": "D", "program": "sh" } ] }',
    );
    expect(reserved[0]).toMatchObject({ path: "profiles[0].id" });
    expect(reserved[0]?.message).toMatch(/reserved/);

    const shape = errorsOf(
      '{ "profiles": [ { "id": "Dev Shell", "name": "D", "program": "sh" } ] }',
    );
    expect(shape[0]).toMatchObject({ path: "profiles[0].id" });
  });

  it("refuses a profile with a missing field, an unknown one, or of the wrong kind", () => {
    expect(errorsOf('{ "profiles": [ { "id": "a", "name": "A" } ] }')[0]).toMatchObject({
      path: "profiles[0].program",
    });
    expect(
      errorsOf('{ "profiles": [ { "id": "a", "name": "A", "program": "sh", "shell": 1 } ] }')[0]
        ?.message,
    ).toBe('Unknown setting "shell"');
    expect(
      errorsOf('{ "profiles": [ { "id": "a", "name": "A", "program": "sh", "args": "-l" } ] }')[0],
    ).toMatchObject({ path: "profiles[0].args" });
    expect(errorsOf('{ "profiles": { "list": [] } }')[0]).toMatchObject({ path: "profiles" });
  });
});

describe("parseConfigText refuses, with the line", () => {
  it("a setting of the wrong value, at the line of the value", () => {
    const errors = errorsOf(`{
  "appearance": {
    "sidebar": {
      "position": "middle"
    }
  }
}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ path: "appearance.sidebar.position", line: 4, column: 19 });
    expect(errors[0]?.message).toMatch(/left/);
    expect(errors[0]?.message).toMatch(/right/);
  });

  it("a setting the schema does not know, at the line of its name", () => {
    const errors = errorsOf(`{
  "appearance": {
    "sidebar": { "postion": "right" }
  }
}`);
    expect(errors).toEqual([
      {
        message: 'Unknown setting "postion"',
        path: "appearance.sidebar.postion",
        line: 3,
        column: 18,
      },
    ]);
  });

  it("an unknown setting at the top, and one more inside, each with its own line", () => {
    const errors = errorsOf(`{
  "theme": "dark",
  "notifications": {
    "enabled": true,
    "loud": 1
  }
}`);
    expect(errors.map((e) => [e.path, e.line])).toEqual([
      ["theme", 2],
      ["notifications.loud", 5],
    ]);
  });

  it("a number out of its range, or not a whole number, or not a number", () => {
    const width = (value: string) => `{ "appearance": { "sidebar": { "width": ${value} } } }`;
    for (const value of ["179", "481", "200.5", '"wide"', "null", "-1"]) {
      const errors = errorsOf(width(value));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ path: "appearance.sidebar.width", line: 1 });
    }
    const seconds = errorsOf('{ "notifications": { "longCommandSeconds": -5 } }');
    expect(seconds[0]).toMatchObject({ path: "notifications.longCommandSeconds" });
  });

  it("a shortcut preset that does not exist, at the line of the value", () => {
    const errors = errorsOf('{\n  "keybindings": { "preset": "vim" }\n}');
    expect(errors[0]).toMatchObject({ path: "keybindings.preset", line: 2 });
    expect(errors[0]?.message).toMatch(/safe/);
    expect(errors[0]?.message).toMatch(/browser/);
  });

  it("a boolean written as text", () => {
    const errors = errorsOf('{\n  "notifications": { "enabled": "no" }\n}');
    expect(errors[0]).toMatchObject({ path: "notifications.enabled", line: 2 });
  });

  it("a group that is not an object, at the line of the group", () => {
    const errors = errorsOf('{\n\n  "appearance": []\n}');
    expect(errors[0]).toMatchObject({ path: "appearance", line: 3 });
  });

  it("a file that is not an object", () => {
    expect(errorsOf("[1, 2]")[0]).toMatchObject({ path: "", line: 1, column: 1 });
    expect(errorsOf('"text"')[0]).toMatchObject({ line: 1 });
  });

  it("broken syntax, at the place where it breaks", () => {
    const missingValue = errorsOf('{\n  "appearance": {\n    "tabs": \n  }\n}');
    expect(missingValue[0]).toMatchObject({ line: 4, path: "" });
    expect(missingValue[0]?.message).toMatch(/value expected/i);

    const unclosed = errorsOf('{\n  "appearance": {}');
    expect(unclosed[0]?.message).toMatch(/close brace expected/i);
    expect(unclosed[0]?.line).toBe(2);

    expect(errorsOf("{ appearance: 1 }").length).toBeGreaterThan(0);
    expect(errorsOf('{ "a": 1 } x')[0]?.message).toMatch(/invalid symbol/i);
  });

  it("counts lines the same with CRLF line ends", () => {
    const errors = errorsOf('{\r\n  "appearance": {\r\n    "density": "tight"\r\n  }\r\n}');
    expect(errors[0]).toMatchObject({ path: "appearance.density", line: 3, column: 16 });
  });

  it("every problem of a text, not only the first, and no flood from a broken one", () => {
    const errors = errorsOf(
      '{ "appearance": { "density": "x", "tabs": "y" }, "notifications": { "enabled": 1 } }',
    );
    expect(errors.map((e) => e.path)).toEqual([
      "appearance.density",
      "appearance.tabs",
      "notifications.enabled",
    ]);
    expect(
      errorsOf("{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{").length,
    ).toBeLessThanOrEqual(20);
  });
});

describe("describeConfigError", () => {
  it("says the line, the column, the setting and the problem", () => {
    expect(
      describeConfigError({
        message: "Invalid option",
        path: "appearance.tabs",
        line: 4,
        column: 7,
      }),
    ).toBe("line 4, column 7: appearance.tabs: Invalid option");
  });

  it("leaves out what it does not have", () => {
    expect(describeConfigError({ message: "Value expected", path: "", line: 2, column: 3 })).toBe(
      "line 2, column 3: Value expected",
    );
    expect(describeConfigError({ message: "Could not read config.jsonc: busy", path: "" })).toBe(
      "Could not read config.jsonc: busy",
    );
  });
});

describe("parseConfigText properties", () => {
  it("never throws, whatever the text", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = parseConfigText(text);
        if (!result.ok) {
          expect(result.errors.length).toBeGreaterThan(0);
          for (const error of result.errors) {
            if (error.line !== undefined) expect(error.line).toBeGreaterThanOrEqual(1);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  const settings = fc.record(
    {
      appearance: fc.record(
        {
          sidebar: fc.record(
            {
              position: fc.constantFrom("left", "right"),
              width: fc.integer({ min: 180, max: 480 }),
              compact: fc.boolean(),
              keepOpen: fc.boolean(),
            },
            { requiredKeys: [] },
          ),
          density: fc.constantFrom("comfortable", "compact"),
          tabs: fc.constantFrom("sidebar", "top"),
          favorites: fc.constantFrom("sidebar", "top"),
          paneHeaders: fc.boolean(),
        },
        { requiredKeys: [] },
      ),
      keybindings: fc.record({ preset: fc.constantFrom("safe", "browser") }, { requiredKeys: [] }),
      notifications: fc.record(
        { enabled: fc.boolean(), longCommandSeconds: fc.integer({ min: 0, max: 100000 }) },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  );

  it("reads back any valid settings, written plain or with comments and trailing commas", () => {
    fc.assert(
      fc.property(settings, (value) => {
        expect(parseConfigText(JSON.stringify(value))).toEqual({ ok: true, config: value });
        const decorated = `// head\n${JSON.stringify(value, null, 2).replace(/\n}/g, ",\n}")}\n// tail`;
        expect(parseConfigText(decorated)).toEqual({ ok: true, config: value });
      }),
      { numRuns: 200 },
    );
  });
});

describe("the language setting", () => {
  it("takes system, en and pt-BR, and nothing else", () => {
    for (const language of ["system", "en", "pt-BR"]) {
      expect(parseConfigText(`{ "language": "${language}" }`)).toEqual({
        ok: true,
        config: { language },
      });
    }
    const [error] = errorsOf('{ "language": "fr" }');
    expect(error?.path).toBe("language");
    expect(error?.line).toBe(1);
    expect(errorsOf('{ "language": 3 }')[0]?.path).toBe("language");
  });
});

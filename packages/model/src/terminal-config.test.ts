import { describe, expect, it } from "vitest";
import {
  ConfigSchema,
  DEFAULT_TERMINAL_OPTIONS,
  configJsonSchema,
  editConfigText,
  parseConfigText,
  terminalOptionsOf,
} from "./index";

// The `terminal` section of config.jsonc: the font, the cursor, the scrollback and the bell.

/** What `parseConfigText` says is wrong with the text: the setting and the line of each problem. */
function problems(text: string): { path: string; line: number | undefined; message: string }[] {
  const result = parseConfigText(text);
  if (result.ok) throw new Error(`expected the text to be refused: ${text}`);
  return result.errors.map((error) => ({
    path: error.path,
    line: error.line,
    message: error.message,
  }));
}

describe("the terminal section of config.jsonc", () => {
  it("accepts every setting", () => {
    const text = `{
  "terminal": {
    "font": { "family": "Fira Code, monospace", "size": 15, "lineHeight": 1.25, "ligatures": true },
    "cursor": { "style": "underline", "blink": false },
    "scrollback": 2000,
    "bell": "both",
  },
}`;
    expect(parseConfigText(text)).toEqual({
      ok: true,
      config: {
        terminal: {
          font: { family: "Fira Code, monospace", size: 15, lineHeight: 1.25, ligatures: true },
          cursor: { style: "underline", blink: false },
          scrollback: 2000,
          bell: "both",
        },
      },
    });
  });

  it("is optional, and so is every setting in it", () => {
    expect(parseConfigText("{}")).toEqual({ ok: true, config: {} });
    expect(parseConfigText('{ "terminal": {} }')).toEqual({ ok: true, config: { terminal: {} } });
    expect(parseConfigText('{ "terminal": { "font": {} , "cursor": {} } }').ok).toBe(true);
  });

  it("gives the terminal its old behavior when the file says nothing", () => {
    const result = parseConfigText("{}");
    if (!result.ok) throw new Error("valid");
    expect(terminalOptionsOf(result.config.terminal)).toEqual(DEFAULT_TERMINAL_OPTIONS);
  });

  it("accepts each cursor style and each bell", () => {
    for (const style of ["block", "bar", "underline"]) {
      expect(parseConfigText(`{ "terminal": { "cursor": { "style": "${style}" } } }`).ok).toBe(
        true,
      );
    }
    for (const bell of ["none", "visual", "sound", "both"]) {
      expect(parseConfigText(`{ "terminal": { "bell": "${bell}" } }`).ok).toBe(true);
    }
  });

  it("accepts the limits of the size, the line height and the scrollback", () => {
    for (const body of [
      '"font": { "size": 6 }',
      '"font": { "size": 72 }',
      '"font": { "size": 13.5 }',
      '"font": { "lineHeight": 1 }',
      '"font": { "lineHeight": 3 }',
      '"scrollback": 0',
      '"scrollback": 100000',
    ]) {
      expect(parseConfigText(`{ "terminal": { ${body} } }`).ok, body).toBe(true);
    }
  });

  it("refuses a size, a line height or a scrollback out of range, with the line", () => {
    const text = (body: string) => `{
  "terminal": {
    ${body}
  }
}`;
    for (const [body, path] of [
      ['"font": { "size": 5 }', "terminal.font.size"],
      ['"font": { "size": 73 }', "terminal.font.size"],
      ['"font": { "size": "big" }', "terminal.font.size"],
      ['"font": { "lineHeight": 0.9 }', "terminal.font.lineHeight"],
      ['"font": { "lineHeight": 3.1 }', "terminal.font.lineHeight"],
      ['"scrollback": -1', "terminal.scrollback"],
      ['"scrollback": 100001', "terminal.scrollback"],
      ['"scrollback": 10.5', "terminal.scrollback"],
      ['"scrollback": null', "terminal.scrollback"],
    ] as const) {
      const [problem, ...others] = problems(text(body));
      expect(problem?.path, body).toBe(path);
      // The value is on the line after the one that opens "terminal" (line 2): line 3.
      expect(problem?.line, body).toBe(3);
      expect(others, body).toEqual([]);
    }
  });

  it("refuses a cursor style, a bell or a kind of value that does not exist", () => {
    const [style] = problems(`{
  "terminal": {
    "cursor": { "style": "beam" }
  }
}`);
    expect(style?.path).toBe("terminal.cursor.style");
    expect(style?.line).toBe(3);
    const [bell] = problems(`{
  "terminal": {
    "bell": "loud"
  }
}`);
    expect(bell?.path).toBe("terminal.bell");
    expect(bell?.line).toBe(3);
    expect(problems('{ "terminal": { "cursor": { "blink": "yes" } } }')[0]?.path).toBe(
      "terminal.cursor.blink",
    );
    expect(problems('{ "terminal": { "font": { "ligatures": 1 } } }')[0]?.path).toBe(
      "terminal.font.ligatures",
    );
  });

  it("refuses a setting it does not have, naming it, so a typo does not go unnoticed", () => {
    const [problem] = problems(`{
  "terminal": {
    "font": { "colour": "red" }
  }
}`);
    expect(problem?.message).toBe('Unknown setting "colour"');
    expect(problem?.path).toBe("terminal.font.colour");
    expect(problem?.line).toBe(3);
    expect(problems('{ "terminal": { "scrollBack": 10 } }')[0]?.message).toBe(
      'Unknown setting "scrollBack"',
    );
  });

  it("refuses a font list that is not a list of font names, with the line and the reason", () => {
    for (const family of [
      "url(https://example.com/font.woff)",
      "https://example.com/font.woff",
      "Consolas; color: red",
      "Consolas } body { display: none",
      "",
      "   ",
      "Consolas,",
      "Evil\\\\Font",
      "x".repeat(301),
    ]) {
      const text = `{
  "terminal": {
    "font": {
      "family": ${JSON.stringify(family)}
    }
  }
}`;
      const [problem, ...others] = problems(text);
      expect(problem?.path, family).toBe("terminal.font.family");
      expect(problem?.line, family).toBe(4);
      expect(problem?.message.length, family).toBeGreaterThan(10);
      expect(others, family).toEqual([]);
    }
  });

  it("names the character that is not allowed in a font name", () => {
    const [problem] = problems('{ "terminal": { "font": { "family": "Consolas; color: red" } } }');
    expect(problem?.message).toContain("is not the name of a font");
    expect(problem?.message).toContain("Consolas; color: red");
  });

  it("lets a font list through that has quotes around its names", () => {
    expect(
      parseConfigText(
        '{ "terminal": { "font": { "family": "\\"Cascadia Mono\\", Consolas, monospace" } } }',
      ).ok,
    ).toBe(true);
  });

  it("keeps the old settings in force when a new text is refused", () => {
    // `parseConfigText` is all-or-nothing: the manager keeps the last valid settings.
    expect(parseConfigText('{ "terminal": { "font": { "size": 99 } } }').ok).toBe(false);
  });
});

describe("the terminal section in the JSON Schema", () => {
  const schema = configJsonSchema() as {
    properties: Record<string, { properties?: Record<string, unknown> }>;
  };

  it("is listed after appearance and before mods, with every setting described", () => {
    const keys = Object.keys(schema.properties);
    expect(keys.indexOf("terminal")).toBe(keys.indexOf("appearance") + 1);
    expect(keys.indexOf("mods")).toBe(keys.indexOf("terminal") + 1);
    const text = JSON.stringify(schema.properties["terminal"]);
    for (const word of [
      "family",
      "lineHeight",
      "ligatures",
      "style",
      "blink",
      "scrollback",
      "bell",
    ]) {
      expect(text).toContain(`"${word}"`);
    }
    expect(text).toContain('"default":14');
    expect(text).toContain('"default":10000');
  });

  it("is what ConfigSchema validates", () => {
    expect(ConfigSchema.safeParse({ terminal: { scrollback: 5 } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ terminal: { scrollback: -5 } }).success).toBe(false);
  });
});

describe("editing the terminal section of a file", () => {
  it("puts a new section after appearance, keeping the comments", () => {
    const text = `{
  // where the sidebar is
  "appearance": { "density": "compact" },
  "mods": ["a.css"],
}
`;
    const edited = editConfigText(text, [{ path: ["terminal", "cursor", "style"], value: "bar" }]);
    expect(edited).toContain("// where the sidebar is");
    const result = parseConfigText(edited);
    expect(result).toEqual({
      ok: true,
      config: {
        appearance: { density: "compact" },
        terminal: { cursor: { style: "bar" } },
        mods: ["a.css"],
      },
    });
    expect(edited.indexOf('"terminal"')).toBeGreaterThan(edited.indexOf('"appearance"'));
    expect(edited.indexOf('"terminal"')).toBeLessThan(edited.indexOf('"mods"'));
  });

  it("changes one value of an existing section and leaves the rest as it was", () => {
    const text = `{
  "terminal": {
    "font": { "size": 14 }, // the size I like
    "scrollback": 5000,
  },
}
`;
    const edited = editConfigText(text, [{ path: ["terminal", "font", "size"], value: 16 }]);
    expect(edited).toBe(text.replace('"size": 14', '"size": 16'));
  });
});

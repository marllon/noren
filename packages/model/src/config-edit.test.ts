import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import type { ConfigChange } from "./config-edit";

const set = (path: string[], value: string | number | boolean): ConfigChange => ({ path, value });

const config = (text: string) => {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.config;
};

/** A file written by hand: every kind of comment, a trailing comma and some spacing of its own. */
const HAND_WRITTEN = `// My settings.
{
  /* where the sidebar goes */
  "appearance": {
    "sidebar": {
      "position": "left", // I like it here
      "width": 240,
    },

    "density": "comfortable", /* tight rows are hard to read */
  },
  // Quiet, please.
  "notifications": { "enabled": true },
}
`;

describe("editConfigText", () => {
  it("replaces only the value of a setting the file has", () => {
    const edited = editConfigText(HAND_WRITTEN, [
      set(["appearance", "sidebar", "position"], "right"),
    ]);
    expect(edited).toBe(HAND_WRITTEN.replace('"position": "left"', '"position": "right"'));
  });

  it("keeps line comments, block comments, blank lines and trailing commas", () => {
    const edited = editConfigText(HAND_WRITTEN, [
      set(["appearance", "sidebar", "width"], 300),
      set(["notifications", "enabled"], false),
    ]);
    for (const kept of [
      "// My settings.",
      "/* where the sidebar goes */",
      "// I like it here",
      "/* tight rows are hard to read */",
      "// Quiet, please.",
    ]) {
      expect(edited).toContain(kept);
    }
    expect(edited).toBe(
      HAND_WRITTEN.replace('"width": 240', '"width": 300').replace(
        '"enabled": true',
        '"enabled": false',
      ),
    );
    expect(config(edited).appearance?.sidebar?.width).toBe(300);
    expect(config(edited).notifications?.enabled).toBe(false);
  });

  it("changes nothing but the lines of the settings that changed", () => {
    const edited = editConfigText(HAND_WRITTEN, [set(["appearance", "tabs"], "top")]);
    const before = HAND_WRITTEN.split("\n");
    const after = edited.split("\n");
    // Every line the file had is still there, in order; the setting is the only new thing.
    let at = 0;
    for (const line of before) {
      at = after.indexOf(line, at);
      expect(at, `line "${line}" was lost`).toBeGreaterThanOrEqual(0);
      at++;
    }
    expect(
      after
        .filter((line) => !before.includes(line))
        .join("")
        .replace(/\s/g, ""),
    ).toContain('"tabs":"top"');
    expect(config(edited).appearance?.tabs).toBe("top");
  });

  it("creates a new setting inside the group that has it, after the ones the schema lists first", () => {
    const text =
      '{\n  "appearance": {\n    "sidebar": {\n      "position": "right"\n    }\n  }\n}\n';
    const edited = editConfigText(text, [set(["appearance", "sidebar", "width"], 300)]);
    expect(edited).toBe(
      '{\n  "appearance": {\n    "sidebar": {\n      "position": "right",\n      "width": 300\n    }\n  }\n}\n',
    );
    expect(config(edited).appearance?.sidebar).toEqual({ position: "right", width: 300 });
  });

  it("keeps a group the person wrote on one line on one line", () => {
    const text = '{\n  "appearance": {\n    "sidebar": { "position": "right" }\n  }\n}\n';
    const edited = editConfigText(text, [set(["appearance", "sidebar", "width"], 300)]);
    expect(edited).toBe(
      '{\n  "appearance": {\n    "sidebar": { "position": "right", "width": 300 }\n  }\n}\n',
    );
    // A setting the schema lists first goes first.
    expect(editConfigText(text, [set(["appearance", "density"], "compact")])).toContain(
      '"sidebar": { "position": "right" },\n    "density": "compact"',
    );
  });

  it("leaves the comment at the end of a line with the setting it was written for", () => {
    const text = '{\n  "appearance": {\n    "density": "compact" // tight\n  }\n}\n';
    const edited = editConfigText(text, [set(["appearance", "tabs"], "top")]);
    expect(edited).toBe(
      '{\n  "appearance": {\n    "density": "compact", // tight\n    "tabs": "top"\n  }\n}\n',
    );
  });

  it("puts a setting the schema lists first above the comment written over the next one", () => {
    const text = '{\n  "appearance": {\n    // I want it tight\n    "density": "compact"\n  }\n}\n';
    const edited = editConfigText(text, [set(["appearance", "sidebar", "position"], "right")]);
    expect(edited).toBe(
      '{\n  "appearance": {\n    "sidebar": {\n      "position": "right"\n    },\n    // I want it tight\n    "density": "compact"\n  }\n}\n',
    );
  });

  it("opens an empty group over several lines", () => {
    expect(editConfigText('{ "appearance": {} }', [set(["appearance", "tabs"], "top")])).toBe(
      '{ "appearance": {\n  "tabs": "top"\n} }',
    );
    expect(editConfigText("{}", [set(["notifications", "enabled"], false)])).toBe(
      '{\n  "notifications": {\n    "enabled": false\n  }\n}',
    );
  });

  it("puts a new setting where the schema lists it, not at the end", () => {
    const text = '{\n  "appearance": {\n    "tabs": "top",\n    "paneHeaders": true\n  }\n}\n';
    const edited = editConfigText(text, [set(["appearance", "density"], "compact")]);
    const keys = [...edited.matchAll(/"(\w+)":/g)].map((match) => match[1]);
    // Schema order inside `appearance`: sidebar, density, tabs, paneHeaders.
    expect(keys).toEqual(["appearance", "density", "tabs", "paneHeaders"]);
    expect(config(edited).appearance).toEqual({
      density: "compact",
      tabs: "top",
      paneHeaders: true,
    });
  });

  it("puts a new group before the ones the schema lists after it and after the ones before it", () => {
    const text =
      '{\n  "$schema": "./config.schema.json",\n  "notifications": { "enabled": false }\n}\n';
    const edited = editConfigText(text, [
      set(["appearance", "tabs"], "top"),
      set(["keybindings", "preset"], "browser"),
    ]);
    const keys = [...edited.matchAll(/^ {2}"([\w$]+)":/gm)].map((match) => match[1]);
    expect(keys).toEqual(["$schema", "appearance", "keybindings", "notifications"]);
    expect(config(edited)).toEqual({
      $schema: "./config.schema.json",
      appearance: { tabs: "top" },
      keybindings: { preset: "browser" },
      notifications: { enabled: false },
    });
  });

  it("adds a setting to a group with a trailing comma without breaking the comma", () => {
    const text = '{\n  "appearance": {\n    "tabs": "top", // here\n  },\n}\n';
    const edited = editConfigText(text, [set(["appearance", "paneHeaders"], true)]);
    expect(edited).toContain("// here");
    expect(config(edited).appearance).toEqual({ tabs: "top", paneHeaders: true });
  });

  it("creates the file when there is none", () => {
    const edited = editConfigText(null, [set(["appearance", "sidebar", "position"], "right")]);
    expect(edited).toBe(
      '{\n  "appearance": {\n    "sidebar": {\n      "position": "right"\n    }\n  }\n}\n',
    );
    expect(config(edited).appearance?.sidebar?.position).toBe("right");
  });

  it("creates the file from an empty text, and from blank space", () => {
    expect(editConfigText("", [set(["notifications", "enabled"], false)])).toBe(
      '{\n  "notifications": {\n    "enabled": false\n  }\n}\n',
    );
    expect(config(editConfigText("\n  \n", [set(["notifications", "enabled"], false)]))).toEqual({
      notifications: { enabled: false },
    });
  });

  it("keeps the comments of a file that holds nothing but comments", () => {
    const text = "// nothing here yet\n/* but soon */\n";
    const edited = editConfigText(text, [set(["appearance", "density"], "compact")]);
    expect(edited).toContain("// nothing here yet");
    expect(edited).toContain("/* but soon */");
    expect(config(edited).appearance?.density).toBe("compact");
  });

  it("writes several changes in order", () => {
    const edited = editConfigText(null, [
      set(["appearance", "sidebar", "width"], 220),
      set(["appearance", "sidebar", "position"], "right"),
      set(["notifications", "longCommandSeconds"], 90),
    ]);
    expect(config(edited)).toEqual({
      appearance: { sidebar: { position: "right", width: 220 } },
      notifications: { longCommandSeconds: 90 },
    });
    // The second change was listed after the first in the file only if the schema says so.
    expect(edited.indexOf('"position"')).toBeLessThan(edited.indexOf('"width"'));
  });

  it("returns the same text for a value the file already has", () => {
    expect(editConfigText(HAND_WRITTEN, [set(["appearance", "density"], "comfortable")])).toBe(
      HAND_WRITTEN,
    );
  });

  it("keeps the line breaks of the file", () => {
    const crlf = HAND_WRITTEN.replace(/\n/g, "\r\n");
    const edited = editConfigText(crlf, [
      set(["appearance", "tabs"], "top"),
      set(["keybindings", "preset"], "browser"),
    ]);
    expect(edited).not.toMatch(/(^|[^\r])\n/);
    expect(config(edited).keybindings?.preset).toBe("browser");
  });

  it("writes a new line with the indentation of the file", () => {
    const tabs = '{\n\t"appearance": {\n\t\t"tabs": "top"\n\t}\n}\n';
    expect(editConfigText(tabs, [set(["appearance", "density"], "compact")])).toContain(
      '\t\t"density": "compact"',
    );
    const four = '{\n    "appearance": {\n        "tabs": "top"\n    }\n}\n';
    expect(editConfigText(four, [set(["appearance", "density"], "compact")])).toContain(
      '        "density": "compact"',
    );
  });

  it("keeps a byte order mark", () => {
    const edited = editConfigText("﻿{ }\n", [set(["appearance", "tabs"], "top")]);
    expect(edited.charCodeAt(0)).toBe(0xfeff);
    expect(config(edited).appearance?.tabs).toBe("top");
  });

  it("ignores a change with no path", () => {
    expect(editConfigText(HAND_WRITTEN, [{ path: [], value: 1 }])).toBe(HAND_WRITTEN);
  });

  describe("properties", () => {
    const settings = fc.record(
      {
        position: fc.constantFrom("left", "right"),
        width: fc.integer({ min: 180, max: 480 }),
        compact: fc.boolean(),
        keepOpen: fc.boolean(),
        density: fc.constantFrom("comfortable", "compact"),
        tabs: fc.constantFrom("sidebar", "top"),
        paneHeaders: fc.boolean(),
        preset: fc.constantFrom("safe", "browser"),
        enabled: fc.boolean(),
        longCommandSeconds: fc.integer({ min: 0, max: 3600 }),
      },
      { requiredKeys: [] },
    );
    const PATHS: Record<string, string[]> = {
      position: ["appearance", "sidebar", "position"],
      width: ["appearance", "sidebar", "width"],
      compact: ["appearance", "sidebar", "compact"],
      keepOpen: ["appearance", "sidebar", "keepOpen"],
      density: ["appearance", "density"],
      tabs: ["appearance", "tabs"],
      paneHeaders: ["appearance", "paneHeaders"],
      preset: ["keybindings", "preset"],
      enabled: ["notifications", "enabled"],
      longCommandSeconds: ["notifications", "longCommandSeconds"],
    };
    const changesOf = (values: Record<string, string | number | boolean>): ConfigChange[] =>
      Object.entries(values).map(([name, value]) => set(PATHS[name] ?? [], value));
    const COMMENTS = ["// My settings.", "/* where the sidebar goes */", "// I like it here"];

    it("always yields a valid file that says what was asked and still holds the comments", () => {
      fc.assert(
        fc.property(settings, (values) => {
          const edited = editConfigText(HAND_WRITTEN, changesOf(values));
          const parsed = parseConfigText(edited);
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          for (const comment of COMMENTS) expect(edited).toContain(comment);
          const read = parsed.config;
          const got: Record<string, unknown> = {
            position: read.appearance?.sidebar?.position,
            width: read.appearance?.sidebar?.width,
            compact: read.appearance?.sidebar?.compact,
            keepOpen: read.appearance?.sidebar?.keepOpen,
            density: read.appearance?.density,
            tabs: read.appearance?.tabs,
            paneHeaders: read.appearance?.paneHeaders,
            preset: read.keybindings?.preset,
            enabled: read.notifications?.enabled,
            longCommandSeconds: read.notifications?.longCommandSeconds,
          };
          for (const [name, value] of Object.entries(values)) expect(got[name]).toBe(value);
        }),
      );
    });

    it("is idempotent: asking for the same thing twice writes nothing new", () => {
      fc.assert(
        fc.property(settings, (values) => {
          const once = editConfigText(HAND_WRITTEN, changesOf(values));
          expect(editConfigText(once, changesOf(values))).toBe(once);
        }),
      );
    });

    it("builds the same settings from no file as a file written clean would hold", () => {
      fc.assert(
        fc.property(settings, (values) => {
          const created = editConfigText(null, changesOf(values));
          expect(parseConfigText(created).ok).toBe(true);
          // Nothing asked, nothing written; otherwise the file ends its last line.
          expect(created === "" ? Object.keys(values).length === 0 : created.endsWith("\n")).toBe(
            true,
          );
        }),
      );
    });
  });
});

describe("editConfigText over files written in any style", () => {
  /** A group of the file with some of its settings, as a plain object. */
  const original = fc.record(
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
          paneHeaders: fc.boolean(),
        },
        { requiredKeys: [] },
      ),
      keybindings: fc.record({ preset: fc.constantFrom("safe", "browser") }, { requiredKeys: [] }),
      notifications: fc.record(
        { enabled: fc.boolean(), longCommandSeconds: fc.integer({ min: 0, max: 600 }) },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  );

  /** How a person might have laid the file out: on one line, or indented by 2, 4 or a tab. */
  const layout = fc.constantFrom<string | number | undefined>(undefined, 2, 4, "\t");

  const changes = fc.array(
    fc.oneof(
      fc.record({
        path: fc.constantFrom(["appearance", "sidebar", "position"]),
        value: fc.constantFrom<string | number | boolean>("left", "right"),
      }),
      fc.record({
        path: fc.constantFrom(["appearance", "sidebar", "width"]),
        value: fc.integer({ min: 180, max: 480 }),
      }),
      fc.record({
        path: fc.constantFrom(["appearance", "sidebar", "compact"], ["appearance", "paneHeaders"]),
        value: fc.boolean(),
      }),
      fc.record({
        path: fc.constantFrom(["appearance", "density"]),
        value: fc.constantFrom<string | number | boolean>("comfortable", "compact"),
      }),
      fc.record({
        path: fc.constantFrom(["keybindings", "preset"]),
        value: fc.constantFrom<string | number | boolean>("safe", "browser"),
      }),
      fc.record({
        path: fc.constantFrom(["notifications", "longCommandSeconds"]),
        value: fc.integer({ min: 0, max: 600 }),
      }),
      fc.record({ path: fc.constantFrom(["notifications", "enabled"]), value: fc.boolean() }),
    ),
    { maxLength: 6 },
  );

  /** What the settings come to when `changes` are laid over `base`. */
  function merged(base: unknown, list: readonly ConfigChange[]): unknown {
    const result = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    for (const { path, value } of list) {
      let at = result;
      for (const key of path.slice(0, -1)) {
        const next = at[key];
        at = (typeof next === "object" && next !== null ? next : (at[key] = {})) as Record<
          string,
          unknown
        >;
      }
      at[path[path.length - 1] ?? ""] = value;
    }
    return result;
  }

  /** The text of `value` in a layout, with a trailing comma and a comment on every line if asked. */
  function written(value: unknown, how: string | number | undefined, decorated: boolean): string {
    const plain = JSON.stringify(value, null, how);
    if (!decorated) return plain;
    const withCommas = plain.replace(/([^,{[\s])(\r?\n\s*[}\]])/g, "$1,$2");
    let count = 0;
    const lines = withCommas.split("\n").map((line) => `${line} // note ${count++}`);
    return `// head\n${lines.join("\n")}\n// tail\n`;
  }

  it("always yields a valid file with the settings asked for, and keeps every comment", () => {
    fc.assert(
      fc.property(original, layout, fc.boolean(), changes, (base, how, decorated, list) => {
        const text = written(base, how, decorated);
        // Not every decoration of every layout is a file the editor accepts as it is written: the
        // property is about the files that are valid.
        fc.pre(parseConfigText(text).ok);
        const edited = editConfigText(text, list);
        const parsed = parseConfigText(edited);
        expect(parsed.ok, edited).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.config).toEqual(merged(base, list));
        for (const comment of text.match(/\/\/ [^\n]*/g) ?? []) {
          // The comment of a line is still on the line it was written on, with what it annotated.
          expect(edited, comment).toContain(comment);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("changes nothing in a file that already says what is asked", () => {
    fc.assert(
      fc.property(original, layout, fc.boolean(), (base, how, decorated) => {
        const text = written(base, how, decorated);
        fc.pre(parseConfigText(text).ok);
        // Ask for every setting the file has, with the value it has.
        const asked: ConfigChange[] = [];
        const walk = (node: unknown, path: string[]) => {
          if (typeof node === "object" && node !== null) {
            for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
          } else {
            asked.push({ path, value: node as string | number | boolean });
          }
        };
        walk(base, []);
        expect(editConfigText(text, asked)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });
});

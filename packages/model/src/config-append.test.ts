import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { describeConfigError, parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import type { ConfigAppend } from "./config-edit";
import type { ShellUserProfile, UserProfile } from "./user-profile-schema";

// Adding items to the end of a list setting (`profiles`) in the text of the file: the items in the
// list and everything around them stay as they are, the new ones are written like their neighbors.

const append = (...items: ShellUserProfile[]): ConfigAppend => ({
  path: ["profiles"],
  append: items,
});

const dev: ShellUserProfile = { id: "dev-shell", name: "Dev Shell", program: "pwsh.exe" };
const git: ShellUserProfile = {
  id: "git-bash",
  name: "Git Bash",
  program: "C:\\Program Files\\Git\\bin\\bash.exe",
  args: ["--login", "-i"],
  cwd: "%USERPROFILE%",
};

/** The profiles a text lists, or the errors that make it invalid. */
function profilesOf(text: string): UserProfile[] {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(`${text}\n${parsed.errors.map(describeConfigError).join("\n")}`);
  return parsed.config.profiles ?? [];
}

/** A file written by hand, with a list of profiles and comments all around it. */
const WITH_LIST = `// My settings.
{
  "notifications": { "enabled": false }, // quiet

  /* my shells */
  "profiles": [
    // the first one
    { "id": "old", "name": "Old", "program": "sh" }, // keep it
    {
      "id": "mine",
      "name": "Mine",
      "program": "zsh",
      "args": ["-l"],
    },
  ],
  "keybindings": { "preset": "browser" }, // last
}
`;

describe("editConfigText appending to a list", () => {
  it("adds the items under the last one, indented like it, and leaves every comment where it was", () => {
    const edited = editConfigText(WITH_LIST, [append(dev, git)]);
    expect(profilesOf(edited)).toEqual([
      { id: "old", name: "Old", program: "sh" },
      { id: "mine", name: "Mine", program: "zsh", args: ["-l"] },
      dev,
      git,
    ]);
    // The text up to the end of the last item is exactly what it was, and so is what follows.
    const before = WITH_LIST.slice(0, WITH_LIST.indexOf("  ],\n"));
    const after = WITH_LIST.slice(WITH_LIST.indexOf("  ],\n"));
    expect(edited.startsWith(before)).toBe(true);
    expect(edited.endsWith(after)).toBe(true);
    // The new items are objects over several lines, a trailing comma like the one the list had.
    expect(edited).toContain(
      `    },
    {
      "id": "dev-shell",
      "name": "Dev Shell",
      "program": "pwsh.exe"
    },
    {
      "id": "git-bash",
      "name": "Git Bash",
      "program": "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe",
      "args": ["--login", "-i"],
      "cwd": "%USERPROFILE%"
    },
  ],`,
    );
  });

  it("puts the comma the last item lacked, and none after the new one when the list had none", () => {
    const text = `{\n  "profiles": [\n    { "id": "a", "name": "A", "program": "sh" } // the only one\n  ]\n}\n`;
    const edited = editConfigText(text, [append(dev)]);
    expect(edited).toBe(`{
  "profiles": [
    { "id": "a", "name": "A", "program": "sh" }, // the only one
    {
      "id": "dev-shell",
      "name": "Dev Shell",
      "program": "pwsh.exe"
    }
  ]
}
`);
    expect(profilesOf(edited)).toHaveLength(2);
  });

  it("keeps a list written on one line on one line", () => {
    const text = `{ "profiles": [ { "id": "a", "name": "A", "program": "sh" } ], "notifications": {} }`;
    const edited = editConfigText(text, [append(dev, git)]);
    expect(edited).toBe(
      `{ "profiles": [ { "id": "a", "name": "A", "program": "sh" }, { "id": "dev-shell", "name": "Dev Shell", "program": "pwsh.exe" }, { "id": "git-bash", "name": "Git Bash", "program": "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe", "args": ["--login", "-i"], "cwd": "%USERPROFILE%" } ], "notifications": {} }`,
    );
    expect(profilesOf(edited)).toHaveLength(3);
  });

  it("fills an empty list over several lines", () => {
    for (const empty of ["[]", "[ ]", "[\n  ]"]) {
      const text = `{\n  "profiles": ${empty},\n}\n`;
      const edited = editConfigText(text, [append(dev)]);
      expect(profilesOf(edited), edited).toEqual([dev]);
      expect(edited).toBe(`{
  "profiles": [
    {
      "id": "dev-shell",
      "name": "Dev Shell",
      "program": "pwsh.exe"
    }
  ],
}
`);
    }
  });

  it("creates the list where the schema puts it, between the groups before it and after it", () => {
    const text = `// head\n{\n  "appearance": { "tabs": "top" }, // tabs\n  "keybindings": { "preset": "safe" },\n}\n`;
    const edited = editConfigText(text, [append(dev)]);
    expect(profilesOf(edited)).toEqual([dev]);
    expect(edited.indexOf('"appearance"')).toBeLessThan(edited.indexOf('"profiles"'));
    expect(edited.indexOf('"profiles"')).toBeLessThan(edited.indexOf('"keybindings"'));
    expect(edited).toContain('"tabs": "top" }, // tabs');
    expect(edited.startsWith("// head\n{\n")).toBe(true);
  });

  it("creates the file when there is none, or only comments", () => {
    const fresh = editConfigText(null, [append(dev)]);
    expect(fresh).toBe(`{
  "profiles": [
    {
      "id": "dev-shell",
      "name": "Dev Shell",
      "program": "pwsh.exe"
    }
  ]
}
`);
    expect(profilesOf(fresh)).toEqual([dev]);
    const commented = editConfigText("// nothing yet\n", [append(dev)]);
    expect(commented.startsWith("// nothing yet\n{")).toBe(true);
    expect(profilesOf(commented)).toEqual([dev]);
  });

  it("keeps the line breaks, the indentation and the byte order mark of the file", () => {
    const crlf = WITH_LIST.replace(/\n/g, "\r\n");
    const edited = editConfigText(crlf, [append(dev)]);
    expect(edited.replace(/\r\n/g, "")).not.toContain("\n");
    expect(profilesOf(edited)).toHaveLength(3);

    const tabs = `{\n\t"profiles": [\n\t\t{ "id": "a", "name": "A", "program": "sh" }\n\t]\n}\n`;
    expect(editConfigText(tabs, [append(dev)])).toContain(`\t\t{\n\t\t\t"id": "dev-shell",`);

    const bom = String.fromCharCode(0xfeff);
    const withBom = editConfigText(`${bom}{}`, [append(dev)]);
    expect(withBom.startsWith(`${bom}{`)).toBe(true);
    expect(withBom.indexOf(bom, 1)).toBe(-1);
    expect(profilesOf(withBom)).toEqual([dev]);
  });

  it("changes nothing when there is nothing to add, and does not touch other settings", () => {
    expect(editConfigText(WITH_LIST, [append()])).toBe(WITH_LIST);
    const both = editConfigText(WITH_LIST, [
      { path: ["notifications", "enabled"], value: true },
      append(dev),
    ]);
    const parsed = parseConfigText(both);
    expect(parsed.ok && parsed.config.notifications?.enabled).toBe(true);
    expect(profilesOf(both)).toHaveLength(3);
  });

  it("refuses to add to something that is not a list, and to a file that is not an object", () => {
    expect(() => editConfigText(`{ "profiles": {} }`, [append(dev)])).toThrow("not a list");
    expect(() => editConfigText(`[]`, [append(dev)])).toThrow("does not hold an object");
  });

  it("writes strings that need escaping so they read back the same", () => {
    const odd: ShellUserProfile = {
      id: "odd",
      name: 'He said "hi" \\ and left',
      program: "sh",
      args: ['a "quoted" b', "back\\slash", "tab\there", "é ü 日本"],
      cwd: "C:\\a b\\c",
    };
    const edited = editConfigText(WITH_LIST, [append(odd)]);
    expect(profilesOf(edited).at(-1)).toEqual(odd);
  });

  describe("properties", () => {
    const id = fc
      .array(fc.constantFrom(..."abcdef0123456789".split("")), { minLength: 1, maxLength: 6 })
      .map((chars) => chars.join(""));
    const profile = fc.record(
      {
        id,
        name: fc.string({ minLength: 1, maxLength: 20 }).filter((text) => text.trim() !== ""),
        program: fc.string({ minLength: 1, maxLength: 20 }).filter((text) => text.trim() !== ""),
        args: fc.array(fc.string({ maxLength: 12 }), { maxLength: 3 }),
        cwd: fc.string({ minLength: 1, maxLength: 12 }).filter((text) => text.trim() !== ""),
      },
      { requiredKeys: ["id", "name", "program"] },
    );
    const clean = (value: ShellUserProfile): ShellUserProfile => ({
      ...value,
      name: value.name.replace(/\0/g, "x"),
      program: value.program.replace(/\0/g, "x"),
      ...(value.args !== undefined ? { args: value.args.map((a) => a.replace(/\0/g, "x")) } : {}),
      ...(value.cwd !== undefined ? { cwd: value.cwd.replace(/\0/g, "x") } : {}),
    });
    const layout = fc.constantFrom<string | number | undefined>(undefined, 2, 4, "\t");

    function uniqueIds(list: ShellUserProfile[]): ShellUserProfile[] {
      const seen = new Set<string>();
      return list
        .filter((item) => !seen.has(item.id) && seen.add(item.id))
        .map((item) => clean(item));
    }

    /** The text of the file with `existing` in its list, plain or with comments and trailing commas. */
    function written(
      existing: ShellUserProfile[],
      how: string | number | undefined,
      decorated: boolean,
    ): string {
      const plain = JSON.stringify(
        { notifications: { enabled: true }, profiles: existing },
        null,
        how,
      );
      if (!decorated) return plain;
      const withCommas = plain.replace(/([^,{[\s])(\r?\n\s*[}\]])/g, "$1,$2");
      let count = 0;
      const lines = withCommas.split("\n").map((line) => `${line} // note ${count++}`);
      return `// head\n${lines.join("\n")}\n// tail\n`;
    }

    it("always yields a valid file with the old items first and the new ones after, and every comment stays", () => {
      fc.assert(
        fc.property(
          fc.array(profile, { maxLength: 3 }),
          fc.array(profile, { minLength: 1, maxLength: 3 }),
          layout,
          fc.boolean(),
          (olderRaw, newerRaw, how, decorated) => {
            const everything = uniqueIds([...olderRaw, ...newerRaw]);
            const older = everything.slice(0, Math.min(olderRaw.length, everything.length));
            const newer = everything.slice(older.length);
            fc.pre(newer.length > 0);
            const text = written(older, how, decorated);
            fc.pre(parseConfigText(text).ok);
            const edited = editConfigText(text, [append(...newer)]);
            expect(profilesOf(edited), edited).toEqual([...older, ...newer]);
            for (const comment of text.match(/\/\/ [^\n]*/g) ?? []) {
              expect(edited, comment).toContain(comment);
            }
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});

import { describe, expect, it } from "vitest";
import { parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import type { UserProfile } from "./user-profile-schema";

// Editing and removing entries of the `profiles` list by their index in the text of the file: the
// path goes through the list, a setting of one profile is replaced, added in the order of the
// schema or taken out, and a whole profile can be removed. The comments around stay.

const FILE = `// My settings.
{
  "notifications": { "enabled": false }, // quiet

  /* my shells */
  "profiles": [
    // the first one
    { "id": "one", "name": "One", "program": "sh", "cwd": "/tmp" }, // keep it
    {
      "id": "two", // the second
      "name": "Two",
      "program": "zsh",
    },
    // the last one
    { "id": "three", "name": "Three", "program": "fish" },
  ],
  // end
}
`;

function profilesOf(text: string): UserProfile[] {
  const parsed = parseConfigText(text);
  if (!parsed.ok) throw new Error(text);
  return parsed.config.profiles ?? [];
}

describe("editing a profile by its index", () => {
  it("replaces a value in place and leaves every comment", () => {
    const out = editConfigText(FILE, [{ path: ["profiles", 1, "name"], value: "Second" }]);
    expect(out).toBe(FILE.replace('"name": "Two"', '"name": "Second"'));
  });

  it("adds a missing setting under its neighbors, in the order of the schema (args before cwd)", () => {
    const out = editConfigText(FILE, [{ path: ["profiles", 0, "args"], value: ["-l", "-i"] }]);
    expect(profilesOf(out)[0]).toEqual({
      id: "one",
      name: "One",
      program: "sh",
      args: ["-l", "-i"],
      cwd: "/tmp",
    });
    expect(out.indexOf('"args"')).toBeLessThan(out.indexOf('"cwd"'));
    expect(out).toContain("// keep it");
    expect(out).toContain("// the first one");
  });

  it("adds a setting to a profile written over several lines, keeping the comment at the end of a line", () => {
    const out = editConfigText(FILE, [{ path: ["profiles", 1, "cwd"], value: "/home" }]);
    expect(profilesOf(out)[1]).toEqual({
      id: "two",
      name: "Two",
      program: "zsh",
      cwd: "/home",
    });
    expect(out).toContain('"id": "two", // the second');
  });

  it("replaces a list of arguments whole", () => {
    const withArgs = editConfigText(FILE, [{ path: ["profiles", 2, "args"], value: ["-x"] }]);
    const out = editConfigText(withArgs, [{ path: ["profiles", 2, "args"], value: ["-a", "-b"] }]);
    expect(profilesOf(out)[2]?.args).toEqual(["-a", "-b"]);
  });

  it("refuses a profile that is not there, instead of writing a wrong key", () => {
    expect(() => editConfigText(FILE, [{ path: ["profiles", 7, "name"], value: "x" }])).toThrow(
      /not in the settings file/,
    );
    expect(() => editConfigText(null, [{ path: ["profiles", 0, "name"], value: "x" }])).toThrow();
  });
});

describe("removing entries", () => {
  it("takes a setting of a profile out, and nothing else", () => {
    const out = editConfigText(FILE, [{ path: ["profiles", 0, "cwd"], remove: true }]);
    expect(profilesOf(out)[0]).toEqual({ id: "one", name: "One", program: "sh" });
    expect(out).toContain("// keep it");
    expect(out).toContain("// the first one");
  });

  it.each([
    [0, ["two", "three"]],
    [1, ["one", "three"]],
    [2, ["one", "two"]],
  ])("takes profile %i out of the list and keeps the comments of the file", (index, left) => {
    const out = editConfigText(FILE, [{ path: ["profiles", index], remove: true }]);
    expect(profilesOf(out).map((profile) => profile.id)).toEqual(left);
    for (const comment of ["// My settings.", "// quiet", "/* my shells */", "// end"]) {
      expect(out).toContain(comment);
    }
  });

  it("takes the last item out of a list without a trailing comma and leaves a list that reads the same way", () => {
    const text = `{\n  "profiles": [\n    { "id": "a", "name": "A", "program": "sh" }, // a\n    { "id": "b", "name": "B", "program": "zsh" } // b\n  ]\n}\n`;
    expect(editConfigText(text, [{ path: ["profiles", 1], remove: true }])).toBe(
      `{\n  "profiles": [\n    { "id": "a", "name": "A", "program": "sh" } // a\n  ]\n}\n`,
    );
    expect(editConfigText(text, [{ path: ["profiles", 0], remove: true }])).toBe(
      `{\n  "profiles": [\n    { "id": "b", "name": "B", "program": "zsh" } // b\n  ]\n}\n`,
    );
  });

  it("takes a profile out of a list written on one line", () => {
    const text = `{ "profiles": [{ "id": "a", "name": "A", "program": "sh" }, { "id": "b", "name": "B", "program": "zsh" }] }`;
    const out = editConfigText(text, [{ path: ["profiles", 0], remove: true }]);
    expect(profilesOf(out).map((profile) => profile.id)).toEqual(["b"]);
  });

  it("keeps CRLF line breaks", () => {
    const text = FILE.replaceAll("\n", "\r\n");
    const out = editConfigText(text, [{ path: ["profiles", 1], remove: true }]);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(profilesOf(out).map((profile) => profile.id)).toEqual(["one", "three"]);
  });

  it("removes several, the highest index first, and the last one leaves an empty list", () => {
    const out = editConfigText(FILE, [
      { path: ["profiles", 2], remove: true },
      { path: ["profiles", 1], remove: true },
      { path: ["profiles", 0], remove: true },
    ]);
    expect(profilesOf(out)).toEqual([]);
    expect(out).toContain("/* my shells */");
  });

  it("leaves a text alone that does not have the entry", () => {
    expect(editConfigText(FILE, [{ path: ["profiles", 9], remove: true }])).toBe(FILE);
    expect(editConfigText(FILE, [{ path: ["archive", "enabled"], remove: true }])).toBe(FILE);
    expect(editConfigText(null, [{ path: ["profiles", 0], remove: true }])).toBe("");
  });

  it("does the edits in order: change, remove, then append", () => {
    const added: UserProfile = { id: "four", name: "Four", program: "nu" };
    const out = editConfigText(FILE, [
      { path: ["profiles", 2, "name"], value: "Third" },
      { path: ["profiles", 0], remove: true },
      { path: ["profiles"], append: [added] },
    ]);
    expect(profilesOf(out)).toEqual([
      { id: "two", name: "Two", program: "zsh" },
      { id: "three", name: "Third", program: "fish" },
      added,
    ]);
  });
});

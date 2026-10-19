import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseConfigText } from "./config";
import { editConfigText } from "./config-edit";
import { importProfiles } from "./importers";
import { JSON_PROFILES_FILE, JSON_SETTINGS } from "./import-fixtures";
import type { ImportedProfile } from "./import-json";
import { MAX_USER_PROFILES, UserProfileSchema, profilesProblem } from "./user-profile-schema";
import type { UserProfile } from "./user-profile-schema";
import { commandLineOf, splitCommandLine, userProfilesFromImported } from "./user-profiles";

const imported = (
  name: string,
  commandLine: string | null,
  startingDirectory: string | null = null,
): ImportedProfile => ({ name, commandLine, startingDirectory, colorScheme: null });

describe("splitCommandLine", () => {
  const cases: [string, string, string[]][] = [
    ["cmd.exe", "cmd.exe", []],
    ["pwsh.exe -NoLogo", "pwsh.exe", ["-NoLogo"]],
    ["  pwsh.exe   -NoLogo  -NoProfile ", "pwsh.exe", ["-NoLogo", "-NoProfile"]],
    ["pwsh.exe\t-NoLogo", "pwsh.exe", ["-NoLogo"]],
    // A quoted program runs to the next quote, spaces included.
    [
      '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i',
      "C:\\Program Files\\Git\\bin\\bash.exe",
      ["--login", "-i"],
    ],
    // Backslashes in the program are a path, not escapes.
    ["C:\\Windows\\System32\\cmd.exe /k dir", "C:\\Windows\\System32\\cmd.exe", ["/k", "dir"]],
    ['"C:\\Tools\\sh.exe"', "C:\\Tools\\sh.exe", []],
    // A quoted argument holds its spaces, and the quotes themselves are not kept.
    ['wsl.exe -d "Ubuntu 22.04"', "wsl.exe", ["-d", "Ubuntu 22.04"]],
    ['sh -c "echo hi there"', "sh", ["-c", "echo hi there"]],
    // A quote in the middle of a word joins the parts.
    ['sh --opt="a b" next', "sh", ["--opt=a b", "next"]],
    ['sh a"b c"d', "sh", ["ab cd"]],
    // An empty pair of quotes is an empty argument.
    ['sh "" x', "sh", ["", "x"]],
    // 2n backslashes and a quote: n backslashes, and the quote opens or closes.
    ['sh "a\\\\"', "sh", ["a\\"]],
    ['sh "C:\\dir with space\\\\" next', "sh", ["C:\\dir with space\\", "next"]],
    // 2n+1 backslashes and a quote: n backslashes and a literal quote.
    ['sh a\\"b', "sh", ['a"b']],
    ['sh "a\\"b c"', "sh", ['a"b c']],
    ['sh \\\\\\"x', "sh", ['\\"x']],
    // Backslashes not before a quote stay.
    ["sh a\\b\\\\c", "sh", ["a\\b\\\\c"]],
    // Two quotes in a row inside a quoted part are one literal quote.
    ['sh "say ""hi"" now"', "sh", ['say "hi" now']],
    // A quoted part never closed runs to the end of the line.
    ['sh "no end here', "sh", ["no end here"]],
    ['"C:\\no end', "C:\\no end", []],
    // Variables are kept as written; they are expanded when a session starts.
    [
      "%SystemRoot%\\System32\\cmd.exe /k cd %USERPROFILE%",
      "%SystemRoot%\\System32\\cmd.exe",
      ["/k", "cd", "%USERPROFILE%"],
    ],
    // What follows the closing quote of the program is the first argument.
    ['"a b"-x', "a b", ["-x"]],
  ];

  it.each(cases)("splits %j", (line, program, args) => {
    expect(splitCommandLine(line)).toEqual({ program, args });
  });

  it("has no program for an empty line, blanks or an empty pair of quotes", () => {
    for (const line of ["", " ", "\t\t", '""', '  ""  x', '" "']) {
      expect(splitCommandLine(line), JSON.stringify(line)).toBeUndefined();
    }
  });

  it("never throws, whatever the text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (line) => {
        const split = splitCommandLine(line);
        if (split !== undefined) {
          expect(split.program.trim()).not.toBe("");
          expect(split.args.every((arg) => typeof arg === "string")).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
    expect(() => splitCommandLine("\\".repeat(10_000) + '"')).not.toThrow();
    expect(() => splitCommandLine('"'.repeat(10_001))).not.toThrow();
  });

  it("splits back what commandLineOf writes, for any program and arguments", () => {
    const word = fc.string({
      unit: fc.constantFrom(..."ab c\\\"'%-_.:/\t"),
      maxLength: 12,
    });
    fc.assert(
      fc.property(
        // A program with a quote cannot be written in a command line.
        word.filter((text) => text.trim() !== "" && !text.includes('"')),
        fc.array(word, { maxLength: 5 }),
        (program, args) => {
          const profile = { program, args };
          expect(splitCommandLine(commandLineOf(profile)), commandLineOf(profile)).toEqual({
            program,
            args,
          });
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("userProfilesFromImported", () => {
  it("turns the profiles of a settings file into profiles of the user, the hidden one left out", () => {
    const file = importProfiles(JSON_PROFILES_FILE);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.hidden).toBe(1);

    const result = userProfilesFromImported(file.profiles, ["fake", "git-bash"]);
    expect(result.profiles).toEqual([
      {
        id: "git-bash-2",
        name: "Git Bash (2)",
        program: "C:\\Program Files\\Git\\bin\\bash.exe",
        args: ["--login", "-i"],
        cwd: "%USERPROFILE%",
      },
      {
        id: "dev-shell",
        name: "Dev Shell",
        program: "pwsh.exe",
        args: ["-NoLogo", "-Command", "Set-Location 'C:\\My Files'"],
        cwd: "C:\\work",
      },
      { id: "fake-2", name: "Fake (2)", program: "fake.exe" },
      { id: "twice", name: "Twice", program: "first.exe" },
      { id: "twice-2", name: "Twice (2)", program: "second.exe", args: ["/k", "title"] },
    ]);
    expect(result.profiles.map((profile) => profile.name)).not.toContain("Old Shell");
    expect(result.skipped).toEqual([{ name: "No Command", reason: "it has no command line" }]);
  });

  it("keeps the program and arguments the command line says, and the folder as written", () => {
    const [profile] = userProfilesFromImported([
      imported("Quoted", '"C:\\Program Files\\Tool\\t.exe" -a "b c" "d\\"e"', "%HOME%\\code"),
    ]).profiles;
    expect(profile).toEqual({
      id: "quoted",
      name: "Quoted",
      program: "C:\\Program Files\\Tool\\t.exe",
      args: ["-a", "b c", 'd"e'],
      cwd: "%HOME%\\code",
    });
  });

  it("gives ids that collide with no taken id, no other profile of the file and not `default`", () => {
    const result = userProfilesFromImported(
      [
        imported("Shell", "a.exe"),
        imported("Shell", "b.exe"),
        imported("shell", "c.exe"),
        imported("Default", "d.exe"),
        imported("pwsh", "e.exe"),
        imported("Ünïcode Shell!", "f.exe"),
      ],
      ["shell", "shell-2"],
    );
    expect(result.profiles.map((profile) => profile.id)).toEqual([
      "shell-3",
      "shell-4",
      "shell-5",
      "default-2",
      "pwsh",
      "unicode-shell",
    ]);
    expect(result.profiles.map((profile) => profile.name)).toEqual([
      "Shell (3)",
      "Shell (4)",
      "shell (5)",
      "Default (2)",
      "pwsh",
      "Ünïcode Shell!",
    ]);
    expect(new Set(result.profiles.map((profile) => profile.id)).size).toBe(6);
  });

  it("names the ids of the profiles the user already has as taken, so importing twice never repeats an id", () => {
    const file = importProfiles(JSON_PROFILES_FILE);
    if (!file.ok) throw new Error("fixture");
    const first = userProfilesFromImported(file.profiles).profiles;
    const second = userProfilesFromImported(
      file.profiles,
      first.map((profile) => profile.id),
    ).profiles;
    const ids = [...first, ...second].map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(first.map((profile) => profile.id)).toEqual([
      "git-bash",
      "dev-shell",
      "fake",
      "twice",
      "twice-2",
    ]);
    expect(second.map((profile) => profile.id)).toEqual([
      "git-bash-2",
      "dev-shell-2",
      "fake-2",
      "twice-3",
      "twice-4",
    ]);
    expect(second.map((profile) => profile.name)).toEqual([
      "Git Bash (2)",
      "Dev Shell (2)",
      "Fake (2)",
      "Twice (3)",
      "Twice (4)",
    ]);
  });

  it("skips a profile with no command line or no program, and says why", () => {
    const result = userProfilesFromImported([
      imported("None", null),
      imported("Blank", "   "),
      imported("Quotes", '""'),
      imported("Fine", "fine.exe"),
    ]);
    expect(result.profiles.map((profile) => profile.id)).toEqual(["fine"]);
    expect(result.skipped).toEqual([
      { name: "None", reason: "it has no command line" },
      { name: "Blank", reason: "its command line has no program" },
      { name: "Quotes", reason: "its command line has no program" },
    ]);
  });

  it("skips what the schema does not accept without spending its id", () => {
    const result = userProfilesFromImported([
      imported("Long", "x".repeat(2000)),
      imported("Nul", "a\0b"),
      imported("Long", "ok.exe"),
    ]);
    expect(result.profiles).toEqual([{ id: "long", name: "Long", program: "ok.exe" }]);
    expect(result.skipped.map((skipped) => skipped.name)).toEqual(["Long", "Nul"]);
    expect(result.skipped[0]?.reason).toMatch(/^program: /);
    expect(result.skipped[1]?.reason).toMatch(/NUL/);
  });

  it("makes profiles the settings file accepts, with the comments of the file kept", () => {
    const file = importProfiles(JSON_SETTINGS);
    if (!file.ok) throw new Error("fixture");
    const { profiles } = userProfilesFromImported(file.profiles, ["cmd"]);
    expect(profiles.map((profile) => profile.name)).toEqual(["Command Prompt", "Dev Shell"]);
    const config = '// mine\n{\n  "notifications": { "enabled": false }, // quiet\n}\n';
    const edited = editConfigText(config, [{ path: ["profiles"], append: profiles }]);
    const parsed = parseConfigText(edited);
    expect(parsed.ok, edited).toBe(true);
    expect(parsed.ok && parsed.config.profiles).toEqual(profiles);
    expect(edited).toContain("// mine");
    expect(edited).toContain('"enabled": false }, // quiet');
  });

  it("never throws, and every profile it makes is valid and unique", () => {
    const entry = fc.record({
      name: fc.string({ unit: "binary", maxLength: 80 }),
      commandLine: fc.option(fc.string({ unit: "binary", maxLength: 120 }), { nil: null }),
      startingDirectory: fc.option(fc.string({ unit: "binary", maxLength: 60 }), { nil: null }),
      colorScheme: fc.constant(null),
    });
    fc.assert(
      fc.property(
        fc.array(entry, { maxLength: 12 }),
        fc.array(fc.constantFrom("pwsh", "cmd", "shell", "profile", "default"), { maxLength: 4 }),
        (entries, taken) => {
          const result = userProfilesFromImported(entries, taken);
          expect(result.profiles.length + result.skipped.length).toBe(entries.length);
          const ids = result.profiles.map((profile) => profile.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const profile of result.profiles) {
            expect(UserProfileSchema.safeParse(profile).success).toBe(true);
            expect(taken).not.toContain(profile.id);
            expect(profile.id).not.toBe("default");
          }
          expect(profilesProblem(result.profiles, taken)).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
    // Values that are not what the types say.
    expect(() =>
      userProfilesFromImported([null, 5, { name: 7 }] as unknown as ImportedProfile[]),
    ).not.toThrow();
  });
});

describe("profilesProblem", () => {
  const profile = (id: string, program = "sh"): UserProfile => ({ id, name: id, program });

  it("accepts a good list, an empty one and profiles with every field", () => {
    expect(profilesProblem([])).toBeUndefined();
    expect(profilesProblem([profile("a"), profile("b")], ["c"])).toBeUndefined();
    expect(
      profilesProblem([
        { id: "dev-shell", name: "Dev", program: "pwsh.exe", args: ["-NoLogo"], cwd: "C:\\w" },
      ]),
    ).toBeUndefined();
  });

  it("refuses an empty or blank program, naming the profile", () => {
    for (const program of ["", "  ", "\t"]) {
      const problem = profilesProblem([profile("ok"), { ...profile("bad"), program }]);
      expect(problem, JSON.stringify(program)).toBe("Profile 2: program: The program is empty");
    }
  });

  it("refuses a list that has an id twice, `default`, a taken id or too many profiles", () => {
    expect(profilesProblem([profile("a"), profile("a")])).toBe(
      'Profile "a": the id "a" is used by another profile',
    );
    expect(profilesProblem([profile("default")])).toBe(
      'Profile "default": the id "default" is reserved',
    );
    expect(profilesProblem([profile("cmd")], ["cmd"])).toBe(
      'Profile "cmd": the id "cmd" is already a shell of this machine',
    );
    const many = Array.from({ length: MAX_USER_PROFILES + 1 }, (_, n) => profile(`p${n}`));
    expect(profilesProblem(many)).toMatch(/more than 200/);
  });

  it("refuses what is not a profile, without throwing", () => {
    for (const bad of [
      null,
      "sh",
      7,
      [],
      {},
      { id: "A", name: "a", program: "sh" },
      { id: "a", name: " ", program: "sh" },
      { id: "a", name: "a", program: "sh\0" },
      { id: "a", name: "a", program: "sh", args: "-l" },
      { id: "a", name: "a", program: "sh", args: ["a\0"] },
      { id: "a", name: "a", program: "sh", cwd: "" },
      { id: "a", name: "a", program: "sh", extra: 1 },
    ]) {
      expect(typeof profilesProblem([bad]), JSON.stringify(bad)).toBe("string");
    }
  });
});

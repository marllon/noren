import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "@noren/model";
import type { Config, UserProfile } from "@noren/model";
import { planSave, shownSettings } from "./settings-screen";
import {
  argsOfText,
  isSshRow,
  newProfileId,
  planProfiles,
  profileRowsOf,
  withNewProfile,
  withProfileEdited,
  withSavedIds,
  withoutProfile,
} from "./settings-profiles";
import type { ProfileField, ProfileRow } from "./settings-profiles";

const FILE = `// My settings, keep this line.
{
  "notifications": { "enabled": false }, // quiet

  /* my shells */
  "profiles": [
    // the first one
    { "id": "dev", "name": "Dev", "program": "pwsh.exe", "args": ["-NoLogo"], "cwd": "C:\\\\dev" }, // keep
    {
      "id": "ops", // the second
      "name": "Ops",
      "program": "bash",
    },
  ],
  // end
}
`;

const config = (text: string): Config => {
  const read = parseConfigText(text);
  if (!read.ok) throw new Error("the text of the test is not a valid file");
  return read.config;
};

/** The profiles of the file after the rows are saved, the way the screen does it. */
function saved(text: string, rows: readonly ProfileRow[], taken: string[] = []) {
  const plan = planProfiles(config(text), rows, taken);
  const next = editConfigText(text, plan.changes);
  const read = parseConfigText(next);
  if (!read.ok) throw new Error(`not valid after saving:\n${next}`);
  return { text: next, profiles: read.config.profiles ?? [], plan };
}

const rows = (): ProfileRow[] => profileRowsOf(config(FILE));

describe("the rows of the profiles", () => {
  it("list the profiles of the file with their boxes as text", () => {
    expect(rows()).toEqual([
      {
        key: "dev",
        saved: true,
        name: "Dev",
        program: "pwsh.exe",
        args: "-NoLogo",
        cwd: "C:\\dev",
      },
      { key: "ops", saved: true, name: "Ops", program: "bash", args: "", cwd: "" },
    ]);
    expect(profileRowsOf({})).toEqual([]);
  });

  it("are the draft once the person touched the list, the file before", () => {
    const base = config(FILE);
    expect(shownSettings(base, {}).profiles).toEqual(rows());
    const touched = withoutProfile(rows(), "dev");
    expect(shownSettings(base, { profiles: touched }).profiles).toEqual(touched);
  });

  it("add an empty row with a key nothing uses, edit one row, and drop one row", () => {
    const first = withNewProfile(rows());
    const second = withNewProfile(first);
    expect(second.map((row) => row.key)).toEqual(["dev", "ops", "new-1", "new-2"]);
    expect(second[3]).toEqual({
      key: "new-2",
      saved: false,
      name: "",
      program: "",
      args: "",
      cwd: "",
    });
    expect(withProfileEdited(rows(), "ops", { name: "Operations" })[1]?.name).toBe("Operations");
    expect(withProfileEdited(rows(), "ops", { name: "x" })[0]).toEqual(rows()[0]);
    expect(withoutProfile(rows(), "dev").map((row) => row.key)).toEqual(["ops"]);
  });
});

describe("argsOfText and newProfileId", () => {
  it("take one argument to a line and leave blank lines out", () => {
    expect(argsOfText("-l\n\n  \n-i\r\n--rcfile x y")).toEqual(["-l", "-i", "--rcfile x y"]);
    expect(argsOfText("")).toEqual([]);
    expect(argsOfText("  keep  spaces ")).toEqual(["  keep  spaces "]);
  });

  it("make the id from the name, and add a number when something has it", () => {
    const taken = new Set(["pwsh", "default"]);
    expect(newProfileId("My Dev Shell", taken)).toBe("my-dev-shell");
    expect(newProfileId("My Dev Shell", taken)).toBe("my-dev-shell-2");
    expect(newProfileId("pwsh", taken)).toBe("pwsh-2");
    expect(newProfileId("Default", taken)).toBe("default-2");
    expect(newProfileId("???", taken)).toBe("profile");
  });
});

describe("planProfiles", () => {
  it("writes nothing for rows that are as the file has them, or for no draft", () => {
    expect(planProfiles(config(FILE), undefined).changes).toEqual([]);
    expect(planProfiles(config(FILE), rows()).changes).toEqual([]);
    expect(planProfiles({}, []).changes).toEqual([]);
  });

  it("adds a profile at the end and keeps the file as it was", () => {
    const added = withProfileEdited(withNewProfile(rows()), "new-1", {
      name: "Build Box",
      program: "cmd.exe",
      args: "/k\nvcvars64.bat",
      cwd: "D:\\build",
    });
    const out = saved(FILE, added);
    expect(out.profiles.at(-1)).toEqual({
      id: "build-box",
      name: "Build Box",
      program: "cmd.exe",
      args: ["/k", "vcvars64.bat"],
      cwd: "D:\\build",
    });
    expect(out.profiles.slice(0, 2)).toEqual(config(FILE).profiles);
    for (const comment of ["// My settings, keep this line.", "// quiet", "/* my shells */"]) {
      expect(out.text).toContain(comment);
    }
    expect(out.text).toContain("// the first one");
    expect(out.text).toContain("// the second");
    expect(out.text).toContain("// end");
  });

  it("adds the first profile to a file that has no list, and to no file at all", () => {
    const one = withProfileEdited(withNewProfile([]), "new-1", { name: "Zed", program: "zsh" });
    expect(saved('{ "notifications": { "enabled": false } }', one).profiles).toEqual([
      { id: "zed", name: "Zed", program: "zsh" },
    ]);
    const plan = planProfiles({}, one);
    expect(parseConfigText(editConfigText(null, plan.changes)).ok).toBe(true);
  });

  it("gives a new profile an id no other profile and no shell of the machine has", () => {
    const two = withNewProfile(withNewProfile(rows()));
    const named = withProfileEdited(
      withProfileEdited(two, "new-1", { name: "Ops", program: "a" }),
      "new-2",
      { name: "PowerShell", program: "b" },
    );
    const out = saved(FILE, named, ["powershell"]);
    expect(out.profiles.slice(2).map((profile) => profile.id)).toEqual(["ops-2", "powershell-2"]);
  });

  it("edits the name, the program, the arguments and the folder of a profile, and only those", () => {
    const edited = withProfileEdited(rows(), "dev", {
      name: "Developer",
      program: "pwsh-preview.exe",
      args: "-NoLogo\n-NoProfile",
      cwd: "D:\\work",
    });
    const plan = planProfiles(config(FILE), edited);
    expect(plan.problems).toEqual({});
    expect(plan.changes.map((c) => c.path.join("."))).toEqual([
      "profiles.0.name",
      "profiles.0.program",
      "profiles.0.args",
      "profiles.0.cwd",
    ]);
    const out = saved(FILE, edited);
    expect(out.profiles[0]).toEqual({
      id: "dev",
      name: "Developer",
      program: "pwsh-preview.exe",
      args: ["-NoLogo", "-NoProfile"],
      cwd: "D:\\work",
    });
    expect(out.profiles[1]).toEqual(config(FILE).profiles?.[1]);
    expect(out.text).toContain("// keep");
    expect(out.text).toContain("// the second");
  });

  it("edits one box and leaves the others and the id alone", () => {
    const out = saved(FILE, withProfileEdited(rows(), "ops", { name: "Operations" }));
    expect(out.text).toBe(FILE.replace('"name": "Ops"', '"name": "Operations"'));
  });

  it("adds arguments and a folder to a profile that had none, in the order of the schema", () => {
    const out = saved(FILE, withProfileEdited(rows(), "ops", { args: "-l", cwd: "/srv" }));
    expect(out.profiles[1]).toEqual({
      id: "ops",
      name: "Ops",
      program: "bash",
      args: ["-l"],
      cwd: "/srv",
    });
    expect(out.text.indexOf('"args": ["-l"]')).toBeLessThan(out.text.indexOf('"cwd": "/srv"'));
    expect(out.text).toContain('"id": "ops", // the second');
  });

  it("takes the arguments and the folder out of the file when their boxes are emptied", () => {
    const out = saved(FILE, withProfileEdited(rows(), "dev", { args: "  \n", cwd: " " }));
    expect(out.profiles[0]).toEqual({ id: "dev", name: "Dev", program: "pwsh.exe" });
    expect(out.text).toContain("// keep");
  });

  it("removes a profile of the file and keeps the others and the comments", () => {
    const first = saved(FILE, withoutProfile(rows(), "dev"));
    expect(first.profiles.map((profile) => profile.id)).toEqual(["ops"]);
    const last = saved(FILE, withoutProfile(rows(), "ops"));
    expect(last.profiles.map((profile) => profile.id)).toEqual(["dev"]);
    for (const out of [first, last]) {
      for (const comment of [
        "// My settings, keep this line.",
        "// quiet",
        "/* my shells */",
        "// end",
      ]) {
        expect(out.text).toContain(comment);
      }
    }
    const none = saved(FILE, []);
    expect(none.profiles).toEqual([]);
    expect(none.text).toContain("/* my shells */");
  });

  it("does an edit, a removal and an addition in one save", () => {
    const draft = withProfileEdited(
      withNewProfile(withoutProfile(withProfileEdited(rows(), "ops", { program: "fish" }), "dev")),
      "new-1",
      { name: "Fresh", program: "nu" },
    );
    const out = saved(FILE, draft);
    expect(out.profiles).toEqual<UserProfile[]>([
      { id: "ops", name: "Ops", program: "fish" },
      { id: "fresh", name: "Fresh", program: "nu" },
    ]);
    expect(out.text).toContain("// quiet");
  });

  it("ignores a new row that was left empty", () => {
    expect(planProfiles(config(FILE), withNewProfile(rows())).changes).toEqual([]);
  });

  it("reports what the schema finds wrong in each box and writes nothing for that row", () => {
    const bad = withProfileEdited(withNewProfile(rows()), "new-1", { name: "  ", program: "x" });
    const plan = planProfiles(config(FILE), bad);
    expect(plan.problems).toEqual({ "new-1": { name: expect.any(String) } });
    expect(plan.changes).toEqual([]);

    const worse = withProfileEdited(rows(), "dev", { name: "", program: "", cwd: "x\0y" });
    const found = planProfiles(config(FILE), worse).problems["dev"];
    expect(Object.keys(found ?? {}).sort()).toEqual(["cwd", "name", "program"]);
  });

  it("refuses a name or a program with nothing but blanks, and one that is too long", () => {
    const blank = withProfileEdited(rows(), "ops", { program: "   " });
    expect(planProfiles(config(FILE), blank).problems["ops"]?.program).toBeDefined();
    const long = withProfileEdited(rows(), "ops", { name: "n".repeat(101) });
    expect(planProfiles(config(FILE), long).problems["ops"]?.name).toBeDefined();
  });

  it("leaves a row alone whose profile left the file while the screen was open", () => {
    const stale = [
      ...rows(),
      { key: "gone", saved: true, name: "G", program: "g", args: "", cwd: "" },
    ];
    expect(planProfiles(config(FILE), stale).changes).toEqual([]);
  });
});

describe("a profile of kind ssh in the file", () => {
  const WITH_SSH = `{
  "profiles": [
    { "id": "dev", "name": "Dev", "program": "pwsh.exe" },
    // the build machine
    {
      "kind": "ssh",
      "id": "build",
      "name": "Build",
      "host": "build.example.org",
      "port": 2222,
      "identityFile": "C:\\\\keys\\\\id_ed25519",
    },
    { "id": "ops", "name": "Ops", "program": "bash" }
  ]
}
`;

  const sshRows = (): ProfileRow[] => profileRowsOf(config(WITH_SSH));

  it("has a row of its own with the boxes of the machine, next to the shells", () => {
    expect(sshRows().map((row) => row.key)).toEqual(["dev", "build", "ops"]);
    expect(sshRows()[1]).toEqual({
      key: "build",
      saved: true,
      kind: "ssh",
      name: "Build",
      host: "build.example.org",
      user: "",
      port: "2222",
      identityFile: "C:\\keys\\id_ed25519",
      knownHostsFile: "",
      program: "",
      args: "",
      cwd: "",
    });
    expect(isSshRow(sshRows()[1] as ProfileRow)).toBe(true);
    expect(isSshRow(sshRows()[0] as ProfileRow)).toBe(false);
  });

  it("is as the file has it when nothing was touched", () => {
    expect(planProfiles(config(WITH_SSH), sshRows()).changes).toEqual([]);
  });

  it("is changed box by box, keeping the comments, and an emptied optional box leaves the file", () => {
    const edited = withProfileEdited(sshRows(), "build", {
      host: "10.0.0.7",
      user: "deploy",
      port: "",
      identityFile: "",
      knownHostsFile: "C:\\keys\\known_hosts",
      program: "bash",
      args: "-l\n-i",
      cwd: "/srv/app",
    });
    const result = saved(WITH_SSH, edited);
    expect(result.profiles[1]).toEqual({
      kind: "ssh",
      id: "build",
      name: "Build",
      host: "10.0.0.7",
      user: "deploy",
      knownHostsFile: "C:\\keys\\known_hosts",
      program: "bash",
      args: ["-l", "-i"],
      cwd: "/srv/app",
    });
    expect(result.text).toContain("// the build machine");
    expect(result.profiles[0]).toEqual({ id: "dev", name: "Dev", program: "pwsh.exe" });
  });

  it("is removed with its row, the shells around it staying", () => {
    const result = saved(WITH_SSH, withoutProfile(sshRows(), "build"));
    expect(result.profiles.map((profile) => profile.id)).toEqual(["dev", "ops"]);
  });

  it("is not edited through a stale row of the other kind that has its id", () => {
    const stale = [{ key: "build", saved: true, name: "B", program: "b", args: "", cwd: "" }];
    expect(planProfiles(config(WITH_SSH), stale).changes).toEqual([
      { path: ["profiles", 2], remove: true },
      { path: ["profiles", 0], remove: true },
    ]);
  });

  it("keeps its id away from a new profile", () => {
    const draft = withProfileEdited(withNewProfile(sshRows()), "new-1", {
      name: "Build",
      program: "sh",
    });
    const append = planProfiles(config(WITH_SSH), draft).changes.find((c) => "append" in c);
    expect(append && "append" in append ? append.append : []).toEqual([
      { id: "build-2", name: "Build", program: "sh" },
    ]);
  });
});

describe("a new profile of kind ssh", () => {
  const filled = (patch: Partial<Record<ProfileField, string>> = {}): ProfileRow[] =>
    withProfileEdited(withNewProfile(rows(), "ssh"), "new-1", {
      name: "Build Box",
      host: "build.example.org",
      ...patch,
    });

  it("starts as an empty row of kind ssh with the boxes of the machine", () => {
    expect(withNewProfile(rows(), "ssh")[2]).toEqual({
      key: "new-1",
      saved: false,
      kind: "ssh",
      name: "",
      program: "",
      args: "",
      cwd: "",
      host: "",
      user: "",
      port: "",
      identityFile: "",
      knownHostsFile: "",
    });
    // The shell row is what it was: no boxes of a machine.
    expect(withNewProfile(rows())[2]).not.toHaveProperty("host");
  });

  it("is left out while empty, and written with only the boxes that have something", () => {
    expect(planProfiles(config(FILE), withNewProfile(rows(), "ssh")).changes).toEqual([]);
    const out = saved(FILE, filled());
    expect(out.profiles.at(-1)).toEqual({
      kind: "ssh",
      id: "build-box",
      name: "Build Box",
      host: "build.example.org",
    });
    expect(out.text).toContain("// My settings, keep this line.");
  });

  it("is written with every box, the port as a number, and no program when none was typed", () => {
    const out = saved(
      FILE,
      filled({
        user: " deploy ",
        port: "2222",
        identityFile: "C:\\keys\\id_ed25519",
        knownHostsFile: "C:\\keys\\known_hosts",
        program: "bash",
        args: "-l",
        cwd: "/srv/app",
      }),
    );
    expect(out.profiles.at(-1)).toEqual({
      kind: "ssh",
      id: "build-box",
      name: "Build Box",
      host: "build.example.org",
      user: "deploy",
      port: 2222,
      identityFile: "C:\\keys\\id_ed25519",
      knownHostsFile: "C:\\keys\\known_hosts",
      program: "bash",
      args: ["-l"],
      cwd: "/srv/app",
    });
  });

  it("is refused by the schema, box by box, and nothing of it is written", () => {
    const cases: [Partial<Record<ProfileField, string>>, ProfileField][] = [
      [{ host: "" }, "host"],
      [{ host: "-oProxyCommand=x" }, "host"],
      [{ host: "has space" }, "host"],
      [{ user: "-x" }, "user"],
      [{ port: "abc" }, "port"],
      [{ port: "22.5" }, "port"],
      [{ port: "0" }, "port"],
      [{ port: "70000" }, "port"],
      [{ identityFile: "key\u0001" }, "identityFile"],
      [{ knownHostsFile: "a\nb" }, "knownHostsFile"],
      [{ name: "   " }, "name"],
    ];
    for (const [patch, field] of cases) {
      const plan = planProfiles(config(FILE), filled(patch));
      expect(plan.problems["new-1"]?.[field], JSON.stringify(patch)).toBeDefined();
      expect(plan.changes, JSON.stringify(patch)).toEqual([]);
    }
    expect(planProfiles(config(FILE), filled({ port: "abc" })).problems["new-1"]?.port).toBe(
      "Must be a whole number",
    );
  });

  it("holds a saved row to the same checks, and writes none of it while a box is wrong", () => {
    const text = `{ "profiles": [{ "kind": "ssh", "id": "box", "name": "Box", "host": "h", "port": 22 }] }`;
    const bad = withProfileEdited(profileRowsOf(config(text)), "box", { host: "", user: "ok" });
    const plan = planProfiles(config(text), bad);
    expect(Object.keys(plan.problems["box"] ?? {})).toEqual(["host"]);
    expect(plan.changes).toEqual([]);
    expect(planSave(config(text), { profiles: bad }).profileProblems["box"]?.host).toBeDefined();
  });

  it("has no box for a password, a passphrase or the text of a key", () => {
    const row = withNewProfile([], "ssh")[0] as ProfileRow;
    expect(Object.keys(row).filter((key) => /pass|secret|private/i.test(key))).toEqual([]);
    const written = saved("{}", filled()).profiles[0] as Record<string, unknown>;
    expect(Object.keys(written).filter((key) => /pass|secret|private/i.test(key))).toEqual([]);
  });
});

describe("planSave with the profiles", () => {
  it("joins them to the other sections, and reports their problems apart", () => {
    const draft = withProfileEdited(rows(), "dev", { name: "" });
    const plan = planSave(config(FILE), { profiles: draft, terminal: { bell: "sound" } });
    expect(plan.profileProblems["dev"]?.name).toBeDefined();
    expect(plan.changes.map((c) => c.path.join("."))).toEqual(["terminal.bell"]);
  });

  it("knows the shells of the machine, which a new profile cannot be named after", () => {
    const draft = withProfileEdited(withNewProfile(rows()), "new-1", {
      name: "WSL",
      program: "wsl",
    });
    const plan = planSave(config(FILE), { profiles: draft }, { takenProfileIds: ["wsl"] });
    const append = plan.changes.find((c) => "append" in c);
    expect(append && "append" in append ? append.append : []).toEqual([
      { id: "wsl-2", name: "WSL", program: "wsl" },
    ]);
  });
});

describe("a new profile that is written as the person fills it in (NOR-F20-10c)", () => {
  const filled = (): ProfileRow[] =>
    withNewProfile(rows()).map((row) =>
      row.saved ? row : { ...row, name: "Work", program: "pwsh" },
    );

  it("tells the id each new row gets, so the row can become that profile", () => {
    const plan = planProfiles(config(FILE), filled());
    expect(plan.ids).toEqual({ "new-1": "work" });
    expect(plan.changes).toEqual([
      { path: ["profiles"], append: [expect.objectContaining({ id: "work" })] },
    ]);
  });

  it("gives the next id of a name that is taken, and none to a row that is not valid yet", () => {
    const second = withNewProfile(filled()).map((row) =>
      row.key === "new-2" ? { ...row, name: "Work", program: "cmd" } : row,
    );
    expect(planProfiles(config(FILE), second).ids).toEqual({ "new-1": "work", "new-2": "work-2" });

    const half = withNewProfile(rows()).map((row) => (row.saved ? row : { ...row, name: "Half" }));
    const plan = planProfiles(config(FILE), half);
    expect(plan.ids).toEqual({});
    expect(plan.problems["new-1"]).toBeDefined();
  });

  it("holds a row the person is still in: its problems are told, nothing of it is written", () => {
    const held = planProfiles(config(FILE), filled(), [], new Set(["new-1"]));
    expect(held.changes).toEqual([]);
    expect(held.ids).toEqual({});

    const half = withNewProfile(rows()).map((row) => (row.saved ? row : { ...row, name: "Half" }));
    expect(
      planProfiles(config(FILE), half, [], new Set(["new-1"])).problems["new-1"],
    ).toBeDefined();
  });

  it("holds only the row asked for, and still edits the profiles of the file", () => {
    const edited = withProfileEdited(filled(), "ops", { program: "fish" });
    const plan = planProfiles(config(FILE), edited, [], new Set(["new-1"]));
    expect(plan.changes).toEqual([{ path: ["profiles", 1, "program"], value: "fish" }]);
  });

  it("turns the new rows into the profiles of the file once they are written", () => {
    const plan = planProfiles(config(FILE), filled());
    const after = withSavedIds(filled(), plan.ids);
    expect(after.map((row) => [row.key, row.saved])).toEqual([
      ["dev", true],
      ["ops", true],
      ["work", true],
    ]);
    // A row with no id (blank, or not valid yet) stays a new row.
    const blank = withNewProfile(rows());
    expect(withSavedIds(blank, {})).toEqual(blank);
    expect(withSavedIds(blank, { "new-9": "other" })).toEqual(blank);
  });
});

import { describe, expect, it } from "vitest";
import { editConfigText, parseConfigText } from "@noren/model";
import type { Config, UserProfile } from "@noren/model";
import { planSave, shownSettings } from "./settings-screen";
import {
  argsOfText,
  newProfileId,
  planProfiles,
  profileRowsOf,
  withNewProfile,
  withProfileEdited,
  withoutProfile,
} from "./settings-profiles";
import type { ProfileRow } from "./settings-profiles";

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
  // The screen has no boxes for the host, the key and the rest yet: such a profile is written in
  // the file by hand, and the screen must not show it as a shell with no program, make Save refuse
  // for that, rewrite it or drop it.
  const WITH_SSH = `{
  "profiles": [
    { "id": "dev", "name": "Dev", "program": "pwsh.exe" },
    // the build machine
    { "kind": "ssh", "id": "build", "name": "Build", "host": "build.example.org", "port": 2222 },
    { "id": "ops", "name": "Ops", "program": "bash" }
  ]
}
`;

  it("has no row, so the screen lists only the shells", () => {
    expect(profileRowsOf(config(WITH_SSH)).map((row) => row.key)).toEqual(["dev", "ops"]);
  });

  it("is neither changed nor removed when the shells around it are edited or removed", () => {
    const edited = withProfileEdited(profileRowsOf(config(WITH_SSH)), "ops", { program: "zsh" });
    const result = saved(WITH_SSH, withoutProfile(edited, "dev"));
    expect(result.profiles).toEqual([
      { kind: "ssh", id: "build", name: "Build", host: "build.example.org", port: 2222 },
      { id: "ops", name: "Ops", program: "zsh" },
    ]);
    expect(result.text).toContain("// the build machine");
  });

  it("keeps its id away from a new profile", () => {
    const draft = withProfileEdited(withNewProfile(profileRowsOf(config(WITH_SSH))), "new-1", {
      name: "Build",
      program: "sh",
    });
    const append = planProfiles(config(WITH_SSH), draft).changes.find((c) => "append" in c);
    expect(append && "append" in append ? append.append : []).toEqual([
      { id: "build-2", name: "Build", program: "sh" },
    ]);
  });

  it("is not edited through a stale row that has its id (the shells with no row go, it stays)", () => {
    const stale = [{ key: "build", saved: true, name: "B", program: "b", args: "", cwd: "" }];
    expect(planProfiles(config(WITH_SSH), stale).changes).toEqual([
      { path: ["profiles", 2], remove: true },
      { path: ["profiles", 0], remove: true },
    ]);
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

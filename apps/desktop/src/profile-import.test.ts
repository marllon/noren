import { ConfigManager, FakeBackend, parseConfigText } from "@noren/model";
import {
  JSON_BROKEN,
  JSON_PROFILES_FILE,
  JSON_SCHEME_LIST,
  NOT_A_SCHEME,
} from "@noren/model/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROFILE_FILE_BYTES,
  commitProfileImport,
  readProfileFile,
  takenProfileIds,
} from "./profile-import";
import type { ProfileImportPlan } from "./profile-import";
import { getProfiles, resetProfiles, startProfiles } from "./profiles-store";
import type { PickedFile } from "./scheme-import";

function fileOf(name: string, text: string): PickedFile {
  return { name, size: new TextEncoder().encode(text).length, text: () => Promise.resolve(text) };
}

/** The shells the test machine has: one named like a profile of the fixture. */
const MACHINE = [
  { id: "fake", name: "Fake shell", default: true },
  { id: "git-bash", name: "Git Bash", default: false },
];

/** The settings file of the user: comments, a trailing comma and a setting of their own. */
const CONFIG = '// my notes\n{\n  "notifications": { "enabled": false }, // quiet\n}\n';

/** Everything the app wires together for profiles: the backend, the settings and the list. */
async function app(config: string | null = CONFIG) {
  const backend = new FakeBackend({ profiles: MACHINE, config });
  const settings = new ConfigManager();
  await settings.start(backend);
  const stop = await startProfiles(backend, settings);
  return { backend, settings, stop };
}

const names = (): string[] => getProfiles().map((profile) => profile.name);

async function planOf(
  settings: ConfigManager,
  text = JSON_PROFILES_FILE,
): Promise<ProfileImportPlan> {
  const read = await readProfileFile(
    fileOf("settings.json", text),
    takenProfileIds(settings.state.config, getProfiles()),
  );
  if (!read.ok) throw new Error(read.message);
  return read.plan;
}

beforeEach(() => resetProfiles());

describe("readProfileFile", () => {
  it("plans the profiles of the file with the hidden one ignored and counted, and the one with no command left out", async () => {
    const { settings, stop } = await app();
    const plan = await planOf(settings);
    expect(plan.fileName).toBe("settings.json");
    expect(plan.hidden).toBe(1);
    expect(plan.skipped).toEqual([{ name: "No Command", reason: "it has no command line" }]);
    expect(plan.profiles.map((profile) => profile.name)).toEqual([
      "Git Bash (2)",
      "Dev Shell",
      "Fake (2)",
      "Twice",
      "Twice (2)",
    ]);
    expect(plan.profiles.map((profile) => profile.name)).not.toContain("Old Shell");
    stop();
  });

  it("separates a command line with quotes into the program and its arguments", async () => {
    const { settings, stop } = await app();
    const plan = await planOf(settings);
    expect(plan.profiles[0]).toMatchObject({
      program: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: ["--login", "-i"],
      cwd: "%USERPROFILE%",
    });
    expect(plan.profiles[1]).toMatchObject({
      program: "pwsh.exe",
      args: ["-NoLogo", "-Command", "Set-Location 'C:\\My Files'"],
      cwd: "C:\\work",
    });
    stop();
  });

  it("gives ids that collide with no shell of the machine, none of the user and none of the file", async () => {
    const { settings, stop } = await app();
    const plan = await planOf(settings);
    const ids = plan.profiles.map((profile) => profile.id);
    expect(ids).toEqual(["git-bash-2", "dev-shell", "fake-2", "twice", "twice-2"]);
    for (const id of ids) expect(MACHINE.map((m) => m.id)).not.toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    stop();
  });

  it("says why a file is not one it can read, and reads nothing from one that is too large", async () => {
    const message = async (name: string, text: string): Promise<string> => {
      const read = await readProfileFile(fileOf(name, text), []);
      expect(read.ok).toBe(false);
      return read.ok ? "" : read.message;
    };
    expect(await message("notes.txt", NOT_A_SCHEME)).toMatch(/^Could not import "notes.txt": /);
    expect(await message("schemes.json", JSON_SCHEME_LIST)).toBe(
      'Could not import "schemes.json": This JSON file has no list of profiles',
    );
    expect(await message("broken.json", JSON_BROKEN)).toMatch(
      /^Could not import "broken.json": line 1/,
    );
    expect(await message("empty.json", "")).toMatch(/^Could not import "empty.json": /);

    let read = false;
    const big: PickedFile = {
      name: "big.json",
      size: MAX_PROFILE_FILE_BYTES + 1,
      text: () => {
        read = true;
        return Promise.resolve("{}");
      },
    };
    expect(await readProfileFile(big, [])).toEqual({
      ok: false,
      message: 'Could not import "big.json": the file is too large to be a settings file.',
    });
    expect(read).toBe(false);

    const unreadable: PickedFile = {
      name: "gone.json",
      size: 5,
      text: () => Promise.reject(new Error("denied")),
    };
    expect(await readProfileFile(unreadable, [])).toEqual({
      ok: false,
      message: 'Could not import "gone.json": the file could not be read.',
    });
  });

  it("says so when the file has profiles but none can be imported", async () => {
    const onlyHidden = '{ "profiles": [ { "name": "A", "commandline": "a", "hidden": true } ] }';
    const read = await readProfileFile(fileOf("h.json", onlyHidden), []);
    expect(read).toEqual({
      ok: false,
      message: 'Could not import "h.json": there is no profile to import: 1 profile is hidden.',
    });
    const noCommands = '{ "profiles": [ { "name": "A" }, { "name": "B", "commandline": "" } ] }';
    const second = await readProfileFile(fileOf("n.json", noCommands), []);
    expect(second.ok).toBe(false);
    expect(!second.ok && second.message).toContain("2 profiles have nothing to start");
  });

  it("never throws, whatever the file holds", async () => {
    // Not a dependency of this app: fast-check lives in @noren/model, so walk made-up texts instead.
    const pieces = [
      "{",
      "}",
      "[",
      "]",
      '"',
      ",",
      ":",
      "\\",
      " ",
      "\n",
      '"profiles"',
      '"list"',
      '"name"',
      '"commandline"',
      '"hidden"',
      "true",
      "null",
      "//",
      "/*",
      "*/",
      "x",
      "\0",
      "é",
    ];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let round = 0; round < 300; round++) {
      let text = "";
      for (let length = next() % 40; length > 0; length--) text += pieces[next() % pieces.length];
      const read = await readProfileFile(fileOf("any.json", text), ["fake"]);
      expect(typeof read.ok, text).toBe("boolean");
    }
    const shapes = [
      "null",
      "[]",
      "5",
      '{ "profiles": null }',
      '{ "profiles": [ null, 5, "x", [] ] }',
      '{ "profiles": { "list": "x" } }',
      '{ "profiles": [ { "name": 5, "commandline": 6 } ] }',
    ];
    for (const text of shapes) {
      const read = await readProfileFile(fileOf("shape.json", text), []);
      expect(read.ok, text).toBe(false);
    }
  });
});

describe("commitProfileImport", () => {
  it("adds the profiles to the settings file with its comments kept, and they appear in the list", async () => {
    const { backend, settings, stop } = await app();
    expect(names()).toEqual(["Fake shell", "Git Bash"]);
    const plan = await planOf(settings);

    const result = await commitProfileImport(plan, settings);
    expect(result).toEqual({
      ok: true,
      message:
        'Imported 5 profiles: "Git Bash (2)", "Dev Shell" and 3 more. Open one with "New ... tab" in the command palette.',
    });

    // The file: the comments are where they were, and the profiles are in it.
    const text = backend.configContent ?? "";
    expect(text.startsWith("// my notes\n{")).toBe(true);
    expect(text).toContain('"notifications": { "enabled": false }, // quiet');
    const parsed = parseConfigText(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.config.profiles?.map((profile) => profile.id)).toEqual([
      "git-bash-2",
      "dev-shell",
      "fake-2",
      "twice",
      "twice-2",
    ]);

    // The list: the machine's shells, then the imported ones; the hidden one is not there.
    await vi.waitFor(() =>
      expect(names()).toEqual([
        "Fake shell",
        "Git Bash",
        "Git Bash (2)",
        "Dev Shell",
        "Fake (2)",
        "Twice",
        "Twice (2)",
      ]),
    );
    expect(names()).not.toContain("Old Shell");

    // An imported profile starts what its command line said, in its folder.
    const id = await backend.createSession({ profileId: "dev-shell", cols: 80, rows: 24 });
    expect(backend.session(id)).toMatchObject({
      program: "pwsh.exe",
      args: ["-NoLogo", "-Command", "Set-Location 'C:\\My Files'"],
      cwd: "C:\\work",
    });
    stop();
  });

  it("starts nothing and runs nothing: reading and adding touch the settings file only", async () => {
    const { backend, settings, stop } = await app();
    const plan = await planOf(settings);
    await commitProfileImport(plan, settings);
    await vi.waitFor(() => expect(names()).toContain("Dev Shell"));
    expect(backend.callsTo("createSession")).toEqual([]);
    expect(backend.callsTo("write")).toEqual([]);
    expect(backend.commands).toEqual([]);
    expect(backend.callsTo("saveState")).toEqual([]);
    expect(backend.callsTo("saveUserTheme")).toEqual([]);
    expect(backend.callsTo("saveConfig")).toHaveLength(1);
    stop();
  });

  it("writes nothing when the plan is only read", async () => {
    const { backend, settings, stop } = await app();
    await planOf(settings);
    expect(backend.callsTo("saveConfig")).toEqual([]);
    expect(backend.configContent).toBe(CONFIG);
    expect(names()).toEqual(["Fake shell", "Git Bash"]);
    stop();
  });

  it("creates the settings file when there is none", async () => {
    const { backend, settings, stop } = await app(null);
    await commitProfileImport(await planOf(settings), settings);
    const parsed = parseConfigText(backend.configContent ?? "");
    expect(parsed.ok && parsed.config.profiles).toHaveLength(5);
    stop();
  });

  it("adds after the profiles the user already has, and importing the same file again numbers the ids", async () => {
    const { backend, settings, stop } = await app();
    await commitProfileImport(await planOf(settings), settings);
    await vi.waitFor(() => expect(names()).toContain("Twice (2)"));
    const second = await planOf(settings);
    expect(second.profiles.map((profile) => profile.id)).toEqual([
      "git-bash-3",
      "dev-shell-2",
      "fake-3",
      "twice-3",
      "twice-4",
    ]);
    await commitProfileImport(second, settings);
    const parsed = parseConfigText(backend.configContent ?? "");
    const ids = parsed.ok ? (parsed.config.profiles ?? []).map((profile) => profile.id) : [];
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    await vi.waitFor(() => expect(getProfiles()).toHaveLength(12));
    stop();
  });

  it("writes nothing and says why when the settings file has a problem of its own", async () => {
    const broken = '{ "appearance": { "tabs": 5 } }';
    const { backend, settings, stop } = await app(broken);
    const plan = await planOf(settings);
    const result = await commitProfileImport(plan, settings);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^The settings file has a problem, so nothing was saved/);
    expect(backend.callsTo("saveConfig")).toEqual([]);
    expect(backend.configContent).toBe(broken);
    stop();
  });

  it("says so when the disk refuses the write, and the list stays as it was", async () => {
    const { backend, settings, stop } = await app();
    backend.setConfigSaveFailure(new Error("disk full"));
    const result = await commitProfileImport(await planOf(settings), settings);
    expect(result).toEqual({ ok: false, message: "Could not write config.jsonc: disk full" });
    expect(backend.configContent).toBe(CONFIG);
    expect(names()).toEqual(["Fake shell", "Git Bash"]);
    stop();
  });

  it("keeps a list the file already had in a style of its own", async () => {
    const own =
      '// shells\n{\n  "profiles": [\n    { "id": "mine", "name": "Mine", "program": "zsh" }, // mine\n  ],\n}\n';
    const { backend, settings, stop } = await app(own);
    expect(names()).toEqual(["Fake shell", "Git Bash", "Mine"]);
    await commitProfileImport(await planOf(settings), settings);
    const text = backend.configContent ?? "";
    expect(text.startsWith('// shells\n{\n  "profiles": [\n    { "id": "mine"')).toBe(true);
    expect(text).toContain('"program": "zsh" }, // mine\n');
    const parsed = parseConfigText(text);
    expect(parsed.ok && parsed.config.profiles?.[0]?.id).toBe("mine");
    expect(parsed.ok && parsed.config.profiles).toHaveLength(6);
    stop();
  });
});

describe("takenProfileIds", () => {
  it("is the ids in the list and the ids the file lists", () => {
    expect(
      takenProfileIds({ profiles: [{ id: "a", name: "A", program: "sh" }] }, [
        { id: "pwsh" },
        { id: "a" },
      ]).sort(),
    ).toEqual(["a", "a", "pwsh"]);
    expect(takenProfileIds({}, [])).toEqual([]);
  });
});

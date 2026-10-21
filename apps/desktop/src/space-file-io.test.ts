import {
  ConfigManager,
  FakeBackend,
  createDefaultWorkspace,
  exportSpace,
  parseConfigText,
  planProfiles,
} from "@noren/model";
import type { ExportRemovals, SpaceFile, UserProfile } from "@noren/model";
import { describe, expect, it, vi } from "vitest";
import {
  commitSpaceImport,
  exportFailureNotice,
  exportFileName,
  exportNotice,
  importNotice,
  readSpaceFile,
} from "./space-file-io";
import type { SpaceImportPlan } from "./space-file-io";
import type { PickedFile } from "./scheme-import";
import { activeSpaceOf } from "./workspace-store";

function fileOf(name: string, text: string): PickedFile {
  return { name, size: new TextEncoder().encode(text).length, text: () => Promise.resolve(text) };
}

const NOTHING: ExportRemovals = { env: [], commands: [], profiles: [] };

/** The file of a one-tab space, with the profiles given. */
function spaceFile(profiles: UserProfile[]): SpaceFile {
  const text = exportSpace(activeSpaceOf(createDefaultWorkspace()), { profiles: [] });
  if (!text.ok) throw new Error(text.error);
  return { ...text.file, profiles };
}

const NEWBIE: UserProfile = { id: "newbie", name: "Newbie", program: "nb.exe", args: ["-x"] };
const MINE: UserProfile = { id: "mine", name: "Mine", program: "sh" };

describe("exportFileName", () => {
  it("is the name of the space and the ending of a space file", () => {
    expect(exportFileName("Work")).toBe("Work.noren-space.json");
    expect(exportFileName("  Team  notes ")).toBe("Team notes.noren-space.json");
  });

  it("replaces what a file name cannot hold", () => {
    expect(exportFileName('a:b/c\\d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j.noren-space.json");
    expect(exportFileName("tab\there\u0000")).toBe("tab-here-.noren-space.json");
  });

  it("does not end in a dot or a space and falls back to space when nothing is left", () => {
    expect(exportFileName("Work...")).toBe("Work.noren-space.json");
    expect(exportFileName("")).toBe("space.noren-space.json");
    expect(exportFileName(" . ")).toBe("space.noren-space.json");
    expect(exportFileName("CON")).toBe("space.noren-space.json");
    expect(exportFileName("lpt1")).toBe("space.noren-space.json");
  });

  it("keeps a name to a sensible length", () => {
    expect(exportFileName("x".repeat(500))).toBe(`${"x".repeat(100)}.noren-space.json`);
  });
});

describe("exportNotice", () => {
  it("says where the file went", () => {
    expect(exportNotice("Work", "Work.noren-space.json", NOTHING)).toBe(
      'Exported space "Work" as Work.noren-space.json.',
    );
  });

  it("names what was left out", () => {
    expect(
      exportNotice("Work", "Work.noren-space.json", {
        env: ["GITHUB_TOKEN", "DB_PASSWORD"],
        commands: ["i1", "i3"],
        profiles: ["deploy"],
      }),
    ).toBe(
      'Exported space "Work" as Work.noren-space.json. Left out because they look like secrets: ' +
        "variables GITHUB_TOKEN, DB_PASSWORD; tab return commands: 2; profiles deploy.",
    );
  });

  it("has a sentence for an export that failed", () => {
    expect(exportFailureNotice("Work", "a page address holds a secret")).toBe(
      'Could not export space "Work": a page address holds a secret',
    );
  });
});

describe("readSpaceFile", () => {
  it("plans the profiles of a space file against the ones the user has", async () => {
    const text = `${JSON.stringify(spaceFile([NEWBIE, MINE, { ...MINE, id: "fake" }]))}`;
    const read = await readSpaceFile(fileOf("a.noren-space.json", text), [MINE], ["fake", "mine"]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.plan.fileName).toBe("a.noren-space.json");
    expect(read.plan.profiles.add).toEqual([NEWBIE]);
    expect(read.plan.profiles.reused).toEqual(["mine"]);
    expect(read.plan.profiles.conflicts).toEqual([{ id: "fake", name: "Mine", reason: "taken" }]);
  });

  it("answers a file that is not a space file with a short reason", async () => {
    const reason = async (name: string, text: string) => {
      const read = await readSpaceFile(fileOf(name, text), [], []);
      return read.ok ? "ok" : read.message;
    };
    expect(await reason("n.txt", "hello")).toBe('Could not import "n.txt": it is not valid JSON');
    expect(await reason("l.json", "[]")).toBe(
      'Could not import "l.json": it is not a Noren space file',
    );
    expect(await reason("v.json", '{"format":"noren-space","version":2}')).toBe(
      'Could not import "v.json": version 2 is not one this build reads (it reads version 1)',
    );
  });

  it("refuses a file that is too large without reading it", async () => {
    const text = vi.fn(() => Promise.resolve("{}"));
    const read = await readSpaceFile({ name: "big.json", size: 2_000_000, text }, [], []);
    expect(read).toEqual({
      ok: false,
      message: 'Could not import "big.json": the file is too large to be a space file.',
    });
    expect(text).not.toHaveBeenCalled();
  });

  it("answers a file that cannot be read", async () => {
    const read = await readSpaceFile(
      { name: "x.json", size: 2, text: () => Promise.reject(new Error("gone")) },
      [],
      [],
    );
    expect(read).toEqual({
      ok: false,
      message: 'Could not import "x.json": the file could not be read.',
    });
  });
});

describe("importNotice", () => {
  it("names the space, the profiles added and the ones in conflict", () => {
    const file = spaceFile([NEWBIE, { ...MINE, program: "other" }, { ...MINE, id: "fake" }]);
    const plan = planProfiles(file, [MINE], ["fake"]);
    expect(importNotice("Work", plan)).toBe(
      'Imported space "Work". Added to config.jsonc: "Newbie". ' +
        'Not added: "Mine" (you already have a different profile with the id mine); ' +
        '"Mine" (the id fake is a shell of this machine). ' +
        "The space keeps using the profile with that id.",
    );
  });

  it("is only the first sentence when the file brings no profile that needs saying", () => {
    expect(importNotice("Work", { add: [], reused: ["mine"], conflicts: [] })).toBe(
      'Imported space "Work".',
    );
  });
});

describe("commitSpaceImport", () => {
  const CONFIG =
    '// mine\n{\n  "profiles": [ { "id": "mine", "name": "Mine", "program": "sh" } ],\n}\n';

  async function app(config: string | null = CONFIG) {
    const backend = new FakeBackend({ config });
    const settings = new ConfigManager();
    await settings.start(backend);
    return { backend, settings };
  }

  function planOf(profiles: UserProfile[], existing: UserProfile[] = [MINE]): SpaceImportPlan {
    const file = spaceFile(profiles);
    return { fileName: "a.noren-space.json", file, profiles: planProfiles(file, existing) };
  }

  it("appends the new profiles to the settings, then makes the space", async () => {
    const { backend, settings } = await app();
    const order: string[] = [];
    const notice = await commitSpaceImport(planOf([NEWBIE, MINE]), {
      settings,
      syncProfiles: () => {
        order.push("sync");
        return Promise.resolve();
      },
      importSpace: () => order.push("space"),
    });
    expect(order).toEqual(["sync", "space"]);
    expect(notice).toBe('Imported space "Main". Added to config.jsonc: "Newbie".');

    const text = backend.configContent ?? "";
    expect(text.startsWith("// mine\n{")).toBe(true);
    const parsed = parseConfigText(text);
    expect(parsed.ok && parsed.config.profiles?.map((profile) => profile.id)).toEqual([
      "mine",
      "newbie",
    ]);
  });

  it("writes nothing when every profile of the file is already there", async () => {
    const { backend, settings } = await app();
    const importSpace = vi.fn();
    await commitSpaceImport(planOf([MINE]), { settings, importSpace });
    expect(importSpace).toHaveBeenCalledTimes(1);
    expect(backend.configContent).toBe(CONFIG);
  });

  it("leaves the profiles in conflict out of the settings", async () => {
    const { backend, settings } = await app();
    const importSpace = vi.fn();
    const notice = await commitSpaceImport(planOf([{ ...MINE, program: "other" }]), {
      settings,
      importSpace,
    });
    expect(notice).toContain("Not added:");
    expect(backend.configContent).toBe(CONFIG);
    expect(importSpace).toHaveBeenCalledTimes(1);
  });

  it("makes no space when the settings cannot be written, and says why", async () => {
    const { backend, settings } = await app('{ "appearance": { "tabs": 5 } }');
    const importSpace = vi.fn();
    const notice = await commitSpaceImport(planOf([NEWBIE]), { settings, importSpace });
    expect(notice).toContain("so nothing was imported: ");
    expect(importSpace).not.toHaveBeenCalled();
    expect(backend.configContent).toBe('{ "appearance": { "tabs": 5 } }');
  });

  it("makes the space even if the backend could not be told about the profiles yet", async () => {
    const { settings } = await app();
    const importSpace = vi.fn();
    await commitSpaceImport(planOf([NEWBIE]), {
      settings,
      syncProfiles: () => Promise.reject(new Error("nope")),
      importSpace,
    });
    expect(importSpace).toHaveBeenCalledTimes(1);
  });
});

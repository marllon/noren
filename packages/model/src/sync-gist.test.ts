import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  gistFileName,
  isSyncGistId,
  isSyncablePath,
  parseSyncGistStatus,
  pathOfGistFile,
  syncGistTokenProblem,
} from "./sync";

// The same cases as the tests of `noren-core::sync_gist` (`a_path_is_sent_as_one_flat_name_and_
// comes_back_the_same`, `only_the_closed_list_has_a_name_in_the_gist`, `a_name_that_does_not_come_
// back_to_a_path_of_the_list_is_refused`, `a_gist_id_is_letters_and_digits_only`), so the two sides
// of the rules cannot drift apart without a test saying so.

describe("the flat name of a path in a gist", () => {
  const cases: [string, string][] = [
    ["config.jsonc", "config.jsonc"],
    ["themes/lagoon.json", "themes--lagoon.json"],
    ["themes/sea-glass-2.json", "themes--sea-glass-2.json"],
    ["mods/tweak.css", "mods--tweak.css"],
    ["mods/a--b.css", "mods--a--b.css"],
    ["spaces/Work.noren-space.json", "spaces--Work.noren-space.json"],
    ["spaces/My notes (2).noren-space.json", "spaces--My notes (2).noren-space.json"],
    ["spaces/themes--x.noren-space.json", "spaces--themes--x.noren-space.json"],
  ];

  it("is flat and comes back to the same path", () => {
    for (const [path, name] of cases) {
      expect(gistFileName(path), path).toBe(name);
      expect(name.includes("/"), name).toBe(false);
      expect(pathOfGistFile(name), name).toBe(path);
    }
    expect(new Set(cases.map(([path]) => gistFileName(path))).size).toBe(cases.length);
  });

  it("exists only for the closed list", () => {
    for (const path of [
      "state.json",
      "gallery.json",
      "sync-gist.json",
      "sync-spaces.json",
      "themes/Bad Id.json",
      "themes/.json",
      "themes/a/b.json",
      "mods/x.txt",
      "spaces/x.json",
      "plugins/p/main.js",
      "scrollback/pane.txt",
      "config.jsonc.bak",
      "../config.jsonc",
      "",
    ]) {
      expect(gistFileName(path), JSON.stringify(path)).toBeUndefined();
    }
  });

  it("is refused for a name that does not come back to a path of the list", () => {
    for (const name of [
      "README.md",
      "notes.txt",
      "state.json",
      "sync-gist.json",
      "themes--.json",
      "themes--../x.json",
      "themes--..%2fx.json",
      "themes--Bad Id.json",
      "themes--a--b.json",
      "mods--x.txt",
      "mods--",
      "spaces--x.json",
      "spaces--.noren-space.json",
      "plugins--p.js",
      "themes/lagoon.json",
      "config.jsonc/",
      "themes--",
      "",
    ]) {
      expect(pathOfGistFile(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it("is one to one for any name (a property)", () => {
    const part = fc.string({ unit: "grapheme", maxLength: 24 });
    const folder = fc.constantFrom("themes", "mods", "spaces", "plugins", "", "config.jsonc");
    // Whatever name is given, if it stands for a path, the path is on the list and maps back to
    // exactly that name; and every path of the list maps to a name that stands for it.
    fc.assert(
      fc.property(fc.tuple(folder, fc.constantFrom("--", "-", "/", ""), part), ([f, sep, rest]) => {
        const name = `${f}${sep}${rest}`;
        const path = pathOfGistFile(name);
        if (path !== undefined) {
          expect(isSyncablePath(path)).toBe(true);
          expect(gistFileName(path)).toBe(name);
          expect(name.includes("/")).toBe(false);
        }
        const asPath = `${f}/${rest}`;
        const flat = gistFileName(asPath);
        if (flat !== undefined) expect(pathOfGistFile(flat)).toBe(asPath);
      }),
      { numRuns: 500 },
    );
  });
});

describe("isSyncGistId", () => {
  it("is letters and digits only, 1 to 64", () => {
    for (const good of ["aa5a315d61ae9438b18d", "1234567", "a".repeat(64), "A1"]) {
      expect(isSyncGistId(good), good).toBe(true);
    }
    for (const bad of ["", "a b", "a/b", "../x", "a?b=c", "a-b", "é", "a".repeat(65)]) {
      expect(isSyncGistId(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("syncGistTokenProblem", () => {
  it("accepts one run of visible ASCII, also with blanks around it", () => {
    for (const good of ["ghp_TestTokenNeverReal0123", "github_pat_11AAA_bbb", "  ghp_x\n", "a"]) {
      expect(syncGistTokenProblem(good), good).toBeUndefined();
    }
    expect(syncGistTokenProblem("t".repeat(1024))).toBeUndefined();
  });

  it("refuses the rest without repeating it", () => {
    for (const bad of [
      "",
      "   ",
      "two words",
      "ghp_with\ttab",
      "line\nbreak",
      "ação",
      "t".repeat(1025),
    ]) {
      const problem = syncGistTokenProblem(bad);
      expect(problem, JSON.stringify(bad)).toBeTypeOf("string");
      if (bad.trim() !== "") expect(problem?.includes(bad.trim())).toBe(false);
    }
  });
});

describe("parseSyncGistStatus", () => {
  const status = {
    connected: true,
    gistId: "aa5a315d61ae9438b18d",
    public: false,
    hasToken: true,
    pending: [{ path: "config.jsonc", change: "modified" }],
  };

  it("reads what the app answers", () => {
    expect(parseSyncGistStatus(status)).toEqual({ ok: true, value: status });
    const fresh = { connected: false, gistId: null, public: false, hasToken: false, pending: [] };
    expect(parseSyncGistStatus(fresh)).toEqual({ ok: true, value: fresh });
  });

  it("refuses a shape that is not the expected one", () => {
    const refused = (value: unknown) => parseSyncGistStatus(value).ok;
    expect(refused({ ...status, extra: 1 })).toBe(false);
    expect(refused({ ...status, gistId: "a/b" })).toBe(false);
    expect(refused({ ...status, hasToken: "yes" })).toBe(false);
    expect(refused({ ...status, public: undefined })).toBe(false);
    expect(refused({ ...status, pending: [{ path: "state.json", change: "added" }] })).toBe(false);
    expect(refused({ ...status, token: "ghp_x" })).toBe(false);
    expect(refused("connected")).toBe(false);
  });
});

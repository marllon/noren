import { describe, expect, it } from "vitest";
import {
  SYNC_LIMITS,
  isSyncSpaceFileName,
  isSyncablePath,
  parseSyncPull,
  parseSyncPush,
  parseSyncSpaceFolder,
  parseSyncStatus,
  syncRemoteProblem,
  syncSpaceWriteProblem,
} from "./sync";

// The same cases as the tests of `noren-core::sync` (`only_the_listed_names_may_travel`,
// `plain_addresses_are_accepted`, `addresses_that_carry_a_secret_or_a_trick_are_refused`), so the
// two sides of the rules cannot drift apart without a test saying so.

describe("isSyncablePath", () => {
  it("accepts the closed list of names", () => {
    for (const path of [
      "config.jsonc",
      "themes/midnight.json",
      "themes/a-b-1.json",
      "mods/tweak.css",
      "spaces/Work.noren-space.json",
      "spaces/my space.noren-space.json",
    ]) {
      expect(isSyncablePath(path), path).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const path of [
      "state.json",
      "gallery.json",
      "config.json",
      "scrollback/p1.txt",
      "plugins/x/plugin.json",
      "themes/Mid.json",
      "themes/notes.txt",
      "themes/con.json",
      "themes/sub/a.json",
      "mods/script.js",
      "mods/.hidden.css",
      "spaces/a.json",
      "spaces/.noren-space.json",
      "spaces/.hidden.noren-space.json",
      "spaces/a/b.noren-space.json",
      "spaces/con.noren-space.json",
      "spaces/a:b.noren-space.json",
      ".env",
      "sync/config.jsonc",
      "../config.jsonc",
      "",
    ]) {
      expect(isSyncablePath(path), path).toBe(false);
    }
  });
});

describe("syncRemoteProblem", () => {
  it("accepts plain addresses", () => {
    for (const url of [
      "https://example.com/me/settings.git",
      "ssh://git@example.com/me/settings.git",
      "ssh://example.com:2222/me/settings.git",
      "git@example.com:me/settings.git",
      "example.com:me/settings.git",
      "file:///srv/settings.git",
      "/srv/settings.git",
      "C:\\repos\\my settings.git",
      "C:/repos/settings.git",
    ]) {
      expect(syncRemoteProblem(url), url).toBeUndefined();
    }
  });

  it("refuses an address that carries a secret or a trick", () => {
    for (const url of [
      "",
      "-oProxyCommand=calc",
      "--upload-pack=calc",
      "ext::sh -c calc",
      "ext::calc",
      "fd::3",
      "hg::https://example.com/x",
      "https://user:token@example.com/x.git",
      "https://token@example.com/x.git",
      "ssh://user:secret@example.com/x.git",
      "ssh://-oProxyCommand=calc/x",
      "ssh://@example.com/x",
      "http://example.com/x.git",
      "ftp://example.com/x.git",
      "git://example.com/x.git",
      "https:///x.git",
      "https://exa mple.com/x.git",
      "user:password@example.com:x.git",
      "-host:path",
      "x:path",
      "relative/path.git",
      "noscheme",
      "file://",
      "https://example.com/x\n.git",
    ]) {
      expect(syncRemoteProblem(url), JSON.stringify(url)).toEqual(expect.any(String));
    }
    expect(syncRemoteProblem(`https://example.com/${"a".repeat(SYNC_LIMITS.remoteChars)}`)).toEqual(
      expect.any(String),
    );
  });
});

describe("what the app answers", () => {
  const status = {
    connected: true,
    remote: "/srv/notes.git",
    branch: "main",
    pending: [{ path: "config.jsonc", change: "modified" }],
    ahead: 1,
    behind: 0,
  };

  it("accepts a status, and the status of a sync that is not connected", () => {
    expect(parseSyncStatus(status)).toEqual({ ok: true, value: status });
    const none = { connected: false, remote: null, branch: null, pending: [], ahead: 0, behind: 0 };
    expect(parseSyncStatus(none)).toEqual({ ok: true, value: none });
  });

  it("refuses a status with a field missing, an extra one, or a path that may not travel", () => {
    const missing: Record<string, unknown> = { ...status };
    delete missing["ahead"];
    expect(parseSyncStatus(missing).ok).toBe(false);
    expect(parseSyncStatus({ ...status, extra: 1 }).ok).toBe(false);
    expect(parseSyncStatus({ ...status, ahead: -1 }).ok).toBe(false);
    expect(
      parseSyncStatus({ ...status, pending: [{ path: "state.json", change: "added" }] }).ok,
    ).toBe(false);
    expect(
      parseSyncStatus({ ...status, pending: [{ path: "config.jsonc", change: "gone" }] }).ok,
    ).toBe(false);
    expect(parseSyncStatus(null).ok).toBe(false);
  });

  it("accepts the three outcomes of a pull and refuses the rest", () => {
    for (const value of [
      { kind: "up_to_date" },
      { kind: "updated", files: ["config.jsonc", "themes/lagoon.json"] },
      { kind: "conflict", paths: ["config.jsonc"] },
    ]) {
      expect(parseSyncPull(value)).toEqual({ ok: true, value });
    }
    expect(parseSyncPull({ kind: "conflict", paths: [] }).ok).toBe(false);
    expect(parseSyncPull({ kind: "conflict", paths: ["state.json"] }).ok).toBe(false);
    expect(parseSyncPull({ kind: "updated" }).ok).toBe(false);
    expect(parseSyncPull({ kind: "merged" }).ok).toBe(false);
    expect(parseSyncPull({ kind: "up_to_date", files: [] }).ok).toBe(false);
  });

  it("accepts a push and refuses a malformed one", () => {
    const push = { committed: true, pushed: false, files: ["mods/tweak.css"] };
    expect(parseSyncPush(push)).toEqual({ ok: true, value: push });
    expect(parseSyncPush({ ...push, files: ["state.json"] }).ok).toBe(false);
    expect(parseSyncPush({ committed: true }).ok).toBe(false);
    const wrong = parseSyncPush({ ...push, pushed: "yes" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.length).toBeGreaterThan(0);
  });
});

// The space files (NOR-F19-01c): the names are the ones of the closed list, the answer of the app is
// checked, and a batch to write is checked the way `noren-core::sync_spaces` checks it.

describe("space file names", () => {
  it("are the names of the closed list without the folder", () => {
    for (const name of [
      "Work.noren-space.json",
      "my space.noren-space.json",
      "é.noren-space.json",
    ]) {
      expect(isSyncSpaceFileName(name), name).toBe(true);
    }
    for (const name of [
      "",
      "plain.json",
      "../x.noren-space.json",
      "a/b.noren-space.json",
      "a\\b.noren-space.json",
      ".hidden.noren-space.json",
      "con.noren-space.json",
      "a:b.noren-space.json",
      "trailing .noren-space.json",
      ".noren-space.json",
      `${"x".repeat(SYNC_LIMITS.spaceFileChars)}.noren-space.json`,
    ]) {
      expect(isSyncSpaceFileName(name), name).toBe(false);
    }
  });
});

describe("parseSyncSpaceFolder", () => {
  const hash = "0123456789abcdef".repeat(4);
  const folder = {
    files: [
      { name: "Work.noren-space.json", hash, linked: null },
      { name: "Play.noren-space.json", hash, linked: { spaceId: "s1", hash } },
    ],
    cloned: ["Theirs.noren-space.json"],
  };

  it("accepts what the app answers", () => {
    expect(parseSyncSpaceFolder(folder)).toEqual({ ok: true, value: folder });
    expect(parseSyncSpaceFolder({ files: [], cloned: [] }).ok).toBe(true);
  });

  it("rejects a name off the list, a hash that is not sha256, a field too many and a wrong shape", () => {
    const spoil = (change: object) => parseSyncSpaceFolder({ ...folder, ...change });
    expect(spoil({ files: [{ name: "state.json", hash, linked: null }] }).ok).toBe(false);
    expect(spoil({ files: [{ name: "A.noren-space.json", hash: "abc", linked: null }] }).ok).toBe(
      false,
    );
    expect(
      spoil({ files: [{ name: "A.noren-space.json", hash: hash.toUpperCase(), linked: null }] }).ok,
    ).toBe(false);
    expect(
      spoil({
        files: [{ name: "A.noren-space.json", hash, linked: { spaceId: "", hash } }],
      }).ok,
    ).toBe(false);
    expect(
      spoil({ files: [{ name: "A.noren-space.json", hash, linked: null, extra: 1 }] }).ok,
    ).toBe(false);
    expect(spoil({ cloned: ["../x.noren-space.json"] }).ok).toBe(false);
    expect(parseSyncSpaceFolder({ files: [] }).ok).toBe(false);
    expect(parseSyncSpaceFolder("files").ok).toBe(false);
    expect(parseSyncSpaceFolder(null).ok).toBe(false);
  });
});

describe("syncSpaceWriteProblem", () => {
  const file = (name: string, text = "{}", spaceId = "s1") => ({ name, text, spaceId });

  it("accepts a batch of names on the list", () => {
    expect(
      syncSpaceWriteProblem([file("Work.noren-space.json"), file("Play.noren-space.json")]),
    ).toBeUndefined();
    expect(syncSpaceWriteProblem([])).toBeUndefined();
  });

  it("names what is wrong", () => {
    expect(syncSpaceWriteProblem([file("../x.noren-space.json")])).toContain("not a name");
    expect(syncSpaceWriteProblem([file("Work.noren-space.json", "{}", "")])).toContain("id");
    expect(
      syncSpaceWriteProblem([file("Work.noren-space.json", "x".repeat(SYNC_LIMITS.fileBytes + 1))]),
    ).toContain("larger than 1024 KiB");
    // The ceiling is in bytes: a text of 3-byte characters passes it sooner than its length says.
    expect(
      syncSpaceWriteProblem([
        file("Work.noren-space.json", "€".repeat(SYNC_LIMITS.fileBytes / 3 + 1)),
      ]),
    ).toContain("larger than");
    expect(
      syncSpaceWriteProblem([
        file("Work.noren-space.json", "€".repeat(Math.floor(SYNC_LIMITS.fileBytes / 3))),
      ]),
    ).toBeUndefined();
    expect(
      syncSpaceWriteProblem([file("Work.noren-space.json"), file("work.noren-space.json")]),
    ).toContain("twice");
    const many = Array.from({ length: SYNC_LIMITS.files + 1 }, (_, n) =>
      file(`s${n}.noren-space.json`),
    );
    expect(syncSpaceWriteProblem(many)).toContain("more than 500");
  });
});

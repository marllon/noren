import { describe, expect, it } from "vitest";
import {
  SYNC_LIMITS,
  isSyncablePath,
  parseSyncPull,
  parseSyncPush,
  parseSyncStatus,
  syncRemoteProblem,
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

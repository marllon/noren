import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_METHOD,
  SYNC_METHODS,
  closePushDecision,
  parseConfigText,
  syncMethodOf,
} from "./index";
import type { SyncGistStatus } from "./index";

describe("syncMethodOf", () => {
  it("is git unless the settings say gist", () => {
    expect(DEFAULT_SYNC_METHOD).toBe("git");
    expect(SYNC_METHODS).toEqual(["git", "gist"]);
    expect(syncMethodOf(undefined)).toBe("git");
    expect(syncMethodOf({})).toBe("git");
    expect(syncMethodOf({ method: "git" })).toBe("git");
    expect(syncMethodOf({ method: "gist" })).toBe("gist");
  });
});

describe("sync.method in config.jsonc", () => {
  it("accepts git and gist", () => {
    for (const method of ["git", "gist"]) {
      const parsed = parseConfigText(`{ "sync": { "method": "${method}" } }`);
      expect(parsed.ok, method).toBe(true);
    }
  });

  it("refuses any other value and says where", () => {
    const parsed = parseConfigText('{ "sync": { "method": "ftp" } }');
    expect(parsed.ok).toBe(false);
  });
});

describe("closePushDecision with the status of a gist", () => {
  const gist = (over: Partial<SyncGistStatus> = {}): SyncGistStatus => ({
    connected: true,
    gistId: "abc123",
    public: false,
    hasToken: true,
    pending: [],
    ...over,
  });

  it("pushes when a file waits, though a gist status has no ahead", () => {
    const status = gist({ pending: [{ path: "config.jsonc", change: "modified" }] });
    expect(closePushDecision({ enabled: true, status, spaceFilesWritten: 0 })).toEqual({
      action: "push",
    });
  });

  it("skips with nothing waiting and with no gist connected", () => {
    expect(closePushDecision({ enabled: true, status: gist(), spaceFilesWritten: 0 })).toEqual({
      action: "skip",
      reason: "nothing-pending",
    });
    expect(
      closePushDecision({
        enabled: true,
        status: gist({ connected: false, gistId: null }),
        spaceFilesWritten: 3,
      }),
    ).toEqual({ action: "skip", reason: "no-remote" });
  });
});

import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { parseSyncPull, parseSyncPush, parseSyncStatus } from "./sync";

const REMOTE = "https://example.com/me/settings.git";

describe("FakeBackend sync", () => {
  it("starts not connected and refuses to pull or push until it is", async () => {
    const backend = new FakeBackend();
    expect(await backend.syncStatus()).toEqual({
      connected: false,
      remote: null,
      branch: null,
      pending: [],
      ahead: 0,
      behind: 0,
    });
    await expect(backend.syncPull()).rejects.toThrow("no remote is connected");
    await expect(backend.syncPush()).rejects.toThrow("no remote is connected");
    expect(backend.calls.map((call) => call.method)).toEqual([
      "syncStatus",
      "syncPull",
      "syncPush",
    ]);
  });

  it("refuses the addresses the app refuses", async () => {
    const backend = new FakeBackend();
    for (const url of ["ext::sh -c calc", "https://me:token@example.com/x.git", "-x", "x:y"]) {
      await expect(backend.syncConnect(url), url).rejects.toThrow("not a usable remote");
    }
    expect((await backend.syncStatus()).connected).toBe(false);
  });

  it("answers in the shapes the wire checks accept", async () => {
    const backend = new FakeBackend();
    backend.setSyncLocalFile("config.jsonc", "{}");
    const connected = await backend.syncConnect(REMOTE);
    expect(parseSyncStatus(connected).ok).toBe(true);
    expect(parseSyncPush(await backend.syncPush()).ok).toBe(true);
    backend.setSyncRemoteFile("themes/lagoon.json", "{}");
    expect(parseSyncPull(await backend.syncPull()).ok).toBe(true);
  });

  it("pushes what may travel and nothing else", async () => {
    const backend = new FakeBackend();
    backend.setSyncLocalFile("config.jsonc", "a");
    backend.setSyncLocalFile("themes/lagoon.json", "b");
    backend.setSyncLocalFile("state.json", "secret");
    backend.setSyncLocalFile("scrollback/p1.txt", "secret");
    backend.setSyncLocalFile("themes/notes.txt", "secret");
    const status = await backend.syncConnect(REMOTE);
    expect(status.pending).toEqual([
      { path: "config.jsonc", change: "added" },
      { path: "themes/lagoon.json", change: "added" },
    ]);
    const pushed = await backend.syncPush();
    expect(pushed).toEqual({
      committed: true,
      pushed: true,
      files: ["config.jsonc", "themes/lagoon.json"],
    });
    expect(backend.syncRemoteFiles()).toEqual({ "config.jsonc": "a", "themes/lagoon.json": "b" });
    const after = await backend.syncStatus();
    expect(after.pending).toEqual([]);
    expect(after.ahead).toBe(0);
    // Nothing new: nothing committed, nothing sent.
    expect(await backend.syncPush()).toEqual({ committed: false, pushed: false, files: [] });
  });

  it("pulls what another computer pushed, into the config folder, and never a name off the list", async () => {
    const backend = new FakeBackend();
    backend.setSyncRemoteFile("config.jsonc", "theirs");
    backend.setSyncRemoteFile("themes/lagoon.json", "{}");
    backend.setSyncRemoteFile("state.json", "stolen");
    await backend.syncConnect(REMOTE);
    expect(await backend.syncPull()).toEqual({
      kind: "updated",
      files: ["config.jsonc", "themes/lagoon.json"],
    });
    expect(backend.syncLocalFile("config.jsonc")).toBe("theirs");
    expect(backend.syncLocalFile("state.json")).toBeUndefined();
    expect(await backend.syncPull()).toEqual({ kind: "up_to_date" });
    // The remote changes later: the next pull brings only that.
    backend.setSyncRemoteFile("config.jsonc", "newer");
    expect(await backend.syncPull()).toEqual({ kind: "updated", files: ["config.jsonc"] });
    expect(backend.syncLocalFile("config.jsonc")).toBe("newer");
  });

  it("refuses a push the remote moved past, and a pull then allows it", async () => {
    const backend = new FakeBackend();
    backend.setSyncLocalFile("config.jsonc", "base");
    await backend.syncConnect(REMOTE);
    await backend.syncPush();
    backend.setSyncRemoteFile("themes/lagoon.json", "{}");
    backend.setSyncLocalFile("mods/mine.css", "p {}");
    await expect(backend.syncPush()).rejects.toThrow("pull first");
    expect((await backend.syncStatus()).behind).toBe(1);
    expect(await backend.syncPull()).toEqual({ kind: "updated", files: ["themes/lagoon.json"] });
    expect((await backend.syncPush()).pushed).toBe(true);
    expect(Object.keys(backend.syncRemoteFiles()).sort()).toEqual([
      "config.jsonc",
      "mods/mine.css",
      "themes/lagoon.json",
    ]);
  });

  it("detects a conflict: the paths come back and nothing is written", async () => {
    const backend = new FakeBackend();
    backend.setSyncLocalFile("config.jsonc", "base");
    backend.setSyncLocalFile("themes/quiet.json", "same");
    await backend.syncConnect(REMOTE);
    await backend.syncPush();
    backend.setSyncRemoteFile("config.jsonc", "from the other computer");
    backend.setSyncLocalFile("config.jsonc", "from this one");
    backend.setSyncLocalFile("mods/mine.css", "p {}");
    expect(await backend.syncPull()).toEqual({ kind: "conflict", paths: ["config.jsonc"] });
    expect(backend.syncLocalFile("config.jsonc")).toBe("from this one");
    expect(backend.syncLocalFile("mods/mine.css")).toBe("p {}");
    expect(backend.syncRemoteFiles()["config.jsonc"]).toBe("from the other computer");
    // Pushing is refused until the conflict is gone; making both sides alike lets the pull go on.
    await expect(backend.syncPush()).rejects.toThrow("pull first");
    backend.setSyncLocalFile("config.jsonc", "from the other computer");
    expect(await backend.syncPull()).toEqual({ kind: "up_to_date" });
    expect((await backend.syncPush()).pushed).toBe(true);
  });

  it("does not let a computer with a config of its own replace a filled remote before a pull", async () => {
    const backend = new FakeBackend();
    backend.setSyncRemoteFile("config.jsonc", "the real one");
    backend.setSyncLocalFile("config.jsonc", "defaults");
    await backend.syncConnect(REMOTE);
    await expect(backend.syncPush()).rejects.toThrow("pull first");
    expect(await backend.syncPull()).toEqual({ kind: "conflict", paths: ["config.jsonc"] });
    expect(backend.syncLocalFile("config.jsonc")).toBe("defaults");
    expect(backend.syncRemoteFiles()).toEqual({ "config.jsonc": "the real one" });
  });

  it("rejects every call with the failure it was given (git is not installed)", async () => {
    const backend = new FakeBackend();
    backend.setSyncFailure(new Error("git was not found on this computer"));
    await expect(backend.syncStatus()).rejects.toThrow("git was not found");
    await expect(backend.syncConnect(REMOTE)).rejects.toThrow("git was not found");
    await expect(backend.syncPull()).rejects.toThrow("git was not found");
    await expect(backend.syncPush()).rejects.toThrow("git was not found");
    backend.setSyncFailure(undefined);
    expect((await backend.syncStatus()).connected).toBe(false);
  });
});

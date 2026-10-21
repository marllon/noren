import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { FAKE_CURRENT_VERSION, UPDATE_MESSAGES } from "./fake-update";
import type { UpdateProgress } from "./update";
import { parseUpdateCheck, parseUpdateStatus } from "./update";

// The update of the app in the fake backend, which stands for `src-tauri/src/update.rs` in the
// tests of the screens: the same sentences, the same order of steps. The cases here are the ones
// the Rust tests pin down against the real updater plugin.

const RELEASE = {
  version: "0.2.0",
  notes: "Fixes\n- one thing",
  publishedAt: 1_792_584_000,
} as const;

describe("FakeBackend update: status", () => {
  it("starts able to update, on the version 0.1.0, with nothing found", async () => {
    const backend = new FakeBackend();
    const status = await backend.updateStatus();
    expect(status).toEqual({ configured: true, currentVersion: "0.1.0", pending: null });
    expect(status.currentVersion).toBe(FAKE_CURRENT_VERSION);
    expect(parseUpdateStatus(status).ok).toBe(true);
  });

  it("says when the build has no update key, and rejects a check and an install then", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    backend.setUpdateConfigured(false);
    expect((await backend.updateStatus()).configured).toBe(false);
    await expect(backend.updateCheck()).rejects.toThrow(UPDATE_MESSAGES.notConfigured);
    await expect(backend.updateInstall()).rejects.toThrow(UPDATE_MESSAGES.notConfigured);
    expect(backend.installedUpdates()).toEqual([]);
  });

  it("follows the version a test says is running", async () => {
    const backend = new FakeBackend();
    backend.setUpdateCurrentVersion("1.4.2");
    expect((await backend.updateStatus()).currentVersion).toBe("1.4.2");
  });
});

describe("FakeBackend update: check", () => {
  it("finds a newer release and keeps it for the install", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    const found = await backend.updateCheck();
    expect(found).toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "Fixes\n- one thing",
      publishedAt: 1_792_584_000,
    });
    expect(parseUpdateCheck(found).ok).toBe(true);
    expect((await backend.updateStatus()).pending).toEqual(found);
    // Nothing is installed by looking.
    expect(backend.installedUpdates()).toEqual([]);
  });

  it("hands out copies, so a caller cannot change what is kept", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    const found = await backend.updateCheck();
    const status = await backend.updateStatus();
    if (found === null || status.pending === null) throw new Error("no update was found");
    found.version = "9.9.9";
    status.pending.version = "8.8.8";
    expect((await backend.updateStatus()).pending?.version).toBe("0.2.0");
  });

  it("finds nothing when the feed has nothing, or a version that is not newer", async () => {
    const backend = new FakeBackend();
    expect(await backend.updateCheck()).toBeNull();
    for (const version of ["0.1.0", "0.0.9", "0.1.0-rc.1", "0.1.0+build.5", "v0.1.0"]) {
      backend.setUpdateRelease({ version });
      expect(await backend.updateCheck(), version).toBeNull();
      expect((await backend.updateStatus()).pending, version).toBeNull();
      await expect(backend.updateInstall()).rejects.toThrow(UPDATE_MESSAGES.nothingToInstall);
    }
  });

  it("takes a prerelease of a later version, and a tag with a v, as the app does", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease({ version: "v0.2.0-beta.1" });
    const found = await backend.updateCheck();
    expect(found).toEqual({
      version: "0.2.0-beta.1",
      currentVersion: "0.1.0",
      notes: null,
      publishedAt: null,
    });
  });

  it("refuses a feed whose version is not one", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease({ version: "soon" });
    await expect(backend.updateCheck()).rejects.toThrow("the update feed is not usable");
    expect((await backend.updateStatus()).pending).toBeNull();
  });

  it("forgets an update when the next check finds none", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    await backend.updateCheck();
    backend.setUpdateRelease(undefined);
    expect(await backend.updateCheck()).toBeNull();
    expect((await backend.updateStatus()).pending).toBeNull();
    await expect(backend.updateInstall()).rejects.toThrow(UPDATE_MESSAGES.nothingToInstall);
  });

  it("rejects when the server cannot be reached, and works again when it can", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    backend.setUpdateFailure(new Error("the update server could not be reached: offline"));
    await expect(backend.updateCheck()).rejects.toThrow("could not be reached");
    await expect(backend.updateInstall()).rejects.toThrow("could not be reached");
    // The status is a read with no network.
    expect((await backend.updateStatus()).configured).toBe(true);
    backend.setUpdateFailure(undefined);
    expect(await backend.updateCheck()).not.toBeNull();
  });
});

describe("FakeBackend update: install", () => {
  it("installs the update found, tells the progress, and leaves nothing pending", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease({ ...RELEASE, bytes: 1000 });
    const told: UpdateProgress[] = [];
    const stop = backend.onUpdateProgress((progress) => told.push(progress));
    await backend.updateCheck();
    await backend.updateInstall();
    stop();
    expect(told).toEqual([
      { downloaded: 250, total: 1000 },
      { downloaded: 500, total: 1000 },
      { downloaded: 1000, total: 1000 },
    ]);
    expect(backend.installedUpdates()).toEqual(["0.2.0"]);
    const status = await backend.updateStatus();
    expect(status.pending).toBeNull();
    // The app that runs is still the old one until it is restarted.
    expect(status.currentVersion).toBe("0.1.0");
  });

  it("stops telling the progress to who stopped listening", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    const told: UpdateProgress[] = [];
    backend.onUpdateProgress((progress) => told.push(progress))();
    await backend.updateCheck();
    await backend.updateInstall();
    expect(told).toEqual([]);
  });

  it("needs an update found: installing without a check is refused", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    await expect(backend.updateInstall()).rejects.toThrow(UPDATE_MESSAGES.nothingToInstall);
    expect(backend.installedUpdates()).toEqual([]);
  });

  it("refuses a package the signature does not match, after it came, and installs nothing", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease({
      ...RELEASE,
      bytes: 100,
      refusal: "the signature does not match the package and the update key",
    });
    const told: UpdateProgress[] = [];
    backend.onUpdateProgress((progress) => told.push(progress));
    await backend.updateCheck();
    await expect(backend.updateInstall()).rejects.toThrow(
      "the update was refused: the signature does not match the package and the update key",
    );
    expect(told.at(-1)).toEqual({ downloaded: 100, total: 100 });
    expect(backend.installedUpdates()).toEqual([]);
    // The update is still found: the person can try again once the release is fixed.
    expect((await backend.updateStatus()).pending?.version).toBe("0.2.0");
  });

  it("can be held a quarter of the way through the download, and goes on when released", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease({ ...RELEASE, bytes: 400 });
    const told: UpdateProgress[] = [];
    backend.onUpdateProgress((progress) => told.push(progress));
    await backend.updateCheck();
    const release = backend.holdUpdateInstall();
    let done = false;
    const installing = backend.updateInstall().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told).toEqual([{ downloaded: 100, total: 400 }]);
    expect(done).toBe(false);
    expect(backend.installedUpdates()).toEqual([]);
    release();
    await installing;
    expect(told.map((progress) => progress.downloaded)).toEqual([100, 200, 400]);
    expect(backend.installedUpdates()).toEqual(["0.2.0"]);
    // Released: the next install is not held.
    backend.setUpdateRelease({ ...RELEASE, version: "0.3.0", bytes: 400 });
    await backend.updateCheck();
    await backend.updateInstall();
    expect(backend.installedUpdates()).toEqual(["0.2.0", "0.3.0"]);
  });

  it("records the calls it was asked, with no argument that could carry anything", async () => {
    const backend = new FakeBackend();
    backend.setUpdateRelease(RELEASE);
    await backend.updateStatus();
    await backend.updateCheck();
    await backend.updateInstall();
    expect(backend.callsTo("updateStatus")).toHaveLength(1);
    expect(backend.callsTo("updateCheck")).toHaveLength(1);
    expect(backend.callsTo("updateInstall")).toHaveLength(1);
    // The hooks of a test are not calls of the Backend.
    expect(backend.callsTo("updateCheck")[0]?.args).toEqual([]);
  });
});

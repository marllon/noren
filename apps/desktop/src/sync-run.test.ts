import { afterEach, describe, expect, it } from "vitest";
import { FAKE_GALLERY_LAGOON, FakeBackend } from "@noren/model";
import { getModFiles, setModFiles } from "./mods-store";
import { reloadPulled, runPull, runPush, runSyncCommand } from "./sync-run";
import { getUserThemes, setUserThemes } from "./user-themes-store";
import { WebBackend } from "./web-backend";

const REMOTE = "https://example.com/me/settings.git";
const MOD = "/* compact */\n";

afterEach(() => {
  setUserThemes([]);
  setModFiles([]);
});

/** The web backend over a storage in memory: a pull writes the themes and mods where the app reads them. */
function webBackend(): WebBackend {
  const held = new Map<string, string>();
  return new WebBackend({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  });
}

async function connectedBackend(): Promise<FakeBackend> {
  const backend = new FakeBackend();
  await backend.syncConnect(REMOTE);
  return backend;
}

describe("runPull", () => {
  it("says the files it wrote and reads the themes and the mods again", async () => {
    const backend = webBackend();
    backend.setSyncRemoteFile("themes/lagoon.json", FAKE_GALLERY_LAGOON);
    backend.setSyncRemoteFile("mods/compact.css", MOD);
    await backend.syncConnect(REMOTE);
    expect(getUserThemes()).toHaveLength(0);
    const message = await runPull(backend);
    expect(message).toEqual({
      text: "Pulled 2 files: mods/compact.css, themes/lagoon.json.",
      alert: false,
    });
    expect(getUserThemes().map((theme) => theme.id)).toEqual(["lagoon"]);
    expect(getModFiles()).toEqual([{ name: "compact.css", text: MOD }]);
  });

  it("is not an update when the merge conflicts: it names the paths and nothing is written", async () => {
    const backend = new FakeBackend();
    backend.setSyncRemoteFile("config.jsonc", '{ "theme": "remote" }');
    backend.setSyncRemoteFile("themes/lagoon.json", FAKE_GALLERY_LAGOON);
    backend.setSyncLocalFile("config.jsonc", '{ "theme": "mine" }');
    await backend.syncConnect(REMOTE);
    const message = await runPull(backend);
    expect(message.alert).toBe(true);
    expect(message.text).toContain("config.jsonc");
    expect(message.text).toContain("Nothing changed on this computer.");
    expect(message.text).not.toMatch(/^Pulled/);
    expect(backend.syncLocalFile("config.jsonc")).toBe('{ "theme": "mine" }');
    expect(backend.syncLocalFile("themes/lagoon.json")).toBeUndefined();
    expect(getUserThemes()).toHaveLength(0);
  });

  it("says up to date when the remote has nothing new", async () => {
    const backend = await connectedBackend();
    expect(await runPull(backend)).toEqual({
      text: "Nothing to pull: this computer is up to date. Nothing changed.",
      alert: false,
    });
  });

  it("carries the text of the backend when git fails", async () => {
    const backend = await connectedBackend();
    backend.setSyncFailure(new Error("git is not installed"));
    expect(await runPull(backend)).toEqual({
      text: "Could not pull: git is not installed",
      alert: true,
    });
  });

  it("warns when the files were written but the list could not be read again", async () => {
    const backend = webBackend();
    backend.setSyncRemoteFile("themes/lagoon.json", FAKE_GALLERY_LAGOON);
    await backend.syncConnect(REMOTE);
    backend.listUserThemes = () => Promise.reject(new Error("the folder is gone"));
    const message = await runPull(backend);
    expect(message.alert).toBe(true);
    expect(message.text).toContain("Pulled 1 file: themes/lagoon.json.");
    expect(message.text).toContain("could not be read again: the folder is gone");
  });
});

describe("runPush", () => {
  it("sends the pending files and names them", async () => {
    const backend = await connectedBackend();
    backend.setSyncLocalFile("config.jsonc", "{}");
    backend.setSyncLocalFile("state.json", "{}");
    expect(await runPush(backend)).toEqual({ text: "Pushed 1 file: config.jsonc.", alert: false });
    expect(backend.syncRemoteFiles()).toEqual({ "config.jsonc": "{}" });
    expect(await runPush(backend)).toEqual({ text: "Nothing to push.", alert: false });
  });

  it("carries the refusal of the backend when the remote moved on", async () => {
    const backend = await connectedBackend();
    backend.setSyncLocalFile("config.jsonc", "{}");
    backend.setSyncRemoteFile("mods/a.css", MOD);
    const message = await runPush(backend);
    expect(message.alert).toBe(true);
    expect(message.text).toMatch(/^Could not push: .*pull first/);
  });
});

describe("runSyncCommand", () => {
  it("says where to connect when there is no remote, and asks nothing more", async () => {
    const backend = new FakeBackend();
    for (const command of ["pull", "push"] as const) {
      const message = await runSyncCommand(backend, command);
      expect(message).toEqual({
        text: "No remote is connected. Connect one in Settings, in the Sync section.",
        alert: true,
      });
    }
    expect(backend.calls.map((call) => call.method)).toEqual(["syncStatus", "syncStatus"]);
  });

  it("runs the pull or the push once a remote is connected", async () => {
    const backend = await connectedBackend();
    backend.setSyncLocalFile("config.jsonc", "{}");
    expect((await runSyncCommand(backend, "push")).text).toBe("Pushed 1 file: config.jsonc.");
    backend.setSyncRemoteFile("mods/a.css", MOD);
    expect((await runSyncCommand(backend, "pull")).text).toBe("Pulled 1 file: mods/a.css.");
  });

  it("says the status could not be read when git is missing", async () => {
    const backend = new FakeBackend();
    backend.setSyncFailure(new Error("git is not installed"));
    expect(await runSyncCommand(backend, "pull")).toEqual({
      text: "Could not read the sync status: git is not installed",
      alert: true,
    });
  });
});

describe("reloadPulled", () => {
  it("reads nothing for a pull that wrote only the config or spaces", async () => {
    const backend = new FakeBackend();
    await reloadPulled(backend, ["config.jsonc", "spaces/work.noren-space.json"]);
    expect(backend.calls).toEqual([]);
  });
});

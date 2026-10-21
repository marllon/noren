import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_GALLERY_LAGOON,
  FakeBackend,
  createDefaultWorkspace,
  createSequentialIds,
} from "@noren/model";
import type { Space } from "@noren/model";
import { getModFiles, setModFiles } from "./mods-store";
import { appSpaceSyncPort } from "./space-sync";
import { reloadPulled, runPull, runPush, runSyncCommand } from "./sync-run";
import { getUserThemes, setUserThemes } from "./user-themes-store";
import { WebBackend } from "./web-backend";
import { createWorkspaceStore } from "./workspace-store";

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

/** A computer with its own backend and window: the default space and one more for each name. */
function computer(...names: string[]) {
  const backend = new FakeBackend();
  const store = createWorkspaceStore({
    backend,
    workspace: createDefaultWorkspace(),
    newId: createSequentialIds("t"),
  });
  for (const name of names) store.getState().dispatch({ type: "space/create", name });
  return { backend, store, port: appSpaceSyncPort(store, backend) };
}

type Computer = ReturnType<typeof computer>;

const spaceNames = (machine: Computer): string[] =>
  machine.store.getState().workspace.spaces.map((space) => space.name);

const countOf = (machine: Computer, name: string): number =>
  spaceNames(machine).filter((each) => each === name).length;

/** What the first computer pushed to the remote, as the second one finds it there. */
function carry(from: FakeBackend, to: FakeBackend): void {
  for (const [path, text] of Object.entries(from.syncRemoteFiles())) {
    to.setSyncRemoteFile(path, text);
  }
}

describe("the spaces in a push and a pull", () => {
  it("a push writes every space as a file first, and the files travel", async () => {
    const a = computer("Work", "Play");
    await a.backend.syncConnect(REMOTE);
    const message = await runPush(a.backend, a.port);
    expect(message.alert).toBe(false);
    expect(message.text).toMatch(/^Pushed 3 files: /);
    expect(Object.keys(a.backend.syncRemoteFiles()).sort()).toEqual(
      [
        `spaces/${spaceNames(a)[0]}.noren-space.json`,
        "spaces/Play.noren-space.json",
        "spaces/Work.noren-space.json",
      ].sort(),
    );
    // Nothing changed since: nothing is written and nothing is pushed.
    expect(await runPush(a.backend, a.port)).toEqual({ text: "Nothing to push.", alert: false });
  });

  it("a push without the spaces of the window carries none", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    expect(await runPush(a.backend)).toEqual({ text: "Nothing to push.", alert: false });
    expect(a.backend.syncRemoteFiles()).toEqual({});
  });

  it("a space that went out comes in on the other computer once, and a second pull does not repeat it", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    await runPush(a.backend, a.port);

    const b = computer();
    carry(a.backend, b.backend);
    await b.backend.syncConnect(REMOTE);
    const first = await runPull(b.backend, b.port);
    expect(first.alert).toBe(false);
    expect(first.text).toContain("Pulled 2 files");
    expect(first.text).toContain("Added 2 spaces from the remote: ");
    expect(countOf(b, "Work")).toBe(1);
    const count = spaceNames(b).length;

    expect(await runPull(b.backend, b.port)).toEqual({
      text: "Nothing to pull: this computer is up to date. Nothing changed.",
      alert: false,
    });
    expect(spaceNames(b)).toHaveLength(count);

    // What b made from the file goes back out under the same name and says the same: a pulls
    // nothing new, and its own Work is still the only one.
    await runPush(b.backend, b.port);
    expect(Object.keys(b.backend.syncRemoteFiles())).toContain("spaces/Work.noren-space.json");
    carry(b.backend, a.backend);
    await runPull(a.backend, a.port);
    expect(countOf(a, "Work")).toBe(1);
  });

  it("a space this computer exported does not come back as a second space on the next pull", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    await runPush(a.backend, a.port);
    // Another computer adds a mod; this one pulls it, and its own files are not made into spaces.
    a.backend.setSyncRemoteFile("mods/other.css", MOD);
    const count = spaceNames(a).length;
    const message = await runPull(a.backend, a.port);
    expect(message.text).toBe("Pulled 1 file: mods/other.css.");
    expect(spaceNames(a)).toHaveLength(count);
  });

  it("a changed file makes the space again in its place and says so", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    await runPush(a.backend, a.port);
    const b = computer();
    carry(a.backend, b.backend);
    await b.backend.syncConnect(REMOTE);
    await runPull(b.backend, b.port);
    const order = spaceNames(b);

    // On a, Work gets another tab and is pushed; b pulls it.
    const work = a.store.getState().workspace.spaces.find((space) => space.name === "Work");
    a.store.getState().dispatch({ type: "item/create", spaceId: work?.id ?? "" });
    expect((await runPush(a.backend, a.port)).text).toContain("spaces/Work.noren-space.json");
    carry(a.backend, b.backend);
    const message = await runPull(b.backend, b.port);
    expect(message.text).toContain('Updated the space "Work" from the remote');
    expect(message.text).toContain("closed tabs");
    expect(spaceNames(b)).toEqual(order);
  });

  it("names a space that could not be written and still pushes the others", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    const secret = "gh" + "p_" + "a1B2".repeat(9);
    const workId = a.port.spaces().find((space) => space.name === "Work")?.id ?? "";
    a.store.getState().dispatch({ type: "item/create", spaceId: workId });
    const first = a.port.spaces().find((space) => space.name === "Work") as Space;
    const item = Object.values(first.items)[0];
    if (item === undefined) throw new Error("the space has a tab");
    const leaky: Space = {
      ...first,
      id: "leaky",
      name: "Leaky",
      items: {
        [item.id]: {
          ...item,
          layout: {
            kind: "pane",
            pane: {
              id: "page",
              type: "browser",
              profileId: "none",
              url: `https://example.com/?token=${secret}`,
              status: "idle",
              unread: false,
              bell: false,
            },
          },
          focusedPaneId: "page",
        },
      },
    };
    const message = await runPush(a.backend, { ...a.port, spaces: () => [first, leaky] });
    expect(message.alert).toBe(true);
    expect(message.text).toMatch(/^Pushed 1 file: spaces\/Work\.noren-space\.json\. /);
    expect(message.text).toContain('Not written as a file: "Leaky" (');
    expect(message.text).not.toContain(secret);
    expect(a.backend.syncRemoteFiles()["spaces/Leaky.noren-space.json"]).toBeUndefined();
  });

  it("does not make spaces from a pull that conflicts, and writes no file for a space that has none", async () => {
    const a = computer("Work");
    a.backend.setSyncRemoteFile("config.jsonc", '{ "theme": "remote" }');
    a.backend.setSyncLocalFile("config.jsonc", '{ "theme": "mine" }');
    a.backend.setSyncRemoteFile("spaces/Came.noren-space.json", "{}");
    await a.backend.syncConnect(REMOTE);
    const before = spaceNames(a);
    const message = await runPull(a.backend, a.port);
    expect(message.alert).toBe(true);
    expect(message.text).toContain("config.jsonc");
    expect(spaceNames(a)).toEqual(before);
    // Nothing was written before the pull for a space that had no file, so the first pull on a new
    // computer cannot clash with a space of the same name on the remote.
    expect(a.backend.callsTo("syncWriteSpaceFiles")).toHaveLength(0);
  });

  it("says a file that is not a space file was skipped, and the pull is still a pull", async () => {
    const a = computer();
    a.backend.setSyncRemoteFile("spaces/Broken.noren-space.json", "{ nope");
    await a.backend.syncConnect(REMOTE);
    const message = await runPull(a.backend, a.port);
    expect(message.alert).toBe(true);
    expect(message.text).toContain("Pulled 1 file: spaces/Broken.noren-space.json.");
    expect(message.text).toContain("Skipped spaces/Broken.noren-space.json: it is not valid JSON.");
    expect(spaceNames(a)).toHaveLength(1);
  });

  it("carries the words of the backend when the files cannot be written, and pushes nothing", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    a.backend.syncWriteSpaceFiles = () => Promise.reject(new Error("the disk is full"));
    expect(await runPush(a.backend, a.port)).toEqual({
      text: "Could not push: the disk is full",
      alert: true,
    });
    expect(a.backend.callsTo("syncPush")).toHaveLength(0);
  });

  it("runs the palette commands with the spaces too", async () => {
    const a = computer("Work");
    await a.backend.syncConnect(REMOTE);
    expect((await runSyncCommand(a.backend, "push", a.port)).text).toMatch(/^Pushed 2 files: /);
    expect(a.backend.syncRemoteFiles()["spaces/Work.noren-space.json"]).toContain('"name": "Work"');
  });
});

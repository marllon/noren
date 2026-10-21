import { describe, expect, it } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import { WEB_SYNC_KEY, WebBackend, seededSync } from "./web-backend";

// The sync through git on the two backends the app runs on: the Tauri one (`sync_status`,
// `sync_connect`, `sync_pull` and `sync_push` of src-tauri/src/bridge.rs, whose JSON is checked
// with the schemas of `@noren/model`) and the web one, which is the in-memory `FakeBackend`.

function bridgeAnswering(answers: Record<string, unknown>, failing: string[] = []) {
  const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const bridge: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      invocations.push({ command, args });
      if (failing.includes(command)) return Promise.reject(new Error(`${command} failed`));
      return Promise.resolve(answers[command] as T);
    },
    listen: () => Promise.resolve(() => undefined),
    createChannel: () => ({ onmessage: () => undefined }),
  };
  return { bridge, invocations };
}

const status = {
  connected: true,
  remote: "/srv/notes.git",
  branch: "main",
  pending: [{ path: "config.jsonc", change: "modified" }],
  ahead: 1,
  behind: 0,
};

describe("TauriBackend sync", () => {
  it("reads the status of sync_status and sends the address to sync_connect", async () => {
    const fake = bridgeAnswering({ sync_status: status, sync_connect: status });
    const backend = new TauriBackend(fake.bridge);
    await expect(backend.syncStatus()).resolves.toEqual(status);
    await expect(backend.syncConnect("/srv/notes.git")).resolves.toEqual(status);
    expect(fake.invocations).toEqual([
      { command: "sync_status", args: undefined },
      { command: "sync_connect", args: { remote: "/srv/notes.git" } },
    ]);
  });

  it("reads the three outcomes of sync_pull and the answer of sync_push", async () => {
    for (const pull of [
      { kind: "up_to_date" },
      { kind: "updated", files: ["themes/lagoon.json"] },
      { kind: "conflict", paths: ["config.jsonc"] },
    ]) {
      const fake = bridgeAnswering({ sync_pull: pull });
      await expect(new TauriBackend(fake.bridge).syncPull()).resolves.toEqual(pull);
    }
    const push = { committed: true, pushed: true, files: ["config.jsonc"] };
    const fake = bridgeAnswering({ sync_push: push });
    await expect(new TauriBackend(fake.bridge).syncPush()).resolves.toEqual(push);
  });

  it("rejects an answer that is not the expected shape, and a failing command", async () => {
    const wrong = bridgeAnswering({
      sync_status: { ...status, pending: [{ path: "state.json", change: "added" }] },
      sync_pull: { kind: "merged" },
      sync_push: "pushed",
    });
    const backend = new TauriBackend(wrong.bridge);
    await expect(backend.syncStatus()).rejects.toThrow("unexpected shape");
    await expect(backend.syncPull()).rejects.toThrow("unexpected shape");
    await expect(backend.syncPush()).rejects.toThrow("unexpected shape");
    const broken = bridgeAnswering({}, ["sync_pull"]);
    await expect(new TauriBackend(broken.bridge).syncPull()).rejects.toThrow("sync_pull failed");
  });
});

describe("WebBackend sync", () => {
  it("keeps the sync in memory like the fake backend", async () => {
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const backend = new WebBackend(storage);
    expect((await backend.syncStatus()).connected).toBe(false);
    backend.setSyncLocalFile("config.jsonc", "{}");
    await backend.syncConnect("https://example.com/me/settings.git");
    expect(await backend.syncPush()).toEqual({
      committed: true,
      pushed: true,
      files: ["config.jsonc"],
    });
  });
});

describe("WebBackend sync seed (noren.web.sync)", () => {
  const withSeed = (seed: unknown) => {
    const held = new Map<string, string>([[WEB_SYNC_KEY, JSON.stringify(seed)]]);
    return new WebBackend({
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => void held.set(key, value),
      removeItem: (key) => void held.delete(key),
    });
  };

  it("reads only the shapes it knows", () => {
    const read = (value: unknown) =>
      seededSync({ getItem: () => (value === null ? null : JSON.stringify(value)) });
    expect(read(null)).toBeUndefined();
    expect(read([])).toBeUndefined();
    expect(read({ localFiles: { "config.jsonc": "{}", bad: 3 }, remoteFiles: 7 })).toEqual({
      localFiles: { "config.jsonc": "{}" },
      remoteFiles: {},
    });
    expect(read({ failure: "no git" })).toEqual({
      localFiles: {},
      remoteFiles: {},
      failure: "no git",
    });
    expect(seededSync({ getItem: () => "not json" })).toBeUndefined();
  });

  it("puts the seeded files on both sides, so a pull brings the remote's and a push sends this computer's", async () => {
    const backend = withSeed({
      localFiles: { "config.jsonc": "{}" },
      remoteFiles: { "mods/a.css": "/* a */\n" },
    });
    const status = await backend.syncConnect("https://example.com/me/s.git");
    expect(status.pending).toEqual([{ path: "config.jsonc", change: "added" }]);
    await expect(backend.syncPull()).resolves.toEqual({ kind: "updated", files: ["mods/a.css"] });
    // The pull wrote the mod where the app reads it.
    await expect(backend.listMods()).resolves.toEqual([{ name: "a.css", text: "/* a */\n" }]);
    await expect(backend.syncPush()).resolves.toMatchObject({ pushed: true });
  });

  it("makes every sync call fail with the seeded message", async () => {
    const backend = withSeed({ failure: "git is not installed" });
    await expect(backend.syncStatus()).rejects.toThrow("git is not installed");
    await expect(backend.syncConnect("https://example.com/me/s.git")).rejects.toThrow(
      "git is not installed",
    );
  });
});

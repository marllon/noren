import { describe, expect, it } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import { WebBackend } from "./web-backend";

// The sync through a gist on the two backends the app runs on: the Tauri one (`sync_gist_*` of
// src-tauri/src/bridge.rs, whose JSON is checked with the schemas of `@noren/model`) and the web
// one, which is the in-memory `FakeBackend`.

const TOKEN = "ghp_TestTokenNeverReal0123456789";

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
  gistId: "aa5a315d61ae9438b18d",
  public: false,
  hasToken: true,
  pending: [{ path: "config.jsonc", change: "modified" }],
};

describe("TauriBackend sync through a gist", () => {
  it("reads the status of sync_gist_status and connects with or without an id", async () => {
    const fake = bridgeAnswering({ sync_gist_status: status, sync_gist_connect: status });
    const backend = new TauriBackend(fake.bridge);
    await expect(backend.syncGistStatus()).resolves.toEqual(status);
    await expect(backend.syncGistConnect("aa5a315d61ae9438b18d")).resolves.toEqual(status);
    await expect(backend.syncGistConnect()).resolves.toEqual(status);
    expect(fake.invocations).toEqual([
      { command: "sync_gist_status", args: undefined },
      { command: "sync_gist_connect", args: { gistId: "aa5a315d61ae9438b18d" } },
      { command: "sync_gist_connect", args: undefined },
    ]);
  });

  it("reads the three outcomes of sync_gist_pull and the answer of sync_gist_push", async () => {
    for (const pull of [
      { kind: "up_to_date" },
      { kind: "updated", files: ["themes/lagoon.json"] },
      { kind: "conflict", paths: ["config.jsonc"] },
    ]) {
      const fake = bridgeAnswering({ sync_gist_pull: pull });
      await expect(new TauriBackend(fake.bridge).syncGistPull()).resolves.toEqual(pull);
      expect(fake.invocations).toEqual([{ command: "sync_gist_pull", args: undefined }]);
    }
    const push = { committed: true, pushed: true, files: ["config.jsonc"] };
    const fake = bridgeAnswering({ sync_gist_push: push });
    await expect(new TauriBackend(fake.bridge).syncGistPush()).resolves.toEqual(push);
    expect(fake.invocations).toEqual([{ command: "sync_gist_push", args: undefined }]);
  });

  it("sends the token to the app and nowhere else, and asks it to forget the token", async () => {
    const fake = bridgeAnswering({ sync_gist_set_token: null, sync_gist_clear_token: null });
    const backend = new TauriBackend(fake.bridge);
    await backend.syncGistSetToken(TOKEN);
    await backend.syncGistClearToken();
    expect(fake.invocations).toEqual([
      { command: "sync_gist_set_token", args: { token: TOKEN } },
      { command: "sync_gist_clear_token", args: undefined },
    ]);
  });

  it("refuses a token the app would refuse without asking it, and without repeating it", async () => {
    const fake = bridgeAnswering({});
    const backend = new TauriBackend(fake.bridge);
    for (const bad of ["", "two words", "ação"]) {
      const error = await backend.syncGistSetToken(bad).catch((e: unknown) => e as Error);
      expect((error as Error).message).toContain("not a usable token");
    }
    expect(fake.invocations).toEqual([]);
  });

  it("rejects an answer that is not the expected shape, and a failing command", async () => {
    const wrong = bridgeAnswering({
      sync_gist_status: { ...status, token: TOKEN },
      sync_gist_connect: { ...status, gistId: "a/b" },
      sync_gist_pull: { kind: "merged" },
      sync_gist_push: "pushed",
    });
    const backend = new TauriBackend(wrong.bridge);
    await expect(backend.syncGistStatus()).rejects.toThrow("unexpected shape");
    await expect(backend.syncGistConnect()).rejects.toThrow("unexpected shape");
    await expect(backend.syncGistPull()).rejects.toThrow("unexpected shape");
    await expect(backend.syncGistPush()).rejects.toThrow("unexpected shape");
    const broken = bridgeAnswering({}, ["sync_gist_pull"]);
    await expect(new TauriBackend(broken.bridge).syncGistPull()).rejects.toThrow(
      "sync_gist_pull failed",
    );
  });
});

describe("WebBackend sync through a gist", () => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

  it("keeps the gist in memory like the fake backend", async () => {
    const backend = new WebBackend(storage);
    expect((await backend.syncGistStatus()).connected).toBe(false);
    await backend.syncGistSetToken(TOKEN);
    backend.setSyncLocalFile("config.jsonc", "{}");
    const connected = await backend.syncGistConnect();
    expect(connected).toMatchObject({ connected: true, hasToken: true, public: false });
    backend.setSyncLocalFile("mods/a.css", "/* a */\n");
    expect(await backend.syncGistPush()).toEqual({
      committed: true,
      pushed: true,
      files: ["mods/a.css"],
    });
  });

  it("lands what a pull brings where the app reads it, as the pull through git does", async () => {
    const backend = new WebBackend(storage);
    await backend.syncGistSetToken(TOKEN);
    backend.putSyncGist("abc123", {
      files: {
        "mods--a.css": "/* a */\n",
        "themes--lagoon.json": '{"id":"lagoon"}',
        "config.jsonc": '{ "theme": "lagoon" }\n',
      },
    });
    await backend.syncGistConnect("abc123");
    await expect(backend.syncGistPull()).resolves.toEqual({
      kind: "updated",
      files: ["config.jsonc", "mods/a.css", "themes/lagoon.json"],
    });
    await expect(backend.listMods()).resolves.toEqual([{ name: "a.css", text: "/* a */\n" }]);
    await expect(backend.loadConfig()).resolves.toBe('{ "theme": "lagoon" }\n');
  });
});

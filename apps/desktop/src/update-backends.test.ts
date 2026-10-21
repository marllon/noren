import { describe, expect, it } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import { WEB_UPDATE_KEY, WebBackend, seededUpdate } from "./web-backend";

// The update of the app on the two backends the app runs on: the Tauri one (`update_status`,
// `update_check` and `update_install` of src-tauri/src/update.rs and its `update-progress` event,
// whose JSON is checked with the schemas of `@noren/model`) and the web one, which is the in-memory
// `FakeBackend` seeded from the storage of the page.

function bridgeAnswering(answers: Record<string, unknown>, failing: Record<string, string> = {}) {
  const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const listeners = new Map<string, ((event: { payload: unknown }) => void)[]>();
  const unlistened: string[] = [];
  const bridge: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      invocations.push({ command, args });
      const failure = failing[command];
      if (failure !== undefined) return Promise.reject(new Error(failure));
      return Promise.resolve(answers[command] as T);
    },
    listen: <T>(event: string, handler: (event: { payload: T }) => void) => {
      const held = listeners.get(event) ?? [];
      held.push(handler as (event: { payload: unknown }) => void);
      listeners.set(event, held);
      return Promise.resolve(() => {
        unlistened.push(event);
      });
    },
    createChannel: () => ({ onmessage: () => undefined }),
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of listeners.get(event) ?? []) handler({ payload });
  };
  return { bridge, invocations, emit, listeners, unlistened };
}

const info = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: "Fixes\n- one thing",
  publishedAt: 1_792_584_000,
};

describe("TauriBackend update", () => {
  it("reads the status of update_status", async () => {
    const status = { configured: true, currentVersion: "0.1.0", pending: info };
    const fake = bridgeAnswering({ update_status: status });
    await expect(new TauriBackend(fake.bridge).updateStatus()).resolves.toEqual(status);
    expect(fake.invocations).toEqual([{ command: "update_status", args: undefined }]);
  });

  it("reads the update of update_check, or null for none", async () => {
    const found = bridgeAnswering({ update_check: info });
    await expect(new TauriBackend(found.bridge).updateCheck()).resolves.toEqual(info);
    expect(found.invocations).toEqual([{ command: "update_check", args: undefined }]);
    const none = bridgeAnswering({ update_check: null });
    await expect(new TauriBackend(none.bridge).updateCheck()).resolves.toBeNull();
  });

  it("refuses an answer of another shape, saying it is the update that was wrong", async () => {
    const bad = bridgeAnswering({
      update_status: { configured: "yes" },
      update_check: { version: 2 },
    });
    const backend = new TauriBackend(bad.bridge);
    await expect(backend.updateStatus()).rejects.toThrow(
      "the app answered about the update in an unexpected shape",
    );
    await expect(backend.updateCheck()).rejects.toThrow(
      "the app answered about the update in an unexpected shape",
    );
  });

  it("asks for the install with no argument, and passes a refusal on as the app worded it", async () => {
    const ok = bridgeAnswering({ update_install: null });
    await expect(new TauriBackend(ok.bridge).updateInstall()).resolves.toBeUndefined();
    expect(ok.invocations).toEqual([{ command: "update_install", args: undefined }]);
    const refused = bridgeAnswering(
      {},
      {
        update_install:
          "the update was refused: the signature does not match the package and the update key",
        update_check: "the update server answered 404",
      },
    );
    const backend = new TauriBackend(refused.bridge);
    await expect(backend.updateInstall()).rejects.toThrow(
      "the update was refused: the signature does not match the package and the update key",
    );
    await expect(backend.updateCheck()).rejects.toThrow("the update server answered 404");
  });

  it("hears the progress of the download from the update-progress event", async () => {
    const fake = bridgeAnswering({});
    const backend = new TauriBackend(fake.bridge);
    const told: unknown[] = [];
    const stop = backend.onUpdateProgress((progress) => told.push(progress));
    expect([...fake.listeners.keys()]).toEqual(["update-progress"]);
    fake.emit("update-progress", { downloaded: 10, total: 100 });
    fake.emit("update-progress", { downloaded: 100, total: null });
    // A payload that is not a progress is dropped, not passed on.
    fake.emit("update-progress", { downloaded: "ten" });
    fake.emit("update-progress", null);
    expect(told).toEqual([
      { downloaded: 10, total: 100 },
      { downloaded: 100, total: null },
    ]);
    stop();
    fake.emit("update-progress", { downloaded: 20, total: 100 });
    expect(told).toHaveLength(2);
  });

  it("listens once however many hear it, and stops listening when the backend is disposed", async () => {
    const fake = bridgeAnswering({});
    const backend = new TauriBackend(fake.bridge);
    const first: unknown[] = [];
    const second: unknown[] = [];
    backend.onUpdateProgress((progress) => first.push(progress));
    backend.onUpdateProgress((progress) => second.push(progress));
    expect(fake.listeners.get("update-progress")).toHaveLength(1);
    fake.emit("update-progress", { downloaded: 1, total: 2 });
    expect(first).toEqual(second);
    await backend.dispose();
    expect(fake.unlistened).toEqual(["update-progress"]);
  });
});

describe("WebBackend update seed (noren.web.update)", () => {
  const withSeed = (seed: unknown) => {
    const held = new Map<string, string>([[WEB_UPDATE_KEY, JSON.stringify(seed)]]);
    return new WebBackend({
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => void held.set(key, value),
      removeItem: (key) => void held.delete(key),
    });
  };

  it("reads only the shapes it knows", () => {
    const read = (value: unknown) =>
      seededUpdate({ getItem: () => (value === null ? null : JSON.stringify(value)) });
    expect(read(null)).toBeUndefined();
    expect(read([])).toBeUndefined();
    expect(read(7)).toBeUndefined();
    expect(read({})).toEqual({});
    expect(
      read({
        currentVersion: "1.0.0",
        configured: false,
        failure: "offline",
        release: {
          version: "1.1.0",
          notes: "Better",
          publishedAt: 5,
          bytes: 100,
          refusal: "bad signature",
          extra: true,
        },
      }),
    ).toEqual({
      currentVersion: "1.0.0",
      configured: false,
      failure: "offline",
      release: {
        version: "1.1.0",
        notes: "Better",
        publishedAt: 5,
        bytes: 100,
        refusal: "bad signature",
      },
    });
    // A field of another type is left out; a release with no version is no release.
    expect(
      read({ currentVersion: 1, configured: "no", failure: 3, release: { notes: "x" } }),
    ).toEqual({});
    expect(read({ release: { version: 2 } })).toEqual({});
    expect(read({ release: { version: "1.0.0", notes: null, publishedAt: null } })).toEqual({
      release: { version: "1.0.0", notes: null, publishedAt: null },
    });
    expect(seededUpdate({ getItem: () => "not json" })).toBeUndefined();
  });

  it("is up to date, on 0.1.0 and able to update, without a seed", async () => {
    const backend = new WebBackend({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(await backend.updateStatus()).toEqual({
      configured: true,
      currentVersion: "0.1.0",
      pending: null,
    });
    expect(await backend.updateCheck()).toBeNull();
  });

  it("offers the release a test seeded, and installs it", async () => {
    const backend = withSeed({
      currentVersion: "1.0.0",
      release: { version: "1.1.0", notes: "Better", bytes: 400 },
    });
    expect(await backend.updateCheck()).toEqual({
      version: "1.1.0",
      currentVersion: "1.0.0",
      notes: "Better",
      publishedAt: null,
    });
    const told: number[] = [];
    backend.onUpdateProgress((progress) => told.push(progress.downloaded));
    await backend.updateInstall();
    expect(told).toEqual([100, 200, 400]);
    expect(backend.installedUpdates()).toEqual(["1.1.0"]);
  });

  it("is a build with no key, or an unreachable server, when the seed says so", async () => {
    const unset = withSeed({ configured: false, release: { version: "9.0.0" } });
    expect((await unset.updateStatus()).configured).toBe(false);
    await expect(unset.updateCheck()).rejects.toThrow("no update key");
    const offline = withSeed({ failure: "the update server could not be reached: offline" });
    await expect(offline.updateCheck()).rejects.toThrow("could not be reached");
    const refused = withSeed({ release: { version: "9.0.0", refusal: "bad signature" } });
    await refused.updateCheck();
    await expect(refused.updateInstall()).rejects.toThrow("the update was refused: bad signature");
    expect(refused.installedUpdates()).toEqual([]);
  });
});

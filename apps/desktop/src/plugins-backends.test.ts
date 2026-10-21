import { describe, expect, it } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import { WEB_PLUGINS_KEY, WebBackend } from "./web-backend";

// The plugin folders through the two backends the app runs on: the Tauri one (`plugins_list` of
// src-tauri/src/bridge.rs) and the web one, which lists the example plugin like `FakeBackend`.

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

describe("TauriBackend plugins", () => {
  it("lists the folders through plugins_list, with the files or the sentence", async () => {
    const fake = bridgeAnswering({
      plugins_list: [
        { folder: "a", manifest: "{}", main: "// a", extra: "left out" },
        { folder: "b", error: "plugin.json not found" },
      ],
    });
    await expect(new TauriBackend(fake.bridge).listPlugins()).resolves.toEqual([
      { folder: "a", manifest: "{}", main: "// a" },
      { folder: "b", error: "plugin.json not found" },
    ]);
    expect(fake.invocations).toEqual([{ command: "plugins_list", args: undefined }]);
  });

  it("keeps a folder with an odd answer as one that could not be read, and drops what is not a folder", async () => {
    const fake = bridgeAnswering({
      plugins_list: [{ folder: "c", manifest: "{}" }, { manifest: "{}", main: "x" }, null, 7],
    });
    await expect(new TauriBackend(fake.bridge).listPlugins()).resolves.toEqual([
      { folder: "c", error: "the folder could not be read" },
    ]);
  });

  it("lists none when the answer is not a list, and rejects when the command fails", async () => {
    const none = bridgeAnswering({ plugins_list: null });
    await expect(new TauriBackend(none.bridge).listPlugins()).resolves.toEqual([]);
    const broken = bridgeAnswering({}, ["plugins_list"]);
    await expect(new TauriBackend(broken.bridge).listPlugins()).rejects.toThrow(
      "plugins_list failed",
    );
  });
});

describe("WebBackend plugins", () => {
  it("lists the example plugin, as the fake backend does", async () => {
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const folders = await new WebBackend(storage).listPlugins();
    expect(folders.map((folder) => folder.folder)).toEqual(["new-tab-action"]);
  });

  it("lists the folders seeded under noren.web.plugins instead of the example, and drops what is not a folder", async () => {
    const seed = JSON.stringify([
      { folder: "a", manifest: "{}", main: "// a" },
      { folder: "b", error: "plugin.json not found" },
      { folder: "c", manifest: "{}" },
      { manifest: "{}", main: "x" },
      7,
    ]);
    const storage = {
      getItem: (key: string) => (key === WEB_PLUGINS_KEY ? seed : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    await expect(new WebBackend(storage).listPlugins()).resolves.toEqual([
      { folder: "a", manifest: "{}", main: "// a" },
      { folder: "b", error: "plugin.json not found" },
    ]);
  });

  it("keeps the example when the seed is not a list", async () => {
    const storage = {
      getItem: (key: string) => (key === WEB_PLUGINS_KEY ? "{}" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const folders = await new WebBackend(storage).listPlugins();
    expect(folders.map((folder) => folder.folder)).toEqual(["new-tab-action"]);
  });
});

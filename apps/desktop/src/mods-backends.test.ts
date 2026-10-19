import { describe, expect, it, vi } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import { WEB_MODS_KEY, WebBackend, seededMods } from "./web-backend";
import type { StateStorage } from "./web-backend";

// The mod files through the two backends the app runs on: the Tauri one (`mod_list`, `mod_watch` and
// the `mods-changed` event of src-tauri/src/bridge.rs) and the web one (the browser storage).

function memoryStorage(): StateStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function blockedStorage(): StateStorage {
  const refuse = (): never => {
    throw new Error("blocked");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

/** A bridge whose `invoke` answers from a table and whose events are fired by the test. */
function fakeBridge(answers: Record<string, unknown> = {}) {
  const invocations: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const failing = new Set<string>();
  const log: string[] = [];
  let unlistened = 0;
  const bridge: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      log.push(`invoke ${command}`);
      invocations.push({ command, args });
      if (failing.has(command)) return Promise.reject(new Error(`${command} failed`));
      return Promise.resolve(answers[command] as T);
    },
    listen: (event, handler) => {
      log.push(`listen ${event}`);
      handlers.set(event, handler as (event: { payload: unknown }) => void);
      return Promise.resolve(() => {
        unlistened++;
      });
    },
    createChannel: () => ({ onmessage: () => undefined }),
  };
  return {
    bridge,
    invocations,
    failing,
    log,
    unlistened: () => unlistened,
    emitMods: (payload: unknown) => handlers.get("mods-changed")?.({ payload }),
    callsTo: (command: string) => invocations.filter((i) => i.command === command),
  };
}

describe("TauriBackend mods", () => {
  it("lists them through mod_list, as name and text only", async () => {
    const fake = fakeBridge({
      mod_list: [{ name: "a.css", text: ".a {}", extra: "left out" }],
    });
    await expect(new TauriBackend(fake.bridge).listMods()).resolves.toEqual([
      { name: "a.css", text: ".a {}" },
    ]);
    expect(fake.invocations).toEqual([{ command: "mod_list", args: undefined }]);
  });

  it("rejects when the folder cannot be read", async () => {
    const fake = fakeBridge();
    fake.failing.add("mod_list");
    await expect(new TauriBackend(fake.bridge).listMods()).rejects.toThrow("mod_list failed");
  });

  it("hears mods-changed first and only then asks the Rust side to watch, once", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const first: string[][] = [];
    const second: string[][] = [];
    backend.watchMods((files) => first.push(files.map((f) => f.name)));
    backend.watchMods((files) => second.push(files.map((f) => f.name)));
    await vi.waitFor(() => expect(fake.callsTo("mod_watch")).toHaveLength(1));

    expect(fake.log).toEqual(["listen mods-changed", "invoke mod_watch"]);
    fake.emitMods([{ name: "a.css", text: "1" }]);
    fake.emitMods([]);
    expect(first).toEqual([["a.css"], []]);
    expect(second).toEqual([["a.css"], []]);
  });

  it("stops delivering to a callback that unsubscribed", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    const heard: number[] = [];
    const stop = backend.watchMods((files) => heard.push(files.length));
    await vi.waitFor(() => expect(fake.callsTo("mod_watch")).toHaveLength(1));
    fake.emitMods([{ name: "a.css", text: "" }]);
    stop();
    fake.emitMods([]);
    expect(heard).toEqual([1]);
  });

  it("does not break when the watching cannot start, and tries again for the next callback", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    fake.failing.add("mod_watch");
    backend.watchMods(() => undefined);
    await vi.waitFor(() => expect(fake.unlistened()).toBe(1));

    fake.failing.delete("mod_watch");
    const heard: number[] = [];
    backend.watchMods((files) => heard.push(files.length));
    await vi.waitFor(() => expect(fake.callsTo("mod_watch")).toHaveLength(2));
    fake.emitMods([{ name: "a.css", text: "" }]);
    expect(heard).toEqual([1]);
  });

  it("stops listening to mods-changed on dispose", async () => {
    const fake = fakeBridge();
    const backend = new TauriBackend(fake.bridge);
    backend.watchMods(() => undefined);
    await vi.waitFor(() => expect(fake.callsTo("mod_watch")).toHaveLength(1));
    await backend.dispose();
    expect(fake.unlistened()).toBe(1);
  });
});

describe("WebBackend mods", () => {
  it("has none at first", async () => {
    expect(await new WebBackend(memoryStorage()).listMods()).toEqual([]);
  });

  it("lists the files seeded under noren.web.mods, by name", async () => {
    const storage = memoryStorage();
    storage.setItem(WEB_MODS_KEY, JSON.stringify({ "b.css": "b", "a.css": "a", "notes.txt": "x" }));
    expect(await new WebBackend(storage).listMods()).toEqual([
      { name: "a.css", text: "a" },
      { name: "b.css", text: "b" },
    ]);
  });

  it("keeps a file placed by setMod in the storage, so a reload finds it", async () => {
    const storage = memoryStorage();
    const backend = new WebBackend(storage);
    backend.setMod("a.css", "1");
    backend.setMod("b.css", "2");
    backend.setMod("a.css", "1 edited");
    expect(seededMods(storage)).toEqual({ "b.css": "2", "a.css": "1 edited" });
    expect(await new WebBackend(storage).listMods()).toEqual([
      { name: "a.css", text: "1 edited" },
      { name: "b.css", text: "2" },
    ]);
    backend.setMod("a.css", null);
    expect(seededMods(storage)).toEqual({ "b.css": "2" });
  });

  it("tells the watchers, like the fake one", () => {
    const backend = new WebBackend(memoryStorage());
    const heard: string[][] = [];
    backend.watchMods((files) => heard.push(files.map((f) => f.name)));
    backend.setMod("a.css", "x");
    expect(heard).toEqual([["a.css"]]);
  });

  it("ignores a seed that is not usable, and works with the storage blocked", async () => {
    const storage = memoryStorage();
    for (const seed of ["not json", "[]", "3", "null", '{"a.css": 1}']) {
      storage.setItem(WEB_MODS_KEY, seed);
      const files = await new WebBackend(storage).listMods();
      expect(files, seed).toEqual([]);
    }
    expect(seededMods(blockedStorage())).toBeUndefined();
    const blocked = new WebBackend(blockedStorage());
    blocked.setMod("a.css", "kept in memory");
    expect(await blocked.listMods()).toEqual([{ name: "a.css", text: "kept in memory" }]);
  });
});

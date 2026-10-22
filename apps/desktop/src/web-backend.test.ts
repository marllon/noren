import { describe, expect, it } from "vitest";
import {
  WEB_ACTIONS_KEY,
  WEB_CONFIG_KEY,
  WEB_GIT_KEY,
  WEB_PROFILES_KEY,
  WEB_STATE_KEY,
  WEB_THEMES_KEY,
  WebBackend,
} from "./web-backend";
import type { StateStorage } from "./web-backend";

function memoryStorage(): StateStorage & { keys(): string[] } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    keys: () => [...values.keys()],
  };
}

/** A storage that refuses everything, as a browser with storage turned off does. */
function blockedStorage(): StateStorage {
  const refuse = (): never => {
    throw new Error("blocked");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

describe("WebBackend", () => {
  it("has no state at first", async () => {
    expect(await new WebBackend(memoryStorage()).loadState()).toBeNull();
  });

  it("a state saved by one backend is loaded by a new one over the same storage", async () => {
    const storage = memoryStorage();
    await new WebBackend(storage).saveState('{"version":1}');
    expect(await new WebBackend(storage).loadState()).toBe('{"version":1}');
  });

  it("quarantine copies the state under another key and keeps the original", async () => {
    const storage = memoryStorage();
    const backend = new WebBackend(storage);
    await backend.saveState("broken");
    const key = await backend.quarantineState();
    expect(key).not.toBe(WEB_STATE_KEY);
    expect(storage.getItem(key)).toBe("broken");
    expect(storage.getItem(WEB_STATE_KEY)).toBe("broken");
  });

  it("quarantine without a state file rejects", async () => {
    await expect(new WebBackend(memoryStorage()).quarantineState()).rejects.toThrow();
  });

  it("blocked storage falls back to memory", async () => {
    const backend = new WebBackend(blockedStorage());
    await backend.saveState("kept");
    expect(await backend.loadState()).toBe("kept");
  });

  it("reads the actions file of a folder from the seeded storage key", async () => {
    const storage = memoryStorage();
    storage.setItem(WEB_ACTIONS_KEY, JSON.stringify({ "/proj": '{"actions":[]}' }));
    const backend = new WebBackend(storage);
    expect(await backend.readActionsFile("/proj")).toBe('{"actions":[]}');
    expect(await backend.readActionsFile("/other")).toBeNull();
    // A later change of the key shows on the next read.
    storage.setItem(WEB_ACTIONS_KEY, JSON.stringify({ "/proj": "changed" }));
    expect(await backend.readActionsFile("/proj")).toBe("changed");
  });

  it("falls back to the in-memory actions file when the seed is missing or broken", async () => {
    const storage = memoryStorage();
    const backend = new WebBackend(storage);
    backend.setActionsFile("/proj", "memory");
    expect(await backend.readActionsFile("/proj")).toBe("memory");
    storage.setItem(WEB_ACTIONS_KEY, "not json");
    expect(await backend.readActionsFile("/proj")).toBe("memory");
    storage.setItem(WEB_ACTIONS_KEY, "[1]");
    expect(await backend.readActionsFile("/proj")).toBe("memory");
  });

  it("lists the profiles seeded under the profiles key, and the one fake shell otherwise", async () => {
    const storage = memoryStorage();
    expect((await new WebBackend(storage).listProfiles()).map((p) => p.id)).toEqual(["fake"]);
    storage.setItem(
      WEB_PROFILES_KEY,
      JSON.stringify([
        { id: "pwsh", name: "PowerShell", default: true },
        { id: "bash", name: "Git Bash" },
      ]),
    );
    expect(await new WebBackend(storage).listProfiles()).toEqual([
      { id: "pwsh", name: "PowerShell", default: true },
      { id: "bash", name: "Git Bash", default: false },
    ]);
  });

  it("ignores a profiles seed that is not a usable list", async () => {
    for (const seed of ["not json", "{}", "[]", '[{"id":1,"name":"x"}]', "[null]"]) {
      const storage = memoryStorage();
      storage.setItem(WEB_PROFILES_KEY, seed);
      expect((await new WebBackend(storage).listProfiles()).map((p) => p.id)).toEqual(["fake"]);
    }
  });

  it("is in no git repository unless the git key says so", async () => {
    const backend = new WebBackend(memoryStorage());
    expect(await backend.gitInfo("/proj")).toBeNull();
  });

  it("reads the git repositories seeded under the git key, again at every lookup", async () => {
    const storage = memoryStorage();
    storage.setItem(
      WEB_GIT_KEY,
      JSON.stringify({ "/proj": "main", "/old": { branch: "0123456", detached: true } }),
    );
    const backend = new WebBackend(storage);
    expect(await backend.gitInfo("/proj/src")).toEqual({ branch: "main", detached: false });
    expect(await backend.gitInfo("/old")).toEqual({ branch: "0123456", detached: true });
    expect(await backend.gitInfo("/elsewhere")).toBeNull();
    // A later change of the key shows on the next lookup, and a folder that left it is gone.
    storage.setItem(WEB_GIT_KEY, JSON.stringify({ "/proj": "feature/x" }));
    expect(await backend.gitInfo("/proj")).toEqual({ branch: "feature/x", detached: false });
    expect(await backend.gitInfo("/old")).toBeNull();
  });

  it("skips the entries of a git seed that are not usable, and ignores a seed that is not an object", async () => {
    const storage = memoryStorage();
    storage.setItem(
      WEB_GIT_KEY,
      JSON.stringify({ "/a": "", "/b": 7, "/c": null, "/d": { branch: 3 }, "/e": "ok" }),
    );
    const backend = new WebBackend(storage);
    for (const folder of ["/a", "/b", "/c", "/d"]) {
      expect(await backend.gitInfo(folder), folder).toBeNull();
    }
    expect(await backend.gitInfo("/e")).toEqual({ branch: "ok", detached: false });
    for (const seed of ["not json", "[1]", "7", "null"]) {
      storage.setItem(WEB_GIT_KEY, seed);
      expect(await backend.gitInfo("/e"), seed).toEqual({ branch: "ok", detached: false });
    }
  });

  describe("config.jsonc", () => {
    it("is empty when the key is not seeded, and is the seeded text when it is", async () => {
      expect(await new WebBackend(memoryStorage()).loadConfig()).toBeNull();
      const storage = memoryStorage();
      storage.setItem(WEB_CONFIG_KEY, "// mine\n{}");
      expect(await new WebBackend(storage).loadConfig()).toBe("// mine\n{}");
    });

    it("keeps a change under the key, so a new backend over the same storage finds it", async () => {
      const storage = memoryStorage();
      const backend = new WebBackend(storage);
      backend.setConfig('{ "appearance": { "tabs": "top" } }');
      expect(storage.getItem(WEB_CONFIG_KEY)).toBe('{ "appearance": { "tabs": "top" } }');
      expect(await new WebBackend(storage).loadConfig()).toBe(
        '{ "appearance": { "tabs": "top" } }',
      );
    });

    it("tells the watchers of a change, and removing the file clears the key", async () => {
      const storage = memoryStorage();
      storage.setItem(WEB_CONFIG_KEY, "{}");
      const backend = new WebBackend(storage);
      const heard: (string | null)[] = [];
      backend.watchConfig((text) => heard.push(text));

      backend.setConfig("{}");
      backend.setConfig("// edited\n{}");
      backend.setConfig(null);
      expect(heard).toEqual(["// edited\n{}", null]);
      expect(storage.getItem(WEB_CONFIG_KEY)).toBeNull();
    });

    it("saves the text of the app under the key too, and tells the watchers", async () => {
      const storage = memoryStorage();
      const backend = new WebBackend(storage);
      const heard: (string | null)[] = [];
      backend.watchConfig((text) => heard.push(text));
      await backend.saveConfig("// saved by the app\n{}");
      expect(storage.getItem(WEB_CONFIG_KEY)).toBe("// saved by the app\n{}");
      expect(heard).toEqual(["// saved by the app\n{}"]);
      expect(await new WebBackend(storage).loadConfig()).toBe("// saved by the app\n{}");
    });

    it("still works in memory when the storage is blocked", async () => {
      const backend = new WebBackend(blockedStorage());
      expect(await backend.loadConfig()).toBeNull();
      await backend.saveConfig("{ }");
      expect(await backend.loadConfig()).toBe("{ }");
      backend.setConfig(null);
      const heard: (string | null)[] = [];
      backend.watchConfig((text) => heard.push(text));
      backend.setConfig("{}");
      expect(heard).toEqual(["{}"]);
      expect(await backend.loadConfig()).toBe("{}");
    });
  });

  describe("theme files of the user", () => {
    it("has none at first, and a saved theme is found by a new backend over the same storage", async () => {
      const storage = memoryStorage();
      const backend = new WebBackend(storage);
      expect(await backend.listUserThemes()).toEqual([]);
      const lagoon = '{ "id": "lagoon" }\n';
      const bay = '{ "id": "bay" }\n';
      await backend.saveUserTheme("lagoon", lagoon);
      await backend.saveUserTheme("bay", bay);
      expect(JSON.parse(storage.getItem(WEB_THEMES_KEY) ?? "null")).toEqual({ lagoon, bay });
      expect(await new WebBackend(storage).listUserThemes()).toEqual([bay, lagoon]);
    });

    it("lists the files seeded under the key, skipping entries that are not text", async () => {
      const storage = memoryStorage();
      storage.setItem(WEB_THEMES_KEY, JSON.stringify({ a: "{}", b: 7, c: null, d: "not json" }));
      expect(await new WebBackend(storage).listUserThemes()).toEqual(["{}", "not json"]);
    });

    it("ignores a seed that is not an object", async () => {
      for (const seed of ["not json", "[1]", "7", "null"]) {
        const storage = memoryStorage();
        storage.setItem(WEB_THEMES_KEY, seed);
        expect(await new WebBackend(storage).listUserThemes(), seed).toEqual([]);
      }
    });

    it("refuses an id that is not a theme id and keeps the storage as it was", async () => {
      const storage = memoryStorage();
      const backend = new WebBackend(storage);
      await expect(backend.saveUserTheme("../x", "{}")).rejects.toThrow(/not a valid theme id/);
      expect(storage.getItem(WEB_THEMES_KEY)).toBeNull();
    });

    it("still works in memory when the storage is blocked", async () => {
      const backend = new WebBackend(blockedStorage());
      await backend.saveUserTheme("lagoon", "{}");
      expect(await backend.listUserThemes()).toEqual(["{}"]);
    });

    it("keeps a deletion in the storage, so a reload does not bring the theme back", async () => {
      const storage = memoryStorage();
      const backend = new WebBackend(storage);
      await backend.saveUserTheme("lagoon", "{ }");
      await backend.saveUserTheme("bay", "{ }");
      await expect(backend.deleteUserTheme("lagoon")).resolves.toBe(true);
      expect(JSON.parse(storage.getItem(WEB_THEMES_KEY) ?? "null")).toEqual({ bay: "{ }" });
      expect(await new WebBackend(storage).listUserThemes()).toEqual(["{ }"]);
      await expect(backend.deleteUserTheme("lagoon")).resolves.toBe(false);
    });

    it("has the fake save chooser of the fake backend: a closed chooser unless a test answers it", async () => {
      const backend = new WebBackend(memoryStorage());
      const options = { fileName: "a.json", text: "{ }", title: "t", filter: "f" };
      await expect(backend.exportUserTheme(options)).resolves.toBeNull();
      backend.setThemeExportPick("C:\\out\\a.json");
      await expect(backend.exportUserTheme(options)).resolves.toBe("C:\\out\\a.json");
      expect(backend.exportedThemeFiles).toEqual({ "C:\\out\\a.json": "{ }" });
    });
  });

  describe("fonts", () => {
    it("lists the families the terminal falls back to, since a browser cannot list the installed fonts", async () => {
      expect(await new WebBackend(memoryStorage()).listMonospaceFonts()).toEqual([
        "Cascadia Mono",
        "Consolas",
        "DejaVu Sans Mono",
      ]);
    });

    it("writes nothing to the storage", async () => {
      const storage = memoryStorage();
      await new WebBackend(storage).listMonospaceFonts();
      expect(storage.keys()).toEqual([]);
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  WEB_ACTIONS_KEY,
  WEB_GIT_KEY,
  WEB_PROFILES_KEY,
  WEB_STATE_KEY,
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
    keys: () => [...values.keys()],
  };
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
    const blocked: StateStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const backend = new WebBackend(blocked);
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
});

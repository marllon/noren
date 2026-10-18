import { describe, expect, it } from "vitest";
import { WEB_STATE_KEY, WebBackend } from "./web-backend";
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
});

import { describe, expect, it } from "vitest";
import { WEB_SCROLLBACK_KEY, WebBackend, seededScrollback } from "./web-backend";
import type { StateStorage } from "./web-backend";

// The scrollback snapshots of web mode live in the browser storage, so a reload finds them.

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

describe("WebBackend scrollback", () => {
  it("keeps a saved snapshot in the storage, and a new backend over it finds the snapshot", async () => {
    const storage = memoryStorage();
    await new WebBackend(storage).saveScrollback("pane-1", "old\noutput");
    expect(JSON.parse(storage.getItem(WEB_SCROLLBACK_KEY) ?? "null")).toEqual({
      "pane-1": "old\noutput",
    });
    expect(await new WebBackend(storage).loadScrollback("pane-1")).toBe("old\noutput");
    expect(await new WebBackend(storage).loadScrollback("pane-2")).toBeNull();
  });

  it("keeps the snapshots of different panes side by side and replaces the one saved again", async () => {
    const storage = memoryStorage();
    const backend = new WebBackend(storage);
    await backend.saveScrollback("pane-1", "one");
    await backend.saveScrollback("pane-2", "two");
    await backend.saveScrollback("pane-1", "one again");
    expect(seededScrollback(storage)).toEqual({ "pane-1": "one again", "pane-2": "two" });
  });

  it("removes the snapshot, and the key when none is left", async () => {
    const storage = memoryStorage();
    const backend = new WebBackend(storage);
    await backend.saveScrollback("pane-1", "one");
    await backend.saveScrollback("pane-2", "two");
    await backend.deleteScrollback("pane-1");
    expect(seededScrollback(storage)).toEqual({ "pane-2": "two" });
    await backend.deleteScrollback("pane-2");
    expect(storage.getItem(WEB_SCROLLBACK_KEY)).toBeNull();
    // A pane that has none is not an error.
    await backend.deleteScrollback("pane-3");
  });

  it("starts with the snapshots seeded in the storage", async () => {
    const storage = memoryStorage();
    storage.setItem(WEB_SCROLLBACK_KEY, JSON.stringify({ "pane-1": "seeded", "pane-2": 5 }));
    const backend = new WebBackend(storage);
    expect(await backend.loadScrollback("pane-1")).toBe("seeded");
    // A value that is not text is left out.
    expect(await backend.loadScrollback("pane-2")).toBeNull();
  });

  it("ignores a seed that is not a table of texts", () => {
    for (const seed of ["not json", "[]", "5", "null", '"text"']) {
      const storage = memoryStorage();
      storage.setItem(WEB_SCROLLBACK_KEY, seed);
      expect(seededScrollback(storage), seed).toBeUndefined();
    }
    expect(seededScrollback(memoryStorage())).toBeUndefined();
  });

  it("refuses an id that is not a file name, like the real store", async () => {
    const storage = memoryStorage();
    const backend = new WebBackend(storage);
    await expect(backend.saveScrollback("../escape", "x")).rejects.toThrow("not a valid pane id");
    await expect(backend.loadScrollback("a/b")).rejects.toThrow("not a valid pane id");
    await expect(backend.deleteScrollback("con")).rejects.toThrow("not a valid pane id");
    expect(storage.getItem(WEB_SCROLLBACK_KEY)).toBeNull();
  });

  it("serves the snapshot from memory when the storage is blocked", async () => {
    const backend = new WebBackend(blockedStorage());
    await backend.saveScrollback("pane-1", "in memory");
    expect(await backend.loadScrollback("pane-1")).toBe("in memory");
  });
});

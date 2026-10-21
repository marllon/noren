import { describe, expect, it } from "vitest";
import { WEB_HARDWARE_KEY, WebBackend, seededHardware } from "./web-backend";
import type { StateStorage } from "./web-backend";

// The memory of the computer a test can seed in web mode (the key `WEB_HARDWARE_KEY`), which the
// recommended models of the settings screen then read through `readHardware`.

function storageWith(value: string | undefined): StateStorage {
  const values = new Map<string, string>(value === undefined ? [] : [[WEB_HARDWARE_KEY, value]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, text) => {
      values.set(key, text);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("seededHardware", () => {
  it("has no seed without the key, with text that is not JSON or with a value that is no memory", () => {
    expect(seededHardware(storageWith(undefined))).toBeUndefined();
    expect(seededHardware(storageWith("not json"))).toBeUndefined();
    expect(seededHardware(storageWith("[]"))).toBeUndefined();
    expect(seededHardware(storageWith("3"))).toBeUndefined();
    expect(seededHardware(storageWith(JSON.stringify({ ramBytes: -1, vramBytes: null })))).toBe(
      undefined,
    );
    expect(seededHardware(storageWith(JSON.stringify({ ramBytes: 1.5 })))).toBeUndefined();
  });

  it("keeps a memory, and reads a missing or invalid video memory as unknown", () => {
    expect(
      seededHardware(storageWith(JSON.stringify({ ramBytes: 8589934592, vramBytes: null }))),
    ).toEqual({ ramBytes: 8589934592, vramBytes: null });
    expect(seededHardware(storageWith(JSON.stringify({ ramBytes: 8589934592 })))).toEqual({
      ramBytes: 8589934592,
      vramBytes: null,
    });
    expect(
      seededHardware(storageWith(JSON.stringify({ ramBytes: 8589934592, vramBytes: -5 }))),
    ).toEqual({ ramBytes: 8589934592, vramBytes: null });
    expect(
      seededHardware(
        storageWith(JSON.stringify({ ramBytes: 8589934592, vramBytes: 25769803776, extra: 1 })),
      ),
    ).toEqual({ ramBytes: 8589934592, vramBytes: 25769803776 });
  });

  it("is a storage that refuses to be read: no seed", () => {
    const blocked: StateStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(seededHardware(blocked)).toBeUndefined();
  });

  it("reaches readHardware of the web backend, and a web page without a seed knows nothing", async () => {
    const seeded = new WebBackend(
      storageWith(JSON.stringify({ ramBytes: 17179869184, vramBytes: 6442450944 })),
    );
    await expect(seeded.readHardware()).resolves.toEqual({
      ramBytes: 17179869184,
      vramBytes: 6442450944,
    });
    await expect(new WebBackend(storageWith(undefined)).readHardware()).resolves.toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { WEB_BENCH_RESULTS_KEY, WebBackend, seededBenchResults } from "./web-backend";
import type { StateStorage } from "./web-backend";

// The bench result files a test can seed in web mode (the key `WEB_BENCH_RESULTS_KEY`), which the
// settings screen then reads through `listBenchResults` like the ones in the data folder.

function storageWith(value: string | undefined): StateStorage {
  const values = new Map<string, string>(
    value === undefined ? [] : [[WEB_BENCH_RESULTS_KEY, value]],
  );
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

describe("seededBenchResults", () => {
  it("has no seed without the key or with a value that is not an object of files", () => {
    expect(seededBenchResults(storageWith(undefined))).toBeUndefined();
    expect(seededBenchResults(storageWith("not json"))).toBeUndefined();
    expect(seededBenchResults(storageWith("[]"))).toBeUndefined();
    expect(seededBenchResults(storageWith("3"))).toBeUndefined();
  });

  it("keeps a text as it is, writes an object as JSON and leaves out anything else", () => {
    const files = seededBenchResults(
      storageWith(
        JSON.stringify({
          "a.json": '{"x":1}',
          "b.json": { y: 2 },
          "c.json": 7,
          "d.json": null,
          "e.json": [1],
        }),
      ),
    );
    expect(files).toEqual({ "a.json": '{"x":1}', "b.json": '{\n  "y": 2\n}' });
  });

  it("is a storage that refuses to be read: no seed", () => {
    const blocked: StateStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(seededBenchResults(blocked)).toBeUndefined();
  });

  it("reaches listBenchResults of the web backend, newest first", async () => {
    const backend = new WebBackend(
      storageWith(
        JSON.stringify({ "2026-10-20-100000.json": { a: 1 }, "2026-10-20-110000.json": { b: 2 } }),
      ),
    );
    const files = await backend.listBenchResults();
    expect(files.map((file) => file.name)).toEqual([
      "2026-10-20-110000.json",
      "2026-10-20-100000.json",
    ]);
  });
});

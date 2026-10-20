import { describe, expect, it } from "vitest";
import { WEB_FILES_KEY, WebBackend, seededFiles } from "./web-backend";
import type { StateStorage } from "./web-backend";

// The files a preview pane can read in web mode: seeded in the browser storage before the page loads
// (as the e2e tests do) or placed with `setFile`, and found again after a reload.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const encode = (text: string) => new TextEncoder().encode(text);

function memoryStorage(initial: Record<string, string> = {}): StateStorage {
  const values = new Map(Object.entries(initial));
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

describe("WebBackend files for a preview", () => {
  it("reads the files and folders of the seed, by full path", async () => {
    const storage = memoryStorage({
      [WEB_FILES_KEY]: JSON.stringify({
        "/docs/notes.md": base64(encode("# Notes")),
        "/docs/pixel.png": base64(PNG),
        "/docs": null,
        "/bad": 3,
        "/worse": "***",
      }),
    });
    expect(Object.keys(seededFiles(storage) ?? {}).sort()).toEqual([
      "/docs",
      "/docs/notes.md",
      "/docs/pixel.png",
    ]);
    const backend = new WebBackend(storage);
    expect(await backend.readFilePreview("/docs/notes.md")).toEqual({
      kind: "markdown",
      text: "# Notes",
    });
    expect(await backend.readFilePreview("/docs/pixel.png")).toMatchObject({
      kind: "image",
      mime: "image/png",
    });
    expect(await backend.readFilePreview("/docs")).toEqual({
      kind: "refused",
      reason: "directory",
    });
    expect(await backend.readFilePreview("/bad")).toEqual({ kind: "refused", reason: "missing" });
    expect(await backend.readFilePreview("docs/notes.md")).toEqual({
      kind: "refused",
      reason: "relative",
    });
  });

  it("keeps a file placed with setFile in the storage, so a reload finds it", async () => {
    const storage = memoryStorage();
    const first = new WebBackend(storage);
    first.setFile("/a.txt", "first");
    first.setDirectory("/folder");
    const second = new WebBackend(storage);
    expect(await second.readFilePreview("/a.txt")).toEqual({ kind: "text", text: "first" });
    expect(await second.readFilePreview("/folder")).toMatchObject({ reason: "directory" });
    second.setFile("/a.txt", "again");
    expect(await new WebBackend(storage).readFilePreview("/a.txt")).toEqual({
      kind: "text",
      text: "again",
    });
    new WebBackend(storage).setFile("/a.txt", null);
    expect(await new WebBackend(storage).readFilePreview("/a.txt")).toMatchObject({
      reason: "missing",
    });
    expect(await new WebBackend(storage).readFilePreview("/folder")).toMatchObject({
      reason: "directory",
    });
  });

  it("has no file when there is no seed or the seed is not an object", async () => {
    for (const raw of ["[]", "3", "{", "null"]) {
      expect(seededFiles(memoryStorage({ [WEB_FILES_KEY]: raw })), raw).toBeUndefined();
    }
    expect(seededFiles(memoryStorage())).toBeUndefined();
    expect(await new WebBackend(memoryStorage()).readFilePreview("/a.txt")).toMatchObject({
      reason: "missing",
    });
  });
});

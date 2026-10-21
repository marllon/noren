import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { compareWithInstalled, parseGalleryIndex } from "./gallery";
import type { GalleryIndex, GalleryItem } from "./gallery";
import {
  FAKE_GALLERY_DOWNLOADS,
  FAKE_GALLERY_HASHES,
  FAKE_GALLERY_INDEX,
  FAKE_GALLERY_LAGOON,
  FAKE_GALLERY_MOD,
} from "./gallery-fixture";
import { parseTheme } from "./theme";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("the gallery fixture", () => {
  it("is a valid index", () => {
    expect(parseGalleryIndex(FAKE_GALLERY_INDEX).ok).toBe(true);
  });

  it("has a hash for every text that is the sha256 of the bytes, and a size that is their length", () => {
    for (const item of FAKE_GALLERY_INDEX.items) {
      const served = FAKE_GALLERY_DOWNLOADS[item.id];
      expect(served, item.id).toBeDefined();
      if (served === undefined) continue;
      expect(served.sha256, item.id).toBe(sha256(served.text));
      expect(item.size, item.id).toBe(new TextEncoder().encode(served.text).length);
    }
    expect(Object.values(FAKE_GALLERY_HASHES).sort()).toEqual(
      Object.values(FAKE_GALLERY_DOWNLOADS)
        .map((served) => served.sha256)
        .sort(),
    );
  });

  it("has exactly one item whose declared hash is not the hash of what it serves", () => {
    const wrong = FAKE_GALLERY_INDEX.items.filter(
      (item) => FAKE_GALLERY_DOWNLOADS[item.id]?.sha256 !== item.sha256,
    );
    expect(wrong.map((item) => item.id)).toEqual(["tampered"]);
  });

  it("serves themes that are valid themes with the id of their item", () => {
    for (const item of FAKE_GALLERY_INDEX.items.filter((entry) => entry.kind === "theme")) {
      const parsed = parseTheme(JSON.parse(FAKE_GALLERY_DOWNLOADS[item.id]?.text ?? "null"));
      expect(parsed.ok, item.id).toBe(true);
      if (parsed.ok) expect(parsed.theme.id).toBe(item.id);
    }
  });
});

describe("FakeBackend gallery", () => {
  it("answers the fixture index and no installed items to begin with", async () => {
    const backend = new FakeBackend();
    expect(await backend.galleryIndex()).toEqual(FAKE_GALLERY_INDEX);
    expect(await backend.galleryInstalled()).toEqual([]);
    expect(backend.calls.map((call) => call.method)).toEqual(["galleryIndex", "galleryInstalled"]);
  });

  it("installs a theme as the file of the user and a mod as a mod file, and records both", async () => {
    const backend = new FakeBackend();
    const heard: string[][] = [];
    backend.watchMods((files) => heard.push(files.map((file) => file.name)));

    expect(await backend.galleryInstall("lagoon")).toEqual({
      id: "lagoon",
      kind: "theme",
      version: "1.1.0",
      sha256: FAKE_GALLERY_HASHES.lagoon,
    });
    expect(await backend.galleryInstall("compact-tabs")).toMatchObject({ kind: "mod" });

    expect(backend.userThemeFiles).toEqual({ lagoon: FAKE_GALLERY_LAGOON });
    expect(backend.modFiles).toEqual({ "compact-tabs.css": FAKE_GALLERY_MOD });
    expect(heard).toEqual([["compact-tabs.css"]]);
    expect((await backend.galleryInstalled()).map((entry) => entry.id)).toEqual([
      "lagoon",
      "compact-tabs",
    ]);
  });

  it("refuses the item whose hash does not match and writes nothing", async () => {
    const backend = new FakeBackend();
    await expect(backend.galleryInstall("tampered")).rejects.toThrow(/sha256/);
    expect(backend.userThemeFiles).toEqual({});
    expect(await backend.galleryInstalled()).toEqual([]);
  });

  it("refuses an unknown id, an address that serves nothing and a file over its declared size", async () => {
    const backend = new FakeBackend();
    await expect(backend.galleryInstall("nothing-here")).rejects.toThrow(/no item/);

    const index: GalleryIndex = {
      version: 1,
      items: [
        {
          id: "big",
          kind: "mod",
          name: "Big",
          version: "1.0.0",
          url: "https://gallery.example/big.css",
          sha256: "a".repeat(64),
          size: 4,
        },
        { ...(FAKE_GALLERY_INDEX.items[1] as GalleryItem), id: "gone" },
      ],
    };
    backend.setGalleryIndex(index, { big: { text: "a { color: red }", sha256: "a".repeat(64) } });
    await expect(backend.galleryInstall("big")).rejects.toThrow(/larger/);
    await expect(backend.galleryInstall("gone")).rejects.toThrow(/served nothing/);
    expect(backend.modFiles).toEqual({});
    expect(await backend.galleryInstalled()).toEqual([]);
  });

  it("an update replaces the record and the file, and the comparison then calls it up to date", async () => {
    const backend = new FakeBackend();
    backend.setGalleryInstalled([
      { id: "lagoon", kind: "theme", version: "1.0.0", sha256: "b".repeat(64) },
    ]);
    const before = compareWithInstalled(
      await backend.galleryIndex(),
      await backend.galleryInstalled(),
    );
    expect(before[0]).toMatchObject({ status: "update", installedVersion: "1.0.0" });

    await backend.galleryInstall("lagoon");
    const installed = await backend.galleryInstalled();
    expect(installed).toEqual([
      { id: "lagoon", kind: "theme", version: "1.1.0", sha256: FAKE_GALLERY_HASHES.lagoon },
    ]);
    const after = compareWithInstalled(await backend.galleryIndex(), installed);
    expect(after[0]?.status).toBe("current");
    expect(after[1]?.status).toBe("new");
  });

  it("rejects when the gallery cannot be reached, until the failure is undone", async () => {
    const backend = new FakeBackend();
    backend.setGalleryFailure(new Error("could not reach the gallery"));
    await expect(backend.galleryIndex()).rejects.toThrow("could not reach the gallery");
    await expect(backend.galleryInstall("lagoon")).rejects.toThrow("could not reach the gallery");
    backend.setGalleryFailure(undefined);
    await expect(backend.galleryIndex()).resolves.toBeDefined();
  });

  it("serves a gallery of the test with setGalleryIndex", async () => {
    const backend = new FakeBackend();
    backend.setGalleryIndex({ version: 1, items: [] }, {});
    expect((await backend.galleryIndex()).items).toEqual([]);
  });
});

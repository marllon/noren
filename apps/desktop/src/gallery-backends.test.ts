import { describe, expect, it } from "vitest";
import { FAKE_GALLERY_INDEX } from "@noren/model";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import { WEB_GALLERY_KEY, WebBackend } from "./web-backend";

// The gallery through the two backends the app runs on: the Tauri one (`gallery_index`,
// `gallery_installed` and `gallery_install` of src-tauri/src/bridge.rs) and the web one, which
// serves the fixture of `FakeBackend` or a gallery seeded for a test.

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

const sha = "a".repeat(64);
const index = {
  version: 1,
  items: [
    {
      id: "lagoon",
      kind: "theme",
      name: "Lagoon",
      version: "1.0.0",
      url: "https://example.com/lagoon.json",
      sha256: sha,
      size: 10,
    },
  ],
};

describe("TauriBackend gallery", () => {
  it("reads the index text of gallery_index and checks it", async () => {
    const fake = bridgeAnswering({
      gallery_index: String.fromCharCode(0xfeff) + JSON.stringify(index),
    });
    await expect(new TauriBackend(fake.bridge).galleryIndex()).resolves.toEqual(index);
    expect(fake.invocations).toEqual([{ command: "gallery_index", args: undefined }]);
  });

  it("rejects an index that is not JSON or not an index, and a failing command", async () => {
    const text = bridgeAnswering({ gallery_index: "{ nope" });
    await expect(new TauriBackend(text.bridge).galleryIndex()).rejects.toThrow("not valid JSON");
    const wrong = bridgeAnswering({
      gallery_index: JSON.stringify({ version: 1, items: [{ ...index.items[0], sha256: "x" }] }),
    });
    await expect(new TauriBackend(wrong.bridge).galleryIndex()).rejects.toThrow(/items\.0\.sha256/);
    const broken = bridgeAnswering({}, ["gallery_index"]);
    await expect(new TauriBackend(broken.bridge).galleryIndex()).rejects.toThrow(
      "gallery_index failed",
    );
  });

  it("lists the installed items, dropping what is not a record", async () => {
    const fake = bridgeAnswering({
      gallery_installed: [
        { id: "lagoon", kind: "theme", version: "1.0.0", sha256: sha, extra: 1 },
        { id: "x", kind: "plugin", version: "1.0.0", sha256: sha },
        { id: "y", kind: "mod", version: 1, sha256: sha },
        null,
        7,
      ],
    });
    await expect(new TauriBackend(fake.bridge).galleryInstalled()).resolves.toEqual([
      { id: "lagoon", kind: "theme", version: "1.0.0", sha256: sha },
    ]);
    const none = bridgeAnswering({ gallery_installed: null });
    await expect(new TauriBackend(none.bridge).galleryInstalled()).resolves.toEqual([]);
  });

  it("installs through gallery_install with the id, and rejects with the message of the app", async () => {
    const fake = bridgeAnswering({
      gallery_install: { id: "lagoon", kind: "theme", version: "1.0.0", sha256: sha },
    });
    await expect(new TauriBackend(fake.bridge).galleryInstall("lagoon")).resolves.toEqual({
      id: "lagoon",
      kind: "theme",
      version: "1.0.0",
      sha256: sha,
    });
    expect(fake.invocations).toEqual([{ command: "gallery_install", args: { id: "lagoon" } }]);

    const odd = bridgeAnswering({ gallery_install: { id: "lagoon" } });
    await expect(new TauriBackend(odd.bridge).galleryInstall("lagoon")).rejects.toThrow(
      "not valid",
    );
    const refused = bridgeAnswering({}, ["gallery_install"]);
    await expect(new TauriBackend(refused.bridge).galleryInstall("lagoon")).rejects.toThrow(
      "gallery_install failed",
    );
  });
});

describe("WebBackend gallery", () => {
  const storageWith = (seed: string | null) => ({
    getItem: (key: string) => (key === WEB_GALLERY_KEY ? seed : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  });

  it("serves the fixture of the fake backend when nothing is seeded", async () => {
    await expect(new WebBackend(storageWith(null)).galleryIndex()).resolves.toEqual(
      FAKE_GALLERY_INDEX,
    );
  });

  it("serves the gallery seeded under noren.web.gallery, and installs from its downloads", async () => {
    const text = '{"id":"lagoon"}';
    const seed = JSON.stringify({
      index: { ...index, items: [{ ...index.items[0], sha256: sha, size: text.length }] },
      downloads: { lagoon: { text, sha256: sha }, broken: 7 },
    });
    const backend = new WebBackend(storageWith(seed));
    expect((await backend.galleryIndex()).items.map((item) => item.id)).toEqual(["lagoon"]);
    await expect(backend.galleryInstall("lagoon")).resolves.toMatchObject({ id: "lagoon" });
    expect(backend.userThemeFiles).toEqual({ lagoon: text });
  });

  it("answers the installed items seeded with the gallery, and leaves out the ones that are not records", async () => {
    const seed = JSON.stringify({
      index,
      installed: [
        { id: "lagoon", kind: "theme", version: "0.9.0", sha256: sha },
        { id: "bad-kind", kind: "plugin", version: "1.0.0", sha256: sha },
        { id: "no-version", kind: "mod", sha256: sha },
        7,
      ],
    });
    await expect(new WebBackend(storageWith(seed)).galleryInstalled()).resolves.toEqual([
      { id: "lagoon", kind: "theme", version: "0.9.0", sha256: sha },
    ]);
    await expect(
      new WebBackend(storageWith(JSON.stringify({ index }))).galleryInstalled(),
    ).resolves.toEqual([]);
  });

  it("keeps the fixture when the seed is not an index", async () => {
    for (const seed of ["{}", "[]", "nope", JSON.stringify({ index: { version: 2, items: [] } })]) {
      await expect(new WebBackend(storageWith(seed)).galleryIndex()).resolves.toEqual(
        FAKE_GALLERY_INDEX,
      );
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBackend } from "@noren/model";
import {
  getPicture,
  pictureUrl,
  resetBackgroundImages,
  showBackgroundImage,
  startBackgroundImages,
} from "./background-image-store";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

/** Lets the promises of the store settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  let count = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const address = `blob:test/${++count}`;
    created.push(address);
    return address;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((address) => {
    revoked.push(address);
  });
});

afterEach(() => {
  resetBackgroundImages();
  vi.restoreAllMocks();
});

describe("the picture behind the terminals", () => {
  it("is none until a path is wanted, and none again for null", async () => {
    const backend = new FakeBackend({ images: { "a.png": PNG } });
    startBackgroundImages(backend);
    expect(getPicture()).toEqual({ status: "none" });
    showBackgroundImage("a.png");
    await settle();
    expect(getPicture().status).toBe("ready");
    showBackgroundImage(null);
    expect(getPicture()).toEqual({ status: "none" });
    expect(pictureUrl(getPicture())).toBeNull();
  });

  it("is loading while the backend reads, then an address of bytes held in memory", async () => {
    const backend = new FakeBackend({ images: { "a.png": PNG } });
    startBackgroundImages(backend);
    showBackgroundImage("a.png");
    expect(getPicture()).toEqual({ status: "loading", path: "a.png" });
    expect(pictureUrl(getPicture())).toBeNull();
    await settle();
    expect(getPicture()).toEqual({ status: "ready", path: "a.png", url: "blob:test/1" });
    expect(pictureUrl(getPicture())).toBe("blob:test/1");
    expect(backend.callsTo("readBackgroundImage").map((call) => call.args)).toEqual([["a.png"]]);
  });

  it("never gives the page a path or a web address: the backend is the only one asked", async () => {
    const backend = new FakeBackend({ images: { "a.png": PNG } });
    startBackgroundImages(backend);
    showBackgroundImage("a.png");
    await settle();
    const picture = getPicture();
    expect(picture.status === "ready" && picture.url.startsWith("blob:")).toBe(true);
  });

  it("fails with the sentence of the backend when the file cannot be read", async () => {
    startBackgroundImages(new FakeBackend());
    showBackgroundImage("missing.png");
    await settle();
    expect(getPicture()).toEqual({
      status: "failed",
      path: "missing.png",
      message: "The image missing.png was not found.",
    });
    expect(pictureUrl(getPicture())).toBeNull();
  });

  // Finding 309: in the app the window asks for the picture the settings name as soon as the
  // settings are read, and the backend reaches the store a moment after that. The ask used to fail
  // with "No backend is available" and never be made again, so the picture of the settings file
  // never showed at the start. The ask now waits, and is made when the backend is handed over.
  it("waits for the backend when the window asks first, and shows the picture once it is there", async () => {
    showBackgroundImage("a.png");
    expect(getPicture()).toEqual({ status: "loading", path: "a.png" });
    await settle();
    expect(getPicture()).toEqual({ status: "loading", path: "a.png" });

    const backend = new FakeBackend({ images: { "a.png": PNG } });
    startBackgroundImages(backend);
    expect(getPicture()).toEqual({ status: "loading", path: "a.png" });
    await settle();
    expect(getPicture()).toEqual({ status: "ready", path: "a.png", url: "blob:test/1" });
    expect(backend.callsTo("readBackgroundImage").map((call) => call.args)).toEqual([["a.png"]]);
  });

  it("reads only the last picture the window asked for before the backend came", async () => {
    showBackgroundImage("a.png");
    showBackgroundImage("b.png");
    const backend = new FakeBackend({ images: { "a.png": PNG, "b.png": PNG } });
    startBackgroundImages(backend);
    await settle();
    expect(getPicture()).toMatchObject({ status: "ready", path: "b.png" });
    expect(backend.callsTo("readBackgroundImage").map((call) => call.args)).toEqual([["b.png"]]);
  });

  it("does not read what the window gave up before the backend came", async () => {
    showBackgroundImage("a.png");
    showBackgroundImage(null);
    const backend = new FakeBackend({ images: { "a.png": PNG } });
    startBackgroundImages(backend);
    await settle();
    expect(getPicture()).toEqual({ status: "none" });
    expect(backend.callsTo("readBackgroundImage")).toEqual([]);
  });

  it("tells why when the backend that came cannot read the picture the window asked for first", async () => {
    showBackgroundImage("missing.png");
    startBackgroundImages(new FakeBackend());
    await settle();
    expect(getPicture()).toEqual({
      status: "failed",
      path: "missing.png",
      message: "The image missing.png was not found.",
    });
  });

  it("does not read the file again for a path it holds, and not twice for the same wish", async () => {
    const backend = new FakeBackend({ images: { "a.png": PNG, "b.png": PNG } });
    startBackgroundImages(backend);
    showBackgroundImage("a.png");
    showBackgroundImage("a.png");
    await settle();
    showBackgroundImage("b.png");
    await settle();
    showBackgroundImage("a.png");
    expect(getPicture()).toMatchObject({ status: "ready", path: "a.png" });
    expect(backend.callsTo("readBackgroundImage").map((call) => call.args)).toEqual([
      ["a.png"],
      ["b.png"],
    ]);
  });

  it("drops an answer for a path the window no longer wants", async () => {
    const backend = new FakeBackend({ images: { "a.png": PNG, "b.png": PNG } });
    startBackgroundImages(backend);
    showBackgroundImage("a.png");
    showBackgroundImage("b.png");
    await settle();
    expect(getPicture()).toMatchObject({ status: "ready", path: "b.png" });
    showBackgroundImage(null);
    showBackgroundImage("a.png");
    expect(getPicture()).toMatchObject({ status: "ready", path: "a.png" });
  });

  it("keeps a few pictures and lets go of the oldest, never the one on screen", async () => {
    const names = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    const backend = new FakeBackend({ images: Object.fromEntries(names.map((n) => [n, PNG])) });
    startBackgroundImages(backend);
    for (const name of names) {
      showBackgroundImage(name);
      await settle();
    }
    expect(created).toHaveLength(5);
    expect(revoked).toEqual(["blob:test/1"]);
    expect(getPicture()).toMatchObject({ status: "ready", path: "e.png" });
  });

  it("lets go of every address when it is reset", async () => {
    startBackgroundImages(new FakeBackend({ images: { "a.png": PNG } }));
    showBackgroundImage("a.png");
    await settle();
    resetBackgroundImages();
    expect(revoked).toEqual(["blob:test/1"]);
    expect(getPicture()).toEqual({ status: "none" });
  });
});

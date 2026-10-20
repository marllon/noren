import { describe, expect, it } from "vitest";
import { FakeBackend } from "./fake-backend";
import { MAX_PREVIEW_TEXT_BYTES } from "./file-preview";
import { encodeUtf8 } from "./utf8";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("FakeBackend.readFilePreview", () => {
  it("reads the files it was given, by the rules of the real side", async () => {
    const backend = new FakeBackend({
      files: {
        "/docs/readme.md": encodeUtf8("# Hi"),
        "/docs/pic.png": PNG,
        "/docs": "directory",
      },
    });
    expect(await backend.readFilePreview("/docs/readme.md")).toEqual({
      kind: "markdown",
      text: "# Hi",
    });
    expect(await backend.readFilePreview("/docs/pic.png")).toEqual({
      kind: "image",
      mime: "image/png",
      bytes: PNG,
    });
    expect(await backend.readFilePreview("/docs")).toEqual({
      kind: "refused",
      reason: "directory",
    });
    expect(await backend.readFilePreview("/docs/none.md")).toEqual({
      kind: "refused",
      reason: "missing",
    });
    expect(await backend.readFilePreview("docs/readme.md")).toEqual({
      kind: "refused",
      reason: "relative",
    });
  });

  it("follows files put in place and taken away afterwards", async () => {
    const backend = new FakeBackend();
    expect(await backend.readFilePreview("/a.txt")).toMatchObject({ reason: "missing" });
    backend.setFile("/a.txt", "first");
    expect(await backend.readFilePreview("/a.txt")).toEqual({ kind: "text", text: "first" });
    backend.setFile("/a.txt", "second");
    expect(await backend.readFilePreview("/a.txt")).toEqual({ kind: "text", text: "second" });
    backend.setDirectory("/a.txt");
    expect(await backend.readFilePreview("/a.txt")).toMatchObject({ reason: "directory" });
    backend.setFile("/a.txt", null);
    expect(await backend.readFilePreview("/a.txt")).toMatchObject({ reason: "missing" });
  });

  it("refuses a file over the limit and a binary one", async () => {
    const backend = new FakeBackend({
      files: {
        "/big.txt": new Uint8Array(MAX_PREVIEW_TEXT_BYTES + 1).fill(0x61),
        "/prog.bin": Uint8Array.from([0x4d, 0x5a, 0, 1]),
      },
    });
    expect(await backend.readFilePreview("/big.txt")).toEqual({
      kind: "refused",
      reason: "too-large",
      size: MAX_PREVIEW_TEXT_BYTES + 1,
    });
    expect(await backend.readFilePreview("/prog.bin")).toEqual({
      kind: "refused",
      reason: "binary",
    });
  });

  it("records every read and writes nothing", async () => {
    const backend = new FakeBackend({ files: { "/a.txt": new Uint8Array(0) } });
    await backend.readFilePreview("/a.txt");
    await backend.readFilePreview("/missing.txt");
    expect(backend.callsTo("readFilePreview").map((call) => call.args)).toEqual([
      ["/a.txt"],
      ["/missing.txt"],
    ]);
    expect(backend.fileAt("/a.txt")).toEqual(new Uint8Array(0));
  });

  it("hands out a copy of a picture, so the page cannot change the file", async () => {
    const backend = new FakeBackend({ files: { "/p.png": PNG.slice() } });
    const first = await backend.readFilePreview("/p.png");
    if (first.kind !== "image") throw new Error("not an image");
    first.bytes[0] = 0;
    const second = await backend.readFilePreview("/p.png");
    expect(second).toMatchObject({ kind: "image" });
    if (second.kind === "image") expect(second.bytes[0]).toBe(0x89);
  });
});

import { describe, expect, it } from "vitest";
import { MAX_BACKGROUND_BYTES } from "./background";
import { createDefaultWorkspace } from "./default-workspace";
import { FakeBackend } from "./fake-backend";
import { parseState, serializeWorkspace } from "./state";
import { applyChecked as apply } from "./test-helpers";
import type { Space, Workspace } from "./types";

// The picture of a space (`space/set-background`), how it is saved, and the two calls of the
// backend that serve the window (`setWindowEffect`, `readBackgroundImage`).

function fixture(): Workspace {
  return createDefaultWorkspace();
}

/** The first space of a workspace (the default one has it). */
function firstSpace(ws: Workspace): Space {
  const [space] = ws.spaces;
  if (space === undefined) throw new Error("the workspace has no space");
  return space;
}

const spaceId = (ws: Workspace) => firstSpace(ws).id;

describe("space/set-background", () => {
  it("gives the space a picture, trimmed, and takes it back with null", () => {
    const ws = fixture();
    const set = apply(ws, {
      type: "space/set-background",
      spaceId: spaceId(ws),
      background: { image: "  C:\\Pictures\\sky.png  " },
    });
    expect(firstSpace(set).background).toEqual({ image: "C:\\Pictures\\sky.png" });
    const cleared = apply(set, {
      type: "space/set-background",
      spaceId: spaceId(ws),
      background: null,
    });
    expect("background" in firstSpace(cleared)).toBe(false);
  });

  it("keeps the opacity and the blur held to their range, and leaves out what is not a number", () => {
    const ws = fixture();
    const id = spaceId(ws);
    const background = (value: { image: string; opacity?: number; blur?: number }) =>
      firstSpace(apply(ws, { type: "space/set-background", spaceId: id, background: value }))
        .background;
    expect(background({ image: "a.png", opacity: 0.4, blur: 8 })).toEqual({
      image: "a.png",
      opacity: 0.4,
      blur: 8,
    });
    expect(background({ image: "a.png", opacity: 5, blur: 500 })).toEqual({
      image: "a.png",
      opacity: 1,
      blur: 100,
    });
    expect(background({ image: "a.png", opacity: -3, blur: -3 })).toEqual({
      image: "a.png",
      opacity: 0,
      blur: 0,
    });
    expect(
      background({ image: "a.png", opacity: Number.NaN, blur: Number.POSITIVE_INFINITY }),
    ).toEqual({ image: "a.png" });
  });

  it("changes nothing for a path that cannot be a background", () => {
    const ws = fixture();
    for (const image of [
      "",
      "  ",
      "https://example.com/a.png",
      "file:///C:/a.png",
      "\\\\server\\share\\a.png",
      "../a.png",
      "notes.txt",
    ]) {
      const next = apply(ws, {
        type: "space/set-background",
        spaceId: spaceId(ws),
        background: { image },
      });
      expect(next, image).toBe(ws);
    }
  });

  it("returns the same workspace for an unchanged picture, an unknown space or none to take back", () => {
    const ws = fixture();
    const id = spaceId(ws);
    const set = apply(ws, {
      type: "space/set-background",
      spaceId: id,
      background: { image: "a.png", opacity: 0.2 },
    });
    expect(
      apply(set, {
        type: "space/set-background",
        spaceId: id,
        background: { image: "a.png", opacity: 0.2 },
      }),
    ).toBe(set);
    expect(
      apply(set, { type: "space/set-background", spaceId: "nope", background: { image: "b.png" } }),
    ).toBe(set);
    expect(apply(ws, { type: "space/set-background", spaceId: id, background: null })).toBe(ws);
  });

  it("is kept in state.json and read back", () => {
    const ws = fixture();
    const set = apply(ws, {
      type: "space/set-background",
      spaceId: spaceId(ws),
      background: { image: "backgrounds/sky.jpg", opacity: 0.25, blur: 4 },
    });
    const parsed = parseState(serializeWorkspace(set));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(firstSpace(parsed.workspace).background).toEqual({
        image: "backgrounds/sky.jpg",
        opacity: 0.25,
        blur: 4,
      });
    }
  });

  it("is refused by state.json when it is not shaped like a picture", () => {
    const ws = fixture();
    const bad = JSON.parse(serializeWorkspace(ws)) as { spaces: Record<string, unknown>[] };
    for (const background of [
      { image: 3 },
      { opacity: 1 },
      "sky.png",
      { image: "a.png", blur: "x" },
    ]) {
      Object.assign(bad.spaces[0] ?? {}, { background });
      const parsed = parseState(JSON.stringify(bad));
      expect(parsed.ok, JSON.stringify(background)).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("background");
    }
  });
});

describe("FakeBackend.setWindowEffect", () => {
  it("applies an effect the fake system paints, and none always", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica", "acrylic"] });
    expect(await backend.setWindowEffect("mica", "dark")).toEqual({
      requested: "mica",
      applied: "mica",
    });
    expect(backend.appliedWindowEffect).toBe("mica");
    expect(await backend.setWindowEffect("none", "dark")).toEqual({
      requested: "none",
      applied: "none",
    });
    expect(backend.appliedWindowEffect).toBe("none");
  });

  it("falls back to opaque, without an error, for an effect the system cannot paint", async () => {
    const backend = new FakeBackend({ windowEffects: ["mica"] });
    await backend.setWindowEffect("mica", "light");
    const report = await backend.setWindowEffect("vibrancy", "light");
    expect(report).toMatchObject({ requested: "vibrancy", applied: "none" });
    expect(report.reason).toMatch(/Vibrancy/);
    expect(backend.appliedWindowEffect).toBe("none");
    // By default the fake system paints nothing.
    const plain = new FakeBackend();
    expect((await plain.setWindowEffect("mica", "dark")).applied).toBe("none");
  });

  it("records the effect and the scheme it was asked for", async () => {
    const backend = new FakeBackend({ windowEffects: ["acrylic"] });
    await backend.setWindowEffect("acrylic", "light");
    expect(backend.callsTo("setWindowEffect").map((call) => call.args)).toEqual([
      ["acrylic", "light"],
    ]);
  });
});

describe("FakeBackend.pickBackgroundImage", () => {
  const words = { title: "Choose a background image", filter: "Pictures" };

  it("is closed without a choice (null) until a test queues what the person chooses", async () => {
    const backend = new FakeBackend();
    await expect(backend.pickBackgroundImage(words)).resolves.toBeNull();
  });

  it("answers what was queued, one answer for each time it is opened, in order", async () => {
    const backend = new FakeBackend();
    backend.setImagePick("C:\\Pictures\\a.png");
    backend.setImagePick(null);
    backend.setImagePick("C:\\Pictures\\b.png");
    await expect(backend.pickBackgroundImage(words)).resolves.toBe("C:\\Pictures\\a.png");
    await expect(backend.pickBackgroundImage(words)).resolves.toBeNull();
    await expect(backend.pickBackgroundImage(words)).resolves.toBe("C:\\Pictures\\b.png");
    await expect(backend.pickBackgroundImage(words)).resolves.toBeNull();
  });

  it("rejects when what was queued is an error, once, and then it is closed again", async () => {
    const backend = new FakeBackend();
    backend.setImagePick(new Error("no window to open it over"));
    await expect(backend.pickBackgroundImage(words)).rejects.toThrow("no window to open it over");
    await expect(backend.pickBackgroundImage(words)).resolves.toBeNull();
  });

  it("records the words the chooser was opened with, and queueing is not a call", async () => {
    const backend = new FakeBackend();
    backend.setImagePick("a.png");
    expect(backend.callsTo("pickBackgroundImage")).toEqual([]);
    await backend.pickBackgroundImage({ title: "Escolher uma imagem de fundo", filter: "Imagens" });
    expect(backend.callsTo("pickBackgroundImage").map((call) => call.args)).toEqual([
      ["Escolher uma imagem de fundo", "Imagens"],
    ]);
  });
});

describe("FakeBackend.readBackgroundImage", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("hands over the bytes of a picture file with its kind", async () => {
    const backend = new FakeBackend({ images: { "fixtures/sky.png": PNG } });
    const file = await backend.readBackgroundImage("fixtures/sky.png");
    expect(file.mime).toBe("image/png");
    expect([...file.bytes]).toEqual([...PNG]);
    // A copy: changing it does not change the file.
    file.bytes[0] = 0;
    expect((await backend.readBackgroundImage("fixtures/sky.png")).bytes[0]).toBe(0x89);
  });

  it("rejects, with a sentence, a path that is refused, a missing file and something that is not a picture", async () => {
    const backend = new FakeBackend({
      images: { "notes.png": Uint8Array.from([104, 105]), "https://x.dev/a.png": PNG },
    });
    await expect(backend.readBackgroundImage("https://x.dev/a.png")).rejects.toThrow(
      /web addresses/,
    );
    await expect(backend.readBackgroundImage("missing.png")).rejects.toThrow(/was not found/);
    await expect(backend.readBackgroundImage("notes.png")).rejects.toThrow(/not a picture/);
    await expect(backend.readBackgroundImage("../a.png")).rejects.toThrow(/climb out/);
  });

  it("rejects a file larger than the limit", async () => {
    const big = new Uint8Array(MAX_BACKGROUND_BYTES + 1);
    big.set(PNG);
    const backend = new FakeBackend({ images: { "big.png": big } });
    await expect(backend.readBackgroundImage("big.png")).rejects.toThrow(/too large/);
  });

  it("serves a file placed with setImage, and not one that was removed", async () => {
    const backend = new FakeBackend();
    backend.setImage("a.png", PNG);
    expect((await backend.readBackgroundImage("a.png")).mime).toBe("image/png");
    backend.setImage("a.png", null);
    await expect(backend.readBackgroundImage("a.png")).rejects.toThrow(/was not found/);
  });
});

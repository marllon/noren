import { describe, expect, it } from "vitest";
import { TauriBackend } from "./tauri-backend";
import type { TauriBridge } from "./tauri-backend";
import {
  WEB_IMAGES_KEY,
  WEB_WINDOW_EFFECTS_KEY,
  WebBackend,
  seededImages,
  seededWindowEffects,
} from "./web-backend";
import type { StateStorage } from "./web-backend";

// The two calls of the backend that serve the window: the effect behind it and the picture
// behind the terminals, in the Tauri backend (against a bridge that answers) and in the web one.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function bridgeAnswering(answer: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  const bridge: TauriBridge = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      try {
        return Promise.resolve(answer(command, args) as T);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    listen: () => Promise.resolve(() => undefined),
    createChannel: () => ({ onmessage: () => undefined }),
  };
  return { bridge, calls };
}

describe("TauriBackend.setWindowEffect", () => {
  it("asks window_effect_set for the effect, in the look of the theme or of the system", async () => {
    const { bridge, calls } = bridgeAnswering(() => ({ requested: "mica", applied: "mica" }));
    const backend = new TauriBackend(bridge);
    await expect(backend.setWindowEffect("mica", "dark")).resolves.toEqual({
      requested: "mica",
      applied: "mica",
    });
    await backend.setWindowEffect("acrylic", "light");
    await backend.setWindowEffect("mica", "system");
    expect(calls).toEqual([
      { command: "window_effect_set", args: { effect: "mica", scheme: "dark" } },
      { command: "window_effect_set", args: { effect: "acrylic", scheme: "light" } },
      { command: "window_effect_set", args: { effect: "mica", scheme: "system" } },
    ]);
  });

  it("hands over the fallback with its reason, and drops a missing one", async () => {
    const { bridge } = bridgeAnswering((_command, args) =>
      args?.["effect"] === "vibrancy"
        ? { requested: "vibrancy", applied: "none", reason: "only on macOS" }
        : { requested: "mica", applied: "mica", reason: null },
    );
    const backend = new TauriBackend(bridge);
    await expect(backend.setWindowEffect("vibrancy", "dark")).resolves.toEqual({
      requested: "vibrancy",
      applied: "none",
      reason: "only on macOS",
    });
    const applied = await backend.setWindowEffect("mica", "dark");
    expect("reason" in applied).toBe(false);
  });

  it("rejects when the request itself fails", async () => {
    const { bridge } = bridgeAnswering(() => {
      throw new Error("the window did not answer");
    });
    await expect(new TauriBackend(bridge).setWindowEffect("mica", "dark")).rejects.toThrow(
      "the window did not answer",
    );
  });
});

describe("TauriBackend.readBackgroundImage", () => {
  it("asks background_image_read for the path and tells the kind from the bytes", async () => {
    const { bridge, calls } = bridgeAnswering(() => PNG.buffer.slice(0));
    const file = await new TauriBackend(bridge).readBackgroundImage("C:\\Pictures\\sky.png");
    expect(file.mime).toBe("image/png");
    expect([...file.bytes]).toEqual([...PNG]);
    expect(calls).toEqual([
      { command: "background_image_read", args: { path: "C:\\Pictures\\sky.png" } },
    ]);
  });

  it("reads a plain list of numbers too, for a bridge with no binary channel", async () => {
    const { bridge } = bridgeAnswering(() => [...PNG]);
    expect((await new TauriBackend(bridge).readBackgroundImage("a.png")).mime).toBe("image/png");
  });

  it("rejects bytes that are not a picture, whatever the name of the file says", async () => {
    const { bridge } = bridgeAnswering(() => new TextEncoder().encode("not a picture").buffer);
    await expect(new TauriBackend(bridge).readBackgroundImage("a.png")).rejects.toThrow(
      /not a picture/,
    );
  });

  it("passes on the sentence of the Rust side when the file is refused", async () => {
    const { bridge } = bridgeAnswering(() => {
      throw "The image a.png was not found.";
    });
    await expect(new TauriBackend(bridge).readBackgroundImage("a.png")).rejects.toBe(
      "The image a.png was not found.",
    );
  });
});

describe("TauriBackend.pickBackgroundImage", () => {
  const words = { title: "Choose a background image", filter: "Pictures" };

  it("asks background_image_pick with the words for the chooser and answers the path", async () => {
    const { bridge, calls } = bridgeAnswering(() => "C:\\Pictures\\sky.png");
    await expect(new TauriBackend(bridge).pickBackgroundImage(words)).resolves.toBe(
      "C:\\Pictures\\sky.png",
    );
    expect(calls).toEqual([{ command: "background_image_pick", args: words }]);
  });

  it("answers null when the chooser was closed, and for an answer that is not a path", async () => {
    for (const answer of [null, undefined, "", 7, { path: "a.png" }]) {
      const { bridge } = bridgeAnswering(() => answer);
      await expect(new TauriBackend(bridge).pickBackgroundImage(words)).resolves.toBeNull();
    }
  });

  it("passes on the sentence of the Rust side when the chooser cannot be opened", async () => {
    const { bridge } = bridgeAnswering(() => {
      throw "the file chooser ended without an answer";
    });
    await expect(new TauriBackend(bridge).pickBackgroundImage(words)).rejects.toBe(
      "the file chooser ended without an answer",
    );
  });
});

describe("TauriBackend.pickPath", () => {
  it("asks path_pick for a file or a folder, with the title of the chooser, and answers the path", async () => {
    const { bridge, calls } = bridgeAnswering(() => "C:\\Users\\a\\.ssh\\id_ed25519");
    const backend = new TauriBackend(bridge);
    await expect(backend.pickPath({ kind: "file", title: "Choose a key file" })).resolves.toBe(
      "C:\\Users\\a\\.ssh\\id_ed25519",
    );
    await backend.pickPath({ kind: "folder", title: "Choose a folder" });
    expect(calls).toEqual([
      { command: "path_pick", args: { kind: "file", title: "Choose a key file" } },
      { command: "path_pick", args: { kind: "folder", title: "Choose a folder" } },
    ]);
  });

  it("answers null when the chooser was closed, and for an answer that is not a path", async () => {
    for (const answer of [null, undefined, "", 7, { path: "a" }]) {
      const { bridge } = bridgeAnswering(() => answer);
      await expect(
        new TauriBackend(bridge).pickPath({ kind: "file", title: "Choose" }),
      ).resolves.toBeNull();
    }
  });

  it("passes on the sentence of the Rust side when the chooser cannot be opened", async () => {
    const { bridge } = bridgeAnswering(() => {
      throw "the file chooser ended without an answer";
    });
    await expect(
      new TauriBackend(bridge).pickPath({ kind: "folder", title: "Choose" }),
    ).rejects.toBe("the file chooser ended without an answer");
  });
});

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

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("WebBackend window effects", () => {
  it("paints nothing by default: every effect falls back to opaque and says a browser has none", async () => {
    const backend = new WebBackend(memoryStorage());
    const report = await backend.setWindowEffect("mica", "dark");
    expect(report).toMatchObject({ requested: "mica", applied: "none" });
    expect(report.reason).toBe(
      "Mica needs the desktop app: a browser window has no window effects.",
    );
    expect((await backend.setWindowEffect("none", "dark")).reason).toBeUndefined();
  });

  it("paints the effects the seed lists, and only those", async () => {
    const storage = memoryStorage({ [WEB_WINDOW_EFFECTS_KEY]: JSON.stringify(["mica", "bogus"]) });
    expect(seededWindowEffects(storage)).toEqual(["mica"]);
    const backend = new WebBackend(storage);
    expect((await backend.setWindowEffect("mica", "dark")).applied).toBe("mica");
    expect((await backend.setWindowEffect("acrylic", "dark")).applied).toBe("none");
  });

  it("ignores a seed that is not a list", () => {
    for (const raw of ["{}", "mica", "null", "[", '"mica"']) {
      expect(seededWindowEffects(memoryStorage({ [WEB_WINDOW_EFFECTS_KEY]: raw })), raw).toEqual(
        [],
      );
    }
    expect(seededWindowEffects(memoryStorage())).toEqual([]);
  });
});

describe("WebBackend picture files", () => {
  it("reads the files of the seed, by path", async () => {
    const storage = memoryStorage({
      [WEB_IMAGES_KEY]: JSON.stringify({ "fixtures/sky.png": base64(PNG), "bad.png": 3 }),
    });
    expect(Object.keys(seededImages(storage) ?? {})).toEqual(["fixtures/sky.png"]);
    const file = await new WebBackend(storage).readBackgroundImage("fixtures/sky.png");
    expect(file.mime).toBe("image/png");
    expect([...file.bytes]).toEqual([...PNG]);
  });

  it("refuses a path with a web address even when the seed has it, and a file that is missing", async () => {
    const storage = memoryStorage({
      [WEB_IMAGES_KEY]: JSON.stringify({ "https://example.com/a.png": base64(PNG) }),
    });
    const backend = new WebBackend(storage);
    await expect(backend.readBackgroundImage("https://example.com/a.png")).rejects.toThrow(
      /web addresses/,
    );
    await expect(backend.readBackgroundImage("missing.png")).rejects.toThrow(/was not found/);
  });

  it("keeps a file placed with setImage in the storage, so a reload finds it", async () => {
    const storage = memoryStorage();
    new WebBackend(storage).setImage("a.png", PNG);
    expect((await new WebBackend(storage).readBackgroundImage("a.png")).mime).toBe("image/png");
    new WebBackend(storage).setImage("a.png", null);
    await expect(new WebBackend(storage).readBackgroundImage("a.png")).rejects.toThrow(
      /was not found/,
    );
  });

  it("ignores a seed that is not an object, or a file that is not base64", async () => {
    for (const raw of ["[]", "3", "{", "null"]) {
      expect(seededImages(memoryStorage({ [WEB_IMAGES_KEY]: raw })), raw).toBeUndefined();
    }
    const storage = memoryStorage({ [WEB_IMAGES_KEY]: JSON.stringify({ "a.png": "***" }) });
    expect(seededImages(storage)).toEqual({});
  });
});

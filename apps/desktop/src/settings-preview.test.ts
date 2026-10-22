import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_OPTIONS, FakeBackend, safeFontFamily } from "@noren/model";
import type { Config } from "@noren/model";
import { appearancePreview, onAppearancePreview, setAppearancePreview } from "./appearance-preview";
import { configManager } from "./config-store";
import { DEFAULT_LAYOUT } from "./layout";
import { getLayout, resetLayoutStore } from "./layout-store";
import { previewLayout, previewOf, previewPicture } from "./settings-screen";
import { previewTerminal } from "./settings-sections";
import {
  getTerminalOptions,
  resetTerminalOptionsStore,
  zoomTerminalFont,
} from "./terminal-options-store";
import { windowAppearance } from "./window-appearance";
import { NOREN_DUSK } from "@noren/model";

// What the settings screen tries out in the window before Save (NOR-F20-10b): the picture, the
// sidebar, the tabs, the font and the cursor of the terminal, besides the three numbers of the
// sliders. The draft says what to try, the preview holds it, the stores of the layout and of the
// terminal lay it over the file, and closing the screen takes it back.

const NO_PICTURE: Config = {};
const WITH_PICTURE: Config = { appearance: { background: { image: "backgrounds/sky.png" } } };

describe("previewLayout: what a draft tries out of the layout", () => {
  it("is nothing for a draft that changed none of it", () => {
    expect(previewLayout({})).toBeUndefined();
    expect(previewLayout({ windowOpacity: "0.5", mods: ["a.css"] })).toBeUndefined();
  });

  it("is the choices and the switches of the draft, as they are", () => {
    expect(
      previewLayout({
        side: "right",
        density: "compact",
        compact: true,
        keepOpen: true,
        tabs: "top",
        paneHeaders: true,
      }),
    ).toEqual({
      side: "right",
      density: "compact",
      compact: true,
      keepOpen: true,
      tabs: "top",
      paneHeaders: true,
    });
    // A switch turned off is something to try out too (the file may have it on).
    expect(previewLayout({ compact: false })).toEqual({ compact: false });
  });

  it("is the width when the box holds whole pixels in range, and keeps the last one while it does not", () => {
    expect(previewLayout({ width: "300" })).toEqual({ width: 300 });
    expect(previewLayout({ width: " 480 " })).toEqual({ width: 480 });
    for (const bad of ["", "30", "30.5", "9999", "x", "2e2"]) {
      expect(previewLayout({ width: bad }), bad).toBeUndefined();
      expect(previewLayout({ width: bad }, { width: 320 }), bad).toEqual({ width: 320 });
    }
    expect(previewLayout({ width: "300" }, { width: 320 })).toEqual({ width: 300 });
  });
});

describe("previewTerminal: what a draft tries out of the terminal", () => {
  it("is nothing for a draft that changed none of it, or has no terminal part", () => {
    expect(previewTerminal(undefined)).toBeUndefined();
    expect(previewTerminal({})).toBeUndefined();
    // The settings that have nothing to see are not tried out.
    expect(previewTerminal({ scrollback: "500", maxPanes: "4", bell: "both" })).toBeUndefined();
  });

  it("is the font, the size, the line height, the ligatures and the cursor", () => {
    expect(
      previewTerminal({
        fontFamily: "Consolas, monospace",
        fontSize: "18",
        lineHeight: "1.4",
        ligatures: true,
        cursorStyle: "bar",
        cursorBlink: false,
      }),
    ).toEqual({
      fontFamily: safeFontFamily("Consolas, monospace"),
      fontSize: 18,
      lineHeight: 1.4,
      ligatures: true,
      cursorStyle: "bar",
      cursorBlink: false,
    });
  });

  it("keeps what was tried while a box holds a value the schema refuses, and drops it once it is back", () => {
    const kept = { fontSize: 20, lineHeight: 1.5 };
    // Half a number, a number out of the range, a font list the schema refuses: the last good one stays.
    expect(previewTerminal({ fontSize: "2", lineHeight: "9" }, kept)).toEqual(kept);
    expect(previewTerminal({ fontSize: "", lineHeight: "x" }, kept)).toEqual(kept);
    // Nothing kept, nothing to try.
    expect(previewTerminal({ fontSize: "2" })).toBeUndefined();
    expect(previewTerminal({ fontSize: "24", lineHeight: "9" }, kept)).toEqual({
      fontSize: 24,
      lineHeight: 1.5,
    });
    // A size is kept in range, like the settings are.
    expect(previewTerminal({ fontSize: "72" })).toEqual({ fontSize: 72 });
  });
});

describe("previewPicture: the picture a draft tries out behind the terminals", () => {
  it("is nothing while the box was not touched", () => {
    expect(previewPicture(undefined, "ready", NO_PICTURE)).toBeUndefined();
  });

  it("is the path once the window can read it, and nothing before or if it cannot", () => {
    expect(previewPicture("backgrounds/sky.png", "ready", NO_PICTURE)).toBe("backgrounds/sky.png");
    expect(previewPicture("  backgrounds/sky.png ", "ready", NO_PICTURE)).toBe(
      "backgrounds/sky.png",
    );
    expect(previewPicture("backgrounds/sky.png", "failed", NO_PICTURE)).toBeUndefined();
    expect(previewPicture("backgrounds/sky.png", "none", NO_PICTURE)).toBeUndefined();
    // A path that is being read keeps the picture the window was showing, so it does not flash.
    expect(previewPicture("backgrounds/sky.png", "loading", NO_PICTURE)).toBeUndefined();
    expect(
      previewPicture("backgrounds/sky.png", "loading", NO_PICTURE, "backgrounds/old.png"),
    ).toBe("backgrounds/old.png");
    expect(previewPicture("backgrounds/sky.png", "loading", NO_PICTURE, null)).toBeNull();
  });

  it("is nothing for a path that cannot be a background (a web address): the box tells why", () => {
    for (const path of ["https://example.com/a.png", "http://x/y.jpg", "//server/share/a.png"]) {
      expect(previewPicture(path, "ready", NO_PICTURE), path).toBeUndefined();
    }
  });

  it("is no picture (null) for a box emptied where the file has one, and nothing where it has none", () => {
    expect(previewPicture("", "none", WITH_PICTURE)).toBeNull();
    expect(previewPicture("   ", "none", WITH_PICTURE)).toBeNull();
    expect(previewPicture("", "none", NO_PICTURE)).toBeUndefined();
  });
});

describe("previewOf with what the screen knows", () => {
  const context = { config: NO_PICTURE, picture: "ready" } as const;

  it("collects the numbers, the picture, the layout and the terminal of one draft", () => {
    expect(
      previewOf(
        {
          windowOpacity: "0.5",
          backgroundImage: "backgrounds/sky.png",
          side: "right",
          width: "300",
          terminal: { fontSize: "18", cursorStyle: "underline" },
        },
        undefined,
        context,
      ),
    ).toEqual({
      windowOpacity: 0.5,
      backgroundOpacity: undefined,
      backgroundBlur: undefined,
      backgroundImage: "backgrounds/sky.png",
      layout: { side: "right", width: 300 },
      terminal: { fontSize: 18, cursorStyle: "underline" },
    });
  });

  it("has no picture, layout or terminal entry for a draft that touched none, and without the context no picture", () => {
    expect(previewOf({}, undefined, context)).toEqual({
      windowOpacity: undefined,
      backgroundOpacity: undefined,
      backgroundBlur: undefined,
    });
    expect(previewOf({ backgroundImage: "backgrounds/sky.png" })).toEqual({
      windowOpacity: undefined,
      backgroundOpacity: undefined,
      backgroundBlur: undefined,
    });
  });

  it("keeps the layout, the terminal and the picture it tried while a box holds half a value", () => {
    const previous = {
      backgroundImage: "backgrounds/old.png",
      layout: { width: 320 },
      terminal: { fontSize: 20 },
    };
    expect(
      previewOf(
        { backgroundImage: "backgrounds/new.png", width: "3", terminal: { fontSize: "2" } },
        previous,
        { config: NO_PICTURE, picture: "loading" },
      ),
    ).toMatchObject(previous);
  });
});

describe("the preview of the layout and the terminal groups", () => {
  afterEach(() => setAppearancePreview(undefined));

  it("holds them until cleared, and tells the listeners only when one changed", () => {
    const listener = vi.fn();
    const stop = onAppearancePreview(listener);
    setAppearancePreview({ layout: { side: "right" }, terminal: { fontSize: 20 } });
    expect(listener).toHaveBeenCalledTimes(1);
    // The same fields in new objects are not a change: no render for nothing while a slider rests.
    const held = appearancePreview();
    setAppearancePreview({ layout: { side: "right" }, terminal: { fontSize: 20 } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(appearancePreview()).toBe(held);
    setAppearancePreview({ layout: { side: "left" }, terminal: { fontSize: 20 } });
    expect(listener).toHaveBeenCalledTimes(2);
    setAppearancePreview({ layout: { side: "left" }, terminal: { fontSize: 21 } });
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });

  it("is none when its groups hold nothing, and a picture of null (no picture) is a thing tried out", () => {
    setAppearancePreview({ layout: {}, terminal: {} });
    expect(appearancePreview()).toBeUndefined();
    setAppearancePreview({ layout: { side: undefined as never } });
    expect(appearancePreview()).toBeUndefined();
    setAppearancePreview({ backgroundImage: null });
    expect(appearancePreview()).toEqual({ backgroundImage: null });
  });

  it("keeps the groups that say something and drops the empty ones", () => {
    setAppearancePreview({ windowOpacity: 0.5, layout: {}, terminal: { cursorBlink: false } });
    expect(appearancePreview()).toEqual({ windowOpacity: 0.5, terminal: { cursorBlink: false } });
  });
});

describe("the layout store lays the preview over the file", () => {
  async function started(config: string | null = null): Promise<FakeBackend> {
    const backend = new FakeBackend({ config });
    await configManager.start(backend);
    return backend;
  }

  beforeEach(() => {
    resetLayoutStore();
    configManager.stop();
    configManager.apply(null);
  });
  afterEach(() => setAppearancePreview(undefined));

  it("shows what the screen tries out, and the file again when it is cleared", async () => {
    await started('{ "appearance": { "sidebar": { "width": 260 } } }');
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, width: 260 });
    setAppearancePreview({ layout: { side: "right", tabs: "top", paneHeaders: true } });
    expect(getLayout()).toEqual({
      ...DEFAULT_LAYOUT,
      width: 260,
      side: "right",
      tabs: "top",
      paneHeaders: true,
    });
    setAppearancePreview({ layout: { width: 400 } });
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, width: 400 });
    setAppearancePreview(undefined);
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, width: 260 });
  });

  it("is the same object when the preview of another setting changes (a slider of the window)", async () => {
    await started(null);
    setAppearancePreview({ layout: { side: "right" } });
    const held = getLayout();
    setAppearancePreview({ layout: { side: "right" }, windowOpacity: 0.5 });
    expect(getLayout()).toBe(held);
    setAppearancePreview({ windowOpacity: 0.6 });
    expect(getLayout()).not.toBe(held);
    expect(getLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("follows the file under the preview: what the preview does not say is the file's", async () => {
    const backend = await started(null);
    setAppearancePreview({ layout: { side: "right" } });
    backend.setConfig('{ "appearance": { "density": "compact" } }');
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, density: "compact", side: "right" });
  });
});

describe("the terminal store lays the preview over the file, and the zoom over both", () => {
  async function started(config: string | null = null): Promise<FakeBackend> {
    const backend = new FakeBackend({ config });
    await configManager.start(backend);
    return backend;
  }

  beforeEach(() => {
    resetTerminalOptionsStore();
    configManager.stop();
    configManager.apply(null);
  });
  afterEach(() => setAppearancePreview(undefined));

  it("shows what the screen tries out, and the file again when it is cleared", async () => {
    await started('{ "terminal": { "font": { "size": 16 } } }');
    expect(getTerminalOptions()).toEqual({ ...DEFAULT_TERMINAL_OPTIONS, fontSize: 16 });
    setAppearancePreview({ terminal: { fontSize: 24, cursorStyle: "bar", ligatures: true } });
    expect(getTerminalOptions()).toEqual({
      ...DEFAULT_TERMINAL_OPTIONS,
      fontSize: 24,
      cursorStyle: "bar",
      ligatures: true,
    });
    setAppearancePreview(undefined);
    expect(getTerminalOptions()).toEqual({ ...DEFAULT_TERMINAL_OPTIONS, fontSize: 16 });
  });

  it("is the same object while the preview says the same thing", async () => {
    await started(null);
    setAppearancePreview({ terminal: { fontSize: 24 } });
    const held = getTerminalOptions();
    setAppearancePreview({ terminal: { fontSize: 24 }, windowOpacity: 0.5 });
    expect(getTerminalOptions()).toBe(held);
  });

  it("puts the zoom over the size the screen tries out", async () => {
    await started(null);
    setAppearancePreview({ terminal: { fontSize: 20 } });
    zoomTerminalFont("in");
    expect(getTerminalOptions().fontSize).toBeGreaterThan(20);
    zoomTerminalFont("reset");
    expect(getTerminalOptions().fontSize).toBe(20);
  });
});

describe("the window appearance with a picture tried out", () => {
  const sources = { config: WITH_PICTURE, theme: NOREN_DUSK, applied: "none" } as const;

  it("shows the picture of the file when nothing is tried out", () => {
    expect(windowAppearance(sources).background.image).toBe("backgrounds/sky.png");
  });

  it("shows the picture the screen tried, over the file's, and none for null", () => {
    expect(
      windowAppearance({ ...sources, preview: { backgroundImage: "backgrounds/new.png" } })
        .background.image,
    ).toBe("backgrounds/new.png");
    expect(
      windowAppearance({ ...sources, preview: { backgroundImage: null } }).background.image,
    ).toBeNull();
    // A preview that says nothing of the picture leaves it as it was, and the numbers still follow.
    const kept = windowAppearance({ ...sources, preview: { backgroundBlur: 9 } }).background;
    expect(kept.image).toBe("backgrounds/sky.png");
    expect(kept.blur).toBe(9);
  });

  it("is the picture of the space that wins over the one tried in the settings", () => {
    const space = { image: "backgrounds/space.png" };
    expect(
      windowAppearance({
        ...sources,
        spaceBackground: space,
        preview: { backgroundImage: "backgrounds/new.png" },
      }).background.image,
    ).toBe("backgrounds/space.png");
  });
});

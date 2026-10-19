import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configManager } from "./config-store";
import { LAYOUT_KEY, DEFAULT_LAYOUT } from "./layout";
import { getLayout, layoutLocks, resetLayoutStore, updateLayout } from "./layout-store";

// The layout the interface shows is the stored choice (the provisional controls) with the settings
// file over it. The module reads `window.localStorage`, so a plain object stands in for it.

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
  resetLayoutStore();
  configManager.stop();
  configManager.apply(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const RIGHT = '{ "appearance": { "sidebar": { "position": "right" } } }';
const LEFT = '{ "appearance": { "sidebar": { "position": "left" } } }';
const savedLayout = () => JSON.parse(values.get(LAYOUT_KEY) ?? "null") as Record<string, unknown>;

describe("layout store with the settings file", () => {
  it("is the default layout with no file and nothing stored", () => {
    expect(getLayout()).toEqual(DEFAULT_LAYOUT);
    expect(layoutLocks().size).toBe(0);
  });

  it("shows the stored choice for every preference the file does not mention", () => {
    values.set(LAYOUT_KEY, JSON.stringify({ side: "right", density: "compact" }));
    expect(getLayout()).toMatchObject({ side: "right", density: "compact" });
  });

  it("puts the preferences of the file over the stored choice, and only those", () => {
    values.set(LAYOUT_KEY, JSON.stringify({ side: "left", density: "compact", width: 300 }));
    configManager.apply(RIGHT);

    expect(getLayout()).toMatchObject({ side: "right", density: "compact", width: 300 });
    expect([...layoutLocks()]).toEqual(["side"]);
  });

  it("follows a change of the file at once, and gives the stored choice back when the key leaves", () => {
    values.set(LAYOUT_KEY, JSON.stringify({ side: "left" }));
    configManager.apply(RIGHT);
    expect(getLayout().side).toBe("right");

    configManager.apply('{ "appearance": { "sidebar": { "position": "left", "width": 260 } } }');
    expect(getLayout()).toMatchObject({ side: "left", width: 260 });

    configManager.apply("{}");
    expect(getLayout().width).toBe(DEFAULT_LAYOUT.width);
    expect(layoutLocks().size).toBe(0);
  });

  it("keeps the layout when the file turns invalid", () => {
    configManager.apply(RIGHT);
    const before = getLayout();
    configManager.apply('{ "appearance": { "sidebar": { "position": "middle" } } }');
    expect(getLayout()).toBe(before);
    expect(layoutLocks().has("side")).toBe(true);
  });

  it("moves every layout preference the file can set", () => {
    configManager.apply(`{
      "appearance": {
        "sidebar": { "position": "right", "width": 333, "compact": true, "keepOpen": true },
        "density": "compact",
        "tabs": "top",
        "paneHeaders": true,
      },
    }`);
    expect(getLayout()).toEqual({
      side: "right",
      width: 333,
      compact: true,
      keepOpen: true,
      density: "compact",
      tabs: "top",
      paneHeaders: true,
    });
    expect(layoutLocks().size).toBe(7);
  });

  it("ignores a change of a preference the file sets, and saves the others", () => {
    configManager.apply(LEFT);
    updateLayout({ side: "right", density: "compact" });

    expect(getLayout()).toMatchObject({ side: "left", density: "compact" });
    // The side that was asked for never reached the storage.
    expect(savedLayout()).toMatchObject({ side: "left", density: "compact" });
  });

  it("saves nothing when everything asked is decided by the file", () => {
    configManager.apply(LEFT);
    updateLayout({ side: "right" });
    expect(values.has(LAYOUT_KEY)).toBe(false);
    expect(getLayout().side).toBe("left");
  });

  it("keeps a width in range", () => {
    updateLayout({ width: 9999 });
    expect(getLayout().width).toBe(480);
    updateLayout({ width: 1 });
    expect(getLayout().width).toBe(180);
  });
});
